/**
 * What MySQL needs that SQLite and Postgres do not.
 *
 * The schema and every query in this app are written once, portably, against
 * SQLite and Postgres. MySQL disagrees with both in four ways that cannot be
 * papered over at the call site without forking every statement:
 *
 *  1. A TEXT column cannot be indexed without a prefix length, so anything
 *     that is a key has to be a VARCHAR.
 *  2. A TEXT column cannot carry a plain DEFAULT.
 *  3. TEXT tops out at 64 KB, silently in a lax server, which would truncate
 *     an attachment or a logo.
 *  4. There is no ON CONFLICT; the equivalent is ON DUPLICATE KEY UPDATE.
 *
 * All four are handled here, by translating the portable SQL on its way to
 * the server, so the rest of the codebase never learns that MySQL exists.
 */

/**
 * Applies `fn` to the stretches of SQL that are not inside a string literal.
 *
 * Every rewrite below has to skip literals: a JSON default like '{}' or a
 * value containing the word `key` is data, not syntax, and rewriting it would
 * corrupt what gets stored.
 */
export function outsideLiterals(sql: string, fn: (fragment: string) => string): string {
  let out = '';
  let buffer = '';
  let quote: string | null = null;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];

    if (quote) {
      out += char;
      // Doubled quotes are an escaped quote, not the end of the literal.
      if (char === quote && sql[i + 1] === quote) {
        out += sql[i + 1];
        i += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"') {
      out += fn(buffer);
      buffer = '';
      out += char;
      quote = char;
      continue;
    }

    buffer += char;
  }

  return out + fn(buffer);
}

/**
 * `key` is a reserved word in MySQL and is a column name in three tables here.
 *
 * Matched lower-case and on word boundaries, so the SQL keywords PRIMARY KEY
 * and FOREIGN KEY are untouched (this codebase writes keywords upper-case),
 * and so are `field_key` and `external_key` - an underscore is a word
 * character, so there is no boundary in front of their `key`.
 *
 * Idempotent, because DDL is translated once when it is built and again on its
 * way through the driver, and a doubly-quoted ``key`` is a syntax error.
 */
function quoteReserved(sql: string): string {
  return outsideLiterals(sql, (fragment) => fragment.replace(/(?<!`)\bkey\b(?!`)/g, '`key`'));
}

/* -------------------------------- DDL ------------------------------------ */

/** Long enough for every key this app stores, short enough to index. */
const KEY_VARCHAR = 'VARCHAR(255)';

/**
 * ISO-8601 UTC is 24 characters; the margin is for offsets and nothing more.
 *
 * Timestamps are promoted out of LONGTEXT whether or not they are indexed
 * today. The schema states as an invariant that every `_at` column holds an
 * ISO-8601 string, so the length is known rather than guessed - and sorting a
 * LONGTEXT means a filesort MySQL can never use an index for, which is
 * precisely what a ticket list ordered by `updated_at` does on every page.
 */
const TIMESTAMP_VARCHAR = 'VARCHAR(40)';

function isTimestamp(column: string): boolean {
  return /_at$/.test(column);
}

/**
 * Column names that take part in a key somewhere, per table.
 *
 * Derived from the DDL and the index list rather than hand-listed, so adding
 * an index later cannot leave a TEXT column behind that MySQL then refuses to
 * index.
 */
export function keyColumnsOf(tableDdl: string, indexes: string[]): Set<string> {
  const keys = new Set<string>();
  const table = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(tableDdl)?.[1];
  if (!table) return keys;

  const body = stripComments(tableDdl);

  // Inline: `col TEXT ... PRIMARY KEY`, `... UNIQUE`, `... REFERENCES x(y)`.
  for (const line of body.split('\n')) {
    const column = /^\s*(\w+)\s+(TEXT|INTEGER)\b/i.exec(line)?.[1];
    if (!column) continue;
    if (/\b(PRIMARY KEY|UNIQUE|REFERENCES)\b/i.test(line)) keys.add(column);
  }

  // Table-level: `PRIMARY KEY (a, b)` and `UNIQUE (a, b)`.
  for (const match of body.matchAll(/\b(?:PRIMARY KEY|UNIQUE)\s*\(([^)]*)\)/gi)) {
    for (const part of match[1].split(',')) keys.add(part.trim());
  }

  // Anything an index is built on.
  for (const index of indexes) {
    const on = new RegExp(`\\bON ${table}\\s*\\(([^)]*)\\)`, 'i').exec(index);
    if (!on) continue;
    for (const part of on[1].split(',')) keys.add(part.trim());
  }

  keys.delete('');
  return keys;
}

