import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import type { BackupEngine, DatabaseHealth } from '../../shared/ops.ts';

/**
 * Health of a customer database, for database monitors and the connector
 * wizard's "Test" button.
 *
 * Postgres, Supabase and MySQL are queried with the drivers the app already
 * ships. MongoDB and SQL Server have no driver in the bundle, so they use the
 * vendor CLI when it is installed and fall back to proving the port answers.
 */
const TIMEOUT_MS = 8000;

export function toolPath(tool: string): string {
  const dir = process.env.BACKUP_TOOLS_DIR;
  if (!dir) return tool;
  const candidate = `${dir.replace(/[\\/]$/, '')}/${tool}${process.platform === 'win32' ? '.exe' : ''}`;
  return fs.existsSync(candidate) ? candidate : tool;
}

export function runTool(
  tool: string,
  args: string[],
  { timeoutMs = TIMEOUT_MS, env }: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      toolPath(tool),
      args,
      { timeout: timeoutMs, env: { ...process.env, ...env }, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
          reject(
            new Error(
              missing
                ? `${tool} is not installed. Install the database's client tools, or point BACKUP_TOOLS_DIR at a folder containing ${tool}.`
                : (stderr || error.message).trim().split('\n').slice(-3).join(' '),
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function tcpReachable(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, timeout: TIMEOUT_MS });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`No answer from ${host}:${port} within ${TIMEOUT_MS / 1000}s`));
    });
    socket.once('error', reject);
  });
}

/** Hides the password in a connection string, for display and logs. */
export function maskConnection(connection: string): string {
  try {
    const url = new URL(connection);
    if (url.password) url.password = '****';
    return `${url.protocol}//${url.username ? `${url.username}${url.password ? ':****' : ''}@` : ''}${url.host}${url.pathname}`;
  } catch {
    return connection.replace(/(password|pwd)=[^;]*/gi, '$1=****');
  }
}

