/**
 * The Teams bot.
 *
 * Teams used to be an incoming webhook, which is a URL you post to and
 * nothing more. This is the endpoint that makes it two-way, so what is
 * checked here is the two-way part: that an unsigned activity is refused,
 * that a mention produces that department's own form, that a submitted card
 * is validated on the server rather than trusted, and that a reply in a
 * ticket's thread becomes a comment on that ticket.
 *
 * The one thing not covered is Microsoft's own handshake - fetching a real
 * JWKS and exchanging real client credentials needs an Azure registration.
 * Both are stubbed at the network boundary; everything this code decides is
 * exercised for real.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'teamsbot.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SECRET_KEY = 'b'.repeat(64);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const APP_ID = '11111111-2222-3333-4444-555555555555';
const SERVICE_URL = 'https://smba.trafficmanager.net/emea/';
const CONVERSATION = '19:abc123@thread.tacv2';
const DATA_DIR = path.resolve(import.meta.dirname, '../data');

/** A throwaway RSA key standing in for Microsoft's signing key. */
const signingKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, `teamsbot.db${suffix}`));
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

/** Mints a token the way Microsoft would, so the real verifier accepts it. */
function mintToken(overrides: Record<string, unknown> = {}): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: KID };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://api.botframework.com',
    aud: APP_ID,
    serviceurl: SERVICE_URL,
    nbf: now - 60,
    exp: now + 3600,
    ...overrides,
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(signingInput), signingKey.privateKey)
    .toString('base64url');
  return `${signingInput}.${signature}`;
}

let server: http.Server;
let base: string;
let db: typeof import('../server/db/index.ts').db;
let financeId = '';
/** The activity that started the test ticket's Teams thread. */
let rootActivityId = '';
let hrId = '';

/** Everything the bot sent back to Teams. */
let sent: Array<{ url: string; body: any }> = [];
/** Roster lookups, keyed by the Teams user id. */
const ROSTER: Record<string, { email?: string; name: string }> = {
  '29:agent': { email: 'agent@acme.test', name: 'Ada Agent' },
  '29:viewer': { email: 'viewer@acme.test', name: 'Vic Viewer' },
  '29:stranger': { email: 'nobody@elsewhere.test', name: 'A Stranger' },
};

const realFetch = globalThis.fetch;

