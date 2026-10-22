import { AsyncLocalStorage } from 'node:async_hooks';
import { assertDatabaseConfigured, dbConfig, IS_SERVERLESS } from '../config.ts';
import { toMysql } from './mysql-dialect.ts';

export type SqlParam = string | number | null | Buffer;

export interface DbDriver {
  readonly dialect: 'sqlite' | 'postgres' | 'mysql';
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  run(sql: string, params?: SqlParam[]): Promise<void>;
  /** Runs `fn` inside a transaction, rolling back if it throws. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Runs `fn` while holding a database-wide named lock, so two instances
   * starting together do not both migrate at once. `fn` uses the driver as
   * normal; the lock lives on a connection of its own.
   */
  withLock<T>(name: string, fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
  describe(): string;
}

/**
 * Queries are authored once using `?` placeholders. Postgres needs `$1..$n`, so
 * we rewrite them here rather than maintaining two copies of every statement.
 * Quoted literals are skipped so a `?` inside a string is left alone.
 */
export function toPositional(sql: string): string {
  let out = '';
  let index = 0;
  let quote: string | null = null;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (quote) {
      out += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      continue;
    }
    if (char === '?') {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += char;
  }
  return out;
}

interface SqliteHandle {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  exec(sql: string): void;
  close(): void;
}

/**
 * Opens the SQLite file with whichever engine is available.
 *
 * better-sqlite3 is a native addon: fast, but it has to be compiled for the
 * exact platform, which a single portable executable cannot carry. Node's own
 * `node:sqlite` needs nothing installed, so it is the fallback - and the only
 * engine the portable build uses. SQLITE_ENGINE=node forces it.
 */
async function openSqlite(file: string): Promise<{ handle: SqliteHandle; engine: string }> {
  if ((process.env.SQLITE_ENGINE || '').toLowerCase() !== 'node') {
    try {
      // The specifier is built at runtime so serverless bundlers do not try to
      // trace and include this native addon, which they cannot package.
      const specifier = ['better', 'sqlite3'].join('-');
      const { default: Database } = (await import(/* @vite-ignore */ specifier)) as {
        default: new (path: string) => SqliteHandle & { pragma(statement: string): unknown };
      };
      const database = new Database(file);
      // WAL keeps readers from blocking on the writer; FK enforcement is off by default.
      database.pragma('journal_mode = WAL');
      database.pragma('foreign_keys = ON');
      database.pragma('busy_timeout = 5000');
      return { handle: database, engine: 'better-sqlite3' };
    } catch (error) {
      if (process.env.SQLITE_ENGINE) throw error;
    }
  }

  const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
    DatabaseSync: new (path: string) => SqliteHandle;
  };
  const database = new DatabaseSync(file);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  return { handle: database, engine: 'node:sqlite' };
}

async function createSqliteDriver(): Promise<DbDriver> {
  const { handle: database, engine } = await openSqlite(dbConfig.sqlitePath);

  /*
   * SQLite has one connection, so an open transaction sees every statement
   * sent while it is open. Transactions therefore take turns, and a write
   * from outside the current transaction waits for it to finish instead of
   * being swept into (and rolled back with) somebody else's work. Reads go
   * straight through; the async context tells a transaction's own
   * statements apart from everyone else's.
   */
  const inTransaction = new AsyncLocalStorage<true>();
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work);
    queue = result.catch(() => undefined);
    return result;
  };
  // Plain reads skip the queue; anything that writes (an UPDATE ... RETURNING
  // through get(), say) waits its turn unless it belongs to the transaction.
  const guarded = <T>(sql: string, work: () => T): T | Promise<T> => {
    if (inTransaction.getStore() || /^\s*(select|with|pragma)\b/i.test(sql)) return work();
    return exclusive(async () => work());
  };

  return {
    dialect: 'sqlite',
    async all<T>(sql: string, params: SqlParam[] = []) {
      return guarded(sql, () => database.prepare(sql).all(...params) as T[]);
    },
    async get<T>(sql: string, params: SqlParam[] = []) {
      return guarded(sql, () => database.prepare(sql).get(...params) as T | undefined);
    },
    async run(sql: string, params: SqlParam[] = []) {
      await guarded('', () => database.prepare(sql).run(...params));
    },
    async transaction<T>(fn: () => Promise<T>) {
      // better-sqlite3's own `transaction()` helper is synchronous-only, so we
      // drive the statements manually to support async work inside the block.
      if (inTransaction.getStore()) return fn();
      return exclusive(() =>
        inTransaction.run(true, async () => {
          database.exec('BEGIN IMMEDIATE');
          try {
            const result = await fn();
            database.exec('COMMIT');
            return result;
          } catch (error) {
            database.exec('ROLLBACK');
            throw error;
          }
        }),
      );
    },
    async withLock<T>(_name: string, fn: () => Promise<T>) {
      // One process owns the file; SQLite's own locking covers the rest.
      return fn();
    },
    async close() {
      database.close();
    },
    describe() {
      return `SQLite (${dbConfig.sqlitePath}, ${engine})`;
    },
  };
}

