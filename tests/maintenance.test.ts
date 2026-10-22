/**
 * Maintenance windows: occurrences (one-off and recurring, in a time zone),
 * what they cover, the two effects on the alert pipeline, status pages, the
 * runner's notices, and raising again what a window held back once it ends.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Before any server module loads: config reads these once, at import.
process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'maintenance.db';
process.env.SESSION_SECRET = 'm'.repeat(48);
process.env.SECRET_KEY = 'd'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const wipe = () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `maintenance.db${suffix}`), { force: true });
};

const { expandOccurrences } = await import('../server/ops/maintenance.ts');
type WindowRow = import('../server/ops/maintenance.ts').WindowRow;

let server: http.Server;
let base: string;
let cookie: string;
let db: typeof import('../server/db/index.ts').db;
let tick: typeof import('../server/ops/maintenance-tick.ts').maintenanceTick;

let healthy = false;
let target: http.Server;
let targetUrl: string;

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload: any = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // HTML
  }
  return { status: response.status, payload };
}

before(async () => {
  wipe();
  const dist = path.resolve(import.meta.dirname, '../dist/client');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }
  target = http.createServer((_req, res) => {
    res.statusCode = healthy ? 200 : 503;
    res.end(healthy ? 'ok' : 'down');
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', () => resolve()));
  targetUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}/`;

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();
  tick = (await import('../server/ops/maintenance-tick.ts')).maintenanceTick;

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword('Adm1n-Password!');
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['u-admin', 'admin@acme.test', 'admin', 'Admin', hash, salt, 'admin', 'active', '#9a7b2f', 0, now, now],
  );

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'admin@acme.test', password: 'Adm1n-Password!' }),
  });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});

after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  target?.closeAllConnections();
  await new Promise<void>((resolve) => target?.close(() => resolve()));
  await db.close();
  wipe();
});

/* ------------------------------ Occurrences ------------------------------- */

function row(overrides: Partial<WindowRow>): WindowRow {
  return {
    id: 'w',
    title: 'Patch night',
    description: null,
    starts_at: '2026-01-01T00:00:00.000Z',
    ends_at: '9999-12-31T00:00:00.000Z',
    monitor_ids: '[]',
    scope: '{"everything":true}',
    effect: 'pause_paging',
    recurrence: '{}',
    time_zone: 'Africa/Johannesburg',
    notify_before_mins: 0,
    publish: 0,
    overrides: '{}',
    announced: '{}',
    cancelled_at: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: null,
    ...overrides,
  };
}
const t = (iso: string) => new Date(iso).getTime();

test('a one-off window has one occurrence, moved by an early end', () => {
  const once = row({ starts_at: '2026-10-25T20:00:00.000Z', ends_at: '2026-10-25T22:00:00.000Z' });
  assert.equal(expandOccurrences(once, t('2026-10-25T21:00:00Z'), t('2026-10-25T21:00:01Z')).length, 1);
  assert.equal(expandOccurrences(once, t('2026-10-25T22:00:00Z'), t('2026-10-25T23:00:00Z')).length, 0, 'the end is exclusive');
  const ended = row({ ...once, overrides: JSON.stringify({ '2026-10-25T20:00:00.000Z': { endsAt: '2026-10-25T20:30:00.000Z' } }) });
  assert.equal(expandOccurrences(ended, t('2026-10-25T21:00:00Z'), t('2026-10-25T21:00:01Z')).length, 0);
  assert.equal(expandOccurrences(row({ ...once, cancelled_at: '2026-10-01T00:00:00Z' }), 0, Infinity).length, 0);
});

