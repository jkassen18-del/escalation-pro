/**
 * Quick tickets (templated ticket types) and handing a ticket to another
 * department, over real HTTP against a throwaway SQLite database.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Before any server module loads: config reads these once, at import.
process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'quick-tickets.db';
process.env.SESSION_SECRET = 'q'.repeat(48);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const wipe = () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `quick-tickets.db${suffix}`), { force: true });
};

let server: http.Server;
let base: string;
let db: typeof import('../server/db/index.ts').db;
const cookies: Record<string, string> = {};
const teams: Record<string, string> = {};

async function call(who: string, method: string, url: string, body?: unknown) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: cookies[who] ?? '' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload: any = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // empty
  }
  return { status: response.status, payload };
}

async function login(who: string, email: string) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: email, password: 'Quick-Password-1' }),
  });
  assert.equal(response.status, 200, `${who} signs in`);
  cookies[who] = response.headers.get('set-cookie')!.split(';')[0];
}

before(async () => {
  wipe();
  const dist = path.resolve(import.meta.dirname, '../dist/client');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }
  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword('Quick-Password-1');
  const now = new Date().toISOString();
  const addUser = (id: string, email: string, role: string) =>
    db.run(
      'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, email, id, `Person ${id}`, hash, salt, role, 'active', '#9a7b2f', 0, now, now],
    );
  await addUser('u-admin', 'admin@acme.test', 'admin');
  await addUser('u-agent', 'agent@acme.test', 'agent');
  await addUser('u-net', 'net@acme.test', 'agent');
  await addUser('u-viewer', 'viewer@acme.test', 'viewer');

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  await login('admin', 'admin@acme.test');
  await login('agent', 'agent@acme.test');
  await login('net', 'net@acme.test');
  await login('viewer', 'viewer@acme.test');

  for (const [key, name] of [
    ['DSK', 'Service Desk'],
    ['NET', 'Network'],
    ['FAC', 'Facilities'],
  ]) {
    const created = await call('admin', 'POST', '/api/teams', { name, key });
    teams[key] = created.payload.team.id;
  }
  // The agent works the Service Desk; the network engineer is in Network, which auto-assigns.
  await db.run(`INSERT INTO team_members (team_id, user_id, is_lead) VALUES (?, 'u-agent', 0)`, [teams.DSK]);
  await db.run(`INSERT INTO team_members (team_id, user_id, is_lead) VALUES (?, 'u-net', 1)`, [teams.NET]);
  await db.run(`UPDATE teams SET auto_assign = 'round_robin' WHERE id = ?`, [teams.NET]);
});

after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db.close();
  wipe();
});

let siteIssueId: string;

test('team managers create quick tickets; others cannot', async () => {
  const refused = await call('agent', 'POST', '/api/ticket-templates', { name: 'Nope', teamId: teams.NET });
  assert.equal(refused.status, 403);

  const created = await call('admin', 'POST', '/api/ticket-templates', {
    name: 'Site issue',
    description: 'A branch or site has lost something it needs.',
    icon: 'globe',
    color: '#b54708',
    teamId: teams.NET,
    ticketType: 'incident',
    priority: 'high',
    severity: 'sev2',
    subjectTemplate: 'Site issue: {{site}} - {{summary}}',
    guidance: 'Say which site and what stopped working.',
    screenshot: 'encouraged',
    tags: ['Site', 'network'],
    fields: [
      { label: 'Site', type: 'select', required: true, options: ['Johannesburg', 'Cape Town'] },
      { label: 'People affected', type: 'number' },
    ],
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const template = created.payload.template;
  siteIssueId = template.id;
  assert.equal(template.teamName, 'Network');
  assert.deepEqual(template.fields.map((f: any) => f.key), ['site', 'people_affected']);
  assert.deepEqual(template.tags, ['site', 'network']);

  // Editing keeps each question's key, so the subject template keeps working.
  const updated = await call('admin', 'PUT', `/api/ticket-templates/${template.id}`, {
    ...template,
    fields: [{ ...template.fields[0], label: 'Which site?' }, template.fields[1]],
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.payload.template.fields[0].key, 'site');
  assert.equal(updated.payload.template.fields[0].label, 'Which site?');

  const visible = await call('agent', 'GET', '/api/ticket-templates');
  assert.deepEqual(visible.payload.templates.map((t: any) => t.name), ['Site issue']);
  assert.equal((await call('viewer', 'GET', '/api/ticket-templates')).payload.templates.length, 0, 'viewers cannot raise tickets');
});

test('a quick ticket routes to its department with the subject filled in', async () => {
  const missing = await call('agent', 'POST', `/api/ticket-templates/${siteIssueId}/tickets`, { summary: 'No internet', answers: {} });
  assert.equal(missing.status, 400);
  assert.match(missing.payload.error, /"Which site\?" is required/);

  const res = await call('agent', 'POST', `/api/ticket-templates/${siteIssueId}/tickets`, {
    summary: 'No internet since 08:00',
    answers: { site: 'Cape Town', people_affected: 40 },
    description: '<p>The whole floor is offline.</p>',
    // A client cannot redirect a quick ticket by adding its own routing.
    teamId: teams.FAC,
    priority: 'low',
  });
  assert.equal(res.status, 201, JSON.stringify(res.payload));
  const ticket = res.payload.ticket;
  assert.equal(ticket.subject, 'Site issue: Cape Town - No internet since 08:00');
  assert.equal(ticket.teamId, teams.NET);
  assert.equal(ticket.priority, 'high');
  assert.equal(ticket.type, 'incident');
  assert.equal(ticket.severity, 'sev2');
  assert.equal(ticket.templateName, 'Site issue');
  assert.equal(ticket.requesterId, 'u-agent');
  assert.equal(ticket.assigneeId, 'u-net', "Network's auto-assignment applies");

  const detail = (await call('admin', 'GET', `/api/tickets/${ticket.id}`)).payload.ticket;
  const answers = Object.fromEntries(detail.fieldValues.map((v: any) => [v.key, v.value]));
  assert.deepEqual(answers, { site: 'Cape Town', people_affected: 40 });
});

test('an unanswered placeholder leaves no dangling separator', async () => {
  const res = await call('agent', 'POST', `/api/ticket-templates/${siteIssueId}/tickets`, { answers: { site: 'Johannesburg' } });
  assert.equal(res.payload.ticket.subject, 'Site issue: Johannesburg');
});

test('a quick ticket limited to some teams is refused to everyone else', async () => {
  const created = await call('admin', 'POST', '/api/ticket-templates', {
    name: 'Core switch change',
    teamId: teams.NET,
    audienceTeamIds: [teams.NET],
    subjectTemplate: 'Change: {{summary}}',
  });
  const id = created.payload.template.id;
  const agentList = await call('agent', 'GET', '/api/ticket-templates');
  assert.ok(!agentList.payload.templates.some((t: any) => t.id === id));
  assert.equal((await call('agent', 'POST', `/api/ticket-templates/${id}/tickets`, { summary: 'x' })).status, 403);
  assert.equal((await call('net', 'POST', `/api/ticket-templates/${id}/tickets`, { summary: 'VLAN 40' })).status, 201);
  const all = await call('admin', 'GET', '/api/ticket-templates?all=1');
  assert.equal(all.payload.templates.length, 2);
});

test('a required screenshot is asked for, and a pasted one becomes an attachment', async () => {
  const created = await call('admin', 'POST', '/api/ticket-templates', {
    name: 'Error on screen',
    teamId: teams.DSK,
    screenshot: 'required',
    subjectTemplate: 'Error: {{summary}}',
  });
  const id = created.payload.template.id;
  const refused = await call('agent', 'POST', `/api/ticket-templates/${id}/tickets`, { summary: 'Blue screen' });
  assert.equal(refused.status, 400);
  assert.match(refused.payload.error, /needs a screenshot/);

  // A screenshot bigger than the old 2MB body limit and 400k-character text
  // limit, as a Win+Shift+S capture of a large screen can be.
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(1_800_000, 7)]);
  const description = `<p>See below</p><p><img src="data:image/png;base64,${png.toString('base64')}"></p>`;
  const res = await call('agent', 'POST', `/api/ticket-templates/${id}/tickets`, { summary: 'Blue screen', description });
  assert.equal(res.status, 201, JSON.stringify(res.payload).slice(0, 300));
  const detail = (await call('agent', 'GET', `/api/tickets/${res.payload.ticket.id}`)).payload.ticket;
  assert.equal(detail.attachments.length, 1);
  assert.equal(detail.attachments[0].size, png.length, 'the image arrives whole');
  assert.match(detail.description, /\/api\/tickets\/[^"]+\/attachments\//);

  // One added with the file picker is uploaded afterwards; the client says it is coming.
  const toFollow = await call('agent', 'POST', `/api/ticket-templates/${id}/tickets`, { summary: 'Printer jam', screenshotsToFollow: 1 });
  assert.equal(toFollow.status, 201);
});

test('a large pasted screenshot also gets through on a plain ticket and a comment', async () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(900_000, 3)]);
  const img = `<img src="data:image/png;base64,${png.toString('base64')}">`;
  const created = await call('agent', 'POST', '/api/tickets', { subject: 'Plain', description: `<p>x</p>${img}`, descriptionFormat: 'html', teamId: teams.DSK });
  assert.equal(created.status, 201);
  const comment = await call('agent', 'POST', `/api/tickets/${created.payload.ticket.id}/comments`, { body: `<p>and</p>${img}`, bodyFormat: 'html', isInternal: false });
  assert.equal(comment.status, 201, JSON.stringify(comment.payload).slice(0, 300));
  const detail = (await call('agent', 'GET', `/api/tickets/${created.payload.ticket.id}`)).payload.ticket;
  assert.equal(detail.attachments.length, 2);
  // Signed out, a big body is not even parsed.
  const anonymous = await fetch(`${base}/api/tickets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'x', description: img }) });
  assert.equal(anonymous.status, 401);
});

test('escalating to another department hands the ticket over', async () => {
  const created = await call('agent', 'POST', '/api/tickets', { subject: 'VPN keeps dropping', teamId: teams.DSK, assigneeId: 'u-agent', priority: 'normal' });
  const id = created.payload.ticket.id;

  const same = await call('agent', 'POST', `/api/tickets/${id}/escalate`, { teamId: teams.DSK, reason: 'x' });
  assert.equal(same.status, 400);
  assert.equal((await call('agent', 'POST', `/api/tickets/${id}/escalate`, { teamId: teams.NET })).status, 400, 'a reason is required');

  const res = await call('agent', 'POST', `/api/tickets/${id}/escalate`, { teamId: teams.NET, reason: 'Firewall drops the tunnel; needs Network.', priority: 'high' });
  assert.equal(res.status, 200, JSON.stringify(res.payload));
  const ticket = res.payload.ticket;
  assert.equal(ticket.teamId, teams.NET);
  assert.equal(ticket.escalationLevel, 1);
  assert.equal(ticket.priority, 'high');
  assert.equal(ticket.type, 'request', 'the type is kept');
  assert.equal(ticket.assigneeId, 'u-net', 'the old assignee is not in Network, so Network auto-assigns');

  const detail = (await call('admin', 'GET', `/api/tickets/${id}`)).payload.ticket;
  assert.ok(detail.comments.some((c: any) => c.isInternal && /^Escalated from Service Desk to Network\. Firewall drops/.test(c.body)));
  assert.ok(detail.events.some((e: any) => e.action === 'escalated' && e.field === 'team' && e.fromValue === 'Service Desk' && e.toValue === 'Network'));

  const audit = await call('admin', 'GET', '/api/audit?search=from Service Desk to Network');
  assert.equal(audit.payload.total, 1);
  const bell = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = 'u-net' AND type = 'escalated'`);
  assert.equal(Number(bell!.n), 1, 'the new department hears about it');
});

test('without a department, escalating works as it always did', async () => {
  const created = await call('agent', 'POST', '/api/tickets', { subject: 'Slow laptop', teamId: teams.DSK, priority: 'normal' });
  const res = await call('agent', 'POST', `/api/tickets/${created.payload.ticket.id}/escalate`, { reason: 'Exec is waiting' });
  assert.equal(res.status, 200);
  assert.equal(res.payload.ticket.teamId, teams.DSK);
  assert.equal(res.payload.ticket.escalationLevel, 1);
  assert.equal(res.payload.ticket.priority, 'high');
  assert.equal(res.payload.ticket.type, 'escalation');
});

test('deleting a quick ticket keeps the tickets raised from it', async () => {
  const before = (await call('admin', 'GET', '/api/tickets?limit=100')).payload.total;
  assert.equal((await call('admin', 'DELETE', `/api/ticket-templates/${siteIssueId}`)).status, 204);
  assert.equal((await call('admin', 'GET', '/api/tickets?limit=100')).payload.total, before);
  assert.equal((await call('agent', 'POST', `/api/ticket-templates/${siteIssueId}/tickets`, { answers: { site: 'Cape Town' } })).status, 404);
});
