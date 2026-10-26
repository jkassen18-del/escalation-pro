# Going live on infraticket.co.za

How to put InfraTicket on `https://infraticket.co.za` through Cloudflare, so it
can be tested for a while before the team is given the address.

The app runs on a machine you control. A **Cloudflare Tunnel** connects that
machine to Cloudflare, and Cloudflare serves the domain over HTTPS. Nothing on
your network is opened to the internet, there is no port forwarding, no
certificate to renew, and it costs nothing.

```
people ──https──▶ Cloudflare (infraticket.co.za) ◀──tunnel── cloudflared ──▶ InfraTicket on your machine
```

InfraTicket cannot run *on* Cloudflare itself (Workers or Pages): it needs a
long-running server for monitoring, paging and the SLA clock, and a database.

---

## 1. Check the domain is active in Cloudflare

The domain was bought at GoDaddy and added to Cloudflare. Confirm the handover
finished:

1. Cloudflare dashboard → **infraticket.co.za** → **Overview**. The status must
   say **Active**. If it says *Pending nameserver update*:
2. GoDaddy → **My Products → infraticket.co.za → DNS → Nameservers → Change →
   I'll use my own nameservers**, and enter the two nameservers Cloudflare shows
   on the Overview page (they look like `ada.ns.cloudflare.com`). Remove any
   others. `.co.za` changes can take a few hours.
3. In Cloudflare → **DNS → Records**, delete any old GoDaddy **A** or **CNAME**
   records for `infraticket.co.za` and `www` (for example GoDaddy's parking
   page). The tunnel creates the records it needs.
4. **SSL/TLS → Overview**: set the mode to **Full**. **SSL/TLS → Edge
   Certificates**: turn on **Always Use HTTPS**.

## 2. Choose where it runs

| | **A. Windows PC or server, portable .exe** | **B. Linux server or VM, Docker** |
| --- | --- | --- |
| Best for | Testing it this week | What the team will use for real |
| Database | Built-in SQLite file next to the .exe | PostgreSQL in a container |
| Setup | About 15 minutes | About 30 minutes |
| Needs | A machine that stays on and awake | Any small Linux host (2 GB RAM is plenty), e.g. a Proxmox VM |

Both keep working exactly the same way behind the tunnel. You can start with A
and move to B later: `InfraTicket.exe export` packs the workspace into a .zip
that a Docker install imports.

---

## 3A. Windows: the portable .exe

1. Make a folder, e.g. `C:\InfraTicket`, and put `InfraTicket.exe` in it.
   Optionally check the download: `certutil -hashfile InfraTicket.exe SHA256`
   should print the value in `InfraTicket.exe.sha256`.
2. In the same folder, create a file called `.env` (in Notepad, save as
   *All files*, named `.env`):

   ```ini
   APP_URL=https://infraticket.co.za
   # The tunnel terminates HTTPS and forwards to this machine. Both are needed:
   # without TRUST_PROXY the sign-in cookie is refused and every visitor looks
   # like the same address to the login rate limit.
   SESSION_COOKIE_SECURE=true
   TRUST_PROXY=1
   # Required to create the first admin once it is reachable from the internet,
   # so a stranger who finds the address first cannot claim it. Use any long
   # random text, and keep it to yourself.
   SETUP_TOKEN=change-me-to-something-long-and-random
   ORGANIZATION_NAME=Gold Media Lab
   ```

3. Double-click `InfraTicket.exe`. Windows SmartScreen may say *Windows
   protected your PC*, because the file is not code-signed. Click **More info →
   Run anyway**. A console window opens, and the app listens on
   `http://localhost:8080` (only this machine can reach that port; the tunnel is
   how everyone else gets in).
4. Keep it running when nobody is logged in: open **Task Scheduler → Create
   Task**. Name it InfraTicket, and choose *Run whether user is logged on or
   not*. Add a trigger *At startup*. Set the action to start
   `C:\InfraTicket\InfraTicket.exe` with argument `--no-browser` and *Start in*
   `C:\InfraTicket`. On the Settings tab, untick *Stop the task if it runs
   longer than*.
5. Stop the PC from sleeping: Settings → System → Power → Sleep: **Never**.

