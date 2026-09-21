import { Router } from 'express';
import { db } from '../db/index.ts';
import { generatePassword } from '../lib/crypto.ts';
import {
  asyncRoute,
  badRequest,
  conflict,
  forbidden,
  isValidEmail,
  notFound,
  optionalString,
  requireEnum,
  requireString,
  toStringArray,
} from '../lib/http.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { sessionStore } from '../lib/session-store.ts';
import { can, requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
import { ALL_PERMISSIONS, PERMISSION_GROUPS, ROLE_DESCRIPTIONS, ROLE_LABELS, isPermission } from '../permissions.ts';
import {
  countActiveAdmins,
  createUser,
  emailInUse,
  findUserById,
  listUsers,
  setUserPermissions,
  setUserTeams,
  updatePassword,
  usernameInUse,
} from '../repositories/users.ts';
import { USER_ROLES, USER_STATUSES, type Permission } from '../../shared/types.ts';

export const usersRouter: Router = Router();

usersRouter.use(requireAuth);

/** Static metadata the UI needs to render role and permission pickers. */
usersRouter.get('/meta', (_req, res) => {
  res.json({
    roles: USER_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role], description: ROLE_DESCRIPTIONS[role] })),
    permissionGroups: PERMISSION_GROUPS,
    allPermissions: ALL_PERMISSIONS,
  });
});

/**
 * Lightweight directory for assignee pickers. Available to any signed-in user
 * so they can route a ticket without holding the users.view permission.
 */
usersRouter.get(
  '/directory',
  asyncRoute(async (_req, res) => {
    const users = await listUsers({ activeOnly: true });
    res.json({
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        avatarColor: user.avatarColor,
        jobTitle: user.jobTitle,
        role: user.role,
        teamIds: user.teamIds,
      })),
    });
  }),
);

usersRouter.get(
  '/',
  requirePermission('users.view'),
  asyncRoute(async (_req, res) => {
    res.json({ users: await listUsers() });
  }),
);

usersRouter.get(
  '/:id',
  requirePermission('users.view'),
  asyncRoute(async (req, res) => {
    const user = await findUserById(req.params.id);
    if (!user) throw notFound('That user does not exist.');
    res.json({ user });
  }),
);

function readPermissions(value: unknown): Permission[] {
  return toStringArray(value, ALL_PERMISSIONS.length).filter(isPermission);
}

/**
 * Accounts are created here by an administrator or manager. There is no public
 * sign-up route anywhere in the application - this is the only way in.
 */
usersRouter.post(
  '/',
  requirePermission('users.create'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;

    const name = requireString(req.body?.name, 'Name', { max: 120 });
    const email = requireString(req.body?.email, 'Email', { max: 160 }).toLowerCase();
    if (!isValidEmail(email)) throw badRequest('Enter a valid email address.', { email: 'Invalid' });

    const username =
      optionalString(req.body?.username, 60)?.replace(/[^a-zA-Z0-9._-]/g, '') || email.split('@')[0];
    const role = requireEnum(req.body?.role ?? 'agent', USER_ROLES, 'Role');

    // Only an admin may mint another admin.
    if (role === 'admin' && actor.role !== 'admin') {
      throw forbidden('Only an administrator can create another administrator.');
    }

    if (await emailInUse(email)) throw conflict('An account with that email already exists.');
    if (await usernameInUse(username)) throw conflict('That username is already taken.');

    // A generated password is returned once so the admin can hand it over.
    const generated = !req.body?.password;
    const password = generated ? generatePassword() : requireString(req.body?.password, 'Password', { min: 10, max: 200 });

    const id = await db.transaction(async () =>
      createUser({
        email,
        username,
        name,
        password,
        role,
        jobTitle: optionalString(req.body?.jobTitle, 120),
        phone: optionalString(req.body?.phone, 40),
        teamIds: toStringArray(req.body?.teamIds),
        extraPermissions: readPermissions(req.body?.extraPermissions),
        mustChangePassword: req.body?.mustChangePassword !== false,
        status: requireEnum(req.body?.status ?? 'active', USER_STATUSES, 'Status'),
      }),
    );

    const user = await findUserById(id);
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'user',
      entityId: id,
      action: 'user_created',
      summary: `Created ${role} account for ${email}`,
      meta: { role, teamIds: user?.teamIds },
      ip: clientIp(req),
    });

    res.status(201).json({ user, temporaryPassword: generated ? password : undefined });
  }),
);

