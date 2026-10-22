/**
 * The Integrations catalogue: tile status from real data, the generated Slack
 * app manifest, the "Add to Slack" OAuth install and Microsoft admin consent.
 *
 * The OAuth checks are the ones that matter most: a callback is only honoured
 * with a state this server issued, to the same signed-in session, once, and
 * within ten minutes. Slack's API is mocked; nothing leaves the machine.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Before any server module loads: config reads these once, at import.
process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'integration-catalogue.db';
process.env.SESSION_SECRET = 'q'.repeat(48);
process.env.SECRET_KEY = 'r'.repeat(64);
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;
delete process.env.APP_URL;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const wipe = () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `integration-catalogue.db${suffix}`), { force: true });
};

let server: http.Server;
let base: string;
let cookie: string;
let db: typeof import('../server/db/index.ts').db;

const BOT_TOKEN = ['xoxb', '1111', '2222', 'secret-bot-token'].join('-');
const slackCalls: Array<{ url: string; body: string }> = [];
const realFetch = globalThis.fetch;

async function login(email: string, password: string): Promise<string> {
  const response = await realFetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: email, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie')!.split(';')[0];
}

async function call(method: string, url: string, body?: unknown, as = cookie) {
  const response = await realFetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: as },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await response.text();
  let payload: any = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // redirect or empty
  }
  return { status: response.status, payload, text, location: response.headers.get('location') };
}

const query = (location: string | null) => new URL(location ?? '/', 'http://x').searchParams;

before(async () => {
  wipe();
  const dist = path.resolve(import.meta.dirname, '../dist/client');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://slack.com/api/')) {
      slackCalls.push({ url, body: String(init?.body ?? '') });
      if (url.startsWith('https://slack.com/api/oauth.v2.access')) {
        const form = new URLSearchParams(String(init?.body ?? ''));
        if (form.get('code') !== 'good-code') return Response.json({ ok: false, error: 'invalid_code' });
        return Response.json({ ok: true, access_token: BOT_TOKEN, token_type: 'bot', team: { id: 'T1', name: 'Acme' } });
      }
      if (url.startsWith('https://slack.com/api/conversations.list')) {
        return Response.json({
          ok: true,
          channels: [
            { id: 'C0INCIDENTS', name: 'incidents', is_private: false, is_member: true },
            { id: 'G0SECRET', name: 'secops', is_private: true, is_member: false },
          ],
          response_metadata: { next_cursor: '' },
        });
      }
      if (url.startsWith('https://slack.com/api/auth.test')) return Response.json({ ok: true, team: 'Acme', user: 'infraticket' });
      if (url.startsWith('https://slack.com/api/chat.postMessage')) return Response.json({ ok: true, channel: 'C0INCIDENTS', ts: '1.1' });
      return Response.json({ ok: true });
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
    ['u-admin', 'admin@acme.test', 'admin', 'Admin', hash, salt, 'admin', 'active', '#9a7b2f', 0, now, now],
  );

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cookie = await login('admin@acme.test', 'Adm1n-Password!');
});

after(async () => {
  globalThis.fetch = realFetch;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db.close();
  wipe();
});

/* --------------------------------- Status --------------------------------- */

