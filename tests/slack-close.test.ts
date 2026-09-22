/**
 * Closing and reopening a ticket from the buttons on its Slack message.
 *
 * The buttons sit in a channel, so anyone who can see the channel can press
 * one. A click therefore proves nothing by itself, and most of what is
 * checked here is who the endpoint refuses: a click has to be traced back to
 * an active account here that is allowed to change a ticket's status.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'slackclose.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SECRET_KEY = 'b'.repeat(64);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const SIGNING_SECRET = 'test-signing-secret';
const RESPONSE_URL = 'https://hooks.slack.com/actions/T1/response-url';
const DATA_DIR = path.resolve(import.meta.dirname, '../data');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, `slackclose.db${suffix}`));
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

/** Whatever was last said back to the person who clicked. */
let ephemeral: string[] = [];

/**
 * Slack's own API is stubbed rather than reached.
 *
 * Only two calls matter: users.info, which is how a Slack id becomes a person
 * here, and the one-use response_url the reply goes to. Everything else is
 * passed through so the local server is still talked to for real.
 */
const SLACK_PEOPLE: Record<string, { email?: string; real_name: string }> = {
  U_AGENT: { email: 'agent@acme.test', real_name: 'Ada Agent' },
  U_VIEWER: { email: 'viewer@acme.test', real_name: 'Vic Viewer' },
  U_SUSPENDED: { email: 'gone@acme.test', real_name: 'Sam Gone' },
  U_STRANGER: { email: 'stranger@elsewhere.test', real_name: 'A Stranger' },
};

const realFetch = globalThis.fetch;

before(async () => {
  wipe();
  ensureClientDist();

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;

    if (url.startsWith('https://slack.com/api/users.info')) {
      const id = new URL(url).searchParams.get('user') ?? '';
      const person = SLACK_PEOPLE[id];
      if (!person) return Response.json({ ok: false, error: 'user_not_found' });
      return Response.json({ ok: true, user: { real_name: person.real_name, profile: { email: person.email } } });
    }
    if (url === RESPONSE_URL) {
      ephemeral.push(JSON.parse(String(init?.body ?? '{}')).text ?? '');
      return new Response('ok');
    }
    // Any other slack.com call (chat.postMessage from the dispatcher) is a
    // no-op success, so the fan-out does not fail the test.
    if (url.startsWith('https://slack.com/api/')) return Response.json({ ok: true, ts: '1.2' });

    return realFetch(input, init);
  }) as typeof fetch;

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const now = new Date().toISOString();
  const { hash, salt } = hashPassword('irrelevant');

  const addUser = (id: string, email: string, role: string, status: string) =>
    db.run(
      'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, email, id.toLowerCase(), `Name ${id}`, hash, salt, role, status, '#9a7b2f', 0, now, now],
    );

  await addUser('u-agent', 'agent@acme.test', 'agent', 'active');
  // A viewer has tickets.view but not tickets.update.
  await addUser('u-viewer', 'viewer@acme.test', 'viewer', 'active');
  await addUser('u-gone', 'gone@acme.test', 'admin', 'suspended');
  await addUser('u-req', 'requester@acme.test', 'agent', 'active');

  await db.run('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', [
    'ticket_number',
    1000,
  ]);
  await db.run(
    `INSERT INTO tickets (id, number, subject, description, description_format, requester_id, status, priority, type, source, tags, escalation_level, created_at, updated_at)
     VALUES ('tkt-1', 4242, 'Payments failing', '', 'text', 'u-req', 'open', 'high', 'incident', 'web', '[]', 0, ?, ?)`,
    [now, now],
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
  globalThis.fetch = realFetch;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await db.close();
  wipe();
});

/** A button click, form-encoded and signed the way Slack sends one. */
function click(
  actionId: string,
  slackUserId: string,
  options: { secret?: string; timestamp?: number; ticketId?: string } = {},
) {
  const payload = JSON.stringify({
    type: 'block_actions',
    user: { id: slackUserId },
    channel: { id: 'C0BU8RYNT8T' },
    response_url: RESPONSE_URL,
    actions: [{ action_id: actionId, value: options.ticketId ?? 'tkt-1' }],
  });
  const raw = new URLSearchParams({ payload }).toString();
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const signature =
    'v0=' +
    crypto
      .createHmac('sha256', options.secret ?? SIGNING_SECRET)
      .update(`v0:${timestamp}:${raw}`)
      .digest('hex');

  ephemeral = [];
  return fetch(`${base}/api/webhooks/slack/interactive`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-signature': signature,
      'x-slack-request-timestamp': String(timestamp),
    },
    body: raw,
  });
}

const statusOf = async () =>
  (await db.get<{ status: string; closed_at: string | null; resolved_at: string | null }>(
    `SELECT status, closed_at, resolved_at FROM tickets WHERE id = 'tkt-1'`,
  ))!;

async function setStatus(status: string) {
  await db.run(`UPDATE tickets SET status = ?, closed_at = NULL, resolved_at = NULL WHERE id = 'tkt-1'`, [status]);
}

