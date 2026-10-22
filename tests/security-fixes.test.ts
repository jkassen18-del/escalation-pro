/**
 * Regression tests for the access-control fixes from the security review:
 * permission grants, admin-only account changes, secrets in ops listings,
 * page acknowledgement, ticket description sanitising, attachments and the
 * XLSX export. Driven over real HTTP against a throwaway SQLite database.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Before any server module loads: config reads these once, at import.
process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'security-fixes.db';
process.env.SESSION_SECRET = 's'.repeat(48);
process.env.SECRET_KEY = 'd'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const XLSX = await import('xlsx');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `security-fixes.db${suffix}`), { force: true });
}

let server: http.Server;
let base: string;
let db: typeof import('../server/db/index.ts').db;
const cookies: Record<string, string> = {};
let teamId: string;
let otherTeamId: string;

const PASSWORD = 'Str0ng-Password!';

async function call(who: string, method: string, url: string, body?: unknown) {
  const isForm = body instanceof FormData;
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { ...(isForm ? {} : { 'content-type': 'application/json' }), cookie: cookies[who] ?? '' },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let payload: any = buffer.toString('utf8');
  try {
    payload = JSON.parse(payload);
  } catch {
    // binary or HTML
  }
  return { status: response.status, payload, buffer };
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
      'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, `${id}@acme.test`, id, `Person ${id}`, hash, salt, role, 'active', '#9a7b2f', 0, now, now],
    );
  }

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  for (const who of ['admin', 'manager', 'agent', 'outsider', 'viewer']) {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: `${who}@acme.test`, password: PASSWORD }),
    });
    assert.equal(login.status, 200, `login ${who}`);
    cookies[who] = login.headers.get('set-cookie')!.split(';')[0];
  }

  teamId = (await call('admin', 'POST', '/api/teams', { name: 'Platform', key: 'PLT' })).payload.team.id;
  otherTeamId = (await call('admin', 'POST', '/api/teams', { name: 'Finance', key: 'FIN' })).payload.team.id;
  // The agent and the viewer work in Platform; the outsider in Finance.
  for (const [user, team] of [
    ['agent', teamId],
    ['viewer', teamId],
    ['outsider', otherTeamId],
  ]) {
    await db.run('INSERT INTO team_members (team_id, user_id, is_lead) VALUES (?, ?, 0)', [team, user]);
  }
});

after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db.close();
  wipe();
});

/* ------------------------------ Permissions ------------------------------- */

test('a manager cannot hand out permissions they do not hold or that only admins may grant', async () => {
  const created = await call('manager', 'POST', '/api/users', {
    name: 'New hire',
    email: 'new@acme.test',
    role: 'agent',
    extraPermissions: ['integrations.manage'],
  });
  assert.equal(created.status, 403, JSON.stringify(created.payload));

  // audit.view is a manager grant, so passing it on is fine.
  const allowed = await call('manager', 'POST', '/api/users', {
    name: 'New hire',
    email: 'new@acme.test',
    role: 'agent',
    extraPermissions: ['audit.view'],
  });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.payload));
  const id = allowed.payload.user.id;

  for (const permission of ['settings.manage', 'backups.restore', 'tickets.delete']) {
    const patched = await call('manager', 'PATCH', `/api/users/${id}`, { extraPermissions: ['audit.view', permission] });
    assert.equal(patched.status, 403, permission);
  }
  // Including granting it to themselves.
  const self = await call('manager', 'PATCH', '/api/users/manager', { extraPermissions: ['integrations.manage'] });
  assert.equal(self.status, 403);

  // An admin may, and a manager may then remove what an admin granted.
  assert.equal((await call('admin', 'PATCH', `/api/users/${id}`, { extraPermissions: ['audit.view', 'settings.manage'] })).status, 200);
  const removed = await call('manager', 'PATCH', `/api/users/${id}`, { extraPermissions: ['audit.view'] });
  assert.equal(removed.status, 200, JSON.stringify(removed.payload));
  assert.deepEqual(removed.payload.user.extraPermissions, ['audit.view']);
});

