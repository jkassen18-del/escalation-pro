import type { DbDriver, SqlParam } from '../driver.ts';
import {
  keyFor,
  type Comparison,
  type Document,
  type Filter,
  type FindOptions,
  type Patch,
  type Scalar,
  type Store,
} from './types.ts';

/**
 * The Store, implemented by generating SQL for the existing driver.
 *
 * Statements are written in SQLite/Postgres spelling with `?` placeholders,
 * exactly as the hand-written queries are: the driver already rewrites those
 * into `$n` for Postgres and into MySQL's dialect on the way out, so this
 * file does not need to know which engine is underneath.
 */

/**
 * Field and collection names reach here from our own code, never from a
 * request body - but they are interpolated rather than bound, so they are
 * checked anyway. A typo becomes a clear error instead of a syntax error from
 * the server, and the one route that ever passes a caller-supplied field name
 * cannot turn it into SQL.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`"${name}" is not a valid column or table name.`);
  return name;
}

function isComparison(value: unknown): value is Comparison {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Where {
  sql: string;
  params: SqlParam[];
}

/** Renders one field's comparison, e.g. `status IN (?, ?)`. */
function renderComparison(field: string, comparison: Comparison): Where {
  const column = ident(field);
  const clauses: string[] = [];
  const params: SqlParam[] = [];

  for (const [operator, value] of Object.entries(comparison)) {
    switch (operator) {
      case '$eq':
        // A null equality test has to become IS NULL: `= NULL` is never true.
        if (value === null) clauses.push(`${column} IS NULL`);
        else {
          clauses.push(`${column} = ?`);
          params.push(value as SqlParam);
        }
        break;
      case '$ne':
        if (value === null) clauses.push(`${column} IS NOT NULL`);
        else {
          /*
           * `<> ?` alone drops rows where the column is NULL, because NULL
           * compares as unknown rather than as different. Mongo's $ne does
           * return those rows, so the SQL has to ask for them explicitly.
           */
          clauses.push(`(${column} IS NULL OR ${column} <> ?)`);
          params.push(value as SqlParam);
        }
        break;
      case '$in':
      case '$nin': {
        const values = value as Scalar[];
        const negated = operator === '$nin';
        if (!values.length) {
          // An empty set matches nothing, or everything when negated. Left as
          // a literal because `IN ()` is a syntax error on every engine.
          clauses.push(negated ? '1 = 1' : '1 = 0');
          break;
        }
        const holes = values.map(() => '?').join(', ');
        clauses.push(negated ? `(${column} IS NULL OR ${column} NOT IN (${holes}))` : `${column} IN (${holes})`);
        params.push(...(values as SqlParam[]));
        break;
      }
      case '$lt':
      case '$lte':
      case '$gt':
      case '$gte': {
        const sign = { $lt: '<', $lte: '<=', $gt: '>', $gte: '>=' }[operator];
        clauses.push(`${column} ${sign} ?`);
        params.push(value as SqlParam);
        break;
      }
      case '$like':
        clauses.push(`${column} LIKE ?`);
        params.push(value as SqlParam);
        break;
      case '$null':
        clauses.push(value ? `${column} IS NULL` : `${column} IS NOT NULL`);
        break;
      default:
        throw new Error(`Unsupported filter operator "${operator}" on "${field}".`);
    }
  }

  if (!clauses.length) return { sql: '1 = 1', params: [] };
  return { sql: clauses.length === 1 ? clauses[0] : `(${clauses.join(' AND ')})`, params };
}

export function buildWhere(filter: Filter = {}): Where {
  const clauses: string[] = [];
  const params: SqlParam[] = [];

  for (const [field, value] of Object.entries(filter)) {
    if (value === undefined) continue;

    if (field === '$or' || field === '$and') {
      const branches = (value as Filter[]).map(buildWhere).filter((branch) => branch.sql);
      if (!branches.length) continue;
      const joiner = field === '$or' ? ' OR ' : ' AND ';
      clauses.push(`(${branches.map((branch) => branch.sql).join(joiner)})`);
      branches.forEach((branch) => params.push(...branch.params));
      continue;
    }

    const rendered = isComparison(value)
      ? renderComparison(field, value as Comparison)
      : renderComparison(field, { $eq: value as Scalar });
    clauses.push(rendered.sql);
    params.push(...rendered.params);
  }

  return { sql: clauses.join(' AND '), params };
}