test('a weekly window in SAST lands on the right UTC instants, across UTC midnight', () => {
  // Sundays 23:00-03:00 SAST = 21:00Z Sunday to 01:00Z Monday.
  const weekly = row({ recurrence: JSON.stringify({ kind: 'weekly', daysOfWeek: [0], startTime: '23:00', durationMins: 240, startDate: '2026-10-01' }) });
  const found = expandOccurrences(weekly, t('2026-10-26T00:30:00Z'), t('2026-10-26T00:30:01Z'));
  assert.equal(found.length, 1, 'still running after UTC midnight');
  assert.equal(found[0].startsAt, '2026-10-25T21:00:00.000Z');
  assert.equal(found[0].endsAt, '2026-10-26T01:00:00.000Z');
  assert.equal(expandOccurrences(weekly, t('2026-10-26T01:00:00Z'), t('2026-10-26T01:00:01Z')).length, 0);
  // A Saturday has none.
  assert.equal(expandOccurrences(weekly, t('2026-10-24T21:30:00Z'), t('2026-10-24T21:30:01Z')).length, 0);
  const month = expandOccurrences(weekly, t('2026-10-01T00:00:00Z'), t('2026-11-01T00:00:00Z'));
  assert.deepEqual(
    month.map((o) => o.startsAt.slice(0, 10)),
    ['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25'],
  );
});

test('daily, monthly, until, start date and skipped occurrences', () => {
  // London leaves BST on 25 Oct 2026: 09:00 local is 08:00Z before and 09:00Z after.
  const daily = row({ time_zone: 'Europe/London', recurrence: JSON.stringify({ kind: 'daily', startTime: '09:00', durationMins: 30, startDate: '2026-10-24', until: '2026-10-26' }) });
  assert.deepEqual(
    expandOccurrences(daily, t('2026-10-20T00:00:00Z'), t('2026-10-30T00:00:00Z')).map((o) => o.startsAt),
    ['2026-10-24T08:00:00.000Z', '2026-10-25T09:00:00.000Z', '2026-10-26T09:00:00.000Z'],
  );
  const monthly = row({ time_zone: 'UTC', recurrence: JSON.stringify({ kind: 'monthly', dayOfMonth: 31, startTime: '01:00', durationMins: 60, startDate: '2027-01-01' }) });
  assert.deepEqual(
    expandOccurrences(monthly, t('2027-01-01T00:00:00Z'), t('2027-04-01T00:00:00Z')).map((o) => o.startsAt.slice(0, 10)),
    ['2027-01-31', '2027-02-28', '2027-03-31'],
    'a short month uses its last day',
  );
  const skipped = row({
    ...monthly,
    overrides: JSON.stringify({ '2027-02-28T01:00:00.000Z': { skipped: true } }),
  });
  assert.equal(expandOccurrences(skipped, t('2027-01-01T00:00:00Z'), t('2027-04-01T00:00:00Z')).length, 2);
});

/* ------------------------------- Pipeline -------------------------------- */

let teamId: string;
let otherTeamId: string;
let monitorId: string;
let sourceUrl: string;
let sourceId: string;
let otherMonitorId: string;

const hour = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

test('setup: teams, a default policy, a monitor, an alert source and a status page', async () => {
  teamId = (await call('POST', '/api/teams', { name: 'Web', key: 'WEB' })).payload.team.id;
  otherTeamId = (await call('POST', '/api/teams', { name: 'Data', key: 'DAT' })).payload.team.id;
  const policy = await call('POST', '/api/ops/policies', { name: 'Web on-call', teamId, levels: [{ delayMins: 5, targets: [{ type: 'user', id: 'u-admin' }] }] });
  await call('PUT', `/api/ops/team-policies/${teamId}`, { policyId: policy.payload.policy.id });
  await call('PUT', `/api/ops/team-policies/${otherTeamId}`, { policyId: policy.payload.policy.id });
  monitorId = (await call('POST', '/api/ops/monitors', { name: 'Website', kind: 'http', target: targetUrl, failureThreshold: 1, teamId, severity: 'sev2' })).payload.monitor.id;
  otherMonitorId = (await call('POST', '/api/ops/monitors', { name: 'Warehouse', kind: 'http', target: targetUrl, failureThreshold: 1, teamId: otherTeamId, severity: 'sev2' })).payload.monitor.id;
  const source = (await call('POST', '/api/ops/alert-sources', { name: 'CI', kind: 'generic', teamId: otherTeamId, defaultSeverity: 'sev2' })).payload.source;
  sourceId = source.id;
  sourceUrl = new URL(source.webhookUrl).pathname;
  const page = await call('POST', '/api/ops/status-pages', { title: 'Acme', slug: 'acme', isPublic: true, components: [{ monitorId, label: 'Website' }] });
  assert.equal(page.status, 201);
});

