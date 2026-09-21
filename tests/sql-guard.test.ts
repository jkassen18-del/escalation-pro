/**
 * The lookup-query guard.
 *
 * It is the third layer under a read-only database user and a read-only
 * transaction, and it exists precisely because those two depend on the remote
 * server being set up as intended. Its job is to make a stored query unable
 * to do anything but read, even against an over-privileged account.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertHasSearchToken,
  assertReadOnlyQuery,
  bindSearchToken,
  stripLiteralsAndComments,
} from '../server/lib/sql-guard.ts';

function refuses(sql: string, note: string) {
  assert.throws(() => assertReadOnlyQuery(sql), /./, `accepted: ${note}`);
}

test('accepts ordinary read queries', () => {
  for (const sql of [
    'SELECT id, name FROM customers WHERE name ILIKE :search LIMIT 20',
    'select c.id, c.name from customers c join tiers t on t.id = c.tier_id where c.name like :search',
    'WITH recent AS (SELECT * FROM orders) SELECT id FROM recent WHERE ref = :search',
    "SELECT id, name FROM customers WHERE region = 'EU' AND name LIKE :search",
  ]) {
    assert.doesNotThrow(() => assertReadOnlyQuery(sql), sql);
  }
});

test('refuses anything that is not a read', () => {
  refuses('UPDATE customers SET name = :search', 'update');
  refuses('DELETE FROM customers WHERE id = :search', 'delete');
  refuses('INSERT INTO customers (name) VALUES (:search)', 'insert');
  refuses('DROP TABLE customers', 'drop');
  refuses('TRUNCATE customers', 'truncate');
  refuses('GRANT ALL ON customers TO PUBLIC', 'grant');
});

test('refuses a second statement, however it is hidden', () => {
  refuses('SELECT 1; DROP TABLE customers', 'stacked statement');
  refuses('SELECT 1;DELETE FROM customers', 'stacked without space');
  refuses('SELECT 1; -- harmless\nDROP TABLE customers', 'stacked after a comment');
  refuses('SELECT 1 /* comment */; UPDATE customers SET x = 1', 'stacked after a block comment');
});

test('refuses statements disguised by comments', () => {
  refuses('SELECT id FROM t WHERE x = :search -- \n; DROP TABLE t', 'comment then statement');
  refuses('/* SELECT */ DELETE FROM customers', 'leading comment hiding the real verb');
  refuses('SEL/**/ECT 1', 'split keyword is not a SELECT');
});

test('refuses file and command access', () => {
  refuses("SELECT pg_read_file('/etc/passwd')", 'pg_read_file');
  refuses("SELECT load_file('/etc/passwd')", 'load_file');
  refuses("SELECT * FROM customers INTO OUTFILE '/tmp/x'", 'into outfile');
  refuses("COPY customers TO '/tmp/x'", 'copy');
  refuses("SELECT dblink('host=evil', 'select 1')", 'dblink');
});

test('refuses time-based probing', () => {
  refuses('SELECT pg_sleep(10)', 'pg_sleep');
  refuses('SELECT benchmark(10000000, md5(1))', 'benchmark');
});

test('a literal that merely contains a keyword is still fine', () => {
  // The point of stripping literals: this is a legitimate query.
  assert.doesNotThrow(() =>
    assertReadOnlyQuery("SELECT id FROM audit WHERE action = 'update' AND actor LIKE :search"),
  );
  assert.doesNotThrow(() => assertReadOnlyQuery('SELECT created_at, updated_at FROM t WHERE k = :search'));
});

test('strips literals, quoted identifiers and comments', () => {
  const stripped = stripLiteralsAndComments(`SELECT "drop", 'delete' -- update\nFROM t /* insert */ WHERE x = 1`);
  assert.doesNotMatch(stripped, /drop|delete|update|insert/i);
  assert.match(stripped, /SELECT/);
  assert.match(stripped, /FROM t/);
});

test('handles escaped quotes without losing track of the literal', () => {
  // A naive scanner ends the literal at the doubled quote and then reads the
  // rest as SQL, which is how an injected statement slips past.
  const stripped = stripLiteralsAndComments("SELECT 'it''s; DROP TABLE t' FROM x");
  assert.doesNotMatch(stripped, /drop/i);
  assert.doesNotMatch(stripped, /;/, 'the semicolon was inside the literal');
  assert.doesNotThrow(() => assertReadOnlyQuery("SELECT 'it''s fine' FROM x WHERE k = :search"));
});

test('requires the search placeholder', () => {
  assert.throws(() => assertHasSearchToken('SELECT id FROM t'), /:search/);
  assert.doesNotThrow(() => assertHasSearchToken('SELECT id FROM t WHERE k = :search'));
});

test('binds the search term rather than interpolating it', () => {
  const pg = bindSearchToken('SELECT id FROM t WHERE a = :search OR b = :search', 'postgres');
  assert.equal(pg.text, 'SELECT id FROM t WHERE a = $1 OR b = $2');
  assert.equal(pg.count, 2);

  const mysql = bindSearchToken('SELECT id FROM t WHERE a = :search OR b = :search', 'mysql');
  assert.equal(mysql.text, 'SELECT id FROM t WHERE a = ? OR b = ?');
  assert.equal(mysql.count, 2);
});

test('trailing semicolons are accepted and removed', () => {
  assert.equal(assertReadOnlyQuery('SELECT id FROM t WHERE k = :search;').sql, 'SELECT id FROM t WHERE k = :search');
  assert.equal(assertReadOnlyQuery('SELECT 1;  ').sql, 'SELECT 1');
});

test('refuses an empty or oversized query', () => {
  refuses('', 'empty');
  refuses('   ', 'whitespace only');
  refuses(`SELECT ${'x'.repeat(4100)}`, 'oversized');
});
