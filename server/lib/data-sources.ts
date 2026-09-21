import { db } from '../db/index.ts';
import { decryptSecret, encryptSecret, randomId } from './crypto.ts';
import { badRequest } from './http.ts';
import { assertHasSearchToken, assertReadOnlyQuery, bindSearchToken } from './sql-guard.ts';
import { DATA_SOURCE_ENGINES, type DataSourceEngine, type DataSourceSummary } from '../../shared/types.ts';

/**
 * Read-only connections to databases the company already runs.
 *
 * Three independent things keep this read-only, because any one of them can
 * be got wrong by whoever sets it up:
 *
 *  1. The credentials are expected to be a read-only account. That is the
 *     operator's job and this code cannot verify it.
 *  2. Every query runs inside a read-only transaction, so the server itself
 *     rejects a write even if the account could perform one.
 *  3. The stored query is checked to be a single SELECT before it is ever
 *     sent (see sql-guard).
 *
 * Unlike outbound webhooks, private and internal hosts are allowed here: a
 * company's own customer database is almost always on a private network, and
 * refusing those addresses would refuse the entire feature. What is not
 * allowed is a query that can do anything but read, or a search term that
 * becomes SQL.
 */

/** Bounds on every lookup, so a bad query cannot stall a request or flood it. */
const QUERY_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 5000;
const MAX_ROWS = 50;

interface DataSourceRow {
  id: string;
  name: string;
  engine: string;
  host: string;
  port: number | string;
  database_name: string;
  username: string;
  password_encrypted: string | null;
  use_tls: number | string;
  lookup_query: string;
  value_column: string;
  label_column: string;
  status: string;
  status_message: string | null;
  last_tested_at: string | null;
}

function mapSource(row: DataSourceRow): DataSourceSummary {
  return {
    id: row.id,
    name: row.name,
    engine: row.engine as DataSourceEngine,
    host: row.host,
    port: Number(row.port),
    database: row.database_name,
    username: row.username,
    hasPassword: Boolean(row.password_encrypted),
    useTls: Number(row.use_tls) === 1,
    lookupQuery: row.lookup_query,
    valueColumn: row.value_column,
    labelColumn: row.label_column,
    status: (row.status as DataSourceSummary['status']) ?? 'unknown',
    statusMessage: row.status_message,
    lastTestedAt: row.last_tested_at,
  };
}

export async function listDataSources(): Promise<DataSourceSummary[]> {
  const rows = await db.all<DataSourceRow>(`SELECT * FROM data_sources ORDER BY name`);
  return rows.map(mapSource);
}

export async function findDataSource(id: string): Promise<DataSourceSummary | null> {
  const row = await db.get<DataSourceRow>(`SELECT * FROM data_sources WHERE id = ?`, [id]);
  return row ? mapSource(row) : null;
}

async function passwordFor(id: string): Promise<string> {
  const row = await db.get<{ password_encrypted: string | null }>(
    `SELECT password_encrypted FROM data_sources WHERE id = ?`,
    [id],
  );
  if (!row?.password_encrypted) return '';
  return decryptSecret(row.password_encrypted);
}

export interface DataSourceInput {
  name: string;
  engine: DataSourceEngine;
  host: string;
  port: number;
  database: string;
  username: string;
  /** Omitted on an edit means "keep the stored one". */
  password?: string;
  useTls: boolean;
  lookupQuery: string;
  valueColumn: string;
  labelColumn: string;
}

/** Column names are identifiers, so they can never be bound as parameters. */
function assertIdentifier(value: string, field: string): string {
  const trimmed = String(value ?? '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(trimmed)) {
    throw badRequest(`${field} must be a plain column name.`, { [field]: 'Invalid column name' });
  }
  return trimmed;
}

