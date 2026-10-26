/**
 * Per-department routing to Slack, Teams and Linear, and the message designs
 * that lay those messages out. The services are faked at fetch; everything on
 * this side runs for real over HTTP against a throwaway SQLite database.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'routing-templates.db';
process.env.SESSION_SECRET = 'q'.repeat(48);
process.env.SECRET_KEY = 'f'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const wipe = () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `routing-templates.db${suffix}`), { force: true });
};

const { fill, normaliseTemplate, SAMPLE_VALUES } = await import('../shared/message-template.ts');

let server: http.Server;
let base: string;
let cookie: string;
let db: typeof import('../server/db/index.ts').db;
let finance: string;
let hr: string;
let design: string;

const realFetch = globalThis.fetch;
const slackPosts: Array<Record<string, any>> = [];
const linearCreates: Array<Record<string, any>> = [];
const teamsPosts: Array<{ url: string; body: any }> = [];
let slackTs = 1000;

async function call(method: string, url: string, body?: unknown) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
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

/** Notifications are sent after the response; wait until `count` have arrived. */
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
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
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://slack.com/api/chat.postMessage') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      slackPosts.push(body);
      slackTs += 1;
      return Response.json({ ok: true, ts: `${slackTs}.0001`, channel: body.channel });
    }
    if (url.startsWith('https://slack.com/api/conversations.list')) {
      return Response.json({
        ok: true,
        channels: [
          { id: 'CFINANCE1', name: 'finance', is_private: false, is_member: true },
          { id: 'CHRTEAM01', name: 'hr', is_private: true, is_member: false },
        ],
      });
    }
    if (url.startsWith('https://api.linear.app/')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (String(body.query).includes('issueCreate')) {
        linearCreates.push(body.variables.input);
        return Response.json({ data: { issueCreate: { success: true, issue: { id: `iss-${linearCreates.length}`, identifier: `FIN-${linearCreates.length}`, url: 'https://linear.app/x' } } } });
      }
      if (String(body.query).includes('teams(')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'lin-fin', key: 'FIN', name: 'Finance' }, { id: 'lin-ops', key: 'OPS', name: 'Operations' }] } } });
      }
      return Response.json({ data: {} });
    }
    if (url.startsWith('https://hr.example.logic.azure.com/') || url.startsWith('https://default.example.logic.azure.com/')) {
      teamsPosts.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response('', { status: 202 });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();
  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword('Adm1n-Password!');
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['u-admin', 'admin@acme.test', 'admin', 'Jamal Kassen', hash, salt, 'admin', 'active', '#9a7b2f', 0, now, now],
  );

  const { saveIntegration } = await import('../server/integrations/store.ts');
  const events = { ticketCreated: true, ticketEscalated: true, ticketAssigned: false, ticketStatusChanged: false, ticketCommented: false, slaBreached: false };
  await saveIntegration('slack', { enabled: true, config: { mode: 'bot', botToken: 'xoxb-test-token' }, events });
  await saveIntegration('msteams', { enabled: true, config: { mode: 'webhook', webhookUrl: 'https://default.example.logic.azure.com/workflows/1' }, events });
  await saveIntegration('linear', { enabled: true, config: { apiKey: ['lin', 'api', 'x'].join('_'), autoCreate: false } });

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'admin@acme.test', password: 'Adm1n-Password!' }),
  });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  finance = (await call('POST', '/api/teams', { name: 'Finance (Withdrawals)', key: 'FIN' })).payload.team.id;
  hr = (await call('POST', '/api/teams', { name: 'HR', key: 'HR' })).payload.team.id;
  design = (await call('POST', '/api/teams', { name: 'Design', key: 'DES' })).payload.team.id;
});

after(async () => {
  globalThis.fetch = realFetch;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db.close();
  wipe();
});

