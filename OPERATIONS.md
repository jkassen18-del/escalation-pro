# Operations: monitoring, on-call, status pages and backups

InfraTicket 2.0 adds the incident-response half of the platform. Signals come
in on the left (built-in monitors, webhooks from cloud providers and CI), the
alert pipeline turns them into incident tickets, the pager wakes the right
person, and status pages tell everyone else.

```
 monitors ─┐                         ┌─> incident ticket ──> Slack / Teams / Linear / email
 webhooks ─┼─> normalise ─> dedupe ─>┤
heartbeats ┘     (per provider)  group └─> page ─> push, email, SMS, phone ... until acknowledged
```

## Monitors

*Operations → Monitoring.* Each monitor runs on its own interval from the
server (or every node, with one leader at a time).

| Kind | Checks |
| --- | --- |
| HTTP(S) | Method, headers, body, expected status (`200-299`, `2xx`, `200,204`), keyword present or absent, response-time limit |
| TCP | A port accepts connections (`host:port`) |
| Ping | ICMP echo, using the system's `ping` |
| DNS | A record resolves, optionally to an expected value |
| SSL | The certificate is trusted and has more than *N* days left |
| Heartbeat | Your job calls its URL at least every interval plus grace. Call `…/fail` to report a failure yourself |
| Database | Connect, query, and report latency, connections, size and replication lag |

A monitor is marked down only after *failure threshold* consecutive failures,
so one dropped packet does not wake anybody, and it recovers on the first
success. Raw results are kept for seven days, and daily uptime for the 90-day
bars on status pages.

Heartbeat example for cron:

```bash
0 2 * * * /opt/etl/run.sh && curl -fsS https://tickets.example.com/api/heartbeat/<token> \
                          || curl -fsS https://tickets.example.com/api/heartbeat/<token>/fail
```

## Alert sources

Each source has its own URL with a secret token in it. POST JSON to it.

| Source | Set up |
| --- | --- |
| AWS CloudWatch / Health | Create an SNS topic and an HTTPS subscription to the URL. The subscription is confirmed automatically, and every message's SNS signature is verified. CloudWatch `OK` resolves the alert |
| Azure Monitor | Action group → Webhook → the URL, with the *common alert schema* on. `Resolved` resolves |
| Grafana / Alertmanager | Contact point or receiver of type webhook. Batches are split into alerts; `resolved` resolves |
| Jenkins | Notification plugin or a post-build HTTP step. `SUCCESS` resolves the job's alert |
| Cloudflare | Notifications → Webhook destination |
| DigitalOcean, Entra ID, Stratigix, anything else | Generic. Map title, severity, status and dedup key with paths like `alert.labels.severity`, or send `title`, `severity`, `status`, `dedup_key` |

*Send test alert* pushes a sample through the real pipeline, so you can see the
ticket it opens and who it pages.

## The alert pipeline

1. **Deduplicate.** A repeat of an alert that is still open increments its
   count; it does not open another ticket.
2. **Group.** A new alert from a source that already has an open incident from
   the last 15 minutes joins that incident (`ALERT_GROUP_WINDOW_MINS`).
3. **Route.** The monitor's or source's own escalation policy, or else its
   team's default policy (*On-call → Escalation policies → Team defaults*).
   SEV1–SEV3 page; SEV4 opens a ticket without paging.
4. **Auto-resolve.** When the last open alert on an incident resolves, the
   incident resolves and paging stops.
5. **Maintenance windows** suppress paging, never recording: the alert and
   ticket still appear, marked as suppressed.

Every incident ticket says, on its page, why it paged and whom it reached.

## On-call

- **Schedules** are layers of rotations (daily, weekly or custom shift
  lengths) over a list of people. A higher layer wins where it has someone;
  an **override** wins over every layer. Anyone can add themselves as cover;
  on-call managers can put anyone in.
- **Escalation policies** are ordered levels. Each level notifies users,
  whoever is on call in a schedule, or a team's leads, then waits *N* minutes
  for an acknowledgement before moving on. The whole policy can repeat up to
  five times.
- **Personal notification rules** decide how each person is reached and when,
  per urgency (SEV1–2 are high, SEV3–4 low). The default for high urgency is
  the in-app bell, email and the ticket's chat thread at once, SMS after 1
  minute, and a call after 3, with calls repeated every 2 minutes up to 5 times.
  High urgency must include SMS or a call.
