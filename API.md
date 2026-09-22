# The HTTPS API

Anything that can make an HTTPS request can raise a ticket: a monitoring
tool, a cron job, a form on an intranet page, a script on a laptop.

Base path: `/api/v1`. Versioned from the first release, because the callers
are other people's systems and cannot be changed in step with this one.

## Getting a key

**Settings → API keys → Create key.** The token is shown **once** and is not
recoverable — it is stored only as a SHA-256 hash, the way a password is.

A key can never hold more than the person who created it held, and that is
re-checked on every call: if the owner's access is reduced or their account
is suspended, the key stops working. Revoking is immediate.

## Authenticating

```
Authorization: Bearer itk_a1b2c3d4_...
```

`X-API-Key: itk_...` also works, for tools that cannot set an Authorization
header. Rejected keys are rate limited per address, so the endpoint cannot be
used to guess one at speed.

## Raising a ticket

```bash
curl -X POST https://tickets.example.internal/api/v1/tickets \
  -H "Authorization: Bearer $INFRATICKET_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
        "subject": "Disk usage above 90% on db-01",
        "description": "Threshold breached at 14:02 UTC.",
        "team": "it",
        "priority": "urgent",
        "type": "incident",
        "tags": ["disk", "db-01"],
        "dedupeKey": "disk-db-01"
      }'
```

```json
{
  "ticket": {
    "reference": "ESC-1001",
    "subject": "Disk usage above 90% on db-01",
    "status": "open",
    "priority": "urgent",
    "team": "IT Support",
    "dueAt": "2026-09-23T14:02:00.000Z"
  }
}
```

`201` with a `Location` header for a new ticket.

| Field | Required | Notes |
|---|---|---|
| `subject` | yes | Max 200 characters |
| `description` | no | Plain text |
| `team` | no | Department **id, key or name** — `it`, `IT`, `IT Support` all work. Falls back to the key's default department, then the system default. |
| `priority` | no | `urgent`, `high`, `normal`, `low` |
| `type` | no | `incident`, `request`, `question`, `problem`, `escalation`. Defaults to `incident`. |
| `tags` | no | Up to 20 strings |
| `fields` | no | Answers to the department's intake form, keyed by field key |
| `dedupeKey` | no | See below |

`GET /api/v1/teams` lists the departments, so a caller never has to guess.

## Deduplication — read this before wiring up a monitor

Monitoring tools retry on timeouts and re-fire while a condition persists.
Without deduplication, one flapping disk fills the queue with hundreds of
identical tickets.

Send a stable `dedupeKey` (or an `Idempotency-Key` header). While a ticket
raised with that key is **still open**, a repeat:

- does **not** create a second ticket
- returns `200` instead of `201`, with `"deduplicated": true`
- appends the new `description` to the existing ticket as a comment, so
  nothing is lost

Once the ticket is **resolved or closed**, the same key opens a new one — the
condition coming back after it was dealt with is a new incident, not a
continuation of the old one.

Pick a key that identifies the *condition*, not the occurrence:
`disk-db-01`, not `disk-db-01-2026-09-22T14:02`.

## Other endpoints

| | |
|---|---|
| `GET /api/v1/whoami` | What the key is and who it acts as. The cheapest way to check one works. |
| `GET /api/v1/teams` | The departments a ticket can be raised against. |
| `GET /api/v1/tickets/{reference}` | One ticket, e.g. `ESC-1001`. |
| `POST /api/v1/tickets/{reference}/comments` | Add a comment. Body: `{"body": "..."}` |

## Errors

Always JSON, always `{"error": "..."}`, and the message says what to do.

| Status | Means |
|---|---|
| `400` | Bad input. Unknown department errors name `GET /api/v1/teams`. |
| `401` | No key, wrong key, revoked, expired, or the owner is no longer active. Revoked and expired say which. |
| `403` | The key lacks the scope for this call. |
| `404` | No such ticket. |
| `429` | Too many rejected keys from this address. Honour `Retry-After`. |

## Worth knowing

- Everything raised this way is recorded with `source: api` and attributed in
  the audit trail to the key by name, so you can tell what a given
  integration has been doing.
- A ticket raised over the API goes through exactly the same path as one
  raised on the web: the department's SLA, auto-assignment, escalation, and
  the fan-out to Slack, Teams, Linear and email.
- The API is mounted ahead of the session middleware, so a browser cookie is
  never accepted here. A key is the only way in.
