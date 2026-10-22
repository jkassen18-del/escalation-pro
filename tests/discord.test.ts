/**
 * Discord: the Gateway connection, /ticket, ticket threads, replies, buttons,
 * account linking and pages by DM.
 *
 * Discord itself is replaced at the edges: REST by a fetch stub that records
 * every call, and the Gateway by a tiny WebSocket server written here (Node
 * has a WebSocket client built in, but no server).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'discord.db';
process.env.SESSION_SECRET = 'd'.repeat(48);
process.env.SECRET_KEY = 'e'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
process.env.DISCORD_SUPERVISE_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const wipe = () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `discord.db${suffix}`), { force: true });
};

const APP_ID = '111111111111111111';
const GUILD = '222222222222222222';
const CHANNEL = '333333333333333333';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

/* ----------------------------- fake Discord REST ---------------------------- */

interface Call {
  method: string;
  path: string;
  body: any;
}
const calls: Call[] = [];
let threadCounter = 0;
let messageCounter = 0;
const realFetch = globalThis.fetch;

function stubFetch() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://cdn.discordapp.com/')) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    if (!url.startsWith('https://discord.com/api/v10')) return realFetch(input, init);
    const pathname = url.slice('https://discord.com/api/v10'.length);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: pathname, body });

    if (pathname === '/gateway/bot') return Response.json({ url: gatewayUrl });
    if (pathname === '/users/@me' && method === 'GET') return Response.json({ id: 'bot-user', username: 'InfraBot' });
    if (pathname === '/applications/@me') return Response.json({ id: APP_ID, flags: 1 << 19 });
    if (pathname === '/users/@me/guilds') return Response.json([{ id: GUILD, name: 'Gold Media Lab' }]);
    if (pathname === '/users/@me/channels') return Response.json({ id: 'dm-channel' });
    if (/^\/channels\/[^/]+\/messages\/[^/]+\/threads$/.test(pathname)) {
      threadCounter += 1;
      return Response.json({ id: `44444444444444444${threadCounter}`, guild_id: GUILD, type: 11 });
    }
    if (/^\/channels\/[^/]+\/messages$/.test(pathname)) {
      messageCounter += 1;
      return Response.json({ id: `55555555555555555${messageCounter}`, channel_id: pathname.split('/')[2] });
    }
    if (method === 'PUT' && pathname.includes('/commands')) return Response.json(body);
    if (pathname.startsWith('/interactions/') || pathname.startsWith('/webhooks/')) return new Response(null, { status: 204 });
    return Response.json({ message: 'not stubbed' }, { status: 404 });
  }) as typeof fetch;
}

const callbacks = (interactionId: string) => calls.filter((c) => c.path.startsWith(`/interactions/${interactionId}/`)).map((c) => c.body);
const lastCallback = (interactionId: string) => callbacks(interactionId).at(-1);

/* --------------------------- fake Discord Gateway --------------------------- */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
interface FakeClient {
  socket: Duplex;
  send: (payload: unknown) => void;
  close: (code: number) => void;
}
let gatewayServer: http.Server;
let gatewayUrl = '';
const gatewayClients: FakeClient[] = [];
const received: any[] = [];
let connections = 0;

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x80 | opcode, length]) : Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
  return Buffer.concat([header, payload]);
}

/** Reads the client's (masked) frames and calls back with each text message or close. */
function readFrames(socket: Duplex, onText: (text: string) => void, onClose: () => void) {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = Boolean(buffer[1] & 0x80);
      const total = offset + (masked ? 4 : 0) + length;
      if (buffer.length < total) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      const data = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), total));
      if (mask) for (let i = 0; i < data.length; i += 1) data[i] ^= mask[i % 4];
      buffer = buffer.subarray(total);
      if (opcode === 1) onText(data.toString('utf8'));
      if (opcode === 8) onClose();
    }
  });
}

type Behaviour = (client: FakeClient, payload: any) => void;
let behaviour: Behaviour = () => undefined;

