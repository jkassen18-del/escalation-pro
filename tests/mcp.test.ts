/**
 * The MCP connector: Claude (and Copilot Studio, VS Code...) reading and acting
 * on InfraTicket as the person who connected it. Driven with the MCP SDK's own
 * client over real HTTP, against a throwaway SQLite database.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'mcp.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.SECRET_KEY = 'c'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
process.env.MCP_RATE_LIMIT_PER_MIN = '40';
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;
delete process.env.APP_URL;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `mcp.db${suffix}`), { force: true });
}

let server: http.Server;
let base: string;
let db: typeof import('../server/db/index.ts').db;
const cookies: Record<string, string> = {};
let teamA: string;
let teamB: string;
let ticketA: { id: string; reference: string };
let ticketB: { id: string; reference: string };

async function call(who: string, method: string, url: string, body?: unknown) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: cookies[who] ?? '' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload: any = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // empty or HTML
  }
  return { status: response.status, payload, headers: response.headers };
}

/** A raw JSON-RPC POST, for the cases an SDK client would refuse to make. */
async function rpc(headers: Record<string, string>, method = 'ping', params: unknown = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  let payload: any = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // SSE or empty
  }
  return { status: response.status, payload, headers: response.headers };
}

async function connect(headers: Record<string, string>) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } });
  await client.connect(transport);
  return client;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function newToken(who: string, scope: 'read' | 'read_write', expiresInDays: number | null = 30) {
  const created = await call(who, 'POST', '/api/connector/tokens', { name: `${who} ${scope}`, scope, expiresInDays });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  return created.payload as { token: string; record: { id: string } };
}

/** Tool results are JSON text; refusals come back as isError. */
async function tool(client: Awaited<ReturnType<typeof connect>>, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
  const text = result.content[0]?.text ?? '';
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    // a refusal message
  }
  return { isError: Boolean(result.isError), data, text };
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
  const { hash, salt } = hashPassword('Pass-word-123!');
  const now = new Date().toISOString();
  for (const [id, role] of [
    ['admin', 'admin'],
    ['agent', 'agent'],
    ['viewer', 'viewer'],
    ['other', 'agent'],
  ]) {
    await db.run(
      'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, `${id}@acme.test`, id, `Person ${id}`, hash, salt, role, 'active', '#9a7b2f', 0, now, now],
    );
  }

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  for (const who of ['admin', 'agent', 'viewer', 'other']) {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: `${who}@acme.test`, password: 'Pass-word-123!' }),
    });
    assert.equal(login.status, 200, `login ${who}`);
    cookies[who] = login.headers.get('set-cookie')!.split(';')[0];
  }

  teamA = (await call('admin', 'POST', '/api/teams', { name: 'Platform', key: 'PLT', memberIds: ['agent', 'viewer'] })).payload.team.id;
  teamB = (await call('admin', 'POST', '/api/teams', { name: 'Finance', key: 'FIN', memberIds: ['other'] })).payload.team.id;
  // Sessions cache nothing, but re-login keeps the test independent of that.
  const a = await call('admin', 'POST', '/api/tickets', { subject: 'Database is slow', description: 'Queries take 10s', teamId: teamA, priority: 'high' });
  ticketA = a.payload.ticket;
  await call('admin', 'POST', `/api/tickets/${ticketA.id}/comments`, { body: 'Looking at the replica now', isInternal: false });
  await call('admin', 'POST', `/api/tickets/${ticketA.id}/comments`, { body: 'SECRET internal: vendor owes us', isInternal: true });
  const b = await call('admin', 'POST', '/api/tickets', { subject: 'Invoice question', description: 'Payroll', teamId: teamB });
  ticketB = b.payload.ticket;
});

after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db.close();
  wipe();
});

/* ------------------------------ Discovery --------------------------------- */

test('an unauthenticated /mcp call gets 401 pointing at the protected-resource metadata', async () => {
  const res = await rpc({}, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  assert.equal(res.status, 401);
  const header = res.headers.get('www-authenticate') ?? '';
  assert.match(header, new RegExp(`^Bearer resource_metadata="${base}/\\.well-known/oauth-protected-resource"`));

  const prm = await fetch(`${base}/.well-known/oauth-protected-resource`);
  assert.equal(prm.headers.get('access-control-allow-origin'), '*');
  const doc = (await prm.json()) as Record<string, unknown>;
  assert.equal(doc.resource, `${base}/mcp`);
  assert.deepEqual(doc.authorization_servers, [base]);
  // The path-suffixed form from RFC 9728 resolves too.
  assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).status, 200);

  const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>;
  assert.equal(as.issuer, base);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.ok(as.token_endpoint_auth_methods_supported.includes('client_secret_basic'));
  assert.equal(as.registration_endpoint, `${base}/oauth/register`);
});