function orderBy(options: FindOptions): string {
  if (!options.sort?.length) return '';
  const terms = options.sort.map(([field, direction]) => `${ident(field)} ${direction === 'desc' ? 'DESC' : 'ASC'}`);
  return ` ORDER BY ${terms.join(', ')}`;
}

/**
 * OFFSET without LIMIT is a syntax error on MySQL and SQLite, so a skip with
 * no limit gets the largest limit the engines all accept.
 */
function limitOffset(options: FindOptions): { sql: string; params: SqlParam[] } {
  const params: SqlParam[] = [];
  let sql = '';
  if (options.limit !== undefined || options.skip !== undefined) {
    sql += ' LIMIT ?';
    params.push(options.limit ?? Number.MAX_SAFE_INTEGER);
  }
  if (options.skip !== undefined) {
    sql += ' OFFSET ?';
    params.push(options.skip);
  }
  return { sql, params };
}

export function createSqlStore(driver: DbDriver): Store {
  const where = (filter?: Filter) => {
    const built = buildWhere(filter);
    return { clause: built.sql ? ` WHERE ${built.sql}` : '', params: built.params };
  };

  return {
    kind: 'sql',

    async find<T>(collection: string, filter: Filter = {}, options: FindOptions = {}) {
      const columns = options.project?.length ? options.project.map(ident).join(', ') : '*';
      const { clause, params } = where(filter);
      const page = limitOffset(options);
      const sql = `SELECT ${columns} FROM ${ident(collection)}${clause}${orderBy(options)}${page.sql}`;
      return driver.all<T>(sql, [...params, ...page.params]);
    },

    async findOne<T>(collection: string, filter: Filter = {}, options: FindOptions = {}) {
      const rows = await this.find<T>(collection, filter, { ...options, limit: 1 });
      return rows[0];
    },

    async count(collection: string, filter: Filter = {}) {
      const { clause, params } = where(filter);
      const row = await driver.get<{ total: number }>(
        `SELECT COUNT(*) AS total FROM ${ident(collection)}${clause}`,
        params,
      );
      return Number(row?.total ?? 0);
    },

    async insert(collection: string, doc: Document) {
      const fields = Object.keys(doc).map(ident);
      await driver.run(
        `INSERT INTO ${ident(collection)} (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
        Object.values(doc) as SqlParam[],
      );
    },

    async insertIfAbsent(collection: string, doc: Document) {
      const fields = Object.keys(doc).map(ident);
      const key = keyFor(collection).map(ident);
      await driver.run(
        `INSERT INTO ${ident(collection)} (${fields.join(', ')}) ` +
          `VALUES (${fields.map(() => '?').join(', ')}) ` +
          `ON CONFLICT (${key.join(', ')}) DO NOTHING`,
        Object.values(doc) as SqlParam[],
      );
    },

    async replace(collection: string, doc: Document) {
      const fields = Object.keys(doc).map(ident);
      const key = keyFor(collection).map(ident);
      // The key columns are what identified the row; rewriting them to the
      // values they already hold is noise, so only the rest are assigned.
      const assignments = fields.filter((field) => !key.includes(field)).map((field) => `${field} = excluded.${field}`);

      if (!assignments.length) {
        await this.insertIfAbsent(collection, doc);
        return;
      }

      await driver.run(
        `INSERT INTO ${ident(collection)} (${fields.join(', ')}) ` +
          `VALUES (${fields.map(() => '?').join(', ')}) ` +
          `ON CONFLICT (${key.join(', ')}) DO UPDATE SET ${assignments.join(', ')}`,
        Object.values(doc) as SqlParam[],
      );
    },

    async update(collection: string, filter: Filter, patch: Patch) {
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (!entries.length) return 0;
      const { clause, params } = where(filter);
      const assignments = entries.map(([field]) => `${ident(field)} = ?`).join(', ');
      return driver.runWithCount(`UPDATE ${ident(collection)} SET ${assignments}${clause}`, [
        ...(entries.map(([, value]) => value) as SqlParam[]),
        ...params,
      ]);
    },

    async remove(collection: string, filter: Filter) {
      const { clause, params } = where(filter);
      return driver.runWithCount(`DELETE FROM ${ident(collection)}${clause}`, params);
    },

    transaction<T>(fn: () => Promise<T>) {
      return driver.transaction(fn);
    },

    close() {
      return driver.close();
    },

    describe() {
      return driver.describe();
    },
  };
}
