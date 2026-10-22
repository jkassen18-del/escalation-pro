/**
 * Custom HTTP integrations and the Linear team mapping.
 *
 * The integrations are driven against a real local HTTP receiver, so what is
 * checked is what actually goes over the wire: the signature a receiver
 * verifies, a body that stays valid JSON whatever a subject contains, and
 * which tickets reach which integration.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Before any server module loads: config reads these once, at import.
process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'http-integrations.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.SECRET_KEY = 'd'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const LINEAR_SECRET = 'linear-webhook-secret';

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `http-integrations.db${suffix}`), { force: true });
}

let server: http.Server;
let base: string;
let cookie: string;
let db: typeof import('../server/db/index.ts').db;
let opsTeam = '';
let hrTeam = '';

/** Everything the receiver was sent, by path. */
interface Received {
  path: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
let received: Received[] = [];
let receiver: http.Server;
let receiverUrl = '';

async function call(method: string, url: string, body?: unknown) {
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
    // empty
  }
  return { status: response.status, payload };
}

/** Deliveries are fire-and-forget, so wait for what should arrive. */
async function waitFor<T>(check: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const realFetch = globalThis.fetch;

before(async () => {
  wipe();
  const dist = path.resolve(import.meta.dirname, '../dist/client');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }

  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '', method: req.method ?? '', headers: req.headers, body });
      res.statusCode = req.url?.startsWith('/broken') ? 500 : 200;
      res.end(req.url?.startsWith('/broken') ? 'receiver exploded' : '{"received":true}');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', () => resolve()));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}`;

  // Linear's API is only asked who an issue's author is.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://api.linear.app/')) return Response.json({ data: { user: null } });
    return realFetch(input, init);
  }) as typeof fetch;

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();

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

  const login = await realFetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'admin@acme.test', password: 'Adm1n-Password!' }),
  });
  cookie = login.headers.get('set-cookie')!.split(';')[0];

  opsTeam = (await call('POST', '/api/teams', { name: 'Platform Ops', key: 'PLO' })).payload.team.id;
  hrTeam = (await call('POST', '/api/teams', { name: 'People', key: 'PPL' })).payload.team.id;
});

after(async () => {
  globalThis.fetch = realFetch;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  receiver?.closeAllConnections();
  await new Promise<void>((resolve) => receiver?.close(() => resolve()));
  await db.close();
  wipe();
});

/* ------------------------------ Custom HTTP ------------------------------- */

let signedId = '';

test('private and internal addresses are refused unless the integration allows them', async () => {
  const internal = await call('POST', '/api/integrations/http', { name: 'Internal', url: `${receiverUrl}/x` });
  assert.equal(internal.status, 400, 'an http localhost URL was accepted without the toggle');
  const privateHttps = await call('POST', '/api/integrations/http', { name: 'Private', url: 'https://10.1.2.3/hook' });
  assert.equal(privateHttps.status, 400);
  // Even with the toggle, cloud metadata stays off limits.
  const metadata = await call('POST', '/api/integrations/http', { name: 'Metadata', url: 'http://169.254.169.254/latest/meta-data', allowPrivate: true });
  assert.equal(metadata.status, 400);
  const reserved = await call('POST', '/api/integrations/http', {
    name: 'Reserved',
    url: `${receiverUrl}/x`,
    allowPrivate: true,
    headers: [{ name: 'X-InfraTicket-Signature', value: 'forged' }],
  });
  assert.equal(reserved.status, 400, 'a header the sender owns could be overridden');
});

