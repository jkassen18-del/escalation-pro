/**
 * 3.0: flows. A department's own alert and escalation routes, drawn as
 * nodes: triggers, conditions, waits that resume later, and actions. Over
 * real HTTP against a throwaway SQLite database, with the outside stubbed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'flows.db';
process.env.SESSION_SECRET = 'f'.repeat(48);
process.env.SECRET_KEY = 'a'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const wipe = () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `flows.db${suffix}`), { force: true });
};

const realFetch = globalThis.fetch;
const outbound: Array<{ url: string; body: any }> = [];
let apiStatus = 200;

let server: http.Server;
let base: string;
const cookies: Record<string, string> = {};
let db: typeof import('../server/db/index.ts').db;
let finance: string;
let hr: string;

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

async function until(check: () => Promise<boolean> | boolean, label: string) {
  for (let i = 0; i < 150; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
}

before(async () => {
  wipe();
  const dist = path.resolve(import.meta.dirname, '../dist/client');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : (input.url ?? input));
    if (url.includes('.invalid')) {
      let body: any = init?.body;
      try {
        body = body ? JSON.parse(String(body)) : body;
      } catch {
        // not JSON
      }
      outbound.push({ url, body });
      if (url.startsWith('https://erp.invalid/')) return Response.json({ ok: apiStatus < 400 }, { status: apiStatus });
      return new Response('1', { status: 200 });
    }
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
    ['u-fin', 'fin@acme.test', 'agent'],
    ['u-hr', 'hr@acme.test', 'agent'],
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
  for (const who of ['admin', 'fin', 'hr']) {
    const response = await realFetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: `${who}@acme.test`, password: 'Adm1n-Password!' }),
    });
    cookies[who] = response.headers.get('set-cookie')!.split(';')[0];
  }
  finance = (await call('admin', 'POST', '/api/teams', { name: 'Finance', key: 'FIN' })).payload.team.id;
  hr = (await call('admin', 'POST', '/api/teams', { name: 'HR', key: 'HR' })).payload.team.id;
  await db.run(`INSERT INTO team_members (team_id, user_id, is_lead) VALUES (?, 'u-fin', 1), (?, 'u-hr', 0)`, [finance, hr]);
  // Finance's own Teams channel, which the flow posts to.
  await call('fin', 'POST', '/api/connections', { kind: 'teams_webhook', teamId: finance, name: 'Finance channel', config: { url: 'https://finance-teams.invalid/hook' }, events: { ticketCreated: false } });
});

after(async () => {
  globalThis.fetch = realFetch;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db.close();
  wipe();
});

const node = (id: string, kind: string, config: Record<string, unknown> = {}) => ({ id, kind, position: { x: 0, y: 0 }, config });
const edge = (source: string, target: string, sourceHandle = 'out') => ({ id: `${source}-${sourceHandle}-${target}`, source, sourceHandle, target });
const runsOf = (flowId: string) => db.all<{ status: string; steps: string; next_at: string | null }>(`SELECT status, steps, next_at FROM flow_runs WHERE flow_id = ? ORDER BY created_at`, [flowId]);

let flowId: string;

test('who may build and see a department flow, and an incomplete flow cannot be switched on', async () => {
  const incomplete = await call('fin', 'POST', '/api/flows', { name: 'No start', teamId: finance, nodes: [node('a', 'notify')], edges: [] });
  assert.equal(incomplete.status, 400);
  assert.match(incomplete.payload.error, /exactly one "When"/);
  const draft = await call('fin', 'POST', '/api/flows', { name: 'Draft', teamId: finance, enabled: false, nodes: [node('a', 'notify')], edges: [] });
  assert.equal(draft.status, 201, 'a draft could not be saved half-built');
  assert.equal((await call('hr', 'POST', '/api/flows', { name: 'Sneaky', teamId: finance, enabled: false, nodes: [], edges: [] })).status, 403);
  assert.equal((await call('hr', 'GET', `/api/flows/${draft.payload.flow.id}`)).status, 404, "HR can see Finance's flow");
  assert.equal((await call('fin', 'POST', '/api/flows', { name: 'Everywhere', teamId: null, enabled: false, nodes: [], edges: [] })).status, 403);
  await call('fin', 'DELETE', `/api/flows/${draft.payload.flow.id}`);
});

test('urgent tickets: post to the channel, wait, then tell the managers if still open; others are labelled', async () => {
  const created = await call('fin', 'POST', '/api/flows', {
    name: 'Urgent finance',
    teamId: finance,
    nodes: [
      node('start', 'trigger', { events: ['ticketCreated'] }),
      node('urgent', 'condition', { field: 'priority', op: 'any_of', value: 'urgent, high' }),
      node('post', 'teams', { message: 'Urgent: {{ticket.reference}} {{ticket.subject}}' }),
      node('wait', 'wait', { minutes: 10, onlyIfOpen: true }),
      node('tell', 'notify', { to: ['department_managers'], message: '{{ticket.reference}} is still open after 10 minutes' }),
      node('label', 'update', { addTags: ['routine'] }),
    ],
    edges: [edge('start', 'urgent'), edge('urgent', 'post', 'yes'), edge('post', 'wait'), edge('wait', 'tell'), edge('urgent', 'label', 'no')],
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  flowId = created.payload.flow.id;

  const urgent = (await call('admin', 'POST', '/api/tickets', { subject: 'Payroll file rejected', teamId: finance, priority: 'urgent' })).payload.ticket;
  await until(async () => (await runsOf(flowId)).some((run) => run.status === 'waiting'), 'the run to reach its wait');
  assert.ok(
    outbound.some((entry) => entry.url === 'https://finance-teams.invalid/hook' && JSON.stringify(entry.body).includes(`Urgent: ${urgent.reference} Payroll file rejected`)),
    'the Teams post did not go to the department channel',
  );
  assert.equal((await db.all(`SELECT id FROM notifications WHERE user_id = 'u-fin' AND type = 'flow'`)).length, 0, 'the managers were told before the wait');

  const { resumeDueRuns } = await import('../server/ops/flows.ts');
  assert.equal(await resumeDueRuns(Date.now() + 5 * 60_000), 0, 'resumed before the wait was over');
  assert.equal(await resumeDueRuns(Date.now() + 11 * 60_000), 1);
  const told = await db.all<{ title: string }>(`SELECT title FROM notifications WHERE user_id = 'u-fin' AND type = 'flow'`);
  assert.deepEqual(told.map((row) => row.title), [`${urgent.reference} is still open after 10 minutes`]);
  assert.equal((await runsOf(flowId)).at(-1)!.status, 'done');

  // Not urgent: labelled, and the label change does not start the flow again.
  const routine = (await call('admin', 'POST', '/api/tickets', { subject: 'Expense query', teamId: finance, priority: 'low' })).payload.ticket;
  await until(async () => ((await db.get<{ tags: string }>(`SELECT tags FROM tickets WHERE id = ?`, [routine.id]))?.tags ?? '').includes('routine'), 'the label');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await runsOf(flowId)).length, 2, "the flow's own change started another run");

  // Another department's ticket never runs Finance's flow.
  await call('admin', 'POST', '/api/tickets', { subject: 'Leave request', teamId: hr, priority: 'urgent' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await runsOf(flowId)).length, 2);
});

test('a wait stops when the ticket was resolved meanwhile', async () => {
  const ticket = (await call('admin', 'POST', '/api/tickets', { subject: 'Bank feed down', teamId: finance, priority: 'high' })).payload.ticket;
  await until(async () => (await runsOf(flowId)).filter((run) => run.status === 'waiting').length === 1, 'the wait');
  await call('admin', 'PATCH', `/api/tickets/${ticket.id}`, { status: 'resolved' });
  const { resumeDueRuns } = await import('../server/ops/flows.ts');
  await resumeDueRuns(Date.now() + 11 * 60_000);
  const last = (await runsOf(flowId)).at(-1)!;
  assert.equal(last.status, 'done');
  assert.match(last.steps, /Stopped: .* was resolved by then/);
  assert.equal((await db.all(`SELECT id FROM notifications WHERE type = 'flow' AND title LIKE ?`, [`${ticket.reference}%`])).length, 0);
});

test('calling an API follows its ok or failed exit, and a flow can be run by hand on a ticket', async () => {
  const erp = (await call('fin', 'POST', '/api/connections', { kind: 'api', teamId: finance, name: 'ERP', config: { baseUrl: 'https://erp.invalid' } })).payload.connection;
  const flow = (
    await call('fin', 'POST', '/api/flows', {
      name: 'Tell the ERP',
      teamId: finance,
      nodes: [
        node('start', 'trigger', { events: ['ticketEscalated'] }),
        node('call', 'api_call', { connectionId: erp.id, method: 'POST', path: '/tickets/{{ticket.reference}}', body: '{"subject": "{{ticket.subject}}"}' }),
        node('ok', 'update', { addTags: ['in-erp'] }),
        node('failed', 'update', { priority: 'urgent' }),
      ],
      edges: [edge('start', 'call'), edge('call', 'ok', 'ok'), edge('call', 'failed', 'failed')],
    })
  ).payload.flow;
  const ticket = (await call('admin', 'POST', '/api/tickets', { subject: 'Quote "Q-7" approved', teamId: finance, priority: 'low' })).payload.ticket;

  const ran = await call('fin', 'POST', `/api/flows/${flow.id}/run`, { ticket: ticket.reference });
  assert.equal(ran.status, 200, JSON.stringify(ran.payload));
  const sent = outbound.filter((entry) => entry.url.startsWith('https://erp.invalid/')).at(-1)!;
  assert.equal(sent.url, `https://erp.invalid/tickets/${ticket.reference}`);
  assert.deepEqual(sent.body, { subject: 'Quote "Q-7" approved' }, 'the template broke the JSON');
  assert.match((await db.get<{ tags: string }>(`SELECT tags FROM tickets WHERE id = ?`, [ticket.id]))!.tags, /in-erp/);

  apiStatus = 503;
  await call('fin', 'POST', `/api/flows/${flow.id}/run`, { ticket: ticket.reference });
  assert.equal((await db.get<{ priority: string }>(`SELECT priority FROM tickets WHERE id = ?`, [ticket.id]))!.priority, 'urgent', 'the failed exit was not followed');
  apiStatus = 200;

  const hrTicket = (await call('admin', 'POST', '/api/tickets', { subject: 'Not Finance', teamId: hr })).payload.ticket;
  assert.equal((await call('fin', 'POST', `/api/flows/${flow.id}/run`, { ticket: hrTicket.reference })).status, 403);
  const detail = await call('fin', 'GET', `/api/flows/${flow.id}`);
  assert.equal(detail.payload.runs.length, 2);
  assert.ok(detail.payload.runs[0].steps.some((step: any) => step.message === 'HTTP 503 from ERP'));
});

test('conditions read the ticket as it is', async () => {
  const { evaluateCondition } = await import('../server/ops/flows.ts');
  const ticket = { priority: 'high', type: 'incident', status: 'open', source: 'email', tags: ['vip', 'payroll'], subject: 'Server down in Durban', assigneeId: null, teamId: finance, teamName: 'Finance' } as any;
  assert.equal(await evaluateCondition({ field: 'tags', op: 'any_of', value: 'payroll' }, ticket), true);
  assert.equal(await evaluateCondition({ field: 'tags', op: 'is_not', value: 'vip' }, ticket), false);
  assert.equal(await evaluateCondition({ field: 'subject', op: 'contains', value: 'durban, cape town' }, ticket), true);
  assert.equal(await evaluateCondition({ field: 'assigned', op: 'is', value: 'no' }, ticket), true);
  assert.equal(await evaluateCondition({ field: 'source', op: 'is', value: 'email' }, ticket), true);
  assert.equal(await evaluateCondition({ field: 'department', op: 'is', value: 'finance' }, ticket), true);
  assert.equal(await evaluateCondition({ field: 'in_shift', op: 'is', value: 'no' }, ticket), true, 'a department with no shifts is not on shift');
});
