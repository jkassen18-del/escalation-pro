/**
 * InfraGrid: monitoring systems raising alerts.
 *
 * Two things decide whether this is useful or a menace, and both are checked
 * against payloads shaped the way each vendor actually sends them:
 *
 *  - Deduplication. A monitor re-fires every minute while a disk is full. If
 *    the dedupe key identifies the delivery rather than the condition, one
 *    bad disk opens hundreds of tickets.
 *  - Recovery. If a vendor's "it is better now" signal is not recognised,
 *    nothing ever clears and the grid stays red forever.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'infragrid.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.SECRET_KEY = 'b'.repeat(64);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, `infragrid.db${suffix}`));
    } catch {
      // Absent on the first run.
    }
  }
}

function ensureClientDist() {
  const dist = path.resolve(import.meta.dirname, '../dist/client');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }
}

let server: http.Server;
let base: string;
let db: typeof import('../server/db/index.ts').db;
let cookie: string;
let itTeamId = '';

/** One ingest token per vendor, as a real deployment would have. */
const tokens: Record<string, string> = {};

before(async () => {
  wipe();
  ensureClientDist();

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { ALL_PERMISSIONS } = await import('../server/permissions.ts');
  const { hash, salt } = hashPassword('Adm1n-Password!');
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['u-1', 'admin@acme.test', 'admin', 'Admin', hash, salt, 'admin', 'active', '#9a7b2f', 0, now, now],
  );
  for (const permission of ALL_PERMISSIONS) {
    await db.run('INSERT INTO user_permissions (user_id,permission) VALUES (?,?)', ['u-1', permission]);
  }
  await db.run('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', [
    'ticket_number',
    1000,
  ]);

  const { createTeam } = await import('../server/repositories/teams.ts');
  itTeamId = await createTeam({ key: 'it', name: 'IT Support' });

  const { createSource } = await import('../server/infragrid/store.ts');
  for (const kind of ['digitalocean', 'jenkins', 'azure', 'aws', 'crowdstrike', 'ansible', 'linux', 'windows'] as const) {
    tokens[kind] = (await createSource({ name: kind, kind, teamId: itTeamId })).token;
  }

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'admin@acme.test', password: 'Adm1n-Password!' }),
  });
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await db.close();
  wipe();
});

async function ingest(kind: string, payload: unknown) {
  const response = await fetch(`${base}/api/ingest/${tokens[kind]}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, payload: (await response.json().catch(() => null)) as any };
}

const ticketCount = async () =>
  Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n);
const alertCount = async () =>
  Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM alerts`))!.n);

/* ------------------------------ Refusals ---------------------------------- */

test('an unknown ingest token is refused', async () => {
  const response = await fetch(`${base}/api/ingest/ing_deadbeef_nothingreal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'x' }),
  });
  assert.equal(response.status, 401);
  assert.equal(await alertCount(), 0);
});

test('a disabled source stops accepting alerts and says why', async () => {
  const { createSource, updateSource } = await import('../server/infragrid/store.ts');
  const { source, token } = await createSource({ name: 'Retired', kind: 'generic' });
  await updateSource(source.id, { enabled: false });

  const response = await fetch(`${base}/api/ingest/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'x' }),
  });
  assert.equal(response.status, 401);
  assert.match(((await response.json()) as any).error, /disabled/i);
});

test('one source cannot post as another', async () => {
  // Each system has its own credential, so a compromised Jenkins cannot
  // impersonate CrowdStrike.
  const { status, payload } = await ingest('jenkins', { name: 'build', build: { status: 'FAILURE' } });
  assert.equal(status, 202);

  const alert = await db.get<{ source_id: string }>(`SELECT source_id FROM alerts ORDER BY first_seen_at DESC LIMIT 1`);
  const source = await db.get<{ kind: string }>(`SELECT kind FROM alert_sources WHERE id = ?`, [alert!.source_id]);
  assert.equal(source!.kind, 'jenkins');
  assert.equal(payload.alerts[0].status, 'created');
});

