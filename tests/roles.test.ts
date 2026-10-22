/**
 * Editable roles, fine-grained permissions and departmental access: the
 * built-in roles and the upgrade from fixed roles, custom role CRUD, a custom
 * role enforced route by route, the granting rule, department assignment,
 * department-scoped ticket visibility and department-scoped on-call editing.
 * Driven over real HTTP against a throwaway SQLite database.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Before any server module loads: config reads these once, at import.
process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'roles.db';
process.env.SESSION_SECRET = 's'.repeat(48);
process.env.SECRET_KEY = 'd'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `roles.db${suffix}`), { force: true });
}

let server: http.Server;
let base: string;
let db: typeof import('../server/db/index.ts').db;
let perms: typeof import('../server/permissions.ts');
const cookies: Record<string, string> = {};
let platform: string;
let finance: string;

const PASSWORD = 'Str0ng-Password!';

async function call(who: string, method: string, url: string, body?: unknown) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: cookies[who] ?? '' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload: any = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, payload };
}

async function login(who: string, email = `${who}@acme.test`, password = PASSWORD) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: email, password }),
  });
  assert.equal(response.status, 200, `login ${who}`);
  cookies[who] = response.headers.get('set-cookie')!.split(';')[0];
}

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
  perms = await import('../server/permissions.ts');

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword(PASSWORD);
  const now = new Date().toISOString();
  for (const [id, role] of [
    ['admin', 'admin'],
    ['manager', 'manager'],
    ['agent', 'agent'],
    ['outsider', 'agent'],
    ['viewer', 'viewer'],
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

  for (const who of ['admin', 'manager', 'agent', 'outsider', 'viewer']) await login(who);

  platform = (await call('admin', 'POST', '/api/teams', { name: 'Platform', key: 'PLT' })).payload.team.id;
  finance = (await call('admin', 'POST', '/api/teams', { name: 'Finance', key: 'FIN' })).payload.team.id;
  for (const [user, team] of [
    ['manager', platform],
    ['agent', platform],
    ['viewer', platform],
    ['outsider', finance],
  ]) {
    await db.run('INSERT INTO team_members (team_id, user_id, is_lead) VALUES (?, ?, 0)', [team, user]);
  }
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  wipe();
});

/* ------------------------------ Built-in roles ----------------------------- */

test('the four built-in roles are seeded with what those roles could always do', async () => {
  const { payload } = await call('admin', 'GET', '/api/roles');
  const byKey = new Map(payload.roles.map((role: any) => [role.systemKey, role]));
  assert.deepEqual([...byKey.keys()].filter(Boolean).sort(), ['admin', 'agent', 'manager', 'viewer']);
  for (const key of ['admin', 'manager', 'agent', 'viewer'] as const) {
    assert.deepEqual((byKey.get(key) as any).permissions.sort(), perms.permissionsForRole(key).sort(), key);
  }
  assert.equal((byKey.get('admin') as any).permissions.length, perms.ALL_PERMISSIONS.length, 'administrator holds everything');

  // The old fixed lists, verbatim: every built-in still holds all of it.
  const legacy: Record<string, string[]> = {
    agent: ['tickets.create', 'tickets.update', 'tickets.assign', 'tickets.comment_internal', 'users.view', 'reports.view'],
    viewer: ['users.view'],
    manager: ['tickets.view_all', 'tickets.create', 'tickets.update', 'tickets.assign', 'tickets.comment_internal', 'users.view', 'users.create', 'users.update', 'users.reset_password', 'teams.manage', 'reports.view', 'reports.export', 'audit.view', 'monitors.manage', 'statuspages.manage'],
  };
  for (const [key, list] of Object.entries(legacy)) {
    const held = (byKey.get(key) as any).permissions as string[];
    for (const permission of list) assert.ok(held.includes(permission), `${key} kept ${permission}`);
  }
  // Splits follow the permission they came out of.
  assert.ok((byKey.get('agent') as any).permissions.includes('tickets.close'));
  assert.ok(!(byKey.get('viewer') as any).permissions.includes('tickets.close'));
  // The one deliberate change: managers run their own departments' on-call.
  assert.ok((byKey.get('manager') as any).permissions.includes('oncall.manage_own_department'));
  assert.ok(!(byKey.get('manager') as any).permissions.includes('oncall.manage'));
});

