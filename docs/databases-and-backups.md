# Databases and backups

*Operations → Databases* (permission `backups.manage`, administrators by default) watches the databases you run and backs them up on a schedule, encrypted.

[Open Databases](/databases)

## Supported engines

| Engine | Backup made with | Restore with |
| --- | --- | --- |
| PostgreSQL | `pg_dump --format=custom` | `pg_restore -d <db> file.pgdump` |
| Supabase | The same, over the **direct** connection (port 5432, not the pooler on 6543) | `pg_restore` |
| MySQL / MariaDB | `mysqldump --single-transaction --routines --triggers` | `mysql <db> < file.sql` |
| MongoDB | `mongodump --archive` | `mongorestore --archive=file.archive` |
| SQLite | Online backup (`VACUUM INTO`), no tools needed | Replace the file |
| SQL Server | `BACKUP DATABASE … WITH COPY_ONLY` via `sqlcmd` | `RESTORE DATABASE` |

The dump tools must be installed on the InfraTicket server, or placed in a folder named by `BACKUP_TOOLS_DIR`. `pg_dump` must be at least the server's major version. SQL Server writes the backup on its own host; set `SQLSERVER_BACKUP_DIR` to a folder both machines can reach.

## Adding a database

**Add database**:

1. **Name**, **Engine** and **Team** (the team is paged if backups stop).
2. **Connection** (or **File path** for SQLite). Examples:

```text
postgres://backup:password@db.internal:5432/app
postgresql://postgres:password@db.<project>.supabase.co:5432/postgres
mysql://backup:password@db.internal:3306/app
mongodb://backup:password@mongo.internal:27017/app?authSource=admin
/var/lib/app/app.db          (or C:\data\app.db)
Server=sql.internal,1433;Database=App;User Id=backup;Password=password
```

   The connection is stored encrypted and never shown again. **Test** connects and reports health.
3. **Schedule**: *Hourly* (`0 * * * *`), *Nightly* (`0 1 * * *`), *Weekly* (`0 2 * * 0`) or *Custom* cron. Cron is in **UTC** (South Africa is UTC+2, so 03:30 SAST is `30 1 * * *`).
4. **Keep**: how many daily, weekly and monthly backups to keep (7 / 4 / 12 by default). The newest backup is always kept.
5. **Store backups in**: *This server* (a folder; blank means the `backups` folder inside the data folder) or *S3-compatible storage* (**Endpoint**, **Region**, **Bucket**, **Prefix**, **Access key ID**, **Secret access key**). AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO and Backblaze B2 all work.
6. **Run on schedule** on, and save.

### Use a read-only account

```sql
-- PostgreSQL 14+
CREATE ROLE infraticket_backup LOGIN PASSWORD '…';
GRANT pg_read_all_data TO infraticket_backup;

-- MySQL
CREATE USER 'infraticket_backup'@'%' IDENTIFIED BY '…';
GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT, PROCESS ON *.* TO 'infraticket_backup'@'%';
```

## How a backup runs

dump → gzip → AES-256-GCM encryption → local folder or S3 → SHA-256 recorded.

- Each backup has its own random key, wrapped with the server's `SECRET_KEY`. The bucket on its own reveals nothing, and a tampered or truncated file is rejected on restore.
- A dump running longer than `BACKUP_TIMEOUT_MINS` (120 by default) is stopped and reported as failed.
- **Back up now** starts a backup immediately.

## Heartbeats and alerts

Every backup job gets a heartbeat monitor. A successful run pings it, a failed run reports a failure, and a job that silently stops misses its ping. All three page the job's team. Failing backups also show on the [Command centre](command-centre.md).

## Restoring

**Download** on a backup run (permission `backups.restore`) returns the dump **decrypted and decompressed**, ready for the restore tool in the table above (`.pgdump`, `.sql`, `.archive`, `.sqlite` or `.bak`). Each download is recorded in the audit log.

```bash
pg_restore --clean --if-exists -d billing billing.pgdump
mysql billing < billing.sql
mongorestore --archive=billing.archive
```

Treat a downloaded file like the production data it is.

> **Warning** `SECRET_KEY` (or, without it, the `.session-secret` file in the data folder) is the key to every backup. Store a copy somewhere other than the backups themselves. Lose it and the backups cannot be decrypted.

## Health checks

A [Database health monitor](monitoring.md#database-health) can watch any of these connectors: connection time, connections, size and replication lag.
