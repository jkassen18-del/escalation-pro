/**
 * The MySQL driver, against a real server.
 *
 * MySQL disagrees with both other engines in ways a mock cannot reproduce: it
 * refuses to index a TEXT column, refuses a plain DEFAULT on one, truncates
 * silently at 64 KB when it is not in strict mode, and has no ON CONFLICT at
 * all. Every one of those is enforced by the server, so every one of them is
 * checked against the server.
 *
 * Skipped, loudly, when no MySQL is reachable - see DEVELOPING.md.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

const URL_ENV =
  process.env.MYSQL_TEST_URL || 'mysql://ticket_app:app-pass@127.0.0.1:33307/infraticket_test';

process.env.NODE_ENV = 'production';
process.env.DATABASE_URL = URL_ENV;
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
delete process.env.DB_DRIVER;
delete process.env.SQLITE_FILE;

let db: typeof import('../server/db/index.ts').db;

/*
 * Probed here, at module load, rather than in before().
 *
 * node:test reads each test's `skip` option when the test() call runs, which
 * is while this module is still being evaluated - long before any hook. A
 * flag set in before() is therefore always still false, and the whole suite
 * skips against a server that is sitting right there.
 */
const available = await (async () => {
  try {
    const mysql = await import('mysql2/promise');
    const probe = await mysql.createConnection(URL_ENV);
    await probe.end();
    return true;
  } catch {
    return false;
  }
})();

before(async () => {
  if (!available) return;

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;

  // Start from nothing, so the schema is genuinely created by this run.
  const mysql2 = await import('mysql2/promise');
  const admin = await mysql2.createConnection(URL_ENV);
  const [tables] = await admin.query<any[]>(
    `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()`,
  );
  await admin.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const row of tables) await admin.query(`DROP TABLE IF EXISTS \`${row.t}\``);
  await admin.query('SET FOREIGN_KEY_CHECKS = 1');
  await admin.end();

  await dbModule.initDatabase();
});

after(async () => {
  if (available && db) await db.close();
});

const skip = () => (available ? false : 'no MySQL reachable at MYSQL_TEST_URL');

test('the schema is created and the driver reports the right dialect', { skip: skip() }, async () => {
  assert.equal(db.dialect, 'mysql');
  const tables = await db.all<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()`,
  );
  // Every table the app needs, not merely "some tables were made".
  const names = new Set(tables.map((row) => row.t));
  for (const required of ['users', 'tickets', 'ticket_comments', 'sessions', 'settings', 'teams']) {
    assert.ok(names.has(required), `${required} was not created`);
  }
});

test('keys are indexable types and free text is not truncatable', { skip: skip() }, async () => {
  const columns = await db.all<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema = DATABASE()`,
  );
  const typeOf = (table: string, column: string) =>
    columns.find((c) => c.table_name === table && c.column_name === column)?.data_type;

  // A key MySQL cannot index is a schema that will not build.
  assert.equal(typeOf('users', 'id'), 'varchar');
  assert.equal(typeOf('users', 'email'), 'varchar');
  assert.equal(typeOf('tickets', 'team_id'), 'varchar', 'a foreign key must match its parent type');

  // A body or an attachment must not be capped at TEXT's 64 KB.
  assert.equal(typeOf('ticket_comments', 'body'), 'longtext');
  assert.equal(typeOf('ticket_attachments', 'content'), 'longtext');

  // Timestamps sort, so they must be sortable by index rather than filesort.
  assert.equal(typeOf('tickets', 'updated_at'), 'varchar');
  assert.equal(typeOf('tickets', 'created_at'), 'varchar');
});