test('an upgrade backfills roles and widens stored extras to the permissions split out of them', async () => {
  const { syncRoles } = await import('../server/db/roles-sync.ts');
  const now = new Date().toISOString();
  const { hash, salt } = (await import('../server/lib/crypto.ts')).hashPassword(PASSWORD);
  // An account as an older version left it: a role tier, no role row, an old extra grant.
  await db.run(
    'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['legacy', 'legacy@acme.test', 'legacy', 'Legacy', hash, salt, 'viewer', 'active', '#9a7b2f', 0, now, now],
  );
  await db.run(`INSERT INTO user_permissions (user_id, permission) VALUES ('legacy', 'tickets.update')`);
  await db.run(`DELETE FROM settings WHERE key = 'ops.permissions_version'`);

  await syncRoles(db as never);
  await syncRoles(db as never); // idempotent

  const row = await db.get<{ role_id: string }>(`SELECT role_id FROM users WHERE id = 'legacy'`);
  assert.equal(row?.role_id, 'role-viewer');
  const extras = (await db.all<{ permission: string }>(`SELECT permission FROM user_permissions WHERE user_id = 'legacy'`)).map((r) => r.permission);
  for (const permission of ['tickets.update', 'tickets.close', 'tickets.reopen', 'tickets.change_status', 'tickets.escalate']) {
    assert.ok(extras.includes(permission), `kept access through ${permission}`);
  }
  const roles = await db.all<{ id: string }>(`SELECT id FROM roles WHERE system_key IS NOT NULL`);
  assert.equal(roles.length, 4, 'no duplicate built-ins');
});

/* ------------------------------- Custom roles ------------------------------- */

let auditorId: string;

