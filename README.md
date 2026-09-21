# Escalation Pro

A departmental ticketing and escalation management system. Tickets are routed to
teams, tracked against SLA targets, escalated when they stall, and mirrored into
the tools your team already uses.

**Accounts are created by administrators. There is no public sign-up** — the
only exception is the one-time setup screen that creates the very first
administrator on a brand-new database.

> **Before exposing this on a public URL, set `SETUP_TOKEN`.** Setup is open by
> default, which is right for local and internal use, but on a public address
> the first person to load the page claims the administrator account. See
> [SECURITY.md](SECURITY.md).

---

## Quick start

Requires Node.js 20.11 or newer. Nothing else.

```bash
npm install
npm run seed     # optional: demo teams, people, and tickets
npm run dev
```

Open <http://localhost:3000>.

- If you skipped the seed, the setup screen asks you to create the first
  administrator account.
- If you ran the seed, sign in as `avery@example.com` / `ChangeMe123!`.
  Six other demo accounts share that password; `npm run seed` prints them all.

There is no database to install and no configuration to write. The app creates
an embedded SQLite database under `data/` on first boot.

To start over: `npm run reset`.

---

## Running in production

```bash
npm run build
npm start
```

`npm run build` produces `dist/client` (the React bundle) and
`dist/server/index.mjs` (the API). `npm start` serves both from one process on
one port.

### Docker

```bash
# App + PostgreSQL
docker compose up -d

# App alone, on the embedded SQLite database
docker compose up -d app
```

### PostgreSQL

Set `DATABASE_URL` and restart. The schema is created automatically:

```bash
DATABASE_URL=postgresql://user:pass@host:5432/escalation_pro npm start
```

Both engines run the same schema and the same test suite. SQLite suits a single
instance; use PostgreSQL when you need several instances or an external backup
story.

### Putting it on your own domain (Cloudflare)

This is a Node server with a native SQLite module, disk-backed uploads, and a
background job. **It does not run on Cloudflare Workers** — Workers have no
filesystem, cannot load native addons, and are request-scoped. Running it there
would mean replacing the database, upload storage, HTTP layer, and scheduler.

The supported way to serve it on a Cloudflare domain is a **Cloudflare Tunnel**,
which proxies to the Node server and needs no code changes:

1. In Cloudflare Zero Trust → **Networks → Tunnels**, create a tunnel.
2. Add a public hostname (e.g. `tickets.yourdomain.com`) pointing at
   `http://app:3000`.
3. Copy the tunnel token into `.env`:

```bash
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...
SETUP_TOKEN=$(openssl rand -hex 16)     # required before going public
SESSION_COOKIE_SECURE=true              # the tunnel terminates TLS
APP_URL=https://tickets.yourdomain.com
```

4. Start it:

```bash
docker compose --profile tunnel up -d
```

No firewall port is opened and no DNS record is edited by hand. Put
**Cloudflare Access** in front of the hostname if you want SSO or MFA.

### Hosted deployment

`render.yaml` provisions a web service and a managed PostgreSQL database.
Point Render at this repository as a Blueprint and it deploys as-is. You can
then point Cloudflare DNS at the Render hostname.

Set `SESSION_COOKIE_SECURE=true` behind any HTTPS proxy. Leave it `false` on
plain HTTP, or browsers will refuse the session cookie and nobody can sign in.

See `.env.example` for every supported variable. All of them are optional.

---

## How it works

### Tickets

Each ticket carries a reference (`ESC-1042`), a status, a priority, a type, an
owning team, an assignee, and a full timeline of comments and system events.

| Status | Meaning |
| --- | --- |
| `open` | Raised, not yet being worked |
| `in_progress` | Someone is actively on it |
| `pending` | Blocked, usually waiting on a third party |
| `resolved` | Fixed, awaiting confirmation |
| `closed` | Finished |

Priorities are `urgent`, `high`, `normal`, and `low`. Types are `incident`,
`request`, `question`, `problem`, and `escalation`.

Comments are either public replies or **internal notes**, which are hidden from
anyone without the internal-notes permission and are never sent to Slack,
Microsoft Teams, or Linear.

### Routing

Each team chooses how new tickets find an owner:

- **Manual** — the ticket stays unassigned until someone picks it up.
- **Round robin** — each new ticket goes to the next member in turn.
- **Least busy** — whichever member has the fewest open tickets.

Only active members with the agent role or above are eligible. Viewers never
receive work.

### SLA

Teams set a first-response target and a resolution target. The due date is
derived from the resolution target, scaled by priority:

| Priority | Multiplier |
| --- | --- |
| Urgent | ×0.25 |
| High | ×0.5 |
| Normal | ×1 |
| Low | ×2 |

A team with a 24-hour resolution target therefore gives an urgent ticket six
hours. A background job scans for breaches every five minutes and notifies
watchers once per breach.

The first-response clock stops on the first public reply from someone other
than the requester.

### Escalation

Escalating a ticket raises its level, bumps its priority, records the reason as
an internal note, and notifies every connected channel. Above the configured
priority floor it can also open a tracked issue in Linear.

---

## Roles and permissions

| Role | Intended for |
| --- | --- |
| **Administrator** | Full access, including integrations, settings, and the audit log |
| **Manager** | Runs queues and people; everything except integrations and system settings |
| **Agent** | Works tickets in their assigned teams |
| **Viewer** | Read-only access to tickets in their assigned teams |

Individual permissions can be granted on top of a role from the People page. A
role's own permissions cannot be revoked — change the role instead.

