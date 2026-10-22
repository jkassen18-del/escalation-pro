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
2. **Apply routing rules** (below). A rule can send the alert to another
   department, change its severity, or drop it.
3. **Group.** A new alert from a source that already has an open incident
   *for the same department* from the last 15 minutes joins that incident
   (`ALERT_GROUP_WINDOW_MINS`).
4. **Route.** The policy a routing rule set, else the monitor's or source's
   own escalation policy, else its department's default policy
   (*On-call → Escalation policies → Team defaults*). SEV1–SEV3 page; SEV4
   opens a ticket without paging.
5. **Auto-resolve.** When the last open alert on an incident resolves, the
   incident resolves and paging stops.
6. **Maintenance windows** pause paging, or alerting altogether, for what they
   cover. Alerts are always recorded. See *Maintenance* below.

Every incident ticket says, on its page, why it paged and whom it reached.

## Alert routing rules

*Monitoring → Routing.* Ordered rules that decide where a new alert goes,
before the source's own routing. Rules run top to bottom; the first one that
matches decides, unless it is set to **keep evaluating**, in which case later
matching rules add their tags and override what they set.

A rule matches when every condition it sets holds:

| Condition | Example |
| --- | --- |
| Specific monitors or alert sources | "Checkout API", "Production Grafana" |
| Kind of source | HTTP(S) monitors, database monitors, AWS CloudWatch, Jenkins |
| Title or summary | contains `checkout`, or matches `postgres\|mysql` (case-insensitive) |
| Severity | SEV1 or SEV2 |
| Payload field | `labels.service` equals `checkout` |
| Time of day | only during, or only outside, working hours in a time zone |

and then does any of:

- **Route to a department.** The incident goes to that team and pages through
  its default policy, unless the rule also names a policy.
- **Use an escalation policy.**
- **Set the severity.**
- **Add tags** to the incident ticket.
- **Ticket only.** Open the ticket, page nobody.
- **Drop.** Record nothing. The delivery still counts on its source.

The incident ticket, the alert and the page's *why was I paged?* all name the
rule that routed it ("Routed by rule 'Website down → Web team'").
*Try a sample alert* shows which rule a made-up alert would match and what
would happen, without creating anything. Presets cover the common cases:
website monitors to the web team, database alerts to the DBAs, SEV4 as ticket
only, and no paging for SEV3 out of hours.

Regular expressions that repeat a repeated group (such as `(a+)+`) are
refused, because they can stall the pipeline.

## On-call