test('/mcp itself sends no CORS headers and refuses foreign browser origins', async () => {
  const { token } = await newToken('agent', 'read');
  const ok = await rpc(bearer(token));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), null);
  const evil = await rpc({ ...bearer(token), Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const get = await fetch(`${base}/mcp`, { headers: bearer(token) });
  assert.equal(get.status, 405, 'stateless: no GET stream');
});

/* --------------------------- Personal tokens ------------------------------ */

test('a personal access token initializes and lists the tools and prompts', async () => {
  const { token } = await newToken('agent', 'read_write');
  assert.match(token, /^itk_[A-Za-z0-9_-]{43}$/);
  const client = await connect(bearer(token));
  assert.equal(client.getServerVersion()?.name, 'infraticket');
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const name of [
    'search_tickets', 'get_ticket', 'my_queue', 'list_incidents', 'who_is_on_call', 'list_monitors', 'get_monitor', 'list_alerts',
    'get_status_page', 'list_maintenance', 'list_teams', 'list_quick_tickets', 'ticket_report',
    'create_ticket', 'add_comment', 'update_ticket', 'escalate_ticket', 'acknowledge_page',
  ]) {
    assert.ok(names.includes(name), `has ${name}`);
  }
  const search = tools.find((t) => t.name === 'search_tickets')!;
  assert.equal(search.annotations?.readOnlyHint, true);
  const create = tools.find((t) => t.name === 'create_ticket')!;
  assert.equal(create.annotations?.readOnlyHint, false);
  assert.equal(create.annotations?.destructiveHint, false);
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ['daily_briefing', 'incident_summary']);
  await client.close();

  // Only a hash is stored.
  const row = await db.get<{ token_hash: string }>('SELECT token_hash FROM api_tokens WHERE token_prefix = ?', [`${token.slice(0, 8)}…`]);
  assert.equal(row?.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
});

test('reads are scoped to what the person can see, and internal notes to who may read them', async () => {
  const agent = await connect(bearer((await newToken('agent', 'read')).token));
  const found = await tool(agent, 'search_tickets', {});
  const refs = found.data.tickets.map((t: { reference: string }) => t.reference);
  assert.ok(refs.includes(ticketA.reference));
  assert.ok(!refs.includes(ticketB.reference), 'another team\'s ticket stays hidden');
  assert.match(found.data.tickets[0].url, new RegExp(`^${base}/tickets/`));

  const hidden = await tool(agent, 'get_ticket', { ticket: ticketB.reference });
  assert.ok(hidden.isError);
  // An id that merely starts with a ticket's number is not that ticket.
  const number = ticketA.reference.replace(/\D/g, '');
  const lookalike = await tool(agent, 'get_ticket', { ticket: `${number}fffffff-0000-4000-8000-000000000000` });
  assert.ok(lookalike.isError, 'a UUID-like id must not resolve by its leading digits');
  assert.equal((await tool(agent, 'get_ticket', { ticket: ticketA.id })).data.reference, ticketA.reference);
  assert.equal((await tool(agent, 'get_ticket', { ticket: number })).data.reference, ticketA.reference);

  const full = await tool(agent, 'get_ticket', { ticket: ticketA.reference });
  assert.ok(full.data.comments.some((c: { body: string }) => c.body.includes('SECRET internal')), 'an agent reads internal notes');
  await agent.close();

  const viewer = await connect(bearer((await newToken('viewer', 'read')).token));
  const seen = await tool(viewer, 'get_ticket', { ticket: ticketA.reference });
  assert.equal(seen.isError, false);
  assert.ok(seen.data.comments.some((c: { body: string }) => c.body.includes('replica')));
  assert.ok(!JSON.stringify(seen.data).includes('SECRET internal'), 'a viewer never sees internal notes');
  const report = await tool(viewer, 'ticket_report', {});
  assert.ok(report.isError, 'reports need reports.view');
  await viewer.close();
});

