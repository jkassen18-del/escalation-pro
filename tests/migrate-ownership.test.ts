/**
 * Migrating a database the application does not own.
 *
 * A deployment where the schema was created by an administrator and the app
 * connects as a limited user is ordinary. PostgreSQL grants every privilege
 * on a table separately from ownership, and ALTER TABLE and CREATE INDEX need
 * *ownership* - CREATE INDEX refuses on that ground even when the index is
 * already there.
 *
 * That shape broke production: two columns were never added, every ticket
 * insert failed, and the message said only "Something went wrong on the
 * server". These tests pin the behaviour that replaced it - a missing column
 * fails loudly and says exactly what to run, a missing index does not.
 *
 * Skipped without a local Postgres; see DEVELOPING.md.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import test, { before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.NODE_ENV = 'test';

const HOST = '127.0.0.1';
const PORT = 55433;
/** Overridable, because a local server's superuser password is a local choice. */
const ADMIN =
  process.env.PGTEST_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:55433/postgres?sslmode=disable';

function reachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port: PORT, timeout: 1500 });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

let available = false;
let pg: typeof import('pg');

before(async () => {
  available = await reachable();
  if (available) pg = await import('pg');
});

/**
 * Builds a database shaped like the broken deployment: the tables belong to an
 * administrator, and the application's user holds every privilege on them but
 * owns nothing.
 */
async function makeUnownedSchema(name: string) {
  const Client = pg.default?.Client ?? pg.Client;
  const admin = new Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const db = new Client({ connectionString: ADMIN.replace('/postgres?', `/${name}?`) });
  await db.connect();
  await db.query('CREATE SCHEMA app_schema');
  await db.query(`DROP ROLE IF EXISTS ${name}_user`);
  await db.query(`CREATE ROLE ${name}_user LOGIN PASSWORD 'pw'`);
  await db.query(`GRANT ALL ON SCHEMA app_schema TO ${name}_user`);
  await db.query(`ALTER ROLE ${name}_user SET search_path = app_schema`);

  // Owned by the administrator, exactly like the tables that broke.
  await db.query(`CREATE TABLE app_schema.tickets (id TEXT PRIMARY KEY, status TEXT, subject TEXT NOT NULL)`);
  await db.query(`CREATE TABLE app_schema.ticket_comments (id TEXT PRIMARY KEY, body TEXT NOT NULL)`);
  await db.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA app_schema TO ${name}_user`);
  await db.end();

  return `postgres://${name}_user:pw@127.0.0.1:55433/${name}?sslmode=disable`;
}

/**
 * Runs the migration in a separate process.
 *
 * config.ts reads DATABASE_URL once, when it is first imported, and the driver
 * imports it - so a second scenario in the same process silently migrates the
 * first one's database however the module specifier is cache-busted. A child
 * process per scenario is the only way to be sure which database was touched.
 */
async function migrateAs(connectionString: string): Promise<{ ok: boolean; message: string }> {
  const script = `
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = ${JSON.stringify(connectionString)};
    delete process.env.DB_DRIVER;
    const { createDriver } = await import(${JSON.stringify(path.join(ROOT, 'server/db/driver.ts'))});
    const { migrate } = await import(${JSON.stringify(path.join(ROOT, 'server/db/schema.ts'))});
    const driver = await createDriver();
    try {
      await migrate(driver);
      // Prove the app can actually write the column that was missing.
      await driver.run('INSERT INTO tickets (id, subject, description_format) VALUES (?, ?, ?)', ['t-1', 'A ticket', 'html']);
      const row = await driver.get('SELECT description_format AS f FROM tickets WHERE id = ?', ['t-1']);
      console.log('RESULT_OK:' + JSON.stringify({ wrote: row && row.f }));
    } catch (error) {
      console.log('RESULT_FAIL:' + JSON.stringify(error instanceof Error ? error.message : String(error)));
    } finally {
      await driver.close().catch(() => undefined);
    }
  `;

  const { stdout } = await run('npx', ['tsx', '--input-type=module', '-e', script], {
    cwd: ROOT,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  const failed = stdout.match(/RESULT_FAIL:(.*)/);
  if (failed) return { ok: false, message: JSON.parse(failed[1]) as string };
  const passed = stdout.match(/RESULT_OK:(.*)/);
  assert.ok(passed, `child produced no result: ${stdout}`);
  return { ok: true, message: passed[1] };
}

test('a column it cannot add fails loudly, naming the cause and the fix', async (t) => {
  if (!available) return t.skip('no local postgres');

  const connectionString = await makeUnownedSchema('ownertest_a');
  const result = await migrateAs(connectionString);

  assert.equal(result.ok, false, 'a missing column must not be shrugged off - writes depend on it');
  const message = result.message;

  assert.match(message, /description_format/, 'names the column');
  assert.match(message, /tickets/, 'names the table');
  assert.match(message, /must be owner/i, 'quotes what the database actually said');
  assert.match(message, /ADD COLUMN IF NOT EXISTS/i, 'gives the statement to run');
  assert.match(message, /OWNER TO/i, 'says how to stop it recurring');
});

test('once the columns exist, not owning the tables is no obstacle', async (t) => {
  if (!available) return t.skip('no local postgres');

  const connectionString = await makeUnownedSchema('ownertest_b');

  // What an administrator does after reading the message above.
  const Client = pg.default?.Client ?? pg.Client;
  const admin = new Client({ connectionString: ADMIN.replace('/postgres?', '/ownertest_b?') });
  await admin.connect();
  await admin.query(`ALTER TABLE app_schema.tickets ADD COLUMN IF NOT EXISTS description_format TEXT NOT NULL DEFAULT 'text'`);
  await admin.query(`ALTER TABLE app_schema.ticket_comments ADD COLUMN IF NOT EXISTS body_format TEXT NOT NULL DEFAULT 'text'`);
  await admin.end();

  const result = await migrateAs(connectionString);
  assert.equal(result.ok, true, `migration should succeed: ${result.message}`);
  // And the app can actually write the column, which is what was broken.
  assert.match(result.message, /"wrote":"html"/, 'the insert that used to fail now works');
});
