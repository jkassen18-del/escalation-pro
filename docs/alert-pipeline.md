# The alert pipeline and routing rules

Signals come in from three places: built-in [monitors](monitoring.md), [alert sources](alert-sources.md) (webhooks), and [heartbeats](monitoring.md#heartbeats). Each becomes an **alert**; the pipeline decides whether it opens an **incident ticket** and whom it **pages**.

```text
 monitors ─┐                                    ┌─> incident ticket ─> Slack / Teams / Discord / Linear / email
 webhooks ─┼─> normalise ─> dedupe ─> rules ─> group ┤
heartbeats ┘   (per provider)                    └─> page ─> push, email, SMS, call… until acknowledged
```

[Open Monitoring](/monitors)

## Step by step

1. **Normalise.** The provider's payload becomes a title, summary, severity (SEV1–SEV4), status (*firing* or *resolved*) and dedup key. See [Alert sources](alert-sources.md#providers).
2. **Deduplicate.** A repeat of an alert that is still open (same source, same dedup key) increases its count. It does not open another ticket.
3. **Apply routing rules** (below). A rule can send the alert to another department, pick a policy, change its severity, tag it, make it ticket-only, or drop it.
4. **Group.** A new alert from a source that already has an open incident *for the same department* opened in the last 15 minutes joins that incident instead of opening another (`ALERT_GROUP_WINDOW_MINS`).
5. **Open the incident.** An incident ticket is created in the department, with priority from severity: SEV1 urgent, SEV2 high, SEV3 normal, SEV4 low.
6. **Page.** The escalation policy is, in order: the one a routing rule chose, else the monitor's or source's own, else the department's default (*On-call → Escalation policies*). SEV1–SEV3 page; SEV4 opens a ticket without paging.
7. **Auto-resolve.** When the last open alert on an incident resolves, the incident resolves and paging stops.

[Maintenance windows](maintenance.md) can pause paging, or alerting altogether, for what they cover. Alerts are always recorded.

Every incident ticket explains on its page why it paged and whom it reached (*Why did this page me?*), including the rule that routed it, e.g. "Routed by rule 'Website down → Web team'".

## Routing rules

*Monitoring → Routing* (permission `monitors.manage`). Ordered rules that decide where a new alert goes, before the source's own routing. They run top to bottom; the **first match decides**, unless it has **Keep evaluating later rules** ticked, in which case later matching rules add their tags and override what they set.

### Conditions

A rule matches when every condition it sets holds:

| Condition | Example |
| --- | --- |
| **Comes from these monitors or sources** | "Checkout API", "Production Grafana" |
| **From this kind of source** | HTTP(S) monitors, database monitors, AWS CloudWatch, Jenkins |
| **Title or summary** | contains `checkout`, or matches the regular expression `postgres\|mysql` (case-insensitive) |
| **Severity** | SEV1 or SEV2 |
| **Payload field** | `labels.service` equals `checkout` |
| **Time of day** | *Any time*, *Only during working hours* or *Only outside working hours*, with **Working days**, **From**, **Until** and **Time zone** |

### Actions

| Action | Effect |
| --- | --- |
| **Route to department** | The incident goes to that department and pages through its default policy, unless the rule also names one |
| **Escalation policy** | Use this policy |
| **Set severity** | Override the severity |
| **Add tags** | Tag the incident ticket |
| **Ticket only, page nobody** | Open the ticket; page no one |
| **Drop the alert** | Record nothing. The delivery still counts on its source |

### Presets

New rules can start from a preset:

- **Website / HTTP monitors → Web team**
- **Database alerts → DBA team**
- **SEV4 → ticket only, no page**
- **Out of hours: downgrade SEV3**

### Trying a rule

**Try a sample alert** takes a made-up alert (**Title**, **Summary**, **Severity**, source, optional **Payload (JSON)**) and shows which rule would match and what would happen, without creating anything.

> **Warning** Regular expressions that repeat a repeated group, such as `(a+)+`, are refused because they can stall the pipeline.

## Alerts tab

*Monitoring → Alerts* lists alerts, **Open** or **All**, with their source, severity, count, status and incident. Click through to the incident ticket.
