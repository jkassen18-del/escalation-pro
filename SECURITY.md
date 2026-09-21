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
  IP address in a 15-minute window, returning `429` with `Retry-After`. The
  lockout applies before the password is checked, so a locked-out attacker gains
  nothing — including timing information — and the correct password does not
  bypass it. Counters live in the database, so the limit holds across restarts
  and across instances.
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

Verified by test:

- An agent cannot read or modify a ticket outside their teams, and such tickets
  are absent from their list view.
- An agent cannot promote themselves, grant themselves permissions, or create an
  administrator.
- A manager cannot promote themselves to administrator, create one, or read
  integration credentials.
- A viewer cannot see internal notes.
- Unauthenticated requests are rejected on every API route.
- `createdBy` cannot be spoofed through the request body.

The system refuses to remove, suspend, or demote the last active administrator.

## Secrets

Integration credentials (Slack tokens, Linear API keys, SMTP passwords, webhook
URLs) are encrypted with AES-256-GCM before storage, using a random IV per
value. They are never returned to the browser — the UI receives only a masked
preview such as `xoxb••••alue` — and are never written to the audit log.

## Outbound requests (SSRF)

Administrator-configurable webhook URLs are validated on save: HTTPS only, and
rejected if they resolve to localhost, private ranges (10/8, 172.16/12,
192.168/16, 127/8), link-local `169.254/16` (which covers cloud metadata
endpoints), IPv6 loopback and unique-local, or multicast. Slack webhooks are
additionally pinned to `hooks.slack.com`.

Inbound Linear webhooks are verified with an HMAC-SHA256 signature over the raw
request body; unsigned or mismatched deliveries are rejected.

## First-run setup

Setup is open by default, which suits a laptop or an internal network. On a
public URL that is a land grab — whoever loads the page first becomes the
administrator.

Set `SETUP_TOKEN` before exposing the app. The setup screen then asks for it,
compares it in constant time, records rejected attempts in the audit log, and
creates nothing without it. Setup closes permanently once any user exists and
cannot be replayed, with or without a valid token.

## Known limitations

These are deliberate scope decisions, not oversights.

- **No CSRF tokens.** Protection relies on `SameSite=Lax` cookies plus the fact
  that every state-changing route is POST/PATCH/DELETE and requires a JSON
  content type. This is sound for current browsers. A defence-in-depth CSRF
  token would be the next addition if the app is exposed to untrusted networks.
- **No multi-factor authentication.** Front the deployment with an identity
  provider (Cloudflare Access, Entra ID, Okta) if you need it.
- **No Content-Security-Policy header.** Worth adding behind a reverse proxy.
- **Audit log is append-only by convention**, not enforced at the database level.
- **Rate limiting covers login only.** Other endpoints are unthrottled and
  assume authenticated, semi-trusted users.
- **Administrators are trusted.** An administrator can configure outbound
  webhooks and read all data by design; the SSRF guard limits the blast radius
  of a mistake or a stolen session, but does not make the role safe to hand out.

## Reporting

Open a private security advisory on the repository rather than a public issue.
