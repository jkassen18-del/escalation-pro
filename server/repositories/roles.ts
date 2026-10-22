import { db } from '../db/index.ts';
import { BUILT_IN_ROLE_ID, parseRolePermissions } from '../db/roles-sync.ts';
import { randomId } from '../lib/crypto.ts';
import { ALL_PERMISSIONS, tierForPermissions } from '../permissions.ts';
import { USER_ROLES, type Permission, type Role, type UserRole } from '../../shared/types.ts';

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  permissions: string;
  system_key: string | null;
  tier: string;
  created_at: string;
  updated_at: string;
}

function asTier(value: string | null): UserRole {
  return (USER_ROLES as readonly string[]).includes(value ?? '') ? (value as UserRole) : 'viewer';
}

function mapRole(row: RoleRow, memberCount = 0): Role {
  const systemKey = row.system_key ? asTier(row.system_key) : null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    // Administrator holds everything, whatever the stored list says.
    permissions: systemKey === 'admin' ? [...ALL_PERMISSIONS] : parseRolePermissions(row.permissions),
    systemKey,
    tier: systemKey ?? asTier(row.tier),
    memberCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Built-ins first in a fixed order, then the rest by name. */
function sortRoles(roles: Role[]): Role[] {
  const rank = (role: Role) => (role.systemKey ? USER_ROLES.indexOf(role.systemKey) : USER_ROLES.length);
  return roles.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export async function listRoles(): Promise<Role[]> {
  const rows = await db.all<RoleRow>(`SELECT * FROM roles`);
  const counts = await db.all<{ role_id: string; n: number | string }>(
    `SELECT role_id, COUNT(*) AS n FROM users WHERE role_id IS NOT NULL GROUP BY role_id`,
  );
  const byRole = new Map(counts.map((row) => [row.role_id, Number(row.n)]));
  return sortRoles(rows.map((row) => mapRole(row, byRole.get(row.id) ?? 0)));
}

/** Every role keyed by id, for resolving many users at once. */
export async function roleMap(): Promise<Map<string, Role>> {
  const rows = await db.all<RoleRow>(`SELECT * FROM roles`);
  return new Map(rows.map((row) => [row.id, mapRole(row)]));
}

export async function getRole(id: string): Promise<Role | null> {
  const row = await db.get<RoleRow>(`SELECT * FROM roles WHERE id = ?`, [id]);
  if (!row) return null;
  const count = await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM users WHERE role_id = ?`, [id]);
  return mapRole(row, Number(count?.n ?? 0));
}

export function builtInRoleId(tier: UserRole): string {
  return BUILT_IN_ROLE_ID(tier);
}

export async function roleNameTaken(name: string, excludeId?: string): Promise<boolean> {
  const row = await db.get<{ id: string }>(
    `SELECT id FROM roles WHERE LOWER(name) = ?${excludeId ? ' AND id <> ?' : ''}`,
    excludeId ? [name.toLowerCase(), excludeId] : [name.toLowerCase()],
  );
  return Boolean(row);
}

export async function createRole(input: { name: string; description: string | null; permissions: Permission[] }): Promise<string> {
  const id = randomId();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO roles (id, name, description, permissions, system_key, tier, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
    [id, input.name, input.description, JSON.stringify(input.permissions), tierForPermissions(input.permissions), now, now],
  );
  return id;
}

/** Keeps each member's legacy tier column in step with their role. */
async function syncMemberTiers(roleId: string, tier: UserRole): Promise<void> {
  await db.run(`UPDATE users SET role = ?, updated_at = ? WHERE role_id = ? AND role <> ?`, [tier, new Date().toISOString(), roleId, tier]);
}

export async function updateRole(
  role: Role,
  patch: { name?: string; description?: string | null; permissions?: Permission[] },
): Promise<void> {
  const permissions = patch.permissions ?? role.permissions;
  const tier = role.systemKey ?? tierForPermissions(permissions);
  await db.run(
    `UPDATE roles SET name = ?, description = ?, permissions = ?, tier = ?, updated_at = ? WHERE id = ?`,
    [
      patch.name ?? role.name,
      patch.description === undefined ? role.description : patch.description,
      JSON.stringify(permissions),
      tier,
      new Date().toISOString(),
      role.id,
    ],
  );
  await syncMemberTiers(role.id, tier);
}

/** Moves every member to `replacement`, then removes the role. */
export async function deleteRole(role: Role, replacement: Role | null): Promise<void> {
  await db.transaction(async () => {
    if (replacement) {
      await db.run(`UPDATE users SET role_id = ?, role = ?, updated_at = ? WHERE role_id = ?`, [
        replacement.id,
        replacement.tier,
        new Date().toISOString(),
        role.id,
      ]);
    }
    await db.run(`DELETE FROM roles WHERE id = ?`, [role.id]);
  });
}
