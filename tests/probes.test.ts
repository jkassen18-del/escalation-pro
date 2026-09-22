/**
 * API health checks.
 *
 * Probed against a real HTTP server rather than a stubbed fetch, because the
 * things worth checking are what actually goes over the wire: whether the
 * bearer token arrives as a bearer token, whether basic auth is encoded the
 * way a server expects to decode it, and whether a timeout is noticed at all.
 * A mocked fetch would assert my own assumptions back at me.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'probes.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.SECRET_KEY = 'b'.repeat(64);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, `probes.db${suffix}`));
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

let db: typeof import('../server/db/index.ts').db;
let target: http.Server;
let targetUrl = '';
let teamId = '';

/** What the fake upstream saw, so the outgoing request can be inspected. */
let lastRequest: { url: string; headers: http.IncomingHttpHeaders } | null = null;
/** Flipped by tests to make the upstream misbehave. */
let behaviour: 'ok' | 'error' | 'slow' | 'wrong-body' = 'ok';

before(async () => {
  wipe();
  ensureClientDist();

  target = http.createServer((req, res) => {
    lastRequest = { url: req.url ?? '', headers: req.headers };

    if (behaviour === 'slow') {
      // Never answers: the probe's timeout is the only thing that ends this.
      return;
    }
    if (behaviour === 'error') {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end('{"status":"unhealthy"}');
    }
    if (behaviour === 'wrong-body') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"status":"degraded"}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"healthy"}');
  });

  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', () => resolve()));
  const address = target.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  targetUrl = `http://127.0.0.1:${address.port}/health`;

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword('irrelevant');
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['u-1', 'admin@acme.test', 'admin', 'Admin', hash, salt, 'admin', 'active', '#9a7b2f', 0, now, now],
  );
  await db.run('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', [
    'ticket_number',
    1000,
  ]);

  const { createTeam } = await import('../server/repositories/teams.ts');
  teamId = await createTeam({ key: 'it', name: 'IT Support' });
});

after(async () => {
  target?.closeAllConnections();
  await new Promise<void>((resolve) => target?.close(() => resolve()));
  await db.close();
  wipe();
});

