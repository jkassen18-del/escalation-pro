/**
 * Ringing the on-call person in Microsoft Teams.
 *
 * Microsoft is replaced by a fetch stub: the token endpoint, Graph, and the
 * calling service's signing keys. Call events are posted to the webhook the
 * way Microsoft posts them - signed JWT, commsNotifications body - so the
 * signature check is exercised for real.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'teamscalls.db';
process.env.SESSION_SECRET = 't'.repeat(48);
process.env.SECRET_KEY = 'u'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const wipe = () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `teamscalls.db${suffix}`), { force: true });
};

const APP_ID = '11111111-2222-3333-4444-555555555555';
const TENANT = '99999999-8888-7777-6666-555555555555';
const AAD_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const KID = 'calling-key-1';
const APP_URL = 'https://tickets.acme.test';
const signingKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

let server: http.Server;
let base: string;
let cookie: string;
let db: typeof import('../server/db/index.ts').db;

/** Everything sent to Graph, and how many times each person was looked up. */
const graphCalls: Array<{ method: string; url: string; body: any }> = [];
let lookups = 0;
let refuseCalls = false;
let callSeq = 0;

function mintToken(key = signingKey.privateKey, overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: KID })}.${encode({ iss: 'https://api.botframework.com', aud: APP_ID, tid: TENANT, nbf: now - 60, exp: now + 3600, ...overrides })}`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie, ...headers },
    body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
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

/** A call event as Microsoft posts it. */
function notify(callId: string, resourceData: Record<string, unknown>, changeType = 'updated', token = mintToken(), attempt?: string) {
  return call(
    'POST',
    `/api/webhooks/msteams/calling${attempt ? `?attempt=${attempt}` : ''}`,
    {
      '@odata.type': '#microsoft.graph.commsNotifications',
      value: [
        {
          '@odata.type': '#microsoft.graph.commsNotification',
          changeType,
          resourceUrl: `/communications/calls/${callId}`,
          resourceData: { '@odata.type': '#microsoft.graph.call', id: callId, ...resourceData },
        },
      ],
    },
    { authorization: `Bearer ${token}`, cookie: '' },
  );
}

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 50; i += 1) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A WAV header plus silence. */
function wav({ channels = 1, rate = 16000, bits = 16, seconds = 0.5 } = {}): Buffer {
  const data = Buffer.alloc(Math.round(rate * seconds) * channels * (bits / 8));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE((rate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const realFetch = globalThis.fetch;

before(async () => {
  wipe();
  const dist = path.resolve(import.meta.dirname, '../dist/client');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init?.method ?? 'GET';
    if (url === 'https://api.aps.skype.com/v1/.well-known/OpenIdConfiguration') {
      return Response.json({ issuer: 'https://api.botframework.com', jwks_uri: 'https://api.aps.skype.com/v1/keys' });
    }
    if (url === 'https://api.aps.skype.com/v1/keys') {
      const jwk = signingKey.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
      return Response.json({ keys: [{ ...jwk, kid: KID, use: 'sig' }] });
    }
    if (url === `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`) {
      assert.match(String(init?.body), /scope=https%3A%2F%2Fgraph\.microsoft\.com%2F\.default/);
      return Response.json({ access_token: 'graph-token', expires_in: 3600 });
    }
    if (url.startsWith('https://graph.microsoft.com/v1.0/')) {
      assert.equal(init?.headers?.Authorization, 'Bearer graph-token');
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      graphCalls.push({ method, url, body });
      if (url.includes('/users/')) {
        lookups += 1;
        return Response.json({ id: AAD_ID });
      }
      if (method === 'POST' && url.endsWith('/communications/calls')) {
        if (refuseCalls) return Response.json({ error: { code: 'Forbidden', message: 'Application does not have permission' } }, { status: 403 });
        callSeq += 1;
        return Response.json({ id: `call-${callSeq}`, state: 'establishing' }, { status: 201 });
      }
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ status: 'running' });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword('Teams-Password-1');
  const now = new Date().toISOString();
  for (const [id, role] of [
    ['u-admin', 'admin'],
    ['u-second', 'agent'],
  ]) {
    await db.run(
      'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, `${id}@acme.test`, id, `Person ${id}`, hash, salt, role, 'active', '#9a7b2f', 0, now, now],
    );
  }

  const { saveIntegration } = await import('../server/integrations/store.ts');
  await saveIntegration('msteams', { enabled: true, config: { mode: 'bot', appId: APP_ID, appPassword: 'secret-value', tenantId: TENANT } });

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'u-admin@acme.test', password: 'Teams-Password-1' }),
  });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  await call('PATCH', '/api/settings', { appUrl: APP_URL });
});

after(async () => {
  globalThis.fetch = realFetch;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db.close();
  wipe();
});

let policyId: string;
let pageId: string;

async function attempts(id: string) {
  return (await call('GET', `/api/ops/pages/${id}`)).payload.page.attempts.filter((a: any) => a.channel === 'teams_call');
}

test('Teams calls are off until an on-call manager turns them on', async () => {
  const before = await call('GET', '/api/ops/teams-calls');
  assert.equal(before.payload.settings.enabled, false);
  assert.equal(before.payload.settings.botConfigured, true);
  assert.equal(before.payload.settings.callingWebhookUrl, `${APP_URL}/api/webhooks/msteams/calling`);
  const on = await call('PUT', '/api/ops/teams-calls', { enabled: true });
  assert.equal(on.payload.settings.enabled, true);
});

test('Teams call counts as a wake-up channel for high urgency', async () => {
  const saved = await call('PUT', '/api/ops/me/rules', {
    rules: [
      { urgency: 'high', channel: 'in_app', delayMins: 0 },
      { urgency: 'high', channel: 'teams_call', delayMins: 0 },
    ],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
});

test('a page rings the person in Teams with the documented call request', async () => {
  policyId = (
    await call('POST', '/api/ops/policies', {
      name: 'Teams SEV',
      levels: [
        { delayMins: 30, targets: [{ type: 'user', id: 'u-admin' }] },
        { delayMins: 30, targets: [{ type: 'user', id: 'u-second' }] },
      ],
    })
  ).payload.policy.id;
  const ticket = await call('POST', '/api/tickets', { subject: 'Payments down', type: 'incident' });
  const page = await call('POST', `/api/ops/tickets/${ticket.payload.ticket.id}/page`, { policyId, severity: 'sev1' });
  pageId = page.payload.page.id;

  const create = graphCalls.find((c) => c.method === 'POST' && c.url.endsWith('/communications/calls'))!;
  assert.ok(create, 'a call was placed');
  assert.equal(create.body['@odata.type'], '#microsoft.graph.call');
  assert.deepEqual(create.body.requestedModalities, ['audio']);
  assert.equal(create.body.mediaConfig['@odata.type'], '#microsoft.graph.serviceHostedMediaConfig');
  assert.equal(create.body.targets[0]['@odata.type'], '#microsoft.graph.invitationParticipantInfo');
  assert.equal(create.body.targets[0].identity.user.id, AAD_ID);
  assert.match(create.body.callbackUri, /^https:\/\/tickets\.acme\.test\/api\/webhooks\/msteams\/calling\?attempt=/);

  const [attempt] = await attempts(pageId);
  assert.equal(attempt.status, 'sent');
  assert.equal(lookups, 1);
  const stored = await db.get<{ teams_user_id: string }>(`SELECT teams_user_id FROM users WHERE id = 'u-admin'`);
  assert.equal(stored!.teams_user_id, AAD_ID, 'the directory id is remembered');
});

test('unanswered, the call repeats like a phone call, without looking the person up again', async () => {
  const { pagerTick } = await import('../server/ops/pager.ts');
  await db.run(`UPDATE pages SET level_started_at = ? WHERE id = ?`, [new Date(Date.now() - 2.5 * 60_000).toISOString(), pageId]);
  await pagerTick();
  const placed = await attempts(pageId);
  assert.equal(placed.length, 2);
  assert.equal(placed[1].seq, 1);
  assert.equal(lookups, 1, 'cached');
});

test('a calling event with a bad signature is refused', async () => {
  assert.equal((await notify('call-1', { state: 'established' }, 'updated', mintToken(otherKey.privateKey))).status, 401);
  assert.equal((await notify('call-1', { state: 'established' }, 'updated', mintToken(signingKey.privateKey, { aud: 'someone-else' }))).status, 401);
  assert.equal((await notify('call-1', { state: 'established' }, 'updated', 'not-a-jwt')).status, 401);
  const [first] = await attempts(pageId);
  assert.equal(first.status, 'sent', 'nothing changed');
});

test('answering without a prompt is recorded, does not acknowledge, and hangs up', async () => {
  const response = await notify('call-1', { state: 'established' });
  assert.equal(response.status, 202);
  const [first] = await waitFor(() => attempts(pageId), (list) => list[0].status !== 'sent', 'the answer to be recorded');
  assert.equal(first.status, 'answered');
  assert.match(first.detail, /Acknowledge from the Teams card or the web/);
  const page = (await call('GET', `/api/ops/pages/${pageId}`)).payload.page;
  assert.equal(page.status, 'triggered', 'still escalating');
  assert.ok(graphCalls.some((c) => c.method === 'DELETE' && c.url.endsWith('/communications/calls/call-1')));
});

test('a missed call is recorded as missed', async () => {
  await notify('call-2', { state: 'terminated' }, 'deleted');
  const list = await waitFor(() => attempts(pageId), (l) => l[1].status === 'missed', 'missed');
  assert.match(list[1].detail, /not answered/);
});

test('the prompt must be the WAV format Teams plays, and is served behind an unguessable URL', async () => {
  const stereo = await call('PUT', '/api/ops/teams-calls/prompt', wav({ channels: 2 }), { 'content-type': 'audio/wav' });
  assert.equal(stereo.status, 400);
  assert.match(stereo.payload.error, /mono, 16-bit, 16 kHz/);
  assert.equal((await call('PUT', '/api/ops/teams-calls/prompt', Buffer.from('not audio'), { 'content-type': 'audio/wav' })).status, 400);

  const ok = await call('PUT', '/api/ops/teams-calls/prompt', wav(), { 'content-type': 'audio/wav' });
  assert.equal(ok.status, 200, JSON.stringify(ok.payload));
  assert.equal(ok.payload.settings.hasPrompt, true);
  assert.equal((await call('GET', '/api/public/teams-call-prompt/aaaaaaaaaaaaaaaaaaaaaaaa.wav', undefined, { cookie: '' })).status, 404);
});

test('with a prompt, answering plays it and pressing 1 acknowledges the page', async () => {
  const { pagerTick } = await import('../server/ops/pager.ts');
  await db.run(`UPDATE pages SET level_started_at = ? WHERE id = ?`, [new Date(Date.now() - 4.5 * 60_000).toISOString(), pageId]);
  await pagerTick();
  const list = await attempts(pageId);
  const third = list[2];
  assert.equal(third.status, 'sent');
  const callId = `call-${callSeq}`;

  await notify(callId, { state: 'established' });
  await waitFor(() => Promise.resolve(graphCalls), (calls) => calls.some((c) => c.url.endsWith(`${callId}/playPrompt`)), 'the prompt');
  const play = graphCalls.find((c) => c.url.endsWith(`${callId}/playPrompt`))!;
  assert.equal(play.body.prompts[0]['@odata.type'], '#microsoft.graph.mediaPrompt');
  const promptUrl: string = play.body.prompts[0].mediaInfo.uri;
  assert.match(promptUrl, /^https:\/\/tickets\.acme\.test\/api\/public\/teams-call-prompt\/[A-Za-z0-9_-]+\.wav$/);
  assert.ok(graphCalls.some((c) => c.url.endsWith(`${callId}/subscribeToTone`)), 'listening for a keypress');
  const served = await fetch(`${base}${new URL(promptUrl).pathname}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'audio/wav');

  await notify(callId, { state: 'established', toneInfo: { '@odata.type': '#microsoft.graph.toneInfo', sequenceId: 1, tone: 'tone1' } });
  const page = await waitFor(
    async () => (await call('GET', `/api/ops/pages/${pageId}`)).payload.page,
    (p) => p.status === 'acknowledged',
    'the acknowledgement',
  );
  assert.equal(page.acknowledgedById, 'u-admin');
  const acked = (await attempts(pageId)).find((a: any) => a.status === 'acknowledged');
  assert.match(acked.detail, /pressing 1/);
});

test('pressing 2 escalates to the next level', async () => {
  const ticket = await call('POST', '/api/tickets', { subject: 'Database slow', type: 'incident' });
  const page = (await call('POST', `/api/ops/tickets/${ticket.payload.ticket.id}/page`, { policyId, severity: 'sev1' })).payload.page;
  const callId = `call-${callSeq}`;
  await notify(callId, { state: 'established' });
  await notify(callId, { state: 'established', toneInfo: { tone: 'tone2' } });
  const after = await waitFor(
    async () => (await call('GET', `/api/ops/pages/${page.id}`)).payload.page,
    (p) => p.currentLevel === 1,
    'the escalation',
  );
  assert.deepEqual(after.currentTargetIds, ['u-second']);
});

test("Graph's permission errors are spelled out on the attempt and the test button", async () => {
  refuseCalls = true;
  const test = await call('POST', '/api/ops/teams-calls/test');
  assert.equal(test.payload.result.status, 'failed');
  assert.match(test.payload.result.detail, /Calls\.Initiate\.All/);
  assert.match(test.payload.result.detail, /admin/i);
  refuseCalls = false;
});

