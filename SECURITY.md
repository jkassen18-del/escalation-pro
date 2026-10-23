# Security

This documents how the system defends itself, what was tested, and what is
deliberately left to the operator.

## Test suites

| Suite | Checks | Covers |
| --- | --- | --- |
| Adversarial | 117 | Injection, authz, traversal, enumeration, abuse |
| Functional API | 72 | Behaviour on SQLite and PostgreSQL |
| Integrations | 43 | Provider payloads, secret handling, failure paths |
| Setup flow | 15 | Open and token-protected first-run |
| Placeholder rewriter | 7 | Postgres parameter binding |

## Injection

**SQL injection is structurally prevented, not filtered.** Every query uses
bound parameters; no user input is ever concatenated into SQL.

The three statements that build SQL dynamically
(`UPDATE users|teams|tickets SET ...`) compose column names exclusively from
hardcoded string literals, with values bound separately. `IN (...)` clauses are
built by a helper that emits only `?` characters, counted from the array length.

PostgreSQL requires `$1..$n` rather than `?`, so a rewriter translates them. A
fault there could bind values to the wrong columns, so it is unit-tested against
quoted literals, escaped quotes, and `?` characters inside string constants.

Tested and rejected: authentication bypass (`' OR '1'='1`, `admin'--`, stacked
`; DROP TABLE`, `UNION SELECT`), boolean-oracle probes against search, and
second-order injection (storing a payload, then reading it back). Tables were
confirmed intact after every `DROP` attempt.

**Cross-site scripting.** The API is JSON-only and never renders user content
into HTML. React escapes by default, and the client contains no
`dangerouslySetInnerHTML`, no `innerHTML`, and no `eval`. Stored script payloads
round-trip as inert text.

**Path traversal.** Attachment filenames never come from the request. The URL
carries an attachment id, which is looked up in the database; the on-disk name is
a server-generated UUID read from that row. A resolved-path check inside the
uploads directory backs this up. Uploads are restricted to an allow-list of MIME
types, served with `X-Content-Type-Options: nosniff`, and SVGs are always sent as
downloads rather than rendered inline.

## Authentication

- Passwords hashed with scrypt (N=16384, r=8, p=1) and a per-user salt;
  comparison is constant-time.
- **Login is rate limited** in the database: 5 failures per account and 30 per
  client IP in a 15-minute window, returning `429` with `Retry-After`. The
  lockout applies before the password is checked, so a locked-out attacker gains
  nothing — including timing information — and the correct password does not
  bypass it. Counters live in the database, so the limit holds across restarts
  and across instances. The client IP comes from `X-Forwarded-For`
  with one proxy hop trusted (`TRUST_PROXY`, default 1), which is right behind
  exactly one reverse proxy. Exposed directly, a client could set that header
  itself and dodge the per-IP limit, so set `TRUST_PROXY=0` there; the portable
  exe does this by default. The per-account limit applies either way.
- **No username enumeration.** A miss runs scrypt against a dummy hash so an
  unknown account costs the same as a known one. Measured at 1.06× (it was 16×
  before this was fixed).
- Session IDs are rotated on sign-in to prevent fixation.
- Sessions are stored in the database, not in memory, and are invalidated
  immediately when an account is suspended, deleted, or has its password reset.
  Changing your own password ends your other sessions but keeps the current one.

## Authorisation

Every route enforces permissions server-side. The UI hiding a control is a
convenience, never the boundary.

Access is permission-based: about fifty permissions, one per capability (see
`server/permissions.ts` and [docs/roles-and-permissions.md](docs/roles-and-permissions.md)).
Roles are rows in the `roles` table; a person holds their role's permissions
plus any extras granted to them. Administrator always holds every permission.
The same checks run for the web app, the MCP connector and the Slack, Teams,
Discord and Linear actions that act as a person.

Verified by test:

- An agent cannot read or modify a ticket outside their departments, and such
  tickets are absent from their list view, counts, reports, exports, alerts
  and pages (a page ringing them excepted). A Slack button or "done" reply
  from someone outside the ticket's department changes nothing.
- An agent cannot promote themselves, grant themselves permissions, or create an
  administrator.
- A manager cannot promote themselves to administrator, create one, or read
  integration credentials.
- Nobody can grant a permission they do not hold, as an extra or by putting it
  in a role, or give someone a role that holds one; only an administrator can
  grant the administrator-only ones (everything the built-in Manager role does
  not start with, such as `settings.manage`, `integrations.manage`,
  `roles.manage`, `backups.*`, `tickets.delete`, `users.delete`).
- A custom role's permissions are enforced route by route (allowed and 403).
- Only an administrator can edit, suspend, reset the password of, or delete an
  administrator account, or assign the Administrator role.
- An on-call page can only be acknowledged or escalated by someone it reached
  (with `pages.respond`), by a holder of `oncall.manage`, or by a holder of
  `oncall.manage_own_department` in the ticket's department.