/* ------------------------------- Vendors ---------------------------------- */

test('a DigitalOcean alert names the droplet it is about', async () => {
  const { status, payload } = await ingest('digitalocean', {
    alert: { uuid: 'pol-1', description: 'CPU above 80%', status: 'triggered' },
    droplets: [{ id: 123, name: 'web-01' }],
  });
  assert.equal(status, 202);
  assert.equal(payload.alerts[0].status, 'created');

  const alert = await db.get<{ title: string; resource: string }>(
    `SELECT title, resource FROM alerts ORDER BY first_seen_at DESC LIMIT 1`,
  );
  assert.match(alert!.title, /CPU above 80%/);
  assert.equal(alert!.resource, 'web-01');
});

test('a DigitalOcean policy covering several droplets makes one alert each', async () => {
  const before = await alertCount();
  await ingest('digitalocean', {
    alert: { uuid: 'pol-2', description: 'Memory high', status: 'triggered' },
    droplets: [{ name: 'app-01' }, { name: 'app-02' }, { name: 'app-03' }],
  });
  // One problem per machine: collapsing them would hide two of the three.
  assert.equal(await alertCount(), before + 3);
});

test('a Jenkins SUCCESS resolves the job that was failing', async () => {
  await ingest('jenkins', { name: 'deploy-api', build: { number: 41, status: 'FAILURE', phase: 'FINALIZED' } });
  const firing = await db.get<{ id: string; severity: string }>(
    `SELECT id, severity FROM alerts WHERE dedupe_key = 'jenkins:deploy-api' AND status = 'firing'`,
  );
  assert.ok(firing, 'the failure did not raise an alert');
  assert.equal(firing!.severity, 'critical');

  await ingest('jenkins', { name: 'deploy-api', build: { number: 42, status: 'SUCCESS', phase: 'FINALIZED' } });
  const after = await db.get<{ status: string }>(`SELECT status FROM alerts WHERE id = ?`, [firing!.id]);
  assert.equal(after!.status, 'resolved', 'a green build did not clear the red one');
});

test('a Jenkins build that has only started is ignored', async () => {
  const before = await alertCount();
  await ingest('jenkins', { name: 'deploy-api', build: { number: 43, phase: 'STARTED' } });
  assert.equal(await alertCount(), before, 'a started build should say nothing');
});

test('an Azure common-schema alert is read, and its resolution recognised', async () => {
  await ingest('azure', {
    data: {
      essentials: {
        alertId: 'az-1',
        alertRule: 'High CPU',
        severity: 'Sev1',
        monitorCondition: 'Fired',
        alertTargetIDs: ['/subscriptions/x/resourceGroups/y/providers/Microsoft.Compute/virtualMachines/vm-prod-1'],
      },
    },
  });
  const firing = await db.get<{ id: string; severity: string; resource: string }>(
    `SELECT id, severity, resource FROM alerts WHERE dedupe_key LIKE 'azure:az-1%' AND status = 'firing'`,
  );
  assert.ok(firing);
  assert.equal(firing!.resource, 'vm-prod-1');
  assert.equal(firing!.severity, 'critical');

  await ingest('azure', {
    data: {
      essentials: {
        alertId: 'az-1',
        alertRule: 'High CPU',
        monitorCondition: 'Resolved',
        alertTargetIDs: ['/subscriptions/x/resourceGroups/y/providers/Microsoft.Compute/virtualMachines/vm-prod-1'],
      },
    },
  });
  const after = await db.get<{ status: string }>(`SELECT status FROM alerts WHERE id = ?`, [firing!.id]);
  assert.equal(after!.status, 'resolved');
});