function startGateway(): Promise<void> {
  gatewayServer = http.createServer();
  gatewayServer.on('upgrade', (req, socket) => {
    const key = String(req.headers['sec-websocket-key']);
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    connections += 1;
    const client: FakeClient = {
      socket,
      send: (payload) => socket.write(frame(1, Buffer.from(JSON.stringify(payload)))),
      close: (code) => {
        const body = Buffer.alloc(2);
        body.writeUInt16BE(code);
        socket.write(frame(8, body));
        socket.end();
      },
    };
    gatewayClients.push(client);
    readFrames(
      socket,
      (text) => {
        const payload = JSON.parse(text);
        received.push(payload);
        if (payload.op === 1) client.send({ op: 11, d: null });
        behaviour(client, payload);
      },
      () => socket.end(),
    );
    socket.on('error', () => undefined);
    client.send({ op: 10, d: { heartbeat_interval: 45_000 } });
  });
  return new Promise((resolve) => gatewayServer.listen(0, '127.0.0.1', () => {
    gatewayUrl = `ws://127.0.0.1:${(gatewayServer.address() as { port: number }).port}`;
    resolve();
  }));
}

// Generous: under the full suite many test files run at once, and a gateway
// handshake over a real socket can take longer than it does alone.
const waitFor = async (check: () => boolean | Promise<boolean>, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};

/* ---------------------------------- app ----------------------------------- */

let server: http.Server;
let base: string;
let db: typeof import('../server/db/index.ts').db;
let handlers: typeof import('../server/integrations/discord-handlers.ts');
let teamId: string;
let otherTeamId: string;
const cookies: Record<string, string> = {};

async function login(email: string, password: string) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: email, password }),
  });
  return response.headers.get('set-cookie')!.split(';')[0];
}

async function call(cookie: string, method: string, url: string, body?: unknown) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json().catch(() => null)) as any };
}

/** An interaction as Discord sends it, from a guild member. */
let interactionCounter = 0;
function interaction(discordUserId: string, type: number, data: Record<string, unknown>) {
  interactionCounter += 1;
  return {
    id: `9000000000000000${interactionCounter}`,
    token: `token-${interactionCounter}`,
    type,
    application_id: APP_ID,
    guild_id: GUILD,
    channel_id: CHANNEL,
    member: { user: { id: discordUserId, username: `user-${discordUserId}` } },
    data,
  };
}

before(async () => {
  wipe();
  const dist = path.resolve(import.meta.dirname, '../dist/client');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }
  stubFetch();
  await startGateway();

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();
  handlers = await import('../server/integrations/discord-handlers.ts');

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const now = new Date().toISOString();
  const addUser = async (id: string, email: string, role: string) => {
    const { hash, salt } = hashPassword('Password-12345');
    await db.run(
      'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, email, id, `Person ${id}`, hash, salt, role, 'active', '#9a7b2f', 0, now, now],
    );
  };
  await addUser('u-admin', 'admin@acme.test', 'admin');
  await addUser('u-agent', 'agent@acme.test', 'agent');
  await addUser('u-viewer', 'viewer@acme.test', 'viewer');

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const [id, email] of [['u-admin', 'admin@acme.test'], ['u-agent', 'agent@acme.test'], ['u-viewer', 'viewer@acme.test']]) {
    cookies[id] = await login(email, 'Password-12345');
  }

  const team = await call(cookies['u-admin'], 'POST', '/api/teams', { name: 'Network', key: 'NET' });
  teamId = team.payload.team.id;
  otherTeamId = (await call(cookies['u-admin'], 'POST', '/api/teams', { name: 'Facilities', key: 'FAC' })).payload.team.id;
  // The agent works tickets in the Network department.
  await db.run(`INSERT INTO team_members (team_id, user_id, is_lead) VALUES (?, 'u-agent', 0)`, [teamId]);
  await db.run(`INSERT INTO team_members (team_id, user_id, is_lead) VALUES (?, 'u-viewer', 0)`, [teamId]);
});

after(async () => {
  const { refreshDiscordGateway, currentGateway } = await import('../server/integrations/discord-gateway.ts');
  void refreshDiscordGateway;
  currentGateway()?.stop();
  globalThis.fetch = realFetch;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  for (const client of gatewayClients) client.socket.destroy();
  await new Promise<void>((resolve) => gatewayServer?.close(() => resolve()));
  await db.close();
  wipe();
});

/* --------------------------------- config --------------------------------- */

