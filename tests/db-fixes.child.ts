/**
 * Run by db-fixes.test.ts in a child process, one per database engine:
 * config.ts reads the connection settings once at import, so each engine
 * needs a fresh process. Prints RESULT:<json> for the parent to check.
 */
const { initDatabase, db, nextTicketNumber } = await import('../server/db/index.ts');
const { createDriver } = await import('../server/db/driver.ts');
const { migrate } = await import('../server/db/schema.ts');

const result: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Two instances starting together: the migration lock makes them take turns.
const [first, second] = await Promise.all([createDriver(), createDriver()]);
await Promise.all([migrate(first), migrate(second)]);
await first.close();
await second.close();
result.concurrentMigrate = 'ok';

await initDatabase();
await db.run(`DELETE FROM counters WHERE name LIKE 'probe-%'`);

// A transaction that fails must not take a concurrent request's work with it,
// and that request's own transaction must not be swept into it.
const failing = db
  .transaction(async () => {
    await db.run(`INSERT INTO counters (name, value) VALUES ('probe-a', 1)`);
    await sleep(150);
    throw new Error('roll me back');
  })
  .catch(() => 'rolled back');
await sleep(30);
const committed = db.transaction(async () => {
  await db.run(`INSERT INTO counters (name, value) VALUES ('probe-b', 1)`);
});
const outside = db.run(`INSERT INTO counters (name, value) VALUES ('probe-c', 1)`);
await Promise.all([failing, committed, outside]);
const probes = await db.all<{ name: string }>(`SELECT name FROM counters WHERE name LIKE 'probe-%' ORDER BY name`);
result.probes = probes.map((row) => row.name);

// Ticket numbers handed out in parallel, inside and outside transactions.
const numbers = await Promise.all(
  Array.from({ length: 40 }, (_, i) => (i % 2 ? db.transaction(() => nextTicketNumber()) : nextTicketNumber())),
);
result.numbers = numbers.length;
result.uniqueNumbers = new Set(numbers).size;

// Searching by a ticket number (CAST(... AS TEXT) used to break MySQL).
const now = new Date().toISOString();
const past = new Date(Date.now() - 3_600_000).toISOString();
const number = await nextTicketNumber();
await db.run(`DELETE FROM tickets WHERE id LIKE 'fix-%'`);
await db.run(
  `INSERT INTO tickets (id, number, subject, due_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)`,
  ['fix-1', number, 'Overdue printer', past, now, now],
);
const { listTickets } = await import('../server/repositories/tickets.ts');
const found = await listTickets({ search: `ESC-${number}` }, 'ESC');
result.searchByNumber = found.tickets.map((ticket) => ticket.id);

// SLA breaches are announced once, survive a "restart", and re-arm when the
// due date moves.
const { checkBreaches } = await import('../server/jobs/sla-monitor.ts');
result.slaFirst = await checkBreaches();
result.slaSecond = await checkBreaches();
await db.run(`UPDATE tickets SET due_at = ? WHERE id = 'fix-1'`, [new Date(Date.now() - 60_000).toISOString()]);
result.slaAfterNewDueDate = await checkBreaches();

await db.close();
console.log('RESULT:' + JSON.stringify(result));
process.exit(0);
