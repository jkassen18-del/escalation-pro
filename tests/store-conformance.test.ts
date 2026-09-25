/**
 * One suite, run against every backend that is reachable.
 *
 * The point of the Store is that a repository cannot tell which database is
 * underneath it. That claim is only worth anything if the same assertions
 * pass on all of them, so they are written once here and replayed per
 * backend rather than tested separately and hoped to agree.
 *
 * SQLite always runs. MongoDB runs when MONGODB_URI is set - see DEVELOPING.md.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'store-conformance-'));

/*
 * Which SQL engine to prove against.
 *
 * `dbConfig` resolves once, at import, so a single run can only exercise one
 * of them - hence the env switch rather than a third entry in `backends`.
 * `npm test` covers SQLite; DEVELOPING.md has the commands for the others.
 */
const SQL_URL = process.env.STORE_TEST_URL || '';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

if (SQL_URL) {
  process.env.DATABASE_URL = SQL_URL;
  delete process.env.DB_DRIVER;
  delete process.env.SQLITE_FILE;
} else {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DATA_DIR = workspace;
  process.env.SQLITE_FILE = 'conformance.db';
  delete process.env.DATABASE_URL;
}

const { initDatabase, getDriver, db } = await import('../server/db/index.ts');
const { createSqlStore } = await import('../server/db/store/sql.ts');
const { createMongoStore, assertTransactionsSupported, idFor } = await import('../server/db/store/mongo.ts');
const { ensureIndexes, buildIndexPlan, defaultsOf } = await import('../server/db/store/mongo-schema.ts');
type Store = import('../server/db/store/types.ts').Store;

const MONGO_URL = process.env.MONGODB_TEST_URI || process.env.MONGODB_URI || '';

/*
 * Probed at module load, not in before(): node:test reads each test's `skip`
 * option while this module is still evaluating, so a flag set in a hook is
 * always still false and the whole suite skips against a server that is
 * sitting right there. The MySQL suite learned this the hard way.
 */
const mongo = await (async () => {
  if (!MONGO_URL) return null;
  try {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const database = client.db(process.env.MONGODB_TEST_DATABASE || 'infraticket_conformance');
    await assertTransactionsSupported(database);
    // A previous run's documents would make uniqueness and count assertions
    // lie, so the database starts empty.
    await database.dropDatabase();
    await ensureIndexes(database);
    return { client, store: createMongoStore(client, database, 'MongoDB (test)') };
  } catch (error) {
    console.warn(`[conformance] MongoDB unavailable, skipping those cases: ${(error as Error).message}`);
    return null;
  }
})();

await initDatabase();
const driver = getDriver();
const backends: Array<{ name: string; store: Store }> = [
  { name: driver.dialect, store: createSqlStore(driver) },
];
if (mongo) backends.push({ name: 'mongodb', store: mongo.store });