test('the integration saves, keeps the token secret, and tests against Discord', async () => {
  const saved = await call(cookies['u-admin'], 'PATCH', '/api/integrations/discord', {
    config: { applicationId: APP_ID, botToken: 'bot-token-secret', channel: CHANNEL },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.integration.configured, true);
  assert.equal(saved.payload.integration.config.botToken, '');
  assert.equal(saved.payload.integration.config.botTokenSet, true);

  const overview = await call(cookies['u-admin'], 'GET', '/api/integrations/discord/overview');
  const invite = new URL(overview.payload.inviteUrl);
  assert.equal(invite.searchParams.get('client_id'), APP_ID);
  assert.equal(invite.searchParams.get('scope'), 'bot applications.commands');
  const permissions = BigInt(invite.searchParams.get('permissions')!);
  for (const bit of [10n, 11n, 14n, 16n, 31n, 35n, 38n]) assert.ok(permissions & (1n << bit), `permission bit ${bit}`);

  const tested = await call(cookies['u-admin'], 'POST', '/api/integrations/discord/test');
  assert.equal(tested.payload.ok, true, tested.payload.message);
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === `/channels/${CHANNEL}/messages`), 'a test message was posted');

  const routes = await call(cookies['u-admin'], 'PUT', '/api/integrations/discord/routes', { routes: [{ teamId: otherTeamId, channelId: '666666666666666666' }] });
  assert.deepEqual(routes.payload.routes, [{ teamId: otherTeamId, channelId: '666666666666666666' }]);
  assert.equal((await call(cookies['u-agent'], 'GET', '/api/integrations/discord/overview')).status, 403);
});

/* --------------------------------- gateway -------------------------------- */