test('custom roles can be created, edited and deleted; one in use needs a replacement', async () => {
  const created = await call('admin', 'POST', '/api/roles', {
    name: 'Auditor',
    description: 'Reads everything, changes nothing',
    permissions: ['tickets.view_all', 'reports.view', 'audit.view', 'not.a.permission'],
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  auditorId = created.payload.role.id;
  assert.deepEqual(created.payload.role.permissions.sort(), ['audit.view', 'reports.view', 'tickets.view_all']);
  assert.equal(created.payload.role.systemKey, null);
  assert.equal(created.payload.role.tier, 'viewer');

  assert.equal((await call('admin', 'POST', '/api/roles', { name: 'auditor', permissions: [] })).status, 409, 'names are unique');

  const edited = await call('admin', 'PATCH', `/api/roles/${auditorId}`, { permissions: ['tickets.view_all', 'reports.view', 'reports.export', 'audit.view'] });
  assert.equal(edited.status, 200);
  assert.ok(edited.payload.role.permissions.includes('reports.export'));

  // Built-ins: Administrator is locked, the others cannot be renamed or deleted.
  assert.equal((await call('admin', 'PATCH', '/api/roles/role-admin', { permissions: [] })).status, 400);
  assert.equal((await call('admin', 'PATCH', '/api/roles/role-agent', { name: 'Grunt' })).status, 400);
  assert.equal((await call('admin', 'DELETE', '/api/roles/role-viewer')).status, 400);

  // In use: a replacement is required, and people move to it.
  const temp = (await call('admin', 'POST', '/api/roles', { name: 'Temporary', permissions: ['users.view'] })).payload.role;
  await call('admin', 'PATCH', '/api/users/outsider', { roleId: temp.id });
  const refused = await call('admin', 'DELETE', `/api/roles/${temp.id}`);
  assert.equal(refused.status, 400);
  assert.match(refused.payload.error, /1 person holds/);
  assert.equal((await call('admin', 'DELETE', `/api/roles/${temp.id}?replacementRoleId=role-agent`)).status, 200);
  const moved = (await call('admin', 'GET', '/api/users/outsider')).payload.user;
  assert.equal(moved.roleId, 'role-agent');
  assert.equal(moved.role, 'agent');
});

test("a custom role's permissions are enforced route by route", async () => {
  const role = (
    await call('admin', 'POST', '/api/roles', {
      name: 'Requester',
      permissions: ['tickets.create', 'tickets.reply', 'users.view'],
    })
  ).payload.role;
  const created = await call('admin', 'POST', '/api/users', {
    name: 'Rae Quester',
    email: 'rae@acme.test',
    roleId: role.id,
    teamIds: [platform],
    password: PASSWORD,
    mustChangePassword: false,
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.user.roleName, 'Requester');
  assert.deepEqual(created.payload.user.teamIds, [platform], 'departments chosen at creation');
  await login('rae', 'rae@acme.test');

  const ticket = await call('rae', 'POST', '/api/tickets', { subject: 'Printer on fire', teamId: platform });
  assert.equal(ticket.status, 201);
  const id = ticket.payload.ticket.id;
  assert.equal((await call('rae', 'POST', `/api/tickets/${id}/comments`, { body: 'Still burning' })).status, 201);
  assert.equal((await call('rae', 'POST', `/api/tickets/${id}/comments`, { body: 'secret', isInternal: true })).status, 403);
  assert.equal((await call('rae', 'PATCH', `/api/tickets/${id}`, { status: 'resolved' })).status, 403);
  assert.equal((await call('rae', 'POST', `/api/tickets/${id}/escalate`, { reason: 'x' })).status, 403);
  assert.equal((await call('rae', 'GET', '/api/ops/monitors')).status, 403, 'no ops.view in this role');
  assert.equal((await call('rae', 'GET', '/api/reports/summary')).status, 403);

  // Close-only: may resolve, may not touch the priority or the subject.
  await call('admin', 'PATCH', `/api/roles/${role.id}`, { permissions: ['tickets.create', 'tickets.reply', 'tickets.close', 'ops.view', 'users.view'] });
  assert.equal((await call('rae', 'PATCH', `/api/tickets/${id}`, { priority: 'urgent' })).status, 403);
  assert.equal((await call('rae', 'PATCH', `/api/tickets/${id}`, { subject: 'Renamed' })).status, 403);
  assert.equal((await call('rae', 'PATCH', `/api/tickets/${id}`, { status: 'resolved' })).status, 200);
  assert.equal((await call('rae', 'PATCH', `/api/tickets/${id}`, { status: 'open' })).status, 403, 'reopening is its own permission');
  assert.equal((await call('rae', 'GET', '/api/ops/monitors')).status, 200);

  // An extra permission on the person adds to the role.
  await call('admin', 'PATCH', '/api/users/' + created.payload.user.id, { extraPermissions: ['tickets.reopen'] });
  assert.equal((await call('rae', 'PATCH', `/api/tickets/${id}`, { status: 'open' })).status, 200);
});

/* ------------------------------ Granting rule ------------------------------ */

test('nobody hands out what they do not hold, and administrators stay with administrators', async () => {
  // Managers cannot manage roles at all by default...
  assert.equal((await call('manager', 'POST', '/api/roles', { name: 'Mine', permissions: [] })).status, 403);
  // ...and with roles.manage still cannot put in what they lack.
  await call('admin', 'PATCH', '/api/users/manager', { extraPermissions: ['roles.manage'] });
  const tooMuch = await call('manager', 'POST', '/api/roles', { name: 'Sneaky', permissions: ['settings.manage'] });
  assert.equal(tooMuch.status, 403);
  const fine = await call('manager', 'POST', '/api/roles', { name: 'Desk', permissions: ['tickets.create', 'tickets.view_all'] });
  assert.equal(fine.status, 201, JSON.stringify(fine.payload));

  // A role holding something the manager lacks cannot be given to anyone by them.
  assert.equal((await call('manager', 'PATCH', '/api/users/agent', { roleId: auditorId })).status, 200, 'auditor is within a manager');
  const strong = (await call('admin', 'POST', '/api/roles', { name: 'Integrator', permissions: ['integrations.manage'] })).payload.role;
  assert.equal((await call('manager', 'PATCH', '/api/users/agent', { roleId: strong.id })).status, 403);
  assert.equal((await call('manager', 'PATCH', '/api/users/agent', { roleId: 'role-admin' })).status, 403);
  assert.equal((await call('manager', 'POST', '/api/users', { name: 'N', email: 'n@acme.test', roleId: strong.id })).status, 403);
  assert.equal((await call('manager', 'PATCH', '/api/users/admin', { name: 'Hijacked' })).status, 403);
  assert.equal((await call('manager', 'POST', '/api/users/admin/reset-password', {})).status, 403);
  await call('manager', 'PATCH', '/api/users/agent', { roleId: 'role-agent' });

  // Agents cannot change roles at all.
  assert.equal((await call('agent', 'PATCH', '/api/users/viewer', { roleId: 'role-agent' })).status, 403);
});

/* ---------------------------- Departmental access --------------------------- */

test('people without view-all only see their own departments’ tickets, everywhere', async () => {
  const mine = (await call('admin', 'POST', '/api/tickets', { subject: 'Platform outage', teamId: platform })).payload.ticket;
  const theirs = (await call('admin', 'POST', '/api/tickets', { subject: 'Payroll run failed', teamId: finance })).payload.ticket;

  const list = (await call('agent', 'GET', '/api/tickets?limit=200')).payload.tickets.map((t: any) => t.id);
  assert.ok(list.includes(mine.id));
  assert.ok(!list.includes(theirs.id), 'another department’s ticket leaked into the list');
  const search = (await call('agent', 'GET', '/api/tickets?search=Payroll')).payload;
  assert.equal(search.total, 0, 'search leaked another department');
  assert.equal((await call('agent', 'GET', `/api/tickets/${theirs.id}`)).status, 403);
  assert.equal((await call('agent', 'POST', `/api/tickets/${theirs.id}/comments`, { body: 'hi' })).status, 403);

  // Alerts and pages tied to another department's ticket are filtered out.
  const now = new Date().toISOString();
  for (const [id, ticketId] of [['al-mine', mine.id], ['al-theirs', theirs.id], ['al-none', null]]) {
    await db.run(
      `INSERT INTO alerts (id, source_type, source_id, source_name, dedup_key, title, severity, status, ticket_id, count, first_seen_at, last_seen_at)
       VALUES (?, 'source', 'src', 'Src', ?, ?, 'sev2', 'firing', ?, 1, ?, ?)`,
      [id, id, id, ticketId, now, now],
    );
  }
  const alerts = (await call('agent', 'GET', '/api/ops/alerts')).payload.alerts.map((a: any) => a.id).sort();
  assert.deepEqual(alerts, ['al-mine', 'al-none']);
  const all = (await call('admin', 'GET', '/api/ops/alerts')).payload.alerts.length;
  assert.equal(all, 3, 'view-all still sees every alert');

  // Reports count only what the viewer can see.
  const asAgent = (await call('agent', 'GET', '/api/reports/summary')).payload;
  const asAdmin = (await call('admin', 'GET', '/api/reports/summary')).payload;
  assert.ok(JSON.stringify(asAgent).length > 2);
  assert.ok(asAgent.ticketCount < asAdmin.ticketCount, 'the report counted another department');
});

test('on-call is visible to everyone, but each department edits only its own', async () => {
  const schedule = { name: 'Platform primary', teamId: platform, timeZone: 'UTC', layers: [] };

  // Everyone can read schedules.
  assert.equal((await call('viewer', 'GET', '/api/ops/schedules')).status, 200);

  // The manager runs Platform's on-call...
  const created = await call('manager', 'POST', '/api/ops/schedules', schedule);
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const id = created.payload.schedule.id;
  assert.equal((await call('manager', 'PUT', `/api/ops/schedules/${id}`, { ...schedule, name: 'Platform 24/7' })).status, 200);
  // ...but not Finance's, not one with no department, and cannot move theirs away.
  assert.equal((await call('manager', 'POST', '/api/ops/schedules', { ...schedule, teamId: finance })).status, 403);
  assert.equal((await call('manager', 'POST', '/api/ops/schedules', { ...schedule, teamId: null })).status, 403);
  assert.equal((await call('manager', 'PUT', `/api/ops/schedules/${id}`, { ...schedule, teamId: finance })).status, 403);

  const financeSchedule = (await call('admin', 'POST', '/api/ops/schedules', { ...schedule, name: 'Finance', teamId: finance })).payload.schedule;
  assert.equal((await call('manager', 'DELETE', `/api/ops/schedules/${financeSchedule.id}`)).status, 403);
  const start = new Date(Date.now() + 3_600_000).toISOString();
  const end = new Date(Date.now() + 7_200_000).toISOString();
  // A manager may put anyone on cover for their own department, not for another.
  assert.equal((await call('manager', 'POST', `/api/ops/schedules/${id}/overrides`, { userId: 'agent', startsAt: start, endsAt: end })).status, 201);
  assert.equal((await call('manager', 'POST', `/api/ops/schedules/${financeSchedule.id}/overrides`, { userId: 'outsider', startsAt: start, endsAt: end })).status, 400);

  // Agents cannot edit schedules; escalation policies stay with oncall.manage.
  assert.equal((await call('agent', 'POST', '/api/ops/schedules', schedule)).status, 403);
  assert.equal((await call('manager', 'POST', '/api/ops/policies', { name: 'P', levels: [] })).status, 403);
  // Administrators edit everyone's.
  assert.equal((await call('admin', 'DELETE', `/api/ops/schedules/${financeSchedule.id}`)).status, 204);
});
