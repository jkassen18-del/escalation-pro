# Deploying

## Live deployment

| | |
| --- | --- |
| URL | https://escalation-pro.vercel.app |
| Host | Vercel (Hobby), functions in `lhr1` |
| Database | Supabase Postgres, `escalation_pro` schema, via the transaction pooler |
| Attachments | Stored in Postgres (no persistent disk on serverless) |
| SLA sweep | Daily at 07:00 UTC, the most a Hobby cron allows |

Verified by `.github/workflows/smoke.yml`, which can be re-run at any time
against any URL from the Actions tab.

---

The app runs two ways. Pick whichever matches what you have.

| | Needs | Persistent uploads | Best for |
| --- | --- | --- | --- |
| **Node server** (Docker, VPS, Render) | A machine that stays up | Yes, on disk | Normal use |
| **Serverless** (Vercel) | A Postgres database | Yes, in the database | No server to run |

Both are already wired up. Nothing needs porting.

> Never commit real secrets. The values below are placeholders — generate your
> own with the commands shown.

---

## Serverless on Vercel

### 1. A Postgres database

Serverless has no persistent filesystem, so `DATABASE_URL` is required — the app
refuses to start without it rather than writing a SQLite file to `/tmp` that
would silently vanish between requests.

Any Postgres works. If you use Supabase, take the **Transaction pooler**
connection string from *Project Settings → Database*, not the direct one:

- Direct connections are IPv6-only on the free tier and serverless platforms
  often cannot reach them.
- Serverless creates many short-lived instances. Without a pooler you will
  exhaust the connection limit.

```
postgresql://USER.PROJECT_REF:PASSWORD@aws-N-REGION.pooler.supabase.com:6543/postgres?sslmode=require
```

Copy the host exactly as the dashboard shows it (`aws-0-…` and `aws-1-…` are
different clusters; guessing gets you a DNS error).

Keep `?sslmode=require`. The connection is encrypted, but the certificate is
not verified by default, because managed providers sign it with a private CA
that the system trust store does not know about — leaving verification on
fails with *self-signed certificate in certificate chain*. To verify it
properly, download the provider's CA certificate and set `PGSSLROOTCERT` to
its path or contents.

### 2. Import the repository

In Vercel, **Add New → Project**, pick this repository, and set the production
branch to the one you are deploying. `vercel.json` already sets the build
command, output directory, function config, and the hourly SLA cron, so leave
the framework preset as **Other**.

### 3. Environment variables

```bash
DATABASE_URL=postgresql://...          # pooled connection string from step 1
SESSION_SECRET=$(openssl rand -hex 32) # signs session cookies
SECRET_KEY=$(openssl rand -hex 32)     # encrypts integration credentials
CRON_SECRET=$(openssl rand -hex 32)    # authorises the SLA cron endpoint
SETUP_TOKEN=$(openssl rand -hex 16)    # gates first-run setup, see below
SESSION_COOKIE_SECURE=true             # Vercel terminates TLS
ATTACHMENT_STORE=database              # no persistent disk
APP_URL=https://your-deployment.vercel.app
```

`SESSION_COOKIE_SECURE=true` is correct behind HTTPS and **breaks sign-in on
plain HTTP**, because the browser will refuse to store the cookie.

Changing `SECRET_KEY` later makes already-saved integration credentials
unreadable and they will need re-entering. Nothing else is affected.

### 4. Create your admin account

Open the deployment. The setup screen asks for the **setup token** — paste the
`SETUP_TOKEN` value — then your name, email, and password.

That screen only exists while the database has no users. Once you submit it, it
closes permanently and every later account is created from the People page.
There is no public sign-up anywhere in the app.

`SETUP_TOKEN` exists because on a public URL an open setup screen is a land
grab: the first stranger to find it would become your administrator. Leave it
unset only for local or internal use.

### 5. SLA sweeps on the free plan

Vercel's Hobby plan allows **one cron run per day**, so `vercel.json` schedules
the SLA breach sweep at 07:00 UTC. Everything else is real-time; only the
"ticket has passed its due date" notification waits for that daily pass.

If you want it checked more often without upgrading, point any external
scheduler at the endpoint — it is a plain authenticated POST:

```bash
curl -X POST https://your-deployment.vercel.app/api/cron/sla \
  -H "Authorization: Bearer $CRON_SECRET"
# {"ok":true,"breachesNotified":0,"ranAt":"..."}
```

A free scheduler (cron-job.org, GitHub Actions on a schedule, an existing box's
crontab) calling that every 15 minutes gives the same behaviour as a paid plan.

### 6. Check it came up

```bash
curl https://your-deployment.vercel.app/health
# {"status":"ok","database":"postgres","uptime":1}
```

`"status":"degraded"` means the database is unreachable — almost always the
wrong pooler host, or the direct connection string instead of the pooled one.
The response includes the underlying error.

---

## Node server

```bash
docker compose up -d          # app + PostgreSQL
docker compose up -d app      # app alone, on the embedded SQLite database
```

Or without Docker:

```bash
npm ci && npm run build && npm start
```

Uploads go to disk, the SLA sweep runs in-process, and SQLite needs no
configuration. Set the same secrets as above, minus `ATTACHMENT_STORE` and
`CRON_SECRET`.

To publish it on a Cloudflare domain without opening a port, see the tunnel
profile in `docker-compose.yml` and the Cloudflare section in the README.

---

## On your own servers: MySQL and Apache

The usual internal launch. Apache owns ports 80 and 443 and terminates TLS;
the application is a Node process bound to loopback behind it; MySQL holds the
data. Apache cannot run this app itself — there is no PHP here and no CGI —
so its role is reverse proxy, which is `mod_proxy_http` and nothing exotic.