before(async () => {
  wipe();
  ensureClientDist();

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;

    // Microsoft's published signing keys.
    if (url.includes('.well-known/openidconfiguration')) {
      return Response.json({ jwks_uri: 'https://login.botframework.com/v1/.well-known/keys' });
    }
    if (url.includes('botframework.com/v1/.well-known/keys')) {
      const jwk = signingKey.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
      return Response.json({ keys: [{ ...jwk, kid: KID, use: 'sig' }] });
    }
    // The client-credentials exchange.
    if (url.includes('login.microsoftonline.com')) {
      return Response.json({ access_token: 'outbound-token', expires_in: 3600 });
    }
    // The roster: how a Teams id becomes a person here.
    const member = /\/v3\/conversations\/[^/]+\/members\/([^/?]+)$/.exec(url);
    if (member) {
      const person = ROSTER[decodeURIComponent(member[1])];
      if (!person) return new Response('not found', { status: 404 });
      return Response.json(person);
    }
    // Anything else on the service URL is the bot talking back.
    if (url.startsWith(SERVICE_URL) || url.includes('/v3/conversations/')) {
      sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return Response.json({ id: `activity-${sent.length}` });
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
  await addUser('u-viewer', 'viewer@acme.test', 'viewer');

  await db.run('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', [
    'ticket_number',
    1000,
  ]);

  const { createTeam } = await import('../server/repositories/teams.ts');
  financeId = await createTeam({ key: 'finance', name: 'Finance' });
  hrId = await createTeam({ key: 'hr', name: 'People Team' });

  const { replaceTeamForm } = await import('../server/repositories/form-fields.ts');
  await replaceTeamForm(financeId, [
    { label: 'Cost centre', type: 'text', required: true },
    { label: 'Category', type: 'select', required: true, options: ['Invoice', 'Expense'] },
  ]);
  await replaceTeamForm(hrId, [{ label: 'Employee ID', type: 'text', required: true }]);

  const { saveIntegration } = await import('../server/integrations/store.ts');
  await saveIntegration('msteams', {
    enabled: true,
    config: { mode: 'bot', appId: APP_ID, appPassword: 'secret', tenantId: 'tenant-1' },
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

function activity(overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    id: `act-${Math.random().toString(36).slice(2)}`,
    serviceUrl: SERVICE_URL,
    conversation: { id: CONVERSATION, conversationType: 'channel' },
    from: { id: '29:agent', name: 'Ada Agent' },
    recipient: { id: `28:${APP_ID}`, name: 'InfraTicket' },
    channelData: { tenant: { id: 'tenant-1' }, team: { name: 'Ops' }, channel: { name: 'General' } },
    ...overrides,
  };
}

function post(body: unknown, token: string | null = mintToken()) {
  sent = [];
  return fetch(`${base}/api/webhooks/msteams`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** The Adaptive Card in the last thing the bot sent, if there was one. */
function lastCard(): any {
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    const card = sent[i].body?.attachments?.[0]?.content;
    if (card) return card;
  }
  return null;
}

const inputIds = (card: any): string[] =>
  (card?.body ?? []).map((block: any) => block.id).filter(Boolean);

/**
 * The most recent plain-text message the bot sent.
 *
 * Scanned backwards rather than taken from the end: ticket creation fans out
 * to the integrations without being awaited, so a notification card from an
 * earlier test can arrive after `sent` was reset and sit on top of the reply
 * this test is actually about.
 */
function lastText(): string {
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    if (typeof sent[i].body?.text === 'string') return sent[i].body.text;
  }
  return '';
}

test('an activity with no token is refused', async () => {
  const response = await post(activity({ text: 'finance' }), null);
  assert.equal(response.status, 401);
  assert.equal(sent.length, 0);
});

test('a token signed by someone else is refused', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: KID })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(
    JSON.stringify({ aud: APP_ID, serviceurl: SERVICE_URL, exp: now + 3600, nbf: now - 60 }),
  ).toString('base64url');
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), other.privateKey)
    .toString('base64url');

  const response = await post(activity({ text: 'finance' }), `${header}.${claims}.${signature}`);
  assert.equal(response.status, 401);
});

test('a token minted for a different bot is refused', async () => {
  // Correctly signed by Microsoft, but for somebody else's app. Without the
  // audience check this would pass.
  const response = await post(activity({ text: 'finance' }), mintToken({ aud: 'another-bot-app-id' }));
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /not issued for this bot/i);
});

test('an expired token is refused', async () => {
  const past = Math.floor(Date.now() / 1000) - 7200;
  const response = await post(activity({ text: 'finance' }), mintToken({ exp: past, nbf: past - 60 }));
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /expired/i);
});

test('a token pointing at a different service URL is refused', async () => {
  // Otherwise a valid token from elsewhere could redirect the bot's outbound
  // calls, and its access token with them.
  const response = await post(
    activity({ text: 'finance' }),
    mintToken({ serviceurl: 'https://attacker.example.com/' }),
  );
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /service URL/i);
});

test('an activity from another tenant is refused', async () => {
  const response = await post(
    activity({ text: 'finance', channelData: { tenant: { id: 'someone-elses-tenant' } } }),
  );
  assert.equal(response.status, 403);
});

test('being added to a channel is remembered and acknowledged', async () => {
  const response = await post(
    activity({ type: 'conversationUpdate', membersAdded: [{ id: `28:${APP_ID}` }] }),
  );
  assert.equal(response.status, 200);

  const { findConversation } = await import('../server/repositories/teams-conversations.ts');
  const stored = await findConversation(CONVERSATION);
  assert.ok(stored, 'the conversation was not recorded, so nothing could ever be posted to it');
  assert.equal(stored!.serviceUrl, SERVICE_URL);

  assert.ok(sent.length > 0, 'the bot said nothing when it was installed');
  assert.match(lastText(), /finance/i, 'the welcome did not say which departments exist');
});