const probeCount = async () =>
  Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM probes`))!.n);
const ticketCount = async () =>
  Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n);

/* ------------------------------ The request ------------------------------- */

test('a probe with no authentication just calls the URL', async () => {
  const { createProbe, runProbe } = await import('../server/infragrid/probes.ts');
  behaviour = 'ok';
  lastRequest = null;

  const probe = await createProbe({ name: 'Public status', url: targetUrl, teamId });
  const result = await runProbe(probe);

  assert.equal(result.ok, true, result.error ?? '');
  assert.equal(result.statusCode, 200);
  assert.ok(result.latencyMs >= 0);
  assert.equal(lastRequest?.headers.authorization, undefined, 'a credential was sent when none was configured');
});

test('a bearer token arrives as a bearer token', async () => {
  const { createProbe, runProbe } = await import('../server/infragrid/probes.ts');
  lastRequest = null;

  const probe = await createProbe({
    name: 'DigitalOcean',
    url: targetUrl,
    authKind: 'bearer',
    authSecret: 'dop_v1_secret',
  });
  await runProbe(probe);

  assert.equal(lastRequest?.headers.authorization, 'Bearer dop_v1_secret');
});

test('basic auth is encoded the way a server decodes it', async () => {
  const { createProbe, runProbe } = await import('../server/infragrid/probes.ts');
  lastRequest = null;

  const probe = await createProbe({
    name: 'Jenkins',
    url: targetUrl,
    authKind: 'basic',
    authSecret: 'buildbot:11aa22bb33cc',
  });
  await runProbe(probe);

  const header = String(lastRequest?.headers.authorization ?? '');
  assert.match(header, /^Basic /);
  assert.equal(
    Buffer.from(header.replace('Basic ', ''), 'base64').toString('utf8'),
    'buildbot:11aa22bb33cc',
    'the credential did not survive the round trip',
  );
});

test('a custom header is sent under the name that was chosen', async () => {
  const { createProbe, runProbe } = await import('../server/infragrid/probes.ts');
  lastRequest = null;

  const probe = await createProbe({
    name: 'Internal service',
    url: targetUrl,
    authKind: 'header',
    authName: 'X-Api-Key',
    authSecret: 'sk-internal-123',
  });
  await runProbe(probe);

  assert.equal(lastRequest?.headers['x-api-key'], 'sk-internal-123');
  assert.equal(lastRequest?.headers.authorization, undefined);
});

test('a query parameter is appended without losing the ones already there', async () => {
  const { createProbe, runProbe } = await import('../server/infragrid/probes.ts');
  lastRequest = null;

  const probe = await createProbe({
    name: 'Legacy API',
    url: `${targetUrl}?verbose=1`,
    authKind: 'query',
    authName: 'api_key',
    authSecret: 'k-987',
  });
  await runProbe(probe);

  const url = new URL(lastRequest!.url, 'http://127.0.0.1');
  assert.equal(url.searchParams.get('api_key'), 'k-987');
  assert.equal(url.searchParams.get('verbose'), '1', 'the existing query string was clobbered');
});

test('the credential is encrypted at rest and never published', async () => {
  const { listProbes } = await import('../server/infragrid/probes.ts');

  const row = await db.get<{ auth_secret: string }>(
    `SELECT auth_secret FROM probes WHERE name = 'DigitalOcean'`,
  );
  assert.ok(row!.auth_secret);
  assert.ok(!row!.auth_secret.includes('dop_v1_secret'), 'the token is stored in the clear');

  const probe = (await listProbes()).find((item) => item.name === 'DigitalOcean');
  assert.equal((probe as any).authSecret, undefined, 'the token was published to the client');
  assert.equal(probe!.hasSecret, true, 'the client cannot tell whether a credential is set');
});

/* ------------------------------- Verdicts --------------------------------- */

test('an unexpected status code is a failure, and says so', async () => {
  const { createProbe, runProbe } = await import('../server/infragrid/probes.ts');
  behaviour = 'error';

  const probe = await createProbe({ name: 'Failing', url: targetUrl });
  const result = await runProbe(probe);

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 503);
  assert.match(result.error!, /Expected 2xx, got 503/);
});

test('a body check catches a service that is up but unwell', async () => {
  // The classic: the process is running and answering 200, but its own
  // health endpoint is saying it cannot reach its database.
  const { createProbe, runProbe } = await import('../server/infragrid/probes.ts');
  behaviour = 'wrong-body';

  const probe = await createProbe({ name: 'Degraded', url: targetUrl, expectBody: '"status":"healthy"' });
  const result = await runProbe(probe);

  assert.equal(result.ok, false, 'a 200 with the wrong body was treated as healthy');
  assert.equal(result.statusCode, 200);
  assert.match(result.error!, /did not contain/);
});

test('a service that never answers is a failure, not a hang', async () => {
  const { createProbe, runProbe } = await import('../server/infragrid/probes.ts');
  behaviour = 'slow';

  const probe = await createProbe({ name: 'Hanging', url: targetUrl, timeoutMs: 1000 });
  const started = Date.now();
  const result = await runProbe(probe);

  assert.equal(result.ok, false);
  assert.match(result.error!, /No response within/);
  assert.ok(Date.now() - started < 5000, 'the probe did not give up when it said it would');
  behaviour = 'ok';
});

/* ------------------------- Alerting and recovery -------------------------- */

test('one failure does not wake anybody', async () => {
  const { createProbe, checkProbe, findProbe } = await import('../server/infragrid/probes.ts');
  behaviour = 'error';

  const probe = await createProbe({ name: 'Flappy', url: targetUrl, failureThreshold: 2, teamId });
  const before = await ticketCount();

  const first = await checkProbe(probe);
  assert.equal(first.alerted, false, 'a single blip raised an alert');
  assert.equal(await ticketCount(), before);

  const after = await findProbe(probe.id);
  assert.equal(after!.consecutiveFailures, 1);
  assert.notEqual(after!.status, 'down', 'one failure should not mark it down');
});

test('a failure that repeats raises an alert and a ticket', async () => {
  const { findProbe, checkProbe } = await import('../server/infragrid/probes.ts');
  const probe = (await findProbe(
    (await db.get<{ id: string }>(`SELECT id FROM probes WHERE name = 'Flappy'`))!.id,
  ))!;

  const before = await ticketCount();
  const second = await checkProbe(probe);

  assert.equal(second.alerted, true, 'the second consecutive failure did not alert');
  assert.equal(await ticketCount(), before + 1);

  const alert = await db.get<{ title: string; severity: string; ticket_id: string }>(
    `SELECT title, severity, ticket_id FROM alerts WHERE dedupe_key = ?`,
    [`probe:${probe.id}`],
  );
  assert.match(alert!.title, /Flappy is not healthy/);
  assert.equal(alert!.severity, 'critical');
  assert.ok(alert!.ticket_id);

  const ticket = await db.get<{ team_id: string }>(`SELECT team_id FROM tickets WHERE id = ?`, [alert!.ticket_id]);
  assert.equal(ticket!.team_id, teamId, 'the alert ignored the probe routing');
});

test('staying down does not open a second ticket', async () => {
  const { findProbe, checkProbe } = await import('../server/infragrid/probes.ts');
  const before = await ticketCount();

  for (let i = 0; i < 5; i += 1) {
    const probe = (await findProbe(
      (await db.get<{ id: string }>(`SELECT id FROM probes WHERE name = 'Flappy'`))!.id,
    ))!;
    await checkProbe(probe);
  }

  assert.equal(await ticketCount(), before, 'a persistent outage kept opening tickets');
});

test('coming back clears the alert and comments on the ticket', async () => {
  const { findProbe, checkProbe } = await import('../server/infragrid/probes.ts');
  behaviour = 'ok';

  const probe = (await findProbe(
    (await db.get<{ id: string }>(`SELECT id FROM probes WHERE name = 'Flappy'`))!.id,
  ))!;
  const outcome = await checkProbe(probe);

  assert.equal(outcome.cleared, true, 'the recovery was not noticed');

  const alert = await db.get<{ status: string; ticket_id: string }>(
    `SELECT status, ticket_id FROM alerts WHERE dedupe_key = ?`,
    [`probe:${probe.id}`],
  );
  assert.equal(alert!.status, 'resolved');

  // The ticket stays open: the service answering again is not the same as
  // anybody knowing why it stopped.
  const ticket = await db.get<{ status: string }>(`SELECT status FROM tickets WHERE id = ?`, [alert!.ticket_id]);
  assert.equal(ticket!.status, 'open');

  const comment = await db.get<{ body: string }>(
    `SELECT body FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 1`,
    [alert!.ticket_id],
  );
  assert.match(comment!.body, /recovered/i);
});

/* -------------------------------- Scheduling ------------------------------ */

test('the sweep only runs probes that are due', async () => {
  const { createProbe, sweepProbes } = await import('../server/infragrid/probes.ts');
  behaviour = 'ok';

  await createProbe({ name: 'Hourly', url: targetUrl, intervalSeconds: 3600 });
  const first = await sweepProbes();
  assert.ok(first.checked > 0, 'nothing ran on the first sweep');

  // Immediately again: nothing is due.
  const second = await sweepProbes();
  assert.equal(second.checked, 0, 'the sweep ignored the intervals and re-ran everything');

  // An hour on, the hourly one is due again.
  const later = await sweepProbes(new Date(Date.now() + 61 * 60 * 1000));
  assert.ok(later.checked > 0);
});

test('a disabled probe is left alone', async () => {
  const { createProbe, updateProbe, sweepProbes } = await import('../server/infragrid/probes.ts');
  const probe = await createProbe({ name: 'Paused', url: targetUrl, intervalSeconds: 30 });
  await updateProbe(probe.id, { enabled: false });

  lastRequest = null;
  await sweepProbes(new Date(Date.now() + 10 * 60 * 1000));

  const after = await db.get<{ last_checked_at: string | null }>(
    `SELECT last_checked_at FROM probes WHERE id = ?`,
    [probe.id],
  );
  assert.equal(after!.last_checked_at, null, 'a disabled probe was still called');
});

/* -------------------------------- Refusals -------------------------------- */

test('a cloud metadata address cannot be probed', async () => {
  // Never a legitimate health check, and the actual prize in an SSRF: it
  // hands out instance credentials to anything that asks from the right place.
  const { createProbe } = await import('../server/infragrid/probes.ts');
  const before = await probeCount();

  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
  ]) {
    await assert.rejects(createProbe({ name: 'Nope', url }), /metadata/i);
  }
  assert.equal(await probeCount(), before);
});

test('an internal address is allowed, because that is the point', async () => {
  // The webhook guard refuses private ranges; a probe must not, or the
  // feature is useless for the on-premises deployment it is for.
  const { createProbe } = await import('../server/infragrid/probes.ts');
  const probe = await createProbe({ name: 'Internal Jenkins', url: 'http://10.0.4.12:8080/login' });
  assert.equal(probe.url, 'http://10.0.4.12:8080/login');
});

test('a URL that is not a URL is refused', async () => {
  const { createProbe } = await import('../server/infragrid/probes.ts');
  await assert.rejects(createProbe({ name: 'Bad', url: 'not a url' }), /valid URL/i);
  await assert.rejects(createProbe({ name: 'Bad', url: 'ftp://files.example.com' }), /http or https/i);
});

test('a transport failure says what actually went wrong', async () => {
  /*
   * Node reports every transport failure as "fetch failed" and hides the
   * reason in `cause`. An administrator staring at a check that will not pass
   * needs to know whether the name did not resolve or the port refused the
   * connection - those have different fixes, and "fetch failed" points at
   * neither.
   */
  const { createProbe, runProbe } = await import('../server/infragrid/probes.ts');

  // A high port nothing listens on: reachable host, refused connection.
  // Not one of the low "bad ports" undici blocks before it ever connects.
  const refused = await runProbe(
    await createProbe({ name: 'Refused', url: 'http://127.0.0.1:45999/', timeoutMs: 2000 }),
  );
  assert.equal(refused.ok, false);
  assert.notEqual(refused.error, 'fetch failed', 'the real reason was swallowed');
  assert.match(refused.error!, /listening|ECONNREFUSED/i);

  const unresolvable = await runProbe(
    await createProbe({ name: 'Nowhere', url: 'http://no-such-host.invalid/', timeoutMs: 2000 }),
  );
  assert.equal(unresolvable.ok, false);
  assert.notEqual(unresolvable.error, 'fetch failed');
  assert.match(unresolvable.error!, /resolve|ENOTFOUND|EAI_AGAIN/i);
});
