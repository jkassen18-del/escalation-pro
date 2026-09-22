/**
 * The HTTPS API.
 *
 * This is the one endpoint anything on the network can reach with nothing but
 * a string, so most of what is checked here is what it refuses: a wrong key,
 * a revoked one, an expired one, a key whose owner was suspended, and a key
 * asked to do something outside its scopes.
 *
 * The other half is deduplication. A monitoring tool retries on timeouts and
 * re-fires while a condition persists, so without it one flapping disk fills
 * the queue with hundreds of identical tickets.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'publicapi.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.SECRET_KEY = 'b'.repeat(64);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, `publicapi.db${suffix}`));
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
let cookie: string;
let financeId = '';

let fullKey = '';
let readOnlyKey = '';
let revokedKey = '';
let expiredKey = '';
let orphanKey = '';

before(async () => {
  wipe();
  ensureClientDist();

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { ALL_PERMISSIONS } = await import('../server/permissions.ts');
  const { hash, salt } = hashPassword('Adm1n-Password!');
  const now = new Date().toISOString();

  await db.run(
    'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['u-1', 'admin@acme.test', 'admin', 'Admin', hash, salt, 'admin', 'active', '#9a7b2f', 0, now, now],
  );
  for (const permission of ALL_PERMISSIONS) {
    await db.run('INSERT INTO user_permissions (user_id,permission) VALUES (?,?)', ['u-1', permission]);
  }
  // A second admin whose account is then suspended, to prove a key dies with
  // the person who made it.
  await db.run(
    'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['u-gone', 'gone@acme.test', 'gone', 'Departed', hash, salt, 'admin', 'active', '#9a7b2f', 0, now, now],
  );
  for (const permission of ALL_PERMISSIONS) {
    await db.run('INSERT INTO user_permissions (user_id,permission) VALUES (?,?)', ['u-gone', permission]);
  }

  await db.run('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', [
    'ticket_number',
    1000,
  ]);

  const { createTeam } = await import('../server/repositories/teams.ts');
  financeId = await createTeam({ key: 'finance', name: 'Finance' });
  await createTeam({ key: 'it', name: 'IT Support' });

  const { createApiKey } = await import('../server/repositories/api-keys.ts');
  fullKey = (await createApiKey({ name: 'Monitoring', scopes: ['tickets.create'], createdBy: 'u-1' })).token;
  // Deliberately no tickets.create: proves scopes are enforced per call.
  readOnlyKey = (await createApiKey({ name: 'Reports only', scopes: ['reports.view'], createdBy: 'u-1' })).token;

  const revoked = await createApiKey({ name: 'Old laptop', scopes: ['tickets.create'], createdBy: 'u-1' });
  revokedKey = revoked.token;
  const { revokeApiKey } = await import('../server/repositories/api-keys.ts');
  await revokeApiKey(revoked.key.id);

  expiredKey = (
    await createApiKey({
      name: 'Contractor',
      scopes: ['tickets.create'],
      createdBy: 'u-1',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
  ).token;

  orphanKey = (await createApiKey({ name: 'Departed admin', scopes: ['tickets.create'], createdBy: 'u-gone' })).token;
  await db.run(`UPDATE users SET status = 'suspended' WHERE id = 'u-gone'`);

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'admin@acme.test', password: 'Adm1n-Password!' }),
  });
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await db.close();
  wipe();
});

async function api(method: string, urlPath: string, token?: string, body?: unknown) {
  const response = await fetch(`${base}/api/v1${urlPath}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json().catch(() => null)) as any, headers: response.headers };
}

const ticketCount = async () =>
  Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n);

/* ------------------------------ Refusals ---------------------------------- */

test('a request with no key is refused and says how to send one', async () => {
  const { status, payload, headers } = await api('POST', '/tickets', undefined, { subject: 'x' });
  assert.equal(status, 401);
  assert.match(headers.get('www-authenticate') ?? '', /Bearer/);
  assert.match(payload.error, /Authorization: Bearer/);
});

test('a made-up key is refused', async () => {
  const { status } = await api('POST', '/tickets', 'itk_deadbeef_notarealsecretatall', { subject: 'x' });
  assert.equal(status, 401);
});

test('a key of the wrong shape is refused', async () => {
  const { status } = await api('GET', '/whoami', 'not-even-close');
  assert.equal(status, 401);
});

