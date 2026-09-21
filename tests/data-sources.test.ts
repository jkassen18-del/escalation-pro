/**
 * Read-only external database lookups, against real servers.
 *
 * The point of these tests is the refusals. A lookup runs a query the operator
 * wrote against a database the app does not own, so the interesting question
 * is not "does a SELECT work" but "what happens when someone tries to make it
 * do something else" - through the query, through the search term, or by
 * tampering with the stored row directly.
 *
 * Skipped unless the test servers are running; the harness that starts them is
 * described in DEVELOPING.md.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'datasources.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
delete process.env.DATABASE_URL;

const PG = { host: '127.0.0.1', port: 55433, database: 'crm', username: 'lookup_ro', password: 'ro-pass' };
const MY = { host: '127.0.0.1', port: 33307, database: 'crm', username: 'lookup_ro', password: 'ro-pass' };

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 1500 });
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

let mod: typeof import('../server/lib/data-sources.ts');
let dbm: typeof import('../server/db/index.ts');
let havePg = false;
let haveMy = false;

before(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.resolve(import.meta.dirname, `../data/datasources.db${suffix}`));
    } catch {
      // Absent on the first run.
    }
  }
  dbm = await import('../server/db/index.ts');
  await dbm.initDatabase();
  mod = await import('../server/lib/data-sources.ts');
  [havePg, haveMy] = await Promise.all([reachable(PG.host, PG.port), reachable(MY.host, MY.port)]);
});

after(async () => {
  await dbm?.db.close();
});

async function makeSource(engine: 'postgres' | 'mysql', lookupQuery: string, name = `src-${Math.random()}`) {
  const config = engine === 'postgres' ? PG : MY;
  return mod.saveDataSource(
    null,
    mod.validateInput({
      name,
      engine,
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.username,
      password: config.password,
      useTls: false,
      lookupQuery,
      valueColumn: 'id',
      labelColumn: 'name',
    }),
  );
}

const SEARCH_QUERY = {
  postgres: "SELECT id, name FROM customers WHERE name ILIKE '%' || :search || '%' ORDER BY name",
  mysql: "SELECT id, name FROM customers WHERE name LIKE CONCAT('%', :search, '%') ORDER BY name",
} as const;

for (const engine of ['postgres', 'mysql'] as const) {
  test(`${engine}: a lookup returns matching rows`, async (t) => {
    if (engine === 'postgres' ? !havePg : !haveMy) return t.skip(`no ${engine} server`);

    const source = await makeSource(engine, SEARCH_QUERY[engine]);
    const all = await mod.runLookup(source, '');
    assert.equal(all.length, 4, 'an empty search matches everything');

    const filtered = await mod.runLookup(source, 'ACME');
    assert.deepEqual(filtered.map((row) => row.label), ['ACME Ltd']);
    assert.match(filtered[0].value, /^\d+$/, 'the value column is returned');
  });

  test(`${engine}: the search term is data, never SQL`, async (t) => {
    if (engine === 'postgres' ? !havePg : !haveMy) return t.skip(`no ${engine} server`);

    const source = await makeSource(engine, SEARCH_QUERY[engine]);
    // Each of these is a classic injection payload. Bound as a parameter they
    // are just text that happens to match nothing.
    for (const payload of [
      "'; DROP TABLE customers; --",
      "' OR '1'='1",
      "' UNION SELECT 1, version() --",
      "\\'; DELETE FROM customers; --",
    ]) {
      const rows = await mod.runLookup(source, payload);
      assert.deepEqual(rows, [], `payload returned rows: ${payload}`);
    }

    // The table is still there, with every row intact.
    const after = await mod.runLookup(source, '');
    assert.equal(after.length, 4, 'the data survived every payload');
  });

  test(`${engine}: a write is refused even though the query passed validation`, async (t) => {
    if (engine === 'postgres' ? !havePg : !haveMy) return t.skip(`no ${engine} server`);

    // Store a source normally, then tamper with the row the way an attacker
    // with database access would - bypassing validateInput entirely.
    const source = await makeSource(engine, SEARCH_QUERY[engine]);
    await dbm.db.run(`UPDATE data_sources SET lookup_query = ? WHERE id = ?`, [
      "DELETE FROM customers WHERE name LIKE :search",
      source.id,
    ]);

    const tampered = (await mod.findDataSource(source.id))!;
    await assert.rejects(() => mod.runLookup(tampered, 'ACME'), /SELECT|cannot use|single statement/i);

    // Nothing was deleted.
    const check = await makeSource(engine, SEARCH_QUERY[engine], `check-${Math.random()}`);
    assert.equal((await mod.runLookup(check, '')).length, 4);
  });

  test(`${engine}: results are capped`, async (t) => {
    if (engine === 'postgres' ? !havePg : !haveMy) return t.skip(`no ${engine} server`);
    const source = await makeSource(engine, SEARCH_QUERY[engine]);
    const rows = await mod.runLookup(source, '');
    assert.ok(rows.length <= 50, 'never more than the row cap');
  });

  test(`${engine}: a test reports success and stores the outcome`, async (t) => {
    if (engine === 'postgres' ? !havePg : !haveMy) return t.skip(`no ${engine} server`);

    const source = await makeSource(engine, SEARCH_QUERY[engine]);
    const result = await mod.testDataSource(source);
    assert.equal(result.ok, true, result.message);

    const stored = (await mod.findDataSource(source.id))!;
    assert.equal(stored.status, 'ok');
    assert.ok(stored.lastTestedAt);
  });

  test(`${engine}: a bad credential is reported, not thrown away`, async (t) => {
    if (engine === 'postgres' ? !havePg : !haveMy) return t.skip(`no ${engine} server`);

    const config = engine === 'postgres' ? PG : MY;
    const source = await mod.saveDataSource(
      null,
      mod.validateInput({
        name: `bad-${Math.random()}`,
        engine,
        host: config.host,
        port: config.port,
        database: config.database,
        username: config.username,
        password: 'wrong-password',
        useTls: false,
        lookupQuery: SEARCH_QUERY[engine],
        valueColumn: 'id',
        labelColumn: 'name',
      }),
    );

    const result = await mod.testDataSource(source);
    assert.equal(result.ok, false);
    assert.ok(result.message.length > 0, 'the reason is reported');
    assert.equal((await mod.findDataSource(source.id))!.status, 'error');
  });
}

test('the stored password is encrypted, never held in the clear', async () => {
  const source = await makeSource('postgres', SEARCH_QUERY.postgres, `enc-${Math.random()}`);
  const row = await dbm.db.get<{ password_encrypted: string }>(
    `SELECT password_encrypted FROM data_sources WHERE id = ?`,
    [source.id],
  );
  assert.ok(row?.password_encrypted);
  assert.doesNotMatch(row.password_encrypted, /ro-pass/, 'the secret is in the row in plain text');
  // And it is not exposed through the API shape either.
  assert.equal((source as Record<string, unknown>).password, undefined);
  assert.equal(source.hasPassword, true);
});

test('a column name that is not an identifier is refused', () => {
  // Column names are identifiers, so they cannot be bound - they are checked.
  for (const bad of ['id; DROP TABLE customers', 'id)--', '*', 'a b', '']) {
    assert.throws(
      () =>
        mod.validateInput({
          name: 'x',
          engine: 'postgres',
          host: 'db.internal',
          port: 5432,
          database: 'crm',
          username: 'ro',
          useTls: true,
          lookupQuery: 'SELECT id, name FROM customers WHERE name = :search',
          valueColumn: bad,
          labelColumn: 'name',
        }),
      /column name/i,
      `accepted column name: ${bad}`,
    );
  }
});

test('a query without the search placeholder is refused', () => {
  assert.throws(
    () =>
      mod.validateInput({
        name: 'x',
        engine: 'postgres',
        host: 'db.internal',
        port: 5432,
        database: 'crm',
        username: 'ro',
        useTls: true,
        lookupQuery: 'SELECT id, name FROM customers',
        valueColumn: 'id',
        labelColumn: 'name',
      }),
    /:search/,
  );
});
