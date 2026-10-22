/**
 * Run by roles-engines.test.ts in a child process, one per database engine
 * (config.ts reads the connection settings once at import). Prints
 * RESULT:<json> for the parent to check.
 */
const { initDatabase, db } = await import('../server/db/index.ts');
const { createDriver } = await import('../server/db/driver.ts');
const { migrate } = await import('../server/db/schema.ts');
const { syncRoles } = await import('../server/db/roles-sync.ts');
const roles = await import('../server/repositories/roles.ts');
const users = await import('../server/repositories/users.ts');

const result: Record<string, unknown> = {};

// Two instances starting together seed the built-in roles exactly once.
const [first, second] = await Promise.all([createDriver(), createDriver()]);
await Promise.all([migrate(first), migrate(second)]);
await first.close();
await second.close();
await initDatabase();
result.builtIns = (await roles.listRoles()).filter((role) => role.systemKey).map((role) => role.systemKey);

// An account as an older version left it: a tier, no role row, an old extra.
await db.run(`DELETE FROM users WHERE email = 'legacy@roles.test'`);
const legacyId = await users.createUser({ email: 'legacy@roles.test', username: 'legacy-roles', name: 'Legacy', password: 'x'.repeat(12), role: 'viewer' });
await db.run(`UPDATE users SET role_id = NULL WHERE id = ?`, [legacyId]);
await users.setUserPermissions(legacyId, ['tickets.update']);
await db.run(`DELETE FROM settings WHERE key = 'ops.permissions_version'`);
await syncRoles(db as never);
const legacy = await users.findUserById(legacyId);
result.legacyRole = legacy?.roleId;
result.legacyCanClose = legacy?.permissions.includes('tickets.close');

// A custom role round-trips its permissions and keeps its holders' tier in step.
const id = await roles.createRole({ name: `Desk ${Date.now()}`, description: null, permissions: ['tickets.create', 'tickets.update'] });
await db.run(`UPDATE users SET role_id = ? WHERE id = ?`, [id, legacyId]);
const created = await roles.getRole(id);
result.customTier = created?.tier;
await roles.updateRole(created!, { permissions: ['tickets.create', 'users.update'] });
result.memberTier = (await users.findUserById(legacyId))?.role;
const replacement = await roles.getRole('role-viewer');
await roles.deleteRole((await roles.getRole(id))!, replacement);
result.afterDelete = (await users.findUserById(legacyId))?.roleId;
await db.run(`DELETE FROM users WHERE id = ?`, [legacyId]);

console.log(`RESULT:${JSON.stringify(result)}`);
process.exit(0);
