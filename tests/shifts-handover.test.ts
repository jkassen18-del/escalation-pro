/**
 * 3.0: department working schedules, the shift handover report, and the
 * department filter on ticket counts, over real HTTP against a throwaway
 * SQLite database.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'shifts-handover.db';
process.env.SESSION_SECRET = 's'.repeat(48);
process.env.SECRET_KEY = 'f'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const wipe = () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `shifts-handover.db${suffix}`), { force: true });
};

const realFetch = globalThis.fetch;
const teamsPosts: Array<{ url: string; body: any }> = [];
const slackPosts: any[] = [];

let server: http.Server;
let base: string;
let adminCookie: string;
let agentCookie: string;
let db: typeof import('../server/db/index.ts').db;
let opsTeam: string;
let hrTeam: string;

async function call(method: string, url: string, body?: unknown, cookie = adminCookie) {
  const response = await realFetch(`${base}${url}`, {
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
  const response = await realFetch(`${base}/api/auth/login`, {
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
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://ops-teams.invalid/')) {
      teamsPosts.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response('1', { status: 200 });
    }
    if (url === 'https://slack.com/api/chat.postMessage') {
      slackPosts.push(JSON.parse(String(init?.body ?? '{}')));
      return Response.json({ ok: true, ts: '1.0001' });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();
  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword('Adm1n-Password!');
  const now = new Date().toISOString();
  for (const [id, email, role, phone] of [
    ['u-admin', 'admin@acme.test', 'admin', null],
    ['u-lead', 'lead@acme.test', 'agent', '+27 82 555 0199'],
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
  opsTeam = (await call('POST', '/api/teams', { name: 'Operations', key: 'OPS' })).payload.team.id;
  hrTeam = (await call('POST', '/api/teams', { name: 'HR', key: 'HR' })).payload.team.id;
});

after(async () => {
  globalThis.fetch = realFetch;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db.close();
  wipe();
});

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6];
/** HH:MM in UTC, `hours` from now. A shift from -2 to +2 runs across midnight when it needs to. */
const hhmm = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString().slice(11, 16);

test('ticket counts follow the department selector', async () => {
  await call('POST', '/api/tickets', { subject: 'Core switch flapping', teamId: opsTeam, priority: 'urgent' });
  await call('POST', '/api/tickets', { subject: 'Payroll query', teamId: hrTeam });
  const all = (await call('GET', '/api/tickets/counts')).payload;
  const ops = (await call('GET', `/api/tickets/counts?teamId=${opsTeam}`)).payload;
  assert.ok(JSON.stringify(all) !== JSON.stringify(ops), 'the department filter changed nothing');
});

test('a department schedule says who is in, who leads, and until when', async () => {
  const saved = await call('PUT', `/api/shifts/${opsTeam}`, {
    timeZone: 'UTC',
    // A shift every day, around now.
    patterns: [{ name: 'Day', days: ALL_WEEK, start: hhmm(-2), end: hhmm(2), leaderId: 'u-lead', memberIds: ['u-agent'] }],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));

  const board = (await call('GET', '/api/shifts/board', undefined, agentCookie)).payload.departments;
  const ops = board.find((entry: any) => entry.teamId === opsTeam);
  assert.ok(ops.current, 'nobody is in although the shift covers the whole day');
  assert.equal(ops.current.leader.name, 'lead');
  assert.equal(ops.current.leader.phone, '+27 82 555 0199');
  assert.equal(board.find((entry: any) => entry.teamId === hrTeam).configured, false);

  const week = (await call('GET', `/api/shifts/${opsTeam}/calendar?days=7`)).payload.shifts;
  assert.ok(week.length >= 7);

  // A closed day removes that day's shift (the shift started two hours ago, so on that date).
  const today = new Date(Date.now() - 2 * 3_600_000).toISOString().slice(0, 10);
  const closed = await call('POST', `/api/shifts/${opsTeam}/exceptions`, { date: today, patternId: null, kind: 'closed', note: 'Public holiday' });
  assert.equal(closed.status, 201, JSON.stringify(closed.payload));
  const shut = (await call('GET', '/api/shifts/board')).payload.departments.find((entry: any) => entry.teamId === opsTeam);
  assert.equal(shut.current, null, 'the department is still shown as in on its closed day');
  const exceptionId = closed.payload.schedule.exceptions[0].id;
  assert.equal((await call('DELETE', `/api/shifts/${opsTeam}/exceptions/${exceptionId}`)).status, 200);

  // Seeing who is in is for everyone; changing it is not.
  assert.equal((await call('PUT', `/api/shifts/${opsTeam}`, { patterns: [] }, agentCookie)).status, 403);
  assert.equal((await call('PUT', `/api/shifts/${opsTeam}`, { patterns: [{ name: 'Bad', days: [], start: '25:00', end: '08:00' }] })).status, 400);
});