test('only an admin can change, reset or delete an admin account', async () => {
  assert.equal((await call('manager', 'PATCH', '/api/users/admin', { email: 'mine@acme.test' })).status, 403);
  assert.equal((await call('manager', 'PATCH', '/api/users/admin', { status: 'suspended' })).status, 403);
  assert.equal((await call('manager', 'POST', '/api/users/admin/reset-password', {})).status, 403);
  assert.equal((await call('manager', 'POST', '/api/users', { name: 'X', email: 'x@acme.test', role: 'admin' })).status, 403);
  assert.equal((await call('manager', 'PATCH', '/api/users/agent', { role: 'admin' })).status, 403);
  // Managers still manage everyone else.
  const reset = await call('manager', 'POST', '/api/users/agent/reset-password', { password: PASSWORD, mustChangePassword: false });
  assert.equal(reset.status, 200);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'agent@acme.test', password: PASSWORD }),
  });
  cookies.agent = login.headers.get('set-cookie')!.split(';')[0];
});

/* ------------------------------ Ops secrets -------------------------------- */

test('ingest tokens, heartbeat URLs and monitor headers are masked for non-managers', async () => {
  const source = await call('admin', 'POST', '/api/ops/alert-sources', { name: 'Grafana', kind: 'grafana', teamId, defaultSeverity: 'sev3' });
  assert.equal(source.status, 201);
  const token = new URL(source.payload.source.webhookUrl).pathname.split('/').pop()!;
  assert.ok(token.length >= 16);

  const monitor = await call('admin', 'POST', '/api/ops/monitors', {
    name: 'API',
    kind: 'http',
    target: 'http://user:hunter2@127.0.0.1:9/health',
    config: { headers: { Authorization: 'Bearer secret-value' } },
    intervalSecs: 300,
    teamId,
  });
  assert.equal(monitor.status, 201, JSON.stringify(monitor.payload));
  const heartbeat = await call('admin', 'POST', '/api/ops/monitors', { name: 'Nightly job', kind: 'heartbeat', intervalSecs: 3600, teamId });
  assert.equal(heartbeat.status, 201, JSON.stringify(heartbeat.payload));

  const asAgent = JSON.stringify([
    (await call('agent', 'GET', '/api/ops/alert-sources')).payload,
    (await call('agent', 'GET', '/api/ops/monitors')).payload,
    (await call('agent', 'GET', `/api/ops/monitors/${monitor.payload.monitor.id}`)).payload,
    (await call('agent', 'GET', `/api/ops/monitors/${heartbeat.payload.monitor.id}`)).payload,
  ]);
  for (const secret of [token, 'secret-value', 'hunter2', heartbeat.payload.monitor.heartbeatUrl]) {
    assert.ok(!asAgent.includes(secret), `agent saw ${secret}`);
  }
  assert.ok(asAgent.includes('Authorization'), 'header names are still shown');

  const asAdmin = JSON.stringify((await call('admin', 'GET', '/api/ops/alert-sources')).payload);
  assert.ok(asAdmin.includes(token));
});

/* --------------------------------- Pages ----------------------------------- */