test('the gateway identifies, registers commands, heartbeats and resumes after a drop', async () => {
  behaviour = (client, payload) => {
    if (payload.op === 2) {
      client.send({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-1', resume_gateway_url: gatewayUrl, user: { id: 'bot-user', username: 'InfraBot' }, guilds: [{ id: GUILD }] } });
    }
    if (payload.op === 6) client.send({ op: 0, t: 'RESUMED', s: 3, d: {} });
  };
  await call(cookies['u-admin'], 'PATCH', '/api/integrations/discord', { enabled: true });
  const gatewayModule = await import('../server/integrations/discord-gateway.ts');
  const { startDiscordGateway, refreshDiscordGateway, discordGatewayStatus } = gatewayModule;
  // The handler the server would install; the supervisor itself is driven by hand.
  startDiscordGateway(handlers.handleDiscordEvent)();
  await refreshDiscordGateway({ url: gatewayUrl });
  await waitFor(() => discordGatewayStatus().connected);

  const identify = received.find((p) => p.op === 2);
  assert.equal(identify.d.token, 'bot-token-secret');
  assert.equal(identify.d.intents, (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15));
  await waitFor(() => calls.some((c) => c.method === 'PUT' && c.path === `/applications/${APP_ID}/guilds/${GUILD}/commands`));
  const commands = calls.find((c) => c.path.endsWith('/commands'))!.body as Array<{ name: string }>;
  assert.deepEqual(commands.map((c) => c.name).sort(), ['link', 'ticket', 'unlink']);

  // An interaction over the gateway reaches the handlers and gets an answer by REST.
  gatewayClients.at(-1)!.send({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: interaction('d-stranger', 2, { name: 'ticket' }) });
  await waitFor(() => calls.some((c) => c.path.startsWith('/interactions/') && /not linked/.test(c.body?.data?.content ?? '')));

  // Dropped with a resumable code: the client reconnects and resumes the same session.
  gatewayClients.at(-1)!.close(4000);
  await waitFor(() => received.some((p) => p.op === 6), 10_000);
  const resume = received.find((p) => p.op === 6);
  assert.equal(resume.d.session_id, 'session-1');
  assert.equal(resume.d.seq, 2);
});

/* -------------------------------- linking --------------------------------- */

async function linkAccount(userId: string, discordUserId: string) {
  const command = interaction(discordUserId, 2, { name: 'link' });
  await handlers.handleInteraction(command as any);
  const content = lastCallback(command.id).data.content as string;
  assert.equal(lastCallback(command.id).data.flags, 64, 'the code is shown only to its owner');
  const code = /\*\*([A-Z0-9]{4}-[A-Z0-9]{4})\*\*/.exec(content)![1];
  return call(cookies[userId], 'POST', '/api/discord/link', { code });
}

test('/link gives a one-time code that links the account from the profile', async () => {
  const linked = await linkAccount('u-admin', 'd-admin');
  assert.equal(linked.status, 200, JSON.stringify(linked.payload));
  const me = await call(cookies['u-admin'], 'GET', '/api/discord/me');
  assert.equal(me.payload.linked, true);

  const reused = await call(cookies['u-agent'], 'POST', '/api/discord/link', { code: 'AAAA-BBBB' });
  assert.equal(reused.status, 400, 'an unknown code is refused');
  assert.equal((await linkAccount('u-agent', 'd-agent')).status, 200);
  assert.equal((await linkAccount('u-viewer', 'd-viewer')).status, 200);
});

/* ---------------------------------- /ticket -------------------------------- */

let ticketId: string;
let threadId: string;

test('/ticket opens a modal, raises the ticket in the department and starts one thread', async () => {
  const unlinked = interaction('d-stranger', 2, { name: 'ticket', options: [{ name: 'department', value: teamId }] });
  await handlers.handleInteraction(unlinked as any);
  assert.match(lastCallback(unlinked.id).data.content, /not linked/);

  const viewer = interaction('d-viewer', 2, { name: 'ticket', options: [{ name: 'department', value: teamId }] });
  await handlers.handleInteraction(viewer as any);
  assert.match(lastCallback(viewer.id).data.content, /permission/, 'a viewer cannot raise tickets');

  const command = interaction('d-agent', 2, { name: 'ticket', options: [{ name: 'department', value: teamId }, { name: 'priority', value: 'high' }] });
  await handlers.handleInteraction(command as any);
  const modal = lastCallback(command.id);
  assert.equal(modal.type, 9);
  assert.equal(modal.data.custom_id, `ticket:create:${teamId}:high:`);

  const threadsBefore = calls.filter((c) => c.path.endsWith('/threads')).length;
  const submit = interaction('d-agent', 5, {
    custom_id: modal.data.custom_id,
    components: [
      { type: 1, components: [{ custom_id: 'subject', value: 'VPN drops every hour' }] },
      { type: 1, components: [{ custom_id: 'details', value: 'Since the firmware update.' }] },
    ],
  });
  await handlers.handleInteraction(submit as any);
  assert.equal(lastCallback(submit.id).type, 5, 'deferred, so Discord does not time out');
  const edit = calls.filter((c) => c.method === 'PATCH' && c.path.includes(`/webhooks/${APP_ID}/${submit.token}/messages/@original`)).at(-1)!;
  assert.match(edit.body.content, /Raised \*\*ESC-\d+\*\* for Network/);

  const row = await db.get<{ id: string; team_id: string; priority: string; source: string; requester_id: string }>(
    `SELECT id, team_id, priority, source, requester_id FROM tickets WHERE subject = 'VPN drops every hour'`,
  );
  assert.equal(row!.team_id, teamId);
  assert.equal(row!.priority, 'high');
  assert.equal(row!.source, 'discord');
  assert.equal(row!.requester_id, 'u-agent');
  ticketId = row!.id;

  // The dispatcher's ticketCreated and the reply both want the thread; only one is made.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls.filter((c) => c.path.endsWith('/threads')).length - threadsBefore, 1);
  const link = await db.get<{ external_id: string; external_key: string }>(`SELECT external_id, external_key FROM ticket_links WHERE ticket_id = ? AND provider = 'discord'`, [ticketId]);
  threadId = link!.external_id;
  assert.equal(link!.external_key, CHANNEL, 'Network has no channel of its own, so the default is used');
  assert.match(edit.body.content, new RegExp(`<#${threadId}>`));
  const card = calls.find((c) => c.method === 'POST' && c.path === `/channels/${CHANNEL}/messages` && c.body.embeds?.[0]?.title?.includes('VPN drops'))!;
  const buttons = card.body.components[0].components.map((b: any) => b.custom_id).filter(Boolean);
  assert.deepEqual(buttons, [`t:take:${ticketId}`, `t:resolve:${ticketId}`, `t:esc:${ticketId}`]);
});

/* ------------------------------ thread replies ----------------------------- */

test('a linked person replying in the thread comments on the ticket, with the screenshot', async () => {
  const outcome = await handlers.handleThreadMessage(
    {
      id: '777777777777777771',
      channel_id: threadId,
      type: 0,
      content: 'Rebooted the edge router <@123456789012345678>',
      author: { id: 'd-agent', username: 'agent' },
      attachments: [{ id: 'a1', filename: 'screen.png', content_type: 'image/png', size: PNG.length, url: 'https://cdn.discordapp.com/attachments/1/2/screen.png' }],
    },
    { botUserId: 'bot-user' },
  );
  assert.equal(outcome, 'comment');
  const comment = await db.get<{ body: string; author_id: string; is_internal: number }>(`SELECT body, author_id, is_internal FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 1`, [ticketId]);
  assert.equal(comment!.body, 'Rebooted the edge router @someone');
  assert.equal(comment!.author_id, 'u-agent');
  assert.equal(comment!.is_internal, 0);
  const attachment = await db.get<{ mime_type: string; size: number }>(`SELECT mime_type, size FROM ticket_attachments WHERE ticket_id = ?`, [ticketId]);
  assert.equal(attachment!.mime_type, 'image/png');
  assert.equal(attachment!.size, PNG.length);

  // Not echoed back into the thread it came from.
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!calls.some((c) => c.path === `/channels/${threadId}/messages` && /Rebooted/.test(JSON.stringify(c.body))));

  const again = await handlers.handleThreadMessage(
    { id: '777777777777777771', channel_id: threadId, type: 0, content: 'Rebooted the edge router', author: { id: 'd-agent', username: 'agent' } },
    { botUserId: 'bot-user' },
  );
  assert.equal(again, 'duplicate');
});

test("the bot's own messages and unlinked people's do not become comments", async () => {
  const before = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ticket_comments WHERE ticket_id = ?`, [ticketId]))!.n);
  assert.equal(
    await handlers.handleThreadMessage({ id: '777777777777777772', channel_id: threadId, type: 0, content: 'Status changed', author: { id: 'bot-user', username: 'InfraBot', bot: true } }, { botUserId: 'bot-user' }),
    'ignored',
  );
  assert.equal(
    await handlers.handleThreadMessage({ id: '777777777777777773', channel_id: threadId, type: 0, content: 'me too', author: { id: 'd-stranger', username: 'stranger' } }, { botUserId: 'bot-user' }),
    'unlinked',
  );
  await handlers.handleThreadMessage({ id: '777777777777777774', channel_id: threadId, type: 0, content: 'still broken', author: { id: 'd-stranger', username: 'stranger' } }, { botUserId: 'bot-user' });
  const reminders = calls.filter((c) => c.path === `/channels/${threadId}/messages` && /\/link/.test(c.body?.content ?? ''));
  assert.equal(reminders.length, 1, 'reminded once, not on every message');
  const after = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ticket_comments WHERE ticket_id = ?`, [ticketId]))!.n);
  assert.equal(after, before);
});

