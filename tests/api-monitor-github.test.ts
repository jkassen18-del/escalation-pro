/**
 * API monitoring (request builder, checks, secrets, redirect guard), the
 * GitHub integration and alert source, and fixes from the code review - over
 * real HTTP against a throwaway SQLite database. GitHub's API is faked at
 * fetch; the monitored API is a real local server.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'api-monitor-github.db';
process.env.SESSION_SECRET = 'g'.repeat(48);
process.env.SECRET_KEY = 'h'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const wipe = () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `api-monitor-github.db${suffix}`), { force: true });
};

const { readPath } = await import('../server/ops/api-probe.ts');
const { canonicalHost, assertOutboundUrl, assertSafeWebhookUrl } = await import('../server/integrations/url-guard.ts');
const { normalise } = await import('../server/ops/sources.ts');
const { ticketReferences } = await import('../server/integrations/github.ts');

let server: http.Server;
let api: http.Server;
let base: string;
let apiBase: string;
const cookies: Record<string, string> = {};
let db: typeof import('../server/db/index.ts').db;
let financeTeam: string;
let hrTeam: string;
const realFetch = globalThis.fetch;
const githubCalls: Array<{ method: string; url: string; body: any }> = [];
const SECRET = 'whsec-test-0123456789';

async function call(who: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: cookies[who] ?? '', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
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

function signed(event: string, payload: unknown) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  return call('none', 'POST', '/api/webhooks/github', raw, { 'x-github-event': event, 'x-hub-signature-256': signature });
}

before(async () => {
  wipe();
  const dist = path.resolve(import.meta.dirname, '../dist/client');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }

  // The API being monitored.
  api = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/health') {
      if (req.headers.authorization !== 'Bearer s3cret') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorised' }));
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-version': '4.2' });
      return res.end(JSON.stringify({ status: 'ok', region: url.searchParams.get('region'), queue: { depth: 7 }, jobs: [{ id: 1 }, { id: 2 }] }));
    }
    if (url.pathname === '/echo' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: JSON.parse(body || '{}'), type: req.headers['content-type'] }));
      });
      return;
    }
    if (url.pathname === '/to-metadata') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', () => resolve()));
  apiBase = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('https://api.github.com/')) {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      githubCalls.push({ method: init?.method ?? 'GET', url, body });
      if (url.endsWith('/user')) return Response.json({ login: 'infraticket-bot' });
      if (url.includes('/user/repos')) {
        return Response.json([
          { full_name: 'acme/finance-app', private: true, archived: false, has_issues: true },
          { full_name: 'acme/hr-portal', private: false, archived: false, has_issues: true },
          { full_name: 'acme/old', private: false, archived: true, has_issues: true },
        ]);
      }
      if (/\/repos\/[^/]+\/[^/]+\/issues$/.test(new URL(url).pathname)) return Response.json({ number: 42, html_url: 'https://github.com/acme/finance-app/issues/42' }, { status: 201 });
      if (url.includes('/comments')) return Response.json({ id: 1 }, { status: 201 });
      return Response.json({ full_name: 'x' });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();
  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword('Adm1n-Password!');
  const now = new Date().toISOString();
  for (const [id, role] of [
    ['admin', 'admin'],
    ['agent', 'agent'],
  ]) {
    await db.run(
      'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, `${id}@acme.test`, id, id, hash, salt, role, 'active', '#9a7b2f', 0, now, now],
    );
  }
  const { saveIntegration } = await import('../server/integrations/store.ts');
  await saveIntegration('github', { enabled: true, config: { token: 'github_pat_test', webhookSecret: SECRET, ticketLabel: 'support', login: 'infraticket-bot' } });

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const who of ['admin', 'agent']) {
    const login = await realFetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: `${who}@acme.test`, password: 'Adm1n-Password!' }),
    });
    cookies[who] = login.headers.get('set-cookie')!.split(';')[0];
  }
  financeTeam = (await call('admin', 'POST', '/api/teams', { name: 'Finance', key: 'FIN' })).payload.team.id;
  hrTeam = (await call('admin', 'POST', '/api/teams', { name: 'HR', key: 'HR' })).payload.team.id;
});

after(async () => {
  globalThis.fetch = realFetch;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  api?.closeAllConnections();
  await new Promise<void>((resolve) => api?.close(() => resolve()));
  await db.close();
  wipe();
});

/* --------------------------------- API monitor --------------------------------- */

