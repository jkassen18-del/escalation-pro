/**
 * Raising a ticket from Slack with /gml.
 *
 * The interesting part is not that a modal opens; it is that the modal is
 * built from the department's own form fields, that switching department
 * rebuilds it, and that the answers are validated against the real field
 * definitions on the way in - because a view_submission is just an HTTP
 * request and can claim anything.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'slackslash.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SECRET_KEY = 'b'.repeat(64);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const SIGNING_SECRET = 'test-signing-secret';
const DATA_DIR = path.resolve(import.meta.dirname, '../data');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, `slackslash.db${suffix}`));
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
let hrId = '';

/** Every Slack Web API call this made, so the view can be inspected. */
let slackCalls: Array<{ method: string; body: any }> = [];

const SLACK_PEOPLE: Record<string, { email?: string; real_name: string }> = {
  U_AGENT: { email: 'agent@acme.test', real_name: 'Ada Agent' },
  U_VIEWER: { email: 'viewer@acme.test', real_name: 'Vic Viewer' },
  U_STRANGER: { email: 'nobody@elsewhere.test', real_name: 'A Stranger' },
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
    if (url.startsWith('https://slack.com/api/')) {
      const method = url.replace('https://slack.com/api/', '');
      slackCalls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
      return Response.json({ ok: true, view: { id: 'V123', hash: 'h1' }, ts: '1.2' });
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
  // A viewer may read tickets but not create them.
  await addUser('u-viewer', 'viewer@acme.test', 'viewer');

  await db.run('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', [
    'ticket_number',
    1000,
  ]);

  const { createTeam } = await import('../server/repositories/teams.ts');
  financeId = await createTeam({ key: 'finance', name: 'Finance' });
  hrId = await createTeam({ key: 'hr', name: 'People Team' });

  // Finance asks two questions of its own; HR asks a different one. The whole
  // point is that /gml finance shows Finance's, not a generic form.
  const { replaceTeamForm } = await import('../server/repositories/form-fields.ts');
  await replaceTeamForm(financeId, [
    { label: 'Cost centre', type: 'text', required: true },
    { label: 'Amount', type: 'number', required: false },
    { label: 'Category', type: 'select', required: true, options: ['Invoice', 'Expense', 'Payroll'] },
  ]);
  await replaceTeamForm(hrId, [{ label: 'Employee ID', type: 'text', required: true }]);

  const { saveIntegration } = await import('../server/integrations/store.ts');
  await saveIntegration('slack', {
    enabled: true,
    config: { mode: 'bot', botToken: 'xoxb-not-real', channel: 'C_GENERAL', signingSecret: SIGNING_SECRET },
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

function signedPost(urlPath: string, form: Record<string, string>) {
  const raw = new URLSearchParams(form).toString();
  const timestamp = Math.floor(Date.now() / 1000);
  const signature =
    'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${raw}`).digest('hex');
  slackCalls = [];
  return fetch(`${base}${urlPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-signature': signature,
      'x-slack-request-timestamp': String(timestamp),
    },
    body: raw,
  });
}

const slash = (text: string, user = 'U_AGENT') =>
  signedPost('/api/webhooks/slack/commands', {
    command: '/gml',
    text,
    user_id: user,
    channel_id: 'C_GENERAL',
    trigger_id: 'T123.456',
  });

const interact = (payload: unknown) =>
  signedPost('/api/webhooks/slack/interactive', { payload: JSON.stringify(payload) });

/** Every block id in the view that was last sent to Slack. */
function lastViewBlockIds(): string[] {
  const call = slackCalls.find((c) => c.method === 'views.open' || c.method === 'views.update');
  return (call?.body?.view?.blocks ?? []).map((b: any) => b.block_id).filter(Boolean);
}

test('an unsigned command is refused', async () => {
  const response = await fetch(`${base}/api/webhooks/slack/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ command: '/gml', user_id: 'U_AGENT', trigger_id: 'T1' }).toString(),
  });
  assert.equal(response.status, 401);
});