test('tile status comes from real data', async () => {
  let { payload } = await call('GET', '/api/integrations/catalogue');
  assert.equal(payload.status.slack.state, 'not_set_up');
  assert.equal(payload.status['source:generic'].state, 'not_set_up');
  assert.equal(payload.status.sso.state, 'not_set_up');

  const created = await call('POST', '/api/ops/alert-sources', { name: 'Scripts', kind: 'generic', defaultSeverity: 'sev4' });
  assert.equal(created.status, 201);
  ({ payload } = await call('GET', '/api/integrations/catalogue'));
  assert.equal(payload.status['source:generic'].state, 'attention', 'created but no alert yet');

  const url = new URL(created.payload.source.webhookUrl);
  await realFetch(`${base}${url.pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'hello', severity: 'info' }) });
  ({ payload } = await call('GET', '/api/integrations/catalogue'));
  assert.equal(payload.status['source:generic'].state, 'connected');

  // A chat tool whose last test failed needs attention.
  const { saveIntegration, setIntegrationStatus } = await import('../server/integrations/store.ts');
  await saveIntegration('email', { config: { host: 'smtp.acme.test', fromEmail: 'it@acme.test' } });
  await setIntegrationStatus('email', 'error', 'Connection refused');
  ({ payload } = await call('GET', '/api/integrations/catalogue'));
  assert.equal(payload.status.email.state, 'attention');
  assert.match(payload.status.email.detail, /refused/);
});

test('the catalogue is for integration managers only', async () => {
  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword('Agent-Password1!');
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['u-agent', 'agent@acme.test', 'agent', 'Agent', hash, salt, 'agent', 'active', '#9a7b2f', 0, now, now],
  );
  const agent = await login('agent@acme.test', 'Agent-Password1!');
  assert.equal((await call('GET', '/api/integrations/catalogue', undefined, agent)).status, 403);
  assert.equal((await call('POST', '/api/integrations/slack/oauth/start', undefined, agent)).status, 403);
});

/* --------------------------------- Slack ---------------------------------- */

test('the Slack manifest points at this server with the scopes the integration uses', async () => {
  await call('PATCH', '/api/settings', { appUrl: 'https://tickets.acme.example' });
  const { payload } = await call('GET', '/api/integrations/slack/setup');
  const m = payload.manifest;
  assert.equal(payload.publicUrl, true);
  assert.deepEqual(m.oauth_config.redirect_urls, ['https://tickets.acme.example/api/integrations/slack/oauth/callback']);
  for (const scope of ['chat:write', 'commands', 'users:read.email', 'channels:history', 'channels:read', 'reactions:read']) {
    assert.ok(m.oauth_config.scopes.bot.includes(scope), scope);
  }
  assert.equal(m.settings.event_subscriptions.request_url, 'https://tickets.acme.example/api/webhooks/slack');
  assert.equal(m.settings.interactivity.request_url, 'https://tickets.acme.example/api/webhooks/slack/interactive');
  assert.equal(m.features.slash_commands[0].url, 'https://tickets.acme.example/api/webhooks/slack/commands');
  assert.equal(m.features.slash_commands[0].command, '/gml');
  assert.ok(payload.createUrl.startsWith('https://api.slack.com/apps?new_app=1&manifest_json='));
  assert.deepEqual(JSON.parse(decodeURIComponent(payload.createUrl.split('manifest_json=')[1])), m);

  // An address Slack cannot reach: events, buttons and the command are left out
  // rather than making Slack reject the whole manifest.
  await call('PATCH', '/api/settings', { appUrl: 'http://10.0.50.20:8080' });
  const internal = (await call('GET', '/api/integrations/slack/setup')).payload;
  assert.equal(internal.publicUrl, false);
  assert.equal(internal.manifest.settings.event_subscriptions, undefined);
  assert.equal(internal.manifest.features.slash_commands, undefined);
  await call('PATCH', '/api/settings', { appUrl: 'https://tickets.acme.example' });
});

let state: string;

test('Slack app credentials are stored encrypted and never returned', async () => {
  const bad = await call('PUT', '/api/integrations/slack/app', { clientId: 'not-an-id' });
  assert.equal(bad.status, 400);
  const saved = await call('PUT', '/api/integrations/slack/app', { clientId: '1234.5678', clientSecret: 'client-secret-value', signingSecret: 'signing-secret-value' });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.app.hasClientSecret, true);
  assert.equal(saved.payload.app.hasSigningSecret, true);
  assert.doesNotMatch(saved.text, /client-secret-value|signing-secret-value/);
  const rows = await db.all<{ value: string }>(`SELECT value FROM settings WHERE key = 'ops.slack-app'`);
  assert.doesNotMatch(rows[0].value, /client-secret-value/);
  const setup = await call('GET', '/api/integrations/slack/setup');
  assert.doesNotMatch(setup.text, /client-secret-value|signing-secret-value/);
});

test('Add to Slack sends the admin to Slack with a state', async () => {
  const started = await call('POST', '/api/integrations/slack/oauth/start');
  assert.equal(started.status, 200);
  const url = new URL(started.payload.url);
  assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2/authorize');
  assert.equal(url.searchParams.get('client_id'), '1234.5678');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://tickets.acme.example/api/integrations/slack/oauth/callback');
  assert.match(url.searchParams.get('scope')!, /chat:write/);
  state = url.searchParams.get('state')!;
  assert.ok(state.length >= 40);
  const stored = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM oauth_states WHERE state_hash = ?`, [state]);
  assert.equal(Number(stored!.n), 0, 'only a hash of the state is stored');
});

test('a callback from another session, or with a forged state, is refused', async () => {
  const otherSession = await login('admin@acme.test', 'Adm1n-Password!');
  const elsewhere = await call('GET', `/api/integrations/slack/oauth/callback?code=good-code&state=${state}`, undefined, otherSession);
  assert.equal(elsewhere.status, 302);
  assert.equal(query(elsewhere.location).get('slack'), 'error');
  assert.match(query(elsewhere.location).get('reason')!, /different sign-in/);

  const forged = await call('GET', `/api/integrations/slack/oauth/callback?code=good-code&state=made-up-state-value`);
  assert.match(query(forged.location).get('reason')!, /not issued/);
  assert.ok(!slackCalls.some((c) => c.url.includes('oauth.v2.access')), 'no code is exchanged without a valid state');
});