test('a revoked key is refused, and says so', async () => {
  const { status, payload } = await api('GET', '/whoami', revokedKey);
  assert.equal(status, 401);
  assert.match(payload.error, /revoked/i);
});

test('an expired key is refused, and says so', async () => {
  const { status, payload } = await api('GET', '/whoami', expiredKey);
  assert.equal(status, 401);
  assert.match(payload.error, /expired/i);
});

test('a key outlives neither its owner nor their suspension', async () => {
  // The key itself is perfectly valid; the person it acts as is not.
  const { status, payload } = await api('GET', '/whoami', orphanKey);
  assert.equal(status, 401);
  assert.match(payload.error, /no longer active/i);
});

test('a key without the scope cannot raise a ticket', async () => {
  const before = await ticketCount();
  const { status, payload } = await api('POST', '/tickets', readOnlyKey, { subject: 'Sneaky' });
  assert.equal(status, 403);
  assert.match(payload.error, /tickets\.create/);
  assert.equal(await ticketCount(), before);
});

test('a session cookie is not an API key', async () => {
  // The API is mounted ahead of the cookie middleware precisely so a browser
  // session cannot be used here by accident.
  const response = await fetch(`${base}/api/v1/whoami`, { headers: { cookie } });
  assert.equal(response.status, 401);
});

/* ----------------------------- Raising tickets ---------------------------- */

test('a valid key identifies itself', async () => {
  const { status, payload } = await api('GET', '/whoami', fullKey);
  assert.equal(status, 200);
  assert.equal(payload.key.name, 'Monitoring');
  assert.deepEqual(payload.key.scopes, ['tickets.create']);
  assert.equal(payload.actor.email, 'admin@acme.test');
});

test('the departments are listable, so a caller need not guess an id', async () => {
  const { status, payload } = await api('GET', '/teams', fullKey);
  assert.equal(status, 200);
  assert.deepEqual(payload.teams.map((t: any) => t.key).sort(), ['FINANCE', 'IT']);
});

test('a ticket can be raised over HTTPS with nothing but a subject', async () => {
  const { status, payload, headers } = await api('POST', '/tickets', fullKey, {
    subject: 'Disk usage above 90% on db-01',
  });

  assert.equal(status, 201);
  assert.match(payload.ticket.reference, /^ESC-\d+$/);
  assert.equal(payload.ticket.subject, 'Disk usage above 90% on db-01');
  // A Location header, so a caller can follow it without parsing the body.
  assert.match(headers.get('location') ?? '', /^\/api\/v1\/tickets\/ESC-\d+$/);
});

test('a department can be named by key rather than by internal id', async () => {
  const { status, payload } = await api('POST', '/tickets', fullKey, {
    subject: 'Invoice mismatch',
    team: 'finance',
    priority: 'high',
    type: 'request',
    tags: ['billing'],
  });

  assert.equal(status, 201);
  assert.equal(payload.ticket.team, 'Finance');
  assert.equal(payload.ticket.priority, 'high');

  const row = await db.get<{ team_id: string; source: string }>(
    `SELECT team_id, source FROM tickets ORDER BY created_at DESC LIMIT 1`,
  );
  assert.equal(row!.team_id, financeId);
  assert.equal(row!.source, 'api', 'the ticket does not record that it came from the API');
});

test('an unknown department is refused with the list of real ones', async () => {
  const { status, payload } = await api('POST', '/tickets', fullKey, {
    subject: 'x',
    team: 'department-of-made-up-things',
  });
  assert.equal(status, 400);
  assert.match(payload.error, /GET \/api\/v1\/teams/);
});

test('an invalid priority is refused rather than silently defaulted', async () => {
  const { status, payload } = await api('POST', '/tickets', fullKey, { subject: 'x', priority: 'catastrophic' });
  assert.equal(status, 400);
  assert.match(payload.error, /priority must be one of/);
});

test('a missing subject is refused', async () => {
  const { status } = await api('POST', '/tickets', fullKey, { description: 'no subject here' });
  assert.equal(status, 400);
});

/* ---------------------------- Deduplication ------------------------------- */

