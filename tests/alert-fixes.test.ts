/**
 * Alert correctness: what each source's payload turns into, dedup against a
 * closed ticket, a heartbeat that reported its own failure, and the ops
 * heartbeat /health reports.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';

import type { AlertSource } from '../shared/ops.ts';

// Before any server module loads: config reads these once, at import.
process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'alert-fixes.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.SECRET_KEY = 'd'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const { normalise } = await import('../server/ops/sources.ts');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `alert-fixes.db${suffix}`), { force: true });
}

let db: typeof import('../server/db/index.ts').db;

before(async () => {
  wipe();
  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();
});

after(async () => {
  await db.close();
  wipe();
});

const source = (kind: AlertSource['kind']): AlertSource => ({
  id: `src-${kind}`,
  name: kind,
  kind,
  teamId: null,
  teamName: null,
  escalationPolicyId: null,
  defaultSeverity: 'sev2',
  mapping: {},
  enabled: true,
  webhookUrl: '',
  lastEventAt: null,
  eventCount: 0,
  createdAt: new Date().toISOString(),
});

/* -------------------------------- Parsers --------------------------------- */

test('Cloudflare: "unhealthy" fires, "healthy again" resolves', () => {
  const down = normalise(source('cloudflare'), { name: 'Pool', alert_type: 'load_balancing_health_alert', text: 'Pool web is unhealthy' });
  assert.equal(down[0].status, 'firing');
  const notRecovered = normalise(source('cloudflare'), { name: 'Pool', text: 'Origin not recovered' });
  assert.equal(notRecovered[0].status, 'firing');
  const up = normalise(source('cloudflare'), { name: 'Pool', alert_type: 'load_balancing_health_alert', text: 'Pool web is healthy' });
  assert.equal(up[0].status, 'resolved');
});

test('Jenkins: a build starting is ignored; failure fires, success resolves', () => {
  assert.deepEqual(normalise(source('jenkins'), { name: 'deploy', build: { phase: 'STARTED', number: 7 } }), []);
  const failed = normalise(source('jenkins'), { name: 'deploy', build: { phase: 'COMPLETED', status: 'FAILURE' } });
  assert.equal(failed[0].status, 'firing');
  const fixed = normalise(source('jenkins'), { name: 'deploy', build: { phase: 'FINALIZED', status: 'SUCCESS' } });
  assert.equal(fixed[0].status, 'resolved');
});

test('AWS: EventBridge CloudWatch alarm changes parse; INSUFFICIENT_DATA is ignored', () => {
  const event = (value: string) => ({
    version: '0',
    id: 'evt-1',
    'detail-type': 'CloudWatch Alarm State Change',
    source: 'aws.cloudwatch',
    account: '123456789012',
    region: 'eu-west-1',
    detail: { alarmName: 'api-5xx', state: { value, reason: 'Threshold crossed' } },
  });
  const alarm = normalise(source('aws_sns'), event('ALARM'));
  assert.equal(alarm.length, 1);
  assert.equal(alarm[0].title, 'CloudWatch: api-5xx');
  assert.equal(alarm[0].status, 'firing');
  assert.equal(alarm[0].dedupKey, 'cloudwatch:123456789012:api-5xx');
  assert.equal(normalise(source('aws_sns'), event('OK'))[0].status, 'resolved');
  assert.deepEqual(normalise(source('aws_sns'), event('INSUFFICIENT_DATA')), []);

  // The SNS shape takes the same rule.
  const sns = (state: string) => ({ Type: 'Notification', Message: JSON.stringify({ AlarmName: 'db-cpu', NewStateValue: state, AWSAccountId: '1' }) });
  assert.equal(normalise(source('aws_sns'), sns('ALARM'))[0].status, 'firing');
  assert.deepEqual(normalise(source('aws_sns'), sns('INSUFFICIENT_DATA')), []);
});

/* ---------------------------------- Dedup --------------------------------- */

test('a signal for an alert whose ticket was closed raises a new alert and ticket', async () => {
  const { ingestSignal } = await import('../server/ops/alerts.ts');
  const signal = {
    sourceType: 'webhook' as const,
    sourceId: 'src-dedup',
    sourceName: 'Dedup',
    dedupKey: 'disk-full',
    title: 'Disk full',
    severity: 'sev4' as const,
    status: 'firing' as const,
    teamId: null,
    escalationPolicyId: null,
  };
  const first = await ingestSignal(signal);
  assert.equal(first.action, 'created');
  assert.ok(first.ticketId);

  const again = await ingestSignal(signal);
  assert.equal(again.action, 'deduplicated');
  assert.equal(again.alertId, first.alertId);

  await db.run(`UPDATE tickets SET status = 'closed' WHERE id = ?`, [first.ticketId]);
  const afterClose = await ingestSignal(signal);
  assert.equal(afterClose.action, 'created');
  assert.notEqual(afterClose.alertId, first.alertId);
  assert.notEqual(afterClose.ticketId, first.ticketId);
  const old = await db.get<{ status: string }>(`SELECT status FROM alerts WHERE id = ?`, [first.alertId]);
  assert.equal(old?.status, 'resolved');
});

/* -------------------------------- Heartbeats ------------------------------ */

test('a heartbeat that reported a failure stays down until a success ping', async () => {
  const { validateMonitor, saveMonitor, recordHeartbeat, checkMonitorNow, getMonitor } = await import('../server/ops/monitors.ts');
  const monitor = await saveMonitor(
    null,
    validateMonitor({ name: 'Nightly job', kind: 'heartbeat', intervalSecs: 3600, graceSecs: 600, failureThreshold: 1, severity: 'sev4' }),
  );
  const row = await db.get<{ heartbeat_token: string }>(`SELECT heartbeat_token FROM monitors WHERE id = ?`, [monitor.id]);
  const token = row!.heartbeat_token;

  assert.equal(await recordHeartbeat(token), true);
  assert.equal((await getMonitor(monitor.id))?.state, 'up');

  await recordHeartbeat(token, { fail: true, message: 'backup exited 1' });
  assert.equal((await getMonitor(monitor.id))?.state, 'down');
  // The scheduled check runs well inside the ping period: it must not
  // decide the job is fine just because the last ping was recent.
  await checkMonitorNow(monitor.id);
  await checkMonitorNow(monitor.id);
  assert.equal((await getMonitor(monitor.id))?.state, 'down');

  await recordHeartbeat(token);
  assert.equal((await getMonitor(monitor.id))?.state, 'up');
  await checkMonitorNow(monitor.id);
  assert.equal((await getMonitor(monitor.id))?.state, 'up');
});

/* ---------------------------------- Runner -------------------------------- */

test('a cron tick records when the loops ran, for /health', async () => {
  const { runOpsTick, opsHealth } = await import('../server/ops/runner.ts');
  const before = await opsHealth();
  assert.equal(before.lastTickAt, null);
  const result = await runOpsTick();
  assert.equal(result.leader, true);
  const health = await opsHealth();
  assert.equal(health.leader, true);
  assert.ok(health.lastTickAt && health.lastPagerTickAt);
  assert.ok(Date.now() - Date.parse(health.lastPagerTickAt) < 10_000);
});
