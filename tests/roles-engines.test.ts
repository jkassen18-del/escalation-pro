/**
 * Roles on every engine: built-ins seeded once even when two instances
 * migrate together, the upgrade backfill, and custom role CRUD keeping each
 * holder's tier in step.
 *
 * SQLite always runs. Postgres and MySQL/MariaDB run when the local servers
 * described in DEVELOPING.md are up, and skip otherwise.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const PG_ADMIN = process.env.PGTEST_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:55433/postgres?sslmode=disable';
const MYSQL_ADMIN = process.env.MYSQL_ADMIN_URL ?? 'mysql://root:@127.0.0.1:33307/';
const SCRATCH_DB = 'infraticket_roles';

async function runChild(env: Record<string, string>): Promise<Record<string, unknown>> {
  const { stdout } = await run('npx', ['tsx', path.join(ROOT, 'tests/roles-engines.child.ts')], {
    cwd: ROOT,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SESSION_SECRET: 'x'.repeat(48),
      DB_DRIVER: '',
      DATABASE_URL: '',
      ...env,
    },
  });
  const line = stdout.match(/RESULT:(.*)/);
  assert.ok(line, `child produced no result: ${stdout}`);
  return JSON.parse(line[1]) as Record<string, unknown>;
}

function check(result: Record<string, unknown>) {
  assert.deepEqual(result.builtIns, ['admin', 'manager', 'agent', 'viewer'], 'each built-in exactly once');
  assert.equal(result.legacyRole, 'role-viewer', 'an account without a role gets its tier’s built-in');
  assert.equal(result.legacyCanClose, true, 'an old extra grant widens to the permissions split from it');
  assert.equal(result.customTier, 'agent');
  assert.equal(result.memberTier, 'manager', 'editing a role moves its holders’ tier with it');
  assert.equal(result.afterDelete, 'role-viewer', 'deleting a role moves its holders to the replacement');
}

const pgAvailable = await (async () => {
  try {
    const pg = await import('pg');
    const Client = pg.default?.Client ?? pg.Client;
    const client = new Client({ connectionString: PG_ADMIN });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${SCRATCH_DB}`);
    await client.end();
    return true;
  } catch {
    return false;
  }
})();

const mysqlAvailable = await (async () => {
  try {
    const mysql = await import('mysql2/promise');
    const connection = await mysql.createConnection(MYSQL_ADMIN);
    await connection.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await connection.query(`CREATE DATABASE ${SCRATCH_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await connection.end();
    return true;
  } catch {
    return false;
  }
})();

test('sqlite: roles seed once, upgrade cleanly and round-trip', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-roles-'));
  try {
    check(await runChild({ DATA_DIR: dir, SQLITE_FILE: 'db.sqlite' }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('postgres: roles seed once, upgrade cleanly and round-trip', { skip: !pgAvailable && 'no local postgres' }, async () => {
  const url = new URL(PG_ADMIN);
  url.pathname = `/${SCRATCH_DB}`;
  check(await runChild({ DATABASE_URL: url.toString() }));
});

test('mysql: roles seed once, upgrade cleanly and round-trip', { skip: !mysqlAvailable && 'no local mysql' }, async () => {
  const url = new URL(MYSQL_ADMIN);
  url.pathname = `/${SCRATCH_DB}`;
  check(await runChild({ DATABASE_URL: url.toString() }));
});
