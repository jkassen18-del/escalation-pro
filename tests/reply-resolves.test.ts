/**
 * Resolving a ticket by answering it in Slack or Linear.
 *
 * The department replies where it already works, and a reply that says the
 * work is done resolves the ticket. Most replies are not that, and anyone in
 * the channel can type "done", so what is checked here is mostly what does
 * *not* resolve a ticket: questions, strangers, people without permission,
 * and this app's own comments coming back from Linear.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { saysResolved } from '../server/integrations/resolve-intent.ts';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'replyresolves.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SECRET_KEY = 'b'.repeat(64);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const SLACK_SECRET = 'test-signing-secret';
const LINEAR_SECRET = 'linear-webhook-secret';
const CHANNEL = 'C0BU8RYNT8T';
const DATA_DIR = path.resolve(import.meta.dirname, '../data');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, `replyresolves.db${suffix}`));
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

/** Private messages sent to someone in Slack with chat.postEphemeral. */
let ephemeral: Array<{ user: string; text: string }> = [];

const SLACK_PEOPLE: Record<string, { email: string; real_name: string }> = {
  U_AGENT: { email: 'agent@acme.test', real_name: 'Ada Agent' },
  U_VIEWER: { email: 'viewer@acme.test', real_name: 'Vic Viewer' },
  U_STRANGER: { email: 'stranger@elsewhere.test', real_name: 'A Stranger' },
};
const LINEAR_PEOPLE: Record<string, { email: string; name: string }> = {
  'lin-agent': { email: 'agent@acme.test', name: 'Ada Agent' },
  'lin-viewer': { email: 'viewer@acme.test', name: 'Vic Viewer' },
};

const realFetch = globalThis.fetch;

before(async () => {
  wipe();
  ensureClientDist();

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;

    if (url.startsWith('https://slack.com/api/users.info')) {
      const person = SLACK_PEOPLE[new URL(url).searchParams.get('user') ?? ''];
      if (!person) return Response.json({ ok: false, error: 'user_not_found' });
      return Response.json({ ok: true, user: { real_name: person.real_name, profile: { email: person.email } } });
    }
    if (url === 'https://slack.com/api/chat.postEphemeral') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      ephemeral.push({ user: body.user, text: body.text });
      return Response.json({ ok: true });
    }
    if (url.startsWith('https://slack.com/api/')) return Response.json({ ok: true, ts: '1.2' });

    if (url.startsWith('https://api.linear.app/')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (String(body.query).includes('user(id:')) {
        const person = LINEAR_PEOPLE[body.variables?.id];
        return Response.json({ data: { user: person ?? null } });
      }
      return Response.json({ data: { commentCreate: { success: true } } });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const now = new Date().toISOString();
  const { hash, salt } = hashPassword('irrelevant');
  const addUser = (id: string, email: string, role: string) =>
    db.run(
      'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, email, id.toLowerCase(), `Name ${id}`, hash, salt, role, 'active', '#9a7b2f', 0, now, now],
    );
  await addUser('u-agent', 'agent@acme.test', 'agent');
  // A viewer can see tickets but not change their status.
  await addUser('u-viewer', 'viewer@acme.test', 'viewer');
  await addUser('u-req', 'requester@acme.test', 'agent');

  await db.run('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', ['ticket_number', 1000]);

  const { saveIntegration } = await import('../server/integrations/store.ts');
  await saveIntegration('slack', {
    enabled: true,
    config: { mode: 'bot', botToken: 'xoxb-not-real', channel: CHANNEL, signingSecret: SLACK_SECRET },
  });
  await saveIntegration('linear', {
    enabled: true,
    config: { apiKey: ['lin', 'api', 'test'].join('_'), teamId: 'lin-team', webhookSecret: LINEAR_SECRET },
  });

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await db.close();
  wipe();
});

/* --------------------------------- helpers -------------------------------- */

let counter = 0;

