# Developing

```bash
npm install
npm run dev          # http://localhost:3000, SQLite, no other services needed
npm run typecheck
npm test
```

## Tests

`npm test` runs Node's own test runner over `tests/*.test.ts`. Everything needed
for the default run is in-process: the app is driven over real HTTP against a
throwaway SQLite file.

Two suites reach outside and **skip themselves** when what they need is absent,
so a plain `npm test` is always green:

| Suite | Needs | Without it |
| --- | --- | --- |
| `dropdown-colours.test.ts` | a Chromium binary | skipped |
| `data-sources.test.ts` | a local Postgres and MySQL/MariaDB | those cases skip |
| `mysql-driver.test.ts` | a MySQL/MariaDB at `MYSQL_TEST_URL` | the whole file skips |
| `store-conformance.test.ts` | a MongoDB at `MONGODB_TEST_URI` | the MongoDB cases skip |

A skipped suite is reported as `# skipped`, never as a pass — if you are
changing either area, start the dependency and confirm the count goes up.

### Chromium

The dropdown test asserts computed styles on `<option>` elements, because a
native popup is drawn by the platform and cannot be screenshotted. It looks for
a browser at `$CHROMIUM_PATH` first, then the usual Playwright locations.

```bash
CHROMIUM_PATH=/path/to/chrome npm test
```

### MySQL for the driver tests

`mysql-driver.test.ts` runs the schema and the real API against a live server,
because everything it checks is enforced by MySQL and not by this code: that a
key column is a type MySQL will index, that a 200 KB attachment is not
truncated at TEXT's 64 KB, that `ON CONFLICT` was translated into something
MySQL understands, and that a second startup does not trip over the missing
`CREATE INDEX IF NOT EXISTS`.

It looks for `MYSQL_TEST_URL`, defaulting to
`mysql://ticket_app:app-pass@127.0.0.1:33307/infraticket_test`, and **drops
every table in that database on each run** — point it at a scratch database,
never a real one.

```sql
CREATE DATABASE infraticket_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'ticket_app'@'localhost' IDENTIFIED BY 'app-pass';
GRANT ALL ON infraticket_test.* TO 'ticket_app'@'localhost';
```

Grant for `localhost` as well as `%`, for the same reason the data-source
tests need it: a connection to `127.0.0.1` is matched as `localhost`.

### Every backend for the store conformance tests

`store-conformance.test.ts` is the one suite that decides whether MongoDB is
really interchangeable with the SQL engines. It holds a single set of
assertions and replays them against each backend, because testing them
separately and hoping they agree is how the two quietly diverge.

`dbConfig` resolves once at import, so one run can only exercise one SQL
engine. `npm test` covers SQLite. To prove the others:

```bash
# MariaDB, the same server the driver tests use
STORE_TEST_URL='mysql://ticket_app:app-pass@127.0.0.1:33307/infraticket_test' \
  node --test --test-force-exit tests/store-conformance.test.ts

# Postgres
STORE_TEST_URL='postgres://lookup_rw:pass@127.0.0.1:55433/infraticket_test' \
  node --test --test-force-exit tests/store-conformance.test.ts

# MongoDB, alongside whichever SQL engine is selected
MONGODB_TEST_URI='mongodb+srv://user:pass@cluster.mongodb.net' \
  node --test --test-force-exit tests/store-conformance.test.ts
```

The MongoDB run **drops its database first**, so point `MONGODB_TEST_DATABASE`
(default `infraticket_conformance`) at something disposable, never at the
database the app uses.

MongoDB also needs a replica set, because the app relies on transactions to
keep a ticket and its events consistent and a standalone `mongod` accepts
every write individually while silently dropping that guarantee. Atlas is
always a replica set. Locally:

```bash
mongod --replSet rs0 --dbpath /var/lib/mongo
mongosh --eval 'rs.initiate()'
```

The app refuses to start against a standalone server rather than running
without the atomicity it assumes.

### Postgres and MySQL for the data-source tests

`data-sources.test.ts` exercises the external-database lookups against real
servers, because the things worth testing — a read-only transaction refusing a
write, a bound parameter refusing to become SQL — are enforced by the database,
not by this code. A mock would assert nothing.

It expects a Postgres on `127.0.0.1:55433` and a MySQL/MariaDB on
`127.0.0.1:33307`, each with a `crm` database, a `customers` table
(`id`, `name`, `region`) holding a few rows, and a `lookup_ro` / `ro-pass`
account with `SELECT` on it and nothing more.

Postgres must require a password over TCP (`scram-sha-256` in `pg_hba.conf`),
not `trust` — otherwise the "a bad credential is reported" case passes against
a server that would have accepted anything.

For MySQL/MariaDB, grant `lookup_ro` for `localhost` as well as `%`: a
connection to `127.0.0.1` is matched as `localhost`, so a `%`-only grant is
refused.

## Deployment

See `DEPLOY.md`. `SECURITY.md` covers the trust boundaries, which is worth
reading before touching authentication, rich text, or the data-source lookups.
