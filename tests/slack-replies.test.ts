/**
 * Replies typed in Slack becoming comments on a ticket.
 *
 * This endpoint is open to the internet, and the signature is the only thing
 * between it and anyone posting comments onto tickets - so most of what is
 * checked here is what it refuses.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'slackreplies.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SECRET_KEY = 'b'.repeat(64);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const SIGNING_SECRET = 'test-signing-secret';
const THREAD_TS = '1790000000.000100';
const DATA_DIR = path.resolve(import.meta.dirname, '../data');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, `slackreplies.db${suffix}`));
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
let ticketId: string;
let db: typeof import('../server/db/index.ts').db;

/** Signs a body the way Slack does, so the endpoint accepts it. */
function post(body: unknown, options: { secret?: string; timestamp?: number; signature?: string } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const signature =
    options.signature ??
    'v0=' +
      crypto
        .createHmac('sha256', options.secret ?? SIGNING_SECRET)
        .update(`v0:${timestamp}:${raw}`)
        .digest('hex');

  return fetch(`${base}/api/webhooks/slack`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-signature': signature,
      'x-slack-request-timestamp': String(timestamp),
    },
    body: raw,
  });
}

const reply = (overrides: Record<string, unknown> = {}) => ({
  type: 'event_callback',
  event: {
    type: 'message',
    text: 'We have restarted the payment worker.',
    user: 'U_SLACK_PERSON',
    ts: `1790000${Math.floor(Math.random() * 1e6)}.000200`,
    thread_ts: THREAD_TS,
    channel: 'C0BU8RYNT8T',
    ...overrides,
  },
});

before(async () => {
  wipe();
  ensureClientDist();

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const now = new Date().toISOString();
  const { hash, salt } = hashPassword('irrelevant');
  await db.run(
    'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['u-req', 'requester@acme.test', 'req', 'Req Uester', hash, salt, 'agent', 'active', '#9a7b2f', 0, now, now],
  );
  await db.run('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', ['ticket_number', 1000]);
  ticketId = 'tkt-1';
  await db.run(
    `INSERT INTO tickets (id, number, subject, description, description_format, requester_id, status, priority, type, source, tags, escalation_level, created_at, updated_at)
     VALUES (?, 4242, 'Payments failing', '', 'text', 'u-req', 'open', 'high', 'incident', 'web', '[]', 0, ?, ?)`,
    [ticketId, now, now],
  );
  // The thread this ticket's notifications live in.
  await db.run(
    `INSERT INTO ticket_links (id, ticket_id, provider, external_id, external_key, url, created_at)
     VALUES ('l-1', ?, 'slack', ?, 'C0BU8RYNT8T', 'https://slack.com/archives/x', ?)`,
    [ticketId, THREAD_TS, now],
  );

  const { saveIntegration } = await import('../server/integrations/store.ts');
  await saveIntegration('slack', {
    enabled: true,
    config: { mode: 'bot', botToken: 'xoxb-not-real', channel: 'C0BU8RYNT8T', signingSecret: SIGNING_SECRET },
  });

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await db.close();
  wipe();
});

const commentCount = async () =>
  Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ticket_comments`))?.n ?? 0);

test('answers the URL verification challenge before anything is configured', async () => {
  const response = await fetch(`${base}/api/webhooks/slack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'url_verification', challenge: 'abc123' }),
  });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { challenge: string }).challenge, 'abc123');
});

test('a reply in the ticket thread becomes a comment', async () => {
  const before = await commentCount();
  const response = await post(reply());
  assert.equal(response.status, 200, await response.clone().text());

  assert.equal(await commentCount(), before + 1);
  const comment = await db.get<{ body: string; is_internal: number; body_format: string }>(
    `SELECT body, is_internal, body_format FROM ticket_comments ORDER BY created_at DESC LIMIT 1`,
  );
  assert.match(comment!.body, /restarted the payment worker/);
  assert.equal(comment!.is_internal, 0, 'a reply from Slack is a public comment, not an internal note');
  assert.equal(comment!.body_format, 'text', 'text written elsewhere is never stored as markup');
});

test('the people waiting on the ticket are notified', async () => {
  const row = await db.get<{ n: number; title: string }>(
    `SELECT COUNT(*) AS n, MAX(title) AS title FROM notifications WHERE user_id = 'u-req'`,
  );
  assert.ok(Number(row!.n) > 0, 'the requester should hear about the reply');
  assert.match(row!.title, /replied to ESC-4242 in Slack/);
});

test('an unsigned request is refused', async () => {
  const before = await commentCount();
  const response = await fetch(`${base}/api/webhooks/slack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(reply()),
  });
  assert.equal(response.status, 401);
  assert.equal(await commentCount(), before, 'nothing may be written without a valid signature');
});

test('a wrongly signed request is refused', async () => {
  const before = await commentCount();
  const response = await post(reply(), { secret: 'not-the-signing-secret' });
  assert.equal(response.status, 401);
  assert.equal(await commentCount(), before);
});

test('a replayed request is refused once it is stale', async () => {
  // Correctly signed, but for a timestamp six minutes ago. Without the
  // freshness check a captured request stays valid forever.
  const before = await commentCount();
  const response = await post(reply(), { timestamp: Math.floor(Date.now() / 1000) - 360 });
  assert.equal(response.status, 401);
  assert.match(((await response.json()) as { error: string }).error, /stale/i);
  assert.equal(await commentCount(), before);
});

test('Slack retrying the same message does not comment twice', async () => {
  const payload = reply();
  assert.equal((await post(payload)).status, 200);
  const after = await commentCount();

  const retry = await post(payload);
  assert.equal(retry.status, 200, 'a retry must be accepted, or Slack keeps retrying');
  assert.equal(((await retry.json()) as { duplicate?: boolean }).duplicate, true);
  assert.equal(await commentCount(), after, 'the same Slack message must not become two comments');
});

test('the app own notifications are not treated as replies', async () => {
  // This is the loop: the app posts into the thread, Slack delivers that back,
  // and treating it as a reply would comment on the ticket that produced it.
  const before = await commentCount();
  assert.equal((await post(reply({ bot_id: 'B123', user: undefined }))).status, 200);
  assert.equal((await post(reply({ app_id: 'A123' }))).status, 200);
  assert.equal(await commentCount(), before);
});

test('edits, joins and top-level messages are ignored', async () => {
  const before = await commentCount();
  await post(reply({ subtype: 'message_changed' }));
  await post(reply({ subtype: 'channel_join' }));
  // A message with no thread_ts is a new channel message, not a reply.
  await post(reply({ thread_ts: undefined }));
  // The thread's own root message.
  await post(reply({ ts: THREAD_TS }));
  assert.equal(await commentCount(), before);
});

test('a reply in an unrelated thread is ignored', async () => {
  const before = await commentCount();
  const response = await post(reply({ thread_ts: '1790000000.999999' }));
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { ignored?: boolean }).ignored, true);
  assert.equal(await commentCount(), before);
});

test('an empty message is not stored as a blank comment', async () => {
  const before = await commentCount();
  await post(reply({ text: '   ' }));
  assert.equal(await commentCount(), before);
});
