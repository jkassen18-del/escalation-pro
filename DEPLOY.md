# Deploying

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
