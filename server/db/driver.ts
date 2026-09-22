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

async function createSqliteDriver(): Promise<DbDriver> {
  // The specifier is built at runtime so serverless bundlers do not try to
  // trace and include this native addon, which they cannot package.
  const specifier = ['better', 'sqlite3'].join('-');
  const { default: Database } = (await import(/* @vite-ignore */ specifier)) as {
    default: new (path: string) => any;
  };
  const database = new Database(dbConfig.sqlitePath);

  // WAL keeps readers from blocking on the writer; FK enforcement is off by default.
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');

  let depth = 0;

  return {
    dialect: 'sqlite',
    async all<T>(sql: string, params: SqlParam[] = []) {
      return database.prepare(sql).all(...params) as T[];
    },
    async get<T>(sql: string, params: SqlParam[] = []) {
      return database.prepare(sql).get(...params) as T | undefined;
    },
    async run(sql: string, params: SqlParam[] = []) {
      database.prepare(sql).run(...params);
    },
    async transaction<T>(fn: () => Promise<T>) {
      // better-sqlite3's own `transaction()` helper is synchronous-only, so we
      // drive the statements manually to support async work inside the block.
      if (depth > 0) return fn();
      depth += 1;
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      } finally {
        depth -= 1;
      }
    },
    async close() {
      database.close();
    },
    describe() {
      return `SQLite (${dbConfig.sqlitePath})`;
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
    : { max: 10 };

  const pool = new Pool(
    dbConfig.connectionString
      ? {
          connectionString: dbConfig.connectionString,
          ssl: dbConfig.ssl,
          ...poolTuning,
        }
      : {
          ...poolTuning,
          host: process.env.PGHOST || 'localhost',
          port: Number(process.env.PGPORT || 5432),
          database: process.env.PGDATABASE || 'escalation_pro',
          user: process.env.PGUSER || 'postgres',
          password: process.env.PGPASSWORD || 'postgres',
          ssl: dbConfig.ssl,
        },
  );

  await pool.query('SELECT 1');

  // Postgres has no ambient connection, so a transaction has to pin one client
  // and route every nested query through it for the duration of the block.
  let txClient: import('pg').PoolClient | null = null;
  const exec = async (sql: string, params: SqlParam[]) => {
    const text = toPositional(sql);
    return txClient ? txClient.query(text, params) : pool.query(text, params);
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
      if (txClient) return fn();
      const client = await pool.connect();
      txClient = client;
      try {
        await client.query('BEGIN');
        const result = await fn();
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        txClient = null;
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
    // Dates and numbers come back as strings otherwise, and every repository
    // here already expects the ISO strings it wrote.
    dateStrings: true,
    // Without this a lost connection surfaces as an unhandled error rather
    // than a rejected query.
    enableKeepAlive: true,
  });

  const [versionRows] = await pool.query('SELECT VERSION() AS version');
  const version = String((versionRows as Array<{ version: string }>)[0]?.version ?? '');
  assertMysqlVersion(version);

  /*
   * Strict mode for this connection pool regardless of how the server is
   * configured. A lax MySQL truncates an over-long value and carries on,
   * which would silently corrupt a ticket rather than refusing it.
   */
  await pool.query(`SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'`);

  let txConnection: Awaited<ReturnType<typeof pool.getConnection>> | null = null;
  const exec = async (sql: string, params: SqlParam[]) => {
    const text = toMysql(sql);
    const target = txConnection ?? pool;
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
      if (txConnection) return fn();
      const connection = await pool.getConnection();
      txConnection = connection;
      try {
        await connection.beginTransaction();
        const result = await fn();
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        txConnection = null;
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
