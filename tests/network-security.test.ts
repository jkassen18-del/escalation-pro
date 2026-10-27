/**
 * The outer wall: the company-network allowlist (as the app sees it behind a
 * Cloudflare Tunnel), security headers, crawler refusal, the same-origin check
 * on state-changing requests, request limits, and how attachments are served.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'network-security.db';
process.env.SESSION_SECRET = 'n'.repeat(48);
process.env.SECRET_KEY = 'k'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
// The company network: an office range and one VPN address.
process.env.ALLOWED_NETWORKS = '10.20.0.0/16, 196.22.10.4';
process.env.RATE_LIMIT_AUTH_PER_MIN = '40';
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;
delete process.env.PUBLIC_PATHS;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const wipe = () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `network-security.db${suffix}`), { force: true });
};

let server: http.Server;
let base: string;
let cookie: string;
let db: typeof import('../server/db/index.ts').db;

const OFFICE = '10.20.4.17';
const VPN = '196.22.10.4';
const OUTSIDER = '203.0.113.9';

/** As the tunnel delivers it: from this machine, with Cloudflare's report of the visitor. */
function via(ip: string, headers: Record<string, string> = {}) {
  return { 'cf-connecting-ip': ip, 'x-forwarded-for': ip, 'x-forwarded-proto': 'https', ...headers };
}

async function req(method: string, url: string, headers: Record<string, string> = {}, body?: unknown) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    redirect: 'manual',
  });
  return response;
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
  await db.run(
    'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['u-admin', 'admin@acme.test', 'admin', 'Admin', hash, salt, 'admin', 'active', '#9a7b2f', 0, now, now],
  );
  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await req('POST', '/api/auth/login', via(OFFICE), { login: 'admin@acme.test', password: 'Adm1n-Password!' });
  assert.equal(login.status, 200, await login.clone().text());
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});

after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db.close();
  wipe();
});

test('network ranges parse, and addresses are matched against them', async () => {
  const { parseNetworks, isAllowed } = await import('../server/lib/network.ts');
  const policy = parseNetworks('10.0.0.0/8 192.168.1.10, 2001:db8::/32');
  assert.equal(isAllowed(policy, '10.255.1.2'), true);
  assert.equal(isAllowed(policy, '192.168.1.10'), true);
  assert.equal(isAllowed(policy, '192.168.1.11'), false);
  assert.equal(isAllowed(policy, '2001:db8::5'), true);
  assert.equal(isAllowed(policy, 'not-an-ip'), false);
  assert.equal(isAllowed(parseNetworks(''), '8.8.8.8'), true, 'no list means no restriction');
  assert.throws(() => parseNetworks('10.0.0.0/40'));
  assert.throws(() => parseNetworks('intranet'));
});

test('outside the company network nothing is served: no login page, no assets, no API', async () => {
  for (const url of ['/', '/login', '/api/auth/me', '/api/branding', '/favicon.svg', '/status/main', '/health']) {
    const response = await req('GET', url, via(OUTSIDER));
    assert.equal(response.status, 403, `${url} was served to an outsider`);
    assert.doesNotMatch(await response.text(), /InfraTicket|root|version/i, `${url} gave something away`);
  }
  assert.equal((await req('POST', '/api/auth/login', via(OUTSIDER), { login: 'admin@acme.test', password: 'x' })).status, 403, 'an outsider could try passwords');
  // Office and VPN addresses get through.
  assert.notEqual((await req('GET', '/', via(OFFICE))).status, 403);
  assert.equal((await req('GET', '/api/auth/me', via(VPN, { cookie }))).status, 200);
});