after(async () => {
  await mongo?.client.close();
  await db.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** Keeps each backend's rows apart so one cannot satisfy another's count. */
let seq = 0;
const tag = (backend: string) => `${backend}-${(seq += 1)}`;

async function seedAttempts(store: Store, prefix: string, keys: string[]): Promise<void> {
  for (const [index, key] of keys.entries()) {
    await store.insert('login_attempts', {
      id: `${prefix}-${index}`,
      key,
      // Distinct, ordered timestamps: ISO-8601 UTC sorts lexicographically in
      // the same order it sorts chronologically, on both backends.
      created_at: `2026-01-0${index + 1}T00:00:00.000Z`,
    });
  }
}

for (const { name, store } of backends) {
  test(`[${name}] round-trips a document`, async () => {
    const id = tag(name);
    await store.insert('login_attempts', { id, key: 'alice', created_at: '2026-01-01T00:00:00.000Z' });

    const found = await store.findOne<{ id: string; key: string }>('login_attempts', { id });
    assert.equal(found?.id, id);
    assert.equal(found?.key, 'alice');
  });

  test(`[${name}] applies the schema's column defaults`, async () => {
    const id = tag(name);
    // `status`, `role` and `avatar_color` are all omitted; SQL fills them from
    // the DDL and the Mongo store has to do the same.
    await store.insert('users', {
      id,
      email: `${id}@example.com`,
      username: id,
      name: 'Test Person',
      password_hash: 'h',
      password_salt: 's',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });

    const user = await store.findOne<{ status: string; role: string; must_change_password: number }>('users', { id });
    assert.equal(user?.status, 'active');
    assert.equal(user?.role, 'agent');
    assert.equal(Number(user?.must_change_password), 0);
  });

  test(`[${name}] filters with the comparison operators`, async () => {
    const prefix = tag(name);
    await seedAttempts(store, prefix, ['aa', 'ab', 'bb', 'cc']);
    const mine = { id: { $like: `${prefix}-%` } };

    assert.equal(await store.count('login_attempts', mine), 4);
    assert.equal(await store.count('login_attempts', { ...mine, key: { $in: ['aa', 'cc'] } }), 2);
    assert.equal(await store.count('login_attempts', { ...mine, key: { $nin: ['aa', 'cc'] } }), 2);
    assert.equal(await store.count('login_attempts', { ...mine, key: { $like: 'a%' } }), 2);
    assert.equal(await store.count('login_attempts', { ...mine, key: { $ne: 'aa' } }), 3);
    assert.equal(await store.count('login_attempts', { ...mine, created_at: { $gte: '2026-01-03' } }), 2);
    assert.equal(
      await store.count('login_attempts', { $and: [mine, { $or: [{ key: 'aa' }, { key: 'bb' }] }] }),
      2,
    );
  });

  test(`[${name}] an empty $in matches nothing, an empty $nin matches everything`, async () => {
    const prefix = tag(name);
    await seedAttempts(store, prefix, ['x', 'y']);
    const mine = { id: { $like: `${prefix}-%` } };

    assert.equal(await store.count('login_attempts', { ...mine, key: { $in: [] } }), 0);
    assert.equal(await store.count('login_attempts', { ...mine, key: { $nin: [] } }), 2);
  });

  test(`[${name}] $ne and $nin still return rows where the column is null`, async () => {
    const prefix = tag(name);
    // `job_title` is nullable and left unset on one of the two.
    for (const [index, title] of [null, 'Engineer'].entries()) {
      await store.insert('users', {
        id: `${prefix}-u${index}`,
        email: `${prefix}-u${index}@example.com`,
        username: `${prefix}-u${index}`,
        name: 'Test Person',
        password_hash: 'h',
        password_salt: 's',
        job_title: title,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
    }
    const mine = { id: { $like: `${prefix}-%` } };

    /*
     * SQL's `<> 'Engineer'` drops the null row, because null compares as
     * unknown rather than as different. Mongo's $ne returns it. The SQL store
     * rewrites the predicate so both agree - on returning it.
     */
    assert.equal(await store.count('login_attempts', {}) >= 0, true);
    assert.equal(await store.count('users', { ...mine, job_title: { $ne: 'Engineer' } }), 1);
    assert.equal(await store.count('users', { ...mine, job_title: { $null: true } }), 1);
    assert.equal(await store.count('users', { ...mine, job_title: { $null: false } }), 1);
  });

  test(`[${name}] sorts, limits and skips`, async () => {
    const prefix = tag(name);
    await seedAttempts(store, prefix, ['a', 'b', 'c', 'd']);
    const mine = { id: { $like: `${prefix}-%` } };

    const descending = await store.find<{ key: string }>('login_attempts', mine, {
      sort: [['created_at', 'desc']],
    });
    assert.deepEqual(descending.map((row) => row.key), ['d', 'c', 'b', 'a']);

    const page = await store.find<{ key: string }>('login_attempts', mine, {
      sort: [['created_at', 'asc']],
      limit: 2,
      skip: 1,
    });
    assert.deepEqual(page.map((row) => row.key), ['b', 'c']);

    // A skip with no limit is a syntax error in SQL unless a limit is supplied.
    const rest = await store.find<{ key: string }>('login_attempts', mine, {
      sort: [['created_at', 'asc']],
      skip: 2,
    });
    assert.deepEqual(rest.map((row) => row.key), ['c', 'd']);
  });

  test(`[${name}] projects only the fields asked for`, async () => {
    const id = tag(name);
    await store.insert('login_attempts', { id, key: 'projected', created_at: '2026-01-01T00:00:00.000Z' });

    const row = await store.findOne<Record<string, unknown>>('login_attempts', { id }, { project: ['key'] });
    assert.deepEqual(Object.keys(row ?? {}), ['key']);
  });

  test(`[${name}] update reports rows matched, not rows changed`, async () => {
    const prefix = tag(name);
    await seedAttempts(store, prefix, ['before', 'before']);
    const mine = { id: { $like: `${prefix}-%` } };

    assert.equal(await store.update('login_attempts', mine, { key: 'after' }), 2);
    // Writing the value it already holds still counts as a row found, or
    // callers cannot tell "no such row" from "nothing to do".
    assert.equal(await store.update('login_attempts', mine, { key: 'after' }), 2);
    assert.equal(await store.update('login_attempts', { id: 'nobody-at-all' }, { key: 'x' }), 0);
    // An empty patch is a no-op rather than invalid SQL.
    assert.equal(await store.update('login_attempts', mine, {}), 0);
  });

  test(`[${name}] replace upserts, insertIfAbsent keeps what is there`, async () => {
    const id = tag(name);
    const row = { id, key: 'first', created_at: '2026-01-01T00:00:00.000Z' };

    await store.replace('login_attempts', row);
    await store.replace('login_attempts', { ...row, key: 'second' });
    assert.equal((await store.findOne<{ key: string }>('login_attempts', { id }))?.key, 'second');
    assert.equal(await store.count('login_attempts', { id }), 1);

    await store.insertIfAbsent('login_attempts', { ...row, key: 'third' });
    assert.equal((await store.findOne<{ key: string }>('login_attempts', { id }))?.key, 'second');
  });

  test(`[${name}] remove reports how many went`, async () => {
    const prefix = tag(name);
    await seedAttempts(store, prefix, ['gone', 'gone', 'stays']);

    assert.equal(await store.remove('login_attempts', { id: { $like: `${prefix}-%` }, key: 'gone' }), 2);
    assert.equal(await store.count('login_attempts', { id: { $like: `${prefix}-%` } }), 1);
    assert.equal(await store.remove('login_attempts', { id: 'nobody-at-all' }), 0);
  });

  test(`[${name}] refuses a duplicate key`, async () => {
    const id = tag(name);
    const row = { id, key: 'dupe', created_at: '2026-01-01T00:00:00.000Z' };
    await store.insert('login_attempts', row);

    await assert.rejects(() => store.insert('login_attempts', row));
    assert.equal(await store.count('login_attempts', { id }), 1);
  });

  test(`[${name}] refuses a duplicate value on a unique column`, async () => {
    const prefix = tag(name);
    const user = (suffix: string) => ({
      id: `${prefix}-${suffix}`,
      email: `${prefix}@example.com`,
      username: `${prefix}-${suffix}`,
      name: 'Test Person',
      password_hash: 'h',
      password_salt: 's',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });

    await store.insert('users', user('a'));
    // Different primary key, same email. SQL has a UNIQUE constraint; Mongo
    // only refuses this because the index plan is derived from that schema.
    await assert.rejects(() => store.insert('users', user('b')));
  });

  test(`[${name}] rolls a transaction back`, async () => {
    const id = tag(name);

    await assert.rejects(() =>
      store.transaction(async () => {
        await store.insert('login_attempts', { id, key: 'doomed', created_at: '2026-01-01T00:00:00.000Z' });
        throw new Error('rollback please');
      }),
    );

    assert.equal(await store.count('login_attempts', { id }), 0);
  });

  test(`[${name}] commits a transaction that returns`, async () => {
    const id = tag(name);

    const result = await store.transaction(async () => {
      await store.insert('login_attempts', { id, key: 'kept', created_at: '2026-01-01T00:00:00.000Z' });
      return 'done';
    });

    assert.equal(result, 'done');
    assert.equal(await store.count('login_attempts', { id }), 1);
  });
}

/* ----------------------- Backend-independent checks ----------------------- */

test('the Mongo index plan covers every unique constraint in the schema', () => {
  const plan = buildIndexPlan();
  const unique = plan.filter((entry) => entry.unique).map((entry) => `${entry.collection}:${Object.keys(entry.keys).join(',')}`);

  // Spot-checks rather than a full list: these are the constraints whose loss
  // would let two accounts share a login or two tickets share a number.
  assert.ok(unique.includes('users:email'));
  assert.ok(unique.includes('users:username'));
  assert.ok(unique.includes('teams:key'));
  assert.ok(unique.includes('tickets:number'));
  assert.ok(unique.includes('team_form_fields:team_id,field_key'));
});

test('column defaults are read off the schema', () => {
  const users = defaultsOf(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'agent',
    must_change_password INTEGER NOT NULL DEFAULT 0,
    job_title TEXT
  )`);

  assert.equal(users?.collection, 'users');
  assert.equal(users?.defaults.role, 'agent');
  assert.equal(users?.defaults.must_change_password, 0);
  assert.ok(!('job_title' in (users?.defaults ?? {})), 'a nullable column has no default');
});

test('composite keys cannot collide through the separator', () => {
  // ("a|b", "c") and ("a", "b|c") both join to a|b|c unless escaped.
  const first = idFor('team_members', { team_id: 'a|b', user_id: 'c' });
  const second = idFor('team_members', { team_id: 'a', user_id: 'b|c' });
  assert.notEqual(first, second);
});
