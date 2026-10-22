/**
 * The Teams app as an admin runs it: a version that goes up exactly when the
 * package changes, a command menu they control, and the forms that open from
 * the compose box and a message's … menu.
 *
 * Microsoft's handshake is stubbed at the network boundary (the same way as
 * teams-bot.test.ts); every decision this code makes runs for real.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'teamsapp.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.SECRET_KEY = 'b'.repeat(64);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;
delete process.env.APP_URL;

const APP_ID = '11111111-2222-3333-4444-555555555555';
const SERVICE_URL = 'https://smba.trafficmanager.net/emea/';
const CONVERSATION = '19:app123@thread.tacv2';
const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const PASSWORD = 'Adm1n-Password!';

const signingKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-app';

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, `teamsapp.db${suffix}`));
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

function mintToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: KID })}.${encode({
    iss: 'https://api.botframework.com',
    aud: APP_ID,
    serviceurl: SERVICE_URL,
    nbf: now - 60,
    exp: now + 3600,
  })}`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), signingKey.privateKey).toString('base64url')}`;
}

let server: http.Server;
let base: string;
let cookie = '';
let db: typeof import('../server/db/index.ts').db;
let financeId = '';
let hrId = '';
let templateId = '';
let manifestModule: typeof import('../server/integrations/teams-manifest.ts');

let sent: Array<{ url: string; body: any }> = [];
const ROSTER: Record<string, { email?: string; name: string }> = {
  '29:agent': { email: 'agent@acme.test', name: 'Ada Agent' },
  '29:viewer': { email: 'viewer@acme.test', name: 'Vic Viewer' },
};
const realFetch = globalThis.fetch;

before(async () => {
  wipe();
  ensureClientDist();

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('.well-known/openidconfiguration')) return Response.json({ jwks_uri: 'https://login.botframework.com/v1/.well-known/keys' });
    if (url.includes('botframework.com/v1/.well-known/keys')) {
      const jwk = signingKey.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
      return Response.json({ keys: [{ ...jwk, kid: KID, use: 'sig' }] });
    }
    if (url.includes('login.microsoftonline.com')) return Response.json({ access_token: 'outbound-token', expires_in: 3600 });
    const member = /\/v3\/conversations\/[^/]+\/members\/([^/?]+)$/.exec(url);
    if (member) {
      const person = ROSTER[decodeURIComponent(member[1])];
      return person ? Response.json(person) : new Response('not found', { status: 404 });
    }
    if (url.startsWith(SERVICE_URL) || url.includes('/v3/conversations/')) {
      sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return Response.json({ id: `activity-${sent.length}` });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  manifestModule = await import('../server/integrations/teams-manifest.ts');
  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword(PASSWORD);
  const now = new Date().toISOString();
  const addUser = (id: string, email: string, role: string) =>
    db.run(
      'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, email, id.toLowerCase(), `Name ${id}`, hash, salt, role, 'active', '#9a7b2f', 0, now, now],
    );
  await addUser('u-admin', 'admin@acme.test', 'admin');
  await addUser('u-agent', 'agent@acme.test', 'agent');
  await addUser('u-viewer', 'viewer@acme.test', 'viewer');
  await db.run('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', ['ticket_number', 1000]);

  const { createTeam } = await import('../server/repositories/teams.ts');
  financeId = await createTeam({ key: 'finance', name: 'Finance' });
  hrId = await createTeam({ key: 'hr', name: 'People Team' });
  const { replaceTeamForm } = await import('../server/repositories/form-fields.ts');
  await replaceTeamForm(financeId, [{ label: 'Cost centre', type: 'text', required: true }]);

  const { saveTemplate, validateTemplate } = await import('../server/repositories/ticket-templates.ts');
  const template = await saveTemplate(
    null,
    validateTemplate({
      name: 'Laptop broken',
      teamId: hrId,
      priority: 'high',
      subjectTemplate: 'Laptop: {{asset}}',
      screenshot: 'off',
      fields: [{ label: 'Asset', type: 'text', required: true }],
    }),
    'u-admin',
  );
  templateId = template.id;

  const { saveIntegration } = await import('../server/integrations/store.ts');
  await saveIntegration('msteams', { enabled: true, config: { mode: 'bot', appId: APP_ID, appPassword: 'secret', tenantId: 'tenant-1', botName: 'InfraBot' } });

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;

  const login = await realFetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'admin@acme.test', password: PASSWORD }),
  });
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie, 'the admin could not sign in');
  await realFetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ appUrl: 'https://tickets.example.internal' }),
  });
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

/* --------------------------------- Helpers -------------------------------- */