/** A fresh open ticket, with a Slack thread and a Linear issue of its own. */
async function newTicket(status = 'open') {
  counter += 1;
  const id = `tkt-${counter}`;
  const thread = `17900000${counter}.000100`;
  const issue = `lin-issue-${counter}`;
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO tickets (id, number, subject, description, description_format, requester_id, status, priority, type, source, tags, escalation_level, created_at, updated_at)
     VALUES (?, ?, 'Payments failing', '', 'text', 'u-req', ?, 'high', 'incident', 'web', '[]', 0, ?, ?)`,
    [id, 5000 + counter, status, now, now],
  );
  await db.run(
    `INSERT INTO ticket_links (id, ticket_id, provider, external_id, external_key, url, created_at)
     VALUES (?, ?, 'slack', ?, ?, 'https://slack.com/archives/x', ?)`,
    [`sl-${id}`, id, thread, CHANNEL, now],
  );
  await db.run(
    `INSERT INTO ticket_links (id, ticket_id, provider, external_id, external_key, url, created_at)
     VALUES (?, ?, 'linear', ?, 'FIN-1', 'https://linear.app/x', ?)`,
    [`li-${id}`, id, issue, now],
  );
  return { id, thread, issue };
}

const statusOf = async (id: string) =>
  (await db.get<{ status: string }>(`SELECT status FROM tickets WHERE id = ?`, [id]))!.status;
const commentsOn = async (id: string) =>
  (await db.all<{ body: string; author_id: string | null }>(
    `SELECT body, author_id FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at`,
    [id],
  ));

function postSlack(body: unknown) {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature =
    'v0=' + crypto.createHmac('sha256', SLACK_SECRET).update(`v0:${timestamp}:${raw}`).digest('hex');
  return fetch(`${base}/api/webhooks/slack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-slack-signature': signature, 'x-slack-request-timestamp': String(timestamp) },
    body: raw,
  });
}

const slackReply = (thread: string, text: string, user = 'U_AGENT') =>
  postSlack({
    type: 'event_callback',
    event: { type: 'message', text, user, ts: `1790${Math.floor(Math.random() * 1e9)}.000200`, thread_ts: thread, channel: CHANNEL },
  });

const slackReaction = (ts: string, reaction: string, user = 'U_AGENT') =>
  postSlack({
    type: 'event_callback',
    event: { type: 'reaction_added', user, reaction, item: { type: 'message', channel: CHANNEL, ts } },
  });

function postLinear(body: unknown) {
  const raw = JSON.stringify(body);
  return fetch(`${base}/api/webhooks/linear`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'linear-signature': crypto.createHmac('sha256', LINEAR_SECRET).update(raw).digest('hex'),
    },
    body: raw,
  });
}

const linearComment = (issueId: string, body: string, userId = 'lin-agent', extra: Record<string, unknown> = {}) =>
  postLinear({
    action: 'create',
    type: 'Comment',
    data: { id: crypto.randomUUID(), body, issueId, userId, user: { id: userId, name: 'From Linear' }, ...extra },
  });

/* ------------------------------ the wording ------------------------------- */

test('a reply that starts by saying it is done counts', () => {
  for (const text of [
    'Fixed - restarted the payment worker',
    'Resolved.',
    'done',
    'Done! Let us know if it comes back.',
    'Sorted, the card was re-issued',
    '#resolve',
    '✅ worker restarted',
    ':white_check_mark: all good',
  ]) {
    assert.equal(saysResolved(text), true, text);
  }
});

test('questions, hedges and passing mentions do not', () => {
  for (const text of [
    'Fixed?',
    'Done? Still seeing it here',
    'Have you fixed it?',
    'Not fixed yet, still looking',
    'Looking into it now',
    'I think this is resolved but will confirm',
    'Can you send a screenshot?',
    '',
  ]) {
    assert.equal(saysResolved(text), false, text);
  }
});

/* --------------------------------- Slack ---------------------------------- */