- On-call schedules and overrides for others can be changed only by holders of
  `oncall.manage`, of `oncall.manage_own_department` for their own
  departments' schedules, or by a department's managers for that department.
- Invite links are the only self sign-up. The token is 192 random bits, stored
  as a SHA-256 hash and shown once; it can only create an account with the
  invite's role, which its creator must have been able to grant, as a plain
  member of one of the invite's departments, with an email on its allowed
  domains. Uses are claimed atomically (racing sign-ups cannot exceed the
  limit), the public endpoints are rate limited per IP, and expired, used-up,
  revoked and unknown links all give the same answer.
- Attachments follow the ticket's visibility for upload, download and delete,
  and files on an internal note are hidden from anyone who cannot read
  internal notes. The XLSX export covers only the tickets the exporter can see
  and leaves out internal notes for people without `tickets.comment_internal`.
- A viewer cannot see internal notes.
- Unauthenticated requests are rejected on every API route except sign-in,
  first-run setup, branding, and opening or accepting an invite link.
- `createdBy` cannot be spoofed through the request body.

The system refuses to remove, suspend, or demote the last active administrator.

## Secrets

Integration credentials (Slack tokens, Linear API keys, SMTP passwords, webhook
URLs) are encrypted with AES-256-GCM before storage, using a random IV per
value. They are never returned to the browser — the UI receives only a masked
preview such as `xoxb••••alue` — and are never written to the audit log.