async function createPostgresDriver(): Promise<DbDriver> {
  const pg = await import('pg');
  const Pool = pg.default?.Pool ?? pg.Pool;

  /**
   * Serverless instances are numerous and short-lived, so each one keeps a
   * single connection and releases it quickly. A large pool per instance is
   * how a managed Postgres runs out of connections.
   */
  const poolTuning = IS_SERVERLESS
    ? { max: 1, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 }
    : { max: 10, connectionTimeoutMillis: 15_000 };

  /**
   * DB_SCHEMA keeps this app's tables in their own Postgres schema, so it can
   * share a database with other applications whose table names overlap
   * (users, sessions, ...). It is sent as a startup parameter, which a session
   * pooler and a direct connection both honour; transaction poolers may not.
   */
  const schema = (process.env.DB_SCHEMA || '').trim();
  if (schema && !/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new Error(`DB_SCHEMA must be a plain identifier, got "${schema}"`);
  }
  const schemaOptions = schema ? { options: `-c search_path=${schema}` } : {};

  const pool = new Pool(
    dbConfig.connectionString
      ? {
          connectionString: dbConfig.connectionString,
          ssl: dbConfig.ssl,
          ...schemaOptions,
          ...poolTuning,
        }
      : {
          ...poolTuning,
          ...schemaOptions,
          host: process.env.PGHOST || 'localhost',
          port: Number(process.env.PGPORT || 5432),
          database: process.env.PGDATABASE || 'escalation_pro',
          user: process.env.PGUSER || 'postgres',
          password: process.env.PGPASSWORD || 'postgres',
          ssl: dbConfig.ssl,
        },
  );

  await pool.query('SELECT 1');
  if (schema) {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    const { rows } = await pool.query('SHOW search_path');
    if (!String(rows[0]?.search_path || '').includes(schema)) {
      throw new Error(
        `DB_SCHEMA is set to "${schema}" but the connection's search_path is "${rows[0]?.search_path}". ` +
          'The pooler is not passing startup options through; use the session pooler (port 5432) or a direct connection.',
      );
    }
  }

  // Postgres has no ambient connection, so a transaction pins one client and
  // every query made from inside the block (its async context, not merely
  // while it is open) goes through that client.
  const txClient = new AsyncLocalStorage<import('pg').PoolClient>();
  const exec = async (sql: string, params: SqlParam[]) => {
    const text = toPositional(sql);
    const client = txClient.getStore();
    return client ? client.query(text, params) : pool.query(text, params);
  };

  return {
    dialect: 'postgres',
    async all<T>(sql: string, params: SqlParam[] = []) {
      const result = await exec(sql, params);
      return result.rows as T[];
    },
    async get<T>(sql: string, params: SqlParam[] = []) {
      const result = await exec(sql, params);
      return result.rows[0] as T | undefined;
    },
    async run(sql: string, params: SqlParam[] = []) {
      await exec(sql, params);
    },
    async transaction<T>(fn: () => Promise<T>) {
      if (txClient.getStore()) return fn();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await txClient.run(client, fn);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async withLock<T>(name: string, fn: () => Promise<T>) {
      const client = await pool.connect();
      const key = `infraticket:${schema || 'public'}:${name}`;
      try {
        await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
        try {
          return await fn();
        } finally {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => undefined);
        }
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
    describe() {
      if (dbConfig.connectionString) {
        return `PostgreSQL (${dbConfig.connectionString.replace(/:[^:@/]+@/, ':****@')})`;
      }
      return `PostgreSQL (${process.env.PGHOST || 'localhost'}/${process.env.PGDATABASE || 'escalation_pro'})`;
    },
  };
}

export async function createDriver(): Promise<DbDriver> {
  assertDatabaseConfigured();

  if (dbConfig.driver === 'mysql') {
    try {
      return await createMysqlDriver();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not connect to MySQL: ${reason}\n` +
          'Check DATABASE_URL / MYSQL_* environment variables, or unset them to use the ' +
          'built-in SQLite database instead.',
      );
    }
  }

  if (dbConfig.driver === 'postgres') {
    try {
      return await createPostgresDriver();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not connect to PostgreSQL: ${reason}\n` +
          'Check DATABASE_URL / PG* environment variables, or unset them to use the ' +
          'built-in SQLite database instead.',
      );
    }
  }
  return createSqliteDriver();
}

/**
 * MySQL 8.0.13+ or MariaDB 10.2+.
 *
 * Older servers reject a DEFAULT on a LONGTEXT column, which several tables
 * here need, and would fail partway through creating the schema. Checked up
 * front so the message names the real problem.
 */
function assertMysqlVersion(version: string): void {
  const mariadb = /mariadb/i.test(version);
  const [major = 0, minor = 0, patch = 0] = (/(\d+)\.(\d+)\.(\d+)/.exec(version) ?? [])
    .slice(1)
    .map(Number);

  const supported = mariadb
    ? major > 10 || (major === 10 && minor >= 2)
    : major > 8 || (major === 8 && (minor > 0 || patch >= 13));

  if (!supported) {
    throw new Error(
      `This server reports ${version}, which is too old. ` +
        'InfraTicket needs MySQL 8.0.13 or newer, or MariaDB 10.2 or newer, because several ' +
        'columns carry a default on a long text column and older servers reject that.',
    );
  }
}

async function createMysqlDriver(): Promise<DbDriver> {
  const mysql = await import('mysql2/promise');

  const pool = mysql.createPool({
    ...(dbConfig.connectionString
      ? { uri: dbConfig.connectionString }
      : {
          host: process.env.MYSQL_HOST || '127.0.0.1',
          port: Number(process.env.MYSQL_PORT || 3306),
          database: process.env.MYSQL_DATABASE || 'infraticket',
          user: process.env.MYSQL_USER || 'infraticket',
          password: process.env.MYSQL_PASSWORD || '',
        }),
    ...(dbConfig.ssl ? { ssl: dbConfig.ssl as object } : {}),
    connectionLimit: IS_SERVERLESS ? 1 : 10,
    connectTimeout: 15_000,
    // Dates and numbers come back as strings otherwise, and every repository
    // here already expects the ISO strings it wrote.
    dateStrings: true,
    // Without this a lost connection surfaces as an unhandled error rather
    // than a rejected query.
    enableKeepAlive: true,
  });

  /*
   * Strict mode on every connection the pool opens, regardless of how the
   * server is configured. A lax MySQL truncates an over-long value and
   * carries on, which would silently corrupt a ticket rather than refusing it.
   */
  pool.on('connection', (connection) => {
    connection.query(`SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'`);
  });

  const [versionRows] = await pool.query('SELECT VERSION() AS version');
  const version = String((versionRows as Array<{ version: string }>)[0]?.version ?? '');
  assertMysqlVersion(version);

  const txConnection = new AsyncLocalStorage<Awaited<ReturnType<typeof pool.getConnection>>>();
  const exec = async (sql: string, params: SqlParam[]) => {
    const text = toMysql(sql);
    const target = txConnection.getStore() ?? pool;
    // `query` rather than `execute`: the prepared-statement cache keys on the
    // SQL text, and DDL cannot be prepared at all.
    const [rows] = await target.query(text, params);
    return rows;
  };

  return {
    dialect: 'mysql',
    async all<T>(sql: string, params: SqlParam[] = []) {
      return (await exec(sql, params)) as T[];
    },
    async get<T>(sql: string, params: SqlParam[] = []) {
      const rows = (await exec(sql, params)) as T[];
      return Array.isArray(rows) ? rows[0] : undefined;
    },
    async run(sql: string, params: SqlParam[] = []) {
      await exec(sql, params);
    },
    async transaction<T>(fn: () => Promise<T>) {
      if (txConnection.getStore()) return fn();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await txConnection.run(connection, fn);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },
    async withLock<T>(name: string, fn: () => Promise<T>) {
      const connection = await pool.getConnection();
      // Lock names are server-wide, so the database name keeps two
      // workspaces on one server from waiting on each other.
      const key = `infraticket:${name}`;
      try {
        const [rows] = await connection.query('SELECT GET_LOCK(CONCAT(?, DATABASE()), 120) AS got', [key]);
        if (Number((rows as Array<{ got: number | null }>)[0]?.got) !== 1) {
          throw new Error(`Timed out waiting for the "${name}" lock; another instance may be stuck migrating.`);
        }
        try {
          return await fn();
        } finally {
          await connection.query('SELECT RELEASE_LOCK(CONCAT(?, DATABASE()))', [key]).catch(() => undefined);
        }
      } finally {
        connection.release();
      }
    },
    async close() {
      await pool.end();
    },
    describe() {
      if (dbConfig.connectionString) {
        return `MySQL (${dbConfig.connectionString.replace(/:[^:@/]+@/, ':****@')})`;
      }
      return `MySQL (${process.env.MYSQL_HOST || '127.0.0.1'}/${process.env.MYSQL_DATABASE || 'infraticket'})`;
    },
  };
}