test('the same alert twice makes one ticket, not two', async () => {
  const before = await ticketCount();

  const first = await api('POST', '/tickets', fullKey, {
    subject: 'CPU pegged on web-03',
    description: 'First firing.',
    dedupeKey: 'alert-cpu-web-03',
  });
  const second = await api('POST', '/tickets', fullKey, {
    subject: 'CPU pegged on web-03',
    description: 'Still going.',
    dedupeKey: 'alert-cpu-web-03',
  });

  assert.equal(first.status, 201);
  assert.equal(second.status, 200, 'the repeat should not report a creation');
  assert.equal(second.payload.deduplicated, true);
  assert.equal(second.payload.ticket.reference, first.payload.ticket.reference);
  assert.equal(await ticketCount(), before + 1, 'a retry opened a second ticket');
});

test('the repeat is recorded as a comment, so nothing is lost', async () => {
  const ticket = await db.get<{ id: string }>(
    `SELECT id FROM tickets WHERE subject = 'CPU pegged on web-03' ORDER BY created_at DESC LIMIT 1`,
  );
  const comment = await db.get<{ body: string }>(
    `SELECT body FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 1`,
    [ticket!.id],
  );
  assert.match(comment!.body, /Still going/);
  assert.match(comment!.body, /Monitoring/, 'the comment should name the key that sent it');
});

test('the Idempotency-Key header works the same as the field', async () => {
  const before = await ticketCount();
  const send = () =>
    fetch(`${base}/api/v1/tickets`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${fullKey}`,
        'idempotency-key': 'alert-memory-web-04',
      },
      body: JSON.stringify({ subject: 'Memory pressure on web-04' }),
    });

  assert.equal((await send()).status, 201);
  assert.equal((await send()).status, 200);
  assert.equal(await ticketCount(), before + 1);
});

test('the same alert after the ticket was closed opens a new one', async () => {
  // The condition coming back after it was dealt with is a new incident, not
  // a continuation of the old one.
  await db.run(`UPDATE tickets SET status = 'closed' WHERE subject = 'CPU pegged on web-03'`);

  const before = await ticketCount();
  const { status } = await api('POST', '/tickets', fullKey, {
    subject: 'CPU pegged on web-03',
    dedupeKey: 'alert-cpu-web-03',
  });

  assert.equal(status, 201);
  assert.equal(await ticketCount(), before + 1);
});

/* ------------------------- Reading and commenting ------------------------- */

test('a ticket can be read back by reference', async () => {
  const created = await api('POST', '/tickets', fullKey, { subject: 'Readable' });
  const { status, payload } = await api('GET', `/tickets/${created.payload.ticket.reference}`, fullKey);

  assert.equal(status, 200);
  assert.equal(payload.ticket.subject, 'Readable');
  // Internal ids and requester details are not part of the promise.
  assert.equal(payload.ticket.requesterId, undefined);
});

test('a comment can be posted over the API', async () => {
  const created = await api('POST', '/tickets', fullKey, { subject: 'Commentable' });
  const { status } = await api('POST', `/tickets/${created.payload.ticket.reference}/comments`, fullKey, {
    body: 'The alert has cleared.',
  });
  assert.equal(status, 201);

  const comment = await db.get<{ body: string }>(
    `SELECT body FROM ticket_comments ORDER BY created_at DESC LIMIT 1`,
  );
  assert.equal(comment!.body, 'The alert has cleared.');
});

test('an unknown reference is a 404, not a 500', async () => {
  const { status } = await api('GET', '/tickets/ESC-999999', fullKey);
  assert.equal(status, 404);
});

/* ----------------------------- Key management ----------------------------- */

test('the token is shown once and never again', async () => {
  const created = await fetch(`${base}/api/settings/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Intranet form', scopes: ['tickets.create'] }),
  });
  assert.equal(created.status, 201);
  const payload = (await created.json()) as any;
  assert.match(payload.token, /^itk_[0-9a-f]{8}_/);

  const listed = await fetch(`${base}/api/settings/api-keys`, { headers: { cookie } });
  const keys = ((await listed.json()) as any).keys;
  const mine = keys.find((k: any) => k.name === 'Intranet form');

  assert.ok(mine, 'the key is missing from the list');
  assert.equal(mine.token, undefined, 'the token came back from the list');
  assert.equal(mine.tokenHash, undefined, 'even the hash should not be published');
  assert.equal(mine.prefix, payload.token.split('_').slice(0, 2).join('_'));
});

test('the token really is not stored in the clear', async () => {
  const rows = await db.all<{ token_hash: string }>(`SELECT token_hash FROM api_keys`);
  for (const row of rows) {
    assert.match(row.token_hash, /^[0-9a-f]{64}$/, 'a key is stored as something other than a SHA-256 hash');
  }
});