test('an AWS CloudWatch alarm inside an SNS envelope is unwrapped', async () => {
  // The alarm is a JSON string inside the notification; reading the envelope
  // as the alarm would lose everything that matters.
  await ingest('aws', {
    Type: 'Notification',
    Subject: 'ALARM: rds-cpu',
    Message: JSON.stringify({
      AlarmName: 'rds-cpu',
      NewStateValue: 'ALARM',
      NewStateReason: 'Threshold crossed',
      Region: 'eu-west-1',
    }),
  });

  const alert = await db.get<{ title: string; body: string; severity: string; id: string }>(
    `SELECT id, title, body, severity FROM alerts WHERE dedupe_key LIKE 'aws:rds-cpu%'`,
  );
  assert.ok(alert, 'the SNS envelope was not unwrapped');
  assert.match(alert!.title, /rds-cpu is ALARM/);
  assert.equal(alert!.body, 'Threshold crossed');
  assert.equal(alert!.severity, 'critical');

  // OK is CloudWatch's recovery.
  await ingest('aws', {
    Type: 'Notification',
    Message: JSON.stringify({ AlarmName: 'rds-cpu', NewStateValue: 'OK', Region: 'eu-west-1' }),
  });
  const after = await db.get<{ status: string }>(`SELECT status FROM alerts WHERE id = ?`, [alert!.id]);
  assert.equal(after!.status, 'resolved');
});

test('an SNS subscription confirmation is answered, not treated as an alert', async () => {
  let confirmed = '';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://sns.example.test/')) {
      confirmed = url;
      return new Response('ok');
    }
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    const before = await alertCount();
    const { status, payload } = await ingest('aws', {
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://sns.example.test/confirm?token=abc',
    });

    assert.equal(status, 200);
    assert.equal(payload.confirmed, true);
    assert.equal(confirmed, 'https://sns.example.test/confirm?token=abc');
    assert.equal(await alertCount(), before, 'a subscription handshake became an alert');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a CrowdStrike detection defaults to critical and keeps separate detections apart', async () => {
  await ingest('crowdstrike', {
    event: {
      DetectId: 'det-1',
      ComputerName: 'LAPTOP-42',
      Technique: 'Credential Dumping',
      Tactic: 'Credential Access',
      FalconHostLink: 'https://falcon.example/det-1',
    },
  });
  await ingest('crowdstrike', {
    event: { DetectId: 'det-2', ComputerName: 'LAPTOP-42', Technique: 'Process Injection' },
  });

  const rows = await db.all<{ severity: string; external_url: string | null }>(
    `SELECT severity, external_url FROM alerts WHERE dedupe_key LIKE 'cs:%'`,
  );
  // Two detections on one machine are two things to look at.
  assert.equal(rows.length, 2, 'two detections on one host were collapsed into one');
  assert.ok(rows.every((row) => row.severity === 'critical'));
  assert.ok(rows.some((row) => row.external_url === 'https://falcon.example/det-1'));
});

test('an Ansible failure raises, and a later success clears it', async () => {
  await ingest('ansible', { name: 'patch-tuesday', status: 'failed', body: 'Host unreachable' });
  const firing = await db.get<{ id: string }>(
    `SELECT id FROM alerts WHERE dedupe_key = 'ansible:patch-tuesday' AND status = 'firing'`,
  );
  assert.ok(firing);

  await ingest('ansible', { name: 'patch-tuesday', status: 'successful' });
  const after = await db.get<{ status: string }>(`SELECT status FROM alerts WHERE id = ?`, [firing!.id]);
  assert.equal(after!.status, 'resolved');
});

