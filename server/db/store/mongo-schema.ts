import type { Db } from 'mongodb';
import { INDEXES, TABLES } from '../schema.ts';

/**
 * Mongo's indexes, derived from the SQL schema rather than listed again.
 *
 * Two copies of this list would drift the first time somebody adds a column
 * with a UNIQUE constraint, and the failure would be silent: Mongo would
 * accept the duplicate row that SQL refuses. `mysql-dialect.ts` already reads
 * the DDL the same way, so parsing it is the established habit here.
 */

export interface IndexPlan {
  collection: string;
  keys: Record<string, 1>;
  unique: boolean;
  name: string;
}

const CREATE_TABLE = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*)\)\s*$/i;
const CREATE_INDEX = /CREATE\s+(UNIQUE\s+)?INDEX IF NOT EXISTS\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)/i;

/** Splits a column list on commas that are not inside parentheses. */
function splitColumns(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function columnNames(list: string): string[] {
  return list
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

/** Every unique constraint the SQL schema declares, column-level and table-level. */
export function uniqueConstraintsOf(tableDdl: string): { collection: string; columns: string[][] } | null {
  const match = CREATE_TABLE.exec(tableDdl.trim());
  if (!match) return null;
  const [, collection, body] = match;
  const columns: string[][] = [];

  for (const definition of splitColumns(body)) {
    const tableLevel = /^UNIQUE\s*\(([^)]*)\)/i.exec(definition);
    if (tableLevel) {
      columns.push(columnNames(tableLevel[1]));
      continue;
    }
    // A column-level UNIQUE, e.g. `email TEXT NOT NULL UNIQUE`. PRIMARY KEY is
    // skipped: it is already carried by `_id`.
    if (/\bUNIQUE\b/i.test(definition) && !/^PRIMARY KEY/i.test(definition)) {
      const name = /^(\w+)/.exec(definition)?.[1];
      if (name) columns.push([name]);
    }
  }

  return { collection, columns };
}

export function buildIndexPlan(): IndexPlan[] {
  const plans: IndexPlan[] = [];

  for (const ddl of TABLES) {
    const parsed = uniqueConstraintsOf(ddl);
    if (!parsed) continue;
    for (const columns of parsed.columns) {
      plans.push({
        collection: parsed.collection,
        keys: Object.fromEntries(columns.map((column) => [column, 1])) as Record<string, 1>,
        unique: true,
        name: `uniq_${parsed.collection}_${columns.join('_')}`,
      });
    }
  }

  for (const ddl of INDEXES) {
    const match = CREATE_INDEX.exec(ddl);
    if (!match) continue;
    const [, unique, name, collection, list] = match;
    plans.push({
      collection,
      keys: Object.fromEntries(columnNames(list).map((column) => [column, 1])) as Record<string, 1>,
      unique: Boolean(unique),
      name,
    });
  }

  return plans;
}

/**
 * Creating an index is idempotent unless the options differ, which is what
 * happens when one is redefined: Mongo then rejects it by name rather than
 * replacing it. Dropping and recreating would be worse on a live database, so
 * the conflict is reported and the rest carry on.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  for (const plan of buildIndexPlan()) {
    try {
      await db.collection(plan.collection).createIndex(plan.keys, { unique: plan.unique, name: plan.name });
    } catch (error) {
      console.warn(`[db] could not create index ${plan.name}: ${(error as Error).message}`);
    }
  }
}

/**
 * The column defaults the SQL schema declares.
 *
 * SQL fills in a DEFAULT for any column an INSERT leaves out. Mongo has no
 * schema and simply stores the document as given, so the same insert would
 * read back `status: 'active'` on one backend and `undefined` on the other -
 * and the difference would not show up until some repository branched on the
 * missing value. Applying them here keeps the two shapes identical.
 *
 * Only absent fields are filled. An explicit null is left alone, because that
 * is a caller saying something different from "I did not mention this".
 */
const DEFAULT_CLAUSE = /^(\w+)\s+\w+(?:\([^)]*\))?[\s\S]*?\bDEFAULT\s+('(?:[^']|'')*'|-?\d+(?:\.\d+)?)/i;

export function defaultsOf(tableDdl: string): { collection: string; defaults: Record<string, string | number> } | null {
  const match = CREATE_TABLE.exec(tableDdl.trim());
  if (!match) return null;
  const [, collection, body] = match;
  const defaults: Record<string, string | number> = {};

  for (const definition of splitColumns(body)) {
    if (/^(PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK)\b/i.test(definition)) continue;
    const found = DEFAULT_CLAUSE.exec(definition);
    if (!found) continue;
    const [, column, literal] = found;
    defaults[column] = literal.startsWith("'")
      ? literal.slice(1, -1).replace(/''/g, "'")
      : Number(literal);
  }

  return { collection, defaults };
}

let cached: Record<string, Record<string, string | number>> | null = null;

export function collectionDefaults(): Record<string, Record<string, string | number>> {
  if (cached) return cached;
  cached = {};
  for (const ddl of TABLES) {
    const parsed = defaultsOf(ddl);
    if (parsed && Object.keys(parsed.defaults).length) cached[parsed.collection] = parsed.defaults;
  }
  return cached;
}

/** Fills in the defaults a SQL INSERT would have applied. */
export function withDefaults(collection: string, doc: Record<string, unknown>): Record<string, unknown> {
  const defaults = collectionDefaults()[collection];
  if (!defaults) return doc;

  const out = { ...doc };
  for (const [field, value] of Object.entries(defaults)) {
    if (out[field] === undefined) out[field] = value;
  }
  return out;
}