test('templates fill placeholders, escape ticket text for Slack, and keep unknown placeholders visible', () => {
  const values = { ...SAMPLE_VALUES, subject: 'Refund <urgent> & fast' };
  assert.equal(fill('{{subject}}', values, 'slack'), 'Refund &lt;urgent&gt; &amp; fast');
  assert.equal(fill('*{{reference}}*', values, 'slack'), '*ESC-1007*', 'the template\'s own formatting is kept');
  assert.equal(fill('{{ticket_link}}', values, 'slack'), `<${values.url}|ESC-1007>`);
  assert.equal(fill('{{ticket_link}}', values, 'linear'), `[ESC-1007](${values.url})`);
  assert.equal(fill('{{nope}} {{team}}', values, 'msteams'), '{{nope}} Finance (Withdrawals)');

  const cleaned = normaliseTemplate('slack', { title: '', fields: ['team', 'bogus', 'team', 'labels'], body: 'x'.repeat(5000), buttons: 'yes' });
  assert.equal(cleaned.title, '{{headline}}', 'a blank title falls back to the default');
  assert.deepEqual(cleaned.fields, ['team', 'labels']);
  assert.equal(cleaned.body.length, 2000);
  assert.equal(cleaned.buttons, true);
});

test('the routing table lists real channels, and saving it routes each department to its own', async () => {
  const view = await call('GET', '/api/integrations/routing/slack');
  assert.equal(view.status, 200, JSON.stringify(view.payload));
  assert.deepEqual(view.payload.destinations.map((d: { id: string }) => d.id), ['CFINANCE1', 'CHRTEAM01']);
  assert.match(view.payload.destinations[1].warning, /Invite the app/);
  assert.equal(view.payload.fallback, '');

  const bad = await call('PUT', '/api/integrations/routing/slack', { departments: [{ teamId: finance, target: '#finance' }] });
  assert.equal(bad.status, 400, 'a typed channel name is refused; the picker sends ids');

  const saved = await call('PUT', '/api/integrations/routing/slack', {
    departments: [
      { teamId: finance, target: 'CFINANCE1', mention: '@here' },
      { teamId: hr, target: 'CHRTEAM01' },
    ],
    fallback: 'none',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  const row = saved.payload.departments.find((d: { teamId: string }) => d.teamId === finance);
  assert.equal(row.target, 'CFINANCE1');
  assert.equal(row.mention, '<!here>');
});

test('Slack posts each department to its channel, laid out by the saved design, and follows an escalation', async () => {
  const design_ = await call('PUT', '/api/integrations/templates/slack', {
    template: { title: '{{team}} needs eyes: {{reference}}', subtitle: '{{subject}}', fields: ['priority', 'requester'], body: '', footer: '', buttons: false, priorityColour: false },
  });
  assert.equal(design_.status, 200);

  slackPosts.length = 0;
  const ticket = (await call('POST', '/api/tickets', { subject: 'Withdrawal Flush Request', teamId: finance })).payload.ticket;
  await until(() => slackPosts.length >= 1, 'the Finance post');
  const first = slackPosts[0];
  assert.equal(first.channel, 'CFINANCE1');
  assert.equal(first.thread_ts, undefined);
  const headline = first.blocks[0].text.text as string;
  assert.ok(headline.startsWith('<!here> *Finance (Withdrawals) needs eyes:'), headline);
  assert.deepEqual(
    first.blocks[1].fields.map((field: { text: string }) => field.text),
    ['*Priority*\nNormal', '*Requester*\nJamal Kassen'],
  );
  assert.ok(!first.blocks.some((block: { type: string }) => block.type === 'actions'), 'buttons were switched off');
  assert.equal(first.attachments, undefined, 'no priority colour');

  // Escalated to HR: a new thread in HR's channel, not a reply in Finance's.
  const escalated = await call('POST', `/api/tickets/${ticket.id}/escalate`, { reason: 'Payroll question', teamId: hr });
  assert.equal(escalated.status, 200, JSON.stringify(escalated.payload));
  await until(() => slackPosts.some((post) => post.channel === 'CHRTEAM01'), 'the HR post');
  const hrPost = slackPosts.find((post) => post.channel === 'CHRTEAM01')!;
  assert.equal(hrPost.thread_ts, undefined, 'HR gets its own thread');

  // A department with no channel, and "Everything else" set to don't post: nothing is sent.
  const before = slackPosts.length;
  await call('POST', '/api/tickets', { subject: 'New logo', teamId: design });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(slackPosts.length, before);
  const skipped = await db.get<{ ok: number; error: string }>(`SELECT ok, error FROM integration_deliveries WHERE provider = 'slack' ORDER BY created_at DESC LIMIT 1`);
  assert.match(skipped!.error, /no Slack channel is set/);
});

test('Teams webhooks route by department and carry the designed card', async () => {
  const saved = await call('PUT', '/api/integrations/routing/msteams', {
    departments: [{ teamId: hr, target: 'https://hr.example.logic.azure.com/workflows/2' }],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.kind, 'url');
  await call('PUT', '/api/integrations/templates/msteams', {
    template: { title: 'HR: {{subject}}', subtitle: '', fields: ['status'], body: 'Raised by {{requester}}', footer: '', buttons: true, priorityColour: false },
  });

  teamsPosts.length = 0;
  await call('POST', '/api/tickets', { subject: 'Leave balance wrong', teamId: hr });
  await until(() => teamsPosts.length >= 1, 'the Teams post');
  assert.equal(teamsPosts[0].url, 'https://hr.example.logic.azure.com/workflows/2');
  const card = teamsPosts[0].body.attachments[0].content;
  assert.equal(card.type, 'AdaptiveCard');
  assert.equal(card.body[0].text, 'HR: Leave balance wrong');
  assert.deepEqual(card.body[1].facts, [{ title: 'Status', value: 'Open' }]);
  assert.equal(card.body[2].text, 'Raised by Jamal Kassen');
  assert.equal(card.actions[0].title, 'Open ticket');

  await call('POST', '/api/tickets', { subject: 'Banner sizes', teamId: design });
  await until(() => teamsPosts.length >= 2, 'the default webhook post');
  assert.equal(teamsPosts[1].url, 'https://default.example.logic.azure.com/workflows/1', 'no route: the default webhook');
});

test('a Linear push goes to the department\'s Linear team, or the one picked, with the designed title', async () => {
  const saved = await call('PUT', '/api/integrations/routing/linear', { departments: [{ teamId: finance, target: 'lin-fin' }], fallback: 'none' });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.payload.destinations.map((d: { id: string }) => d.id), ['lin-fin', 'lin-ops']);
  await call('PUT', '/api/integrations/templates/linear', {
    template: { title: '{{team}} · {{subject}}', fields: ['requester'], body: '{{description}}', footer: 'From {{ticket_link}}' },
  });

  const ticket = (await call('POST', '/api/tickets', { subject: 'Chargeback dispute', teamId: finance, description: 'Card ending 4242' })).payload.ticket;
  const targets = await call('GET', `/api/tickets/${ticket.id}/linear-targets`);
  assert.equal(targets.payload.suggested, 'lin-fin');

  linearCreates.length = 0;
  const pushed = await call('POST', `/api/tickets/${ticket.id}/push-to-linear`, {});
  assert.equal(pushed.status, 200, JSON.stringify(pushed.payload));
  assert.equal(linearCreates[0].teamId, 'lin-fin');
  assert.equal(linearCreates[0].title, 'Finance (Withdrawals) · Chargeback dispute');
  assert.match(linearCreates[0].description, /Card ending 4242/);
  assert.match(linearCreates[0].description, /- \*\*Requester:\*\* Jamal Kassen/);
  assert.match(linearCreates[0].description, /From \[ESC-\d+\]\(/);

  // Picked by hand in the dialog.
  const other = (await call('POST', '/api/tickets', { subject: 'Server down', teamId: finance })).payload.ticket;
  await call('POST', `/api/tickets/${other.id}/push-to-linear`, { linearTeamId: 'lin-ops' });
  assert.equal(linearCreates[1].teamId, 'lin-ops');

  // A department with no Linear team and no "Everything else" says so.
  const orphan = (await call('POST', '/api/tickets', { subject: 'Poster', teamId: design })).payload.ticket;
  const refused = await call('POST', `/api/tickets/${orphan.id}/push-to-linear`, {});
  assert.equal(refused.status, 400);
  assert.match(refused.payload.error, /No Linear team is set for Design/);
});

test('resetting a design restores the default', async () => {
  const reset = await call('PUT', '/api/integrations/templates/slack', { template: null });
  assert.equal(reset.payload.template.title, '{{headline}}');
  assert.deepEqual(reset.payload.template.fields, ['status', 'priority', 'team', 'assignee']);
});