- **Schedules** are layers. A layer is either a **rotation** (daily, weekly
  or custom shift lengths over a list of people) or a **fixed roster**: who is
  on standby for which dates, set by hand ("week 1 Jamal, Monday to Sunday;
  week 2 Kopano"). A higher layer wins where it has someone; an **override**
  wins over every layer. Anyone can add themselves as cover; on-call managers
  can put anyone in.
- **Rosters** are laid out week by week from a handover day and time in the
  schedule's time zone (Monday 08:00 SAST by default). Pick the people to
  repeat, fill as many weeks as you need, then change any single week. Custom
  date ranges (Monday to Wednesday, a long weekend) sit alongside. Entries may
  not overlap; a week left empty falls through to the layer below, so a
  backstop rotation underneath covers the gaps.
- **Calendar.** Each schedule shows the next 14 days as a timeline and a month
  view of who is on call each day. *Download calendar (.ics)* exports the next
  90 days for Outlook or Google Calendar.
- **Escalation policies** are ordered levels. Each level notifies users,
  whoever is on call in a schedule, or a team's leads, then waits *N* minutes
  for an acknowledgement before moving on. The whole policy can repeat up to
  five times.
- **Personal notification rules** decide how each person is reached and when,
  per urgency (SEV1–2 are high, SEV3–4 low). The default for high urgency is
  the in-app bell, phone push, email and the ticket's chat thread at once, SMS
  after 1 minute, and a call after 3, with calls repeated every 2 minutes up to
  5 times. High urgency must include SMS, a phone call or a Teams call.
- **Acknowledge** from the web, from the push notification, by replying `ACK`
  to the SMS, or by pressing 1 on a phone or Teams call (2 escalates now, 3
  reads the details on a phone call). Acknowledging stops the
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

### Phone push notifications

Pages arrive on phones and computers as notifications with an **Acknowledge**
button, even with InfraTicket closed, through the browser's own push service
(Web Push). No app store app is involved, and sending is outbound only, so it
works from a server nothing on the internet can reach.

Each person turns it on, once per device, under *Profile → Phone
notifications*:

- **Android:** open InfraTicket in Chrome, tap *Turn on for this device* and
  allow notifications. *Install app* from Chrome's menu keeps it one tap away.
- **iPhone (iOS 16.4+):** in Safari tap *Share → Add to Home Screen*, open
  InfraTicket from the new home-screen icon, then turn it on there. iOS only
  allows push from the home-screen app.
- **Computers:** Chrome, Edge and Firefox, the same way.

Push needs InfraTicket to be opened over **https** (or on `localhost`), which
is why the lab guide puts every app behind a wildcard certificate. A
notification reaches the phone wherever it is; tapping *Acknowledge* needs the
phone to reach InfraTicket (company Wi-Fi, VPN, or a tunnel). When it cannot,
the notification opens InfraTicket instead. *Send a test notification* proves
a device works. Devices that uninstall or revoke permission are forgotten on
the next send.

The VAPID key pair that signs pushes is generated on first use and stored in
the database, the private half encrypted with `SECRET_KEY`. Keep `SECRET_KEY`
when moving a workspace, or every device has to turn push on again.

### Teams calls

The Teams bot can ring the person being paged in Microsoft Teams, on their
desktop and on the Teams app on their phone, repeating like a phone call until
someone acknowledges. People add **Teams call** to their own notification
rules; it counts as a wake-up channel for high urgency.

Setup, in order (*On-call → Phone & SMS → Teams calls* shows the same steps
with ticks for the parts it can check):

1. The Teams integration is in **bot mode** with the app id, client secret
   and **tenant id** filled in (*Integrations → Microsoft Teams*).
2. *Settings → App URL* is a public **https** address: Microsoft posts call
   events to it. A Cloudflare Tunnel exposing only `/api/webhooks/*` and
   `/api/public/*` is enough.
3. Azure portal → your **Azure Bot** → *Channels* → *Microsoft Teams* →
   **Calling** → *Enable calling*, with *Webhook (for calling)* set to
   `<App URL>/api/webhooks/msteams/calling`.
4. Entra admin centre → *App registrations* → the bot's app → *API
   permissions* → *Add a permission* → *Microsoft Graph* → **Application
   permissions**: `Calls.Initiate.All` (place the call), `Calls.AccessMedia.All`
   (hear the keypress) and `User.Read.All` (find each person's directory id
   from their email) → **Grant admin consent**.
5. Download the Teams app package again (*Integrations → Microsoft Teams*):
   with Teams calls on, it declares `supportsCalling`. Upload the new version
   in the Teams admin centre.
6. Turn Teams calls on and press **Call me in Teams now**. If Microsoft refuses,
   the message names the missing permission.

**Spoken prompt.** Teams plays recordings only, with no text-to-speech, so
upload a WAV prompt: mono, 16-bit, 16 kHz PCM, up to 512 KB (about 15
seconds). Record something like *"This is InfraTicket. You are being paged
for an incident. Press 1 to acknowledge, or 2 to escalate."* In Audacity, set
the project rate to 16000 Hz and the track to mono, then *File → Export →
WAV (signed 16-bit PCM)*. The file is served at an unguessable URL that
changes with each upload, because Microsoft fetches it to play.

With a prompt, answering plays it: **1** acknowledges and **2** escalates now,
then the call ends. **Without a prompt, answering is recorded but does not
acknowledge**, because a call answered in a pocket looks the same; the call
ends, and the person acknowledges from the Teams card, the web or push. Each
call's progress is on the incident's attempts: *sent* (ringing), *answered*,
*missed* or *acknowledged*. When a page is acknowledged anywhere, Teams calls
still ringing for it are hung up.

Call events are checked like every other inbound request: each carries a
JWT signed by Microsoft's calling service (keys from
`api.aps.skype.com`), issued by `https://api.botframework.com` and addressed
to the bot's app id; anything else is refused.

## Maintenance

*Operations → Maintenance.* Schedule planned work so that expected disruption
does not wake anyone.