let pagingWindowId: string;

test('a team-scoped pause_paging window opens the ticket but pages nobody', async () => {
  const now = Date.now();
  const created = await call('POST', '/api/ops/maintenance', {
    title: 'Web deploy',
    description: 'Upgrading the web servers.',
    scope: { teamIds: [teamId] },
    effect: 'pause_paging',
    recurrence: { kind: 'none' },
    timeZone: 'Africa/Johannesburg',
    startsAt: iso(now - 60_000),
    endsAt: iso(now + hour),
    publishToStatusPages: true,
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  pagingWindowId = created.payload.window.id;
  assert.equal(created.payload.window.state, 'in_progress');
  assert.equal(created.payload.window.scopeSummary, 'team Web');

  const checked = await call('POST', `/api/ops/monitors/${monitorId}/check`);
  assert.equal(checked.payload.monitor.state, 'down');
  assert.equal(checked.payload.monitor.maintenance.windowId, pagingWindowId);
  const alert = (await call('GET', '/api/ops/alerts?status=open')).payload.alerts.find((a: any) => a.sourceId === monitorId);
  assert.ok(alert.ticketId, 'pause_paging still opens a ticket');
  assert.equal(alert.suppressed, true);
  const pages = await call('GET', `/api/ops/pages?ticketId=${alert.ticketId}&filter=all`);
  assert.equal(pages.payload.pages.length, 0);

  // A monitor of another team is not covered.
  const other = await call('POST', `/api/ops/monitors/${otherMonitorId}/check`);
  assert.equal(other.payload.monitor.maintenance, null);
  const otherAlert = (await call('GET', '/api/ops/alerts?status=open')).payload.alerts.find((a: any) => a.sourceId === otherMonitorId);
  assert.equal((await call('GET', `/api/ops/pages?ticketId=${otherAlert.ticketId}&filter=all`)).payload.pages.length, 1, 'outside the scope it pages');

  const day = await db.get<{ failures: number; maintenance: number }>(`SELECT failures, maintenance FROM monitor_daily WHERE monitor_id = ?`, [monitorId]);
  assert.deepEqual([Number(day!.failures), Number(day!.maintenance)], [0, 1], 'a failed check in maintenance is not an outage');
});

let alertingWindowId: string;

test('a source-scoped pause_alerting window records the alert and opens nothing', async () => {
  const now = Date.now();
  const created = await call('POST', '/api/ops/maintenance', {
    title: 'CI migration',
    scope: { sourceIds: [sourceId] },
    effect: 'pause_alerting',
    recurrence: { kind: 'none' },
    timeZone: 'UTC',
    startsAt: iso(now - 60_000),
    endsAt: iso(now + hour),
  });
  alertingWindowId = created.payload.window.id;
  const res = await call('POST', sourceUrl, { title: 'Build broken', dedup_key: 'build-1', severity: 'critical' }, { cookie: '' });
  assert.equal(res.status, 202);
  assert.equal(res.payload.results[0].action, 'suppressed');
  assert.equal(res.payload.results[0].ticketId, null);
  const alert = (await call('GET', '/api/ops/alerts?status=open')).payload.alerts.find((a: any) => a.dedupKey === 'build-1');
  assert.equal(alert.suppressed, true);
  assert.equal(alert.ticketId, null);
});

test('the status page shows maintenance in progress, scheduled maintenance and the component state', async () => {
  const now = Date.now();
  await call('POST', '/api/ops/maintenance', {
    title: 'Database upgrade',
    description: 'Short read-only period.',
    scope: { components: [{ statusPageId: 'any', monitorId }] },
    effect: 'pause_paging',
    recurrence: { kind: 'none' },
    timeZone: 'Africa/Johannesburg',
    startsAt: iso(now + 2 * 24 * hour),
    endsAt: iso(now + 2 * 24 * hour + 2 * hour),
    publishToStatusPages: true,
  });
  const html = (await call('GET', '/status/acme', undefined, { cookie: '' })).payload as string;
  assert.match(html, /Maintenance in progress/);
  assert.match(html, /Web deploy/);
  assert.match(html, /Upgrading the web servers\./);
  assert.match(html, /Scheduled maintenance/);
  assert.match(html, /Database upgrade/);
  assert.match(html, /SAST/, 'times are shown in the window zone');
  assert.match(html, /Under maintenance/);
  assert.doesNotMatch(html, /CI migration/, 'unpublished windows stay internal');
  const json = await call('GET', '/api/public/status/acme', undefined, { cookie: '' });
  assert.equal(json.payload.components[0].status, 'maintenance');
});

test('the runner posts "in progress" once, and the banner endpoint lists what is active', async () => {
  const first = await tick();
  const second = await tick();
  assert.ok(first.started >= 2);
  assert.equal(second.started, 0, 'idempotent');
  const updates = await db.all<{ title: string }>(`SELECT title FROM status_updates WHERE title LIKE 'Maintenance in progress:%'`);
  assert.deepEqual(updates.map((u) => u.title), ['Maintenance in progress: Web deploy'], 'only published windows post, once');
  const active = await call('GET', '/api/ops/maintenance/active');
  assert.deepEqual(active.payload.active.map((a: any) => a.title).sort(), ['CI migration', 'Web deploy']);
});

test('extend and the listing of upcoming occurrences', async () => {
  const before = (await call('GET', '/api/ops/maintenance')).payload.windows.find((w: any) => w.id === pagingWindowId);
  const extended = await call('POST', `/api/ops/maintenance/${pagingWindowId}/extend`, { minutes: 30 });
  assert.equal(extended.status, 200);
  assert.equal(new Date(extended.payload.window.currentOccurrence.endsAt).getTime() - new Date(before.currentOccurrence.endsAt).getTime(), 30 * 60_000);
  const weekly = await call('POST', '/api/ops/maintenance', {
    title: 'Sunday patching',
    scope: { everything: true },
    effect: 'pause_paging',
    recurrence: { kind: 'weekly', daysOfWeek: [0], startTime: '22:00', durationMins: 120, startDate: new Date().toISOString().slice(0, 10) },
    timeZone: 'Africa/Johannesburg',
  });
  assert.equal(weekly.status, 201, JSON.stringify(weekly.payload));
  const listing = await call('GET', '/api/ops/maintenance');
  const sundays = listing.payload.occurrences.filter((o: any) => o.title === 'Sunday patching');
  assert.ok(sundays.length >= 4 && sundays.length <= 5, `four or five Sundays in 30 days, got ${sundays.length}`);
  // Skip one, cancel the series.
  const skip = await call('POST', `/api/ops/maintenance/${weekly.payload.window.id}/cancel`, { occurrence: sundays[0].key });
  assert.equal(skip.payload.window.state, 'scheduled');
  const cancel = await call('POST', `/api/ops/maintenance/${weekly.payload.window.id}/cancel`, {});
  assert.equal(cancel.payload.window.state, 'cancelled');
  const bad = await call('POST', '/api/ops/maintenance', { title: 'x', scope: {}, recurrence: { kind: 'none' }, startsAt: iso(Date.now()), endsAt: iso(Date.now() + hour) });
  assert.equal(bad.status, 400, 'a window must cover something');
});

test('ending early posts "completed" and raises what is still down, once', async () => {
  const ended = await call('POST', `/api/ops/maintenance/${pagingWindowId}/end`);
  assert.equal(ended.payload.window.state, 'completed');
  await call('POST', `/api/ops/maintenance/${alertingWindowId}/cancel`, {});

  const first = await tick();
  const second = await tick();
  assert.equal(first.ended, 2, 'the window ended early and the cancelled one');
  assert.equal(second.ended, 0);
  assert.equal(first.reraised, 2, 'the paused monitor and the paused source');
  assert.equal(second.reraised, 0, 'no alert storm on the next tick');
  const completed = await db.all(`SELECT id FROM status_updates WHERE title = 'Maintenance completed: Web deploy'`);
  assert.equal(completed.length, 1);

  // The monitor's existing ticket is paged now; the webhook alert gets a ticket of its own.
  const monitorAlert = (await call('GET', '/api/ops/alerts?status=open')).payload.alerts.find((a: any) => a.sourceId === monitorId);
  const pages = await call('GET', `/api/ops/pages?ticketId=${monitorAlert.ticketId}&filter=all`);
  assert.equal(pages.payload.pages.length, 1);
  const build = (await call('GET', '/api/ops/alerts?status=open')).payload.alerts.filter((a: any) => a.dedupKey === 'build-1');
  assert.equal(build.length, 1);
  assert.ok(build[0].ticketId, 'raised as a normal alert with a ticket');
  assert.equal(build[0].suppressed, false);
});

test('legacy windows (a bare list of ids) still work, and changing them needs the permission', async () => {
  const now = Date.now();
  const legacy = await call('POST', '/api/ops/maintenance', { title: 'Old style', startsAt: iso(now - 1000), endsAt: iso(now + hour), monitorIds: [otherMonitorId] });
  assert.equal(legacy.status, 201);
  assert.equal(legacy.payload.window.scopeSummary, '1 monitor');
  const monitors = (await call('GET', '/api/ops/monitors')).payload.monitors;
  assert.equal(monitors.find((m: any) => m.id === otherMonitorId).maintenance.title, 'Old style');
  assert.equal(monitors.find((m: any) => m.id === monitorId).maintenance, null);

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword('Viewer-Password1!');
  const stamp = new Date().toISOString();
  await db.run(
    'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['u-viewer', 'viewer@acme.test', 'viewer', 'Viewer', hash, salt, 'viewer', 'active', '#9a7b2f', 0, stamp, stamp],
  );
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'viewer@acme.test', password: 'Viewer-Password1!' }),
  });
  const viewer = login.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await call('GET', '/api/ops/maintenance/active', undefined, { cookie: viewer })).status, 200, 'everyone can see it');
  assert.equal((await call('POST', `/api/ops/maintenance/${legacy.payload.window.id}/end`, undefined, { cookie: viewer })).status, 403);
  const audit = await call('GET', '/api/audit?search=maintenance');
  assert.ok(audit.payload.entries.some((e: any) => e.action === 'maintenance_ended_early'));
  assert.ok(audit.payload.entries.some((e: any) => e.action === 'maintenance_extended'));
  assert.ok(audit.payload.entries.some((e: any) => e.action === 'maintenance_cancelled'));
});

test('teams are told before a window starts, once', async () => {
  await db.run(`INSERT INTO team_members (team_id, user_id, is_lead) VALUES (?, 'u-admin', 1) ON CONFLICT (team_id, user_id) DO NOTHING`, [teamId]);
  const now = Date.now();
  await call('POST', '/api/ops/maintenance', {
    title: 'Firewall swap',
    scope: { monitorIds: [monitorId] },
    effect: 'pause_paging',
    recurrence: { kind: 'none' },
    timeZone: 'Africa/Johannesburg',
    startsAt: iso(now + 30 * 60_000),
    endsAt: iso(now + 90 * 60_000),
    notifyBeforeMins: 60,
  });
  const first = await tick();
  const second = await tick();
  assert.equal(first.notified, 1);
  assert.equal(second.notified, 0);
  const note = await db.get<{ title: string }>(`SELECT title FROM notifications WHERE user_id = 'u-admin' AND type = 'maintenance'`);
  assert.match(note!.title, /Firewall swap/);
});