test('writes are refused for read tokens, without the permission, and when the org is read-only', async () => {
  const readOnly = await connect(bearer((await newToken('agent', 'read')).token));
  const r1 = await tool(readOnly, 'add_comment', { ticket: ticketA.reference, body: 'hi' });
  assert.ok(r1.isError);
  assert.match(r1.text, /read-only/);
  await readOnly.close();

  const viewer = await connect(bearer((await newToken('viewer', 'read_write')).token));
  const r2 = await tool(viewer, 'create_ticket', { subject: 'Printer' });
  assert.ok(r2.isError);
  assert.match(r2.text, /tickets\.create/);
  const r3 = await tool(viewer, 'add_comment', { ticket: ticketA.reference, body: 'psst', internal: true });
  assert.ok(r3.isError);
  assert.match(r3.text, /comment_internal/);
  await viewer.close();

  assert.equal((await call('admin', 'PUT', '/api/connector/settings', { mode: 'read_only' })).status, 200);
  const agent = await connect(bearer((await newToken('agent', 'read_write')).token));
  const r4 = await tool(agent, 'update_ticket', { ticket: ticketA.reference, status: 'in_progress' });
  assert.ok(r4.isError);
  assert.match(r4.text, /organisation/);
  await agent.close();
  assert.equal((await call('admin', 'PUT', '/api/connector/settings', { mode: 'read_write' })).status, 200);
  // Non-admins cannot change it.
  assert.equal((await call('agent', 'PUT', '/api/connector/settings', { mode: 'read_only' })).status, 403);
});

test('a permitted write goes through the normal service and is audited as via Claude', async () => {
  const agent = await connect(bearer((await newToken('agent', 'read_write')).token));
  const commented = await tool(agent, 'add_comment', { ticket: ticketA.reference, body: 'Restarted the replica', internal: true });
  assert.equal(commented.isError, false, commented.text);
  const updated = await tool(agent, 'update_ticket', { ticket: ticketA.reference, status: 'in_progress', assignee: 'me' });
  assert.equal(updated.isError, false, updated.text);
  assert.equal(updated.data.updated.status, 'in_progress');
  assert.equal(updated.data.updated.assignee, 'Person agent');

  const created = await tool(agent, 'create_ticket', { subject: 'VPN drops every hour', team: 'Platform', priority: 'normal' });
  assert.equal(created.isError, false, created.text);
  const source = await db.get<{ source: string }>('SELECT source FROM tickets WHERE id = ?', [created.data.created.id]);
  assert.equal(source?.source, 'claude');

  const queue = await tool(agent, 'my_queue', {});
  assert.ok(queue.data.tickets.some((t: { reference: string }) => t.reference === ticketA.reference));
  await agent.close();

  const rows = await db.all<{ action: string; summary: string; meta: string }>(
    `SELECT action, summary, meta FROM audit_log WHERE action LIKE 'claude_%' ORDER BY created_at`,
  );
  const actions = rows.map((r) => r.action);
  assert.ok(actions.includes('claude_add_comment'));
  assert.ok(actions.includes('claude_update_ticket'));
  assert.ok(actions.includes('claude_create_ticket'));
  for (const row of rows) {
    assert.match(row.summary, /^Person agent via Claude: /);
    const meta = JSON.parse(row.meta);
    assert.equal(meta.via, 'mcp');
    assert.match(meta.client, /token/i);
  }
});

