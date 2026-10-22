/**
 * Operations: monitors, the alert pipeline, on-call paging, status pages and
 * backups, driven over real HTTP against a throwaway SQLite database.
 *
 * Telephony runs in the sandbox, so nothing leaves the machine; the one test
 * that exercises Twilio checks the inbound signature, which is the part that
 * protects an acknowledgement from being forged.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import type { ScheduleLayer } from '../shared/ops.ts';

// Before any server module loads: config reads these once, at import.
process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'ops.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.SECRET_KEY = 'c'.repeat(64);
// The test drives every tick itself.
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');

// Loaded dynamically for the same reason: a static import would be hoisted
// above the environment set up there and open the developer's own database.
const { nextCronTime, parseCron } = await import('../server/ops/cron.ts');
const { onCallAt, renderShifts } = await import('../server/ops/oncall.ts');
const { selectKept } = await import('../server/ops/backups.ts');
const { severityFrom, readPath } = await import('../server/ops/sources.ts');
const { signRequest } = await import('../server/ops/s3.ts');
const { statusMatches } = await import('../server/ops/probes.ts');
const { twilioSignature } = await import('../server/ops/telephony.ts');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `ops.db${suffix}`), { force: true });
}

let server: http.Server;
let base: string;
let cookie: string;
let teamId: string;
let db: typeof import('../server/db/index.ts').db;

/** A target the monitors can check, whose health the test controls. */
let targetHealthy = false;
let target: http.Server;
let targetUrl: string;

async function call(method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie, ...extraHeaders },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let payload: any = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // HTML or empty
  }
  return { status: response.status, payload, headers: response.headers };
}

