/**
 * Sending each department's tickets to its own place.
 *
 * HR tickets announce in the HR channel and ping the HR group; IT tickets go
 * to IT. A team with no override keeps using the single channel configured on
 * the integration, so this must change nothing for a deployment that wants one
 * channel for everything.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before, afterEach } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'teamrouting.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SECRET_KEY = 'b'.repeat(64);
delete process.env.DATABASE_URL;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, `teamrouting.db${suffix}`));
    } catch {
      // Absent on the first run.
    }
  }
}

let db: typeof import('../server/db/index.ts').db;
let routing: typeof import('../server/repositories/team-routing.ts');
let slack: typeof import('../server/integrations/slack.ts');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Captures what would have been sent to Slack. */
function captureSlack(response: Record<string, unknown> = { ok: true, ts: '1790.1', channel: 'C_POSTED' }) {
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return sent;
}

/** Real rows, because the thread link references the ticket. */
async function seedTicket(id: string, teamId: string | null) {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO tickets (id, number, subject, description, description_format, team_id, status, priority, type, source, tags, escalation_level, created_at, updated_at)
     VALUES (?, ?, 'Laptop will not boot', '', 'text', ?, 'open', 'high', 'incident', 'web', '[]', 0, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    [id, Math.floor(Math.random() * 100000), teamId, now, now],
  );
}

const ticket = (teamId: string | null, id = `t-${Math.random()}`) =>
  ({
    id,
    reference: 'ESC-1',
    subject: 'Laptop will not boot',
    teamId,
    teamName: 'Whichever',
    priority: 'high',
    status: 'open',
    assigneeName: null,
    watcherIds: [],
  }) as never;

const ctx = (teamId: string | null, id?: string) =>
  ({
    event: 'ticketCreated' as const,
    ticket: ticket(teamId, id),
    actorName: 'Someone',
    headline: 'New ticket',
    ticketUrl: 'https://example.test/t/1',
  }) as never;

const record = { provider: 'slack', enabled: true, config: { mode: 'bot', botToken: 'x', channel: 'C_DEFAULT' } } as never;

before(async () => {
  wipe();
  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();
  routing = await import('../server/repositories/team-routing.ts');
  slack = await import('../server/integrations/slack.ts');

  const now = new Date().toISOString();
  for (const [id, key, name] of [
    ['team-hr', 'HR', 'Human Resources'],
    ['team-it', 'IT', 'IT Support'],
    ['team-mkt', 'MKT', 'Marketing'],
  ] as const) {
    await db.run(
      `INSERT INTO teams (id, key, name, color, auto_assign, default_priority, sla_response_mins, sla_resolve_mins, created_at, updated_at)
       VALUES (?, ?, ?, '#888', 'none', 'normal', 240, 2880, ?, ?)`,
      [id, key, name, now, now],
    );
  }
});

after(async () => {
  await db.close();
  wipe();
});

test('a department posts to its own channel and pings its own group', async () => {
  await routing.setTeamRoute('team-hr', 'slack', 'C_HR', 'S0HRGROUP');

  const sent = captureSlack();
  const result = await slack.sendSlack(record, ctx('team-hr'));

  assert.equal(result.ok, true);
  assert.equal(sent[0].channel, 'C_HR', 'HR tickets must not land in the default channel');
  assert.match(String(sent[0].text), /<!subteam\^S0HRGROUP>/, 'the ping belongs in the push line too');
  assert.match(JSON.stringify(sent[0].blocks), /<!subteam\^S0HRGROUP>/, 'Slack only notifies on a mention in the body');
});

test('a department with no override uses the default channel', async () => {
  const sent = captureSlack();
  await slack.sendSlack(record, ctx('team-mkt'));

  assert.equal(sent[0].channel, 'C_DEFAULT');
  assert.doesNotMatch(String(sent[0].text), /<!/, 'nobody is pinged when nobody was configured');
});

test('a ticket with no department uses the default channel', async () => {
  const sent = captureSlack();
  await slack.sendSlack(record, ctx(null));
  assert.equal(sent[0].channel, 'C_DEFAULT');
});

test('two departments do not leak into each other', async () => {
  await routing.setTeamRoute('team-it', 'slack', 'C_IT', null);

  const sent = captureSlack();
  await slack.sendSlack(record, ctx('team-hr'));
  await slack.sendSlack(record, ctx('team-it'));

  assert.equal(sent[0].channel, 'C_HR');
  assert.equal(sent[1].channel, 'C_IT');
  assert.match(String(sent[0].text), /subteam/, 'HR pings its group');
  assert.doesNotMatch(String(sent[1].text), /subteam/, 'IT configured no group, so nobody is pinged');
});

test('once a ticket has a thread, later notices stay in it', async () => {
  // Moving a ticket between departments must not split its conversation across
  // two channels - the follow-up belongs with the message people replied to.
  const id = 'ticket-threaded';
  await seedTicket(id, 'team-hr');

  const sent = captureSlack();
  await slack.sendSlack(record, ctx('team-hr', id));
  assert.equal(sent[0].channel, 'C_HR');

  const second = captureSlack();
  await slack.sendSlack(record, ctx('team-it', id));
  assert.equal(second[0].channel, 'C_POSTED', 'it follows the thread, not the new department');
  assert.ok(second[0].thread_ts, 'and it is a reply, not a new message');
});

test('what people type as a mention becomes what Slack pings', () => {
  const cases: Array<[string | null, string | null]> = [
    ['@here', '<!here>'],
    ['here', '<!here>'],
    ['@channel', '<!channel>'],
    ['S0123456', '<!subteam^S0123456>'],
    ['U0123456', '<@U0123456>'],
    ['<!subteam^S9>', '<!subteam^S9>'],
    ['', null],
    ['   ', null],
    [null, null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(routing.normaliseMention(input), expected, `for input ${JSON.stringify(input)}`);
  }
});

test('a handle that cannot be resolved is kept, not dropped', () => {
  // @hr-team cannot be turned into an id here. Keeping it means the message
  // still reads as addressed to HR, which beats silently losing the intent.
  assert.equal(routing.normaliseMention('@hr-team'), '@hr-team');
});

test('clearing both fields removes the override rather than storing a blank one', async () => {
  await routing.setTeamRoute('team-mkt', 'slack', 'C_MKT', '@here');
  assert.ok(await routing.findTeamRoute('team-mkt', 'slack'));

  await routing.setTeamRoute('team-mkt', 'slack', '', '');
  assert.equal(await routing.findTeamRoute('team-mkt', 'slack'), null, 'an empty override is not configuration');

  const sent = captureSlack();
  await slack.sendSlack(record, ctx('team-mkt'));
  assert.equal(sent[0].channel, 'C_DEFAULT', 'and it falls back to the default again');
});

test('a ping with no channel override still goes to the default channel', async () => {
  await routing.setTeamRoute('team-mkt', 'slack', '', '@here');
  const sent = captureSlack();
  await slack.sendSlack(record, ctx('team-mkt'));

  assert.equal(sent[0].channel, 'C_DEFAULT');
  assert.match(String(sent[0].text), /<!here>/, 'the ping applies even without a channel of its own');
});

test('deleting a team takes its routing with it', async () => {
  await routing.setTeamRoute('team-it', 'slack', 'C_IT', null);
  await db.run(`DELETE FROM teams WHERE id = ?`, ['team-it']);
  const left = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM team_routing WHERE team_id = ?`, ['team-it']);
  assert.equal(Number(left!.n), 0, 'routing must not outlive the team it belongs to');
});
