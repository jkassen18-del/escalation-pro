# Lab server and staging

A common path is: try the [portable exe](portable.md) on a laptop, run a **lab server** on the internal network that the team uses for real (with webhooks reaching it through a tunnel), then move to a [production](production.md) server. This page covers the lab server. Everything here uses free software and free tiers.

## A typical lab server

- A small Linux VM (2 vCPU, 2–4 GB RAM) or a spare Windows box.
- InfraTicket in Docker with PostgreSQL, or on SQLite (fine for one server).
- HTTPS inside the network with a wildcard certificate, so phone push and secure cookies work.
- A Cloudflare Tunnel that exposes **only** the webhook paths to the internet.

## 1. Install

```bash
sudo apt install -y docker.io docker-compose-v2 git
git clone <this repository> /opt/infraticket && cd /opt/infraticket
cat > .env <<'ENV'
SESSION_SECRET=<openssl rand -hex 32>
SECRET_KEY=<openssl rand -hex 32>
SETUP_TOKEN=<openssl rand -hex 16>
APP_URL=https://tickets.lab.example.com
SESSION_COOKIE_SECURE=true
ENV
docker compose up -d            # app + PostgreSQL on port 3000
curl -s localhost:3000/health   # {"status":"ok","database":"postgres",...}
```

`docker compose up -d app` instead runs the app alone on SQLite.

## 2. HTTPS on the internal network

Phone push, secure cookies and Teams/Slack links want https. A free option is a Let's Encrypt **wildcard** certificate validated by DNS, so the server never has to be reachable from the internet:

```bash
sudo apt install -y certbot python3-certbot-dns-cloudflare
# /root/cloudflare.ini holds: dns_cloudflare_api_token = <token with Zone:DNS:Edit>
sudo certbot certonly --dns-cloudflare --dns-cloudflare-credentials /root/cloudflare.ini \
  -d '*.lab.example.com' -d lab.example.com
```

Then put Apache or nginx in front on port 443 (the repository has `deploy/apache/infraticket.conf`; see [Servers, Docker and databases](servers-and-docker.md#reverse-proxy)), and point an internal DNS record `tickets.lab.example.com` at the server.

Verified against the Certbot and Cloudflare documentation; untested in your network.

## Exposing only the webhook paths

Slack, Teams, Linear, Twilio, cloud alert sources and AI assistants on the internet must reach some paths. People should not reach the rest. A Cloudflare Tunnel can publish a separate hostname that answers **only** those paths; everything else gets 404:

```yaml
# /etc/cloudflared/config.yml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: hooks.example.com
    path: ^/api/(webhooks|ingest|heartbeat|public)/
    service: http://localhost:3000
  - hostname: hooks.example.com
    path: ^/status/
    service: http://localhost:3000
  - hostname: hooks.example.com
    path: ^/(mcp|oauth/(register|authorize|token|revoke)|\.well-known/oauth-(protected-resource|authorization-server)(/mcp)?)$
    service: http://localhost:3000
  - hostname: hooks.example.com
    service: http_status:404
  - service: http_status:404
```

| Path | Who calls it |
| --- | --- |
| `/api/webhooks/slack*` | Slack events, buttons, `/gml` |
| `/api/webhooks/msteams` | The Teams bot |
| `/api/webhooks/msteams/calling` | Teams calls |
| `/api/webhooks/linear` | Linear |
| `/api/webhooks/telephony/twilio/*` | Twilio SMS and calls |
| `/api/ingest/<token>` | Alert sources |
| `/api/heartbeat/<token>` | Jobs outside your network |
| `/api/public/*` | Status JSON, the Teams call prompt |
| `/status/*` | Public status pages (leave out if you have none) |
| `/mcp`, `/oauth/*`, `/.well-known/oauth-*` | claude.ai and Copilot Studio (leave out if unused) |

Leave out the rows you do not use. Steps:

1. Cloudflare Zero Trust → **Networks → Tunnels → Create a tunnel** (cloudflared), and install the connector on the lab server.
2. Use the `config.yml` above (or add the same hostname and path rules as *Public hostnames* in the dashboard).
3. Set **Settings → Public URL** to `https://hooks.example.com` so the URLs InfraTicket gives to Slack, Teams, Linear and Twilio use the tunnel.

> **Note** Links in notifications are built from the Public URL too, and that hostname answers only webhook paths. People open tickets at the internal address (`https://tickets.lab.example.com`), so a link from Slack opens a 404 unless they change the host. If that matters, expose the whole app through the tunnel instead and protect it with **Cloudflare Access** (free for up to 50 users) in front of everything except the webhook paths.

Cloudflare's tunnel and Access are free. Verified against Cloudflare's documentation; untested against your account.

## Staging next to production

Run two installs with **separate** databases and **separate** `SECRET_KEY`s:

| | Staging | Production |
| --- | --- | --- |
| Address | `tickets-staging.lab.example.com` | `tickets.example.com` |
| Slack | A second Slack app in a test channel | The real app |
| Teams | A second bot registration | The real bot |
| Telephony | Sandbox | Twilio |
| Alert sources | Test sources only | Real |

Never point real monitoring tools at staging: two installs paging for the same alert confuses everyone.

## Upgrading the lab server

```bash
cd /opt/infraticket && git pull
docker compose build app && docker compose up -d app
curl -s localhost:3000/health
```

The schema upgrades itself on start. Back up first; see [Backing up InfraTicket](backing-up-infraticket.md).