export function validateInput(input: Partial<DataSourceInput>): DataSourceInput {
  const name = String(input.name ?? '').trim();
  if (!name) throw badRequest('Give this connection a name.', { name: 'Required' });
  if (!DATA_SOURCE_ENGINES.includes(input.engine as DataSourceEngine)) {
    throw badRequest('Choose Postgres or MySQL.', { engine: 'Unsupported' });
  }
  const host = String(input.host ?? '').trim();
  if (!host) throw badRequest('A host is required.', { host: 'Required' });
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw badRequest('The port must be between 1 and 65535.', { port: 'Invalid' });
  }
  const database = String(input.database ?? '').trim();
  if (!database) throw badRequest('A database name is required.', { database: 'Required' });

  const { sql } = assertReadOnlyQuery(String(input.lookupQuery ?? ''));
  assertHasSearchToken(sql);

  return {
    name: name.slice(0, 120),
    engine: input.engine as DataSourceEngine,
    host: host.slice(0, 255),
    port,
    database: database.slice(0, 120),
    username: String(input.username ?? '').trim().slice(0, 120),
    password: input.password,
    useTls: input.useTls !== false,
    lookupQuery: sql,
    valueColumn: assertIdentifier(input.valueColumn ?? 'id', 'Value column'),
    labelColumn: assertIdentifier(input.labelColumn ?? 'name', 'Label column'),
  };
}

export async function saveDataSource(id: string | null, input: DataSourceInput): Promise<DataSourceSummary> {
  const now = new Date().toISOString();

  if (id) {
    const existing = await findDataSource(id);
    if (!existing) throw badRequest('That connection no longer exists.');
    // An absent password means "leave the stored one alone", so an edit does
    // not require retyping a secret the person may not have.
    const encrypted = input.password ? encryptSecret(input.password) : undefined;
    await db.run(
      `UPDATE data_sources SET name = ?, engine = ?, host = ?, port = ?, database_name = ?, username = ?,
         ${encrypted !== undefined ? 'password_encrypted = ?,' : ''} use_tls = ?, lookup_query = ?,
         value_column = ?, label_column = ?, status = 'unknown', status_message = NULL, updated_at = ?
       WHERE id = ?`,
      [
        input.name,
        input.engine,
        input.host,
        input.port,
        input.database,
        input.username,
        ...(encrypted !== undefined ? [encrypted] : []),
        input.useTls ? 1 : 0,
        input.lookupQuery,
        input.valueColumn,
        input.labelColumn,
        now,
        id,
      ],
    );
    return (await findDataSource(id))!;
  }

  const newId = randomId();
  await db.run(
    `INSERT INTO data_sources (id, name, engine, host, port, database_name, username, password_encrypted,
       use_tls, lookup_query, value_column, label_column, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`,
    [
      newId,
      input.name,
      input.engine,
      input.host,
      input.port,
      input.database,
      input.username,
      input.password ? encryptSecret(input.password) : null,
      input.useTls ? 1 : 0,
      input.lookupQuery,
      input.valueColumn,
      input.labelColumn,
      now,
      now,
    ],
  );
  return (await findDataSource(newId))!;
}

export async function removeDataSource(id: string): Promise<void> {
  await db.run(`DELETE FROM data_sources WHERE id = ?`, [id]);
  // Fields pointing at it fall back to being plain text rather than breaking.
  await db.run(`UPDATE team_form_fields SET type = 'text', data_source_id = NULL WHERE data_source_id = ?`, [id]);
}

export async function recordStatus(id: string, status: 'ok' | 'error', message: string | null): Promise<void> {
  await db.run(`UPDATE data_sources SET status = ?, status_message = ?, last_tested_at = ? WHERE id = ?`, [
    status,
    message?.slice(0, 500) ?? null,
    new Date().toISOString(),
    id,
  ]);
}

/* ----------------------------- execution --------------------------------- */

export interface LookupRow {
  value: string;
  label: string;
}

/**
 * Runs a source's lookup query for a typed search term.
 *
 * The term is always bound as a parameter. The query runs inside a read-only
 * transaction and under a statement timeout, and the result set is capped -
 * so a mistyped query costs one slow request, not the process.
 */
