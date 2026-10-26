/**
 * 3.0: department connections (an API, the department's own channels and
 * webhooks, kept from other departments) and alert sources that poll an API
 * connection - Jenkins job colours here. Over real HTTP against a throwaway
 * SQLite database, with the outside world stubbed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'connections-polling.db';
process.env.SESSION_SECRET = 'c'.repeat(48);
process.env.SECRET_KEY = 'd'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const wipe = () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `connections-polling.db${suffix}`), { force: true });
};

const realFetch = globalThis.fetch;
const outbound: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
let jenkinsJobs: Array<{ name: string; color: string; url: string }> = [];
let inbox: Array<Record<string, unknown>> = [];
const graphCalls: Array<{ method: string; url: string; body: any }> = [];

let server: http.Server;
let base: string;
const cookies: Record<string, string> = {};
let db: typeof import('../server/db/index.ts').db;
let finance: string;
let hr: string;

async function call(who: string, method: string, url: string, body?: unknown) {
  const response = await realFetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: cookies[who] },
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

async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
}

before(async () => {
  wipe();
  const dist = path.resolve(import.meta.dirname, '../dist/client');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input.url ?? input);
    if (url.startsWith('https://login.microsoftonline.com/')) return Response.json({ access_token: 'graph-token', expires_in: 3600 });
    if (url.startsWith('https://graph.microsoft.com/')) {
      const method = String(init?.method ?? 'GET');
      graphCalls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'GET' && url.includes('/messages?')) return Response.json({ value: inbox });
      if (method === 'GET') return Response.json({ displayName: 'Inbox', unreadItemCount: inbox.length });
      return new Response(null, { status: method === 'POST' ? 202 : 200 });
    }
    if (url.includes('.invalid')) {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
      let body: any = init?.body;
      try {
        body = body ? JSON.parse(String(body)) : body;
      } catch {
        // not JSON
      }
      outbound.push({ url, headers, body });
      if (url.startsWith('https://jenkins.invalid/')) return Response.json({ jobs: jenkinsJobs });
      if (url.startsWith('https://api.invalid/')) return Response.json({ status: 'ok', queue: 3 });
      return new Response('1', { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();
  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword('Adm1n-Password!');
  const now = new Date().toISOString();
  for (const [id, email, role] of [
    ['u-admin', 'admin@acme.test', 'admin'],
    ['u-fin', 'fin@acme.test', 'agent'],
    ['u-hr', 'hr@acme.test', 'agent'],
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
  for (const who of ['admin', 'fin', 'hr']) {
    const response = await realFetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: `${who}@acme.test`, password: 'Adm1n-Password!' }),
    });
    cookies[who] = response.headers.get('set-cookie')!.split(';')[0];
  }
  finance = (await call('admin', 'POST', '/api/teams', { name: 'Finance', key: 'FIN' })).payload.team.id;
  hr = (await call('admin', 'POST', '/api/teams', { name: 'HR', key: 'HR' })).payload.team.id;
  // The Finance agent manages Finance; the HR agent is in HR only.
  await db.run(`INSERT INTO team_members (team_id, user_id, is_lead) VALUES (?, 'u-fin', 1), (?, 'u-hr', 0)`, [finance, hr]);
});

after(async () => {
  globalThis.fetch = realFetch;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db.close();
  wipe();
});

let apiConnection: string;

test("a department's API connection: its own people use it, other departments never see it, secrets stay hidden", async () => {
  const created = await call('fin', 'POST', '/api/connections', {
    kind: 'api',
    teamId: finance,
    name: 'Payments API',
    config: { baseUrl: 'https://api.invalid/v1', auth: { type: 'bearer', token: 'sk_live_supersecret' }, headers: { 'X-Api-Key': 'key-1234567890' } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  apiConnection = created.payload.connection.id;
  const shown = JSON.stringify(created.payload);
  assert.doesNotMatch(shown, /sk_live_supersecret|key-1234567890/, 'a secret went back to the browser');
  assert.equal(created.payload.connection.config.auth.secretSet, true);

  assert.equal((await call('hr', 'POST', '/api/connections', { kind: 'api', teamId: finance, name: 'Sneaky', config: { baseUrl: 'https://api.invalid' } })).status, 403);
  assert.equal((await call('hr', 'GET', '/api/connections')).payload.connections.length, 0, "HR can see Finance's connection");
  assert.equal((await call('hr', 'POST', `/api/connections/${apiConnection}/try`, { path: '/status' })).status, 404);
  assert.equal((await call('fin', 'POST', '/api/connections', { kind: 'api', teamId: null, name: 'Shared', config: { baseUrl: 'https://api.invalid' } })).status, 403, 'a department manager added a shared connection');

  const tried = await call('fin', 'POST', `/api/connections/${apiConnection}/try`, { path: '/status', query: { verbose: '1' } });
  assert.equal(tried.status, 200, JSON.stringify(tried.payload));
  assert.equal(tried.payload.result.json.queue, 3);
  const sent = outbound.at(-1)!;
  assert.equal(sent.url, 'https://api.invalid/v1/status?verbose=1');
  assert.equal(sent.headers.authorization, 'Bearer sk_live_supersecret');
  assert.equal(sent.headers['x-api-key'], 'key-1234567890');
  assert.equal((await call('fin', 'POST', `/api/connections/${apiConnection}/try`, { path: 'https://elsewhere.invalid/' })).status, 400, 'a path swapped the host');

  // Saving again with the masked values keeps the real ones.
  const listed = (await call('fin', 'GET', '/api/connections')).payload.connections[0];
  const resaved = await call('fin', 'PUT', `/api/connections/${apiConnection}`, { ...listed, config: { ...listed.config, auth: { type: 'bearer', token: '' } } });
  assert.equal(resaved.status, 200, JSON.stringify(resaved.payload));
  await call('fin', 'POST', `/api/connections/${apiConnection}/try`, { path: '/status' });
  assert.equal(outbound.at(-1)!.headers.authorization, 'Bearer sk_live_supersecret');
  assert.equal(outbound.at(-1)!.headers['x-api-key'], 'key-1234567890');
});

test("a department's own Teams channel gets its tickets even without the organisation's Teams integration", async () => {
  const created = await call('fin', 'POST', '/api/connections', { kind: 'teams_webhook', teamId: finance, name: 'Finance channel', config: { url: 'https://finance.webhook.invalid/workflows/1' } });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.doesNotMatch(JSON.stringify(created.payload), /workflows\/1/, 'the webhook URL went back to the browser');
  const before = outbound.length;
  await call('fin', 'POST', '/api/tickets', { subject: 'Invoice run failed', teamId: finance });
  await until(() => outbound.slice(before).some((entry) => entry.url === 'https://finance.webhook.invalid/workflows/1'), 'the Teams post');
  await call('hr', 'POST', '/api/tickets', { subject: 'Leave query', teamId: hr });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(outbound.slice(before).filter((entry) => entry.url.startsWith('https://finance.webhook.invalid')).length, 1, "HR's ticket went to Finance's channel");
});

test('an API monitor can call through a connection', async () => {
  const tried = await call('admin', 'POST', '/api/ops/monitors/try', { target: 'https://api.invalid/v1/health', config: { connectionId: apiConnection, connectionPath: '/health', method: 'GET' } });
  assert.equal(tried.status, 200, JSON.stringify(tried.payload));
  assert.equal(outbound.at(-1)!.url, 'https://api.invalid/v1/health');
  assert.equal(outbound.at(-1)!.headers.authorization, 'Bearer sk_live_supersecret');
});

test('a Jenkins source that polls: a red job raises an incident, and green again resolves it', async () => {
  const jenkins = (await call('admin', 'POST', '/api/connections', { kind: 'api', teamId: null, name: 'Jenkins', config: { baseUrl: 'https://jenkins.invalid', auth: { type: 'basic', username: 'bot', password: 'api-token' } } })).payload.connection;
  const poll = { enabled: true, connectionId: jenkins.id, path: '/api/json?tree=jobs[name,url,color]', itemsPath: 'jobs', intervalSecs: 120 };
  jenkinsJobs = [
    { name: 'deploy-prod', color: 'red', url: 'https://jenkins.invalid/job/deploy-prod/' },
    { name: 'nightly', color: 'blue', url: 'https://jenkins.invalid/job/nightly/' },
    { name: 'old', color: 'disabled', url: 'https://jenkins.invalid/job/old/' },
  ];

  const preview = await call('admin', 'POST', '/api/ops/alert-sources/poll-preview', { kind: 'jenkins', defaultSeverity: 'sev2', poll });
  assert.equal(preview.status, 200, JSON.stringify(preview.payload));
  assert.equal(preview.payload.error, null);
  assert.deepEqual(preview.payload.signals.map((signal: any) => [signal.dedupKey, signal.status]), [
    ['jenkins:deploy-prod', 'firing'],
    ['jenkins:nightly', 'resolved'],
  ]);
  assert.equal(outbound.at(-1)!.headers.authorization, `Basic ${Buffer.from('bot:api-token').toString('base64')}`);
  assert.equal(await db.get(`SELECT id FROM alerts`), undefined, 'a preview raised an alert');

  const source = (await call('admin', 'POST', '/api/ops/alert-sources', { name: 'Jenkins jobs', kind: 'jenkins', teamId: finance, defaultSeverity: 'sev2', poll })).payload.source;
  assert.equal(source.poll.intervalSecs, 120);
  const first = await call('admin', 'POST', `/api/ops/alert-sources/${source.id}/poll`);
  assert.equal(first.status, 200, JSON.stringify(first.payload));
  assert.deepEqual(first.payload.results.map((result: any) => result.action), ['created'], 'the green job should not raise or resolve anything');
  const ticketId = first.payload.results[0].ticketId;

  // Still red: nothing new.
  assert.equal((await call('admin', 'POST', `/api/ops/alert-sources/${source.id}/poll`)).payload.results.length, 0);

  // The scheduler only polls a source once its interval has passed.
  const { pollDueSources } = await import('../server/ops/source-poll.ts');
  assert.equal(await pollDueSources(Date.now()), 0);

  jenkinsJobs[0].color = 'blue_anime';
  assert.equal(await pollDueSources(Date.now() + 121_000), 1);
  const alert = await db.get<{ status: string }>(`SELECT status FROM alerts WHERE dedup_key = 'jenkins:deploy-prod'`);
  assert.equal(alert?.status, 'resolved');
  const ticket = await db.get<{ status: string }>(`SELECT status FROM tickets WHERE id = ?`, [ticketId]);
  assert.equal(ticket?.status, 'resolved', 'the incident did not resolve when the job went green');
});

test("a department's Outlook mailbox: new mail raises its tickets, replies join them, routes send some elsewhere", async () => {
  const created = await call('fin', 'POST', '/api/connections', {
    kind: 'mailbox',
    teamId: finance,
    name: 'Finance inbox',
    config: {
      tenantId: 'acme.onmicrosoft.com',
      clientId: '00000000-1111-2222-3333-444444444444',
      clientSecret: 'graph-client-secret',
      mailbox: 'finance@acme.test',
      acknowledge: true,
      routes: [{ field: 'from', contains: '@supplier.invalid', teamId: hr }],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.doesNotMatch(JSON.stringify(created.payload), /graph-client-secret/);
  const id = created.payload.connection.id;
  assert.match((await call('fin', 'POST', `/api/connections/${id}/test`)).payload.message, /Connected to finance@acme.test/);

  const message = (n: number, from: string, subject: string, conversationId: string, at: string) => ({
    id: `msg-${n}`,
    subject,
    conversationId,
    receivedDateTime: at,
    from: { emailAddress: { name: from.split('@')[0], address: from } },
    body: { contentType: 'html', content: `<p>Body ${n}</p><script>alert(1)</script>` },
  });
  inbox = [
    message(2, 'bob@supplier.invalid', 'Statement for October', 'conv-b', '2026-10-26T08:05:00Z'),
    message(1, 'fin@acme.test', 'Invoice 77 overdue', 'conv-a', '2026-10-26T08:00:00Z'),
    message(9, 'finance@acme.test', 'Re: your ticket', 'conv-x', '2026-10-26T08:06:00Z'),
  ];
  const first = await call('fin', 'POST', `/api/connections/${id}/check-mail`);
  assert.equal(first.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.created.length, 2);
  assert.equal(first.payload.skipped, 1, 'mail from the mailbox itself raised a ticket');

  const tickets = await db.all<{ id: string; subject: string; team_id: string; requester_id: string | null; source: string; description: string }>(
    `SELECT id, subject, team_id, requester_id, source, description FROM tickets WHERE source = 'email' ORDER BY number`,
  );
  assert.deepEqual(tickets.map((t) => t.subject), ['Invoice 77 overdue', 'Statement for October'], 'not raised oldest first');
  assert.equal(tickets[0].team_id, finance);
  assert.equal(tickets[0].requester_id, 'u-fin', 'a known sender was not made the requester');
  assert.equal(tickets[1].team_id, hr, 'the supplier route was not followed');
  assert.match(tickets[1].description, /bob@supplier\.invalid/);
  assert.doesNotMatch(tickets[1].description, /<script/);
  assert.ok(graphCalls.some((c) => c.method === 'POST' && c.url.endsWith('/messages/msg-1/reply') && /this is now ticket [A-Z]+-\d+/.test(c.body.comment)), 'the sender was not told their ticket number');
  assert.ok(graphCalls.some((c) => c.method === 'PATCH' && c.url.endsWith('/messages/msg-1') && c.body.isRead === true));

  // Mail.Read only: the same mail comes back unread. Nothing is raised twice, and the reply joins its ticket.
  inbox = [...inbox, message(3, 'fin@acme.test', 'RE: Invoice 77 overdue', 'conv-a', '2026-10-26T09:00:00Z')];
  const second = await call('fin', 'POST', `/api/connections/${id}/check-mail`);
  assert.deepEqual(second.payload.created, []);
  assert.equal(second.payload.commented.length, 1);
  const comments = await db.all<{ ticket_id: string; author_id: string | null; body: string }>(`SELECT ticket_id, author_id, body FROM ticket_comments WHERE body LIKE '%Body 3%'`);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].ticket_id, tickets[0].id);
  assert.equal(comments[0].author_id, 'u-fin');

  // A new conversation that names the ticket in its subject joins it too.
  const reference = (await call('admin', 'GET', `/api/tickets/${tickets[1].id}`)).payload.ticket.reference;
  inbox = [message(4, 'bob@supplier.invalid', `Following up on ${reference}`, 'conv-new', '2026-10-26T10:00:00Z')];
  const third = await call('fin', 'POST', `/api/connections/${id}/check-mail`);
  assert.deepEqual(third.payload.commented, [reference]);

  assert.equal((await call('hr', 'POST', `/api/connections/${id}/check-mail`)).status, 404, "HR could reach Finance's mailbox");
});