/* --------------------------------- buttons --------------------------------- */

test('Take and Resolve check the person behind the click', async () => {
  const stranger = interaction('d-stranger', 3, { custom_id: `t:take:${ticketId}` });
  await handlers.handleInteraction(stranger as any);
  assert.match(lastCallback(stranger.id).data.content, /not linked/);

  const viewer = interaction('d-viewer', 3, { custom_id: `t:resolve:${ticketId}` });
  await handlers.handleInteraction(viewer as any);
  assert.match(lastCallback(viewer.id).data.content, /permission/);
  assert.equal((await db.get<{ status: string }>(`SELECT status FROM tickets WHERE id = ?`, [ticketId]))!.status, 'open');

  const take = interaction('d-agent', 3, { custom_id: `t:take:${ticketId}` });
  await handlers.handleInteraction(take as any);
  const taken = await db.get<{ assignee_id: string; status: string }>(`SELECT assignee_id, status FROM tickets WHERE id = ?`, [ticketId]);
  assert.equal(taken!.assignee_id, 'u-agent');
  assert.equal(taken!.status, 'in_progress');

  const resolve = interaction('d-agent', 3, { custom_id: `t:resolve:${ticketId}` });
  await handlers.handleInteraction(resolve as any);
  assert.equal((await db.get<{ status: string }>(`SELECT status FROM tickets WHERE id = ?`, [ticketId]))!.status, 'resolved');
  await waitFor(() => calls.some((c) => c.path === `/channels/${threadId}/messages` && /moved to resolved/.test(JSON.stringify(c.body))));
});