test('the real callback installs the bot token, encrypted, and the state cannot be replayed', async () => {
  const done = await call('GET', `/api/integrations/slack/oauth/callback?code=good-code&state=${state}`);
  assert.equal(done.status, 302);
  assert.equal(query(done.location).get('slack'), 'installed');
  assert.equal(query(done.location).get('team'), 'Acme');
  const exchange = slackCalls.find((c) => c.url.includes('oauth.v2.access'))!;
  const form = new URLSearchParams(exchange.body);
  assert.equal(form.get('client_secret'), 'client-secret-value');
  assert.equal(form.get('redirect_uri'), 'https://tickets.acme.example/api/integrations/slack/oauth/callback');

  const row = await db.get<{ config: string }>(`SELECT config FROM integrations WHERE provider = 'slack'`);
  assert.doesNotMatch(row!.config, new RegExp(BOT_TOKEN), 'the token is encrypted at rest');
  const listed = await call('GET', '/api/integrations');
  assert.doesNotMatch(listed.text, new RegExp(BOT_TOKEN), 'and never sent to the browser');

  const replay = await call('GET', `/api/integrations/slack/oauth/callback?code=good-code&state=${state}`);
  assert.match(query(replay.location).get('reason')!, /already been used/);
});

test('an expired state is refused', async () => {
  const started = await call('POST', '/api/integrations/slack/oauth/start');
  const fresh = new URL(started.payload.url).searchParams.get('state')!;
  await db.run(`UPDATE oauth_states SET expires_at = ? WHERE used_at IS NULL`, [new Date(Date.now() - 1000).toISOString()]);
  const late = await call('GET', `/api/integrations/slack/oauth/callback?code=good-code&state=${fresh}`);
  assert.match(query(late.location).get('reason')!, /expired/);
});

test('picking a channel switches Slack on and runs the real test', async () => {
  const { payload } = await call('GET', '/api/integrations/slack/channels');
  assert.deepEqual(payload.channels.map((c: any) => c.name), ['incidents', 'secops']);
  const set = await call('PUT', '/api/integrations/slack/channel', { channel: 'C0INCIDENTS' });
  assert.equal(set.status, 200);
  assert.equal(set.payload.result.ok, true, set.payload.result.message);
  const status = (await call('GET', '/api/integrations/catalogue')).payload.status;
  assert.equal(status.slack.state, 'connected');
  assert.equal((await call('PUT', '/api/integrations/slack/channel', { channel: 'nope' })).status, 400);
});

/* ---------------------------- Microsoft consent ---------------------------- */

test('Microsoft admin consent records success and failure, and checks state', async () => {
  assert.equal((await call('POST', '/api/integrations/msteams/consent/start')).status, 400, 'needs the bot app id first');
  const { saveIntegration } = await import('../server/integrations/store.ts');
  await saveIntegration('msteams', { config: { mode: 'bot', appId: '00001111-aaaa-2222-bbbb-3333cccc4444', appPassword: 'pw', tenantId: 'acme.onmicrosoft.com' } });

  const started = await call('POST', '/api/integrations/msteams/consent/start');
  const url = new URL(started.payload.url);
  assert.equal(url.origin + url.pathname, 'https://login.microsoftonline.com/acme.onmicrosoft.com/adminconsent');
  assert.equal(url.searchParams.get('client_id'), '00001111-aaaa-2222-bbbb-3333cccc4444');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://tickets.acme.example/api/integrations/msteams/consent/callback');
  const consentState = url.searchParams.get('state')!;

  const forged = await call('GET', `/api/integrations/msteams/consent/callback?admin_consent=True&tenant=evil&state=forged`);
  assert.equal(query(forged.location).get('consent'), 'failed');
  assert.equal((await call('GET', '/api/integrations/msteams/consent')).payload.consent.grantedAt, undefined);

  const granted = await call('GET', `/api/integrations/msteams/consent/callback?admin_consent=True&tenant=tenant-guid&state=${consentState}`);
  assert.equal(query(granted.location).get('consent'), 'granted');
  const after = (await call('GET', '/api/integrations/msteams/consent')).payload;
  assert.ok(after.consent.grantedAt);
  assert.equal(after.consent.tenant, 'tenant-guid');

  const again = new URL((await call('POST', '/api/integrations/msteams/consent/start')).payload.url).searchParams.get('state')!;
  const denied = await call('GET', `/api/integrations/msteams/consent/callback?error=access_denied&error_description=The+admin+canceled+the+request&state=${again}`);
  assert.equal(query(denied.location).get('consent'), 'failed');
  assert.match(query(denied.location).get('reason')!, /canceled/);
  assert.match((await call('GET', '/api/integrations/msteams/consent')).payload.consent.error, /canceled/);

  const audit = await call('GET', '/api/audit?search=consent');
  assert.ok(audit.payload.total >= 3, 'every step is audited');
});
