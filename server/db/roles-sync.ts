import type { DbDriver } from './driver.ts';
import { ALL_PERMISSIONS, ROLE_DESCRIPTIONS, ROLE_LABELS, expandImplied, isPermission, permissionsForRole } from '../permissions.ts';
import { USER_ROLES, type Permission } from '../../shared/types.ts';

/**
 * Bumped whenever the permission catalogue changes in a way existing grants
 * have to follow. Version 1 is the move from four fixed roles to editable ones.
 */
const PERMISSIONS_VERSION = 2;

/**
 * Permissions added after version 1, by the version that added them. On
 * upgrade, every role and every person holding the permission each one was
 * split from gets it too. Only these are widened: re-expanding everything
 * would undo permissions an admin deliberately took out of a role.
 */
const ADDED_IN: Record<number, Permission[]> = {
  2: ['users.invite'],
};
const VERSION_KEY = 'ops.permissions_version';

export const BUILT_IN_ROLE_ID = (key: string) => `role-${key}`;

function parse(value: string | null | undefined): Permission[] {
  try {
    const list = JSON.parse(value ?? '[]');
    return Array.isArray(list) ? list.filter(isPermission) : [];
  } catch {
    return [];
  }
}

/**
 * Runs on every start, after the tables exist. Idempotent.
 *
 *  - creates the four built-in roles the first time, with exactly what those
 *    roles could do before roles became editable;
 *  - gives everyone without a role the built-in role matching their tier;
 *  - on an upgrade, widens stored extra grants to the permissions that were
 *    split out of them, so nobody loses access;
 *  - keeps Administrator holding every permission, including new ones.
 */
export async function syncRoles(driver: DbDriver): Promise<void> {
  const now = new Date().toISOString();
  const versionRow = await driver.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, [VERSION_KEY]);
  const version = Number(versionRow?.value ?? 0);

  for (const key of USER_ROLES) {
    await driver.run(
      `INSERT INTO roles (id, name, description, permissions, system_key, tier, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [BUILT_IN_ROLE_ID(key), ROLE_LABELS[key], ROLE_DESCRIPTIONS[key], JSON.stringify(permissionsForRole(key)), key, key, now, now],
    );
  }
  await driver.run(`UPDATE roles SET permissions = ? WHERE system_key = 'admin'`, [JSON.stringify(ALL_PERMISSIONS)]);

  if (version < 1) {
    // Extra grants were stored against the old, coarser permissions.
    const rows = await driver.all<{ user_id: string; permission: string }>(`SELECT user_id, permission FROM user_permissions`);
    const byUser = new Map<string, Permission[]>();
    for (const row of rows) {
      if (!isPermission(row.permission)) continue;
      byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row.permission]);
    }
    for (const [userId, held] of byUser) {
      for (const permission of expandImplied(held)) {
        if (held.includes(permission)) continue;
        await driver.run(
          `INSERT INTO user_permissions (user_id, permission) VALUES (?, ?) ON CONFLICT (user_id, permission) DO NOTHING`,
          [userId, permission],
        );
      }
    }
  }

  for (let step = Math.max(version, 1) + 1; step <= PERMISSIONS_VERSION; step += 1) {
    await widenGrants(driver, ADDED_IN[step] ?? []);
  }

  for (const key of USER_ROLES) {
    await driver.run(`UPDATE users SET role_id = ? WHERE role_id IS NULL AND role = ?`, [BUILT_IN_ROLE_ID(key), key]);
  }
  // Anything else (a hand-edited row, an unknown role) falls back to Viewer.
  await driver.run(`UPDATE users SET role_id = ?, role = 'viewer' WHERE role_id IS NULL`, [BUILT_IN_ROLE_ID('viewer')]);

  if (version < PERMISSIONS_VERSION) {
    await driver.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [VERSION_KEY, String(PERMISSIONS_VERSION), now],
    );
  }
}

/** Gives `added` to every role and every person holding what each was split from. */
async function widenGrants(driver: DbDriver, added: Permission[]): Promise<void> {
  if (!added.length) return;
  const roles = await driver.all<{ id: string; permissions: string }>(`SELECT id, permissions FROM roles`);
  for (const role of roles) {
    const held = parse(role.permissions);
    const widened = expandImplied(held).filter((key) => held.includes(key) || added.includes(key));
    if (widened.length !== held.length) {
      await driver.run(`UPDATE roles SET permissions = ? WHERE id = ?`, [JSON.stringify(widened), role.id]);
    }
  }
  const rows = await driver.all<{ user_id: string; permission: string }>(`SELECT user_id, permission FROM user_permissions`);
  const byUser = new Map<string, Permission[]>();
  for (const row of rows) {
    if (isPermission(row.permission)) byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row.permission]);
  }
  for (const [userId, held] of byUser) {
    for (const permission of expandImplied(held)) {
      if (held.includes(permission) || !added.includes(permission)) continue;
      await driver.run(
        `INSERT INTO user_permissions (user_id, permission) VALUES (?, ?) ON CONFLICT (user_id, permission) DO NOTHING`,
        [userId, permission],
      );
    }
  }
}

export { parse as parseRolePermissions };
