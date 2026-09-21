import { Router } from 'express';
import { SESSION_COOKIE_NAME, config } from '../config.ts';
import { db } from '../db/index.ts';
import { timingSafeCompare, verifyAgainstDummy, verifyPassword } from '../lib/crypto.ts';
import { HttpError, asyncRoute, badRequest, requireString, unauthorized } from '../lib/http.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { LOGIN_LIMITS, accountKey, checkLimit, clearFailures, ipKey, recordFailure } from '../lib/rate-limit.ts';
import { sessionStore } from '../lib/session-store.ts';
import { attachUser, requireAuth, type AuthedRequest } from '../middleware/auth.ts';
import { countUsers, findUserById, findUserRowByLogin, updatePassword } from '../repositories/users.ts';
import { getSettings } from '../repositories/settings.ts';
import { bootstrapFirstAdmin } from '../bootstrap.ts';

export const authRouter: Router = Router();

/**
 * Public boot state. The client uses this before login to decide whether to
 * show the sign-in form or the one-time first-admin setup screen.
 */
authRouter.get(
  '/bootstrap',
  asyncRoute(async (_req, res) => {
    const settings = await getSettings();
    const users = await countUsers();
    res.json({
      setupRequired: users === 0,
      organizationName: settings.organizationName,
      /** Self-registration is intentionally unavailable; admins create accounts. */
      registrationOpen: false,
      /** Tells the setup screen whether to ask for the token. */
      setupTokenRequired: users === 0 && Boolean(config.setupToken),
    });
  }),
);

/** One-time endpoint: creates the very first administrator. Closed afterwards. */
authRouter.post(
  '/setup',
  asyncRoute(async (req, res) => {
    if ((await countUsers()) > 0) {
      throw badRequest('This system is already set up. Ask an administrator for an account.');
    }

    // When a token is configured, it gates the whole endpoint. Compared in
    // constant time so the check cannot be narrowed down by guessing.
    if (config.setupToken) {
      const supplied = typeof req.body?.setupToken === 'string' ? req.body.setupToken : '';
      if (!timingSafeCompare(supplied, config.setupToken)) {
        await recordAudit({
          actorName: 'unknown',
          entityType: 'system',
          action: 'setup_rejected',
          summary: 'First-run setup attempted with an incorrect setup token',
          ip: clientIp(req),
        });
        throw new HttpError(403, 'That setup token is not correct.');
      }
    }

    const name = requireString(req.body?.name, 'Name', { max: 120 });
    const email = requireString(req.body?.email, 'Email', { max: 160 }).toLowerCase();
    const password = requireString(req.body?.password, 'Password', { max: 200, min: 10 });
    const organizationName = requireString(req.body?.organizationName ?? 'Escalation Pro', 'Organisation', { max: 120 });

    const user = await bootstrapFirstAdmin({ name, email, password, organizationName });

    req.session.userId = user.id;
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'system',
      action: 'setup',
      summary: `Initial administrator ${user.email} created`,
      ip: clientIp(req),
    });

    res.status(201).json({ user });
  }),
);

authRouter.post(
  '/login',
  asyncRoute(async (req, res) => {
    const login = requireString(req.body?.login, 'Email or username', { max: 160 });
    const password = requireString(req.body?.password, 'Password', { max: 200 });

    const ip = clientIp(req);
    const keys = [accountKey(login), ipKey(ip)];

    // Refuse before touching the password so a locked-out attacker gains nothing,
    // not even timing information.
    const [accountLimit, ipLimit] = await Promise.all([
      checkLimit(keys[0], LOGIN_LIMITS.account),
      checkLimit(keys[1], LOGIN_LIMITS.ip),
    ]);
    const limited = accountLimit.blocked ? accountLimit : ipLimit.blocked ? ipLimit : null;
    if (limited) {
      res.setHeader('Retry-After', String(limited.retryAfterSeconds));
      throw new HttpError(
        429,
        `Too many failed sign-in attempts. Try again in ${Math.ceil(limited.retryAfterSeconds / 60)} minute(s).`,
      );
    }

    const row = await findUserRowByLogin(login);
    // Hash on every path, including a miss, so an unknown account and a wrong
    // password cost the same. A bare early return leaks which accounts exist.
    const valid = row
      ? verifyPassword(password, row.password_hash, row.password_salt)
      : verifyAgainstDummy(password);

    if (!row || !valid) {
      await recordFailure(keys);
      await recordAudit({
        actorName: login,
        entityType: 'auth',
        action: 'login_failed',
        summary: `Failed sign-in attempt for "${login}"`,
        ip,
      });
      throw unauthorized('That email/username and password combination is not recognised.');
    }

    if (row.status !== 'active') {
      await recordFailure(keys);
      throw unauthorized('This account has been suspended. Contact an administrator.');
    }

    await clearFailures(keys);

    await db.run(`UPDATE users SET last_login_at = ? WHERE id = ?`, [new Date().toISOString(), row.id]);

    // Rotate the session id on login to prevent session fixation.
    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((error) => (error ? reject(error) : resolve()));
    });
    req.session.userId = row.id;

    const user = await findUserById(row.id);
    await recordAudit({
      actorId: row.id,
      actorName: row.name,
      entityType: 'auth',
      entityId: row.id,
      action: 'login',
      summary: `${row.name} signed in`,
      ip,
    });

    res.json({ user });
  }),
);

authRouter.post(
  '/logout',
  attachUser,
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    if (user) {
      await recordAudit({
        actorId: user.id,
        actorName: user.name,
        entityType: 'auth',
        entityId: user.id,
        action: 'logout',
        summary: `${user.name} signed out`,
        ip: clientIp(req),
      });
    }
    req.session.destroy(() => {
      res.clearCookie(SESSION_COOKIE_NAME, { path: '/', sameSite: 'lax', secure: config.cookieSecure });
      res.json({ ok: true });
    });
  }),
);

authRouter.get(
  '/me',
  attachUser,
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json({ user: (req as AuthedRequest).user });
  }),
);

/** Self-service password change; also clears the forced-reset flag. */
authRouter.post(
  '/change-password',
  attachUser,
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const currentPassword = requireString(req.body?.currentPassword, 'Current password', { max: 200 });
    const newPassword = requireString(req.body?.newPassword, 'New password', { max: 200, min: 10 });

    const row = await db.get<{ password_hash: string; password_salt: string }>(
      `SELECT password_hash, password_salt FROM users WHERE id = ?`,
      [user.id],
    );
    if (!row || !verifyPassword(currentPassword, row.password_hash, row.password_salt)) {
      throw badRequest('Your current password is not correct.', { currentPassword: 'Incorrect' });
    }
    if (currentPassword === newPassword) {
      throw badRequest('The new password must be different from the current one.', { newPassword: 'Reuse' });
    }

    await updatePassword(user.id, newPassword, false);
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'auth',
      entityId: user.id,
      action: 'password_changed',
      summary: `${user.name} changed their password`,
      ip: clientIp(req),
    });

    // Other devices keep a session tied to the old password; drop them, but
    // leave this one signed in.
    await sessionStore.destroyForUser(user.id, req.sessionID);

    res.json({ ok: true });
  }),
);