- **Acknowledge** from the web, by replying `ACK` to the SMS, or by pressing 1
  on the call (2 escalates now, 3 reads the details). Acknowledging stops the
  escalation, assigns the incident to you if nobody had it, and moves it to
  *in progress*.

The pager keeps its state in the database: the current level, when it started,
and every attempt made. A restart, or another node taking over, carries on
where it left off and never repeats an attempt.

### Telephony

The default provider is the **sandbox**: SMS and calls are recorded on the
timeline as *simulated* and nothing is sent. To place real calls and messages,
choose Twilio under *On-call → Phone & SMS* and enter the account SID, auth
token and a number. For acknowledgements by SMS and keypad, set an `https`
*App URL*, and point the number's messaging webhook at
`<App URL>/api/webhooks/telephony/twilio/sms`. Inbound requests are checked
against Twilio's signature, and call callbacks carry a per-attempt signed token.

Phone numbers on profiles must be in international format (`+27 82 123 4567`).
Ask each on-call person to save the Twilio number as a contact and allow it
through Do Not Disturb.

## Status pages

Make as many as you need, public or internal. Components are monitors, with a
public label. A page shows the current state, 90 days of uptime and the updates
you post. Updates are written for the page and never copied from ticket
comments, so nothing said internally becomes public.

- Public pages: `/status/<slug>`, and JSON at `/api/public/status/<slug>`.
  They are plain HTML with no scripts, and they refresh every minute.
- Internal pages show only to signed-in users.

## Databases and backups

*Operations → Databases.* Each connector is a database to watch and back up.

| Engine | Backup | Restore |
| --- | --- | --- |
| PostgreSQL | `pg_dump --format=custom` | `pg_restore -d <db> file.pgdump` |
| Supabase | The same, over the direct connection (port 5432, not the pooler) | `pg_restore` |
| MySQL / MariaDB | `mysqldump --single-transaction --routines --triggers` | `mysql <db> < file.sql` |
| MongoDB | `mongodump --archive` | `mongorestore --archive=file.archive` |
| SQLite | Online backup (`VACUUM INTO`), no tools needed | Replace the file |
| SQL Server | `BACKUP DATABASE … WITH COPY_ONLY` via `sqlcmd` | `RESTORE DATABASE` |

The pipeline is dump → gzip → AES-256-GCM → local folder or S3-compatible
storage (AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO, Backblaze B2) →
SHA-256 recorded. Every backup has its own key, wrapped with the server's
`SECRET_KEY`, so the bucket on its own is useless to whoever takes it.

- **Schedules** are cron expressions in UTC. Presets are offered.
- **Retention** keeps the newest backup of each of the last *N* days, weeks and
  months (7 / 4 / 12 by default), and always the newest one.
- **Heartbeat.** Every job gets a heartbeat monitor. A successful run pings it,
  a failed run reports a failure, and a job that silently stops misses its
  ping. All three page the job's team.
- **Download** (permission *Download backups*) returns the decrypted dump,
  ready for the restore tool, and is recorded in the audit log.

Give the connector a least-privilege account:

```sql
-- PostgreSQL
CREATE ROLE infraticket_backup LOGIN PASSWORD '…';
GRANT pg_read_all_data TO infraticket_backup;          -- PostgreSQL 14+
-- MySQL
CREATE USER 'infraticket_backup'@'%' IDENTIFIED BY '…';
GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT, PROCESS ON *.* TO 'infraticket_backup'@'%';
```

## Running it at scale

Every node runs the same scheduler loop, and one holds a lease in the database
and does the work. If that node stops, another takes over within 30 seconds.
Serverless deployments have no loop, so call `/api/cron/ops` every minute with
`Authorization: Bearer $CRON_SECRET`.

## Permissions

| Permission | Allows | Default roles |
| --- | --- | --- |
| `monitors.manage` | Monitors, alert sources, maintenance windows | Admin, Manager |
| `oncall.manage` | Schedules, policies, team defaults, telephony | Admin, Manager |
| `statuspages.manage` | Status pages and their updates | Admin, Manager |
| `backups.manage` | Database connectors and running backups | Admin |
| `backups.restore` | Downloading decrypted backups | Admin |

Everyone signed in can see what is down, who is on call and the status pages,
can acknowledge pages, and can add themselves as cover.