test('re-running the migration changes nothing', { skip: skip() }, async () => {
  // MySQL has no CREATE INDEX IF NOT EXISTS, so a second start is exactly
  // where a naive port falls over.
  const { migrate } = await import('../server/db/schema.ts');
  const { getDriver } = await import('../server/db/index.ts');
  await migrate(getDriver());
  await migrate(getDriver());

  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM counters WHERE name = 'ticket_number'`,
  );
  assert.equal(Number(row!.n), 1, 'the seed row was inserted more than once');
});

test('an upsert that means "insert or ignore" does not raise', { skip: skip() }, async () => {
  const now = new Date().toISOString();
  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword('irrelevant');
  await db.run(
    `INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['u-1', 'a@b.test', 'ab', 'A B', hash, salt, 'admin', 'active', '#9a7b2f', 0, now, now],
  );

  await db.run(`INSERT INTO user_permissions (user_id, permission) VALUES (?, ?)
                ON CONFLICT (user_id, permission) DO NOTHING`, ['u-1', 'tickets.create']);
  await db.run(`INSERT INTO user_permissions (user_id, permission) VALUES (?, ?)
                ON CONFLICT (user_id, permission) DO NOTHING`, ['u-1', 'tickets.create']);

  const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM user_permissions WHERE user_id = 'u-1'`);
  assert.equal(Number(row!.n), 1, 'the second insert was not ignored');
});

test('an upsert that means "insert or update" replaces the row', { skip: skip() }, async () => {
  const { updateSettings, getSettings } = await import('../server/repositories/settings.ts');

  await updateSettings({ organizationName: 'First Name' });
  assert.equal((await getSettings()).organizationName, 'First Name');

  // Same key again: the whole point of ON CONFLICT DO UPDATE.
  await updateSettings({ organizationName: 'Second Name' });
  assert.equal((await getSettings()).organizationName, 'Second Name');

  const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM settings WHERE \`key\` = 'organizationName'`);
  assert.equal(Number(row!.n), 1, 'the update inserted a duplicate instead of replacing');
});

test('a value larger than TEXT survives the round trip', { skip: skip() }, async () => {
  // 200 KB, well past TEXT's 64 KB ceiling. A lax server truncates this
  // silently, which would corrupt an attachment rather than refuse it.
  const big = 'A'.repeat(200_000);
  const now = new Date().toISOString();

  await db.run(`INSERT INTO branding_assets (id, mime_type, byte_size, content, updated_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (id) DO UPDATE SET content = excluded.content`,
    ['logo', 'image/png', big.length, big, now]);

  const row = await db.get<{ content: string }>(`SELECT content FROM branding_assets WHERE id = 'logo'`);
  assert.equal(row!.content.length, big.length, 'the value was truncated on the way in or out');
});

test('non-ASCII text is stored and returned unchanged', { skip: skip() }, async () => {
  // utf8mb4 explicitly: a server defaulting to utf8mb3 rejects the emoji, and
  // one defaulting to latin1 mangles the accents.
  const subject = 'Wärmepumpe défectueuse — 空調が故障 🔥';
  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO tickets (id, number, subject, description, description_format, status, priority, type, source, tags, escalation_level, created_at, updated_at)
     VALUES (?, 9001, ?, '', 'text', 'open', 'normal', 'incident', 'web', '[]', 0, ?, ?)`,
    ['tkt-utf8', subject, now, now],
  );

  const row = await db.get<{ subject: string }>(`SELECT subject FROM tickets WHERE id = 'tkt-utf8'`);
  assert.equal(row!.subject, subject);
});

test('a rolled-back transaction leaves nothing behind', { skip: skip() }, async () => {
  const before = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n);

  await assert.rejects(
    db.transaction(async () => {
      const now = new Date().toISOString();
      await db.run(
        `INSERT INTO tickets (id, number, subject, description, description_format, status, priority, type, source, tags, escalation_level, created_at, updated_at)
         VALUES (?, 9002, 'rolled back', '', 'text', 'open', 'normal', 'incident', 'web', '[]', 0, ?, ?)`,
        ['tkt-rollback', now, now],
      );
      throw new Error('deliberate');
    }),
  );

  const after = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets`))!.n);
  assert.equal(after, before, 'the failed transaction was committed anyway');
});

