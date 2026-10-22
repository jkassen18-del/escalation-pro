# Environment variables

Every variable is optional. With none set, InfraTicket runs on an embedded SQLite database in `data/`, on port 3000. Set them in the environment, in a `.env` file in the working directory, in `docker-compose.yml`, or in your platform's settings. `.env.example` in the repository lists the common ones.

Integration credentials (Slack, Teams, Linear, Discord, SMTP, Twilio) are **not** environment variables: they are entered in the app and stored encrypted.

> **Warning** For the portable exe, `PORT`, `HOST`, `DATA_DIR`, `SQLITE_FILE`, `SQLITE_ENGINE`, `UPLOADS_DIR`, `EXPORTS_DIR`, `CLIENT_DIST` and `NODE_ENV` are decided before the `.env` file is read, so setting them in `.env` beside the exe has no effect. Use `--port`, or set them in the shell or system environment. See [Portable exe](portable.md#options).

## Server

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` (portable: `8080`) | Port to listen on |
| `HOST` | `0.0.0.0` (portable: `127.0.0.1`) | Address to bind. `127.0.0.1` means this machine only |
| `APP_URL` | empty | Public address, e.g. `https://tickets.example.com`. Used when *Settings → Public URL* is empty |
| `NODE_ENV` | (portable: `production`) | `production` serves the built client; anything else runs the Vite dev server |
| `CLIENT_DIST` | `dist/client` | Folder of the built web client |

## Database

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | empty (SQLite) | `postgresql://…` or `mysql://…` / `mariadb://…`. The engine follows the scheme |
| `DB_DRIVER` | inferred | Force `sqlite`, `postgres`, `mysql` or `mariadb` |
| `DB_SCHEMA` | empty | PostgreSQL schema for this app's tables, created if missing. Needs a session pooler or direct connection |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | `localhost`, `5432`, `escalation_pro`, `postgres`, `postgres` | PostgreSQL without a URL. Setting `PGHOST` or `PGDATABASE` selects PostgreSQL |
| `PGSSLMODE` | from the URL | `disable` turns TLS off; anything else encrypts |
| `PGSSLROOTCERT` | empty | CA certificate (file path or PEM) to verify the server's certificate |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD` | `127.0.0.1`, `3306`, `infraticket`, `infraticket`, empty | MySQL without a URL. Setting `MYSQL_HOST` or `MYSQL_DATABASE` selects MySQL |
| `DATA_DIR` | `data` (portable: `InfraTicket-data` beside the exe) | Folder for the SQLite file, uploads, exports, backups and `.session-secret` |
| `SQLITE_FILE` | `escalation-pro.db` (portable: `infraticket.db`) | SQLite file name inside `DATA_DIR` |
| `SQLITE_ENGINE` | `better-sqlite3`, else built-in | `node` forces Node's built-in `node:sqlite` (always used by the portable exe) |

Connection string examples:

```bash
DATABASE_URL=postgresql://infraticket:secret@db.internal:5432/infraticket
DATABASE_URL=postgresql://USER.PROJECT:PASSWORD@aws-0-eu-west-2.pooler.supabase.com:6543/postgres?sslmode=require
DATABASE_URL=mysql://infraticket:secret@127.0.0.1:3306/infraticket
```

## Security

| Variable | Default | Meaning |
| --- | --- | --- |
| `SESSION_SECRET` | generated into `DATA_DIR/.session-secret` | Signs session cookies. Set explicitly when running several servers |
| `SECRET_KEY` | the session secret | Encrypts stored credentials and backup keys. **Changing it makes them unreadable** |
| `SESSION_COOKIE_SECURE` | `false` | `true` only when users reach the app over https; on plain http it breaks sign-in |
| `SESSION_MAX_AGE_HOURS` | `12` | Idle session lifetime |
| `SETUP_TOKEN` | empty (setup open) | Required on the first-run screen. Set before going public |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_ADMIN_NAME` | empty, empty, `Administrator` | Create the first administrator at start-up on an empty database |
| `ORGANIZATION_NAME` | `Service Desk` | Organisation name used by the bootstrap administrator |
| `CRON_SECRET` | empty | Bearer token for `/api/cron/*`; the endpoints refuse everything while it is empty |
| `MCP_RATE_LIMIT_PER_MIN` | `120` | AI connector requests per minute per credential |

Generate secrets with:

```bash
openssl rand -hex 32
```

## Files and uploads

| Variable | Default | Meaning |
| --- | --- | --- |
| `UPLOADS_DIR` | `DATA_DIR/uploads` | Attachment storage |
| `EXPORTS_DIR` | `DATA_DIR/exports` | Temporary export files |
| `MAX_UPLOAD_MB` | `15` | Largest single attachment |
| `ATTACHMENT_STORE` | `disk` (serverless: `database`) | `database` keeps attachment bytes in the database, capped at 6 MB per file |

## Background jobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `SLA_CHECK_INTERVAL_MS` | `300000` (5 minutes) | How often SLA breaches are checked |
| `OPS_TICK_MS` | `10000` (10 seconds) | How often due monitors, escalations, maintenance and backups are processed |
| `ALERT_GROUP_WINDOW_MINS` | `15` | Alerts from one source and department this close together join one incident |
| `DISCORD_SUPERVISE_MS` | `20000` | How often the Discord connection is checked and the lease renewed |
| `BACKUP_TOOLS_DIR` | empty (use `PATH`) | Folder holding `pg_dump`, `mysqldump`, `mongodump`, `sqlcmd` |
| `BACKUP_TIMEOUT_MINS` | `120` | A dump running longer is stopped and reported as failed |
| `SQLSERVER_BACKUP_DIR` | a temporary folder | A folder SQL Server and InfraTicket can both reach |

### Scheduled jobs on serverless

On a long-running server the jobs run in-process, and with several servers one holds a lease in the database and does the work (another takes over within 30 seconds). Serverless platforms have no long-running process, so call the endpoints from a scheduler:

```bash
# every minute: monitors, paging, maintenance, backups
curl -fsS -X POST https://tickets.example.com/api/cron/ops -H "Authorization: Bearer $CRON_SECRET"

# every 5–15 minutes: SLA breaches
curl -fsS -X POST https://tickets.example.com/api/cron/sla -H "Authorization: Bearer $CRON_SECRET"
```

`vercel.json` already schedules `/api/cron/sla`. A free scheduler (GitHub Actions, cron-job.org, a crontab elsewhere) can call both.

## Detected automatically

| Variable | Meaning |
| --- | --- |
| `VERCEL`, `AWS_LAMBDA_FUNCTION_NAME`, `NETLIFY` | Any of these marks a serverless platform: a database is required, attachments go to the database, in-process jobs are off |
| `INFRATICKET_PORTABLE` | Set by the portable exe itself |

## Development only

| Variable | Meaning |
| --- | --- |
| `SEED_PASSWORD` | Password for the demo accounts created by `npm run seed` (default `ChangeMe123!`) |

## Docker Compose

`docker-compose.yml` also reads `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` for its database container and `CLOUDFLARE_TUNNEL_TOKEN` for the `tunnel` profile. These configure the containers, not InfraTicket itself.