test('an unsigned click changes nothing', async () => {
  const response = await fetch(`${base}/api/webhooks/slack/interactive`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ payload: '{}' }).toString(),
  });
  assert.equal(response.status, 401);
  assert.equal((await statusOf()).status, 'open');
});

test('a click signed with the wrong secret changes nothing', async () => {
  const response = await click('ticket_close', 'U_AGENT', { secret: 'wrong' });
  assert.equal(response.status, 401);
  assert.equal((await statusOf()).status, 'open');
});

test('a correctly signed but stale click changes nothing', async () => {
  const response = await click('ticket_close', 'U_AGENT', { timestamp: Math.floor(Date.now() / 1000) - 400 });
  assert.equal(response.status, 401);
  assert.equal((await statusOf()).status, 'open');
});

test('someone with no account here cannot close a ticket', async () => {
  const response = await click('ticket_close', 'U_STRANGER');
  assert.equal(response.status, 200, 'a non-2xx makes Slack retry the same click');
  assert.equal((await statusOf()).status, 'open');
  assert.match(ephemeral.join(' '), /not linked to a user here/i);
});

test('a suspended account cannot close a ticket', async () => {
  const response = await click('ticket_close', 'U_SUSPENDED');
  assert.equal(response.status, 200);
  assert.equal((await statusOf()).status, 'open');
  assert.match(ephemeral.join(' '), /no longer active/i);
});

test('an account without permission to update tickets cannot close one', async () => {
  const response = await click('ticket_close', 'U_VIEWER');
  assert.equal(response.status, 200);
  assert.equal((await statusOf()).status, 'open', 'a viewer closed a ticket from Slack');
  assert.match(ephemeral.join(' '), /do not have permission/i);
});

test('an agent closes the ticket and is told so privately', async () => {
  const response = await click('ticket_close', 'U_AGENT');
  assert.equal(response.status, 200, await response.clone().text());

  const ticket = await statusOf();
  assert.equal(ticket.status, 'closed');
  assert.ok(ticket.closed_at, 'closed_at drives the SLA report and must be stamped');
  assert.match(ephemeral.join(' '), /ESC-4242 is now \*closed\*/);
});

test('closing tells the people waiting on the ticket', async () => {
  const row = await db.get<{ n: number; title: string }>(
    `SELECT COUNT(*) AS n, MAX(title) AS title FROM notifications WHERE user_id = 'u-req'`,
  );
  assert.ok(Number(row!.n) > 0, 'the requester should hear that their ticket was closed');
  assert.match(row!.title, /ESC-4242 closed/);
});

test('closing is written to the audit trail with the person who did it', async () => {
  const row = await db.get<{ summary: string; actor_id: string }>(
    `SELECT summary, actor_id FROM audit_log WHERE action = 'status_changed_from_slack' ORDER BY created_at DESC LIMIT 1`,
  );
  assert.ok(row, 'a status change from Slack must be auditable');
  assert.equal(row!.actor_id, 'u-agent');
  assert.match(row!.summary, /moved ESC-4242 to closed from Slack/);
});

test('clicking close again says so rather than logging a second change', async () => {
  const before = Number(
    (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ticket_events WHERE field = 'status'`))!.n,
  );
  const response = await click('ticket_close', 'U_AGENT');
  assert.equal(response.status, 200);

  const after = Number(
    (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ticket_events WHERE field = 'status'`))!.n,
  );
  assert.equal(after, before, 'a repeated click recorded a second status change');
  assert.match(ephemeral.join(' '), /already closed/i);
});

test('reopening clears the timestamps the SLA report reads', async () => {
  const response = await click('ticket_reopen', 'U_AGENT');
  assert.equal(response.status, 200);

  const ticket = await statusOf();
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.closed_at, null, 'a reopened ticket still counted as finished');
  assert.equal(ticket.resolved_at, null);
});

test('resolving stamps resolved_at and leaves the ticket resolvable-to-closed', async () => {
  await setStatus('open');
  await click('ticket_resolve', 'U_AGENT');
  const resolved = await statusOf();
  assert.equal(resolved.status, 'resolved');
  assert.ok(resolved.resolved_at);

  await click('ticket_close', 'U_AGENT');
  const closed = await statusOf();
  assert.equal(closed.status, 'closed');
  assert.ok(closed.closed_at);
  assert.ok(closed.resolved_at, 'closing a resolved ticket must not wipe when it was resolved');
});

test('a click naming a ticket that does not exist is acknowledged, not retried', async () => {
  const response = await click('ticket_close', 'U_AGENT', { ticketId: 'no-such-ticket' });
  assert.equal(response.status, 200);
  assert.match(ephemeral.join(' '), /no longer exists/i);
});

test('an action this app does not own is ignored', async () => {
  const response = await click('some_other_apps_button', 'U_AGENT');
  assert.equal(response.status, 200);
  assert.deepEqual(ephemeral, [], 'a button belonging to another app was answered');
});