- **What it covers:** everything, or any mix of teams (every monitor and alert
  source they own), monitors, alert sources and status page components.
- **What it does:**
  - *Pause paging*: problems still open incident tickets, so there is a
    record, but nobody is called, texted or notified.
  - *Pause alerting*: problems are only recorded, marked as maintenance. No
    tickets, no pages.
- **When:** once (a start and an end), or daily, weekly (chosen days) or
  monthly (a day of the month; a shorter month uses its last day) at a
  wall-clock time in a time zone, Africa/Johannesburg by default, for a set
  length, from a date and optionally until one. Recurring windows are worked
  out on the fly, so editing the series changes every future occurrence.
- **While it runs:** a banner across the top of the app says what is in
  maintenance and until when; affected monitors show a *Maintenance* badge on
  the Monitoring page and the Command centre. Monitors keep checking. A failed
  check during maintenance is counted as maintenance, not as an outage: it is
  left out of the uptime figure, and the day shows blue on the 90-day bars.
- **Notice:** optionally, everyone in the affected teams gets an in-app
  notification 15 minutes to a day before it starts.
- **Status pages:** a published window appears on every page showing an
  affected component, under *Scheduled maintenance* for the next 7 days and
  *Maintenance in progress* while it runs, with times in the window's own
  zone. The component shows *Under maintenance*, and "Maintenance in
  progress" and "Maintenance completed" updates are posted automatically, once
  each.
- **Actions:** end now, extend by 30 minutes or an hour, skip the next
  occurrence of a recurring window, or cancel it. Each is in the audit log.
- **When it ends** (on time, early, or cancelled), whatever it held back that
  is still firing is raised normally, once: a ticket whose paging was paused
  is paged now, and an alert that only was recorded becomes a ticket and pages.
  Monitors that came back during the work raise nothing.

### Discord direct messages

Free, and needs no public URL. With the Discord integration on (see the
README), each person links their account by typing `/link` in Discord and
entering the code under *Profile → Discord*, then adds **Discord DM** to their
notification rules. A page arrives as a DM with **Acknowledge** and
**Escalate now** buttons; the clicks come back over the bot's own outbound
connection, so they work even when InfraTicket sits on an internal network.
Every attempt is on the incident timeline, and Discord DM counts as a wake-up
channel for high urgency. For it to be loud, set the InfraTicket server (or
the bot's DMs) to *All messages* and allow it through Do Not Disturb on the
phone. Discord refuses a DM to someone who shares no server with the bot or
has turned off DMs from that server; the attempt then shows that reason.

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
SHA-256 recorded. Every backup has its own key, wrapped with `BACKUP_KEY` (or
`SECRET_KEY` when that is unset) and written into the file's header, so the
bucket on its own is useless to whoever takes it, and the file plus the key is
enough to restore it even if this server and its database are gone.

- **Schedules** are cron expressions in UTC. Presets are offered.
- **Retention** keeps the newest backup of each of the last *N* days, weeks and
  months (7 / 4 / 12 by default), and always the newest one.
- **Heartbeat.** Every job gets a heartbeat monitor. A successful run pings it,
  a failed run reports a failure, and a job that silently stops misses its
  ping. All three page the job's team.
- **Download** (permission *Download backups*) returns the decrypted dump,
  ready for the restore tool, and is recorded in the audit log.
- **Restore without the server.** `InfraTicket.exe decrypt-backup <file> [out]`
  or `npm run decrypt-backup -- <file> [out] [--key-file path]` decrypts a
  backup with `BACKUP_KEY`, `SECRET_KEY`, `SESSION_SECRET` or the data folder's
  `.session-secret`. Keep a copy of that key away from the backups. Backups
  from before the key-in-file format (`ITBK1`) restore only through
  **Download** on the server that took them.

### The encryption key

`SECRET_KEY` (or `SESSION_SECRET`, or the generated `.session-secret` file)
encrypts every stored credential. InfraTicket records a fingerprint of it in
the database. If a server starts with a different key it logs an *ENCRYPTION
KEY MISMATCH* error; a production server refuses to start until you restore
the old key, or start once with `ALLOW_KEY_CHANGE=1` to accept the new one and
re-enter the secrets. A production server that cannot save a generated key
(read-only data folder, serverless) refuses to start rather than run with one
that changes on every restart.

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