usersRouter.patch(
  '/:id',
  requirePermission('users.update'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const target = await findUserById(req.params.id);
    if (!target) throw notFound('That user does not exist.');

    const updates: string[] = [];
    const params: Array<string | number | null> = [];
    const push = (column: string, value: string | number | null) => {
      updates.push(`${column} = ?`);
      params.push(value);
    };

    if (req.body?.name !== undefined) push('name', requireString(req.body.name, 'Name', { max: 120 }));
    if (req.body?.jobTitle !== undefined) push('job_title', optionalString(req.body.jobTitle, 120));
    if (req.body?.phone !== undefined) push('phone', optionalString(req.body.phone, 40));

    if (req.body?.email !== undefined) {
      const email = requireString(req.body.email, 'Email', { max: 160 }).toLowerCase();
      if (!isValidEmail(email)) throw badRequest('Enter a valid email address.', { email: 'Invalid' });
      if (await emailInUse(email, target.id)) throw conflict('Another account already uses that email.');
      push('email', email);
    }

    if (req.body?.username !== undefined) {
      const username = requireString(req.body.username, 'Username', { max: 60 }).replace(/[^a-zA-Z0-9._-]/g, '');
      if (await usernameInUse(username, target.id)) throw conflict('That username is already taken.');
      push('username', username);
    }

    if (req.body?.role !== undefined) {
      const role = requireEnum(req.body.role, USER_ROLES, 'Role');
      if (role === 'admin' && actor.role !== 'admin') {
        throw forbidden('Only an administrator can promote someone to administrator.');
      }
      // Never let the last working admin lock everyone out.
      if (target.role === 'admin' && role !== 'admin' && (await countActiveAdmins(target.id)) === 0) {
        throw badRequest('This is the only active administrator. Promote someone else first.');
      }
      push('role', role);
    }

    if (req.body?.status !== undefined) {
      const status = requireEnum(req.body.status, USER_STATUSES, 'Status');
      if (status !== 'active' && target.role === 'admin' && (await countActiveAdmins(target.id)) === 0) {
        throw badRequest('This is the only active administrator and cannot be suspended.');
      }
      if (status !== 'active' && target.id === actor.id) {
        throw badRequest('You cannot suspend your own account.');
      }
      push('status', status);
    }

    if (updates.length) {
      push('updated_at', new Date().toISOString());
      params.push(target.id);
      await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    if (Array.isArray(req.body?.teamIds)) {
      await setUserTeams(target.id, toStringArray(req.body.teamIds));
    }
    if (Array.isArray(req.body?.extraPermissions)) {
      if (!can(actor, 'users.update') || (actor.role !== 'admin' && actor.role !== 'manager')) {
        throw forbidden('You cannot change permission grants.');
      }
      await setUserPermissions(target.id, readPermissions(req.body.extraPermissions));
    }

    // A suspended user must lose their live sessions immediately.
    if (req.body?.status && req.body.status !== 'active') {
      await sessionStore.destroyForUser(target.id);
    }

    const user = await findUserById(target.id);
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'user',
      entityId: target.id,
      action: 'user_updated',
      summary: `Updated account ${user?.email ?? target.email}`,
      meta: { fields: Object.keys(req.body ?? {}) },
      ip: clientIp(req),
    });

    res.json({ user });
  }),
);

usersRouter.post(
  '/:id/reset-password',
  requirePermission('users.reset_password'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const target = await findUserById(req.params.id);
    if (!target) throw notFound('That user does not exist.');

    const generated = !req.body?.password;
    const password = generated
      ? generatePassword()
      : requireString(req.body?.password, 'Password', { min: 10, max: 200 });

    await updatePassword(target.id, password, req.body?.mustChangePassword !== false);
    await sessionStore.destroyForUser(target.id);

    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'user',
      entityId: target.id,
      action: 'password_reset',
      summary: `Reset the password for ${target.email}`,
      ip: clientIp(req),
    });

    res.json({ ok: true, temporaryPassword: generated ? password : undefined });
  }),
);

usersRouter.delete(
  '/:id',
  requirePermission('users.delete'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const target = await findUserById(req.params.id);
    if (!target) throw notFound('That user does not exist.');
    if (target.id === actor.id) throw badRequest('You cannot delete your own account.');
    if (target.role === 'admin' && (await countActiveAdmins(target.id)) === 0) {
      throw badRequest('This is the only active administrator and cannot be deleted.');
    }

    // Tickets keep their history: the FK is ON DELETE SET NULL, so authorship
    // becomes "Unknown" rather than the ticket disappearing.
    await db.run(`DELETE FROM users WHERE id = ?`, [target.id]);
    await sessionStore.destroyForUser(target.id);

    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'user',
      entityId: target.id,
      action: 'user_deleted',
      summary: `Deleted account ${target.email}`,
      ip: clientIp(req),
    });

    res.json({ ok: true });
  }),
);