Users without `tickets.view_all` see only tickets in their teams, plus any
ticket they raised, were assigned, or created.

The API enforces every permission independently of the UI. Hiding a button is a
convenience, not the security boundary.

---

## Integrations

Configure these in **Integrations** while signed in as an administrator. Every
credential is encrypted with AES-256-GCM before it is stored, and each provider
has a **Test connection** button that calls the real service and reports exactly
what came back.

### Slack

Either method works:

- **Incoming webhook** — create one at Slack → Your apps → Incoming Webhooks,
  then paste the `https://hooks.slack.com/services/...` URL.
- **Bot token** — create an app with the `chat:write` scope, then supply the
  `xoxb-...` token and a channel. This lets you change channel later without a
  new URL.

Messages are sent as Block Kit, with a priority-coloured bar and a button that
opens the ticket.

### Microsoft Teams

In Teams: channel → **⋯** → **Workflows** → *Post to a channel when a webhook
request is received*. Paste the generated URL.

Microsoft is retiring the older Office 365 connectors in favour of Workflows,
and the two accept different payloads. Escalation Pro detects which one your URL
needs from its host and sends an Adaptive Card or a MessageCard accordingly. You
can override the choice if detection gets it wrong.

### Linear

Create a personal API key at Linear → Settings → API, then choose the Linear
team that mirrored issues should be filed against.

- Ticket priority maps onto Linear's scale (urgent → 1, high → 2, and so on).
- The issue description links back to the ticket, and public replies are
  mirrored as Linear comments.
- Set a **webhook secret** and point a Linear webhook at
  `https://your-host/api/webhooks/linear` to sync issue status back. Deliveries
  are verified with an HMAC-SHA256 signature; unsigned requests are rejected.

### Email (SMTP)

Standard SMTP with STARTTLS on port 587 or implicit TLS on port 465. Notifies
the assignee, the requester, and anyone watching the ticket.

### Delivery log

Every outbound notification is recorded with its status code and any error, and
the last 60 are shown at the bottom of the Integrations page. An integration
failure never blocks a ticket update — it is logged and the update proceeds.

---

## Reports

The Reports page covers open and overdue volume, workload per assignee and per
team, created-versus-resolved volume over time, average first response, average
resolution, and SLA compliance.

**Export XLSX** produces a real workbook with three sheets — Tickets, Comments,
and History — scoped to the selected window and to what you have permission to
see.

---

## Project layout

```
server/
  index.ts              Express app, middleware, static serving
  config.ts             Environment and paths
  bootstrap.ts          First-administrator creation
  permissions.ts        Roles and the permission catalogue
  db/
    driver.ts           SQLite and PostgreSQL drivers behind one interface
    schema.ts           Portable schema, applied on boot
    seed.ts             Demo data
  routes/               One module per resource
  repositories/         Data access
  integrations/         Slack, Microsoft Teams, Linear, SMTP, dispatcher
  jobs/sla-monitor.ts   Periodic breach detection
shared/types.ts         Types shared by the API and the client
src/                    React client (Vite, Tailwind, React Router)
```

### Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Dev server with hot reload on one port |
| `npm run build` | Build the client and the server |
| `npm start` | Run the production build |
| `npm run seed` | Load demo data (no-op if users already exist) |
| `npm run reset` | Delete the local database and re-seed |
| `npm run typecheck` | Type-check client and server |

---

## Security

[SECURITY.md](SECURITY.md) covers the threat model, the test suites, and the
known limitations. In short:

- Passwords are hashed with scrypt (N=16384) and a per-user salt.
- Sessions live in the database, not in process memory, so they survive
  restarts and work across multiple instances. The session ID is rotated on
  sign-in to prevent fixation.
- Suspending a user, deleting them, or resetting their password ends their
  sessions immediately. Changing your own password ends your *other* sessions
  but keeps the one you are using.
- Integration credentials are encrypted at rest and are never returned to the
  browser — the UI receives only a masked preview.
- Uploads are restricted to an allow-list of types, stored under generated
  names, and served with `X-Content-Type-Options: nosniff`. SVGs are always
  sent as downloads rather than rendered inline.
- The system refuses to remove or demote the last active administrator.
- Every privileged action is written to an append-only audit log with the
  actor, a summary, and the source IP.
- Login is rate limited (5 failures per account, 30 per IP, per 15 minutes) and
  does not leak which accounts exist through response timing.
- All SQL is parameterised; admin-configurable webhook URLs are checked against
  private and link-local address ranges before they are saved.

## Troubleshooting

**Port 3000 is in use** — start with `PORT=3001 npm run dev`.

**Signing in does nothing, or the session drops immediately** — almost always
`SESSION_COOKIE_SECURE=true` on a plain-HTTP origin. Set it to `false` unless
you are behind HTTPS.

**"Could not connect to PostgreSQL"** — the message includes the underlying
reason. Unset `DATABASE_URL` to fall back to SQLite and confirm the rest of the
app works first.

**An integration test fails** — the error text comes straight from the
provider. `invalid_token` means the credential is wrong; a timeout usually means
egress to that host is blocked.

**"That setup token is not correct"** — `SETUP_TOKEN` is set in the
environment and must be entered on the setup screen. Read it from your `.env`
or container config; clear the variable and restart if you want setup open.

**Locked out by the login rate limit** — wait out the window shown in the
error (15 minutes), or clear the counter with
`DELETE FROM login_attempts WHERE key LIKE 'account:%';`.

**Lost the only administrator password** — stop the app, set
`BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`, and start it against an
empty database; or reset the password directly in the `users` table.
