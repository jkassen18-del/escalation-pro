# Moving to production and upgrading

## Production checklist

Before people depend on it:

- **`SETUP_TOKEN`** set before the address is reachable, or the first administrator already created.
- **`SESSION_SECRET`** and **`SECRET_KEY`** set explicitly (`openssl rand -hex 32`), and `SECRET_KEY` stored somewhere safe outside the server.
- **HTTPS** in front, with `SESSION_COOKIE_SECURE=true`.
- **Settings → Public URL** set to the real address.
- A real database (PostgreSQL or MySQL) if you need more than one server; otherwise SQLite on a disk that is backed up.
- **Backups** of InfraTicket's own database and the secret, and a restore tested. See [Backing up InfraTicket](backing-up-infraticket.md).
- A **heartbeat or external check** on `/health`, from somewhere other than InfraTicket itself.
- At least two administrators, and SSO tested in a private window before requiring it.
- Every on-call person has sent themselves a test page (*Profile → Send a test page to me*) and has a wake-up channel.
- Only the webhook paths exposed to the internet, or the whole app behind Cloudflare Access or a VPN.
- Twilio switched from sandbox, if you use SMS or calls.

## From staging to production

Most teams start production fresh and re-create the configuration, which is quick:

1. Install production (see [Servers, Docker and databases](servers-and-docker.md)) with its own `SECRET_KEY`.
2. Create the administrator, departments, people and forms.
3. Re-create integrations with the **production** Slack app, Teams bot and Linear webhook. Integration credentials cannot be copied between installs with different keys.
4. Re-create alert sources and move each tool's webhook to the new URL one at a time, sending a test alert after each.
5. Turn off the staging sources so nothing pages twice.

### Keeping the staging data

If staging ran on SQLite (the portable exe or a lab server) and production will too:

1. `InfraTicket.exe export workspace.zip` (or a `VACUUM INTO` copy on a server).
2. Put `infraticket.db` in production's `DATA_DIR` with `SQLITE_FILE=infraticket.db`, and `uploads/` in `DATA_DIR/uploads`.
3. Use the **same** `SECRET_KEY` (or copy `.session-secret`) so stored credentials still decrypt.
4. Start, then update *Settings → Public URL* and every integration that points at the old address.

### Moving data between engines

There is no built-in export from one engine to another. To move a SQLite or PostgreSQL workspace onto MySQL (or similar), start the target once so InfraTicket creates its schema, stop it, then copy the rows with your own tooling (for example `pgloader` for PostgreSQL → MySQL). Starting fresh is usually less work if the data is disposable.

## Upgrading

The schema is upgraded automatically on start: new tables and columns are added, nothing is dropped.

1. **Back up** the database, uploads and secret.
2. Read the release notes for anything that needs action.
3. Update:

```bash
# from source / systemd
cd /opt/infraticket && sudo -u infraticket git pull
sudo -u infraticket npm ci && sudo -u infraticket npm run build
sudo systemctl restart infraticket

# Docker
git pull && docker compose build app && docker compose up -d app
```

   Portable: close the console, replace `InfraTicket.exe`, start it again. The data folder is kept and the new web UI unpacks into `web\<new version>\`.
4. Check `/health` and sign in. On MySQL, if the upgrade needs a privilege the account no longer has (`ALTER`, `INDEX`), the error names it.

### Rolling back

Stop the app, restore the database backup taken in step 1, and start the previous version. Starting an older version against a newer schema usually works (extra columns are ignored) but is not tested.