Monitoring secrets are the exception: alert-source ingest URLs and heartbeat
URLs carry their token, and HTTP monitors keep their request headers and body.
Holders of `monitors.manage` see them in full so they can copy them into the
sending tool; everyone else, in the API and over MCP, gets them masked
(header names stay visible, credentials in a monitor's target URL are removed).

## Outbound requests (SSRF)

Administrator-configurable webhook URLs are validated on save: HTTPS only, and
rejected if the host as written is localhost, a private range (10/8, 172.16/12,
192.168/16, 127/8), link-local `169.254/16` (which covers cloud metadata
endpoints), IPv6 loopback and unique-local, or multicast. Slack webhooks are
additionally pinned to `hooks.slack.com`.

The check looks at the hostname as typed; it does not resolve DNS. A public
name that resolves to a private address, or that changes its answer between
the check and the request (DNS rebinding), is not caught. Restrict egress at
the network if administrators are not fully trusted.

Inbound Linear webhooks are verified with an HMAC-SHA256 signature over the raw
request body; unsigned or mismatched deliveries are rejected.

## Operations endpoints

The monitoring, paging and backup modules add endpoints that machines call
without a session. Each one carries its own proof:

- **Alert intake** (`/api/ingest/<token>`) and **heartbeats**
  (`/api/heartbeat/<token>`): a 24- or 18-byte random token in the URL, one per
  source or monitor, rotatable from the UI. AWS SNS messages are additionally
  verified against SNS's own signature, with the signing certificate fetched
  only from an `sns.*.amazonaws.com` host, and subscriptions are confirmed only
  against that host.
- **Twilio callbacks**: every request must carry a valid `X-Twilio-Signature`
  over the configured *App URL*, so the URL is rebuilt rather than trusted from
  `Host`. Voice callbacks also carry an HMAC token bound to the one call
  attempt, so an acknowledgement cannot be forged by guessing ids.
- **Status pages**: public pages are public by design and expose labels and
  states only, never monitor targets or ids. Internal pages need a session.
  Updates are typed for the page and never derived from ticket comments.

Monitors may target private and internal addresses: watching the company's
own network is the point. Only holders of `monitors.manage` can create them.

**Backups** hold copies of production data, so:

- Connection strings are encrypted at rest and never returned by the API.
- Each backup is encrypted with its own random AES-256-GCM key, wrapped with
  the server's `SECRET_KEY`. The storage bucket alone does not reveal anything,
  and GCM authentication rejects a tampered or truncated file on restore.
- Downloading a decrypted backup needs `backups.restore` (administrators by
  default) and is written to the audit log.
- `SECRET_KEY` (or, without it, `data/.session-secret`) is now also the key to
  every backup. Back it up separately from the backups themselves.

## Single sign-on

SAML 2.0 sign-in (Microsoft Entra ID or any SAML provider) is set up under
*Settings → Single sign-on*; see [SSO.md](SSO.md). The signature checks,
audience, conditions and clock-skew handling come from
`@node-saml/node-saml`. On top of that, this app requires the following:

- **Signed assertions.** The assertion itself must carry a valid signature from
  the configured certificate. An unsigned assertion, one inside a signed
  response, or one signed by any other key is refused.
- **Audience.** The assertion must be addressed to this app's entity ID.
- **A request of ours.** Every response must answer a sign-in request this app
  issued (`InResponseTo`), within 10 minutes. The request ids are stored in the
  database, so this holds across instances.
  - IdP-initiated sign-in (starting from *My Apps*) is therefore not
    supported. It is the usual route for a login-CSRF attack. Users start from
    the app's own sign-in button, or from the *Sign on URL*, which forwards
    them through a fresh request.
- **No replays.** Each assertion id is accepted once, and assertions older than
  10 minutes are refused. Clock skew of up to 2 minutes is tolerated.
- **Only same-site paths in RelayState.** The return path survives the round
  trip only when it is a path on this site, so it cannot become an open
  redirect.
- **Sessions.** A successful sign-in rotates the session id exactly as a
  password sign-in does. Every sign-in, refusal, account creation and
  role change is written to the audit log.
- **Provisioning is off by default.** Only existing accounts (matched by email)
  can sign in until an administrator enables just-in-time creation. Accounts it
  creates get an unusable random password.
- **Group-to-role mappings never change an administrator**, and *require SSO*
  never applies to administrators. A broken identity provider or a bad mapping
  therefore cannot lock everyone out.
- **The metadata import** fetches only public https addresses (the same guard
  as outbound webhooks). SSO configuration is stored outside the general
  settings, so it is never returned by `GET /api/settings`.

Team links (*Teams → Links to other systems*) accept https URLs only, so a
`javascript:` or `data:` link cannot run in this app's origin.

## First-run setup

Setup is open by default, which suits a laptop or an internal network. On a
public URL that is a land grab — whoever loads the page first becomes the
administrator.

Set `SETUP_TOKEN` before exposing the app. The setup screen then asks for it,
compares it in constant time, records rejected attempts in the audit log, and
creates nothing without it. Setup closes permanently once any user exists and
cannot be replayed, with or without a valid token.

## AI connectors (MCP)

`/mcp` lets Claude and other MCP clients act as a signed-in person. The full
design is in [CLAUDE_CONNECTOR.md](CLAUDE_CONNECTOR.md#security-notes); the
points that matter for review:

- **Same authority as the person, never more.** Each request reloads the user
  (suspended users are refused at once) and every tool checks the same
  permissions and ticket visibility as the web routes. Writes additionally need
  a read-and-write token or grant *and* the organisation not set to read-only.
  Writes go through the same services as the web app and are audited as
  "*name* via Claude" with `meta.via = "mcp"` and the client's name.
- **Credentials are hashed.** Personal access tokens (`itk_`), OAuth access
  (`ita_`) and refresh (`itr_`) tokens, authorization codes and confidential
  client secrets (`its_`) are stored as SHA-256 hashes of 32 random bytes.
  Tokens are accepted only in the `Authorization: Bearer` header or (personal
  tokens only) `X-InfraTicket-Token`, never in a query string.
- **OAuth 2.1.** Authorization code with PKCE S256 (required for public
  clients), 60-second single-use codes (replay revokes the grant), one-hour
  access tokens, rotating refresh tokens with reuse detection, and RFC 8707
  audience binding to this server's `/mcp` URL. Unknown clients and
  unregistered redirect URIs get an error page, never a redirect. Dynamic
  registration is public-clients-only and rate-limited; metadata-document
  client IDs are fetched through the SSRF guard. Confidential clients are
  created only by administrators.
- **Browser isolation.** `/mcp` sends no CORS headers and rejects foreign
  `Origin`s (DNS rebinding). The OAuth and discovery endpoints allow any origin
  but never with credentials, since none of them read cookies. The consent
  screen is a same-origin page behind the normal session.
- **Rate limit.** 120 MCP requests a minute per credential, in memory per
  instance (`MCP_RATE_LIMIT_PER_MIN`).
- **Prompt injection** is the residual risk: ticket text is attacker-writable
  and an assistant reads it. Write tools are annotated so clients confirm
  them, nothing deletes, and administrators can make every connection
  read-only.

## Known limitations

These are deliberate scope decisions, not oversights.

- **No CSRF tokens.** Protection relies on `SameSite=Lax` session cookies,
  which browsers do not send on cross-site POST/PATCH/DELETE, plus the fact
  that every state-changing route uses one of those methods. Routes do not
  insist on a JSON content type (uploads are multipart, and some actions take
  no body), so the cookie attribute is the whole defence. This is sound for
  current browsers. A defence-in-depth CSRF
  token would be the next addition if the app is exposed to untrusted networks.
- **No multi-factor authentication.** Front the deployment with an identity
  provider (Cloudflare Access, Entra ID, Okta) if you need it.
- **No Content-Security-Policy header.** Worth adding behind a reverse proxy.
- **Audit log is append-only by convention**, not enforced at the database level.
- **Rate limiting covers login, OAuth client registration and `/mcp` only.**
  Other endpoints are unthrottled and assume authenticated, semi-trusted users.
- **Administrators are trusted.** An administrator can configure outbound
  webhooks and read all data by design; the SSRF guard limits the blast radius
  of a mistake or a stolen session, but does not make the role safe to hand out.

## Reporting

Open a private security advisory on the repository rather than a public issue.
