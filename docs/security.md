# Security model

A summary of how InfraTicket protects itself and what is left to you. The full threat model and test list are in `SECURITY.md` in the repository.

[Open the audit log](/audit)

## Accounts and sign-in

- **No public sign-up.** Accounts are created by administrators and managers, or by single sign-on when you allow it.
- Passwords are hashed with scrypt and a per-user salt, at least 10 characters.
- **Login rate limit**: 5 failures per account and 30 per IP address in 15 minutes, answered with `429` and `Retry-After`. Checked before the password, held in the database so it survives restarts and spans servers. An unknown account takes as long to refuse as a known one, so accounts cannot be discovered by timing.
- Sessions live in the database, last 12 hours of inactivity by default (`SESSION_MAX_AGE_HOURS`), and the session id is rotated at sign-in.
- Suspending or deleting someone, or resetting their password, ends their sessions at once. Changing your own password ends your other sessions.
- **Single sign-on** (SAML 2.0) requires signed assertions, addressed to this app, answering a request this app made within 10 minutes, each accepted once. See [Single sign-on](single-sign-on.md#how-it-is-protected).
- There is **no built-in multi-factor authentication**. Use SSO with Entra ID conditional access, or put Cloudflare Access in front.

## First-run setup

A new, empty database shows a setup screen that creates the first administrator. It is **open by default**, which suits a laptop or an internal network. On an address the internet can reach, whoever opens it first becomes the administrator.

Set `SETUP_TOKEN` before exposing the app:

```bash
SETUP_TOKEN=$(openssl rand -hex 16)
```

The setup screen then asks for it, compares it in constant time, logs wrong attempts and creates nothing without it. Setup closes permanently once any user exists. Alternatively create the first administrator from the environment with `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`.

## Permissions

Every API route checks permissions on the server; hiding a button is only a convenience. See [Roles and permissions](roles-and-permissions.md). The last active administrator cannot be removed or demoted.

## Data and secrets

- **Integration credentials, database connection strings, SMTP passwords and webhook URLs** are encrypted with AES-256-GCM using `SECRET_KEY` and never returned to the browser.
- **Backups** are encrypted with a per-backup key wrapped with `SECRET_KEY`.
- **AI connector tokens** are stored as SHA-256 hashes.
- **All SQL is parameterised.**
- **Uploads** are limited to an allow-list of types, stored under random names, served with `nosniff`; SVGs always download.
- **The web app** renders user content as text (React escaping), including this documentation, which is rendered without raw HTML.

> **Warning** `SECRET_KEY` (or, if unset, the `.session-secret` file in the data folder) unlocks every stored credential and every backup. Back it up separately, and keep it when moving a workspace.

## Outbound requests

Administrator-entered webhook URLs must be https and must not resolve to localhost, private ranges, link-local addresses (including cloud metadata endpoints), IPv6 loopback or unique-local, or multicast. Slack webhooks must be on `hooks.slack.com`. *Custom HTTP* can opt in to private addresses; cloud metadata addresses stay blocked. Monitors and database lookups may target private addresses on purpose, and only administrators and managers can create them.

## Endpoints machines call

Each carries its own proof instead of a session:

| Endpoint | Proof |
| --- | --- |
| `/api/ingest/<token>`, `/api/heartbeat/<token>` | A long random token per source or monitor; AWS SNS also verified by signature |
| `/api/webhooks/slack*` | Slack's signing secret |
| `/api/webhooks/msteams` | Microsoft's signed JWT (and the tenant id, if set) |
| `/api/webhooks/msteams/calling` | Microsoft calling-service JWT for the bot's app id |
| `/api/webhooks/linear` | HMAC-SHA256 of the body |
| `/api/webhooks/telephony/twilio/*` | Twilio's signature over the Public URL, plus a per-call token |
| `/api/cron/*` | `Authorization: Bearer $CRON_SECRET` |
| `/mcp` | A personal token or OAuth access token |
| `/status/<slug>` | None: public pages are public, and show labels and states only |

## Company network only

Set `ALLOWED_NETWORKS` to the addresses your people come from, and everyone else is turned away before they see anything: no sign-in page, no scripts, no version, no API. Only the signed webhook and secret-URL intake paths in `PUBLIC_PATHS` stay reachable, because Slack, Teams, GitHub and your monitoring tools call them from the internet. Set `PUBLIC_PATHS=none` if nothing outside needs to reach the app.

List the addresses the app actually sees, which depends on how people reach it:

- **Directly on the network or VPN** (`HOST=0.0.0.0`, with or without the built-in https): the internal ranges, e.g. `ALLOWED_NETWORKS=10.0.0.0/8, 172.16.0.0/12`.
- **Through a reverse proxy on the same machine** (IIS, nginx, Caddy): the visitors' internal ranges as above. The app believes the proxy's `X-Forwarded-For` because `TRUST_PROXY` trusts a proxy on this machine; someone connecting directly cannot forge it.
- **Through a tunnel or cloud proxy** (Cloudflare and similar): your office's and VPN's **public** addresses, as the internet sees them. Set `CLIENT_IP_HEADER` if the service reports the visitor in its own header, e.g. `cf-connecting-ip`.

```text
ALLOWED_NETWORKS=10.0.0.0/8, 196.22.10.0/28
```

A proxy's own header is only believed when you name it in `CLIENT_IP_HEADER`, and only from a proxy `TRUST_PROXY` trusts. If you use a cloud service in front, its own access controls (for Cloudflare, Access / Zero Trust) add a second wall before requests reach the server.

## Protections in every response

- **Content-Security-Policy**: scripts only from the app itself, no plugins, no framing (`frame-ancestors 'none'`), forms post only to the app.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy` turning off camera, microphone and location, cross-origin isolation headers.
- `Strict-Transport-Security` over https.
- `X-Robots-Tag: noindex` and a `robots.txt` that disallows everything, so nothing is indexed.
- `Cache-Control: no-store` on every API answer, so no browser or CDN keeps ticket data.
- A state-changing request made with the session cookie must come from the app's own pages (`Origin`/`Sec-Fetch-Site` checked), on top of `SameSite=Lax`.
- Per-address request limits on the whole API, sign-in, invites and alert intake.
- `/health` answers only `{"status": "ok"}` except to the server itself.
- Attachments are shown in the browser only for images, PDF, plain text and media, under a sandboxing policy; every other type downloads.

## Known limitations

- The audit log is append-only by convention, not enforced in the database.
- Administrators are trusted: they can configure outbound webhooks and read everything.

## Reporting a vulnerability

Open a private security advisory on the repository, not a public issue.
