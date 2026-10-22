/**
 * Fixed on-call rosters ("week 1 Jamal, week 2 Kopano") and alert routing
 * rules, over real HTTP against a throwaway SQLite database.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

import type { AlertRule, ScheduleLayer } from '../shared/ops.ts';

// Before any server module loads: config reads these once, at import.
process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'roster-routing.db';
process.env.SESSION_SECRET = 'r'.repeat(48);
process.env.SECRET_KEY = 'd'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const wipe = () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `roster-routing.db${suffix}`), { force: true });
};

// Dynamic, so they load after the environment above.
const { onCallAt, renderShifts, parseRosterEntries, scheduleToIcs } = await import('../server/ops/oncall.ts');
const { evaluateRules, ruleMatches, assertSafeRegex } = await import('../server/ops/routing.ts');
const { buildWeeklyRoster, zonedTimeToUtc } = await import('../shared/roster.ts');

let server: http.Server;
let base: string;
let cookie: string;
let db: typeof import('../server/db/index.ts').db;
let webTeam: string;
let dbaTeam: string;

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
    // not JSON
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
  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword('Adm1n-Password!');
  const now = new Date().toISOString();
  for (const [id, email, role] of [
    ['u-jamal', 'jamal@acme.test', 'admin'],
    ['u-kopano', 'kopano@acme.test', 'agent'],
    ['u-lee', 'lee@acme.test', 'agent'],
  ]) {
    await db.run(
      'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, email, id, id.slice(2), hash, salt, role, 'active', '#9a7b2f', 0, now, now],
    );
  }
  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'jamal@acme.test', password: 'Adm1n-Password!' }),
  });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  webTeam = (await call('POST', '/api/teams', { name: 'Web', key: 'WEB' })).payload.team.id;
  dbaTeam = (await call('POST', '/api/teams', { name: 'DBA', key: 'DBA' })).payload.team.id;
});

after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db.close();
  wipe();
});

/* --------------------------------- Roster --------------------------------- */

test('handover times are computed in the schedule\'s time zone', () => {
  // 08:00 in Johannesburg (UTC+2, no DST) is 06:00 UTC.
  assert.equal(zonedTimeToUtc(2026, 11, 2, 8, 0, 'Africa/Johannesburg').toISOString(), '2026-11-02T06:00:00.000Z');
  // London is UTC+1 in summer and UTC+0 in winter: the same wall clock lands on different UTC hours.
  assert.equal(zonedTimeToUtc(2026, 7, 6, 9, 0, 'Europe/London').toISOString(), '2026-07-06T08:00:00.000Z');
  assert.equal(zonedTimeToUtc(2026, 12, 7, 9, 0, 'Europe/London').toISOString(), '2026-12-07T09:00:00.000Z');

  const roster = buildWeeklyRoster({
    firstWeek: '2026-11-04', // a Wednesday: the week is the one starting Monday 2 Nov
    weekday: 1,
    time: '08:00',
    timeZone: 'Africa/Johannesburg',
    people: ['u-jamal', null, 'u-kopano'],
  });
  assert.deepEqual(roster, [
    { userId: 'u-jamal', startsAt: '2026-11-02T06:00:00.000Z', endsAt: '2026-11-09T06:00:00.000Z' },
    { userId: 'u-kopano', startsAt: '2026-11-16T06:00:00.000Z', endsAt: '2026-11-23T06:00:00.000Z' },
  ]);
});

