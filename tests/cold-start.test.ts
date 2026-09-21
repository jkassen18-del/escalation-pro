/**
 * Regression test for the cold-start 500.
 *
 * express-session reads its store on every request that carries a session
 * cookie. The store is the database, so if the session middleware is mounted
 * ahead of the database-readiness check, a returning visitor's first request
 * to a cold instance reaches db.get() before anything has called
 * initDatabase(). That threw, and the generic error handler turned it into an
 * opaque 500 - sign-in failed on the first attempt and worked on the retry.
 *
 * The scenario needs no external database: pointing a "serverless" instance at
 * SQLite is itself a refused configuration, so opening the connection fails on
 * purpose. What matters is *which* failure the caller sees. Before the fix the
 * answer came from deep inside express-session as a 500 that named nothing;
 * after it, the readiness gate answers 503 and says what is wrong.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test, { after, before } from 'node:test';

const SESSION_SECRET = 'test-secret-that-is-at-least-32-characters-long';

process.env.NODE_ENV = 'production';
process.env.VERCEL = '1';
process.env.DB_DRIVER = 'sqlite';
process.env.SESSION_SECRET = SESSION_SECRET;
process.env.SESSION_COOKIE_SECURE = 'true';
delete process.env.DATABASE_URL;

const { SESSION_COOKIE_NAME } = await import('../server/config.ts');
const { getServerlessApp } = await import('../server/index.ts');

/** express-session's cookie format: "s:" + sid + "." + base64 HMAC-SHA256. */
function signedCookie(sid: string): string {
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(sid).digest('base64').replace(/=+$/, '');
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(`s:${sid}.${mac}`)}`;
}

let server: http.Server;
let base: string;

before(async () => {
  // Exactly how the serverless entry builds it: the database is NOT opened
  // first, which is what makes the instance "cold".
  const app = await getServerlessApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

after(() => server?.close());

test('a cold instance does not answer a cookie-bearing request with an opaque 500', async () => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: signedCookie('any-previously-issued-sid') },
    body: JSON.stringify({ login: 'someone@example.com', password: 'whatever' }),
  });

  assert.notEqual(response.status, 500, 'the session store was read before the database was opened');
  assert.equal(response.status, 503);

  const body = (await response.json()) as { error?: string };
  assert.match(String(body.error), /database is unavailable/i);
});

test('/health stays reachable and reports the cause', async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 503);

  const body = (await response.json()) as { status?: string; error?: string };
  assert.equal(body.status, 'degraded');
  // It names the real problem rather than a generic failure.
  assert.match(String(body.error), /DATABASE_URL/);
});