test('only someone a page reached, or an on-call manager, can ack or escalate it', async () => {
  const ticket = (await call('admin', 'POST', '/api/tickets', { subject: 'DB down', teamId })).payload.ticket;
  const now = new Date().toISOString();
  const page = async (id: string) => {
    await db.run(
      `INSERT INTO pages (id, ticket_id, policy_id, severity, status, level_started_at, current_targets, created_at, updated_at)
       VALUES (?, ?, NULL, 'sev1', 'triggered', ?, '[]', ?, ?)`,
      [id, ticket.id, now, now, now],
    );
    await db.run(
      `INSERT INTO notification_attempts (id, page_id, user_id, channel, provider, status, created_at) VALUES (?, ?, 'agent', 'in_app', 'sandbox', 'sent', ?)`,
      [`${id}-a`, id, now],
    );
  };
  await page('page-1');
  await page('page-2');

  assert.equal((await call('outsider', 'POST', '/api/ops/pages/page-1/ack')).status, 403);
  assert.equal((await call('outsider', 'POST', '/api/ops/pages/page-1/escalate')).status, 403);
  assert.equal((await call('viewer', 'POST', '/api/ops/pages/page-1/ack')).status, 403);
  const acked = await call('agent', 'POST', '/api/ops/pages/page-1/ack');
  assert.equal(acked.status, 200, JSON.stringify(acked.payload));
  // A manager holds oncall.manage.
  assert.equal((await call('manager', 'POST', '/api/ops/pages/page-2/ack')).status, 200);
});

test('deleting an escalation policy clears every reference to it', async () => {
  const policy = (
    await call('admin', 'POST', '/api/ops/policies', { name: 'Doomed', teamId, repeatCount: 0, levels: [{ delayMins: 5, targets: [{ type: 'user', id: 'agent' }] }] })
  ).payload.policy;
  const monitor = (await call('admin', 'POST', '/api/ops/monitors', { name: 'Ref', kind: 'heartbeat', intervalSecs: 3600, escalationPolicyId: policy.id })).payload.monitor;
  const source = (await call('admin', 'POST', '/api/ops/alert-sources', { name: 'Ref', kind: 'generic', escalationPolicyId: policy.id })).payload.source;
  const now = new Date().toISOString();
  await db.run(`INSERT INTO alert_rules (id, name, position, enabled, match_spec, actions, continue_evaluating, created_at, updated_at) VALUES ('rule-1', 'R', 0, 1, '{}', ?, 0, ?, ?)`, [
    JSON.stringify({ escalationPolicyId: policy.id, severity: 'sev1' }),
    now,
    now,
  ]);
  assert.equal(monitor.escalationPolicyId, policy.id);
  assert.equal(source.escalationPolicyId, policy.id);

  assert.equal((await call('admin', 'DELETE', `/api/ops/policies/${policy.id}`)).status, 204);
  assert.equal((await db.get<{ p: string | null }>('SELECT escalation_policy_id AS p FROM monitors WHERE id = ?', [monitor.id]))!.p, null);
  assert.equal((await db.get<{ p: string | null }>('SELECT escalation_policy_id AS p FROM alert_sources WHERE id = ?', [source.id]))!.p, null);
  const rule = await db.get<{ actions: string }>(`SELECT actions FROM alert_rules WHERE id = 'rule-1'`);
  assert.deepEqual(JSON.parse(rule!.actions), { severity: 'sev1' });
});

/* -------------------------------- Tickets ---------------------------------- */

test('an edited HTML description is sanitised like a new one', async () => {
  const ticket = (await call('agent', 'POST', '/api/tickets', { subject: 'Rich', description: '<p>hi</p>', descriptionFormat: 'html', teamId })).payload.ticket;
  const patched = await call('agent', 'PATCH', `/api/tickets/${ticket.id}`, {
    description: '<p>ok</p><script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">x</a>',
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.payload));
  const stored = (await db.get<{ description: string }>('SELECT description FROM tickets WHERE id = ?', [ticket.id]))!.description;
  assert.ok(stored.includes('<p>ok</p>'));
  assert.ok(!/<script|onerror|javascript:/i.test(stored), stored);
});

function filesForm(fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('files', new Blob(['secret notes'], { type: 'text/plain' }), 'notes.txt');
  return form;
}