Your data lives in `C:\InfraTicket\InfraTicket-data\`. Back that folder up,
and keep the backups private: alongside the database it holds the keys that
encrypt your integration tokens.

## 3B. Linux: Docker

```bash
git clone https://github.com/jkassen18-del/escalation-pro.git infraticket
cd infraticket && git checkout infraticket
cat > .env <<'EOF'
APP_URL=https://infraticket.co.za
SESSION_COOKIE_SECURE=true
SETUP_TOKEN=change-me-to-something-long-and-random
ORGANIZATION_NAME=Gold Media Lab
SESSION_SECRET=REPLACE_WITH_OUTPUT_OF_openssl_rand_-hex_32
SECRET_KEY=REPLACE_WITH_OUTPUT_OF_openssl_rand_-hex_32
POSTGRES_PASSWORD=REPLACE_WITH_A_STRONG_PASSWORD
CLOUDFLARE_TUNNEL_TOKEN=paste-in-step-4
EOF
```

Generate the two keys with `openssl rand -hex 32` (run it twice) and paste them in.
**Keep `SECRET_KEY` safe:** integration tokens and backups are encrypted with it,
and they cannot be read without it.

## 4. Create the tunnel

1. Cloudflare dashboard → **Zero Trust** (first time: pick the free plan) →
   **Networks → Tunnels → Create a tunnel → Cloudflared**. Name it `infraticket`.
2. **Install the connector:**
   - **Windows (3A):** download the Windows installer on that page and run it.
     Then, in an administrator Command Prompt, run the
     `cloudflared.exe service install <token>` line the page shows. It runs as
     a Windows service from then on.
   - **Docker (3B):** copy only the token, the long `eyJ...` string, into
     `CLOUDFLARE_TUNNEL_TOKEN` in `.env`, then start everything:
     `docker compose --profile tunnel up -d --build`.

   The page shows the connector as **Healthy** within a minute.
3. **Public hostname → Add:** leave Subdomain empty, Domain
   `infraticket.co.za`, Type `HTTP`, URL:
   - Windows: `localhost:8080`
   - Docker: `app:3000`
4. Add a second public hostname with Subdomain `www`, same domain, same URL.

Cloudflare creates the DNS records for both. Open `https://infraticket.co.za`.

## 5. Claim the admin account

The first visit shows the setup page. Enter the `SETUP_TOKEN` from `.env`, your
name, email and a password. That account is the administrator. The setup page
disappears once it exists.

Then, under **Settings → App URL**, confirm it says
`https://infraticket.co.za`. Every link in Slack, Teams, email, Linear and
GitHub messages is built from it.

## 6. Point the integrations at the live address

Now that there is a public HTTPS address, the parts that need one start working:

| Integration | Where to paste |
| --- | --- |
| Slack | Integrations → Slack → *Update the manifest* (it now carries `https://infraticket.co.za`), then reinstall. Threads, buttons and the slash command start working. |
| Microsoft Teams | Azure Bot → messaging endpoint `https://infraticket.co.za/api/webhooks/msteams` |
| Linear | Webhook URL `https://infraticket.co.za/api/webhooks/linear` |
| GitHub | Repository → Settings → Webhooks → `https://infraticket.co.za/api/webhooks/github` (secret as set in Integrations → GitHub) |
| Alert sources (AWS, Azure, Grafana, GitHub Actions…) | Each source's own URL under Monitoring → Sources |

## 7. Before the team gets the address (recommended)

- **Restrict who can open it while you test:** Zero Trust → **Access →
  Applications → Add → Self-hosted**, domain `infraticket.co.za`. Add a policy
  *Allow, emails ending in @yourcompany.co.za* (or a list of testers). Visitors
  then sign in with a one-time code by email before they see the app. Exclude
  `/api/webhooks/*` and `/api/ingest/*` from the application (add them as
  separate *Bypass* applications), or Slack, Teams, GitHub and alert sources
  will be blocked too.
- **Backups:** Databases → add a backup of the InfraTicket database itself, or
  on Windows copy `InfraTicket-data` somewhere else every night.
- **Uptime:** add an HTTP monitor in another InfraTicket, or any external
  checker, for `https://infraticket.co.za/health`.

## Troubleshooting

| What you see | Why, and the fix |
| --- | --- |
| Cloudflare *Error 1033* | The tunnel connector is not running. Start the cloudflared service (Windows) or `docker compose --profile tunnel up -d`. |
| Cloudflare *Error 502* | The tunnel is up but the app is not. Check the console window or `docker compose logs app`, and that the hostname URL matches (`localhost:8080` / `app:3000`). |
| You sign in, and land back on the sign-in page | `SESSION_COOKIE_SECURE=true` without `TRUST_PROXY=1` (portable). Add it and restart. |
| *Too many redirects* | SSL/TLS mode is *Flexible*. Set it to **Full**. |
| The setup page asks for a token | That is `SETUP_TOKEN` from `.env`. |
| Links in Slack/Teams point at localhost | Settings → App URL, or `APP_URL` in `.env`. |
