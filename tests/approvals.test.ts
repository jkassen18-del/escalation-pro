/**
 * 3.0: approvals. Rules that make a new ticket wait for sign-off, requests by
 * hand, deciding from the web and from Slack, and the gate that keeps a
 * waiting ticket from being started or resolved. Over real HTTP against a
 * throwaway SQLite database.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'approvals.db';
process.env.SESSION_SECRET = 'a'.repeat(48);
process.env.SECRET_KEY = 'b'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const wipe = () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `approvals.db${suffix}`), { force: true });
};

const SIGNING_SECRET = 'slack-signing-secret-for-tests';
const RESPONSE_URL = 'https://hooks.slack.com/actions/T1/approval/xyz';
const realFetch = globalThis.fetch;
const slackPosts: any[] = [];
let ephemeral: string[] = [];

let server: http.Server;
let base: string;
const cookies: Record<string, string> = {};
let db: typeof import('../server/db/index.ts').db;
let finance: string;

async function call(who: string, method: string, url: string, body?: unknown) {
  const response = await realFetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: cookies[who] },
    body: body === undefined ? undefined : JSON.stringify(body),
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

before(async () => {
  wipe();
  const dist = path.resolve(import.meta.dirname, '../dist/client');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://slack.com/api/users.info')) {
      const id = new URL(url).searchParams.get('user');
      const email = id === 'USIPHO' ? 'sipho@acme.test' : id === 'UAGENT' ? 'agent@acme.test' : null;
      return Response.json(email ? { ok: true, user: { real_name: id, profile: { email } } } : { ok: false, error: 'user_not_found' });
    }
    if (url === 'https://slack.com/api/chat.postMessage') {
      slackPosts.push(JSON.parse(String(init?.body ?? '{}')));
      return Response.json({ ok: true, ts: '1.0001' });
    }
    if (url === RESPONSE_URL) {
      ephemeral.push(JSON.parse(String(init?.body ?? '{}')).text ?? '');
      return new Response('ok');
    }
    if (url.startsWith('https://slack.com/api/')) return Response.json({ ok: true });
    return realFetch(input, init);
  }) as typeof fetch;

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();
  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword('Adm1n-Password!');
  const now = new Date().toISOString();
  for (const [id, email, role] of [
    ['u-admin', 'admin@acme.test', 'admin'],
    ['u-sipho', 'sipho@acme.test', 'agent'],
    ['u-agent', 'agent@acme.test', 'agent'],
  ]) {
    await db.run(
      'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, email, id, id.slice(2), hash, salt, role, 'active', '#9a7b2f', 0, now, now],
    );
  }
  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const who of ['admin', 'sipho', 'agent']) {
    const response = await realFetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: `${who}@acme.test`, password: 'Adm1n-Password!' }),
    });
    cookies[who] = response.headers.get('set-cookie')!.split(';')[0];
  }
  finance = (await call('admin', 'POST', '/api/teams', { name: 'Finance', key: 'FIN' })).payload.team.id;
  // Sipho manages Finance; the agent is a plain member.
  await db.run(`INSERT INTO team_members (team_id, user_id, is_lead) VALUES (?, 'u-sipho', 1), (?, 'u-agent', 0)`, [finance, finance]);
  await db.run(
    `INSERT INTO team_form_fields (id, team_id, field_key, label, type, required, options, position, created_at, updated_at) VALUES ('f-amount', ?, 'amount', 'Amount', 'text', 0, '[]', 0, ?, ?)`,
    [finance, now, now],
  );
  const { saveIntegration } = await import('../server/integrations/store.ts');
  await saveIntegration('slack', { enabled: true, config: { mode: 'bot', botToken: 'xoxb-test', channel: 'CFIN', signingSecret: SIGNING_SECRET } });
});

after(async () => {
  globalThis.fetch = realFetch;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db.close();
  wipe();
});

async function slackClick(slackUser: string, actionId: string, value: string) {
  const payload = JSON.stringify({ type: 'block_actions', user: { id: slackUser }, channel: { id: 'CFIN' }, response_url: RESPONSE_URL, actions: [{ action_id: actionId, value }] });
  const raw = new URLSearchParams({ payload }).toString();
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${raw}`).digest('hex');
  ephemeral = [];
  return realFetch(`${base}/api/webhooks/slack/interactive`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-signature': signature, 'x-slack-request-timestamp': String(timestamp) },
    body: raw,
  });
}

const statusOf = async (id: string) => (await db.get<{ status: string }>(`SELECT status FROM tickets WHERE id = ?`, [id]))!.status;

test('rule matching: limits with currency, labels, words and form answers', async () => {
  const { ruleMatches, outcome } = await import('../shared/approvals.ts');
  const ticket = { type: 'request', priority: 'normal', tags: ['campaign'], subject: 'Need admin rights', description: '<p>please</p>', templateId: null, answers: { amount: 'R 75,000.00' } };
  assert.equal(ruleMatches({ field: { key: 'amount', op: 'gt', value: '50000' } }, ticket), true);
  assert.equal(ruleMatches({ field: { key: 'amount', op: 'lt', value: '50000' } }, ticket), false);
  assert.equal(ruleMatches({ field: { key: 'missing', op: 'gt', value: '1' } }, ticket), false);
  assert.equal(ruleMatches({ tags: ['Campaign'], keywords: ['ADMIN RIGHTS'] }, ticket), true);
  assert.equal(ruleMatches({ types: ['incident'] }, ticket), false);
  assert.equal(ruleMatches({}, ticket), true);
  const yes = (userId: string) => ({ userId, name: userId, decision: 'approved' as const, comment: null, at: '', via: 'web' });
  assert.equal(outcome('all', ['a', 'b'], [yes('a')]), 'pending');
  assert.equal(outcome('all', ['a', 'b'], [yes('a'), yes('b')]), 'approved');
  assert.equal(outcome('any', ['a', 'b'], [yes('b')]), 'approved');
});

test('a Finance payment over the limit waits for the manager before work starts', async () => {
  const created = await call('agent', 'POST', '/api/approvals/rules', { name: 'Over limit', teamId: finance, conditions: {}, approvers: [{ kind: 'department_managers' }] });
  assert.equal(created.status, 403, 'a plain member wrote approval rules');
  const rule = await call('admin', 'POST', '/api/approvals/rules', {
    name: 'Payments over R50 000',
    teamId: finance,
    conditions: { field: { key: 'amount', op: 'gt', value: '50000' } },
    approvers: [{ kind: 'department_managers' }],
  });
  assert.equal(rule.status, 201, JSON.stringify(rule.payload));

  const small = (await call('agent', 'POST', '/api/tickets', { subject: 'Pay supplier', teamId: finance, customFields: { amount: '1200' } })).payload.ticket;
  assert.equal((await call('agent', 'GET', `/api/approvals/ticket/${small.id}`)).payload.approvals.length, 0);

  const big = (await call('agent', 'POST', '/api/tickets', { subject: 'Pay contractor', teamId: finance, customFields: { amount: 'R 120 000' } })).payload.ticket;
  const approvals = (await call('agent', 'GET', `/api/approvals/ticket/${big.id}`)).payload.approvals;
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0].approverIds, ['u-sipho']);
  assert.ok(slackPosts.some((post) => JSON.stringify(post.blocks ?? []).includes('approval_approve')), 'no Approve button went to Slack');

  const blocked = await call('admin', 'PATCH', `/api/tickets/${big.id}`, { status: 'in_progress' });
  assert.equal(blocked.status, 409, 'a ticket waiting for approval was started');
  assert.match(blocked.payload.error, /waiting for approval/);
  assert.equal((await call('agent', 'POST', `/api/approvals/${approvals[0].id}/decide`, { decision: 'approved' })).status, 403, 'someone who is not an approver approved');

  const mine = (await call('sipho', 'GET', '/api/approvals/mine')).payload.approvals;
  assert.deepEqual(mine.map((entry: any) => entry.id), [approvals[0].id]);
  const decided = await call('sipho', 'POST', `/api/approvals/${approvals[0].id}/decide`, { decision: 'approved', comment: 'Within budget' });
  assert.equal(decided.status, 200, JSON.stringify(decided.payload));
  assert.equal(decided.payload.approval.status, 'approved');
  assert.equal((await call('admin', 'PATCH', `/api/tickets/${big.id}`, { status: 'in_progress' })).status, 200);
  assert.equal((await call('sipho', 'GET', '/api/approvals/mine')).payload.approvals.length, 0);
});

test('Approve and Reject from Slack: only a named approver, and a rejection closes the ticket', async () => {
  const ticket = (await call('agent', 'POST', '/api/tickets', { subject: 'Access to the payroll share', teamId: finance })).payload.ticket;
  const requested = await call('agent', 'POST', `/api/approvals/ticket/${ticket.id}`, { title: 'Payroll share access', approverIds: ['u-sipho'], note: 'For month end' });
  assert.equal(requested.status, 201, JSON.stringify(requested.payload));
  const id = requested.payload.approval.id;

  // The Resolve button is refused too while it waits.
  await slackClick('USIPHO', 'ticket_resolve', ticket.id);
  assert.match(ephemeral.join(' '), /waiting for approval/);
  assert.equal(await statusOf(ticket.id), 'open');

  assert.equal((await slackClick('UAGENT', 'approval_reject', id)).status, 200);
  assert.match(ephemeral.join(' '), /not one of the approvers/);
  assert.equal((await call('agent', 'GET', `/api/approvals/ticket/${ticket.id}`)).payload.approvals[0].status, 'pending');

  assert.equal((await slackClick('USIPHO', 'approval_reject', id)).status, 200);
  assert.match(ephemeral.join(' '), /rejected/);
  const after = (await call('agent', 'GET', `/api/approvals/ticket/${ticket.id}`)).payload.approvals[0];
  assert.equal(after.status, 'rejected');
  assert.equal(after.decisions[0].via, 'slack');
  assert.equal(await statusOf(ticket.id), 'closed');

  // A second click is answered, not applied twice.
  await slackClick('USIPHO', 'approval_approve', id);
  assert.match(ephemeral.join(' '), /already rejected/);
});

test('needing everyone: the request waits until the last approver, and can be withdrawn', async () => {
  const ticket = (await call('agent', 'POST', '/api/tickets', { subject: 'Campaign artwork', teamId: finance })).payload.ticket;
  const id = (await call('agent', 'POST', `/api/approvals/ticket/${ticket.id}`, { title: 'Artwork', approverIds: ['u-sipho', 'u-admin'], mode: 'all' })).payload.approval.id;
  assert.equal((await call('sipho', 'POST', `/api/approvals/${id}/decide`, { decision: 'approved' })).payload.approval.status, 'pending');
  assert.equal((await call('admin', 'PATCH', `/api/tickets/${ticket.id}`, { status: 'resolved' })).status, 409);
  assert.equal((await call('sipho', 'POST', `/api/approvals/${id}/cancel`)).status, 200, 'the department manager could not withdraw it');
  assert.equal((await call('admin', 'PATCH', `/api/tickets/${ticket.id}`, { status: 'resolved' })).status, 200, 'a withdrawn request still blocked the ticket');
});