/** Block and line comments, which the column scan would otherwise misread. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

/**
 * Rewrites one portable CREATE TABLE for MySQL.
 *
 * Key columns become VARCHAR so they can be indexed. Everything else becomes
 * LONGTEXT: attachment content and logos are base64 and would not fit in
 * TEXT, and guessing a length per column is how a column silently truncates
 * two years later. A DEFAULT on a LONGTEXT has to be parenthesised, which is
 * MySQL 8.0.13 and MariaDB 10.2 upwards.
 */
export function tableToMysql(tableDdl: string, indexes: string[]): string {
  const keys = keyColumnsOf(tableDdl, indexes);

  const converted = tableDdl.replace(
    /^(\s*)(\w+)(\s+)TEXT\b/gim,
    (_match, indent: string, column: string, gap: string) =>
      `${indent}${column}${gap}${mysqlTypeFor(column, keys)}`,
  );

  const defaulted = parenthesiseLongDefaults(converted);

  /*
   * utf8mb4 explicitly rather than by server default: a server still defaulting
   * to latin1 would mangle any non-ASCII a person types, and one defaulting to
   * utf8mb3 would reject emoji outright.
   */
  return `${quoteReserved(defaulted)} ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}

/** What one portable TEXT column becomes. */
function mysqlTypeFor(column: string, keys: Set<string>): string {
  if (keys.has(column)) return KEY_VARCHAR;
  if (isTimestamp(column)) return TIMESTAMP_VARCHAR;
  // Everything else is free-form: a ticket body, a base64 attachment, a JSON
  // blob. Guessing a length for those is how a column silently truncates two
  // years later, so they all get the largest type.
  return 'LONGTEXT';
}

/**
 * A DEFAULT on a long text column has to be an expression in MySQL, so the
 * literal is wrapped in parentheses. A VARCHAR takes a plain default and is
 * left alone, which reads better and is what most of these columns are.
 */
function parenthesiseLongDefaults(ddl: string): string {
  return ddl.replace(
    /\bLONGTEXT([^,\n]*?)\bDEFAULT\s+('(?:[^']|'')*')/gi,
    (_match, middle: string, literal: string) => `LONGTEXT${middle}DEFAULT (${literal})`,
  );
}

/**
 * One ALTER TABLE ... ADD COLUMN, translated the same way the CREATE TABLE
 * path translates its columns.
 *
 * A column added later is never a key - an index on it would be a separate
 * statement - so it always becomes LONGTEXT, matching what CREATE TABLE would
 * have produced had the column been there from the start.
 */
export function addColumnToMysql(table: string, column: string, definition: string): string {
  const typed = definition.replace(/^TEXT\b/i, mysqlTypeFor(column, new Set()));
  return quoteReserved(`ALTER TABLE ${table} ADD COLUMN ${column} ${parenthesiseLongDefaults(typed)}`);
}

/**
 * MySQL has no CREATE INDEX IF NOT EXISTS, so the name is returned for the
 * caller to check against information_schema first.
 */
export function indexToMysql(indexDdl: string): { name: string; table: string; sql: string } | null {
  const parsed = /CREATE INDEX IF NOT EXISTS (\w+) ON (\w+)\s*\(([^)]*)\)/i.exec(indexDdl);
  if (!parsed) return null;
  const [, name, table, columns] = parsed;
  return { name, table, sql: quoteReserved(`CREATE INDEX ${name} ON ${table} (${columns})`) };
}

/* ------------------------------- Queries ---------------------------------- */

/**
 * Translates the two ON CONFLICT shapes this codebase uses.
 *
 * `DO NOTHING` becomes INSERT IGNORE. `DO UPDATE SET x = excluded.y` becomes
 * ON DUPLICATE KEY UPDATE x = VALUES(y) - which MySQL 8.0.20 marks deprecated
 * in favour of a row alias, but still honours, and which MariaDB has no
 * alternative to.
 *
 * The conflict target is dropped because MySQL has no way to express it: it
 * reacts to whichever unique key was violated. Every use here names the
 * table's only unique key, so the two mean the same thing.
 */
export function rewriteUpsert(sql: string): string {
  const conflict = /\bON CONFLICT\s*\([^)]*\)\s*DO\s+(NOTHING|UPDATE SET)/i.exec(sql);
  if (!conflict) return sql;

  if (conflict[1].toUpperCase() === 'NOTHING') {
    return sql.slice(0, conflict.index).replace(/\bINSERT\s+INTO\b/i, 'INSERT IGNORE INTO').trimEnd();
  }

  const assignments = sql
    .slice(conflict.index + conflict[0].length)
    .replace(/\bexcluded\.(\w+)/gi, 'VALUES($1)');

  return `${sql.slice(0, conflict.index)}ON DUPLICATE KEY UPDATE${assignments}`;
}

/** Everything a statement needs on its way to MySQL. */
export function toMysql(sql: string): string {
  return quoteReserved(rewriteUpsert(sql));
}