test('the handover reports what is open and paging, goes to the department channels, and the scheduler sends it once', async () => {
  const { saveIntegration } = await import('../server/integrations/store.ts');
  await saveIntegration('msteams', { enabled: true, config: { mode: 'webhook', webhookUrl: 'https://ops-teams.invalid/default' } });
  await db.run(`INSERT INTO team_routing (team_id, provider, target, updated_at) VALUES (?, 'msteams', ?, ?)`, [opsTeam, 'https://ops-teams.invalid/ops', new Date().toISOString()]);

  const preview = await call('GET', `/api/shifts/${opsTeam}/handover/preview`, undefined, agentCookie);
  assert.equal(preview.status, 200, JSON.stringify(preview.payload));
  assert.match(preview.payload.text, /Shift handover: Operations/);
  assert.match(preview.payload.text, /Core switch flapping/, 'the urgent ticket is not in the handover');
  assert.doesNotMatch(preview.payload.text, /Payroll query/, "another department's ticket leaked in");
  assert.equal(preview.payload.report.open.urgent, 1);

  assert.equal((await call('POST', `/api/shifts/${opsTeam}/handover/send`, {}, agentCookie)).status, 403);
  await call('PUT', `/api/shifts/${opsTeam}`, { handover: { enabled: true, leadMins: 0, channels: ['msteams'] } });
  const sent = await call('POST', `/api/shifts/${opsTeam}/handover/send`, {});
  assert.equal(sent.status, 200, JSON.stringify(sent.payload));
  assert.deepEqual(sent.payload.deliveries.map((delivery: any) => [delivery.channel, delivery.ok]), [['msteams', true]]);
  assert.equal(teamsPosts.at(-1)!.url, 'https://ops-teams.invalid/ops', "it did not go to the department's own channel");
  assert.equal(teamsPosts.at(-1)!.body.attachments[0].content.type, 'AdaptiveCard');

  // The scheduler: a shift starting now is due once, and only once.
  await call('PUT', `/api/shifts/${opsTeam}`, {
    timeZone: 'UTC',
    patterns: [{ name: 'Day', days: ALL_WEEK, start: '00:00', end: '12:00', leaderId: 'u-lead', memberIds: [] }],
  });
  const { handoverTick } = await import('../server/ops/handover.ts');
  const midnight = new Date();
  midnight.setUTCHours(0, 3, 0, 0);
  const before = teamsPosts.length;
  assert.equal(await handoverTick(midnight.getTime()), 1);
  assert.equal(await handoverTick(midnight.getTime() + 60_000), 0, 'the same shift change was sent twice');
  assert.equal(teamsPosts.length, before + 1);
  // Long after the change, nothing stale goes out.
  assert.equal(await handoverTick(midnight.getTime() + 3 * 3_600_000), 0);

  const history = (await call('GET', `/api/shifts/${opsTeam}/handover/history`)).payload.reports;
  assert.equal(history.length, 2);
  assert.equal(history.filter((entry: any) => entry.automatic).length, 1);
});