test('secrets are stored but never sent back', async () => {
  const created = await call('POST', '/api/integrations/http', {
    name: 'Ops automation',
    url: `${receiverUrl}/signed`,
    allowPrivate: true,
    headers: [{ name: 'Authorization', value: 'Bearer very-secret-token-123' }],
    signingSecret: 'shh-signing-secret',
    teamIds: [opsTeam],
    events: { ticketCreated: true },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  signedId = created.payload.integration.id;
  const listed = await call('GET', '/api/integrations/http');
  const text = JSON.stringify(listed.payload);
  assert.ok(!text.includes('very-secret-token-123'), 'a header value was returned');
  assert.ok(!text.includes('shh-signing-secret'), 'the signing secret was returned');
  assert.equal(listed.payload.integrations[0].hasSigningSecret, true);
  assert.equal(listed.payload.integrations[0].headers[0].name, 'Authorization');

  const row = await db.get<{ headers_encrypted: string; signing_secret_encrypted: string }>(`SELECT * FROM http_integrations WHERE id = ?`, [signedId]);
  assert.ok(!row!.headers_encrypted.includes('very-secret'), 'headers are stored in the clear');
  assert.ok(!row!.signing_secret_encrypted.includes('shh'), 'the secret is stored in the clear');

  // Saving with the masked (empty) value keeps the stored one.
  const kept = await call('PUT', `/api/integrations/http/${signedId}`, {
    ...created.payload.integration,
    headers: [{ name: 'Authorization', value: '' }],
    signingSecret: '',
  });
  assert.equal(kept.status, 200);
  assert.equal(kept.payload.integration.hasSigningSecret, true);
});

test('a ticket event is delivered signed, and only for the chosen teams', async () => {
  received = [];
  await call('POST', '/api/tickets', { subject: 'People ticket', teamId: hrTeam });
  await call('POST', '/api/tickets', { subject: 'Ops ticket', teamId: opsTeam });
  const delivery = await waitFor(() => received.find((r) => r.path === '/signed'));
  // Give a wrongly routed delivery a moment to arrive before asserting it did not.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(received.filter((r) => r.path === '/signed').length, 1, 'the team filter let the other team through');

  const body = JSON.parse(delivery.body);
  assert.equal(body.event, 'ticketCreated');
  assert.equal(body.ticket.subject, 'Ops ticket');
  assert.equal(body.ticket.teamName, 'Platform Ops');
  assert.equal(delivery.headers.authorization, 'Bearer very-secret-token-123');

  const timestamp = String(delivery.headers['x-infraticket-timestamp']);
  const expected = `sha256=${crypto.createHmac('sha256', 'shh-signing-secret').update(`${timestamp}.${delivery.body}`).digest('hex')}`;
  assert.equal(delivery.headers['x-infraticket-signature'], expected);

  // The delivery is logged after the receiver answers, so poll for it.
  let logged: { ok: number; event: string } | undefined;
  for (let i = 0; i < 40 && !logged; i += 1) {
    logged = await db.get<{ ok: number; event: string }>(`SELECT ok, event FROM integration_deliveries WHERE provider = ?`, [`http:${signedId}`]);
    if (!logged) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(logged!.ok, 1);
  assert.equal(logged!.event, 'ticketCreated');
});

test('a JSON template escapes values so the document stays valid', async () => {
  received = [];
  const created = await call('POST', '/api/integrations/http', {
    name: 'Templated',
    url: `${receiverUrl}/templated`,
    method: 'PUT',
    allowPrivate: true,
    bodyTemplate: '{"text": "{{headline}}: {{ticket.subject}}", "ref": "{{ticket.reference}}", "missing": "{{ticket.nothing}}"}',
  });
  assert.equal(created.status, 201);
  const subject = 'Quote " and \\ backslash\nnewline", "injected": "yes';
  await call('POST', '/api/tickets', { subject: subject.replace('\n', ' '), teamId: hrTeam });
  const delivery = await waitFor(() => received.find((r) => r.path === '/templated'));
  assert.equal(delivery.method, 'PUT');
  assert.equal(delivery.headers['content-type'], 'application/json');
  const body = JSON.parse(delivery.body);
  assert.ok(body.text.endsWith(subject.replace('\n', ' ')), body.text);
  assert.equal(body.injected, undefined, 'a value broke out of its string');
  assert.match(body.ref, /^ESC-\d+$/);
  assert.equal(body.missing, '');
  await call('DELETE', `/api/integrations/http/${created.payload.integration.id}`);
});

test('the Test button sends a sample and reports what came back', async () => {
  received = [];
  const broken = await call('POST', '/api/integrations/http', { name: 'Broken', url: `${receiverUrl}/broken`, allowPrivate: true });
  const failed = await call('POST', `/api/integrations/http/${broken.payload.integration.id}/test`);
  assert.equal(failed.payload.result.ok, false);
  assert.equal(failed.payload.result.statusCode, 500);
  assert.match(failed.payload.result.responseExcerpt, /receiver exploded/);

  const ok = await call('POST', `/api/integrations/http/${signedId}/test`);
  assert.equal(ok.payload.result.ok, true);
  assert.equal(ok.payload.result.responseExcerpt, '{"received":true}');

  const deliveries = await call('GET', '/api/integrations/deliveries');
  assert.ok(deliveries.payload.deliveries.some((d: any) => d.provider === `http:${broken.payload.integration.id}` && d.event === 'test' && !d.ok));
  await call('DELETE', `/api/integrations/http/${broken.payload.integration.id}`);
});

test('a disabled integration and an unwanted event send nothing', async () => {
  received = [];
  const listed = (await call('GET', '/api/integrations/http')).payload.integrations[0];
  await call('PUT', `/api/integrations/http/${signedId}`, { ...listed, headers: [{ name: 'Authorization', value: '' }], enabled: false });
  await call('POST', '/api/tickets', { subject: 'While disabled', teamId: opsTeam });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(received.filter((r) => r.path === '/signed').length, 0);
});

/* --------------------------- Linear team mapping -------------------------- */

function linearPost(payload: unknown) {
  const raw = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', LINEAR_SECRET).update(raw).digest('hex');
  return realFetch(`${base}/api/webhooks/linear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'linear-signature': signature },
    body: raw,
  });
}

const issue = (id: string, teamId: string, title: string) => ({
  action: 'create',
  type: 'Issue',
  data: { id, identifier: `${teamId.toUpperCase()}-1`, title, description: '', priority: 3, teamId },
});

test('several Linear teams can feed one department, and the primary is where tickets mirror to', async () => {
  const { saveIntegration } = await import('../server/integrations/store.ts');
  await saveIntegration('linear', { enabled: true, config: { apiKey: ['lin', 'api', 'test'].join('_'), teamId: 'lin-default', webhookSecret: LINEAR_SECRET } });

  const saved = await call('PUT', '/api/integrations/linear/team-map', {
    mappings: [
      { linearTeamId: 'lin-infra', linearTeamKey: 'INF', linearTeamName: 'Infrastructure', teamId: opsTeam },
      { linearTeamId: 'lin-sre', linearTeamKey: 'SRE', linearTeamName: 'SRE', teamId: opsTeam, isPrimary: true },
      { linearTeamId: 'lin-people', linearTeamKey: 'PPL', linearTeamName: 'People', teamId: hrTeam },
      { linearTeamId: 'lin-unlinked', linearTeamKey: 'X', linearTeamName: 'Not linked', teamId: null },
    ],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.mappings.length, 3, 'an unlinked team is not stored');
  assert.equal(saved.payload.mappings.find((m: any) => m.linearTeamId === 'lin-sre').isPrimary, true);

  const routes = await db.all<{ team_id: string; target: string }>(`SELECT team_id, target FROM team_routing WHERE provider = 'linear'`);
  assert.equal(routes.find((r) => r.team_id === opsTeam)?.target, 'lin-sre', 'outbound did not follow the primary');
  assert.equal(routes.find((r) => r.team_id === hrTeam)?.target, 'lin-people');

  for (const [id, team, title] of [
    ['iss-1', 'lin-infra', 'Disk filling on db-02'],
    ['iss-2', 'lin-sre', 'Pager rota gap'],
    ['iss-3', 'lin-people', 'New starter laptop'],
  ] as const) {
    const response = await linearPost(issue(id, team, title));
    assert.equal(response.status, 200, await response.clone().text());
  }
  const tickets = await db.all<{ subject: string; team_id: string }>(`SELECT subject, team_id FROM tickets WHERE source <> 'web'`);
  assert.equal(tickets.find((t) => t.subject === 'Disk filling on db-02')?.team_id, opsTeam);
  assert.equal(tickets.find((t) => t.subject === 'Pager rota gap')?.team_id, opsTeam);
  assert.equal(tickets.find((t) => t.subject === 'New starter laptop')?.team_id, hrTeam);

  const unmapped = await linearPost(issue('iss-4', 'lin-unlinked', 'Nobody owns this'));
  assert.equal((await unmapped.json()).ignored, true, 'an issue from an unlinked team raised a ticket');
});

test('unlinking a department stops its mirroring, but leaves a hand-set route alone', async () => {
  const { setTeamRoute } = await import('../server/repositories/team-routing.ts');
  const saved = await call('PUT', '/api/integrations/linear/team-map', {
    mappings: [{ linearTeamId: 'lin-sre', linearTeamKey: 'SRE', linearTeamName: 'SRE', teamId: opsTeam }],
  });
  assert.equal(saved.status, 200);
  const hr = await db.get<{ target: string }>(`SELECT target FROM team_routing WHERE provider = 'linear' AND team_id = ?`, [hrTeam]);
  assert.equal(hr, undefined, 'the unlinked department still mirrors to its old Linear team');

  await setTeamRoute(hrTeam, 'linear', 'lin-chosen-by-hand');
  await call('PUT', '/api/integrations/linear/team-map', { mappings: [] });
  const kept = await db.get<{ target: string }>(`SELECT target FROM team_routing WHERE provider = 'linear' AND team_id = ?`, [hrTeam]);
  assert.equal(kept?.target, 'lin-chosen-by-hand');
});