test('mentioning the bot with a department posts that department’s form', async () => {
  const response = await post(activity({ text: '<at>InfraTicket</at> finance' }));
  assert.equal(response.status, 200);

  const card = lastCard();
  assert.ok(card, 'no card was posted');
  const ids = inputIds(card);
  assert.ok(ids.includes('subject'));
  assert.ok(ids.includes('field:cost_centre'), `expected Finance fields, got ${ids.join(', ')}`);
  assert.ok(!ids.includes('field:employee_id'), "another department's question leaked in");

  // The submit action carries the department, so the submission cannot lie
  // about which form it came from without being re-validated anyway.
  assert.equal(card.actions[0].data.teamId, financeId);
});

test('mentioning the bot with no department lists them instead of failing', async () => {
  const response = await post(activity({ text: '<at>InfraTicket</at>' }));
  assert.equal(response.status, 200);
  assert.match(lastText(), /finance/i);
  assert.match(lastText(), /hr/i);
});

test('the bot ignores its own messages', async () => {
  // A bot hearing itself and answering is an infinite loop.
  const response = await post(activity({ from: { id: `28:${APP_ID}`, name: 'InfraTicket' }, text: 'finance' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, ignored: true });
});

test('someone without permission is refused, in the thread', async () => {
  const response = await post(activity({ from: { id: '29:viewer', name: 'Vic' }, text: '<at>x</at> finance' }));
  assert.equal(response.status, 200);
  assert.match(lastText(), /do not have permission/i);
  assert.equal(lastCard(), null, 'a form was offered to someone who cannot use it');
});

test('someone with no account here is told what to do about it', async () => {
  const response = await post(activity({ from: { id: '29:stranger', name: 'Stranger' }, text: '<at>x</at> finance' }));
  assert.equal(response.status, 200);
  assert.match(lastText(), /not linked to a user here/i);
});

const cardSubmission = (value: Record<string, unknown> = {}) =>
  activity({
    text: '',
    value: {
      action: 'infraticket_new',
      teamId: financeId,
      subject: 'Duplicate invoice from Acme',
      description: 'We appear to have paid it twice.',
      priority: 'high',
      'field:cost_centre': 'CC-4471',
      'field:category': 'Invoice',
      ...value,
    },
  });

test('a submitted card raises a ticket against the right department', async () => {
  const response = await post(cardSubmission());
  assert.equal(response.status, 200);

  const row = await db.get<{ id: string; subject: string; team_id: string; priority: string; source: string }>(
    `SELECT id, subject, team_id, priority, source FROM tickets ORDER BY created_at DESC LIMIT 1`,
  );
  assert.equal(row!.subject, 'Duplicate invoice from Acme');
  assert.equal(row!.team_id, financeId);
  assert.equal(row!.priority, 'high');
  assert.equal(row!.source, 'msteams');

  const { listAnswers } = await import('../server/repositories/form-fields.ts');
  const answers = Object.fromEntries((await listAnswers(row!.id)).map((a) => [a.key, a.value]));
  assert.equal(answers.cost_centre, 'CC-4471');
  assert.equal(answers.category, 'Invoice');

  // And the person is told, in the thread, with a link.
  const card = lastCard();
  assert.match(card.body[0].text, /Raised ESC-\d+/);
  assert.equal(card.actions[0].type, 'Action.OpenUrl');
});

test('a card claiming a choice that was never offered is refused', async () => {
  // The card is a convenience, not a control: Adaptive Cards validate in the
  // client only, and this is an HTTP request that can say anything.
  const before = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n);

  const response = await post(cardSubmission({ 'field:category': 'Embezzlement' }));
  assert.equal(response.status, 200);
  assert.match(lastText(), /Category/i);

  const after = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n);
  assert.equal(after, before, 'an invalid answer was accepted');
});