async function postgresHealth(connection: string): Promise<DatabaseHealth> {
  const pg = await import('pg');
  const Client = pg.default?.Client ?? pg.Client;
  const ssl = /sslmode=(require|verify)/.test(connection) || /supabase\.(co|com)/.test(connection) ? { rejectUnauthorized: false } : undefined;
  const client = new Client({
    connectionString: connection.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, ''),
    ssl,
    connectionTimeoutMillis: TIMEOUT_MS,
    statement_timeout: TIMEOUT_MS,
  });
  const started = Date.now();
  await client.connect();
  try {
    await client.query('SELECT 1');
    const latencyMs = Date.now() - started;
    const { rows } = await client.query(`
      SELECT current_setting('server_version') AS version,
             (SELECT COUNT(*) FROM pg_stat_activity) AS connections,
             pg_database_size(current_database()) AS size_bytes,
             CASE WHEN pg_is_in_recovery()
                  THEN EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp()) END AS replication_lag_secs,
             (SELECT COUNT(*) FROM pg_stat_activity
               WHERE state = 'active' AND now() - query_start > interval '5 minutes') AS long_running_queries`);
    const row = rows[0] ?? {};
    return {
      ok: true,
      latencyMs,
      message: `Connected in ${latencyMs} ms`,
      details: {
        version: row.version ?? null,
        connections: Number(row.connections ?? 0),
        sizeBytes: Number(row.size_bytes ?? 0),
        replicationLagSecs: row.replication_lag_secs === null ? null : Number(row.replication_lag_secs),
        longRunningQueries: Number(row.long_running_queries ?? 0),
      },
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function mysqlHealth(connection: string): Promise<DatabaseHealth> {
  const mysql = await import('mysql2/promise');
  const started = Date.now();
  const conn = await mysql.createConnection({ uri: connection, connectTimeout: TIMEOUT_MS });
  try {
    await conn.query('SELECT 1');
    const latencyMs = Date.now() - started;
    const [versionRows] = await conn.query('SELECT VERSION() AS version');
    const [threadRows] = await conn.query(`SHOW STATUS LIKE 'Threads_connected'`);
    const details: DatabaseHealth['details'] = {
      version: (versionRows as Array<{ version: string }>)[0]?.version ?? null,
      threadsConnected: Number((threadRows as Array<{ Value: string }>)[0]?.Value ?? 0),
    };
    try {
      const [replica] = await conn.query('SHOW REPLICA STATUS');
      const status = (replica as Array<Record<string, unknown>>)[0];
      if (status) details.replicationLagSecs = status.Seconds_Behind_Source === null ? null : Number(status.Seconds_Behind_Source);
    } catch {
      // Needs REPLICATION CLIENT; not worth failing the check over.
    }
    return { ok: true, latencyMs, message: `Connected in ${latencyMs} ms`, details };
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function sqliteHealth(file: string): Promise<DatabaseHealth> {
  if (!fs.existsSync(file)) return { ok: false, latencyMs: null, message: `${file} does not exist`, details: {} };
  const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
      prepare(sql: string): { get(): Record<string, unknown> };
      close(): void;
    };
  };
  const started = Date.now();
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const result = database.prepare('PRAGMA quick_check').get();
    const latencyMs = Date.now() - started;
    const verdict = String(Object.values(result)[0] ?? '');
    return {
      ok: verdict === 'ok',
      latencyMs,
      message: verdict === 'ok' ? `Integrity check passed in ${latencyMs} ms` : `Integrity check: ${verdict}`,
      details: { sizeBytes: fs.statSync(file).size },
    };
  } finally {
    database.close();
  }
}

function hostPortOf(connection: string, defaultPort: number): { host: string; port: number } {
  try {
    const url = new URL(connection.replace(/^mongodb\+srv:/, 'mongodb:'));
    return { host: url.hostname, port: Number(url.port || defaultPort) };
  } catch {
    const server = /(?:server|data source)=([^;,]+)(?:,(\d+))?/i.exec(connection);
    return { host: server?.[1] ?? 'localhost', port: Number(server?.[2] ?? defaultPort) };
  }
}

async function mongoHealth(connection: string): Promise<DatabaseHealth> {
  const started = Date.now();
  try {
    const { stdout } = await runTool('mongosh', [connection, '--quiet', '--eval', 'JSON.stringify(db.runCommand({ping:1}))']);
    const latencyMs = Date.now() - started;
    const ok = /"ok":\s*1/.test(stdout);
    return { ok, latencyMs, message: ok ? `Ping answered in ${latencyMs} ms` : stdout.trim(), details: {} };
  } catch (error) {
    if (!/not installed/.test((error as Error).message)) throw error;
    const { host, port } = hostPortOf(connection, 27017);
    await tcpReachable(host, port);
    const latencyMs = Date.now() - started;
    return { ok: true, latencyMs, message: `Port ${port} answers (install mongosh for a full check)`, details: {} };
  }
}

/** `sqlcmd` arguments from "Server=host,1433;Database=x;User Id=u;Password=p". */
export function sqlcmdArgs(connection: string): string[] {
  const parts = Object.fromEntries(
    connection
      .split(';')
      .map((pair) => pair.split('='))
      .filter((pair) => pair.length >= 2)
      .map(([key, ...value]) => [key.trim().toLowerCase(), value.join('=').trim()]),
  );
  const args = ['-S', parts.server || parts['data source'] || 'localhost', '-b'];
  if (parts.database || parts['initial catalog']) args.push('-d', parts.database || parts['initial catalog']);
  if (parts['user id'] || parts.uid) args.push('-U', parts['user id'] || parts.uid, '-P', parts.password || parts.pwd || '');
  else args.push('-E');
  return args;
}

async function sqlServerHealth(connection: string): Promise<DatabaseHealth> {
  const started = Date.now();
  try {
    await runTool('sqlcmd', [...sqlcmdArgs(connection), '-Q', 'SET NOCOUNT ON; SELECT 1']);
    const latencyMs = Date.now() - started;
    return { ok: true, latencyMs, message: `Query answered in ${latencyMs} ms`, details: {} };
  } catch (error) {
    if (!/not installed/.test((error as Error).message)) throw error;
    const { host, port } = hostPortOf(connection, 1433);
    await tcpReachable(host, port);
    const latencyMs = Date.now() - started;
    return { ok: true, latencyMs, message: `Port ${port} answers (install sqlcmd for a full check)`, details: {} };
  }
}

export async function checkDatabaseHealth(engine: BackupEngine, connection: string): Promise<DatabaseHealth> {
  try {
    switch (engine) {
      case 'postgres':
      case 'supabase':
        return await postgresHealth(connection);
      case 'mysql':
        return await mysqlHealth(connection);
      case 'sqlite':
        return await sqliteHealth(connection);
      case 'mongodb':
        return await mongoHealth(connection);
      case 'sqlserver':
        return await sqlServerHealth(connection);
    }
  } catch (error) {
    return { ok: false, latencyMs: null, message: error instanceof Error ? error.message : String(error), details: {} };
  }
}
