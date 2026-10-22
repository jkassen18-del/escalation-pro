/**
 * Phone and browser push notifications (Web Push), driven over real HTTP.
 *
 * The push services (Google, Mozilla, Apple) are replaced by stubbing
 * web-push's sendNotification, which is the one call that leaves the server.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'push.db';
process.env.SESSION_SECRET = 'p'.repeat(48);
process.env.SECRET_KEY = 'q'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const wipe = () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `push.db${suffix}`), { force: true });
};

let server: http.Server;
let base: string;
let db: typeof import('../server/db/index.ts').db;
const cookies: Record<string, string> = {};

/** What web-push was asked to deliver, and which endpoints should fail. */
const pushed: Array<{ endpoint: string; payload: any; options: any }> = [];
const gone = new Set<string>();

async function call(who: string, method: string, url: string, body?: unknown) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { cookie: cookies[who] } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json().catch(() => null)) as any };
}

const device = (name: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
  keys: { p256dh: `BP256-${name}`, auth: `auth-${name}` },
});

before(async () => {
  wipe();
  const dist = path.resolve(import.meta.dirname, '../dist/client');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }

  const webpush = (await import('web-push')).default;
  webpush.sendNotification = (async (subscription: { endpoint: string }, payload: string, options: unknown) => {
    if (gone.has(subscription.endpoint)) throw Object.assign(new Error('Gone'), { statusCode: 410 });
    pushed.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options });
    return { statusCode: 201, body: '', headers: {} };
  }) as unknown as typeof webpush.sendNotification;

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword('Push-Password-1');
  const now = new Date().toISOString();
  for (const [id, role] of [
    ['u-admin', 'admin'],
    ['u-other', 'agent'],
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

  for (const id of ['u-admin', 'u-other']) {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: `${id}@acme.test`, password: 'Push-Password-1' }),
    });
    cookies[id] = login.headers.get('set-cookie')!.split(';')[0];
  }
});

after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db.close();
  wipe();
});

test('the VAPID public key is public, stable, and its private half is stored encrypted', async () => {
  const first = await call('', 'GET', '/api/ops/push/key');
  assert.equal(first.status, 200);
  assert.match(first.payload.publicKey, /^[A-Za-z0-9_-]{80,}$/);
  const { resetVapidCache } = await import('../server/ops/push.ts');
  resetVapidCache();
  const second = await call('', 'GET', '/api/ops/push/key');
  assert.equal(second.payload.publicKey, first.payload.publicKey, 'the key survives a restart');

  const row = await db.get<{ value: string }>(`SELECT value FROM settings WHERE key = 'ops.webPush'`);
  const stored = JSON.parse(row!.value);
  assert.match(stored.privateKeyEncrypted, /^enc:v1:/);
  assert.equal(stored.privateKey, undefined);
  const settings = await call('u-admin', 'GET', '/api/settings');
  assert.doesNotMatch(JSON.stringify(settings.payload), /privateKey/, 'never exposed through settings');
});

test('people subscribe their own devices, and only remove their own', async () => {
  assert.equal((await call('u-admin', 'POST', '/api/ops/push/subscribe', { endpoint: 'http://evil.test/x', keys: { p256dh: 'a', auth: 'b' } })).status, 400);
  assert.equal((await call('u-admin', 'POST', '/api/ops/push/subscribe', { endpoint: 'https://fcm.googleapis.com/x' })).status, 400);
  assert.equal((await call('', 'POST', '/api/ops/push/subscribe', device('anon'))).status, 401);

  assert.equal((await call('u-admin', 'POST', '/api/ops/push/subscribe', device('phone'))).payload.devices, 1);
  assert.equal((await call('u-admin', 'POST', '/api/ops/push/subscribe', device('laptop'))).payload.devices, 2);
  // Re-subscribing the same device does not duplicate it.
  assert.equal((await call('u-admin', 'POST', '/api/ops/push/subscribe', device('phone'))).payload.devices, 2);
  assert.equal((await call('u-other', 'POST', '/api/ops/push/subscribe', device('other'))).payload.devices, 1);

  const stealing = await call('u-other', 'DELETE', '/api/ops/push/subscribe', { endpoint: device('phone').endpoint });
  assert.equal(stealing.status, 404, "someone else's device cannot be removed");
  assert.equal((await call('u-admin', 'GET', '/api/ops/me/push')).payload.devices, 2);

  assert.equal((await call('u-other', 'DELETE', '/api/ops/push/subscribe', { endpoint: device('other').endpoint })).payload.devices, 0);
});

test('a page is pushed to every device, with what the notification needs and no secrets', async () => {
  const policy = await call('u-admin', 'POST', '/api/ops/policies', {
    name: 'Push test',
    levels: [{ delayMins: 10, targets: [{ type: 'user', id: 'u-admin' }] }],
  });
  const ticket = await call('u-admin', 'POST', '/api/tickets', { subject: 'Website down', type: 'incident' });
  pushed.length = 0;
  const page = await call('u-admin', 'POST', `/api/ops/tickets/${ticket.payload.ticket.id}/page`, { policyId: policy.payload.policy.id, severity: 'sev1' });
  assert.equal(page.status, 201, JSON.stringify(page.payload));

  // Push is in the default rules at 0 minutes, so it goes immediately.
  assert.deepEqual(pushed.map((p) => p.endpoint).sort(), [device('laptop').endpoint, device('phone').endpoint].sort());
  const payload = pushed[0].payload;
  assert.equal(payload.pageId, page.payload.page.id);
  assert.equal(payload.ticketId, ticket.payload.ticket.id);
  assert.match(payload.title, /Paged: ESC-\d+/);
  assert.equal(pushed[0].options.urgency, 'high');
  const raw = JSON.stringify(payload);
  for (const secret of ['p256dh', 'auth-phone', 'BP256', 'privateKey']) assert.ok(!raw.includes(secret), `payload leaks ${secret}`);

  const attempt = (await call('u-admin', 'GET', `/api/ops/pages/${page.payload.page.id}`)).payload.page.attempts.find((a: any) => a.channel === 'push');
  assert.equal(attempt.status, 'sent');
  assert.match(attempt.detail, /2 device/);
});

test('a device the push service reports as gone is forgotten', async () => {
  gone.add(device('laptop').endpoint);
  pushed.length = 0;
  const result = await call('u-admin', 'POST', '/api/ops/me/test-push');
  assert.equal(result.payload.result.status, 'sent');
  assert.match(result.payload.result.detail, /forgot 1 device/);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].payload.pageId, undefined, 'a test is not a page: no Acknowledge button');
  assert.equal((await call('u-admin', 'GET', '/api/ops/me/push')).payload.devices, 1);
});

test('someone with no devices is told how to turn push on', async () => {
  const result = await call('u-other', 'POST', '/api/ops/me/test-push');
  assert.equal(result.payload.result.status, 'skipped');
  assert.match(result.payload.result.detail, /Phone notifications/);
});
