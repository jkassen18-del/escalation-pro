/**
 * An issue raised in Linear becoming a ticket here.
 *
 * Linear has no slash commands for third-party apps, so this is the
 * equivalent: somebody working in Linear raises an issue the normal way and
 * it turns up as a ticket. The risk in any two-way sync is the loop - an
 * issue this app created must not come back as a second ticket - so that is
 * most of what is checked.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'linearin.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SECRET_KEY = 'b'.repeat(64);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const WEBHOOK_SECRET = 'linear-webhook-secret';
const LINEAR_FINANCE = 'lin-team-finance';
const DATA_DIR = path.resolve(import.meta.dirname, '../data');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, `linearin.db${suffix}`));
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
let financeId = '';

const realFetch = globalThis.fetch;

before(async () => {
  wipe();
  ensureClientDist();

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.linear.app/')) {
      // The actor lookup: Linear's webhook carries an id, not an email.
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (String(body.query).includes('user(id:')) {
        return Response.json(
          body.variables?.id === 'lin-user-ada'
            ? { data: { user: { email: 'agent@acme.test', name: 'Ada Agent' } } }
            : { data: { user: null } },
        );
      }
      return Response.json({ data: {} });
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
  await addUser('u-admin', 'admin@acme.test', 'admin');
  await addUser('u-agent', 'agent@acme.test', 'agent');

  await db.run('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', [
    'ticket_number',
    1000,
  ]);

  const { createTeam } = await import('../server/repositories/teams.ts');
  financeId = await createTeam({ key: 'finance', name: 'Finance' });

  // The department ↔ Linear team mapping, which is read in both directions.
  const { setTeamRoute } = await import('../server/repositories/team-routing.ts');
  await setTeamRoute(financeId, 'linear', LINEAR_FINANCE);

  const { saveIntegration } = await import('../server/integrations/store.ts');
  await saveIntegration('linear', {
    enabled: true,
    config: { apiKey: ['lin', 'api', 'test'].join('_'), teamId: LINEAR_FINANCE, webhookSecret: WEBHOOK_SECRET },
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

function post(payload: unknown, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return fetch(`${base}/api/webhooks/linear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'linear-signature': signature },
    body: raw,
  });
}

const issueCreated = (data: Record<string, unknown> = {}) => ({
  action: 'create',
  type: 'Issue',
  data: {
    id: 'lin-issue-1',
    identifier: 'FIN-42',
    title: 'Supplier invoice looks wrong',
    description: 'The VAT line does not add up.',
    priority: 2,
    teamId: LINEAR_FINANCE,
    creatorId: 'lin-user-ada',
    ...data,
  },
});

const ticketCount = async () =>
  Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n);

test('an unsigned webhook is refused', async () => {
  const before = await ticketCount();
  const response = await fetch(`${base}/api/webhooks/linear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(issueCreated()),
  });
  assert.equal(response.status, 401);
  assert.equal(await ticketCount(), before);
});

test('a wrongly signed webhook is refused', async () => {
  const before = await ticketCount();
  const response = await post(issueCreated(), 'not-the-secret');
  assert.equal(response.status, 401);
  assert.equal(await ticketCount(), before);
});

test('an issue in a mapped Linear team becomes a ticket for that department', async () => {
  const response = await post(issueCreated());
  assert.equal(response.status, 200, await response.clone().text());

  const row = await db.get<{ id: string; subject: string; team_id: string; priority: string; requester_id: string }>(
    `SELECT id, subject, team_id, priority, requester_id FROM tickets ORDER BY created_at DESC LIMIT 1`,
  );
  assert.equal(row!.subject, 'Supplier invoice looks wrong');
  assert.equal(row!.team_id, financeId, 'the ticket did not go to the mapped department');
  // Linear's 2 is our "high".
  assert.equal(row!.priority, 'high');
  assert.equal(row!.requester_id, 'u-agent', 'the issue was not attributed to its Linear author');
});

test('the ticket is linked to the issue it came from', async () => {
  const link = await db.get<{ ticket_id: string; external_key: string }>(
    `SELECT ticket_id, external_key FROM ticket_links WHERE provider = 'linear' AND external_id = 'lin-issue-1'`,
  );
  assert.ok(link, 'without a link the same issue would raise a ticket again on the next webhook');
  assert.equal(link!.external_key, 'FIN-42');
});

test('a redelivered create does not raise a second ticket', async () => {
  const before = await ticketCount();
  await post(issueCreated());
  assert.equal(await ticketCount(), before, 'the same issue raised two tickets');
});

test('an issue in an unmapped Linear team is left alone', async () => {
  // Better than dumping it into a default queue nobody is watching.
  const before = await ticketCount();
  const response = await post(issueCreated({ id: 'lin-issue-2', teamId: 'lin-team-nobody-mapped' }));
  assert.equal(response.status, 200);
  assert.equal(await ticketCount(), before);
});

test('an issue from a Linear user with no account here is still raised', async () => {
  const before = await ticketCount();
  const response = await post(
    issueCreated({ id: 'lin-issue-3', identifier: 'FIN-43', creatorId: 'lin-user-unknown' }),
  );
  assert.equal(response.status, 200);
  assert.equal(await ticketCount(), before + 1, 'the issue was dropped because its author is unknown');

  const row = await db.get<{ requester_id: string; description: string }>(
    `SELECT requester_id, description FROM tickets ORDER BY created_at DESC LIMIT 1`,
  );
  // Raised as an administrator rather than attributed to somebody it is not,
  // and the description says so.
  assert.equal(row!.requester_id, 'u-admin');
  assert.match(row!.description, /no account here/i);
});

test('an issue this app created does not come back as a second ticket', async () => {
  // The loop that makes a two-way sync eat itself: a ticket mirrors out to
  // Linear, Linear announces the creation, and that becomes a new ticket.
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO tickets (id, number, subject, description, description_format, requester_id, status, priority, type, source, tags, escalation_level, created_at, updated_at)
     VALUES ('tkt-mirrored', 5555, 'Raised here first', '', 'text', 'u-agent', 'open', 'normal', 'incident', 'web', '[]', 0, ?, ?)`,
    [now, now],
  );
  await db.run(
    `INSERT INTO ticket_links (id, ticket_id, provider, external_id, external_key, url, created_at)
     VALUES ('tl-mirror', 'tkt-mirrored', 'linear', 'lin-issue-mirrored', 'FIN-99', '', ?)`,
    [now],
  );

  const before = await ticketCount();
  const response = await post(issueCreated({ id: 'lin-issue-mirrored', identifier: 'FIN-99' }));
  assert.equal(response.status, 200);
  assert.equal(await ticketCount(), before, 'a mirrored issue came back as a duplicate ticket');
});

test('moving the issue in Linear still moves the ticket', async () => {
  // The direction that already worked must keep working now that create is
  // handled in the same endpoint.
  const response = await post({
    action: 'update',
    type: 'Issue',
    data: { id: 'lin-issue-1', identifier: 'FIN-42', state: { type: 'completed', name: 'Done' } },
  });
  assert.equal(response.status, 200);

  const link = await db.get<{ ticket_id: string }>(
    `SELECT ticket_id FROM ticket_links WHERE provider = 'linear' AND external_id = 'lin-issue-1'`,
  );
  const ticket = await db.get<{ status: string }>(`SELECT status FROM tickets WHERE id = ?`, [link!.ticket_id]);
  assert.equal(ticket!.status, 'resolved');
});