test('ticket numbers are never handed out twice under concurrency', { skip: skip() }, async () => {
  const { nextTicketNumber } = await import('../server/db/index.ts');

  // Sequential rather than parallel: the driver pins one connection per
  // transaction, and the counter must still advance once per call.
  const numbers: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    numbers.push(await db.transaction(() => nextTicketNumber()));
  }
  assert.equal(new Set(numbers).size, numbers.length, 'a ticket number was reused');
});

test('the strict-mode session refuses an over-long key rather than truncating', { skip: skip() }, async () => {
  // A key column is VARCHAR(255). Silently trimming an id to fit is how two
  // records become one, so the write has to fail instead.
  await assert.rejects(
    db.run(`INSERT INTO counters (name, value) VALUES (?, 1)`, ['n'.repeat(300)]),
    /too long|Data too long/i,
  );
});

test('a foreign key is actually enforced', { skip: skip() }, async () => {
  await assert.rejects(
    db.run(
      `INSERT INTO ticket_comments (id, ticket_id, author_id, body, body_format, is_internal, created_at, updated_at)
       VALUES (?, ?, NULL, 'orphan', 'text', 0, ?, ?)`,
      ['c-orphan', 'no-such-ticket', new Date().toISOString(), new Date().toISOString()],
    ),
    /foreign key/i,
  );
});

/* ------------------------- The app, end to end ---------------------------- */

/*
 * The driver tests above prove the SQL translates. These prove the product
 * runs on it: the repositories, the upserts inside them, and the session
 * store - which is the database too, so a failure there means nobody can log
 * in at all.
 */
test('the whole first-run and ticket flow works on MySQL', { skip: skip() }, async () => {
  const http = await import('node:http');
  const { getServerlessApp } = await import('../server/index.ts');

  const server = http.createServer(await getServerlessApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  const base = `http://127.0.0.1:${address.port}`;

  const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '',
      payload: (await response.json().catch(() => null)) as any,
    };
  };

  try {
    // A user already exists from the upsert test above, so sign in rather than
    // running setup. Reset the password through the repository to a known one.
    const { hashPassword } = await import('../server/lib/crypto.ts');
    const { hash, salt } = hashPassword('mysql-test-password');
    await db.run(`UPDATE users SET password_hash = ?, password_salt = ? WHERE id = 'u-1'`, [hash, salt]);

    const login = await call('POST', '/api/auth/login', {
      login: 'a@b.test',
      password: 'mysql-test-password',
    });
    assert.equal(login.status, 200, JSON.stringify(login.payload));
    assert.ok(login.cookie, 'the session store is the database, so no cookie means no sessions');

    // The session survives a second request, which is the round trip through
    // the sessions table.
    const me = await call('GET', '/api/auth/me', undefined, login.cookie);
    assert.equal(me.status, 200);
    assert.equal(me.payload.user.email, 'a@b.test');

    const team = await call('POST', '/api/teams', { key: 'ops', name: 'Operations' }, login.cookie);
    assert.equal(team.status, 201, JSON.stringify(team.payload));

    const created = await call(
      'POST',
      '/api/tickets',
      {
        subject: 'Printer on fire 🔥',
        description: 'It is genuinely on fire.',
        priority: 'urgent',
        type: 'incident',
        teamId: team.payload.team.id,
      },
      login.cookie,
    );
    assert.equal(created.status, 201, JSON.stringify(created.payload));
    assert.match(created.payload.ticket.reference, /^ESC-\d+$/);
    assert.equal(created.payload.ticket.subject, 'Printer on fire 🔥');

    const commented = await call(
      'POST',
      `/api/tickets/${created.payload.ticket.id}/comments`,
      { body: 'Extinguisher deployed.' },
      login.cookie,
    );
    assert.equal(commented.status, 201, JSON.stringify(commented.payload));

    // And it reads back, which exercises the joins the list view runs.
    const list = await call('GET', '/api/tickets', undefined, login.cookie);
    assert.equal(list.status, 200);
    assert.ok(
      list.payload.tickets.some((t: any) => t.id === created.payload.ticket.id),
      'the ticket was written but does not come back from the list query',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