test('attachments follow ticket visibility, and internal-note files stay internal', async () => {
  const ticket = (await call('agent', 'POST', '/api/tickets', { subject: 'Files', teamId })).payload.ticket;
  const other = (await call('outsider', 'POST', '/api/tickets', { subject: 'Finance only', teamId: otherTeamId })).payload.ticket;

  // Someone who cannot see the ticket cannot add to it or delete from it.
  assert.equal((await call('outsider', 'POST', `/api/tickets/${ticket.id}/attachments`, filesForm())).status, 403);

  // A comment id must belong to the ticket in the URL.
  const otherComment = await call('outsider', 'POST', `/api/tickets/${other.id}/comments`, { body: 'mine', isInternal: false });
  assert.equal(otherComment.status, 201);
  assert.ok(otherComment.payload.commentId);
  const foreign = await call('agent', 'POST', `/api/tickets/${ticket.id}/attachments`, filesForm({ commentId: otherComment.payload.commentId }));
  assert.equal(foreign.status, 400);

  const note = await call('agent', 'POST', `/api/tickets/${ticket.id}/comments`, { body: 'internal', isInternal: true });
  assert.equal(note.status, 201);
  const uploaded = await call('agent', 'POST', `/api/tickets/${ticket.id}/attachments`, filesForm({ commentId: note.payload.commentId }));
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.payload));
  const attachment = await db.get<{ id: string; comment_id: string }>('SELECT id, comment_id FROM ticket_attachments WHERE ticket_id = ?', [ticket.id]);
  assert.equal(attachment!.comment_id, note.payload.commentId);

  // The agent sees it; the viewer (same team, no internal notes) does not.
  const agentView = await call('agent', 'GET', `/api/tickets/${ticket.id}`);
  assert.equal(agentView.payload.ticket.attachments.length, 1);
  const viewerView = await call('viewer', 'GET', `/api/tickets/${ticket.id}`);
  assert.equal(viewerView.status, 200);
  assert.equal(viewerView.payload.ticket.attachments.length, 0);
  assert.equal((await call('viewer', 'GET', `/api/tickets/${ticket.id}/attachments/${attachment!.id}`)).status, 404);
  assert.equal((await call('agent', 'GET', `/api/tickets/${ticket.id}/attachments/${attachment!.id}`)).status, 200);
  assert.equal((await call('outsider', 'DELETE', `/api/tickets/${ticket.id}/attachments/${attachment!.id}`)).status, 403);
});

test('the XLSX export only covers visible tickets and hides internal notes without the permission', async () => {
  const ticket = (await call('agent', 'POST', '/api/tickets', { subject: 'Export me', teamId })).payload.ticket;
  await call('agent', 'POST', `/api/tickets/${ticket.id}/comments`, { body: 'PUBLIC-REPLY', isInternal: false });
  await call('agent', 'POST', `/api/tickets/${ticket.id}/comments`, { body: 'INTERNAL-NOTE', isInternal: true });
  const finance = (await call('outsider', 'POST', '/api/tickets', { subject: 'Finance', teamId: otherTeamId })).payload.ticket;
  await call('outsider', 'POST', `/api/tickets/${finance.id}/comments`, { body: 'FINANCE-SECRET', isInternal: false });

  // The viewer gets the export permission but not internal notes.
  await db.run(`INSERT INTO user_permissions (user_id, permission) VALUES ('viewer', 'reports.view'), ('viewer', 'reports.export')`);
  const sheets = async (who: string) => {
    const res = await call(who, 'GET', '/api/reports/export');
    assert.equal(res.status, 200, res.buffer.toString('utf8').slice(0, 200));
    const book = XLSX.read(res.buffer, { type: 'buffer' });
    return JSON.stringify(book.SheetNames.map((name) => XLSX.utils.sheet_to_json(book.Sheets[name])));
  };
  const viewer = await sheets('viewer');
  assert.ok(viewer.includes('PUBLIC-REPLY'));
  assert.ok(!viewer.includes('INTERNAL-NOTE'));
  assert.ok(!viewer.includes('FINANCE-SECRET'));
  const admin = await sheets('admin');
  assert.ok(admin.includes('INTERNAL-NOTE') && admin.includes('FINANCE-SECRET'));
});
