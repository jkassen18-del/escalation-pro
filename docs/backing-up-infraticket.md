# Backing up InfraTicket itself

The [Databases](databases-and-backups.md) feature backs up *your* databases. This page is about InfraTicket's own data: tickets, users, settings, integrations and attachments.

## What to keep

| Item | Where | Why |
| --- | --- | --- |
| The database | SQLite: `DATA_DIR/<SQLITE_FILE>`. PostgreSQL or MySQL: your database server | Everything except attachment files |
| Attachments | `UPLOADS_DIR` (default `DATA_DIR/uploads`), or inside the database when `ATTACHMENT_STORE=database` | Uploaded files and screenshots |
| The secret | `SECRET_KEY`, or the `.session-secret` file in `DATA_DIR` if `SECRET_KEY` is unset | Decrypts every stored credential, push key and backup |
| Your `.env` / compose file | Wherever you deploy | Configuration |

> **Warning** Keep the secret **separately** from the database backups. A database backup without the secret loses every integration credential; a secret stored next to the backups makes stolen backups readable.

## SQLite

The database may be in use, so do not copy the file while the app runs (recent writes may still be in its write-ahead log). Use SQLite's online backup instead:

```bash
sqlite3 data/escalation-pro.db "VACUUM INTO '/backups/infraticket-$(date +%F).db'"
tar czf /backups/uploads-$(date +%F).tgz -C data uploads
```

As a nightly cron job with a [heartbeat](monitoring.md#heartbeats) so you hear when it stops:

```bash
15 1 * * * sqlite3 /opt/infraticket/data/escalation-pro.db "VACUUM INTO '/backups/it-$(date +\%F).db'" \
  && curl -fsS https://tickets.example.com/api/heartbeat/<token>
```

Or let InfraTicket back itself up: *Databases → Add database*, engine **SQLite**, file path of its own database file. The backup is encrypted with `SECRET_KEY`, so keep a copy of the key elsewhere.

### Portable exe

`InfraTicket.exe export my-workspace.zip` writes a consistent snapshot of the database (taken with `VACUUM INTO`, safe while the app runs) plus `uploads/` into one zip. Without a file name it goes to `InfraTicket-data\exports\infraticket-workspace-<time>.zip`. The zip does **not** include `.session-secret`; copy that from `InfraTicket-data\` yourself. See [Portable exe](portable.md#moving-a-tested-workspace).

## PostgreSQL

```bash
pg_dump --format=custom --file=/backups/infraticket-$(date +%F).pgdump "$DATABASE_URL"
# restore into an empty database
pg_restore --no-owner -d "$NEW_DATABASE_URL" /backups/infraticket-2026-10-22.pgdump
```

Managed providers (Supabase, Render, RDS) also keep their own point-in-time backups.

## MySQL / MariaDB

```bash
mysqldump --single-transaction --routines --triggers infraticket > /backups/infraticket-$(date +%F).sql
mysql infraticket < /backups/infraticket-2026-10-22.sql
```

## Docker

The `app_data` volume holds `DATA_DIR` (SQLite, uploads, `.session-secret`), and `postgres_data` the bundled PostgreSQL:

```bash
docker compose exec postgres pg_dump -U escalation -Fc escalation_pro > infraticket.pgdump
docker run --rm -v escalation-pro_app_data:/data -v "$PWD":/out alpine tar czf /out/app_data.tgz -C /data .
```

(The volume name is prefixed with your compose project name; `docker volume ls` shows it.)

## Testing a restore

A backup you have never restored is a hope. At least once a quarter, restore into a scratch install (the portable exe is ideal), start it with the same `SECRET_KEY`, sign in, open a ticket with an attachment, and press **Test** on one integration.
