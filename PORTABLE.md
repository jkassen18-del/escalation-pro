# InfraTicket portable (`InfraTicket.exe`)

One file, no installer and no admin rights. It is the same build that runs
on-prem and in the cloud, with an embedded SQLite database, so you can evaluate
everything on a laptop and carry the workspace somewhere permanent afterwards.

## Run it

1. Put `InfraTicket.exe` in a folder of its own (a USB stick works).
2. Double-click it. A console window opens and the browser goes to
   <http://localhost:8080>.
3. Create the owner account on the setup screen.

Close the console window to stop it.

Everything it writes lives in `InfraTicket-data\` beside the executable:

| Path | Holds |
| --- | --- |
| `infraticket.db` | The workspace (SQLite) |
| `uploads\` | Ticket attachments |
| `backups\` | Database backups taken by backup jobs (encrypted) |
| `web\<version>\` | The web UI, unpacked on first run |
| `.session-secret` | The key that encrypts stored secrets. **Keep it with the database.** |

Delete the folder to start over.

## Options

```text
InfraTicket.exe                   start and open the browser
InfraTicket.exe --no-browser      start without opening the browser
InfraTicket.exe --port 9090       listen somewhere other than 8080
InfraTicket.exe export [file.zip] pack the workspace to move it elsewhere
InfraTicket.exe --version
```

Any variable from `.env.example` can be set in the environment or in a `.env`
file next to the executable. The portable build listens on `127.0.0.1` only;
set `HOST=0.0.0.0` to let other machines on the network reach it.

## What works, and what needs extra setup

Everything in the web app works: tickets, forms, SLAs, monitors, alert sources,
on-call schedules and escalation, status pages and backups.

- **Paging by SMS and phone** runs in **sandbox mode**: each attempt is written
  to the incident timeline as "simulated", so you can walk a whole escalation
  without a telephony account. Add Twilio credentials under
  *On-call → Phone & SMS* to place real calls. Use *Profile → Send a test page
  to me* to check what each person would receive.
- **Webhooks from the internet** (Slack, Teams, Linear, alert sources, Twilio)
  need a public https address. Run a Cloudflare Tunnel or similar to
  `http://localhost:8080` and set *Settings → App URL* to the tunnel's address.
  Built-in monitors, heartbeats from your own network and the web app need no
  tunnel.
- **Backups** of SQLite files need nothing. Postgres, Supabase, MySQL, MongoDB
  and SQL Server backups run the vendor's dump tool (`pg_dump`, `mysqldump`,
  `mongodump`, `sqlcmd`). Install the client tools, or put them in a folder
  and set `BACKUP_TOOLS_DIR` to it. `pg_dump` must be at least the server's
  major version.
- **Ping monitors** use Windows' own `ping`.

## Moving a tested workspace

```text
InfraTicket.exe export my-workspace.zip
```

The zip holds a consistent snapshot of the database (taken with
`VACUUM INTO`, safe while the app runs) and the attachments. To carry it into
an on-prem install, unzip `infraticket.db` into that install's data folder
(`SQLITE_FILE=infraticket.db`), copy `uploads/` beside it, and copy
`.session-secret` from `InfraTicket-data\` as well, or set `SECRET_KEY` to the
same value on both sides: stored credentials are encrypted with it.

## Building it

```bash
npm ci
npm run build:portable                         # dist/portable/InfraTicket.exe
npm run build:portable -- --target linux-x64   # or darwin-arm64, darwin-x64
```

The server is bundled into one CommonJS file, the web UI is attached as
assets, and both are injected into the official Node.js binary for the target
(downloaded once from nodejs.org and checked against its published SHA-256).
Nothing native is bundled, so a Windows executable builds on any platform.
The *Portable build* workflow builds it on a Windows runner, starts it, checks
`/health`, and attaches the exe to the run.

The executable is not code-signed yet, so Windows SmartScreen will warn the
first time it runs ("More info → Run anyway").