before(async () => {
  wipe();
  const dist = path.resolve(import.meta.dirname, '../dist/client');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }

  target = http.createServer((_req, res) => {
    res.statusCode = targetHealthy ? 200 : 503;
    res.end(targetHealthy ? 'all good' : 'down');
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', () => resolve()));
  targetUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}/health`;

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword('Adm1n-Password!');
  const now = new Date().toISOString();
  const addUser = (id: string, email: string, role: string, phone: string | null) =>
    db.run(
      'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,phone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, email, id, `Person ${id}`, hash, salt, role, 'active', '#9a7b2f', 0, phone, now, now],
    );
  await addUser('u-admin', 'admin@acme.test', 'admin', '+27 82 123 4567');
  await addUser('u-second', 'second@acme.test', 'agent', '+27821110000');

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

  const team = await call('POST', '/api/teams', { name: 'Platform', key: 'PLT' });
  teamId = team.payload.team.id;
});

after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  target?.closeAllConnections();
  await new Promise<void>((resolve) => target?.close(() => resolve()));
  await db.close();
  wipe();
});

/* --------------------------------- Units ---------------------------------- */

test('cron finds the next run in UTC', () => {
  const from = new Date('2026-10-22T05:30:00Z');
  assert.equal(nextCronTime('0 1 * * *', from).toISOString(), '2026-10-23T01:00:00.000Z');
  assert.equal(nextCronTime('*/15 * * * *', from).toISOString(), '2026-10-22T05:45:00.000Z');
  // Sunday 02:30.
  assert.equal(nextCronTime('30 2 * * 0', from).toISOString(), '2026-10-25T02:30:00.000Z');
  assert.throws(() => parseCron('61 * * * *'));
  assert.throws(() => parseCron('* * *'));
});

test('a schedule rotates, the top layer wins, and an override beats both', () => {
  const start = '2026-10-19T06:00:00.000Z';
  const primary: ScheduleLayer = { id: 'l1', name: 'Weekly', position: 0, rotation: 'daily', shiftHours: 24, startsAt: start, memberIds: ['a', 'b', 'c'] };
  const t = (iso: string) => new Date(iso).getTime();
  assert.equal(onCallAt([primary], [], t('2026-10-19T07:00:00Z'))?.userId, 'a');
  assert.equal(onCallAt([primary], [], t('2026-10-20T07:00:00Z'))?.userId, 'b');
  assert.equal(onCallAt([primary], [], t('2026-10-22T07:00:00Z'))?.userId, 'a', 'wraps round');
  assert.equal(onCallAt([primary], [], t('2026-10-18T07:00:00Z')), null, 'nobody before the rotation starts');

  const weekends: ScheduleLayer = { ...primary, id: 'l2', position: 1, shiftHours: 168, startsAt: '2026-10-24T06:00:00.000Z', memberIds: ['z'] };
  assert.equal(onCallAt([primary, weekends], [], t('2026-10-24T07:00:00Z'))?.userId, 'z');

  const override = { id: 'o', userId: 'cover', userName: null, startsAt: '2026-10-20T18:00:00.000Z', endsAt: '2026-10-20T22:00:00.000Z', note: null };
  assert.equal(onCallAt([primary], [override], t('2026-10-20T19:00:00Z'))?.userId, 'cover');

  const shifts = renderShifts([primary], [override], t('2026-10-20T06:00:00Z'), t('2026-10-21T06:00:00Z'));
  assert.deepEqual(
    shifts.map((s) => [s.userId, s.startsAt.slice(11, 16), s.endsAt.slice(11, 16)]),
    [
      ['b', '06:00', '18:00'],
      ['cover', '18:00', '22:00'],
      ['b', '22:00', '06:00'],
    ],
  );
});

test('retention keeps the newest backup of each day, week and month', () => {
  const runs = Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, startedAt: new Date(Date.UTC(2026, 8, 1) + i * 86_400_000).toISOString() }));
  const kept = selectKept(runs, { keepDaily: 7, keepWeekly: 4, keepMonthly: 2 });
  for (let i = 53; i < 60; i += 1) assert.ok(kept.has(`r${i}`), `day ${i} kept`);
  assert.ok(kept.size <= 7 + 4 + 2);
  assert.ok(!kept.has('r10'), 'an old mid-month daily is pruned');
});

test('provider severities and paths are understood', () => {
  assert.equal(severityFrom('critical', 'sev3'), 'sev1');
  assert.equal(severityFrom('warning', 'sev1'), 'sev3');
  assert.equal(severityFrom('nonsense', 'sev2'), 'sev2');
  assert.equal(readPath({ alerts: [{ labels: { severity: 'high' } }] }, 'alerts[0].labels.severity'), 'high');
  assert.ok(statusMatches(204, '200-299'));
  assert.ok(statusMatches(301));
  assert.ok(!statusMatches(500));
  assert.ok(statusMatches(201, '2xx'));
});

test('S3 requests are signed exactly as AWS documents', () => {
  // The GET Object example from the AWS Signature Version 4 documentation.
  const headers = signRequest(
    { bucket: 'examplebucket', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    'GET',
    new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    { Range: 'bytes=0-9' },
    new Date('2013-05-24T00:00:00Z'),
  );
  assert.match(headers.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

/* ----------------------- Monitor -> incident -> page ---------------------- */

let policyId: string;
let monitorId: string;
let incidentId: string;
let pageId: string;

test('an escalation policy becomes the team default', async () => {
  const created = await call('POST', '/api/ops/policies', {
    name: 'Platform SEV',
    teamId,
    repeatCount: 0,
    levels: [
      { delayMins: 5, targets: [{ type: 'user', id: 'u-admin' }] },
      { delayMins: 5, targets: [{ type: 'user', id: 'u-second' }] },
    ],
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  policyId = created.payload.policy.id;
  assert.equal(created.payload.policy.levels[0].targets[0].name, 'Person u-admin');
  const set = await call('PUT', `/api/ops/team-policies/${teamId}`, { policyId });
  assert.equal(set.status, 200);
});

test('a failing HTTP monitor opens an incident and pages the first level', async () => {
  const created = await call('POST', '/api/ops/monitors', {
    name: 'Checkout API',
    kind: 'http',
    target: targetUrl,
    intervalSecs: 60,
    failureThreshold: 2,
    teamId,
    severity: 'sev1',
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  monitorId = created.payload.monitor.id;

  // One failure is not enough to page anyone.
  let checked = await call('POST', `/api/ops/monitors/${monitorId}/check`);
  assert.equal(checked.payload.monitor.state, 'pending');
  checked = await call('POST', `/api/ops/monitors/${monitorId}/check`);
  assert.equal(checked.payload.monitor.state, 'down');
  assert.match(checked.payload.monitor.lastMessage, /HTTP 503/);

  const alerts = await call('GET', '/api/ops/alerts?status=open');
  assert.equal(alerts.payload.alerts.length, 1);
  incidentId = alerts.payload.alerts[0].ticketId;
  const ticket = await call('GET', `/api/tickets/${incidentId}`);
  assert.equal(ticket.payload.ticket.type, 'incident');
  assert.equal(ticket.payload.ticket.severity, 'sev1');
  assert.equal(ticket.payload.ticket.priority, 'urgent');
  assert.equal(ticket.payload.ticket.source, 'monitor');

  const pages = await call('GET', `/api/ops/pages?ticketId=${incidentId}`);
  assert.equal(pages.payload.pages.length, 1);
  pageId = pages.payload.pages[0].id;
  assert.deepEqual(pages.payload.pages[0].currentTargetIds, ['u-admin']);
  assert.match(pages.payload.pages[0].reason, /Checkout API.*default escalation policy of team Platform/);

  const page = await call('GET', `/api/ops/pages/${pageId}`);
  const channels = page.payload.page.attempts.map((a: any) => `${a.channel}:${a.status}`);
  // Immediately: bell, email (not configured), chat. SMS waits a minute, the call three.
  assert.ok(channels.includes('in_app:sent'), channels.join(','));
  assert.ok(channels.includes('email:skipped'));
  assert.ok(!channels.some((c: string) => c.startsWith('sms') || c.startsWith('voice')));
});

test('unacknowledged, the pager moves to SMS, repeats calls, then escalates', async () => {
  const { pagerTick } = await import('../server/ops/pager.ts');
  const rewind = (mins: number) =>
    db.run(`UPDATE pages SET level_started_at = ? WHERE id = ?`, [new Date(Date.now() - mins * 60_000).toISOString(), pageId]);

  await rewind(4);
  await pagerTick();
  let page = (await call('GET', `/api/ops/pages/${pageId}`)).payload.page;
  const sms = page.attempts.find((a: any) => a.channel === 'sms');
  assert.equal(sms.status, 'simulated');
  assert.match(sms.detail, /\+27821234567/, 'the number is normalised to E.164');
  // One call is placed per tick, never a catch-up burst.
  assert.equal(page.attempts.filter((a: any) => a.channel === 'voice').length, 1);
  await pagerTick();
  page = (await call('GET', `/api/ops/pages/${pageId}`)).payload.page;
  assert.equal(page.attempts.filter((a: any) => a.channel === 'voice').length, 1, 'the second call waits for its slot');

  await rewind(6);
  await pagerTick();
  page = (await call('GET', `/api/ops/pages/${pageId}`)).payload.page;
  assert.equal(page.currentLevel, 1);
  assert.deepEqual(page.currentTargetIds, ['u-second']);
  assert.ok(page.attempts.some((a: any) => a.userId === 'u-second' && a.channel === 'in_app'));
});

test('a viewer of a page can acknowledge it, which stops the escalation and takes the ticket', async () => {
  const ack = await call('POST', `/api/ops/pages/${pageId}/ack`);
  assert.equal(ack.status, 200);
  assert.equal(ack.payload.page.status, 'acknowledged');
  assert.equal(ack.payload.page.acknowledgedById, 'u-admin');
  const ticket = (await call('GET', `/api/tickets/${incidentId}`)).payload.ticket;
  assert.equal(ticket.status, 'in_progress');
  assert.equal(ticket.assigneeId, 'u-admin');

  const { pagerTick } = await import('../server/ops/pager.ts');
  const before = (await call('GET', `/api/ops/pages/${pageId}`)).payload.page.attempts.length;
  await db.run(`UPDATE pages SET level_started_at = ? WHERE id = ?`, [new Date(Date.now() - 60 * 60_000).toISOString(), pageId]);
  await pagerTick();
  const after = (await call('GET', `/api/ops/pages/${pageId}`)).payload.page.attempts.length;
  assert.equal(after, before, 'nothing more is sent once acknowledged');
});

test('when the monitor recovers the incident resolves itself', async () => {
  targetHealthy = true;
  const checked = await call('POST', `/api/ops/monitors/${monitorId}/check`);
  assert.equal(checked.payload.monitor.state, 'up');
  const ticket = (await call('GET', `/api/tickets/${incidentId}`)).payload.ticket;
  assert.equal(ticket.status, 'resolved');
  const alerts = await call('GET', '/api/ops/alerts?status=open');
  assert.equal(alerts.payload.alerts.length, 0);
  const comments = (await call('GET', `/api/tickets/${incidentId}`)).payload.ticket.comments;
  assert.ok(comments.some((c: any) => c.authorName === 'InfraTicket' && /Auto-resolved/.test(c.body)), 'system notes are attributed to the platform');
});

/* ------------------------------ Webhook intake ---------------------------- */

test('a webhook source dedupes repeats, groups siblings and resolves', async () => {
  const created = await call('POST', '/api/ops/alert-sources', { name: 'Grafana', kind: 'grafana', teamId, defaultSeverity: 'sev3' });
  assert.equal(created.status, 201);
  const url = new URL(created.payload.source.webhookUrl);
  const post = (body: unknown) => call('POST', url.pathname, body, { cookie: '' });

  const firing = (fingerprint: string, status = 'firing') => ({
    status,
    alerts: [{ status, fingerprint, labels: { alertname: `Disk full ${fingerprint}`, severity: 'critical' }, annotations: { summary: `Disk full on ${fingerprint}` } }],
  });
  let res = await post(firing('db-1'));
  assert.equal(res.status, 202, JSON.stringify(res.payload));
  assert.equal(res.payload.results[0].action, 'created');
  const ticketId = res.payload.results[0].ticketId;

  res = await post(firing('db-1'));
  assert.equal(res.payload.results[0].action, 'deduplicated');
  res = await post(firing('db-2'));
  assert.equal(res.payload.results[0].action, 'grouped');
  assert.equal(res.payload.results[0].ticketId, ticketId);

  const alerts = (await call('GET', `/api/ops/alerts?ticketId=${ticketId}`)).payload.alerts;
  assert.equal(alerts.find((a: any) => a.dedupKey === 'db-1').count, 2);
  assert.equal(alerts[0].severity, 'sev1');

  await post(firing('db-1', 'resolved'));
  assert.equal((await call('GET', `/api/tickets/${ticketId}`)).payload.ticket.status, 'open', 'one alert still open');
  await post(firing('db-2', 'resolved'));
  assert.equal((await call('GET', `/api/tickets/${ticketId}`)).payload.ticket.status, 'resolved');
});

test('an unknown ingest token is refused', async () => {
  const res = await call('POST', '/api/ingest/not-a-real-token-at-all', { title: 'x' }, { cookie: '' });
  assert.equal(res.status, 404);
});

test('a maintenance window records the alert but pages nobody', async () => {
  const source = (await call('POST', '/api/ops/alert-sources', { name: 'Jenkins', kind: 'jenkins', teamId, defaultSeverity: 'sev2' })).payload.source;
  const now = Date.now();
  const window = await call('POST', '/api/ops/maintenance', {
    title: 'CI upgrade',
    startsAt: new Date(now - 60_000).toISOString(),
    endsAt: new Date(now + 3_600_000).toISOString(),
    monitorIds: [source.id],
  });
  assert.equal(window.status, 201);
  const res = await call('POST', new URL(source.webhookUrl).pathname, { name: 'deploy-prod', build: { status: 'FAILURE', number: 42 } }, { cookie: '' });
  const ticketId = res.payload.results[0].ticketId;
  assert.ok(ticketId);
  const pages = await call('GET', `/api/ops/pages?ticketId=${ticketId}&filter=all`);
  assert.equal(pages.payload.pages.length, 0);
  const alert = (await call('GET', `/api/ops/alerts?ticketId=${ticketId}`)).payload.alerts[0];
  assert.equal(alert.suppressed, true);
  assert.equal(alert.title, 'Jenkins: deploy-prod failure');
});

/* -------------------------------- Heartbeats ------------------------------ */

test('a heartbeat monitor accepts pings and reported failures', async () => {
  const created = await call('POST', '/api/ops/monitors', { name: 'Nightly ETL', kind: 'heartbeat', intervalSecs: 3600, graceSecs: 300, teamId, severity: 'sev4' });
  const url = new URL(created.payload.monitor.heartbeatUrl);
  assert.equal((await call('GET', url.pathname, undefined, { cookie: '' })).status, 200);
  let monitor = (await call('GET', `/api/ops/monitors/${created.payload.monitor.id}`)).payload.monitor;
  assert.equal(monitor.state, 'up');
  await call('POST', `${url.pathname}/fail`, 'exit code 2', { cookie: '', 'content-type': 'text/plain' });
  monitor = (await call('GET', `/api/ops/monitors/${created.payload.monitor.id}`)).payload.monitor;
  assert.equal(monitor.state, 'down');
  assert.equal(monitor.lastMessage, 'exit code 2');
  assert.equal((await call('GET', '/api/heartbeat/unknownunknownunknown', undefined, { cookie: '' })).status, 404);
});

/* -------------------------------- Status pages ---------------------------- */

test('a public status page renders for anyone; an internal one does not', async () => {
  const pub = await call('POST', '/api/ops/status-pages', { title: 'Acme Status', slug: 'acme', isPublic: true, components: [{ monitorId, label: 'Checkout' }] });
  assert.equal(pub.status, 201, JSON.stringify(pub.payload));
  await call('POST', `/api/ops/status-pages/${pub.payload.page.id}/updates`, { title: 'Checkout errors', state: 'resolved', body: 'Fixed <b>now</b>' });

  const html = await call('GET', '/status/acme', undefined, { cookie: '' });
  assert.equal(html.status, 200);
  assert.match(html.payload, /Checkout/);
  assert.match(html.payload, /All systems operational/);
  assert.match(html.payload, /Fixed &lt;b&gt;now&lt;\/b&gt;/, 'update text is escaped');
  const json = await call('GET', '/api/public/status/acme', undefined, { cookie: '' });
  assert.equal(json.payload.components[0].status, 'operational');
  assert.equal(json.payload.components[0].monitorId, undefined, 'internal ids stay internal');

  const styled = await call('PUT', `/api/ops/status-pages/${pub.payload.page.id}`, {
    title: 'Acme Status',
    slug: 'acme',
    isPublic: true,
    components: [{ monitorId, label: 'Checkout' }],
    appearance: { theme: 'dark', accentColor: '#2563eb', supportUrl: 'mailto:help@acme.test', customCss: 'h1{color:red}</style><script>alert(1)</script>' },
  });
  assert.equal(styled.status, 200, JSON.stringify(styled.payload));
  const themed = (await call('GET', '/status/acme', undefined, { cookie: '' })).payload as string;
  assert.match(themed, /--accent:#2563eb/);
  assert.match(themed, /mailto:help@acme.test/);
  assert.match(themed, /h1\{color:red\}/);
  assert.doesNotMatch(themed, /<script>/, 'custom CSS cannot break out of the style element');
  const badColour = await call('PUT', `/api/ops/status-pages/${pub.payload.page.id}`, { title: 'Acme Status', slug: 'acme', appearance: { accentColor: 'red;}' } });
  assert.equal(badColour.status, 400);

  await call('POST', '/api/ops/status-pages', { title: 'Internal', slug: 'internal', isPublic: false, components: [] });
  assert.equal((await call('GET', '/status/internal', undefined, { cookie: '' })).status, 404);
  assert.equal((await call('GET', '/status/internal')).status, 200, 'signed in, it shows');
});

/* --------------------------- Notification rules --------------------------- */

test('people keep their own mobile number current', async () => {
  const bad = await call('PATCH', '/api/auth/me/phone', { phone: '082 123' });
  assert.equal(bad.status, 400);
  const ok = await call('PATCH', '/api/auth/me/phone', { phone: '+27 82 123 4567' });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.user.phone, '+27 82 123 4567');
});

test('high urgency must be able to wake someone', async () => {
  const quiet = await call('PUT', '/api/ops/me/rules', { rules: [{ urgency: 'high', channel: 'email', delayMins: 0 }] });
  assert.equal(quiet.status, 400);
  const ok = await call('PUT', '/api/ops/me/rules', {
    rules: [
      { urgency: 'high', channel: 'in_app', delayMins: 0 },
      { urgency: 'high', channel: 'voice', delayMins: 2 },
    ],
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.isDefault, false);
  const testPage = await call('POST', '/api/ops/me/test-page');
  assert.deepEqual(testPage.payload.attempts.map((a: any) => `${a.channel}:${a.status}`).sort(), ['in_app:sent', 'voice:simulated']);
});

test('a Twilio SMS "ACK" acknowledges only with a valid signature', async () => {
  const refused = await call('POST', `/api/ops/tickets/${incidentId}/page`, { policyId, severity: 'sev1' });
  assert.equal(refused.status, 400, 'a resolved incident is not paged for');
  await db.run(`UPDATE tickets SET status = 'open' WHERE id = ?`, [incidentId]);
  const paged = (await call('POST', `/api/ops/tickets/${incidentId}/page`, { policyId, severity: 'sev1' })).payload.page;
  assert.ok(paged, 'page created');

  await call('PATCH', '/api/settings', { appUrl: 'https://tickets.acme.test' });
  await call('PUT', '/api/ops/telephony', { provider: 'twilio', accountSid: 'AC123', authToken: 'twilio-secret', fromNumber: '+15550001111' });
  const telephony = await call('GET', '/api/ops/telephony');
  assert.equal(telephony.payload.telephony.hasAuthToken, true);
  assert.equal(telephony.payload.telephony.authToken, undefined, 'the token is never sent back');

  const params = { From: '+27821234567', Body: 'ack' };
  const form = new URLSearchParams(params).toString();
  const forged = await call('POST', '/api/webhooks/telephony/twilio/sms', form, { cookie: '', 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'bogus' });
  assert.equal(forged.status, 403);

  const signature = twilioSignature('twilio-secret', 'https://tickets.acme.test/api/webhooks/telephony/twilio/sms', params);
  const res = await call('POST', '/api/webhooks/telephony/twilio/sms', form, { cookie: '', 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature });
  assert.equal(res.status, 200);
  assert.match(String(res.payload), /Acknowledged/);
  const page = (await call('GET', `/api/ops/pages/${paged.id}`)).payload.page;
  assert.equal(page.status, 'acknowledged');
  await call('PUT', '/api/ops/telephony', { provider: 'sandbox' });
});

/* ---------------------------------- Backups ------------------------------- */

test('a SQLite database is backed up encrypted and downloads decrypted', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'it-backup-'));
  const source = path.join(scratch, 'app.db');
  const { DatabaseSync } = (await import('node:sqlite')) as any;
  const sqlite = new DatabaseSync(source);
  sqlite.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO customers (name) VALUES ('Ada'), ('Grace');`);
  sqlite.close();

  const health = await call('POST', '/api/ops/databases/test', { engine: 'sqlite', connection: source });
  assert.equal(health.payload.health.ok, true, health.payload.health.message);

  const created = await call('POST', '/api/ops/databases', {
    name: 'App DB',
    engine: 'sqlite',
    connection: source,
    schedule: '0 2 * * *',
    destination: { type: 'local', path: path.join(scratch, 'out') },
    teamId,
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const job = created.payload.database;
  assert.ok(job.heartbeatMonitorId, 'the job gets a heartbeat monitor');
  assert.equal(job.connection, undefined, 'the connection is write-only');

  const run = await call('POST', `/api/ops/databases/${job.id}/run`);
  assert.equal(run.payload.run.status, 'succeeded', run.payload.run.error);
  const stored = fs.readFileSync(run.payload.run.location);
  assert.equal(stored.subarray(0, 5).toString(), 'ITBK2', 'the file carries its own wrapped key');
  assert.ok(!stored.includes(Buffer.from('Grace')), 'the stored file is encrypted');

  const download = await fetch(`${base}/api/ops/backup-runs/${run.payload.run.id}/download`, { headers: { cookie } });
  assert.equal(download.status, 200);
  const restored = Buffer.from(await download.arrayBuffer());
  assert.equal(restored.subarray(0, 15).toString(), 'SQLite format 3');
  const copy = path.join(scratch, 'restored.db');
  fs.writeFileSync(copy, restored);
  const check = new DatabaseSync(copy);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 2);
  check.close();

  const monitor = (await call('GET', `/api/ops/monitors/${job.heartbeatMonitorId}`)).payload.monitor;
  assert.equal(monitor.state, 'up', 'a successful run pings the heartbeat');

  const audit = await call('GET', '/api/audit?search=decrypted');
  assert.equal(audit.payload.total, 1, 'downloads are audited');
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('a failing backup reports failure through its heartbeat', async () => {
  const created = await call('POST', '/api/ops/databases', { name: 'Gone', engine: 'sqlite', connection: '/nonexistent/x.db', schedule: '0 3 * * *', teamId });
  const run = await call('POST', `/api/ops/databases/${created.payload.database.id}/run`);
  assert.equal(run.payload.run.status, 'failed');
  assert.match(run.payload.run.error, /does not exist/);
  const monitor = (await call('GET', `/api/ops/monitors/${created.payload.database.heartbeatMonitorId}`)).payload.monitor;
  assert.equal(monitor.state, 'down');
});

test('people without the permission cannot change operations', async () => {
  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword('Viewer-Password1!');
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['u-viewer', 'viewer@acme.test', 'viewer', 'Viewer', hash, salt, 'viewer', 'active', '#9a7b2f', 0, now, now],
  );
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'viewer@acme.test', password: 'Viewer-Password1!' }),
  });
  const viewer = login.headers.get('set-cookie')!.split(';')[0];
  const attempt = await call('POST', '/api/ops/monitors', { name: 'x', kind: 'tcp', target: 'a:1' }, { cookie: viewer });
  assert.equal(attempt.status, 403);
  assert.equal((await call('GET', '/api/ops/databases', undefined, { cookie: viewer })).status, 403);
  assert.equal((await call('GET', '/api/ops/monitors', undefined, { cookie: viewer })).status, 200, 'reading is open');
});