test('a roster layer covers only its entries, so lower layers show through the gaps', () => {
  const roster: ScheduleLayer = {
    id: 'top',
    name: 'Roster',
    position: 1,
    rotation: 'roster',
    shiftHours: 168,
    startsAt: '2026-11-02T06:00:00.000Z',
    memberIds: [],
    entries: [
      { userId: 'jamal', startsAt: '2026-11-02T06:00:00.000Z', endsAt: '2026-11-09T06:00:00.000Z' },
      { userId: 'kopano', startsAt: '2026-11-16T06:00:00.000Z', endsAt: '2026-11-23T06:00:00.000Z' },
    ],
  };
  const fallback: ScheduleLayer = {
    id: 'base',
    name: 'Backstop',
    position: 0,
    rotation: 'weekly',
    shiftHours: 168,
    startsAt: '2026-10-01T00:00:00.000Z',
    memberIds: ['lee'],
    entries: [],
  };
  const at = (iso: string) => onCallAt([roster, fallback], [], new Date(iso).getTime())?.userId;
  assert.equal(at('2026-11-05T12:00:00Z'), 'jamal');
  assert.equal(at('2026-11-09T06:00:00Z'), 'lee', 'the end is exclusive, and the gap week falls to the lower layer');
  assert.equal(at('2026-11-17T12:00:00Z'), 'kopano');
  assert.equal(onCallAt([roster], [], new Date('2026-11-10T00:00:00Z').getTime()), null, 'a gap with no lower layer is nobody');

  const shifts = renderShifts([roster, fallback], [], new Date('2026-11-02T06:00:00Z').getTime(), new Date('2026-11-23T06:00:00Z').getTime());
  assert.deepEqual(
    shifts.map((s) => [s.userId, s.startsAt.slice(5, 10), s.endsAt.slice(5, 10)]),
    [
      ['jamal', '11-02', '11-09'],
      ['lee', '11-09', '11-16'],
      ['kopano', '11-16', '11-23'],
    ],
  );
});

test('overlapping roster entries are refused', () => {
  assert.throws(
    () =>
      parseRosterEntries(
        [
          { userId: 'a', startsAt: '2026-11-02T06:00:00Z', endsAt: '2026-11-09T06:00:00Z' },
          { userId: 'b', startsAt: '2026-11-08T06:00:00Z', endsAt: '2026-11-10T06:00:00Z' },
        ],
        'Roster',
      ),
    /overlap/,
  );
  assert.throws(() => parseRosterEntries([{ userId: 'a', startsAt: '2026-11-09T06:00:00Z', endsAt: '2026-11-02T06:00:00Z' }], 'Roster'), /ends before/);
  // Touching end-to-start is not an overlap.
  assert.equal(
    parseRosterEntries(
      [
        { userId: 'b', startsAt: '2026-11-09T06:00:00Z', endsAt: '2026-11-16T06:00:00Z' },
        { userId: 'a', startsAt: '2026-11-02T06:00:00Z', endsAt: '2026-11-09T06:00:00Z' },
      ],
      'Roster',
    )[0].userId,
    'a',
    'entries come back sorted',
  );
});