test('Escalate moves the ticket to another department with a reason', async () => {
  await db.run(`UPDATE tickets SET status = 'open' WHERE id = ?`, [ticketId]);
  const press = interaction('d-agent', 3, { custom_id: `t:esc:${ticketId}` });
  await handlers.handleInteraction(press as any);
  const select = lastCallback(press.id).data.components[0].components[0];
  assert.equal(select.custom_id, `t:escto:${ticketId}`);
  assert.ok(select.options.some((o: any) => o.value === otherTeamId));

  const pick = interaction('d-agent', 3, { custom_id: `t:escto:${ticketId}`, values: [otherTeamId] });
  await handlers.handleInteraction(pick as any);
  const modal = lastCallback(pick.id);
  assert.equal(modal.type, 9);

  const submit = interaction('d-agent', 5, { custom_id: modal.data.custom_id, components: [{ type: 1, components: [{ custom_id: 'reason', value: 'Physical cabling, not config' }] }] });
  await handlers.handleInteraction(submit as any);
  assert.match(lastCallback(submit.id).data.content, /now with Facilities/);
  const row = await db.get<{ team_id: string; escalation_level: number }>(`SELECT team_id, escalation_level FROM tickets WHERE id = ?`, [ticketId]);
  assert.equal(row!.team_id, otherTeamId);
  assert.equal(Number(row!.escalation_level), 1);
});

/* ---------------------------------- pages --------------------------------- */

test('a page arrives as a DM whose Acknowledge button stops the escalation', async () => {
  const { savePolicy, saveRules, validateRules } = await import('../server/ops/oncall.ts');
  assert.doesNotThrow(() => validateRules([{ urgency: 'high', channel: 'discord', delayMins: 0 }]), 'a Discord DM counts as a wake-up channel');
  await saveRules('u-admin', [{ urgency: 'high', channel: 'discord', delayMins: 0 }]);
  const policy = await savePolicy(null, { name: 'Discord test', description: null, teamId: null, repeatCount: 0, levels: [{ position: 0, delayMins: 5, targets: [{ type: 'user', id: 'u-admin' }] }] });
  await db.run(`UPDATE tickets SET status = 'open' WHERE id = ?`, [ticketId]);
  const { triggerPage } = await import('../server/ops/pager.ts');
  const pageId = (await triggerPage(ticketId, { policyId: policy.id, severity: 'sev1', reason: 'test' }))!;

  const dm = calls.find((c) => c.path === '/users/@me/channels');
  assert.equal(dm!.body.recipient_id, 'd-admin');
  const message = calls.filter((c) => c.path === '/channels/dm-channel/messages').at(-1)!;
  const ids = message.body.components[0].components.map((b: any) => b.custom_id).filter(Boolean);
  assert.deepEqual(ids, [`p:ack:${pageId}`, `p:esc:${pageId}`]);

  const click = interaction('d-admin', 3, { custom_id: `p:ack:${pageId}` });
  await handlers.handleInteraction(click as any);
  assert.equal(lastCallback(click.id).type, 7, 'the DM is updated in place');
  assert.match(lastCallback(click.id).data.content, /Acknowledged by Person u-admin/);
  assert.equal((await db.get<{ status: string }>(`SELECT status FROM pages WHERE id = ?`, [pageId]))!.status, 'acknowledged');
});

/* ---------------------------- fatal close codes ---------------------------- */

test('a rejected token (4004) marks the integration and stops retrying', async () => {
  behaviour = (client, payload) => {
    if (payload.op === 2) client.close(4004);
  };
  const before = connections;
  await call(cookies['u-admin'], 'PATCH', '/api/integrations/discord', { config: { botToken: 'revoked-token' } });
  const { refreshDiscordGateway, discordGatewayStatus } = await import('../server/integrations/discord-gateway.ts');
  await refreshDiscordGateway({ url: gatewayUrl });
  await waitFor(async () => (await db.get<{ status: string }>(`SELECT status FROM integrations WHERE provider = 'discord'`))!.status === 'error');
  const row = await db.get<{ last_error: string }>(`SELECT last_error FROM integrations WHERE provider = 'discord'`);
  assert.match(row!.last_error, /bot token/);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(connections - before, 1, 'no reconnect after a fatal close');
  assert.equal(discordGatewayStatus().running, false);
});