test('a card missing a required answer is refused', async () => {
  const before = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n);
  const value = { ...cardSubmission().value } as Record<string, unknown>;
  delete value['field:cost_centre'];

  const response = await post(activity({ text: '', value }));
  assert.equal(response.status, 200);

  const after = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n);
  assert.equal(after, before);
  assert.match(lastText(), /required/i);
});

test('a viewer cannot raise a ticket by posting a card submission directly', async () => {
  const before = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n);
  const payload = cardSubmission();
  payload.from = { id: '29:viewer', name: 'Vic' };

  await post(payload);

  const after = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n);
  assert.equal(after, before, 'a viewer got a ticket through the back door');
});

test('a reply in a ticket’s thread becomes a comment on that ticket', async () => {
  const ticket = await db.get<{ id: string }>(`SELECT id FROM tickets WHERE subject = ?`, [
    'Duplicate invoice from Acme',
  ]);

  /*
   * The thread is the one the ticket's own notification created when it was
   * raised, not a fabricated row: that is what a real reply would be
   * answering, and it proves the notification recorded its thread at all.
   */
  const link = await db.get<{ external_id: string }>(
    `SELECT external_id FROM ticket_links WHERE provider = 'msteams' AND ticket_id = ?`,
    [ticket!.id],
  );
  assert.ok(link, 'raising the ticket did not record a Teams thread to reply to');
  rootActivityId = link!.external_id;

  const before = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ticket_comments`))!.n);
  const response = await post(
    activity({ id: 'reply-1', replyToId: rootActivityId, text: '<p>Engineer booked for Tuesday.</p>' }),
  );
  assert.equal(response.status, 200);

  const after = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ticket_comments`))!.n);
  assert.equal(after, before + 1, 'the reply did not become a comment');

  const comment = await db.get<{ body: string; body_format: string; is_internal: number; author_id: string }>(
    `SELECT body, body_format, is_internal, author_id FROM ticket_comments ORDER BY created_at DESC LIMIT 1`,
  );
  // The HTML Teams sends is flattened, not stored as markup.
  assert.equal(comment!.body, 'Engineer booked for Tuesday.');
  assert.equal(comment!.body_format, 'text');
  assert.equal(comment!.is_internal, 0);
  assert.equal(comment!.author_id, 'u-agent', 'the reply was not attributed to the right person');
});

test('a redelivered reply does not become a second comment', async () => {
  const before = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ticket_comments`))!.n);
  // Microsoft retries on its own timeouts; the activity id is what stops it.
  await post(activity({ id: 'reply-1', replyToId: rootActivityId, text: '<p>Engineer booked for Tuesday.</p>' }));

  const after = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ticket_comments`))!.n);
  assert.equal(after, before, 'a retry created a duplicate comment');
});

test('a notification threads onto the ticket’s existing Teams message', async () => {
  const { loadIntegration } = await import('../server/integrations/store.ts');
  const { sendMsTeams } = await import('../server/integrations/msteams.ts');
  const { findTicket } = await import('../server/repositories/tickets.ts');

  const row = await db.get<{ id: string }>(`SELECT id FROM tickets WHERE subject = ?`, [
    'Duplicate invoice from Acme',
  ]);
  const ticket = await findTicket(row!.id, 'ESC');

  sent = [];
  const result = await sendMsTeams(await loadIntegration('msteams'), {
    event: 'ticketStatusChanged',
    ticket: ticket!,
    actorName: 'Ada Agent',
    headline: 'Moved to in progress',
    ticketUrl: 'https://example.internal/tickets/1',
  });

  assert.equal(result.ok, true, result.error ?? '');
  // Posting to .../activities/root-activity-1 is what makes it a reply rather
  // than a new thread scattered down the channel.
  assert.ok(
    sent.at(-1)!.url.endsWith(`/activities/${rootActivityId}`),
    `expected a reply to ${rootActivityId}, got ${sent.at(-1)!.url}`,
  );
});