test('Slack: an agent replying "Fixed ..." resolves the ticket and keeps the reply', async () => {
  const t = await newTicket();
  const response = await slackReply(t.thread, 'Fixed - restarted the payment worker');
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { resolved?: string }).resolved, 'resolved');

  assert.equal(await statusOf(t.id), 'resolved');
  const resolvedAt = await db.get<{ resolved_at: string | null }>(`SELECT resolved_at FROM tickets WHERE id = ?`, [t.id]);
  assert.ok(resolvedAt!.resolved_at, 'the SLA report reads resolved_at, so it must be stamped');
  assert.match((await commentsOn(t.id))[0].body, /restarted the payment worker/);

  const audit = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'status_changed_from_slack'`,
    [t.id],
  );
  assert.equal(Number(audit!.n), 1);
});

test('Slack: an ordinary reply is only a comment', async () => {
  const t = await newTicket();
  await slackReply(t.thread, 'Looking into it, will update shortly');
  assert.equal(await statusOf(t.id), 'open');
  assert.equal((await commentsOn(t.id)).length, 1);
});

test('Slack: "done" from someone without permission is kept but does not resolve, and they are told', async () => {
  for (const user of ['U_VIEWER', 'U_STRANGER']) {
    const t = await newTicket();
    ephemeral = [];
    const response = await slackReply(t.thread, 'Done', user);
    assert.equal(((await response.json()) as { resolved?: string }).resolved, 'refused');
    assert.equal(await statusOf(t.id), 'open', `${user} must not be able to resolve`);
    assert.equal((await commentsOn(t.id)).length, 1, 'the reply itself is still worth keeping');
    assert.equal(ephemeral.length, 1);
    assert.equal(ephemeral[0].user, user);
    assert.match(ephemeral[0].text, /was not resolved/);
  }
});

test('Slack: a tick on the ticket message resolves it', async () => {
  const t = await newTicket();
  const response = await slackReaction(t.thread, 'white_check_mark');
  assert.equal(response.status, 200);
  assert.equal(await statusOf(t.id), 'resolved');
});

test('Slack: a tick on a reply in the thread resolves it too', async () => {
  const t = await newTicket();
  const replyTs = '1791234567.000900';
  await postSlack({
    type: 'event_callback',
    event: { type: 'message', text: 'Restarted it', user: 'U_AGENT', ts: replyTs, thread_ts: t.thread, channel: CHANNEL },
  });
  assert.equal(await statusOf(t.id), 'open');

  await slackReaction(replyTs, 'heavy_check_mark');
  assert.equal(await statusOf(t.id), 'resolved');
});

test('Slack: other reactions, and ticks from people without permission, change nothing', async () => {
  const t = await newTicket();
  await slackReaction(t.thread, 'eyes');
  assert.equal(await statusOf(t.id), 'open');

  ephemeral = [];
  await slackReaction(t.thread, 'white_check_mark', 'U_VIEWER');
  assert.equal(await statusOf(t.id), 'open');
  assert.equal(ephemeral.length, 1);
});

test('Slack: "done" on a closed ticket does not move it back to resolved', async () => {
  const t = await newTicket('closed');
  await slackReply(t.thread, 'Done');
  await slackReaction(t.thread, 'white_check_mark');
  assert.equal(await statusOf(t.id), 'closed');
});

/* --------------------------------- Linear --------------------------------- */

test('Linear: a comment on the issue becomes a comment on the ticket, attributed by email', async () => {
  const t = await newTicket();
  const response = await linearComment(t.issue, 'Checking the logs now');
  assert.equal(response.status, 200);

  const comments = await commentsOn(t.id);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, 'Checking the logs now');
  assert.equal(comments[0].author_id, 'u-agent');
  assert.equal(await statusOf(t.id), 'open');

  const note = await db.get<{ title: string }>(
    `SELECT title FROM notifications WHERE user_id = 'u-req' AND ticket_id = ? ORDER BY created_at DESC LIMIT 1`,
    [t.id],
  );
  assert.match(note!.title, /replied to .* in Linear/);
});

test('Linear: "Fixed ..." from an agent resolves the ticket', async () => {
  const t = await newTicket();
  await linearComment(t.issue, 'Fixed. The worker is back up.');
  assert.equal(await statusOf(t.id), 'resolved');
});

test('Linear: "Fixed" from someone without permission, or with no account here, stays a comment', async () => {
  for (const userId of ['lin-viewer', 'lin-nobody']) {
    const t = await newTicket();
    await linearComment(t.issue, 'Fixed', userId);
    assert.equal(await statusOf(t.id), 'open', userId);
    const comments = await commentsOn(t.id);
    assert.equal(comments.length, 1);
    if (userId === 'lin-nobody') assert.match(comments[0].body, /From Linear commented in Linear/);
  }
});

test('Linear: a comment this app posted does not come back as a second comment', async () => {
  const t = await newTicket();
  const ours = crypto.randomUUID();
  await db.run(
    `INSERT INTO ticket_links (id, ticket_id, provider, external_id, external_key, url, created_at)
     VALUES (?, ?, 'linear_comment', ?, NULL, '', ?)`,
    [`lc-${ours}`, t.id, ours, new Date().toISOString()],
  );

  await postLinear({ action: 'create', type: 'Comment', data: { id: ours, body: 'Done', issueId: t.issue, userId: 'lin-agent' } });
  assert.equal((await commentsOn(t.id)).length, 0);
  assert.equal(await statusOf(t.id), 'open', 'our own mirrored "Done" must not resolve anything');
});

test('Linear: a retried delivery is recorded once', async () => {
  const t = await newTicket();
  const payload = { action: 'create', type: 'Comment', data: { id: crypto.randomUUID(), body: 'On it', issueId: t.issue, userId: 'lin-agent' } };
  await postLinear(payload);
  await postLinear(payload);
  assert.equal((await commentsOn(t.id)).length, 1);
});

test('Linear: notes from other integrations are ignored', async () => {
  const t = await newTicket();
  await linearComment(t.issue, 'Done: deployed to production', 'lin-agent', { botActor: { name: 'GitHub' } });
  assert.equal((await commentsOn(t.id)).length, 0);
  assert.equal(await statusOf(t.id), 'open');
});

test('Linear: a bad signature is refused', async () => {
  const t = await newTicket();
  const response = await fetch(`${base}/api/webhooks/linear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'linear-signature': 'nope' },
    body: JSON.stringify({ action: 'create', type: 'Comment', data: { id: 'x', body: 'Done', issueId: t.issue } }),
  });
  assert.equal(response.status, 401);
  assert.equal(await statusOf(t.id), 'open');
});
