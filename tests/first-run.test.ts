/**
 * The first-run flow, on a database that has never been used.
 *
 * Nobody can sign in to a system with no accounts, so the very first
 * administrator has to be created from outside the normal authentication
 * path. That makes this the one publicly reachable account-creating endpoint
 * in the product, and the only thing standing between it and a stranger is
 * the user count - so the test checks both that it works once and that it
 * closes behind itself.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'firstrun.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, `firstrun.db${suffix}`));
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

async function call(method: string, url: string, body?: unknown, cookie?: string) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '',
    payload: (await response.json().catch(() => null)) as any,
  };
}

before(async () => {
  wipe();
  ensureClientDist();

  const dbModule = await import('../server/db/index.ts');
  await dbModule.initDatabase();

  const { getServerlessApp } = await import('../server/index.ts');
  const app = await getServerlessApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  wipe();
});

test('an empty database asks for the first administrator', async () => {
  const { status, payload } = await call('GET', '/api/auth/bootstrap');
  assert.equal(status, 200);
  assert.equal(payload.setupRequired, true, 'the client would have shown the sign-in form instead');
  // No token is configured here, so the screen must not ask for one.
  assert.equal(payload.setupTokenRequired, false);
  // Self-registration stays shut even before anyone exists.
  assert.equal(payload.registrationOpen, false);
});

test('setup creates the administrator and signs them straight in', async () => {
  const created = await call('POST', '/api/auth/setup', {
    name: 'Avery Whitlock',
    email: 'Avery@Example.com',
    password: 'first-run-password',
    organizationName: 'Northwind Services',
  });

  assert.equal(created.status, 201);
  assert.equal(created.payload.user.email, 'avery@example.com', 'the address should be normalised');
  assert.ok(created.cookie, 'setup must establish the session, not bounce to a login form');

  // The session the response handed back is a real, usable one.
  const me = await call('GET', '/api/auth/me', undefined, created.cookie);
  assert.equal(me.status, 200);
  assert.equal(me.payload.user.email, 'avery@example.com');

  // The administrator can actually administer: this route needs a permission
  // a lesser role does not have.
  const users = await call('GET', '/api/users', undefined, created.cookie);
  assert.equal(users.status, 200, 'the first account was not given administrator permissions');
});

test('the organisation name from setup becomes the name the product wears', async () => {
  const { payload } = await call('GET', '/api/auth/bootstrap');
  assert.equal(payload.organizationName, 'Northwind Services');
});

test('setup closes behind itself', async () => {
  const boot = await call('GET', '/api/auth/bootstrap');
  assert.equal(boot.payload.setupRequired, false, 'the setup screen would still be reachable');

  const again = await call('POST', '/api/auth/setup', {
    name: 'Someone Else',
    email: 'someone@example.com',
    password: 'another-password',
    organizationName: 'Not Northwind',
  });
  assert.equal(again.status, 400, 'a second administrator could be created by anyone who found the URL');
  assert.match(String(again.payload.error), /already set up/i);
});

test('the first administrator can sign in normally afterwards', async () => {
  const { status, cookie } = await call('POST', '/api/auth/login', {
    login: 'avery@example.com',
    password: 'first-run-password',
  });
  assert.equal(status, 200);
  assert.ok(cookie);
});