test('/gml with no department opens the form with a picker and no questions', async () => {
  const response = await slash('');
  assert.equal(response.status, 200);

  const opened = slackCalls.find((c) => c.method === 'views.open');
  assert.ok(opened, 'no modal was opened');
  assert.equal(opened!.body.trigger_id, 'T123.456');

  const ids = lastViewBlockIds();
  assert.ok(ids.includes('team_block'));
  assert.ok(ids.includes('subject'));
  assert.ok(!ids.some((id) => id.startsWith('field:')), 'department questions appeared before one was chosen');
});

test('/gml finance opens Finance’s own questions, not a generic form', async () => {
  const response = await slash('finance');
  assert.equal(response.status, 200);

  const ids = lastViewBlockIds();
  assert.ok(ids.includes('field:cost_centre'), `expected Finance fields, got ${ids.join(', ')}`);
  assert.ok(ids.includes('field:category'));
  assert.ok(!ids.includes('field:employee_id'), "another department's question leaked in");
});

test('the department is matched forgivingly', async () => {
  // People type the prefix out of habit, and they abbreviate.
  for (const text of ['gml-finance', 'Finance', 'FINANCE', 'fin']) {
    await slash(text);
    assert.ok(lastViewBlockIds().includes('field:cost_centre'), `"${text}" did not resolve to Finance`);
  }
});

test('an unrecognised department opens the picker rather than failing', async () => {
  await slash('accounts-payable-department-9');
  const ids = lastViewBlockIds();
  assert.ok(ids.includes('team_block'));
  assert.ok(!ids.some((id) => id.startsWith('field:')));
});

test('switching department in the open modal rebuilds the questions', async () => {
  const response = await interact({
    type: 'block_actions',
    user: { id: 'U_AGENT' },
    view: { id: 'V123', hash: 'h1', callback_id: 'infraticket_new', private_metadata: '{"channelId":"C_GENERAL"}' },
    actions: [{ action_id: 'team_select', selected_option: { value: hrId } }],
  });
  assert.equal(response.status, 200);

  const updated = slackCalls.find((c) => c.method === 'views.update');
  assert.ok(updated, 'the view was not updated');
  assert.equal(updated!.body.view_id, 'V123');
  assert.equal(updated!.body.hash, 'h1', 'Slack rejects an update without the current hash');

  const ids = lastViewBlockIds();
  assert.ok(ids.includes('field:employee_id'), 'the HR question did not appear');
  assert.ok(!ids.includes('field:cost_centre'), 'the Finance question was left behind');
});

test('someone without permission to raise tickets is refused', async () => {
  const response = await slash('finance', 'U_VIEWER');
  assert.equal(response.status, 200);
  const body = (await response.json()) as { text?: string; response_type?: string };
  assert.equal(body.response_type, 'ephemeral', 'the refusal was broadcast to the channel');
  assert.match(String(body.text), /do not have permission/i);
  assert.equal(slackCalls.length, 0, 'a modal was opened for someone who cannot use it');
});

test('someone with no account here is told what to do about it', async () => {
  const response = await slash('finance', 'U_STRANGER');
  const body = (await response.json()) as { text?: string };
  assert.match(String(body.text), /not linked to a user here/i);
});

/** A filled-in modal, as Slack posts it back. */
function submission(values: Record<string, Record<string, unknown>>) {
  return {
    type: 'view_submission',
    user: { id: 'U_AGENT' },
    view: {
      callback_id: 'infraticket_new',
      private_metadata: JSON.stringify({ channelId: 'C_GENERAL' }),
      state: { values },
    },
  };
}

const financeValues = (overrides: Record<string, Record<string, unknown>> = {}) => ({
  team_block: { team_select: { selected_option: { value: financeId } } },
  subject: { v: { value: 'Duplicate invoice from Acme' } },
  description: { v: { value: 'We appear to have paid it twice.' } },
  priority: { v: { selected_option: { value: 'high' } } },
  'field:cost_centre': { v: { value: 'CC-4471' } },
  'field:category': { v: { selected_option: { value: 'Invoice' } } },
  ...overrides,
});