test('revoked and expired tokens stop working; tokens are never read from the query string', async () => {
  const { token, record } = await newToken('agent', 'read');
  assert.equal((await rpc(bearer(token))).status, 200);
  assert.equal((await call('other', 'DELETE', `/api/connector/tokens/${record.id}`)).status, 404, 'not someone else\'s');
  assert.equal((await call('agent', 'DELETE', `/api/connector/tokens/${record.id}`)).status, 204);
  assert.equal((await rpc(bearer(token))).status, 401);

  const second = await newToken('agent', 'read');
  await db.run('UPDATE api_tokens SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), second.record.id]);
  const expired = await rpc(bearer(second.token));
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get('www-authenticate') ?? '', /invalid_token/);

  const third = await newToken('agent', 'read');
  const viaQuery = await fetch(`${base}/mcp?access_token=${third.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(viaQuery.status, 401);

  // Admins see and revoke anyone's.
  const all = await call('admin', 'GET', '/api/connector/tokens/all');
  assert.ok(all.payload.some((t: { id: string; userName: string }) => t.id === third.record.id && t.userName === 'Person agent'));
  assert.equal((await call('agent', 'GET', '/api/connector/tokens/all')).status, 403);
  assert.equal((await call('admin', 'DELETE', `/api/connector/tokens/${third.record.id}`)).status, 204);
  assert.equal((await rpc(bearer(third.token))).status, 401);
});

test('a raw X-InfraTicket-Token header works for API-key clients such as Copilot Studio', async () => {
  const { token } = await newToken('agent', 'read');
  const client = await connect({ 'X-InfraTicket-Token': token });
  const teams = await tool(client, 'list_teams');
  assert.ok(teams.data.teams.some((t: { name: string }) => t.name === 'Platform'));
  await client.close();
  assert.equal((await rpc({ 'X-InfraTicket-Token': 'ita_notapat' })).status, 401);
  assert.equal((await rpc({ 'X-InfraTicket-Token': 'itk_wrong' })).status, 401);
});

test('a suspended person\'s token stops at once', async () => {
  const { token } = await newToken('other', 'read');
  assert.equal((await rpc(bearer(token))).status, 200);
  await db.run(`UPDATE users SET status = 'suspended' WHERE id = 'other'`);
  assert.equal((await rpc(bearer(token))).status, 401);
  await db.run(`UPDATE users SET status = 'active' WHERE id = 'other'`);
});

test('calls are rate-limited per credential', async () => {
  const { token } = await newToken('admin', 'read');
  let limited = 0;
  for (let i = 0; i < 45; i += 1) {
    const res = await rpc(bearer(token));
    if (res.status === 429) {
      limited += 1;
      assert.ok(Number(res.headers.get('retry-after')) > 0);
    }
  }
  assert.equal(limited, 5);
  // Someone else's token is unaffected.
  assert.equal((await rpc(bearer((await newToken('agent', 'read')).token))).status, 200);
});

/* --------------------------------- OAuth ---------------------------------- */

const REDIRECT = 'http://localhost:7777/callback';

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

async function register(name = 'Claude') {
  const res = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Authorize, approve as `who`, return the code. */
async function authorize(clientId: string, opts: { challenge?: string; resource?: string; scope?: string; who?: string; redirect?: string } = {}) {
  const url = new URL(`${base}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', opts.redirect ?? REDIRECT);
  url.searchParams.set('state', 'st-123');
  if (opts.challenge) {
    url.searchParams.set('code_challenge', opts.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  url.searchParams.set('resource', opts.resource ?? `${base}/mcp`);
  if (opts.scope) url.searchParams.set('scope', opts.scope);
  const res = await fetch(url, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const location = res.headers.get('location')!;
  if (!location.startsWith('/connect/authorize')) return { error: new URL(location).searchParams };
  const requestId = new URLSearchParams(location.split('?')[1]).get('request')!;
  const consent = await call(opts.who ?? 'agent', 'GET', `/api/connector/requests/${requestId}`);
  assert.equal(consent.status, 200);
  const approved = await call(opts.who ?? 'agent', 'POST', `/api/connector/requests/${requestId}/approve`, {});
  const back = new URL(approved.payload.redirectTo);
  assert.equal(back.searchParams.get('state'), 'st-123');
  return { code: back.searchParams.get('code')!, consent: consent.payload };
}

async function token(body: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString(),
  });
  return { status: res.status, payload: (await res.json()) as Record<string, any> };
}

test('the full OAuth flow: PKCE, single-use codes, audience binding and refresh rotation', async () => {
  const clientId = await register('Claude');
  const resource = `${base}/mcp`;

  // The consent screen sees who is asking and where it sends you back.
  const first = await authorize(clientId, { challenge: pkce().challenge });
  assert.equal(first.consent.clientName, 'Claude');
  assert.equal(first.consent.redirectHost, 'localhost:7777');
  const wrong = await token({ grant_type: 'authorization_code', code: first.code!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: pkce().verifier, resource });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.payload.error, 'invalid_grant');

  // Missing PKCE never reaches the consent screen.
  const noPkce = await authorize(clientId, {});
  assert.equal(noPkce.error?.get('error'), 'invalid_request');
  // Nor does a token for another server.
  const elsewhere = await authorize(clientId, { challenge: pkce().challenge, resource: 'https://other.example/mcp' });
  assert.equal(elsewhere.error?.get('error'), 'invalid_target');

  const p = pkce();
  const ok = await authorize(clientId, { challenge: p.challenge });
  const exchange = { grant_type: 'authorization_code', code: ok.code!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: p.verifier, resource };
  const issued = await token(exchange);
  assert.equal(issued.status, 200, JSON.stringify(issued.payload));
  assert.equal(issued.payload.token_type, 'Bearer');
  assert.equal(issued.payload.expires_in, 3600);

  // The access token works with a real MCP client, as the person who approved.
  const client = await connect(bearer(issued.payload.access_token));
  const mine = await tool(client, 'search_tickets', {});
  assert.ok(!mine.data.tickets.some((t: { reference: string }) => t.reference === ticketB.reference));
  await client.close();
  const apps = await call('agent', 'GET', '/api/connector/apps');
  assert.equal(apps.payload.length, 1);
  assert.equal(apps.payload[0].clientName, 'Claude');

  // Refresh rotates: the new pair works, the old refresh token is refused,
  // and reusing it withdraws the whole grant.
  const refreshed = await token({ grant_type: 'refresh_token', refresh_token: issued.payload.refresh_token, client_id: clientId });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.payload.refresh_token, issued.payload.refresh_token);
  assert.equal((await rpc(bearer(refreshed.payload.access_token))).status, 200);
  const reuse = await token({ grant_type: 'refresh_token', refresh_token: issued.payload.refresh_token, client_id: clientId });
  assert.equal(reuse.payload.error, 'invalid_grant');
  assert.equal((await rpc(bearer(refreshed.payload.access_token))).status, 401, 'reuse revokes the grant');

  // A replayed code is refused, and revokes what the first exchange issued.
  const p2 = pkce();
  const again = await authorize(clientId, { challenge: p2.challenge });
  const firstUse = await token({ ...exchange, code: again.code!, code_verifier: p2.verifier });
  assert.equal(firstUse.status, 200);
  const replay = await token({ ...exchange, code: again.code!, code_verifier: p2.verifier });
  assert.equal(replay.payload.error, 'invalid_grant');
  assert.equal((await rpc(bearer(firstUse.payload.access_token))).status, 401);

  // The wrong audience at the token endpoint.
  const p3 = pkce();
  const third = await authorize(clientId, { challenge: p3.challenge });
  const otherAudience = await token({ ...exchange, code: third.code!, code_verifier: p3.verifier, resource: 'https://other.example/mcp' });
  assert.equal(otherAudience.payload.error, 'invalid_target');

  // A token bound to this server is refused if the server's address changes.
  const p4 = pkce();
  const fourth = await authorize(clientId, { challenge: p4.challenge });
  const bound = await token({ ...exchange, code: fourth.code!, code_verifier: p4.verifier });
  assert.equal((await rpc(bearer(bound.payload.access_token))).status, 200);
  await call('admin', 'PUT', '/api/connector/settings', { publicUrl: 'https://tickets.example.com' });
  assert.equal((await rpc(bearer(bound.payload.access_token))).status, 401);
  await call('admin', 'PUT', '/api/connector/settings', { publicUrl: '' });

  // Disconnecting from the profile revokes it.
  const grantId = (await call('agent', 'GET', '/api/connector/apps')).payload[0].grantId;
  assert.equal((await call('agent', 'DELETE', `/api/connector/apps/${grantId}`)).status, 204);
  assert.equal((await rpc(bearer(bound.payload.access_token))).status, 401);

  // RFC 7009 revoke answers 200 whatever it is given.
  const revoked = await fetch(`${base}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=nonsense' });
  assert.equal(revoked.status, 200);
});

test('the consent screen can grant less than was asked, and a read grant cannot write', async () => {
  const clientId = await register('Claude read');
  const p = pkce();
  const url = new URL(`${base}/oauth/authorize`);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: p.challenge, code_challenge_method: 'S256', state: 's' })) {
    url.searchParams.set(k, v);
  }
  const location = (await fetch(url, { redirect: 'manual' })).headers.get('location')!;
  const requestId = new URLSearchParams(location.split('?')[1]).get('request')!;
  const approved = await call('agent', 'POST', `/api/connector/requests/${requestId}/approve`, { scope: 'read' });
  const code = new URL(approved.payload.redirectTo).searchParams.get('code')!;
  const issued = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: p.verifier });
  assert.equal(issued.payload.scope, 'infraticket:read');
  const client = await connect(bearer(issued.payload.access_token));
  assert.ok((await tool(client, 'add_comment', { ticket: ticketA.reference, body: 'x' })).isError);
  await client.close();

  // Denying sends the person back with access_denied.
  const p2 = pkce();
  url.searchParams.set('code_challenge', p2.challenge);
  const loc2 = (await fetch(url, { redirect: 'manual' })).headers.get('location')!;
  const denied = await call('agent', 'POST', `/api/connector/requests/${new URLSearchParams(loc2.split('?')[1]).get('request')}/deny`);
  assert.equal(new URL(denied.payload.redirectTo).searchParams.get('error'), 'access_denied');
});

test('an unregistered redirect URI is shown an error page, never redirected to', async () => {
  const clientId = await register();
  const url = `${base}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=${pkce().challenge}&code_challenge_method=S256`;
  const res = await fetch(url, { redirect: 'manual' });
  assert.equal(res.status, 400);
  assert.match(res.headers.get('content-type') ?? '', /html/);
  const bad = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'x', redirect_uris: ['http://evil.example/cb'] }),
  });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: string }).error, 'invalid_redirect_uri');
});

test('confidential clients (Copilot Studio "Manual" OAuth): client secret, optional PKCE, short scope names', async () => {
  const callback = 'https://global.consent.azure-apim.net/redirect/test-connector';
  const created = await call('admin', 'POST', '/api/connector/clients', { name: 'Copilot Studio', redirectUris: [] });
  assert.equal(created.status, 201);
  const { client, clientSecret } = created.payload;
  assert.match(clientSecret, /^its_/);
  assert.equal((await call('agent', 'POST', '/api/connector/clients', { name: 'x' })).status, 403);
  // The callback URL is pasted in after Copilot Studio shows it.
  const patched = await call('admin', 'PATCH', `/api/connector/clients/${client.clientId}`, { redirectUris: [callback] });
  assert.deepEqual(patched.payload.redirectUris, [callback]);

  // No PKCE: allowed for this client only, and only with its secret.
  const { code } = await authorize(client.clientId, { redirect: callback, scope: 'read_write offline_access', resource: `${base}/mcp` });
  const basic = Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64');
  const wrongSecret = await token(
    { grant_type: 'authorization_code', code: code!, redirect_uri: callback },
    { Authorization: `Basic ${Buffer.from(`${client.clientId}:its_wrong`).toString('base64')}` },
  );
  assert.equal(wrongSecret.status, 401);
  assert.equal(wrongSecret.payload.error, 'invalid_client');

  const { code: code2 } = await authorize(client.clientId, { redirect: callback, scope: 'read_write' });
  const issued = await token({ grant_type: 'authorization_code', code: code2!, redirect_uri: callback }, { Authorization: `Basic ${basic}` });
  assert.equal(issued.status, 200, JSON.stringify(issued.payload));
  assert.equal(issued.payload.scope, 'infraticket:read infraticket:write');
  const mcp = await connect(bearer(issued.payload.access_token));
  assert.equal((await tool(mcp, 'list_incidents')).isError, false);
  await mcp.close();

  // client_secret_post for the refresh.
  const refreshed = await token({ grant_type: 'refresh_token', refresh_token: issued.payload.refresh_token, client_id: client.clientId, client_secret: clientSecret });
  assert.equal(refreshed.status, 200);
  const noSecret = await token({ grant_type: 'refresh_token', refresh_token: refreshed.payload.refresh_token, client_id: client.clientId });
  assert.equal(noSecret.payload.error, 'invalid_client');

  // A PKCE challenge, if sent, is still enforced.
  const p = pkce();
  const { code: code3 } = await authorize(client.clientId, { redirect: callback, challenge: p.challenge });
  const missingVerifier = await token({ grant_type: 'authorization_code', code: code3!, redirect_uri: callback, client_id: client.clientId, client_secret: clientSecret });
  assert.equal(missingVerifier.payload.error, 'invalid_grant');

  // Deleting the client disconnects everyone who used it.
  assert.equal((await call('admin', 'DELETE', `/api/connector/clients/${client.clientId}`)).status, 204);
  assert.equal((await rpc(bearer(refreshed.payload.access_token))).status, 401);
});

test('turning the connector off closes /mcp, discovery and new tokens', async () => {
  const { token: pat } = await newToken('agent', 'read');
  await call('admin', 'PUT', '/api/connector/settings', { enabled: false });
  assert.equal((await rpc(bearer(pat))).status, 403);
  assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource`)).status, 404);
  assert.equal((await call('agent', 'POST', '/api/connector/tokens', { name: 'x', scope: 'read', expiresInDays: 30 })).status, 403);
  await call('admin', 'PUT', '/api/connector/settings', { enabled: true });
  assert.equal((await rpc(bearer(pat))).status, 200);
  const info = await call('agent', 'GET', '/api/connector/info');
  assert.equal(info.payload.mcpUrl, `${base}/mcp`);
  assert.equal(info.payload.publicHttps, false);
});
