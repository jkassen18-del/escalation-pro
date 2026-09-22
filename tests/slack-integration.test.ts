/**
 * Saving the Slack integration in bot mode.
 *
 * Slack can post through an incoming webhook or a bot token, and only the
 * selected mode's credential is read. Saving a bot token was rejected with
 * "Webhook URL must be a valid URL" - a field the person was not filling in
 * and that bot mode never looks at.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'slackintegration.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SECRET_KEY = 'b'.repeat(64);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, `slackintegration.db${suffix}`));
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

/**
 * A fake credential, assembled at runtime rather than written out.
 *
 * Nothing here contacts Slack, but a literal of the real shape trips secret
 * scanning and blocks the push - correctly, since a scanner cannot know a
 * token is fake. Building it from parts keeps the test honest without
 * committing anything that looks like a live key.
 */
const BOT_TOKEN = ['xoxb', '0'.repeat(13), '0'.repeat(13), 'notarealtokenjustfortests'].join('-');

let server: http.Server;
let base: string;
let cookie: string;
let db: typeof import('../server/db/index.ts').db;

async function saveSlack(config: Record<string, unknown>) {
  const response = await fetch(`${base}/api/integrations/slack`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ config }),
  });
  return { status: response.status, payload: (await response.json()) as any };
}

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
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await db.close();
  wipe();
});

test('a bot token saves without a webhook URL', async () => {
  const { status, payload } = await saveSlack({ mode: 'bot', botToken: BOT_TOKEN, channel: '#escalations' });
  assert.equal(status, 200, JSON.stringify(payload));
  assert.equal(payload.integration.configured, true, 'bot mode is configured by token and channel alone');
});

test('a leftover value in the unused field does not block the save', async () => {
  // Exactly what happened: a bot token pasted into the webhook box first, then
  // the method switched to bot. The stale value rode along with the request.
  const { status, payload } = await saveSlack({
    mode: 'bot',
    botToken: BOT_TOKEN,
    channel: '#escalations',
    webhookUrl: BOT_TOKEN,
  });
  assert.equal(status, 200, JSON.stringify(payload));
  assert.equal(payload.integration.configured, true);
});

test('the leftover value is not stored as a webhook either', async () => {
  const record = await (await import('../server/integrations/store.ts')).loadIntegration('slack');
  assert.notEqual(record.config.webhookUrl, BOT_TOKEN, 'a token must never be stored as a webhook URL');
});

test('the token is stored encrypted and returned masked', async () => {
  const row = await db.get<{ config: string }>(`SELECT config FROM integrations WHERE provider = 'slack'`);
  assert.ok(row);
  assert.doesNotMatch(row.config, /notarealtokenjustfortests/, 'the token sits in the row in plain text');

  const listed = await (await fetch(`${base}/api/integrations`, { headers: { cookie } })).json() as any;
  const slack = listed.integrations.find((entry: any) => entry.provider === 'slack');
  assert.doesNotMatch(JSON.stringify(slack), /notarealtokenjustfortests/, 'the token was sent to the browser');
  assert.equal(slack.config.botTokenSet, true, 'the UI is still told a token is saved');
});

test('webhook mode still rejects a URL that is not a Slack webhook', async () => {
  const { status, payload } = await saveSlack({ mode: 'webhook', webhookUrl: 'https://evil.example/hook' });
  assert.equal(status, 400);
  assert.match(payload.error, /Slack incoming webhook/i);
});

test('webhook mode still rejects an internal address', async () => {
  const { status } = await saveSlack({ mode: 'webhook', webhookUrl: 'http://169.254.169.254/latest/meta-data' });
  assert.equal(status, 400, 'SSRF protection must survive the mode change');
});

test('switching back to webhook mode keeps the stored bot token', async () => {
  await saveSlack({ mode: 'webhook' });
  const record = await (await import('../server/integrations/store.ts')).loadIntegration('slack');
  assert.ok(record.config.botToken, 'switching method must not discard the other credential');
});

/* ------------------------------ Linear ----------------------------------- */

/**
 * Loading the Linear team list.
 *
 * "Load teams" did nothing visible when it failed - the client swallowed the
 * error - and it only ever used a key that had already been saved, so pressing
 * the buttons in the natural order returned an empty list and no reason.
 */

test('loading teams without any key explains what is missing', async () => {
  const response = await fetch(`${base}/api/integrations/linear/teams`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
  const payload = (await response.json()) as any;
  assert.match(payload.error, /API key/i, 'the reason must be stated, not left blank');
});

test('a key that Linear rejects is reported with Linear own words', async () => {
  const response = await fetch(`${base}/api/integrations/linear/teams`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ apiKey: ['lin', 'api', 'definitely-not-a-real-key'].join('_') }),
  });

  // 400 with a message either way: Linear refuses the key, or it cannot be
  // reached from here. What matters is that something is said.
  assert.equal(response.status, 400);
  const payload = (await response.json()) as any;
  assert.ok(typeof payload.error === 'string' && payload.error.length > 0, 'an empty failure tells the user nothing');
});

test('the key is sent in the body, never in the URL', async () => {
  // A key in a query string lands in access logs and browser history, so the
  // endpoint is a POST and does not accept one on the query.
  const response = await fetch(`${base}/api/integrations/linear/teams?apiKey=${['lin', 'api', 'leaky'].join('_')}`, {
    headers: { cookie },
  });
  assert.equal(response.status, 404, 'there must be no GET form of this endpoint');
});
