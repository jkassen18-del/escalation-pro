import { badRequest } from './http.ts';

/**
 * Checks that an operator-supplied lookup query is a single read.
 *
 * Connections are opened with a read-only user and every query runs inside a
 * read-only transaction, so this is the third layer rather than the only one.
 * It exists because the first two depend on the remote server being
 * configured as expected, and this one does not - a typo that grants the app
 * a writable account should still not let a stored query mutate anything.
 */

/** Anything that writes, changes structure, or reaches outside the query. */
const FORBIDDEN = [
  'insert', 'update', 'delete', 'merge', 'upsert', 'replace',
  'drop', 'create', 'alter', 'truncate', 'rename', 'comment',
  'grant', 'revoke', 'commit', 'rollback', 'savepoint', 'begin', 'start',
  'call', 'do', 'execute', 'prepare', 'deallocate', 'set', 'reset', 'lock', 'unlock',
  'copy', 'load', 'outfile', 'dumpfile', 'into', 'vacuum', 'analyze', 'reindex',
  'listen', 'notify', 'discard', 'cluster', 'refresh', 'import', 'attach', 'detach',
  'pg_read_file', 'pg_ls_dir', 'lo_import', 'lo_export', 'dblink', 'pg_sleep', 'sleep',
  'benchmark', 'load_file', 'sys_exec', 'xp_cmdshell',
];

/**
 * Removes string literals, quoted identifiers and comments.
 *
 * Keyword checks run against this rather than the raw text, so a row
 * containing the word "update" inside a literal is not mistaken for a
 * statement, and a comment cannot hide one.
 */
export function stripLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];

    /*
     * Comments become a space, not nothing.
     *
     * That is what the engines themselves do - a comment separates tokens -
     * so `SEL/**\u002a/ECT` reads as two words here exactly as it would there,
     * and fails the leading-SELECT check instead of being silently glued back
     * into a keyword.
     */
    if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      out += ' ';
      continue;
    }
    if (char === '#') {
      // MySQL's other line-comment marker.
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      out += ' ';
      continue;
    }
    if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          // A doubled quote is an escaped one, not the end of the literal.
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }

    out += char;
    i += 1;
  }
  return out;
}

export interface LookupQueryCheck {
  /** The query with its trailing semicolon removed, ready to wrap. */
  sql: string;
}

export function assertReadOnlyQuery(raw: string): LookupQueryCheck {
  const trimmed = String(raw ?? '').trim().replace(/;+\s*$/, '');
  if (!trimmed) throw badRequest('The lookup query cannot be empty.', { query: 'Required' });
  if (trimmed.length > 4000) throw badRequest('That query is too long.', { query: 'Too long' });

  const bare = stripLiteralsAndComments(trimmed).toLowerCase();

  // One statement only: a second one is how a read turns into a write.
  if (bare.includes(';')) {
    throw badRequest('The lookup query must be a single statement.', { query: 'Multiple statements' });
  }

  if (!/^\s*(select|with)\b/.test(bare)) {
    throw badRequest('The lookup query must start with SELECT.', { query: 'Not a SELECT' });
  }

  for (const word of FORBIDDEN) {
    // Word boundaries, so "created_at" does not trip the "create" check.
    if (new RegExp(`\\b${word}\\b`).test(bare)) {
      throw badRequest(`The lookup query cannot use "${word.toUpperCase()}".`, { query: `Contains ${word}` });
    }
  }

  return { sql: trimmed };
}

/** The placeholder operators write in their query for the typed search term. */
export const SEARCH_TOKEN = ':search';

export function assertHasSearchToken(sql: string): void {
  if (!sql.includes(SEARCH_TOKEN)) {
    throw badRequest(`The lookup query must include ${SEARCH_TOKEN} where the typed text should go.`, {
      query: 'Missing :search',
    });
  }
}

/**
 * Swaps the placeholder for the driver's own parameter marker.
 *
 * The value is always bound, never interpolated, so what someone types in the
 * lookup box is data to the remote server and can never become SQL.
 */
export function bindSearchToken(
  sql: string,
  dialect: 'postgres' | 'mysql',
): { text: string; count: number } {
  let count = 0;
  const text = sql.split(SEARCH_TOKEN).reduce((accumulator, part, index) => {
    if (index === 0) return part;
    count += 1;
    return accumulator + (dialect === 'postgres' ? `$${count}` : '?') + part;
  }, '');
  return { text, count };
}
