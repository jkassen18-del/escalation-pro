# Portable exe

`InfraTicket.exe` is one file: no installer and no administrator rights. It is the same build that runs on servers, with an embedded SQLite database, so you can evaluate everything on a laptop and move the workspace somewhere permanent later.

## Run it

1. Put `InfraTicket.exe` in a folder of its own (a USB stick works).
2. Double-click it. A console window opens and the browser goes to <http://localhost:8080>.
3. Create the administrator on the setup screen (see [Getting started](getting-started.md#first-run-setup)).

Close the console window to stop it.

> **Note** The exe is not code-signed yet, so Windows SmartScreen warns the first time: **More info → Run anyway**.

## The data folder

Everything it writes lives in `InfraTicket-data\` beside the exe:

| Path | Holds |
| --- | --- |
| `infraticket.db` | The workspace (SQLite) |
| `uploads\` | Ticket attachments |
| `backups\` | Backups taken by backup jobs (encrypted) |
| `exports\` | Workspace exports |
| `web\<version>\` | The web UI, unpacked on first run |
| `.session-secret` | The key that encrypts stored secrets. **Keep it with the database** |

Delete the folder to start over. Set the `DATA_DIR` environment variable to keep the data somewhere else.

## Options

```text
InfraTicket.exe                    start and open the browser
InfraTicket.exe --no-browser       start without opening the browser
InfraTicket.exe --port 9090        listen somewhere other than 8080
InfraTicket.exe export [file.zip]  pack the workspace to move it elsewhere
InfraTicket.exe --version          print the version
```

### Port already in use

If something else uses 8080, the console says *Another program is using that port. Start with --port 9090 to pick another.* Either:

- run `InfraTicket.exe --port 9090` (make a shortcut: right-click the exe → *Create shortcut* → *Properties* → **Target** `"C:\Tools\InfraTicket\InfraTicket.exe" --port 9090`), or
- set it for your user: `setx PORT 9090` in a command prompt, then start the exe from a new window.

To see what holds the port: `netstat -ano | findstr :8080`, then look the PID up in Task Manager.

> **Warning** A `.env` file beside the exe **cannot** change `PORT`, `HOST`, `DATA_DIR` or `SQLITE_FILE`: the exe sets those before it reads `.env`. Use `--port` or a real environment variable. Every other variable (for example `SETUP_TOKEN`, `SECRET_KEY`, `APP_URL`, `BACKUP_TOOLS_DIR`) works from `.env`.

### Letting other machines connect

The exe listens on `127.0.0.1` only. To let colleagues or phones on the network reach it, start it with `HOST` set in the environment:

```bat
set HOST=0.0.0.0
InfraTicket.exe --port 8080
```

Allow the port through Windows Firewall when asked, and set `SETUP_TOKEN` first if the setup screen is still open.

## What works, and what needs extra setup

Everything in the web app works: tickets, forms, SLAs, monitors, alert sources, on-call, status pages and backups.

- **SMS and phone calls** run in **sandbox mode**: each attempt is written to the incident timeline as *simulated*. Add Twilio under *On-call → Phone & SMS* for real ones.
- **Webhooks from the internet** (Slack replies, Teams bot, Linear sync, cloud alert sources, Twilio) need a public https address: run a Cloudflare Tunnel to `http://localhost:8080` and set *Settings → Public URL* to the tunnel address. Discord, built-in monitors, heartbeats from your own network and outbound notifications need nothing.
- **Backups** of SQLite need nothing; other engines need the vendor's dump tool installed or in a folder named by `BACKUP_TOOLS_DIR` (e.g. `C:\Program Files\PostgreSQL\16\bin`).
- **Ping monitors** use Windows' own `ping`.
- **Phone push** works on the laptop at `http://localhost:8080`; phones need an https address.
- **Teams calls** need the Teams bot and an https Public URL Microsoft can reach.

## Moving a tested workspace

```text
InfraTicket.exe export my-workspace.zip
```

The zip holds a consistent snapshot of the database (taken with `VACUUM INTO`, safe while the app runs) and `uploads/`. To carry it into a server install that uses SQLite:

1. Unzip `infraticket.db` into that install's `DATA_DIR` and set `SQLITE_FILE=infraticket.db`.
2. Copy `uploads/` into `DATA_DIR/uploads`.
3. Copy `.session-secret` from `InfraTicket-data\` into `DATA_DIR`, or set `SECRET_KEY` to the same value on both sides. The zip does not contain it, and stored credentials are encrypted with it.

There is no built-in converter from SQLite to PostgreSQL or MySQL; see [Moving to production](production.md#moving-data-between-engines).

## Building it

```bash
npm ci
npm run build:portable                         # dist/portable/InfraTicket.exe
npm run build:portable -- --target linux-x64   # or darwin-arm64, darwin-x64
```

The server is bundled into one file and injected with the web UI into the official Node.js binary for the target (downloaded once from nodejs.org and checked against its SHA-256), so a Windows exe builds on any platform.
