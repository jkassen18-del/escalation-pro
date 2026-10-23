/**
 * Department labels, "Notify on-call" from a ticket, and the activity heatmap,
 * over real HTTP against a throwaway SQLite database.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Before any server module loads: config reads these once, at import.
process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'labels-oncall.db';
process.env.SESSION_SECRET = 'l'.repeat(48);
process.env.SECRET_KEY = 'e'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const wipe = () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `labels-oncall.db${suffix}`), { force: true });
};

let server: http.Server;
let base: string;
let adminCookie: string;
let agentCookie: string;
let db: typeof import('../server/db/index.ts').db;
let financeTeam: string;
let hrTeam: string;

async function call(method: string, url: string, body?: unknown, cookie = adminCookie) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
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

async function login(email: string): Promise<string> {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: email, password: 'Adm1n-Password!' }),
  });
  return response.headers.get('set-cookie')!.split(';')[0];
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
  const { hash, salt } = hashPassword('Adm1n-Password!');
  const now = new Date().toISOString();
  for (const [id, email, role, phone] of [
    ['u-admin', 'admin@acme.test', 'admin', null],
    ['u-sipho', 'sipho@acme.test', 'agent', '+27 82 555 0101'],
    ['u-agent', 'agent@acme.test', 'agent', null],
  ]) {
    await db.run(
      'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,phone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, email, id, id.slice(2), hash, salt, role, 'active', '#9a7b2f', 0, phone, now, now],
    );
  }
  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  adminCookie = await login('admin@acme.test');
  agentCookie = await login('agent@acme.test');
  financeTeam = (await call('POST', '/api/teams', { name: 'Finance', key: 'FIN' })).payload.team.id;
  hrTeam = (await call('POST', '/api/teams', { name: 'HR', key: 'HR' })).payload.team.id;
});

after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db.close();
  wipe();
});

test('labels are per department, plus organisation-wide ones, and names are unique where they meet', async () => {
  const withdrawals = await call('POST', '/api/labels', { teamId: financeTeam, name: 'Withdrawals', color: '#2F80ED' });
  assert.equal(withdrawals.status, 201, JSON.stringify(withdrawals.payload));
  assert.equal(withdrawals.payload.label.color, '#2f80ed');
  await call('POST', '/api/labels', { teamId: hrTeam, name: 'Onboarding', color: '#3f9d4e' });
  const vip = await call('POST', '/api/labels', { teamId: null, name: 'VIP', color: '#d64545' });
  assert.equal(vip.status, 201);

  const finance = await call('GET', `/api/labels?teamId=${financeTeam}`);
  assert.deepEqual(finance.payload.labels.map((label: { name: string }) => label.name).sort(), ['VIP', 'Withdrawals']);

  const clash = await call('POST', '/api/labels', { teamId: financeTeam, name: 'vip', color: '#000000' });
  assert.equal(clash.status, 400, 'a department label cannot shadow an organisation-wide one');
  // The same name in another department is fine.
  assert.equal((await call('POST', '/api/labels', { teamId: hrTeam, name: 'Withdrawals' })).status, 201);
  assert.equal((await call('POST', '/api/labels', { teamId: hrTeam, name: 'a,b' })).status, 400);

  const forbidden = await call('POST', '/api/labels', { teamId: financeTeam, name: 'Sneaky' }, agentCookie);
  assert.equal(forbidden.status, 403);
  // Everyone signed in can read them, to pick from.
  assert.equal((await call('GET', `/api/labels?teamId=${financeTeam}`, undefined, agentCookie)).status, 200);

  const renamed = await call('PUT', `/api/labels/${withdrawals.payload.label.id}`, { name: 'Payouts', color: '#0e9f9a' });
  assert.equal(renamed.payload.label.name, 'Payouts');
  assert.equal((await call('DELETE', `/api/labels/${withdrawals.payload.label.id}`)).status, 204);
});

test('a ticket lists who is on call for its department, and can notify them once per cooldown', async () => {
  const now = Date.now();
  const iso = (offsetDays: number) => new Date(now + offsetDays * 86_400_000).toISOString();
  const schedule = await call('POST', '/api/ops/schedules', {
    name: 'Finance standby',
    teamId: financeTeam,
    timeZone: 'Africa/Johannesburg',
    layers: [{ name: 'Weeks', rotation: 'roster', entries: [{ userId: 'u-sipho', startsAt: iso(-1), endsAt: iso(6) }] }],
  });
  assert.equal(schedule.status, 201, JSON.stringify(schedule.payload));

  const ticket = (await call('POST', '/api/tickets', { subject: 'Withdrawal flush request', teamId: financeTeam, tags: ['VIP'] })).payload.ticket;
  assert.deepEqual(ticket.tags, ['vip']);

  const onCall = await call('GET', `/api/tickets/${ticket.id}/oncall`);
  assert.equal(onCall.status, 200);
  assert.equal(onCall.payload.contacts.length, 1);
  assert.equal(onCall.payload.contacts[0].name, 'sipho');
  assert.equal(onCall.payload.contacts[0].phone, '+27 82 555 0101');
  assert.equal(onCall.payload.teamsConnected, false);

  const sent = await call('POST', `/api/tickets/${ticket.id}/notify-oncall`, { note: 'Player waiting on a payout' });
  assert.equal(sent.status, 200, JSON.stringify(sent.payload));
  const byChannel = Object.fromEntries(sent.payload.results.map((result: { channel: string; status: string }) => [result.channel, result.status]));
  assert.equal(byChannel.in_app, 'sent');
  assert.equal(byChannel.push, 'skipped', 'no device has push turned on');
  assert.equal(byChannel.msteams, 'skipped', 'Teams is not connected');

  const bell = await db.all<{ title: string }>(`SELECT title FROM notifications WHERE user_id = 'u-sipho' AND type = 'oncall'`);
  assert.equal(bell.length, 1);
  assert.match(bell[0].title, /admin needs you on/);

  const detail = (await call('GET', `/api/tickets/${ticket.id}`)).payload.ticket;
  const event = detail.events.find((entry: { action: string }) => entry.action === 'oncall_notified');
  assert.equal(event.toValue, 'sipho: Player waiting on a payout');

  const again = await call('POST', `/api/tickets/${ticket.id}/notify-oncall`, {});
  assert.equal(again.status, 400, 'a second nudge inside the cooldown is refused');

  const nobody = (await call('POST', '/api/tickets', { subject: 'Leave request', teamId: hrTeam })).payload.ticket;
  assert.deepEqual((await call('GET', `/api/tickets/${nobody.id}/oncall`)).payload.contacts, []);
  assert.equal((await call('POST', `/api/tickets/${nobody.id}/notify-oncall`, {})).status, 400);
});

test('the activity heatmap counts created and resolved tickets per day, scoped to what the viewer can see', async () => {
  const ticket = (await call('POST', '/api/tickets', { subject: 'Laptop will not boot', teamId: hrTeam })).payload.ticket;
  await call('PATCH', `/api/tickets/${ticket.id}`, { status: 'resolved' });

  const activity = await call('GET', '/api/tickets/activity?days=30&tzOffset=0');
  assert.equal(activity.status, 200);
  const today = new Date().toISOString().slice(0, 10);
  const day = activity.payload.days.find((entry: { date: string }) => entry.date === today);
  assert.ok(day, JSON.stringify(activity.payload));
  assert.ok(day.created >= 3);
  assert.equal(day.resolved, 1);

  // An agent in no department sees only tickets they are personally on.
  const scoped = await call('GET', '/api/tickets/activity?days=30', undefined, agentCookie);
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.payload.days, []);
});
