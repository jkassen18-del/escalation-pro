import { Router } from 'express';
import { asyncRoute, badRequest, conflict, forbidden, notFound, optionalString, requireString, toStringArray } from '../lib/http.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
import { ALL_PERMISSIONS, isPermission, ungrantablePermissions } from '../permissions.ts';
import { createRole, deleteRole, getRole, listRoles, roleNameTaken, updateRole } from '../repositories/roles.ts';
import type { Permission, PublicUser } from '../../shared/types.ts';

/**
 * Roles: named sets of permissions. Anyone signed in may read them (the user
 * dialog shows what a role grants); changing them needs roles.manage, and
 * nobody may put a permission into a role that they do not hold themselves.
 */
export const rolesRouter: Router = Router();

rolesRouter.use(requireAuth);

rolesRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    res.json({ roles: await listRoles() });
  }),
);

function readPermissions(value: unknown): Permission[] {
  return toStringArray(value, ALL_PERMISSIONS.length).filter(isPermission);
}

function assertGrantable(actor: PublicUser, requested: Permission[]): void {
  const refused = ungrantablePermissions(actor, requested);
  if (refused.length) {
    throw forbidden(`You cannot grant ${refused.map((permission) => `"${permission}"`).join(', ')}.`);
  }
}

rolesRouter.post(
  '/',
  requirePermission('roles.manage'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const name = requireString(req.body?.name, 'Name', { max: 60 });
    if (await roleNameTaken(name)) throw conflict('A role with that name already exists.');
    const permissions = readPermissions(req.body?.permissions);
    assertGrantable(actor, permissions);
    const id = await createRole({ name, description: optionalString(req.body?.description, 300), permissions });
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'role',
      entityId: id,
      action: 'role_created',
      summary: `Created the "${name}" role`,
      meta: { permissions },
      ip: clientIp(req),
    });
    res.status(201).json({ role: await getRole(id) });
  }),
);

rolesRouter.patch(
  '/:id',
  requirePermission('roles.manage'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const role = await getRole(req.params.id);
    if (!role) throw notFound('That role does not exist.');
    if (role.systemKey === 'admin') throw badRequest('The Administrator role always holds every permission and cannot be changed.');

    const name = req.body?.name !== undefined ? requireString(req.body.name, 'Name', { max: 60 }) : undefined;
    if (name !== undefined && role.systemKey && name !== role.name) throw badRequest('Built-in roles keep their names.');
    if (name !== undefined && (await roleNameTaken(name, role.id))) throw conflict('A role with that name already exists.');

    let permissions: Permission[] | undefined;
    if (req.body?.permissions !== undefined) {
      permissions = readPermissions(req.body.permissions);
      // Only additions are checked, so a manager can take away a permission
      // an administrator put in, but never add one they lack.
      assertGrantable(actor, permissions.filter((permission) => !role.permissions.includes(permission)));
      // Removals are checked too: editing your own role down is fine, but
      // taking away what you do not hold yourself is an administrator's call.
      const removed = role.permissions.filter((permission) => !permissions!.includes(permission));
      if (actor.role !== 'admin') assertGrantable(actor, removed);
    }

    await updateRole(role, {
      name,
      description: req.body?.description !== undefined ? optionalString(req.body.description, 300) : undefined,
      permissions,
    });
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'role',
      entityId: role.id,
      action: 'role_updated',
      summary: `Updated the "${name ?? role.name}" role`,
      meta: permissions
        ? {
            added: permissions.filter((permission) => !role.permissions.includes(permission)),
            removed: role.permissions.filter((permission) => !permissions!.includes(permission)),
          }
        : undefined,
      ip: clientIp(req),
    });
    res.json({ role: await getRole(role.id) });
  }),
);

rolesRouter.delete(
  '/:id',
  requirePermission('roles.manage'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const role = await getRole(req.params.id);
    if (!role) throw notFound('That role does not exist.');
    if (role.systemKey) throw badRequest('Built-in roles cannot be deleted.');

    let replacement = null;
    if (role.memberCount > 0) {
      const replacementId = optionalString(req.body?.replacementRoleId ?? req.query.replacementRoleId, 60);
      if (!replacementId) {
        throw badRequest(`${role.memberCount} ${role.memberCount === 1 ? 'person holds' : 'people hold'} this role. Choose a role to move them to.`, {
          replacementRoleId: 'Required',
        });
      }
      replacement = await getRole(replacementId);
      if (!replacement || replacement.id === role.id) throw badRequest('Choose a different, existing role to move people to.');
      if (replacement.systemKey === 'admin' && actor.role !== 'admin') throw forbidden('Only an administrator can make people administrators.');
      assertGrantable(actor, replacement.permissions);
    }

    await deleteRole(role, replacement);
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'role',
      entityId: role.id,
      action: 'role_deleted',
      summary: replacement
        ? `Deleted the "${role.name}" role and moved ${role.memberCount} ${role.memberCount === 1 ? 'person' : 'people'} to "${replacement.name}"`
        : `Deleted the "${role.name}" role`,
      ip: clientIp(req),
    });
    res.json({ ok: true });
  }),
);