test('a Linux source reads a Prometheus Alertmanager batch', async () => {
  const before = await alertCount();
  await ingest('linux', {
    alerts: [
      {
        status: 'firing',
        labels: { alertname: 'DiskWillFill', instance: 'db-01:9100', severity: 'critical' },
        annotations: { description: 'Disk full in 4 hours' },
      },
      {
        status: 'firing',
        labels: { alertname: 'HighLoad', instance: 'db-02:9100', severity: 'warning' },
        annotations: { summary: 'Load average 12' },
      },
    ],
  });
  assert.equal(await alertCount(), before + 2, 'a batch should produce one alert per entry');

  const critical = await db.get<{ severity: string; resource: string }>(
    `SELECT severity, resource FROM alerts WHERE dedupe_key LIKE 'linux:diskwillfill%'`,
  );
  assert.equal(critical!.severity, 'critical');
  assert.equal(critical!.resource, 'db-01:9100');
});

test('a Windows source reads the plain shape a scheduled task can send', async () => {
  await ingest('windows', {
    ComputerName: 'DC-01',
    Source: 'Service Control Manager',
    EntryType: 'Error',
    Message: 'The Print Spooler service terminated unexpectedly.',
  });
  const alert = await db.get<{ title: string; severity: string }>(
    `SELECT title, severity FROM alerts WHERE dedupe_key LIKE 'windows:dc-01%'`,
  );
  assert.ok(alert);
  assert.match(alert!.title, /DC-01/);
  assert.equal(alert!.severity, 'critical');
});

/* ---------------------------- Deduplication ------------------------------- */

test('a condition that re-fires does not open a second ticket', async () => {
  const beforeTickets = await ticketCount();
  const beforeAlerts = await alertCount();

  const payload = {
    ComputerName: 'FILE-01',
    Source: 'Disk',
    EntryType: 'Error',
    Message: 'Volume D: is at 95%',
  };
  for (let i = 0; i < 12; i += 1) await ingest('windows', payload);

  assert.equal(await alertCount(), beforeAlerts + 1, 'twelve firings made more than one alert');
  assert.equal(await ticketCount(), beforeTickets + 1, 'twelve firings made more than one ticket');

  const alert = await db.get<{ occurrences: number }>(
    `SELECT occurrences FROM alerts WHERE dedupe_key LIKE 'windows:file-01%'`,
  );
  assert.equal(Number(alert!.occurrences), 12, 'the repeats were not counted');
});

