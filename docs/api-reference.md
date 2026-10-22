# API and webhooks

Everything the web app does goes through a JSON API under `/api`. This page lists the endpoints that are useful from outside: the machine endpoints (alerts, heartbeats, status, cron, chat webhooks) and the signed-in REST API.

## Health

```bash
curl -s https://tickets.example.com/health
# 200 {"status":"ok","database":"postgres","uptime":4231}
# 503 {"status":"degraded","database":"postgres","error":"…"}
```

No authentication. Point an external uptime check at it.

## Machine endpoints

Each carries its own proof instead of a session.

| Method | Path | Proof | Purpose |
| --- | --- | --- | --- |
| POST | `/api/ingest/<token>` | Token in the URL | Send an alert ([Alert sources](alert-sources.md)) |
| any | `/api/heartbeat/<token>` | Token in the URL | Heartbeat ping ([Heartbeats](monitoring.md#heartbeats)) |
| any | `/api/heartbeat/<token>/fail` | Token in the URL | Report a failed run |
| GET | `/status/<slug>` | None (public pages) | Status page HTML |
| GET | `/api/public/status/<slug>` | None (public pages) | Status page JSON |
| POST, GET | `/api/cron/ops` | `Authorization: Bearer $CRON_SECRET` | Run monitors, paging, maintenance and backups once |
| POST, GET | `/api/cron/sla` | `Authorization: Bearer $CRON_SECRET` | Run the SLA breach sweep once |
| POST | `/api/webhooks/slack` | Slack signing secret | Slack events |
| POST | `/api/webhooks/slack/interactive` | Slack signing secret | Slack buttons and modals |
| POST | `/api/webhooks/slack/commands` | Slack signing secret | `/gml` |
| POST | `/api/webhooks/msteams` | Microsoft Bot Framework JWT | Teams bot |
| POST | `/api/webhooks/msteams/calling` | Microsoft calling JWT | Teams call events |
| POST | `/api/webhooks/linear` | `Linear-Signature` HMAC | Linear issues and comments |
| POST | `/api/webhooks/telephony/twilio/sms` | `X-Twilio-Signature` | Inbound SMS (`ACK`) |
| POST | `/api/webhooks/telephony/twilio/voice` | `X-Twilio-Signature` + per-call token | Call progress and keypresses |
| GET | `/api/public/teams-call-prompt/<file>` | Unguessable file name | The WAV Teams plays |
| GET | `/api/ops/push/key` | None | Public half of the push key |
| GET | `/api/auth/saml/metadata`, `/api/auth/saml/login`; POST `/api/auth/saml/acs` | SAML | Single sign-on |
| any | `/mcp` | Bearer token | AI connector ([AI assistants](ai-connector.md)) |

### Sending an alert

```bash
curl -X POST https://tickets.example.com/api/ingest/<token> \
  -H "Content-Type: application/json" \
  -d '{"title":"Disk full on db-1","severity":"critical","status":"firing","dedup_key":"db-1-disk"}'
# 202 {"accepted":1,"results":[{"action":"created","ticketId":"…"}]}
```

Resolve it by sending the same `dedup_key` with `"status":"resolved"`. A wrong or disabled token answers `404`.

### Reading a status page

```bash
curl -s https://tickets.example.com/api/public/status/shop
```

## The signed-in REST API

The REST API uses the **browser session cookie** (`escalation.sid`); there are no API keys for it. For scripts, prefer:

- [Alert sources](alert-sources.md) to open incidents,
- [Custom HTTP](custom-http.md) to receive ticket events,
- the [AI connector](ai-connector.md) (`/mcp`, with personal access tokens) to read and change tickets programmatically.

If you do script the REST API, sign in as a dedicated account and keep the cookie:

```bash
curl -c jar.txt -H "Content-Type: application/json" \
  -d '{"login":"automation@example.com","password":"…"}' \
  https://tickets.example.com/api/auth/login

curl -b jar.txt "https://tickets.example.com/api/tickets?status=open&priority=urgent"

curl -b jar.txt -H "Content-Type: application/json" \
  -d '{"subject":"Printer on 3rd floor offline","description":"Shows error 50.4","teamId":"<team id>","priority":"normal","type":"request"}' \
  https://tickets.example.com/api/tickets
```

Every request is checked against the account's permissions, and sign-in is rate limited.

### Endpoints

All under `/api`, JSON in and out. Errors are `{"error":"…"}` with a 4xx or 5xx status.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password`, `PATCH /auth/me/phone` |
| Tickets | `GET /tickets` (filters: `status`, `priority`, `type`, `teamId`, `assignee`, `unassigned`, `overdue`, `search`, `sort`, `offset`), `GET /tickets/counts`, `GET /tickets/:id`, `POST /tickets`, `PATCH /tickets/:id`, `DELETE /tickets/:id`, `POST /tickets/:id/comments`, `POST /tickets/:id/escalate`, `POST /tickets/:id/watch`, `POST /tickets/:id/push-to-linear` |
| Attachments | `POST /tickets/:id/attachments` (multipart), `GET /tickets/:id/attachments/:attachmentId`, `DELETE …` |
| Quick tickets | `GET /ticket-templates`, `POST /ticket-templates/:id/tickets`, plus create, update, delete |
| Teams | `GET /teams`, `GET /teams/:id`, `POST /teams`, `PATCH /teams/:id`, `DELETE /teams/:id`, `GET/PUT /teams/:id/form`, `GET/PUT /teams/:id/routing`, `GET /teams/forms/all` |
| People | `GET /users`, `GET /users/directory`, `GET /users/:id`, `POST /users`, `PATCH /users/:id`, `POST /users/:id/reset-password`, `DELETE /users/:id` |
| Reports | `GET /reports/summary`, `GET /reports/export` (XLSX) |
| Audit | `GET /audit` |
| Notifications | `GET /notifications`, `POST /notifications/read` |
| Settings | `GET /settings`, `PATCH /settings`, `GET /branding`, `PUT/DELETE /branding/logo` |
| Integrations | `GET /integrations`, `GET /integrations/catalogue`, `GET /integrations/deliveries`, `PATCH /integrations/:provider`, `POST /integrations/:provider/test`, custom HTTP under `/integrations/http` |
| Lookups | `GET /data-sources`, `GET /data-sources/:id/lookup?q=…`, plus create, update, test, delete |
| Operations | Under `/ops`: `overview`, `monitors`, `alerts`, `alert-sources`, `alert-rules`, `maintenance`, `schedules`, `policies`, `team-policies`, `pages` (`/pages/:id/ack`, `/pages/:id/escalate`), `me/rules`, `telephony`, `teams-calls`, `status-pages`, `databases`, `backup-runs/:id/download` |
| Discord | `GET /discord/me`, `POST /discord/link`, `DELETE /discord/link` |
| AI connector | Under `/connector`: `info`, `settings`, `tokens`, `apps`, `clients` |

The API is what the web app uses and may change between releases; the machine endpoints above are the stable ones.