const appState = async () => (await realFetch(`${base}/api/integrations/msteams/app`, { headers: { cookie } })).json() as Promise<any>;
const saveApp = (body: unknown) =>
  realFetch(`${base}/api/integrations/msteams/app`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const download = () => realFetch(`${base}/api/integrations/msteams/app-package`, { headers: { cookie } });

function activity(overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    id: `act-${Math.random().toString(36).slice(2)}`,
    serviceUrl: SERVICE_URL,
    conversation: { id: CONVERSATION, conversationType: 'personal' },
    from: { id: '29:agent', name: 'Ada Agent' },
    recipient: { id: `28:${APP_ID}`, name: 'InfraBot' },
    channelData: { tenant: { id: 'tenant-1' } },
    ...overrides,
  };
}

async function post(body: unknown): Promise<any> {
  sent = [];
  const response = await realFetch(`${base}/api/webhooks/msteams`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mintToken()}` },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

const invoke = (name: string, value: Record<string, unknown>, from = '29:agent') =>
  post(activity({ type: 'invoke', name, value, from: { id: from, name: 'Someone' } }));

function lastCard(): any {
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    const card = sent[i].body?.attachments?.[0]?.content;
    if (card) return card;
  }
  return null;
}
function raisedCard(): any {
  return sent.map((entry) => entry.body?.attachments?.[0]?.content).find((card) => /^Raised /.test(card?.body?.[0]?.text ?? ''));
}
function lastText(): string {
  for (let i = sent.length - 1; i >= 0; i -= 1) if (typeof sent[i].body?.text === 'string') return sent[i].body.text;
  return '';
}
const inputs = (card: any): any[] => (card?.body ?? []).filter((block: any) => block.id);

/* -------------------------------- Manifest -------------------------------- */

test('the manifest carries the command menu and both form commands', () => {
  const manifest = manifestModule.buildTeamsManifest({ appId: APP_ID, appUrl: 'https://tickets.example.internal', teams: [] }) as any;
  assert.deepEqual(
    manifest.bots[0].commandLists[0].commands.map((c: any) => c.title),
    ['help', 'new', 'status', 'mine', 'oncall'],
  );
  const extension = manifest.composeExtensions[0];
  assert.equal(extension.botId, APP_ID, 'the forms must be answered by the same bot');
  const byId = Object.fromEntries(extension.commands.map((c: any) => [c.id, c]));
  assert.equal(byId.raiseTicket.type, 'action');
  assert.equal(byId.raiseTicket.fetchTask, true);
  assert.deepEqual(byId.raiseTicket.context, ['compose', 'commandBox']);
  assert.deepEqual(byId.ticketFromMessage.context, ['message']);
});

test('validation names what Teams would reject', () => {
  const { validateTeamsPackage } = manifestModule;
  assert.deepEqual(validateTeamsPackage({ appId: APP_ID, appUrl: 'https://tickets.example.internal', teams: [] }), []);

  const many = Array.from({ length: 12 }, (_, i) => ({ title: `c${i}`, description: 'x' }));
  assert.match(validateTeamsPackage({ appId: APP_ID, appUrl: 'https://a.example', commands: many }).join(' '), /12 commands/);
  assert.match(
    validateTeamsPackage({ appId: APP_ID, appUrl: 'https://a.example', commands: [{ title: 'a', description: 'y'.repeat(200) }] }).join(' '),
    /longer than 128/,
  );
  assert.match(validateTeamsPackage({ appId: 'nope', appUrl: 'https://a.example' }).join(' '), /GUID/);
  assert.match(validateTeamsPackage({ appId: APP_ID, appUrl: 'http://a.example' }).join(' '), /https/);

  assert.match(validateTeamsPackage({ appId: APP_ID, appUrl: 'https://a.example', colorIconPng: fakePng(100, 100) }).join(' '), /192x192/);
  assert.match(validateTeamsPackage({ appId: APP_ID, appUrl: 'https://a.example', colorIconPng: Buffer.from('not a png') }).join(' '), /not a PNG/);
});

/** manifest.json out of a package, read from its local file header. */
function manifestFromZip(zip: Buffer): any {
  for (let offset = 0; offset + 30 < zip.length; ) {
    if (zip.readUInt32LE(offset) !== 0x04034b50) break;
    const method = zip.readUInt16LE(offset + 8);
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extra = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const data = zip.subarray(offset + 30 + nameLength + extra, offset + 30 + nameLength + extra + size);
    if (name === 'manifest.json') return JSON.parse((method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8'));
    offset += 30 + nameLength + extra + size;
  }
  throw new Error('no manifest.json in the package');
}

function fakePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

/* --------------------------------- Version -------------------------------- */

test('the version stays put until the package changes, then goes up once', async () => {
  let state = await appState();
  assert.equal(state.version, '1.1.0');
  assert.equal(state.lastDownload, null);
  assert.deepEqual(state.problems, []);

  assert.equal((await download()).status, 200);
  state = await appState();
  assert.equal(state.lastDownload.version, '1.1.0');
  assert.equal(state.version, '1.1.0', 'an unchanged package must not bump');
  assert.equal(state.updateAvailable, false);
  assert.deepEqual(state.changes, []);

  // Saving exactly what is there changes nothing.
  assert.equal((await saveApp({ name: '' })).status, 200);
  assert.equal((await appState()).version, '1.1.0');

  assert.equal((await saveApp({ name: 'HelpBot', accentColor: '#0055aa' })).status, 200);
  state = await appState();
  assert.equal(state.version, '1.1.1');
  assert.equal(state.updateAvailable, true);
  assert.ok(state.changes.some((change: string) => /Renamed/.test(change)), state.changes.join(' | '));
  assert.ok(state.changes.some((change: string) => /accent/i.test(change)));

  // Further changes before the next download do not keep bumping.
  await saveApp({ shortDescription: 'Tickets in Teams.' });
  assert.equal((await appState()).version, '1.1.1');

  const response = await download();
  const zip = Buffer.from(await response.arrayBuffer());
  assert.equal(manifestFromZip(zip).version, '1.1.1', 'the downloaded manifest carries the bumped version');
  assert.equal(manifestFromZip(zip).name.short, 'HelpBot');
  state = await appState();
  assert.equal(state.lastDownload.version, '1.1.1');
  assert.equal(state.updateAvailable, false);

  // A new department changes the menu, which is a change to the package.
  const { createTeam } = await import('../server/repositories/teams.ts');
  const opsId = await createTeam({ key: 'ops', name: 'Operations' });
  state = await appState();
  assert.equal(state.version, '1.1.2');
  assert.ok(state.changes.some((change: string) => /ops/.test(change)));
  await db.run('DELETE FROM teams WHERE id = ?', [opsId]);

  // A minimum version jumps past one installed elsewhere.
  await saveApp({ minimumVersion: '3.0.0' });
  assert.equal((await appState()).version, '3.0.0');
  await saveApp({ minimumVersion: '' });
});

test('an icon must be a 192x192 PNG', async () => {
  const wrong = await saveApp({ icon: fakePng(64, 64).toString('base64') });
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /192x192/);
  assert.equal((await saveApp({ icon: 'data:image/png;base64,' + fakePng(192, 192).toString('base64') })).status, 200);
  assert.equal((await appState()).settings.hasCustomIcon, true);
  await saveApp({ icon: null });
});

test('an outline icon must be a 32x32 PNG, and changing it is an update', async () => {
  const wrong = await saveApp({ outline: fakePng(192, 192).toString('base64') });
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /32x32/);
  const before = await appState();
  assert.equal((await saveApp({ outline: fakePng(32, 32).toString('base64') })).status, 200);
  const after = await appState();
  assert.equal(after.settings.hasCustomOutline, true);
  assert.ok(after.changes.includes('The icon changed.') || before.lastDownload === null);
  await saveApp({ outline: null });
});

test('custom commands are validated', async () => {
  const clash = await saveApp({ commands: [{ kind: 'custom', title: 'finance', description: 'x', action: { type: 'reply', text: 'hi' } }] });
  assert.equal(clash.status, 400);
  const spaces = await saveApp({ commands: [{ kind: 'custom', title: 'two words', description: 'x', action: { type: 'reply', text: 'hi' } }] });
  assert.equal(spaces.status, 400);
  const nothing = await saveApp({ commands: [{ kind: 'custom', title: 'empty', description: 'x', action: { type: 'reply', text: '' } }] });
  assert.equal(nothing.status, 400);
  const ghost = await saveApp({ commands: [{ kind: 'custom', title: 'ghost', description: 'x', action: { type: 'department', teamId: 'nope' } }] });
  assert.equal(ghost.status, 400);
});

test('a viewer cannot read or change the Teams app', async () => {
  const login = await realFetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'viewer@acme.test', password: PASSWORD }),
  });
  const viewer = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.equal((await realFetch(`${base}/api/integrations/msteams/app`, { headers: { cookie: viewer } })).status, 403);
});

/* -------------------------------- Commands -------------------------------- */

test('help lists the switched-on commands', async () => {
  await post(activity({ text: '<at>InfraBot</at> help' }));
  const facts = lastCard().body.find((block: any) => block.type === 'FactSet').facts.map((fact: any) => fact.title);
  for (const name of ['help', 'new', 'status', 'mine', 'oncall', 'finance', 'hr']) assert.ok(facts.includes(name), `${name} missing from help`);
});

test('new offers the departments and quick tickets, and a pick posts that form', async () => {
  await post(activity({ text: 'new' }));
  const chooser = lastCard();
  const values = chooser.body.find((block: any) => block.id === 'choice').choices.map((choice: any) => choice.value);
  assert.ok(values.includes(`team:${financeId}`));
  assert.ok(values.includes(`template:${templateId}`));

  await post(activity({ text: '', value: { action: 'infraticket_pick', choice: `team:${financeId}` } }));
  const ids = inputs(lastCard()).map((block: any) => block.id);
  assert.ok(ids.includes('field:cost_centre'), ids.join(', '));
});

test('status shows a ticket only to someone who may see it', async () => {
  const { createTicket } = await import('../server/services/tickets.ts');
  const { findUserById } = await import('../server/repositories/users.ts');
  const admin = (await findUserById('u-admin'))!;
  const agent = (await findUserById('u-agent'))!;
  const hidden = await createTicket({ subject: 'Payroll secret', teamId: hrId, requesterId: 'u-admin' }, { actor: admin });
  const own = await createTicket({ subject: 'My keyboard', teamId: hrId, requesterId: 'u-agent' }, { actor: agent });

  // Creating them notifies the conversation; let that settle so it is not
  // mistaken for the answer.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const statusCardFor = (reference: string) =>
    sent.map((entry) => entry.body?.attachments?.[0]?.content).find((card) => (card?.body?.[0]?.text ?? '').startsWith(`${reference}:`));

  await post(activity({ text: `status ${hidden.reference}` }));
  assert.match(lastText(), /can't find/i);
  assert.equal(statusCardFor(hidden.reference), undefined, 'a ticket the agent may not see must not be shown');

  await post(activity({ text: `<at>InfraBot</at> status ${own.reference}` }));
  assert.match(statusCardFor(own.reference)?.body[0].text ?? '', /My keyboard/);

  await post(activity({ text: 'mine' }));
  const listed = JSON.stringify(sent.map((entry) => entry.body?.attachments?.[0]?.content).find((card) => card?.body?.[0]?.text === 'Your open tickets'));
  assert.match(listed, /My keyboard/);
  assert.doesNotMatch(listed, /Payroll secret/);
});

test('oncall answers even with no schedules', async () => {
  await post(activity({ text: 'oncall' }));
  assert.match(lastText(), /No on-call schedules/);
});

test('custom commands open forms and reply, and switched-off ones are not answered', async () => {
  const current = (await appState()).commands;
  const response = await saveApp({
    commands: [
      ...current.map((command: any) => ({
        id: command.id,
        kind: command.kind,
        ref: command.builtin ?? command.teamId,
        title: command.title,
        description: command.description,
        enabled: command.builtin !== 'mine',
        action: command.action,
      })),
      { kind: 'custom', title: 'wifi', description: 'Guest Wi-Fi', action: { type: 'reply', text: 'Network: Guest', url: 'https://wiki.example/wifi' } },
      { kind: 'custom', title: 'laptop', description: 'Broken laptop', action: { type: 'template', templateId } },
      { kind: 'custom', title: 'money', description: 'Finance form', action: { type: 'department', teamId: financeId } },
    ],
  });
  assert.equal(response.status, 200, await response.clone().text());
  const state = await response.json();
  const manifestTitles = state.commands.filter((command: any) => command.listed).map((command: any) => command.title);
  assert.ok(!manifestTitles.includes('mine'), 'a switched-off command stays out of the menu');
  assert.ok(manifestTitles.includes('wifi'));

  await post(activity({ text: 'wifi' }));
  assert.match(lastText(), /Network: Guest/);
  assert.match(lastText(), /wiki\.example/);

  await post(activity({ text: '<at>InfraBot</at> laptop' }));
  const ids = inputs(lastCard()).map((block: any) => block.id);
  assert.ok(ids.includes('tfield:asset'), ids.join(', '));

  await post(activity({ text: 'money' }));
  assert.ok(inputs(lastCard()).some((block: any) => block.id === 'field:cost_centre'));

  // "mine" is off, so it falls through to the department handler.
  await post(activity({ text: 'mine' }));
  assert.match(lastText(), /Which department/);
});

test('a quick-ticket form submitted in chat raises the ticket from the template', async () => {
  await post(activity({ text: '', value: { action: 'infraticket_template', templateId, 'tfield:asset': 'LT-0042', description: 'Screen flickers' } }));
  // Searched for rather than taken as the last card: notifications for other
  // tickets fan out without being awaited and can land after the reply.
  assert.ok(raisedCard(), 'no confirmation card was posted');
  const row = await db.get<{ subject: string; team_id: string; source: string; priority: string }>(
    `SELECT subject, team_id, source, priority FROM tickets WHERE subject = 'Laptop: LT-0042'`,
  );
  assert.ok(row, 'the ticket was not raised with the template subject');
  assert.equal(row?.team_id, hrId);
  assert.equal(row?.source, 'msteams');
  assert.equal(row?.priority, 'high', 'the template decides the priority');
});

/* ---------------------------------- Forms --------------------------------- */

test('"create ticket from message" opens a chooser carrying the message, then a prefilled form', async () => {
  const opened = await invoke('composeExtension/fetchTask', {
    commandId: 'ticketFromMessage',
    commandContext: 'message',
    messagePayload: {
      body: { contentType: 'html', content: '<p>The VPN drops every <b>10 minutes</b></p>' },
      linkToMessage: 'https://teams.microsoft.com/l/message/19:abc/123',
      from: { user: { displayName: 'Bea Builder' } },
    },
  });
  assert.equal(opened.task.type, 'continue');
  const chooser = opened.task.value.card.content;
  const next = chooser.actions[0].data;
  assert.match(next.prefill, /VPN drops every 10 minutes/);
  assert.match(next.prefill, /Bea Builder/);
  assert.match(next.prefill, /teams\.microsoft\.com\/l\/message/);

  const form = await invoke('composeExtension/submitAction', { commandId: 'ticketFromMessage', data: { ...next, choice: `team:${financeId}` } });
  assert.equal(form.task.type, 'continue');
  const description = form.task.value.card.content.body.find((block: any) => block.id === 'description');
  assert.match(description.value, /VPN drops/);

  const submit = form.task.value.card.content.actions[0].data;
  const done = await invoke('composeExtension/submitAction', {
    commandId: 'ticketFromMessage',
    data: { ...submit, subject: 'VPN keeps dropping', description: description.value, priority: 'high', 'field:cost_centre': 'CC-9' },
  });
  assert.equal(done.composeExtension.type, 'result');
  assert.match(done.composeExtension.attachments[0].content.body[0].text, /^Raised /);

  const row = await db.get<{ subject: string; description: string; source: string }>(
    `SELECT subject, description, source FROM tickets WHERE subject = 'VPN keeps dropping'`,
  );
  assert.ok(row, 'no ticket was raised');
  assert.equal(row!.source, 'msteams');
  assert.match(row!.description, /VPN drops every 10 minutes/);
});

test('a form missing a required answer is refused, not raised', async () => {
  const done = await invoke('composeExtension/submitAction', {
    commandId: 'raiseTicket',
    data: { action: 'infraticket_new', teamId: financeId, subject: 'No cost centre' },
  });
  assert.equal(done.task.type, 'message');
  const row = await db.get(`SELECT id FROM tickets WHERE subject = 'No cost centre'`);
  assert.equal(row, undefined);
});

test('task/fetch and task/submit round-trip a pop-up form from a card', async () => {
  const opened = await invoke('task/fetch', { data: { action: 'infraticket_pick', choice: `template:${templateId}` } });
  assert.equal(opened.task.type, 'continue');
  const card = opened.task.value.card.content;
  assert.ok(inputs(card).some((block: any) => block.id === 'tfield:asset'));

  const done = await invoke('task/submit', { data: { ...card.actions[0].data, 'tfield:asset': 'LT-7' } });
  assert.equal(done.task.type, 'message');
  assert.match(done.task.value, /^Raised .*Laptop: LT-7/);
  // The confirmation is also posted where the card was.
  assert.ok(raisedCard(), 'no confirmation card was posted');
});

test('someone who may not raise tickets is told so by the form', async () => {
  const opened = await invoke('composeExtension/fetchTask', { commandId: 'raiseTicket' }, '29:viewer');
  assert.equal(opened.task.type, 'message');
  assert.match(opened.task.value, /permission/i);
});
