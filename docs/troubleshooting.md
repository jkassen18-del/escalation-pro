# Troubleshooting and FAQ

## Starting up

**The portable exe says the port is in use.** Another program has port 8080. Start with `InfraTicket.exe --port 9090`. A `PORT=` line in `.env` beside the exe does not work for this; see [Portable exe](portable.md#port-already-in-use).

**`npm run dev` says port 3000 is in use.** `PORT=3001 npm run dev` (PowerShell: `$env:PORT=3001; npm run dev`).

**"Client bundle not found".** Run `npm run build` before `npm start`.

**"DATABASE_URL is not set" on Vercel or another serverless host.** Serverless needs PostgreSQL or MySQL; the embedded SQLite file would vanish between requests.

**"Could not connect to PostgreSQL" / `/health` says degraded.** The message carries the reason. Common ones: the wrong Supabase pooler host (copy it exactly), a direct connection string where a pooled one is needed, or `self-signed certificate in certificate chain` (keep `?sslmode=require`, or set `PGSSLROOTCERT`). Unset `DATABASE_URL` to check the rest works on SQLite.

**`/health` says `"database":"sqlite"` but I configured MySQL.** The service is not reading your `.env`. Check `EnvironmentFile=` in the systemd unit, or the compose `environment:`.

**MySQL refuses to start with a version message.** InfraTicket needs MySQL 8.0.13+ or MariaDB 10.2+.

## Signing in

**Signing in does nothing, or I am signed out immediately.** Almost always `SESSION_COOKIE_SECURE=true` on a plain-http address. Set it to `false` unless users reach the app over https, or put https in front.

**"That setup token is not correct".** `SETUP_TOKEN` is set on the server; enter that value on the setup screen. Clear it and restart if you want setup open.

**Locked out by the sign-in limit.** Wait the 15 minutes shown, or clear the counter in the database:

```sql
DELETE FROM login_attempts WHERE key LIKE 'account:%';
```

**Lost the only administrator password.** Another administrator can reset it under People. If there is none, start against an empty database with `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`, or reset it in the `users` table with a hash produced by the app.

**Single sign-on fails.** See [When sign-in fails](single-sign-on.md#when-sign-in-fails).

**Everyone was signed out after a restart.** `SESSION_SECRET` changed, or the `.session-secret` file was lost (for example a container without a volume). Set `SESSION_SECRET` explicitly.

## Integrations

**An integration test fails.** The text comes straight from the provider. `invalid_token` / `invalid_auth`: the credential is wrong or revoked. A timeout: outbound traffic to that host is blocked by a firewall or proxy.

**Stored integrations say they cannot be decrypted.** `SECRET_KEY` changed (or `.session-secret` was replaced). Restore the old key, or re-enter the credentials.

**Slack buttons, replies or `/gml` do nothing.** Slack cannot reach the Public URL, or the signing secret is wrong. Slack's app page shows failed deliveries. See [Slack](slack.md#troubleshooting).

**Teams bot does not answer.** The messaging endpoint must be public https with a publicly trusted certificate, and InfraBot must be added to the channel. See [Microsoft Teams](microsoft-teams.md#troubleshooting).

**Links in Slack, Teams or email point at `localhost`.** Set **Settings → Public URL**.

**Discord replies are ignored.** Turn on *Message Content Intent*, and make sure the person ran `/link`.

## Monitoring and paging

**A monitor is down but nobody was paged.** Check, in order: severity SEV4 (never pages); a routing rule set *Ticket only* or *Drop*; a maintenance window covers it; the department has *None* as its default policy; the policy's targets have no wake-up channel. The incident's *Why did this page me?* shows what happened.

**Ping monitors fail with "The ping command is not available".** Install `ping` (`iputils-ping` on Debian/Ubuntu; it is in the Docker image).

**Alerts from AWS never arrive.** The SNS subscription must be confirmed: the URL must be reachable when you create the subscription. Check *Alert sources → (source) → last event*.

**SMS and calls show "simulated".** Telephony is in sandbox mode. Add Twilio under *On-call → Phone & SMS*.

**Phone push cannot be turned on.** It needs https (or `localhost`). On iPhone, add InfraTicket to the Home Screen first and turn it on from there.

**Nothing runs on serverless.** Monitors, paging and backups need `/api/cron/ops` called every minute; see [Scheduled jobs on serverless](environment-variables.md#scheduled-jobs-on-serverless).

## Backups

**"pg_dump: server version mismatch".** `pg_dump` must be at least the server's major version. Install a newer client or point `BACKUP_TOOLS_DIR` at one.

**"mysqldump is not installed on this server".** Install the client tools, or set `BACKUP_TOOLS_DIR` to the folder holding them.

**SQL Server backups fail to find the file.** SQL Server writes on its own host; set `SQLSERVER_BACKUP_DIR` to a share both machines can reach.

## FAQ

**Does anything here cost money?** No. Slack, Teams (webhook or bot), Discord, Linear, email, Cloudflare Tunnel and every alert source work on free plans. Twilio (real SMS and calls) is the only paid option, and push, Teams calls and Discord DMs are free wake-up channels instead.

**Can people raise tickets by email?** Not yet. Email is outbound only.

**Can I use Telegram / WhatsApp?** There is no built-in connector. [Custom HTTP](custom-http.md) can post ticket events to any bot API.

**Can it run on Cloudflare Workers?** No; use a Cloudflare Tunnel to a Node server.

**Where is the data?** In the database you configured, plus attachments in `DATA_DIR/uploads`. Nothing is sent anywhere except to the integrations you set up.

**How do I report a security problem?** A private security advisory on the repository.
