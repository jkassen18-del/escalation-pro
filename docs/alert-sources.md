# Alert sources (webhooks)

An alert source is a URL your monitoring tools POST to. Each source belongs to a department, has a default severity and its own secret URL, and understands its provider's payload, so an AWS alarm, an Azure alert and a Grafana notification all become the same kind of alert in InfraTicket.

Create one under *Monitoring → Alert sources → New*, or from a tile on [Integrations](integrations.md), which shows the provider's own steps and a *Send a test alert* button (permission `monitors.manage`).

[Open alert sources](/monitors)

## The webhook URL

```text
https://tickets.example.com/api/ingest/<token>
```

- The token is the only credential. *⋯ → Issue a new URL* replaces it; the old URL stops working at once.
- Send `POST` with a JSON body. Bodies sent as `text/plain` or without a content type are parsed as JSON too, and a body that is not JSON becomes the alert's title and message. Up to 1 MB.
- A JSON array is treated as a batch of alerts.
- The answer is `202` with what happened to each alert:

```json
{ "accepted": 1, "results": [{ "action": "created", "ticketId": "…" }] }
```

`action` is one of `created`, `grouped`, `deduplicated`, `resolved`, `ignored` (a resolve for an alert that was not open) or `suppressed` (held back by maintenance or dropped by a rule).

The tools have to reach this URL. From the internet, that means a public https address; see [Exposing only the webhook paths](lab-server.md#exposing-only-the-webhook-paths).

## Source fields

| Field | Meaning |
| --- | --- |
| **Name** | Shown on alerts and incidents |
| **Type** | The provider (below) |
| **Team** | The department whose policy pages |
| **Default severity** | Used when the payload has none |
| **Escalation policy** | Overrides the department's default |
| Field mapping (generic types) | Dot paths into the payload for title, summary, severity, status and dedup key |
| **Status values that mean resolved** | Overrides the default list |
| **Enabled** | Untick to refuse deliveries (404) |

## Providers

### AWS CloudWatch / SNS

1. AWS console → **Simple Notification Service → Topics** → create a Standard topic, e.g. `infraticket-alerts`.
2. **Create subscription** → Protocol **HTTPS** → Endpoint: the webhook URL. InfraTicket confirms the subscription automatically.
3. Point your CloudWatch alarms' **alarm** and **OK** actions at the topic. For AWS Health, add an EventBridge rule (source `aws.health`) targeting the topic.

Every SNS message's signature is verified, with the signing certificate fetched only from an `sns.<region>.amazonaws.com` host. A CloudWatch `OK` state resolves the alert. AWS Health `issue` events are SEV2, others SEV4; `closed` resolves.

### Azure Monitor

1. Azure portal → **Monitor → Alerts → Action groups** → create or edit one.
2. **Actions → Webhook** → paste the URL and set **Enable the common alert schema** to *Yes*.
3. Attach the action group to your alert rules.

Azure severities map Sev0→SEV1, Sev1→SEV2, Sev2→SEV3, Sev3/Sev4→SEV4. `Resolved` resolves.

### Grafana and Prometheus Alertmanager

- **Grafana**: Alerting → **Contact points → New** → Integration **Webhook** → the URL. Use it in a notification policy.
- **Alertmanager**:

```yaml
receivers:
  - name: infraticket
    webhook_configs:
      - url: https://tickets.example.com/api/ingest/<token>
        send_resolved: true
```

Each alert in a batch becomes its own alert, keyed by its fingerprint. The `severity` label sets severity; `resolved` resolves.

### Jenkins

Install the free **Notification** plugin and add an endpoint: Format **JSON**, Protocol **HTTP**, Event **Job Finalized**, the URL. Or add a post-build step:

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"name":"'"$JOB_NAME"'","build":{"status":"FAILURE","full_url":"'"$BUILD_URL"'"}}' \
  https://tickets.example.com/api/ingest/<token>
```

A failing job opens an incident; the next `SUCCESS` for the same job resolves it. `UNSTABLE` is SEV3.

### Cloudflare

1. Dashboard → **Notifications → Destinations → Webhooks → Create**, paste the URL, save.
2. **Notifications → Add**: choose the events (origin errors, tunnel health, health checks, DDoS) and the webhook destination.

Text containing *resolved*, *recovered* or *healthy* resolves.

### DigitalOcean

DigitalOcean alert policies notify only by email or Slack, so forward them with a small script or relay that POSTs JSON to the URL, using the generic format below.

### Entra ID / Microsoft 365

Create a Logic App (consumption plan) or a Power Automate flow triggered by the alert or service-health event, with an **HTTP** action: `POST`, the URL, and a body with `title`, `severity` and `status`.

### Stratigix

Configure Stratigix to POST its alerts as JSON to the URL. If title, severity and status are not detected automatically, map them with JSON paths in the source.

### Generic webhook

Anything that can POST JSON:

```bash
curl -X POST https://tickets.example.com/api/ingest/<token> \
  -H "Content-Type: application/json" \
  -d '{"title":"Disk full on db-1","severity":"critical","status":"firing","dedup_key":"db-1-disk","description":"/var at 97%"}'
```

Send the same `dedup_key` with `"status":"resolved"` to close it.

When no mapping is set, these fields are looked for, first match wins:

| Alert field | Payload keys tried |
| --- | --- |
| Title | `title`, `summary`, `name`, `subject`, `message`, `alert`, `event` |
| Summary | `description`, `details`, `message`, `text`, `body` |
| Severity | `severity`, `priority`, `level` |
| Status | `status`, `state`, `event_type` |
| Dedup key | `dedup_key`, `dedupKey`, `fingerprint`, `id`, `alert_id`, `incident_key` (else the title) |

Mappings are dot paths such as `alert.labels.severity` or `items[0].name`.

**Severity words** (case-insensitive):

| Becomes | Values |
| --- | --- |
| SEV1 | `sev1`, `critical`, `crit`, `emergency`, `fatal`, `disaster`, `p1`, `sev0`, `0` |
| SEV2 | `sev2`, `error`, `major`, `high`, `p2`, `1` |
| SEV3 | `sev3`, `warning`, `warn`, `minor`, `medium`, `average`, `p3`, `2` |
| SEV4 | `sev4`, `info`, `information`, `informational`, `low`, `notice`, `ok`, `p4`, `p5`, `3`, `4` |

Anything else uses the source's default severity.

**Resolved words** by default: `resolved`, `ok`, `recovered`, `success`, `closed`, `inactive`, `normal`. Anything else means firing.

## Testing

*⋯ → Send test alert* pushes a sample through the real pipeline, so you see the ticket it opens and who it pages. Use a SEV4 default severity if you do not want to wake anyone while testing.