Ready-made files: `deploy/apache/infraticket.conf` and
`deploy/systemd/infraticket.service`.

### 1. MySQL

**MySQL 8.0.13+ or MariaDB 10.2+.** Older servers reject a `DEFAULT` on a long
text column, which several tables here need; the app checks the version on
startup and refuses with that message rather than half-creating a schema.

```sql
CREATE DATABASE infraticket CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'infraticket'@'localhost' IDENTIFIED BY '<a long random password>';
GRANT ALL PRIVILEGES ON infraticket.* TO 'infraticket'@'localhost';
FLUSH PRIVILEGES;
```

`utf8mb4` is not optional. A database created with `utf8mb3` rejects emoji
outright, and one defaulting to `latin1` mangles any accented character
someone types into a ticket. The app declares the charset on every table it
creates, so this only matters for the database itself.

Grant for `'localhost'` specifically if the app connects to `127.0.0.1` —
MySQL matches that as `localhost`, so a `'%'`-only grant is refused.

`ALL PRIVILEGES` is only needed for the first boot, which creates the schema.
Afterwards you can narrow it to `SELECT, INSERT, UPDATE, DELETE` — but leave
`ALTER` and `INDEX` if you intend to upgrade in place, because a release that
adds a column will need them and will tell you so by name if it cannot.

### 2. The application

```bash
sudo useradd --system --home /opt/infraticket --shell /usr/sbin/nologin infraticket
sudo git clone <this repo> /opt/infraticket && cd /opt/infraticket
sudo -u infraticket npm ci && sudo -u infraticket npm run build
```

`/opt/infraticket/.env`, owned by that user and mode `0640` — it holds the
database password and the key that every integration secret is encrypted with:

```bash
DATABASE_URL=mysql://infraticket:<password>@127.0.0.1:3306/infraticket
APP_URL=https://tickets.example.internal
SESSION_SECRET=$(openssl rand -hex 32)   # signs session cookies
SECRET_KEY=$(openssl rand -hex 32)       # encrypts integration credentials
SETUP_TOKEN=$(openssl rand -hex 16)      # gates first-run setup
SESSION_COOKIE_SECURE=true               # Apache terminates TLS
```

No `CRON_SECRET` and no `ATTACHMENT_STORE` here: on a long-running server the
SLA sweep runs in-process and uploads go to disk under `data/`, both of which
only need working around on serverless.

`SESSION_COOKIE_SECURE=true` is right behind Apache's TLS and **breaks sign-in
over plain HTTP**, because the browser refuses to store the cookie. Set
`SETUP_TOKEN` because the first-run screen creates an administrator, and on a
reachable address the first person to load the page would otherwise claim it.

**Keep `SECRET_KEY` safe.** Integration credentials are encrypted with it; lose
it and every stored Slack token, Linear key and SMTP password becomes
unreadable and has to be entered again.

```bash
sudo cp deploy/systemd/infraticket.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now infraticket
curl -s localhost:3000/health     # {"status":"ok","database":"mysql",...}
```

Check `database` says `mysql` before going further. If it says `sqlite`, the
unit is not reading your `.env` and the app is quietly writing to a file.

### 3. Apache

```bash
sudo a2enmod proxy proxy_http headers ssl rewrite
sudo cp deploy/apache/infraticket.conf /etc/apache2/sites-available/
sudo a2ensite infraticket
sudo apachectl configtest && sudo systemctl reload apache2
```

Edit `ServerName` and the two certificate paths first. On RHEL or Rocky the
modules are built in — drop the file into `/etc/httpd/conf.d/` and reload
`httpd` instead.

The two `RequestHeader set X-Forwarded-*` lines in that file are load-bearing.
The app calls `app.set('trust proxy', 1)` and believes them: without them
every audit entry records Apache's own address instead of the person's, and
the session cookie is issued without `Secure` because the app thinks the
request arrived over plain HTTP.

### 4. Confirm it, then claim the account

```bash
curl -sk https://tickets.example.internal/health
```

Then open the site. An empty database shows the first-run screen, which asks
for the setup token and creates your administrator. Everyone else is added
from the People page afterwards — there is no public sign-up.

### Moving an existing deployment onto MySQL

There is no built-in export/import between engines, and I would not pretend
otherwise: the schema is portable but the data is not copied for you. For a
deployment that already has tickets in Postgres or SQLite, move the rows with
your own tooling (`pgloader` handles Postgres to MySQL well) against a schema
this app has already created, so the column types match what it expects.

Starting fresh is considerably less work if the current data is disposable.

---

## Notes

**Cloudflare Workers is not a supported target.** Workers cannot load native
addons, have no filesystem for uploads, and are request-scoped, so the SLA job
has nowhere to run. Use the tunnel instead — it serves the Node process on your
Cloudflare domain and needs no code changes.

**Sharing a database with another application** is fine if you give this app its
own schema and a role scoped to it:

```sql
CREATE SCHEMA escalation_pro;
CREATE ROLE escalation_app LOGIN PASSWORD '...';
GRANT USAGE, CREATE ON SCHEMA escalation_pro TO escalation_app;
ALTER ROLE escalation_app SET search_path = escalation_pro;
```

The `search_path` is what keeps unqualified tables out of `public`. Verify the
isolation before trusting it:

```sql
SELECT has_table_privilege('escalation_app', 'public.some_table', 'SELECT');
-- expect: false
```

This couples the two applications' lifecycles, so move to a dedicated database
before it matters.