test('a condition that worsens raises its severity without duplicating', async () => {
  await ingest('linux', {
    alerts: [{ status: 'firing', labels: { alertname: 'Flapping', instance: 'app-9', severity: 'warning' } }],
  });
  await ingest('linux', {
    alerts: [{ status: 'firing', labels: { alertname: 'Flapping', instance: 'app-9', severity: 'critical' } }],
  });

  const rows = await db.all<{ severity: string }>(`SELECT severity FROM alerts WHERE dedupe_key LIKE 'linux:flapping%'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].severity, 'critical', 'the escalation was not reflected');
});

/* ------------------------------- Tickets ---------------------------------- */

test('an alert opens a ticket routed to the source’s department', async () => {
  await ingest('windows', { ComputerName: 'MAIL-01', Source: 'Exchange', EntryType: 'Error', Message: 'Queue stalled' });

  const alert = await db.get<{ ticket_id: string }>(
    `SELECT ticket_id FROM alerts WHERE dedupe_key LIKE 'windows:mail-01%'`,
  );
  assert.ok(alert!.ticket_id, 'no ticket was opened');

  const ticket = await db.get<{ team_id: string; priority: string; tags: string }>(
    `SELECT team_id, priority, tags FROM tickets WHERE id = ?`,
    [alert!.ticket_id],
  );
  assert.equal(ticket!.team_id, itTeamId);
  assert.equal(ticket!.priority, 'urgent', 'a critical alert should be urgent');
  assert.match(ticket!.tags, /infragrid/);
});

test('an informational alert is recorded but wakes nobody', async () => {
  const beforeTickets = await ticketCount();
  const { payload } = await ingest('linux', {
    alerts: [{ status: 'firing', labels: { alertname: 'Notice', instance: 'x-1', severity: 'info' } }],
  });

  assert.equal(payload.alerts[0].status, 'recorded', 'an info alert opened a ticket');
  assert.equal(await ticketCount(), beforeTickets);

  // Still visible on the grid, which is the point of recording it.
  const alert = await db.get<{ status: string }>(`SELECT status FROM alerts WHERE dedupe_key LIKE 'linux:notice%'`);
  assert.equal(alert!.status, 'firing');
});

test('a recovery comments on the ticket rather than closing it', async () => {
  await ingest('ansible', { name: 'nightly-sync', status: 'failed' });
  const alert = await db.get<{ id: string; ticket_id: string }>(
    `SELECT id, ticket_id FROM alerts WHERE dedupe_key = 'ansible:nightly-sync'`,
  );
  assert.ok(alert!.ticket_id);

  await ingest('ansible', { name: 'nightly-sync', status: 'successful' });

  const ticket = await db.get<{ status: string }>(`SELECT status FROM tickets WHERE id = ?`, [alert!.ticket_id]);
  /*
   * The condition clearing is not the same as the cause being understood. A
   * ticket that closes itself is how a recurring fault goes uninvestigated.
   */
  assert.equal(ticket!.status, 'open', 'the ticket closed itself');

  const comment = await db.get<{ body: string }>(
    `SELECT body FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 1`,
    [alert!.ticket_id],
  );
  assert.match(comment!.body, /recovered/i);
});

/* ------------------------------ Heartbeats -------------------------------- */

test('a heartbeat that checks in is healthy, and one that stops raises an alert', async () => {
  const { createHeartbeat } = await import('../server/infragrid/store.ts');
  const { sweepHeartbeats } = await import('../server/infragrid/sweep.ts');

  const heartbeat = await createHeartbeat({
    name: 'Nightly backup',
    periodSeconds: 3600,
    graceSeconds: 300,
    severity: 'critical',
    teamId: itTeamId,
  });

  // Never checked in: not yet late, or creating one would alert immediately
  // before anybody had put the URL into the job.
  assert.deepEqual(await sweepHeartbeats(), { checked: 1, missed: 0, recovered: 0 });

  const beat = await fetch(`${base}/api/ingest/heartbeat/${heartbeat.slug}`);
  assert.equal(beat.status, 200);

  // On time.
  assert.equal((await sweepHeartbeats()).missed, 0);

  // Two hours later, with a one-hour period, it is overdue.
  const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const swept = await sweepHeartbeats(later);
  assert.equal(swept.missed, 1, 'a silent job went unnoticed');

  const alert = await db.get<{ title: string; severity: string; ticket_id: string }>(
    `SELECT title, severity, ticket_id FROM alerts WHERE dedupe_key = ?`,
    [`heartbeat:${heartbeat.slug}`],
  );
  assert.match(alert!.title, /has not checked in/);
  assert.equal(alert!.severity, 'critical');
  assert.ok(alert!.ticket_id, 'a missed heartbeat should raise a ticket');
});

test('a heartbeat that starts checking in again clears itself', async () => {
  const { listHeartbeats } = await import('../server/infragrid/store.ts');
  const { sweepHeartbeats } = await import('../server/infragrid/sweep.ts');

  const missed = (await listHeartbeats()).find((item) => item.status === 'missed');
  assert.ok(missed, 'expected a missed heartbeat from the previous test');

  await fetch(`${base}/api/ingest/heartbeat/${missed!.slug}`);

  /*
   * The check-in itself clears the alert, without waiting for a sweep. It has
   * to: recording a beat moves the heartbeat out of `missed`, so a sweep
   * looking for that transition would never see it and the alert would stay
   * firing forever.
   */
  const alert = await db.get<{ status: string }>(`SELECT status FROM alerts WHERE dedupe_key = ?`, [
    `heartbeat:${missed!.slug}`,
  ]);
  assert.equal(alert!.status, 'resolved', 'a recovered job left its alert firing');

  const after = (await listHeartbeats()).find((item) => item.id === missed!.id);
  assert.equal(after!.status, 'ok');

  // And the next sweep has nothing left to do.
  assert.equal((await sweepHeartbeats()).recovered, 0);
});

test('a heartbeat only fires once while it stays missed', async () => {
  const { createHeartbeat } = await import('../server/infragrid/store.ts');
  const { sweepHeartbeats } = await import('../server/infragrid/sweep.ts');

  const heartbeat = await createHeartbeat({ name: 'Chatty', periodSeconds: 60, graceSeconds: 60 });
  await fetch(`${base}/api/ingest/heartbeat/${heartbeat.slug}`);

  const later = new Date(Date.now() + 60 * 60 * 1000);
  const beforeTickets = await ticketCount();
  await sweepHeartbeats(later);
  await sweepHeartbeats(later);
  await sweepHeartbeats(later);

  assert.equal(await ticketCount(), beforeTickets + 1, 'repeated sweeps opened repeated tickets');
});

test('an unknown heartbeat slug is a 404', async () => {
  const response = await fetch(`${base}/api/ingest/heartbeat/not-a-real-slug`);
  assert.equal(response.status, 404);
});

/* -------------------------------- The grid -------------------------------- */

test('the grid shows sources, what is firing, and the heartbeats', async () => {
  const response = await fetch(`${base}/api/infragrid`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as any;

  assert.ok(payload.sources.length >= 8, 'not every connected system is listed');
  assert.ok(payload.alerts.length > 0);
  assert.ok(payload.heartbeats.length > 0);

  // The firing count per source is what the grid colours itself by.
  const jenkins = payload.sources.find((source: any) => source.kind === 'jenkins');
  assert.equal(typeof jenkins.firingCount, 'number');
  // And the token is never republished.
  assert.equal(jenkins.tokenHash, undefined);
});

test('the grid needs a session', async () => {
  const response = await fetch(`${base}/api/infragrid`);
  assert.equal(response.status, 401);
});

/* ------------------------------ Test alert -------------------------------- */

test('a test alert goes down the same path a real one does', async () => {
  /*
   * The point of this button is to see an alert arrive. Each integration has
   * a connection test of its own, but those prove the credential works - not
   * that an alert reaches a person, which also depends on routing, on which
   * events each integration subscribes to, and on a ticket being created at
   * all. So the test alert must not take a shortcut past any of that.
   */
  const before = await ticketCount();

  const response = await fetch(`${base}/api/infragrid/test-alert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ severity: 'critical', teamId: itTeamId }),
  });
  assert.equal(response.status, 201);

  const payload = (await response.json()) as any;
  assert.equal(payload.status, 'created');
  assert.match(payload.ticketReference, /^ESC-\d+$/);
  assert.equal(await ticketCount(), before + 1);

  const ticket = await db.get<{ subject: string; team_id: string; priority: string; source: string }>(
    `SELECT subject, team_id, priority, source FROM tickets WHERE id = (
       SELECT ticket_id FROM alerts ORDER BY first_seen_at DESC LIMIT 1)`,
  );
  assert.match(ticket!.subject, /Test alert/);
  assert.equal(ticket!.team_id, itTeamId, 'the test ignored the department it was sent to');
  // A real critical alert is urgent, so the test one must be too, or it does
  // not exercise the same notification rules.
  assert.equal(ticket!.priority, 'urgent');
});

test('two test alerts do not fold into one', async () => {
  // Deduplication is right for a real condition re-firing and wrong here:
  // pressing the button twice should produce two visible alerts.
  const before = await ticketCount();
  for (let i = 0; i < 2; i += 1) {
    await fetch(`${base}/api/infragrid/test-alert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ severity: 'warning' }),
    });
  }
  assert.equal(await ticketCount(), before + 2);
});

test('only an administrator can send one', async () => {
  const response = await fetch(`${base}/api/infragrid/test-alert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 401);
});