test('paths read nested values, array items and lengths', () => {
  const value = { data: { items: [{ status: 'up' }, { status: 'down' }] }, 'odd key': 1 };
  assert.deepEqual(readPath(value, 'data.items[1].status'), { found: true, value: 'down' });
  assert.deepEqual(readPath(value, '$.data.items.length'), { found: true, value: 2 });
  assert.deepEqual(readPath(value, 'data.items[-1].status'), { found: true, value: 'down' });
  assert.deepEqual(readPath(value, '["odd key"]'), { found: true, value: 1 });
  assert.equal(readPath(value, 'data.missing.x').found, false);
});

test('"Send request" calls the API with auth and query, and judges each picked value', async () => {
  const tried = await call('admin', 'POST', '/api/ops/monitors/try', {
    target: `${apiBase}/health`,
    config: {
      method: 'GET',
      query: { region: 'eu' },
      auth: { type: 'bearer', token: 's3cret' },
      assertions: [
        { source: 'json', path: 'status', op: 'eq', value: 'ok' },
        { source: 'json', path: 'queue.depth', op: 'lt', value: '5' },
        { source: 'json', path: 'jobs.length', op: 'gte', value: '2' },
        { source: 'header', path: 'x-version', op: 'eq', value: '4.2' },
        { source: 'latency', op: 'lt', value: '5000' },
      ],
    },
  });
  assert.equal(tried.status, 200, JSON.stringify(tried.payload));
  const result = tried.payload.result;
  assert.equal(result.status, 200);
  assert.equal(result.json.region, 'eu', 'query parameters are sent');
  assert.deepEqual(result.assertions.map((a: { ok: boolean }) => a.ok), [true, false, true, true, true]);
  assert.equal(result.ok, false);
  assert.match(result.message, /queue\.depth is less than 5, but it was 7/);

  const unauth = await call('admin', 'POST', '/api/ops/monitors/try', { target: `${apiBase}/health`, config: {} });
  assert.equal(unauth.payload.result.status, 401);
  assert.equal(unauth.payload.result.ok, false, 'a 401 is outside the default 200-399');

  const posted = await call('admin', 'POST', '/api/ops/monitors/try', {
    target: `${apiBase}/echo`,
    config: { method: 'POST', bodyType: 'json', body: '{"deep":true}', expectedStatus: '201' },
  });
  assert.equal(posted.payload.result.ok, true);
  assert.deepEqual(posted.payload.result.json, { received: { deep: true }, type: 'application/json' });

  assert.equal((await call('agent', 'POST', '/api/ops/monitors/try', { target: `${apiBase}/health`, config: {} })).status, 403);
});

