/**
 * Invite links and department managers: an admin makes an invite, someone
 * signs themselves up through it into a department, and an admin then makes
 * them that department's manager. Driven over real HTTP against a throwaway
 * SQLite database.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'invites.db';
process.env.SESSION_SECRET = 'i'.repeat(48);
process.env.SECRET_KEY = 'e'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `invites.db${suffix}`), { force: true });
}

let server: http.Server;
let base: string;
let db: typeof import('../server/db/index.ts').db;
const cookies: Record<string, string> = {};
let platform: string;
let finance: string;

const PASSWORD = 'Str0ng-Password!';

async function call(who: string | null, method: string, url: string, body?: unknown) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: who ? (cookies[who] ?? '') : '' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload: any = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, payload, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? null };
}

async function login(who: string, email = `${who}@acme.test`, password = PASSWORD) {
  const result = await call(null, 'POST', '/api/auth/login', { login: email, password });
  assert.equal(result.status, 200, `login ${who}`);
  cookies[who] = result.cookie!;
}

const tokenOf = (url: string) => url.split('/invite/')[1];

before(async () => {
  wipe();
  const dist = path.resolve(import.meta.dirname, '../dist/client');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword(PASSWORD);
  const now = new Date().toISOString();
  for (const [id, role] of [
    ['admin', 'admin'],
    ['manager', 'manager'],
    ['agent', 'agent'],
  ]) {
    await db.run(
      'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,role_id,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, `${id}@acme.test`, id, `Person ${id}`, hash, salt, role, `role-${role}`, 'active', '#9a7b2f', 0, now, now],
    );
  }

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  for (const who of ['admin', 'manager', 'agent']) await login(who);
  platform = (await call('admin', 'POST', '/api/teams', { name: 'Platform', key: 'PLT' })).payload.team.id;
  finance = (await call('admin', 'POST', '/api/teams', { name: 'Finance', key: 'FIN' })).payload.team.id;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  wipe();
});

test('admins and managers can invite; agents cannot', async () => {
  const meta = (await call('admin', 'GET', '/api/users/meta')).payload;
  const manager = meta.roles.find((role: any) => role.systemKey === 'manager');
  assert.ok(manager.permissions.includes('users.invite'), 'Manager has users.invite');
  const agent = meta.roles.find((role: any) => role.systemKey === 'agent');
  assert.ok(!agent.permissions.includes('users.invite'), 'Agent does not');
  assert.equal((await call('agent', 'GET', '/api/invites')).status, 403);
  assert.equal((await call('agent', 'POST', '/api/invites', { roleId: 'role-agent' })).status, 403);
});

test('an invite is made, accepted into a department and signs the person in', async () => {
  const created = await call('admin', 'POST', '/api/invites', {
    label: 'Platform onboarding',
    roleId: 'role-agent',
    allowedDomains: ['acme.test'],
    teamIds: [],
  });
  assert.equal(created.status, 201);
  const token = tokenOf(created.payload.url);
  assert.equal(token, created.payload.token);
  assert.ok(token.startsWith('inv_'));
  // Only a hash is stored.
  const stored = await db.get<{ token_hash: string }>('SELECT token_hash FROM invites WHERE id = ?', [created.payload.invite.id]);
  assert.notEqual(stored!.token_hash, token);
  assert.ok(!JSON.stringify((await call('admin', 'GET', '/api/invites')).payload).includes(token), 'listing never shows the token');

  const preview = await call(null, 'GET', `/api/invite/${token}`);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.payload.invite.departments.map((d: any) => d.name).sort(), ['Finance', 'Platform']);
  assert.deepEqual(preview.payload.invite.allowedDomains, ['acme.test']);

  const accepted = await call(null, 'POST', `/api/invite/${token}/accept`, {
    firstName: 'Thandi',
    lastName: 'Mokoena',
    email: 'Thandi@Acme.test',
    teamId: platform,
    password: PASSWORD,
  });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.payload));
  assert.equal(accepted.payload.user.name, 'Thandi Mokoena');
  assert.equal(accepted.payload.user.email, 'thandi@acme.test');
  assert.deepEqual(accepted.payload.user.teamIds, [platform]);
  assert.deepEqual(accepted.payload.user.managedTeamIds, [], 'invitees join as plain members');
  assert.equal(accepted.payload.user.roleId, 'role-agent');

  // Signed straight in with the session the accept set.
  cookies.thandi = accepted.cookie!;
  const me = await call('thandi', 'GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.payload.user.email, 'thandi@acme.test');
  // And can sign in again later with the password they chose.
  await login('thandi2', 'thandi@acme.test');

  const list = (await call('admin', 'GET', '/api/invites')).payload.invites;
  assert.equal(list.find((invite: any) => invite.id === created.payload.invite.id).uses, 1);

  // Admins hear about it, so they can choose department managers.
  const notes = (await call('admin', 'GET', '/api/notifications')).payload;
  const items = notes.notifications ?? notes;
  assert.ok(items.some((note: any) => /Thandi Mokoena joined Platform/.test(note.title)), 'admin notified');

  // The accept is in the audit log.
  const audit = await db.get<{ action: string }>(`SELECT action FROM audit_log WHERE action = 'invite_accepted'`);
  assert.ok(audit, 'accept audited');
});

test('company email domains are enforced, and the email must be unused', async () => {
  const { payload } = await call('admin', 'POST', '/api/invites', { roleId: 'role-agent', allowedDomains: ['acme.test'] });
  const token = payload.token;
  const outside = await call(null, 'POST', `/api/invite/${token}/accept`, {
    firstName: 'Eve',
    lastName: 'Outside',
    email: 'eve@gmail.com',
    teamId: platform,
    password: PASSWORD,
  });
  assert.equal(outside.status, 400);
  assert.match(outside.payload.error, /company email/i);

  const taken = await call(null, 'POST', `/api/invite/${token}/accept`, {
    firstName: 'Agent',
    lastName: 'Again',
    email: 'agent@acme.test',
    teamId: platform,
    password: PASSWORD,
  });
  assert.equal(taken.status, 409);
  // Says only that the address is taken: nothing about the account behind it.
  assert.ok(!/agent|Person|role|suspend/i.test(taken.payload.error.replace('An account with that email already exists', '')), taken.payload.error);
  const unused = (await call('admin', 'GET', '/api/invites')).payload.invites.find((invite: any) => invite.id === payload.invite.id);
  assert.equal(unused.uses, 0, 'failed sign-ups do not use the invite up');
});

test('max uses, expiry and revoke all close a link, with one generic error', async () => {
  const single = (await call('admin', 'POST', '/api/invites', { roleId: 'role-agent', maxUses: 1 })).payload;
  const first = await call(null, 'POST', `/api/invite/${single.token}/accept`, {
    firstName: 'One',
    lastName: 'Use',
    email: 'one@acme.test',
    teamId: finance,
    password: PASSWORD,
  });
  assert.equal(first.status, 201);
  const second = await call(null, 'POST', `/api/invite/${single.token}/accept`, {
    firstName: 'Two',
    lastName: 'Use',
    email: 'two@acme.test',
    teamId: finance,
    password: PASSWORD,
  });
  assert.equal(second.status, 404);
  const usedUp = second.payload.error;

  const expiring = (await call('admin', 'POST', '/api/invites', { roleId: 'role-agent' })).payload;
  await db.run('UPDATE invites SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), expiring.invite.id]);
  const expired = await call(null, 'GET', `/api/invite/${expiring.token}`);
  assert.equal(expired.status, 404);

  const revoking = (await call('admin', 'POST', '/api/invites', { roleId: 'role-agent' })).payload;
  assert.equal((await call('admin', 'DELETE', `/api/invites/${revoking.invite.id}`)).status, 200);
  const revoked = await call(null, 'GET', `/api/invite/${revoking.token}`);
  assert.equal(revoked.status, 404);

  const unknown = await call(null, 'GET', `/api/invite/inv_${'x'.repeat(32)}`);
  assert.equal(unknown.status, 404);
  // Used up, expired, revoked and made up all read the same.
  assert.equal(new Set([usedUp, expired.payload.error, revoked.payload.error, unknown.payload.error]).size, 1);

  const statuses = (await call('admin', 'GET', '/api/invites')).payload.invites;
  assert.equal(statuses.find((invite: any) => invite.id === single.invite.id).status, 'used_up');
  assert.equal(statuses.find((invite: any) => invite.id === expiring.invite.id).status, 'expired');
  assert.equal(statuses.find((invite: any) => invite.id === revoking.invite.id).status, 'revoked');
});

test('two people racing for a single-use link: only one gets in', async () => {
  const single = (await call('admin', 'POST', '/api/invites', { roleId: 'role-agent', maxUses: 1 })).payload;
  const results = await Promise.all(
    ['race1', 'race2', 'race3'].map((name) =>
      call(null, 'POST', `/api/invite/${single.token}/accept`, {
        firstName: name,
        lastName: 'Racer',
        email: `${name}@acme.test`,
        teamId: platform,
        password: PASSWORD,
      }),
    ),
  );
  assert.equal(results.filter((result) => result.status === 201).length, 1, results.map((r) => r.status).join(','));
});

test('an invite limited to departments only offers and accepts those', async () => {
  const { payload } = await call('admin', 'POST', '/api/invites', { roleId: 'role-viewer', teamIds: [finance] });
  const preview = await call(null, 'GET', `/api/invite/${payload.token}`);
  assert.deepEqual(preview.payload.invite.departments.map((d: any) => d.id), [finance]);
  const wrong = await call(null, 'POST', `/api/invite/${payload.token}/accept`, {
    firstName: 'Wrong',
    lastName: 'Dept',
    email: 'wrong@acme.test',
    teamId: platform,
    password: PASSWORD,
  });
  assert.equal(wrong.status, 400);
});

test('an invite for one person is single-use and only for their address', async () => {
  const { payload } = await call('admin', 'POST', '/api/invites', { roleId: 'role-agent', email: 'named@acme.test' });
  assert.equal(payload.invite.maxUses, 1);
  const other = await call(null, 'POST', `/api/invite/${payload.token}/accept`, {
    firstName: 'Not',
    lastName: 'Named',
    email: 'other@acme.test',
    teamId: platform,
    password: PASSWORD,
  });
  assert.equal(other.status, 400);
  const named = await call(null, 'POST', `/api/invite/${payload.token}/accept`, {
    firstName: 'The',
    lastName: 'Named',
    email: 'named@acme.test',
    teamId: platform,
    password: PASSWORD,
  });
  assert.equal(named.status, 201);
});

test('nobody can invite people into a role they could not grant', async () => {
  const admin = await call('manager', 'POST', '/api/invites', { roleId: 'role-admin' });
  assert.equal(admin.status, 403);
  // A custom role holding something the manager lacks.
  const custom = await call('admin', 'POST', '/api/roles', { name: 'Integrator', permissions: ['integrations.manage', 'tickets.create'] });
  assert.equal(custom.status, 201);
  const refused = await call('manager', 'POST', '/api/invites', { roleId: custom.payload.role.id });
  assert.equal(refused.status, 403);
  const fine = await call('manager', 'POST', '/api/invites', { roleId: 'role-agent' });
  assert.equal(fine.status, 201);
});

test('admins make a member a department manager, who then runs that department’s on-call', async () => {
  const { payload } = await call('admin', 'POST', '/api/invites', { roleId: 'role-agent' });
  const joined = await call(null, 'POST', `/api/invite/${payload.token}/accept`, {
    firstName: 'Lead',
    lastName: 'Person',
    email: 'lead@acme.test',
    teamId: platform,
    password: PASSWORD,
  });
  assert.equal(joined.status, 201);
  cookies.lead = joined.cookie!;
  const leadId = joined.payload.user.id;

  // As a plain agent member, they cannot touch on-call.
  const before = await call('lead', 'POST', '/api/ops/schedules', { name: 'Platform primary', teamId: platform, timeZone: 'UTC', layers: [] });
  assert.equal(before.status, 403);

  // An agent cannot promote anyone.
  assert.equal((await call('agent', 'PUT', `/api/teams/${platform}/members/${leadId}`, { role: 'manager' })).status, 403);
  // Not a member of Finance, so cannot manage it.
  assert.equal((await call('admin', 'PUT', `/api/teams/${finance}/members/${leadId}`, { role: 'manager' })).status, 400);

  const promoted = await call('admin', 'PUT', `/api/teams/${platform}/members/${leadId}`, { role: 'manager' });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.payload));
  assert.deepEqual(promoted.payload.user.managedTeamIds, [platform]);
  assert.ok(promoted.payload.team.managerIds.includes(leadId));

  // Now they run Platform's on-call, but still not Finance's.
  const own = await call('lead', 'POST', '/api/ops/schedules', { name: 'Platform primary', teamId: platform, timeZone: 'UTC', layers: [] });
  assert.equal(own.status, 201, JSON.stringify(own.payload));
  const other = await call('lead', 'POST', '/api/ops/schedules', { name: 'Finance primary', teamId: finance, timeZone: 'UTC', layers: [] });
  assert.equal(other.status, 403);

  // Editing their departments keeps who manages what, unless told otherwise.
  await call('admin', 'PATCH', `/api/users/${leadId}`, { teamIds: [platform, finance] });
  let user = (await call('admin', 'GET', `/api/users/${leadId}`)).payload.user;
  assert.deepEqual(user.managedTeamIds, [platform]);
  await call('admin', 'PATCH', `/api/users/${leadId}`, { teamIds: [platform, finance], managedTeamIds: [finance] });
  user = (await call('admin', 'GET', `/api/users/${leadId}`)).payload.user;
  assert.deepEqual(user.managedTeamIds, [finance]);

  // And from the department side.
  await call('admin', 'PATCH', `/api/teams/${platform}`, { managerIds: [leadId] });
  user = (await call('admin', 'GET', `/api/users/${leadId}`)).payload.user;
  assert.deepEqual(user.managedTeamIds.sort(), [finance, platform].sort());

  const audit = await db.get<{ action: string }>(`SELECT action FROM audit_log WHERE action = 'department_role_changed'`);
  assert.ok(audit);
});

test('upgrading gives users.invite to every role and person holding users.create, and nothing else', async () => {
  const { syncRoles } = await import('../server/db/roles-sync.ts');
  const custom = (await call('admin', 'POST', '/api/roles', { name: 'Provisioner', permissions: ['users.view', 'users.create'] })).payload.role;
  // Pretend an older version: the custom role and an extra grant lack the new key.
  await db.run('UPDATE roles SET permissions = ? WHERE id = ?', [JSON.stringify(['users.view', 'users.create']), custom.id]);
  await db.run(`INSERT INTO user_permissions (user_id, permission) VALUES ('agent', 'users.create')`);
  await db.run(`UPDATE settings SET value = '1' WHERE key = 'ops.permissions_version'`);

  await syncRoles(db as any);

  const role = await db.get<{ permissions: string }>('SELECT permissions FROM roles WHERE id = ?', [custom.id]);
  assert.deepEqual(JSON.parse(role!.permissions).sort(), ['users.create', 'users.invite', 'users.view']);
  const extras = await db.all<{ permission: string }>(`SELECT permission FROM user_permissions WHERE user_id = 'agent'`);
  assert.deepEqual(extras.map((row) => row.permission).sort(), ['users.create', 'users.invite']);
});
