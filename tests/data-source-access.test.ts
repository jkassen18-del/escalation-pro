/**
 * Who can see and use a database connection.
 *
 * The connection record is a map of internal infrastructure - hostname, port,
 * database name, database user, the SQL, and whatever a failed connection
 * said. The lookup endpoint is a search box over whatever that query selects.
 * Neither belongs to every account that can sign in.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'dsaccess.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SECRET_KEY = 'b'.repeat(64);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, `dsaccess.db${suffix}`));
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
let adminCookie: string;
let viewerCookie: string;
let sourceId: string;
let db: typeof import('../server/db/index.ts').db;

async function signIn(login: string, password: string) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password }),
  });
  assert.equal(response.status, 200, `could not sign in as ${login}`);
  return response.headers.get('set-cookie')!.split(';')[0];
}

before(async () => {
  wipe();
  ensureClientDist();

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { ALL_PERMISSIONS } = await import('../server/permissions.ts');
  const now = new Date().toISOString();

  for (const [id, email, role] of [
    ['u-admin', 'admin@acme.test', 'admin'],
    ['u-viewer', 'viewer@acme.test', 'viewer'],
  ] as const) {
    const { hash, salt } = hashPassword('Adm1n-Password!');
    await db.run(
      'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, email, id, id, hash, salt, role, 'active', '#9a7b2f', 0, now, now],
    );
  }
  // Only the admin gets the explicit grants; the viewer keeps its role defaults.
  for (const permission of ALL_PERMISSIONS) {
    await db.run('INSERT INTO user_permissions (user_id,permission) VALUES (?,?)', ['u-admin', permission]);
  }

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;

  adminCookie = await signIn('admin@acme.test', 'Adm1n-Password!');
  viewerCookie = await signIn('viewer@acme.test', 'Adm1n-Password!');

  const created = await fetch(`${base}/api/data-sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({
      name: 'Customer CRM',
      engine: 'postgres',
      host: 'crm.internal.example',
      port: 5432,
      database: 'crm',
      username: 'lookup_ro',
      password: 'super-secret',
      useTls: true,
      lookupQuery: "SELECT id, name FROM customers WHERE name ILIKE '%' || :search || '%'",
      valueColumn: 'id',
      labelColumn: 'name',
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  sourceId = ((await created.json()) as any).dataSource.id;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await db.close();
  wipe();
});

test('an administrator sees the full connection record', async () => {
  const payload = (await (await fetch(`${base}/api/data-sources`, { headers: { cookie: adminCookie } })).json()) as any;
  const source = payload.dataSources[0];
  assert.equal(source.host, 'crm.internal.example');
  assert.equal(source.username, 'lookup_ro');
  assert.match(source.lookupQuery, /SELECT/);
});

test('the password is never returned, to anyone', async () => {
  for (const cookie of [adminCookie, viewerCookie]) {
    const body = await (await fetch(`${base}/api/data-sources`, { headers: { cookie } })).text();
    assert.doesNotMatch(body, /super-secret/, 'the stored password was sent to the client');
    assert.doesNotMatch(body, /password_encrypted|passwordEncrypted/, 'the ciphertext was sent to the client');
  }
});

test('a read-only account sees only the name, not the infrastructure', async () => {
  const response = await fetch(`${base}/api/data-sources`, { headers: { cookie: viewerCookie } });
  const body = await response.clone().text();
  const payload = (await response.json()) as any;

  assert.equal(payload.dataSources.length, 1, 'it still knows the connection exists');
  assert.equal(payload.dataSources[0].name, 'Customer CRM');

  for (const leak of ['crm.internal.example', 'lookup_ro', 'SELECT', '5432']) {
    assert.doesNotMatch(body, new RegExp(leak), `leaked "${leak}" to a viewer`);
  }
});

test('a read-only account cannot search the connected database', async () => {
  const response = await fetch(`${base}/api/data-sources/${sourceId}/lookup?q=a`, {
    headers: { cookie: viewerCookie },
  });
  assert.equal(response.status, 403, 'a viewer must not get a search box over the CRM');
});

test('signing out closes both off entirely', async () => {
  assert.equal((await fetch(`${base}/api/data-sources`)).status, 401);
  assert.equal((await fetch(`${base}/api/data-sources/${sourceId}/lookup?q=a`)).status, 401);
});

test('a read-only account cannot create, edit, test or delete a connection', async () => {
  const body = JSON.stringify({ name: 'x', engine: 'postgres', host: 'h', port: 5432, database: 'd', username: 'u', lookupQuery: 'SELECT 1 WHERE x = :search', valueColumn: 'id', labelColumn: 'name' });
  const headers = { 'content-type': 'application/json', cookie: viewerCookie };

  assert.equal((await fetch(`${base}/api/data-sources`, { method: 'POST', headers, body })).status, 403);
  assert.equal((await fetch(`${base}/api/data-sources/${sourceId}`, { method: 'PATCH', headers, body })).status, 403);
  assert.equal((await fetch(`${base}/api/data-sources/${sourceId}/test`, { method: 'POST', headers })).status, 403);
  assert.equal((await fetch(`${base}/api/data-sources/${sourceId}`, { method: 'DELETE', headers })).status, 403);
});