test('credentials are encrypted, never returned, and kept when the editor leaves them blank', async () => {
  const created = await call('admin', 'POST', '/api/ops/monitors', {
    name: 'Health API',
    kind: 'http',
    target: `${apiBase}/health`,
    intervalSecs: 60,
    config: { auth: { type: 'bearer', token: 's3cret' }, assertions: [{ source: 'json', path: 'status', op: 'eq', value: 'ok' }] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const monitor = created.payload.monitor;
  assert.equal(monitor.config.auth.token, undefined);
  assert.equal(monitor.config.auth.secretSet, true);
  const stored = await db.get<{ config: string }>(`SELECT config FROM monitors WHERE id = ?`, [monitor.id]);
  assert.ok(!stored!.config.includes('s3cret'), 'not stored in the clear');

  // Saved again from the editor, which never had the token: it is kept.
  const updated = await call('admin', 'PUT', `/api/ops/monitors/${monitor.id}`, { ...monitor, config: { ...monitor.config, auth: { type: 'bearer' } } });
  assert.equal(updated.status, 200, JSON.stringify(updated.payload));
  const checked = await call('admin', 'POST', `/api/ops/monitors/${monitor.id}/check`);
  assert.equal(checked.payload.monitor.state === 'up' || checked.payload.checks[0].ok, true, JSON.stringify(checked.payload.checks?.[0]));

  // "Send request" for a saved monitor uses its stored token too.
  const tried = await call('admin', 'POST', '/api/ops/monitors/try', { target: `${apiBase}/health`, monitorId: monitor.id, config: { auth: { type: 'bearer' } } });
  assert.equal(tried.payload.result.status, 200);
});

test('a redirect to a metadata address is refused, and so is a pattern that can hang', async () => {
  const tried = await call('admin', 'POST', '/api/ops/monitors/try', { target: `${apiBase}/to-metadata`, config: {} });
  assert.equal(tried.payload.result.ok, false);
  assert.match(tried.payload.result.message, /link-local or cloud metadata/);

  const bad = await call('admin', 'POST', '/api/ops/monitors/try', {
    target: `${apiBase}/health`,
    config: { assertions: [{ source: 'body', op: 'matches', value: '(a+)+$' }] },
  });
  assert.equal(bad.status, 400);
});

/* --------------------------------- URL guard --------------------------------- */

test('the URL guard sees through mapped IPv6 and trailing dots', () => {
  assert.equal(canonicalHost('[::ffff:7f00:1]'), '127.0.0.1');
  assert.equal(canonicalHost('metadata.google.internal.'), 'metadata.google.internal');
  assert.throws(() => assertSafeWebhookUrl('https://[::ffff:169.254.169.254]/', 'u'));
  assert.throws(() => assertSafeWebhookUrl('https://[::ffff:127.0.0.1]/', 'u'));
  assert.throws(() => assertOutboundUrl('https://metadata.google.internal./', 'u', { allowPrivate: true }));
  assert.equal(assertOutboundUrl('http://10.0.0.5/health', 'u', { allowPrivate: true }), 'http://10.0.0.5/health');
});

/* ---------------------------------- GitHub ---------------------------------- */

test('GitHub Actions: a failed run on the default branch fires, a PR branch is ignored, a green run resolves', () => {
  const source = { kind: 'github', defaultSeverity: 'sev2' } as never;
  const run = (branch: string, conclusion: string) => ({
    action: 'completed',
    repository: { full_name: 'acme/api', default_branch: 'main' },
    workflow_run: { name: 'Deploy', head_branch: branch, conclusion, html_url: 'https://github.com/acme/api/actions/runs/1' },
  });
  const [failed] = normalise(source, run('main', 'failure'));
  assert.equal(failed.status, 'firing');
  assert.match(failed.title, /Deploy failure on acme\/api@main/);
  assert.deepEqual(normalise(source, run('feature/x', 'failure')), []);
  const [green] = normalise(source, run('main', 'success'));
  assert.equal(green.status, 'resolved');
  assert.equal(green.dedupKey, failed.dedupKey);
  assert.deepEqual(normalise(source, run('main', 'cancelled')), []);

  const [secret] = normalise(source, { action: 'created', repository: { full_name: 'acme/api' }, alert: { number: 3, secret_type: 'aws_key', secret_type_display_name: 'AWS key' } });
  assert.equal(secret.severity, 'sev1');
  assert.deepEqual(normalise(source, { zen: 'Keep it logically awesome.', hook_id: 1 }), [], 'ping says nothing');
});

test('ticket references are found in PR titles, bodies and branches', () => {
  assert.deepEqual(ticketReferences('ESC', 'Fix ESC-1042', 'also esc-7', 'fix/ESC-1042-payouts'), [1042, 7]);
});

test('GitHub: departments map to repositories, and a ticket becomes an issue there', async () => {
  const view = await call('admin', 'GET', '/api/integrations/routing/github');
  assert.equal(view.status, 200, JSON.stringify(view.payload));
  assert.deepEqual(view.payload.destinations.map((d: { id: string }) => d.id), ['acme/finance-app', 'acme/hr-portal'], 'archived repos are left out');
  assert.equal((await call('admin', 'PUT', '/api/integrations/routing/github', { departments: [{ teamId: financeTeam, target: 'not a repo' }] })).status, 400);
  const saved = await call('admin', 'PUT', '/api/integrations/routing/github', { departments: [{ teamId: financeTeam, target: 'acme/finance-app' }] });
  assert.equal(saved.status, 200);

  const ticket = (await call('admin', 'POST', '/api/tickets', { subject: 'Payout export broken', teamId: financeTeam, description: 'CSV has no header' })).payload.ticket;
  const targets = await call('admin', 'GET', `/api/tickets/${ticket.id}/github-targets`);
  assert.equal(targets.payload.suggested, 'acme/finance-app');

  githubCalls.length = 0;
  const pushed = await call('admin', 'POST', `/api/tickets/${ticket.id}/push-to-github`, {});
  assert.equal(pushed.status, 200, JSON.stringify(pushed.payload));
  const create = githubCalls.find((c) => c.method === 'POST' && c.url.endsWith('/repos/acme/finance-app/issues'))!;
  assert.match(create.body.title, /Payout export broken/);
  assert.match(create.body.body, /CSV has no header/);
  assert.ok(pushed.payload.ticket.links.some((link: { provider: string; externalId: string }) => link.provider === 'github' && link.externalId === 'acme/finance-app#42'));

  // A public reply goes onto the issue.
  githubCalls.length = 0;
  await call('admin', 'POST', `/api/tickets/${ticket.id}/comments`, { body: 'Looking now', isInternal: false });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(githubCalls.some((c) => c.url.endsWith('/issues/42/comments') && c.body.body.includes('Looking now')));
});

test('GitHub webhooks: signed only; closing resolves, comments come back, PRs link, labelled issues raise tickets', async () => {
  const ticket = (await call('admin', 'GET', '/api/tickets?limit=1')).payload.tickets[0];
  const unsigned = await call('none', 'POST', '/api/webhooks/github', { action: 'closed' }, { 'x-github-event': 'issues', 'x-hub-signature-256': 'sha256=00' });
  assert.equal(unsigned.status, 401);

  const comment = await signed('issue_comment', {
    action: 'created',
    repository: { full_name: 'acme/finance-app' },
    sender: { login: 'dev-sam' },
    issue: { number: 42 },
    comment: { id: 900, body: 'Root cause found', user: { login: 'dev-sam', type: 'User' } },
  });
  assert.equal(comment.status, 200, JSON.stringify(comment.payload));
  const echo = await signed('issue_comment', {
    action: 'created',
    repository: { full_name: 'acme/finance-app' },
    sender: { login: 'someone' },
    issue: { number: 42 },
    comment: { id: 901, body: 'mine <!-- infraticket -->', user: { login: 'someone', type: 'User' } },
  });
  assert.equal(echo.payload.ignored, true, 'our own comment is not recorded twice');

  const pr = await signed('pull_request', {
    action: 'opened',
    repository: { full_name: 'acme/finance-app' },
    sender: { login: 'dev-sam' },
    pull_request: { number: 7, title: `Fix ${ticket.reference}`, body: '', html_url: 'https://github.com/acme/finance-app/pull/7', head: { ref: 'fix' }, user: { login: 'dev-sam' } },
  });
  assert.deepEqual(pr.payload.linked, [ticket.reference]);

  const closed = await signed('issues', { action: 'closed', repository: { full_name: 'acme/finance-app' }, sender: { login: 'dev-sam' }, issue: { number: 42 } });
  assert.equal(closed.payload.status, 'resolved');
  const detail = (await call('admin', 'GET', `/api/tickets/${ticket.id}`)).payload.ticket;
  assert.equal(detail.status, 'resolved');
  assert.ok(detail.comments.some((c: { body: string }) => c.body.includes('Root cause found')));
  assert.ok(detail.comments.some((c: { body: string }) => c.body.includes('Pull request acme/finance-app#7')));

  const raised = await signed('issues', {
    action: 'opened',
    repository: { full_name: 'acme/finance-app' },
    sender: { login: 'customer' },
    issue: { number: 50, title: 'Cannot log in', body: 'since 9am', html_url: 'https://github.com/acme/finance-app/issues/50', user: { login: 'customer' }, labels: [{ name: 'Support' }] },
  });
  assert.equal(raised.status, 200, JSON.stringify(raised.payload));
  const created = (await call('admin', 'GET', '/api/tickets?limit=1&sort=newest')).payload.tickets[0];
  assert.equal(created.reference, raised.payload.ticket);
  assert.equal(created.teamId, financeTeam, 'the repository\'s department');
  assert.equal(created.source, 'github');
});

/* ------------------------------- Review fixes ------------------------------- */

test('a ticket assigned to someone who does not exist is refused cleanly', async () => {
  const unknown = await call('admin', 'POST', '/api/tickets', { subject: 'x', teamId: hrTeam, assigneeId: 'nobody-here' });
  assert.equal(unknown.status, 400, 'an unknown assignee is a 400, not a database error');
});

test('department routing is not readable by everyone, since a Teams destination is a signed URL', async () => {
  assert.equal((await call('agent', 'GET', `/api/teams/${financeTeam}/routing`)).status, 403);
  assert.equal((await call('admin', 'GET', `/api/teams/${financeTeam}/routing`)).status, 200);
  const internal = await call('admin', 'PUT', `/api/teams/${financeTeam}/routing`, { routes: [{ provider: 'msteams', target: 'https://10.0.0.5/hook' }] });
  assert.equal(internal.status, 400, 'a private address is refused as a destination');
});
