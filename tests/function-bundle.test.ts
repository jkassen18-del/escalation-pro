/**
 * The deployed artifact is the bundle, not the source.
 *
 * sanitize-html is CommonJS and requires an ESM-only htmlparser2. Under the
 * development loader that resolved fine, so every test passed - and the built
 * function then failed on every request in production with "require() of ES
 * Module ... not supported". Nothing in the suite looked at the bundle.
 *
 * So this loads it the way the platform does: a separate plain `node`, no
 * TypeScript loader, no dev resolution. A database is not needed - an
 * unreachable one reports 503 with its reason, which is a healthy answer. What
 * must not happen is the module failing to load at all.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(ROOT, 'dist/function/index.mjs');

/** Interop and resolution failures, as opposed to a database being down. */
const LOAD_FAILURE = /require\(\) of ES Module|Dynamic require|Cannot find module|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|is not a function|is not defined/;

test('the built serverless function loads and serves under plain node', async (t) => {
  if (!fs.existsSync(BUNDLE)) {
    return t.skip('dist/function/index.mjs is not built; run npm run build:function');
  }

  // Deliberately a child process: running this in-process would inherit the
  // loader whose resolution hid the problem in the first place.
  const script = `
    process.env.VERCEL = '1';
    process.env.SESSION_SECRET = ${JSON.stringify('x'.repeat(48))};
    process.env.ENCRYPTION_KEY = ${JSON.stringify('a'.repeat(64))};
    process.env.DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none?sslmode=disable';
    const handler = (await import(${JSON.stringify(BUNDLE)})).default;
    if (typeof handler !== 'function') throw new Error('bundle default export is not a handler');
    const http = await import('node:http');
    const server = http.createServer((req, res) => handler(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/health');
    const body = await response.text();
    server.close();
    console.log('STATUS:' + response.status);
    console.log('BODY:' + body);
  `;

  /*
   * --no-experimental-require-module matters: newer Node versions allow a
   * CommonJS module to require() an ESM one, and this machine's Node does.
   * The deployment runtime did not, which is exactly why the break reached
   * production while everything here stayed green. Turning the allowance off
   * reproduces the stricter runtime.
   */
  const { stdout } = await run(process.execPath, ['--no-experimental-require-module', '--input-type=module', '-e', script], {
    cwd: ROOT,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  const status = Number(stdout.match(/STATUS:(\d+)/)?.[1]);
  const body = stdout.match(/BODY:(.*)/)?.[1] ?? '';

  // 200 when a database happens to be reachable, 503 when it is not. Either
  // proves the module loaded and express answered.
  assert.ok([200, 503].includes(status), `unexpected status ${status}: ${body}`);
  assert.doesNotMatch(body, LOAD_FAILURE, `the bundle failed to load: ${body}`);
});
