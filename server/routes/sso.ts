import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { db } from '../db/index.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { asyncRoute, badRequest, requireString } from '../lib/http.ts';
import { requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
import { createUser, usernameInUse } from '../repositories/users.ts';
import { findTeamById } from '../repositories/teams.ts';
import {
  fetchIdpMetadata,
  loadSaml,
  loginUrl,
  roleFromGroups,
  samlReady,
  saveSaml,
  serviceProvider,
  spMetadata,
  validateSaml,
  verifyResponse,
} from '../lib/sso.ts';

/**
 * SAML endpoints the browser and the identity provider use. Mounted at
 * /api/auth/saml, ahead of the session user being resolved.
 */
export const samlRouter: Router = Router();

const originOf = (req: Request) => `${req.protocol}://${req.get('host')}`;

/** Only same-site paths survive the round trip through the IdP: never an open redirect. */
function safeReturnTo(value: unknown): string {
  const path = typeof value === 'string' ? value : '/';
  return /^\/(?!\/)[^\s\\]*$/.test(path) ? path : '/';
}

function failRedirect(message: string): string {
  return `/?sso_error=${encodeURIComponent(message)}`;
}

samlRouter.get(
  '/metadata',
  asyncRoute(async (req, res) => {
    const settings = await loadSaml();
    res.type('application/samlmetadata+xml');
    if (req.query.download !== undefined) res.setHeader('Content-Disposition', 'attachment; filename="infraticket-sp-metadata.xml"');
    res.send(spMetadata(settings, await serviceProvider(originOf(req))));
  }),
);

samlRouter.get(
  '/login',
  asyncRoute(async (req, res) => {
    const settings = await loadSaml();
    if (!samlReady(settings)) return res.redirect(failRedirect('Single sign-on is not set up.'));
    res.redirect(await loginUrl(settings, await serviceProvider(originOf(req)), safeReturnTo(req.query.returnTo)));
  }),
);

/** The assertion consumer service: where the IdP posts the signed response. */
samlRouter.post(
  '/acs',
  asyncRoute(async (req, res) => {
    const ip = clientIp(req);
    const settings = await loadSaml();
    const fail = async (reason: string, who = 'unknown') => {
      await recordAudit({ actorName: who, entityType: 'auth', action: 'sso_login_failed', summary: `Single sign-on refused: ${reason}`, ip });
      res.redirect(failRedirect(reason));
    };
    if (!samlReady(settings)) return fail('Single sign-on is not set up.');
    const samlResponse = typeof req.body?.SAMLResponse === 'string' ? req.body.SAMLResponse : '';
    if (!samlResponse) return fail('No sign-in response was received.');

    let identity;
    try {
      identity = await verifyResponse(settings, await serviceProvider(originOf(req)), samlResponse);
    } catch (error) {
      console.warn('[sso] rejected response:', (error as Error).message);
      return fail('The sign-in response could not be verified.');
    }

    let row = await db.get<{ id: string; name: string; role: string; status: string }>(
      `SELECT id, name, role, status FROM users WHERE LOWER(email) = ?`,
      [identity.email],
    );
    const groupRole = roleFromGroups(settings, identity.groups);

    if (!row) {
      if (!settings.jitEnabled) return fail(`${identity.email} has no account here. Ask an administrator to add you.`, identity.email);
      const team = settings.jitTeamId ? await findTeamById(settings.jitTeamId) : null;
      let username = identity.email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40) || 'user';
      if (await usernameInUse(username)) username = `${username}-${crypto.randomBytes(2).toString('hex')}`;
      const id = await createUser({
        email: identity.email,
        username,
        name: identity.name,
        // Never used: the account signs in through the IdP. Random so it cannot be guessed.
        password: crypto.randomBytes(32).toString('base64url'),
        role: groupRole ?? settings.jitRole,
        teamIds: team ? [team.id] : [],
        mustChangePassword: false,
      });
      await recordAudit({
        actorId: id,
        actorName: identity.name,
        entityType: 'user',
        entityId: id,
        action: 'sso_user_provisioned',
        summary: `Created ${identity.email} on first single sign-on (${groupRole ?? settings.jitRole})`,
        ip,
      });
      row = { id, name: identity.name, role: groupRole ?? settings.jitRole, status: 'active' };
    } else if (groupRole && groupRole !== row.role && row.role !== 'admin') {
      // Group membership in the IdP decides the role. Administrators are left
      // alone, so a mapping mistake can never lock the last one out.
      await db.run(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`, [groupRole, new Date().toISOString(), row.id]);
      await recordAudit({
        actorId: row.id,
        actorName: row.name,
        entityType: 'user',
        entityId: row.id,
        action: 'sso_role_changed',
        summary: `Role set to ${groupRole} from identity-provider groups (was ${row.role})`,
        ip,
      });
    }

    if (row.status !== 'active') return fail('This account has been suspended. Contact an administrator.', identity.email);

    await db.run(`UPDATE users SET last_login_at = ? WHERE id = ?`, [new Date().toISOString(), row.id]);
    await new Promise<void>((resolve, reject) => req.session.regenerate((error) => (error ? reject(error) : resolve())));
    req.session.userId = row.id;
    await recordAudit({
      actorId: row.id,
      actorName: row.name,
      entityType: 'auth',
      entityId: row.id,
      action: 'sso_login',
      summary: `${row.name} signed in with single sign-on`,
      ip,
    });
    res.redirect(safeReturnTo(req.body?.RelayState));
  }),
);

/* -------------------------- Administration ------------------------------- */

/** Mounted at /api/sso, after the session user is resolved. */
export const ssoAdminRouter: Router = Router();
ssoAdminRouter.use(requireAuth, requirePermission('settings.manage'));

ssoAdminRouter.get(
  '/saml',
  asyncRoute(async (req, res) => {
    res.json({ settings: await loadSaml(), serviceProvider: await serviceProvider(originOf(req)) });
  }),
);

ssoAdminRouter.put(
  '/saml',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const current = await loadSaml();
    const next = validateSaml(req.body ?? {}, current);
    if (next.jitTeamId && !(await findTeamById(next.jitTeamId))) throw badRequest('That team no longer exists.');
    await saveSaml(next);
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'settings',
      action: 'sso_updated',
      summary: `Single sign-on ${next.enabled ? 'enabled' : 'disabled'}${next.requireSso ? ', required for non-administrators' : ''}`,
      meta: { idpEntityId: next.idpEntityId, jitEnabled: next.jitEnabled, groupRoles: next.groupRoles.length },
      ip: clientIp(req),
    });
    res.json({ settings: next, serviceProvider: await serviceProvider(originOf(req)) });
  }),
);

ssoAdminRouter.post(
  '/saml/import-metadata',
  asyncRoute(async (req, res) => {
    res.json({ metadata: await fetchIdpMetadata(requireString(req.body?.url, 'Metadata URL', { max: 2000 })) });
  }),
);

export async function ssoBootstrap(): Promise<{ enabled: boolean; label: string; required: boolean; provider: string }> {
  const settings = await loadSaml();
  return { enabled: samlReady(settings), label: settings.buttonLabel, required: samlReady(settings) && settings.requireSso, provider: settings.provider };
}

/** Whether password sign-in is refused for this person. Administrators always keep it. */
export async function passwordLoginBlocked(role: string): Promise<boolean> {
  if (role === 'admin') return false;
  const settings = await loadSaml();
  return samlReady(settings) && settings.requireSso;
}