test('a key cannot be granted permissions its creator does not hold', async () => {
  // Otherwise a key outlives any later reduction of its owner's access.
  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword('Manager-Password!');
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['u-mgr', 'mgr@acme.test', 'mgr', 'Manager', hash, salt, 'manager', 'active', '#9a7b2f', 0, now, now],
  );
  for (const permission of ['tickets.create', 'settings.manage']) {
    await db.run('INSERT INTO user_permissions (user_id,permission) VALUES (?,?)', ['u-mgr', permission]);
  }

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'mgr@acme.test', password: 'Manager-Password!' }),
  });
  const mgrCookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';

  const response = await fetch(`${base}/api/settings/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: mgrCookie },
    body: JSON.stringify({ name: 'Escalation', scopes: ['tickets.create', 'users.delete'] }),
  });

  assert.equal(response.status, 403);
  assert.match(((await response.json()) as any).error, /users\.delete/);
});

test('revoking a key stops it working immediately', async () => {
  const created = await fetch(`${base}/api/settings/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Short lived', scopes: ['tickets.create'] }),
  });
  const { key, token } = (await created.json()) as any;

  assert.equal((await api('GET', '/whoami', token)).status, 200);

  const revoked = await fetch(`${base}/api/settings/api-keys/${key.id}`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(revoked.status, 200);

  assert.equal((await api('GET', '/whoami', token)).status, 401);
});

test('creating and revoking a key is written to the audit trail', async () => {
  const rows = await db.all<{ action: string; summary: string }>(
    `SELECT action, summary FROM audit_log WHERE action IN ('api_key_created','api_key_revoked')`,
  );
  assert.ok(rows.some((r) => r.action === 'api_key_created'));
  assert.ok(rows.some((r) => r.action === 'api_key_revoked'));
});

test('a ticket raised over the API is attributed to the key in the audit trail', async () => {
  const row = await db.get<{ actor_name: string; summary: string }>(
    `SELECT actor_name, summary FROM audit_log WHERE action = 'ticket_created_via_api' ORDER BY created_at DESC LIMIT 1`,
  );
  assert.ok(row, 'an API ticket must be auditable');
  assert.match(row!.actor_name, /API key/);
});

test('only a settings administrator can manage keys', async () => {
  const response = await fetch(`${base}/api/settings/api-keys`, { headers: {} });
  assert.equal(response.status, 401);
});

test('a key whose secret contains an underscore still works', async () => {
  /*
   * Regression. The secret is base64url, whose alphabet includes `_` and `-`,
   * so parsing the token by splitting on underscores tore roughly half of all
   * generated keys into four pieces and rejected them as malformed. The
   * failure was intermittent by nature - a key either worked forever or never
   * worked at all, depending on 32 random bytes.
   */
  const { verifyApiKey } = await import('../server/repositories/api-keys.ts');
  const now = new Date().toISOString();

  // Built by hand so the awkward characters are certain to be present rather
  // than left to chance.
  const crypto = await import('node:crypto');
  const prefix = 'itk_abcdef12';
  const secret = 'aa_bb-cc_dd--ee__ff';
  const token = `${prefix}_${secret}`;

  await db.run(
    `INSERT INTO api_keys (id, name, prefix, token_hash, scopes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'k-underscore',
      'Awkward characters',
      prefix,
      crypto.createHash('sha256').update(token).digest('hex'),
      JSON.stringify(['tickets.create']),
      'u-1',
      now,
      now,
    ],
  );

  const verified = await verifyApiKey(token);
  assert.equal(verified.ok, true, 'a token containing _ and - was rejected');

  const { status } = await api('GET', '/whoami', token);
  assert.equal(status, 200);
});

test('every generated token round-trips, whatever bytes it drew', async () => {
  // Fifty keys, because the bug above showed up in about half of them.
  const { createApiKey, verifyApiKey } = await import('../server/repositories/api-keys.ts');

  for (let i = 0; i < 50; i += 1) {
    const { token } = await createApiKey({ name: `Bulk ${i}`, scopes: ['tickets.create'], createdBy: 'u-1' });
    const verified = await verifyApiKey(token);
    assert.equal(verified.ok, true, `key ${i} did not verify: ${token}`);
  }
});