export async function runLookup(source: DataSourceSummary, search: string): Promise<LookupRow[]> {
  // Re-checked at execution time, not only when it was saved: the stored row
  // is the thing being run, and it is what an attacker with database access
  // would have tampered with.
  const { sql } = assertReadOnlyQuery(source.lookupQuery);
  const password = await passwordFor(source.id);
  const term = String(search ?? '').slice(0, 200);

  return source.engine === 'postgres'
    ? runPostgresLookup(source, sql, term, password)
    : runMysqlLookup(source, sql, term, password);
}

function toRows(raw: Array<Record<string, unknown>>, source: DataSourceSummary): LookupRow[] {
  return raw.slice(0, MAX_ROWS).map((row) => {
    const value = row[source.valueColumn] ?? row[source.labelColumn] ?? '';
    const label = row[source.labelColumn] ?? row[source.valueColumn] ?? '';
    return { value: String(value), label: String(label) };
  });
}

async function runPostgresLookup(
  source: DataSourceSummary,
  sql: string,
  term: string,
  password: string,
): Promise<LookupRow[]> {
  const pg = await import('pg');
  const Client = pg.default?.Client ?? pg.Client;
  const client = new Client({
    host: source.host,
    port: source.port,
    database: source.database,
    user: source.username,
    password,
    // Managed providers terminate TLS with their own CA, so encrypt without
    // demanding a chain the server has no way to know about.
    ssl: source.useTls ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  });

  await client.connect();
  try {
    // The transaction is what makes a write impossible regardless of what the
    // account is allowed to do.
    await client.query('BEGIN READ ONLY');
    const bound = bindSearchToken(sql, 'postgres');
    const result = await client.query(
      `SELECT * FROM (${bound.text}) AS lookup LIMIT ${MAX_ROWS}`,
      Array.from({ length: bound.count }, () => term),
    );
    await client.query('ROLLBACK');
    return toRows(result.rows as Array<Record<string, unknown>>, source);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function runMysqlLookup(
  source: DataSourceSummary,
  sql: string,
  term: string,
  password: string,
): Promise<LookupRow[]> {
  const mysql = await import('mysql2/promise');
  const connection = await mysql.createConnection({
    host: source.host,
    port: source.port,
    database: source.database,
    user: source.username,
    password,
    ssl: source.useTls ? { rejectUnauthorized: false } : undefined,
    connectTimeout: CONNECT_TIMEOUT_MS,
    // Stacked statements are refused by the protocol itself unless this is on,
    // and it is off by default. Stated explicitly so it stays that way.
    multipleStatements: false,
  });

  try {
    await connection.query('SET SESSION TRANSACTION READ ONLY');

    /*
     * MySQL and MariaDB spell the statement timeout differently and each
     * rejects the other's name outright, so both are tried. Best-effort: a
     * server with neither still has the connect timeout and the row cap, and
     * failing the lookup over a missing tuning knob would help nobody.
     */
    for (const statement of [
      `SET SESSION max_execution_time = ${QUERY_TIMEOUT_MS}`,
      `SET SESSION max_statement_time = ${QUERY_TIMEOUT_MS / 1000}`,
    ]) {
      try {
        await connection.query(statement);
        break;
      } catch {
        // Not this dialect's spelling; try the other.
      }
    }

    await connection.beginTransaction();
    const bound = bindSearchToken(sql, 'mysql');
    const [rows] = await connection.execute(
      `SELECT * FROM (${bound.text}) AS lookup LIMIT ${MAX_ROWS}`,
      Array.from({ length: bound.count }, () => term),
    );
    await connection.rollback();
    return toRows(rows as Array<Record<string, unknown>>, source);
  } finally {
    await connection.end().catch(() => undefined);
  }
}

/** Connects and runs the query once, to report whether the setup works. */
export async function testDataSource(source: DataSourceSummary): Promise<{ ok: boolean; message: string; sample: LookupRow[] }> {
  try {
    const sample = await runLookup(source, '');
    const message = `Connected. The query returned ${sample.length} row(s) for an empty search.`;
    await recordStatus(source.id, 'ok', message);
    return { ok: true, message, sample: sample.slice(0, 5) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await recordStatus(source.id, 'error', message);
    return { ok: false, message, sample: [] };
  }
}