test('a roster schedule saves, resolves who is on call now, and exports to iCal', async () => {
  const now = Date.now();
  const iso = (offsetDays: number) => new Date(now + offsetDays * 86_400_000).toISOString();
  const created = await call('POST', '/api/ops/schedules', {
    name: 'Standby roster',
    timeZone: 'Africa/Johannesburg',
    layers: [
      {
        name: 'Weeks',
        rotation: 'roster',
        entries: [
          { userId: 'u-kopano', startsAt: iso(-1), endsAt: iso(6) },
          { userId: 'u-jamal', startsAt: iso(6), endsAt: iso(13) },
        ],
      },
    ],
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const schedule = created.payload.schedule;
  assert.equal(schedule.layers[0].rotation, 'roster');
  assert.equal(schedule.layers[0].entries.length, 2);
  assert.equal(schedule.onCallNow.userId, 'u-kopano');

  const overlap = await call('PUT', `/api/ops/schedules/${schedule.id}`, {
    name: 'Standby roster',
    layers: [{ name: 'Weeks', rotation: 'roster', entries: [{ userId: 'u-kopano', startsAt: iso(0), endsAt: iso(7) }, { userId: 'u-jamal', startsAt: iso(5), endsAt: iso(9) }] }],
  });
  assert.equal(overlap.status, 400);

  const ics = await call('GET', `/api/ops/schedules/${schedule.id}/calendar.ics`);
  assert.equal(ics.status, 200);
  assert.match(ics.headers.get('content-type') ?? '', /text\/calendar/);
  assert.match(ics.payload, /BEGIN:VCALENDAR/);
  assert.match(ics.payload, /SUMMARY:On call: kopano/);
  assert.equal((await call('GET', `/api/ops/schedules/${schedule.id}/calendar.ics`, undefined, { cookie: '' })).status, 401);

  // iCal text escaping.
  assert.match(scheduleToIcs('Ops; nights, weekends', []), /X-WR-CALNAME:Ops\\; nights\\, weekends/);
});

/* --------------------------------- Routing -------------------------------- */

const rule = (partial: Partial<AlertRule>): AlertRule => ({
  id: partial.name ?? 'r',
  name: 'r',
  position: 0,
  enabled: true,
  match: {},
  actions: {},
  continueEvaluating: false,
  createdAt: '',
  updatedAt: '',
  ...partial,
});
const signal = {
  sourceType: 'monitor' as const,
  sourceId: 'm-1',
  sourceKind: 'http',
  title: 'Checkout site down',
  summary: 'HTTP 503',
  severity: 'sev2' as const,
  payload: { labels: { service: 'checkout' } },
  teamId: 'ops',
  escalationPolicyId: 'p-ops',
};

test('rule conditions: kind, text, regex, severity, payload field and working hours', () => {
  assert.ok(ruleMatches({ sourceKinds: ['http'] }, signal));
  assert.ok(!ruleMatches({ sourceKinds: ['database'] }, signal));
  assert.ok(ruleMatches({ text: 'CHECKOUT', textMode: 'contains' }, signal));
  assert.ok(ruleMatches({ text: '^checkout .* down$', textMode: 'regex' }, signal));
  assert.ok(!ruleMatches({ severities: ['sev1'] }, signal));
  assert.ok(ruleMatches({ field: { path: 'labels.service', op: 'equals', value: 'Checkout' } }, signal));
  assert.ok(!ruleMatches({ field: { path: 'labels.team', op: 'equals', value: 'x' } }, signal));
  const window = { timeZone: 'Africa/Johannesburg', days: [1, 2, 3, 4, 5], startHour: 8, endHour: 17 };
  const tuesdayNoonSast = new Date('2026-11-03T10:00:00Z');
  const saturday = new Date('2026-11-07T10:00:00Z');
  assert.ok(ruleMatches({ timeWindow: { mode: 'business_hours', ...window } }, signal, tuesdayNoonSast));
  assert.ok(!ruleMatches({ timeWindow: { mode: 'business_hours', ...window } }, signal, saturday));
  assert.ok(ruleMatches({ timeWindow: { mode: 'after_hours', ...window } }, signal, saturday));
  assert.throws(() => assertSafeRegex('(a+)+$'), /repeats a repeated group/);
});

test('the first matching rule wins unless it says to keep evaluating', () => {
  const rules = [
    rule({ name: 'skip', enabled: false, actions: { teamId: 'nobody' } }),
    rule({ name: 'Tag web', match: { sourceKinds: ['http'] }, actions: { tags: ['web'] }, continueEvaluating: true }),
    rule({ name: 'Website down → Web team', match: { text: 'site' }, actions: { teamId: 'web', severity: 'sev1' } }),
    rule({ name: 'never reached', actions: { drop: true } }),
  ];
  const outcome = evaluateRules(rules, signal);
  assert.deepEqual(outcome.matchedRules.map((r) => r.name), ['Tag web', 'Website down → Web team']);
  assert.equal(outcome.teamId, 'web');
  assert.equal(outcome.escalationPolicyId, null, 'a new department means its own default policy');
  assert.equal(outcome.severity, 'sev1');
  assert.deepEqual(outcome.tags, ['web']);
  assert.equal(outcome.drop, false);
  assert.match(outcome.explanation, /Routed by rule 'Tag web', then 'Website down → Web team' \(severity SEV2 → SEV1\)/);
  assert.equal(evaluateRules([], signal).teamId, 'ops', 'no rules, no change');
});

test('routing rules decide the department, the policy and whether anyone is paged', async () => {
  const policy = (
    await call('POST', '/api/ops/policies', { name: 'Web on-call', levels: [{ delayMins: 5, targets: [{ type: 'user', id: 'u-kopano' }] }] })
  ).payload.policy;
  await call('PUT', `/api/ops/team-policies/${webTeam}`, { policyId: policy.id });

  const web = await call('POST', '/api/ops/alert-rules', {
    name: 'Website down → Web team',
    match: { sourceKinds: ['grafana'], text: 'website' },
    actions: { teamId: webTeam, tags: ['website'] },
  });
  assert.equal(web.status, 201, JSON.stringify(web.payload));
  const quiet = await call('POST', '/api/ops/alert-rules', { name: 'SEV4 → ticket only', match: { severities: ['sev4'] }, actions: { suppressPaging: true } });
  const noise = await call('POST', '/api/ops/alert-rules', { name: 'Drop test noise', match: { field: { path: 'labels.env', op: 'equals', value: 'test' } }, actions: { drop: true } });
  const dba = await call('POST', '/api/ops/alert-rules', { name: 'Database alerts → DBA', match: { text: 'postgres' }, actions: { teamId: dbaTeam, severity: 'sev3' } });
  assert.equal((await call('POST', '/api/ops/alert-rules', { name: 'No actions', match: {} , actions: {} })).status, 400);

  // Reorder: DBA first.
  const order = await call('PUT', '/api/ops/alert-rules/order', { ids: [dba.payload.rule.id, web.payload.rule.id, quiet.payload.rule.id, noise.payload.rule.id] });
  assert.deepEqual(order.payload.rules.map((r: any) => r.name), ['Database alerts → DBA', 'Website down → Web team', 'SEV4 → ticket only', 'Drop test noise']);

  // Dry run creates nothing.
  const before = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n);
  const dry = await call('POST', '/api/ops/alert-rules/test', { title: 'Website checkout is down', sourceKind: 'grafana', severity: 'sev2' });
  assert.equal(dry.payload.outcome.teamId, webTeam);
  assert.equal(Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n), before);
  const draft = await call('POST', '/api/ops/alert-rules/test', { title: 'x', rule: { name: 'Draft', match: { text: 'x' }, actions: { severity: 'sev4' } } });
  assert.equal(draft.payload.outcome.severity, 'sev4', 'an unsaved rule can be tried');

  const source = (await call('POST', '/api/ops/alert-sources', { name: 'Grafana', kind: 'grafana', defaultSeverity: 'sev2' })).payload.source;
  const hook = new URL(source.webhookUrl).pathname;
  const send = (alertname: string, labels: Record<string, string> = {}, severity = 'critical') =>
    call(
      'POST',
      hook,
      { status: 'firing', alerts: [{ status: 'firing', fingerprint: `${alertname}-${Math.random()}`, labels: { alertname, severity, ...labels }, annotations: { summary: alertname } }] },
      { cookie: '' },
    );

  // Website alert: routed to Web, paged through Web's default policy, reason names the rule.
  const site = await send('Website checkout is down');
  const siteTicket = (await call('GET', `/api/tickets/${site.payload.results[0].ticketId}`)).payload.ticket;
  assert.equal(siteTicket.teamId, webTeam);
  assert.ok(siteTicket.tags.includes('website'));
  assert.ok(siteTicket.comments.some((c: any) => /Routed by rule 'Website down → Web team'/.test(c.body)));
  const page = (await call('GET', `/api/ops/pages?ticketId=${siteTicket.id}&filter=all`)).payload.pages[0];
  assert.deepEqual(page.currentTargetIds, ['u-kopano']);
  assert.match(page.reason, /Routed by rule 'Website down → Web team'/);
  const alert = (await call('GET', `/api/ops/alerts?ticketId=${siteTicket.id}`)).payload.alerts[0];
  assert.equal(alert.ruleName, 'Website down → Web team');

  // Severity override, to DBA (no policy there, so nobody paged but the ticket says why).
  const pg = await send('Postgres replication lag');
  const pgTicket = (await call('GET', `/api/tickets/${pg.payload.results[0].ticketId}`)).payload.ticket;
  assert.equal(pgTicket.teamId, dbaTeam);
  assert.equal(pgTicket.severity, 'sev3');

  // Ticket only.
  const low = await send('Disk 70% on build agent', {}, 'info');
  const lowId = low.payload.results[0].ticketId;
  assert.equal((await call('GET', `/api/ops/pages?ticketId=${lowId}&filter=all`)).payload.pages.length, 0);
  assert.equal((await call('GET', `/api/ops/alerts?ticketId=${lowId}`)).payload.alerts[0].suppressed, true);

  // Dropped: nothing recorded, but the source still counts the delivery.
  const countBefore = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM alerts`))!.n);
  const dropped = await send('Flaky test env', { env: 'test' });
  assert.equal(dropped.payload.results[0].action, 'ignored');
  assert.equal(Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM alerts`))!.n), countBefore);
  const sources = (await call('GET', '/api/ops/alert-sources')).payload.sources;
  assert.equal(sources.find((s: any) => s.id === source.id).eventCount, 4);
});
