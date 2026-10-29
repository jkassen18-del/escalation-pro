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

A `.env` file beside the exe can set any of these, including `PORT`, `HOST`, `DATA_DIR` and `SQLITE_FILE`. Restart the exe after changing it.

## Choose how people reach it

Nothing here is required: pick the setup that fits, in `.env` beside the exe. No tunnel, proxy or cloud service is needed for any of the first three.

| Setup | `.env` | People open |
| --- | --- | --- |
| **This computer only** (the default) | nothing | `http://localhost:8080` |
| **Company network** | `HOST=0.0.0.0` | `http://<this-pc-name>:8080` |
| **Company network over https** | `HOST=0.0.0.0` and a certificate (below) | `https://<this-pc-name>:8080` |
| **Behind your own proxy or tunnel** | see below | your proxy's address |

The console lists the exact addresses when the exe starts. `InfraTicket.exe --network` does the same as `HOST=0.0.0.0` without editing a file.

On a network setup, allow the port through Windows Firewall when asked, and set `SETUP_TOKEN` first if the setup screen is still open. To limit it to the office and VPN, add `ALLOWED_NETWORKS` (see [Security](security.md#company-network-only)).

### https with your own certificate

Ask IT for a certificate for the machine's name, then point the exe at it. A Windows `.pfx`:

```text
HOST=0.0.0.0
PORT=443
TLS_PFX_FILE=C:\Tools\InfraTicket\infraticket.pfx
TLS_PFX_PASSPHRASE=the-pfx-password
```

or PEM files: `TLS_CERT_FILE=…\cert.pem` and `TLS_KEY_FILE=…\key.pem`. The sign-in cookie is then marked secure automatically, and phone push works.

### Behind a reverse proxy or tunnel

IIS, nginx, Caddy, Azure Application Proxy, a Cloudflare Tunnel or anything similar can sit in front: leave `HOST` unset (the proxy runs on the same machine) and point the proxy at `http://127.0.0.1:8080` (`localhost` works too: kept to this computer, the exe answers on both 127.0.0.1 and ::1). The exe believes the proxy's `X-Forwarded-*` headers only from this machine. If your proxy reports the visitor in its own header, name it: `CLIENT_IP_HEADER=cf-connecting-ip` (Cloudflare) or `CLIENT_IP_HEADER=x-real-ip` (nginx). `GO-LIVE.md` in the repository walks through the Cloudflare option.

## What works, and what needs extra setup

Everything in the web app works: tickets, forms, SLAs, monitors, alert sources, on-call, status pages and backups.

- **SMS and phone calls** run in **sandbox mode**: each attempt is written to the incident timeline as *simulated*. Add Twilio under *On-call → Phone & SMS* for real ones.
- **Webhooks from the internet** (Slack replies, Teams bot, Linear sync, cloud alert sources, Twilio) need an https address those services can reach: a public IP or port forward, a reverse proxy, or a tunnel; set *Settings → Public URL* to it. If you do not use those, nothing is needed: Discord, built-in monitors, heartbeats from your own network, mailboxes and outbound notifications all work from inside the network.
- **Backups** of SQLite need nothing; other engines need the vendor's dump tool installed or in a folder named by `BACKUP_TOOLS_DIR` (e.g. `C:\Program Files\PostgreSQL\16\bin`).
- **Ping monitors** use Windows' own `ping`.
- **Phone push** works on the laptop at `http://localhost:8080`; phones need an https address (your own certificate above, or a proxy).
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