test("a forged visitor address does not get past, and signed webhooks still arrive from outside", async () => {
  // Cloudflare overwrites CF-Connecting-IP; a visitor adding their own X-Forwarded-For changes nothing.
  assert.equal((await req('GET', '/api/auth/me', via(OUTSIDER, { 'x-forwarded-for': `${OFFICE}, ${OUTSIDER}` }))).status, 403);
  // Alert intake and heartbeats carry their own secret: reachable, and refused on the secret instead.
  assert.equal((await req('POST', '/api/ingest/not-a-real-token-123456', via(OUTSIDER), { title: 'x' })).status, 404);
  assert.equal((await req('GET', '/api/heartbeat/not-a-real-token-123456', via(OUTSIDER))).status, 404);
  // Slack must sign: an unsigned call from outside reaches the route and is turned away there.
  assert.notEqual((await req('POST', '/api/webhooks/slack/interactive', via(OUTSIDER), {})).status, 200);
});

test('every response carries the security headers, and crawlers are told to stay out', async () => {
  const response = await req('GET', '/api/auth/me', via(OFFICE, { cookie }));
  const csp = response.headers.get('content-security-policy') ?? '';
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-powered-by'), null);
  const robots = await req('GET', '/robots.txt', via(OFFICE));
  assert.equal(await robots.text(), 'User-agent: *\nDisallow: /\n');
});

test('another site cannot make a signed-in browser change anything', async () => {
  const body = { subject: 'Made by a malicious page' };
  const evil = await req('POST', '/api/tickets', via(OFFICE, { cookie, origin: 'https://evil.example' }), body);
  assert.equal(evil.status, 403);
  const crossSite = await req('POST', '/api/tickets', via(OFFICE, { cookie, 'sec-fetch-site': 'cross-site' }), body);
  assert.equal(crossSite.status, 403);
  const host = new URL(base).host;
  const own = await req('POST', '/api/tickets', via(OFFICE, { cookie, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }), { subject: 'From our own page' });
  assert.equal(own.status, 201, await own.text());
  assert.equal((await db.all(`SELECT id FROM tickets WHERE subject LIKE 'Made by%'`)).length, 0);
});

test('requests are limited per address', async () => {
  let limited: Response | null = null;
  for (let i = 0; i < 45 && !limited; i += 1) {
    const response = await req('GET', '/api/auth/me', via('10.20.9.9'));
    if (response.status === 429) limited = response;
  }
  assert.ok(limited, 'never limited');
  assert.ok(Number(limited!.headers.get('retry-after')) > 0);
  // Another address is unaffected.
  assert.notEqual((await req('GET', '/api/auth/me', via('10.20.9.10'))).status, 429);
});

test('outsiders get a bare health answer; attachments that could hold script are downloaded, not shown', async () => {
  assert.deepEqual(await (await req('GET', '/health', via(OFFICE))).json(), { status: 'ok' });
  assert.ok('database' in (await (await req('GET', '/health')).json()), 'the server itself sees the details');

  const host = new URL(base).host;
  const ticket = await (await req('POST', '/api/tickets', via(OFFICE, { cookie, origin: `http://${host}` }), { subject: 'Files' })).json();
  const form = new FormData();
  form.append('files', new Blob(['{"looks":"harmless"}'], { type: 'application/json' }), 'data.json');
  form.append('files', new Blob(['plain words'], { type: 'text/plain' }), 'notes.txt');
  const uploaded = await req('POST', `/api/tickets/${ticket.ticket.id}/attachments`, via(OFFICE, { cookie, origin: `http://${host}` }), form);
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const files = (await db.all<{ id: string; mime_type: string }>(`SELECT id, mime_type FROM ticket_attachments WHERE ticket_id = ?`, [ticket.ticket.id])).map((row) => ({ id: row.id, mimeType: row.mime_type }));
  assert.equal(files.length, 2);
  for (const file of files) {
    const served = await req('GET', `/api/tickets/${ticket.ticket.id}/attachments/${file.id}`, via(OFFICE, { cookie }));
    const disposition = served.headers.get('content-disposition') ?? '';
    if ((file.mimeType ?? '').includes('json')) {
      assert.match(disposition, /^attachment/, 'JSON was shown inline');
      assert.equal(served.headers.get('content-type'), 'application/octet-stream');
    } else {
      assert.match(disposition, /^inline/);
      assert.match(served.headers.get('content-security-policy') ?? '', /sandbox/);
    }
  }
});