test('submitting the form raises a ticket against the right department', async () => {
  const response = await interact(submission(financeValues()));
  assert.equal(response.status, 200);
  // An empty 200 is what closes the modal.
  assert.deepEqual(await response.json(), {});

  const row = await db.get<{ id: string; subject: string; team_id: string; priority: string; source: string }>(
    `SELECT id, subject, team_id, priority, source FROM tickets ORDER BY created_at DESC LIMIT 1`,
  );
  assert.equal(row!.subject, 'Duplicate invoice from Acme');
  assert.equal(row!.team_id, financeId, 'the ticket went to the wrong department');
  assert.equal(row!.priority, 'high');
  assert.equal(row!.source, 'slack', 'the ticket does not record where it came from');
});

test('the department’s answers are stored with the ticket', async () => {
  const row = await db.get<{ id: string }>(`SELECT id FROM tickets ORDER BY created_at DESC LIMIT 1`);

  // Read through the repository rather than the raw column: values are stored
  // JSON-encoded so numbers and lists round-trip, and this is what the ticket
  // page actually renders.
  const { listAnswers } = await import('../server/repositories/form-fields.ts');
  const answers = await listAnswers(row!.id);

  const byKey = Object.fromEntries(answers.map((a) => [a.key, a.value]));
  assert.equal(byKey.cost_centre, 'CC-4471');
  assert.equal(byKey.category, 'Invoice');
  // The question is snapshotted alongside the answer.
  assert.ok(answers.some((a) => a.label === 'Cost centre'));
});

test('the person who raised it is told, privately', async () => {
  const ephemeral = slackCalls.find((c) => c.method === 'chat.postEphemeral');
  assert.ok(ephemeral, 'nobody was told the ticket was raised');
  assert.equal(ephemeral!.body.user, 'U_AGENT');
  assert.match(ephemeral!.body.text, /ESC-\d+/);
});

test('a missing required answer is pinned under the field that is missing', async () => {
  const before = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n);

  const values = financeValues();
  delete (values as any)['field:cost_centre'];
  const response = await interact(submission(values));

  const body = (await response.json()) as { response_action?: string; errors?: Record<string, string> };
  assert.equal(body.response_action, 'errors', 'the modal closed on an invalid submission');
  assert.ok(body.errors?.['field:cost_centre'], `the error was not attached to the field: ${JSON.stringify(body.errors)}`);

  const after = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n);
  assert.equal(after, before, 'a ticket was created despite the invalid submission');
});

test('an answer that is not one of the offered choices is refused', async () => {
  // The modal only offered three categories. A submission is an HTTP request
  // and can say anything, so the server is what has to say no.
  const response = await interact(
    submission(financeValues({ 'field:category': { v: { selected_option: { value: 'Embezzlement' } } } })),
  );
  const body = (await response.json()) as { response_action?: string; errors?: Record<string, string> };
  assert.equal(body.response_action, 'errors');
  assert.ok(body.errors?.['field:category']);
});

test('a submission with no department is refused', async () => {
  const values = financeValues();
  delete (values as any).team_block;
  const response = await interact(submission(values));
  const body = (await response.json()) as { response_action?: string; errors?: Record<string, string> };
  assert.equal(body.response_action, 'errors');
  assert.ok(body.errors?.team_block);
});

test('a viewer cannot raise a ticket by posting a submission directly', async () => {
  const before = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n);
  const payload = submission(financeValues());
  payload.user.id = 'U_VIEWER';

  const response = await interact(payload);
  const body = (await response.json()) as { response_action?: string };
  assert.equal(body.response_action, 'errors', 'a viewer got a ticket through the back door');

  const after = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n);
  assert.equal(after, before);
});
