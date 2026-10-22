# Monitors and heartbeats

*Operations → Monitoring* watches your services from the InfraTicket server. When a monitor goes down it opens an incident ticket and pages through the department's escalation policy; when it recovers, the incident resolves on its own.

[Open Monitoring](/monitors)

The page has five tabs: **Monitors**, **Alert sources** ([guide](alert-sources.md)), **Routing** ([guide](alert-pipeline.md#routing-rules)), **Alerts** (open or all alerts, with their incidents) and **Maintenance** ([guide](maintenance.md)). Everyone can see them; changing them needs `monitors.manage`.

## Monitor kinds

| Kind | Target | Passes when |
| --- | --- | --- |
| **HTTP(S)** | A URL, e.g. `https://shop.example.com/health` | The status matches **Expected status** (default `200-399`), the keyword rules hold, and it is faster than the limit |
| **TCP port** | `host:port`, e.g. `db.internal:5432` | The port accepts a connection |
| **Ping (ICMP)** | A host, e.g. `gateway.internal` or `10.0.0.1` | The system's `ping` gets a reply |
| **DNS record** | A hostname | The record resolves, optionally to **Expected value** |
| **SSL certificate expiry** | `example.com` or `example.com:8443` | The certificate is trusted and has more than **Warn this many days before expiry** left (default 14) |
| **Heartbeat (cron / job)** | Nothing; you get a URL | Your job calls the URL at least once per period plus grace |
| **Database health** | A database connector from *Databases* | It connects and answers a query |

### Settings shared by all kinds

| Field | Meaning |
| --- | --- |
| **Name** | Shown on alerts, incidents and status pages (status pages can use a different public label) |
| **Team** | The department that owns the incident |
| **Check** | Every 30 seconds, minute, 5 or 15 minutes, hour, or once a day |
| **Down after** | 1, 2, 3 or 5 failures in a row before it counts as down and pages. Recovery needs one success |
| **Severity when down** | SEV1 to SEV3 page; SEV4 opens a ticket without paging |
| **Escalation policy** | Overrides the department's default policy |
| **Enabled** | Untick to pause the monitor |

The timeout is 10 seconds for HTTP, TCP, DNS and SSL checks and 5 seconds for ping.

### HTTP(S) options

- **Method**: GET, HEAD, POST or PUT, with **Request headers** and a **Request body**.
- **Expected status**: a range (`200-299`), a class (`2xx`) or a list (`200,204`).
- **Response must contain**: a keyword. Tick **Fail when the text is present instead** to alert when, for example, `maintenance mode` appears.
- **Slower than (ms) fails**: a response-time limit.

Redirects are followed.

### DNS options

**Record type** (`A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`) and an optional **Expected value** that one of the answers must equal.

### Database health

Pick a connector from [Databases](databases-and-backups.md). The check connects, runs a query and records latency, connection count, size and (for PostgreSQL and MySQL replicas) replication lag.

## Heartbeats

A heartbeat monitor turns the usual check around: your job calls InfraTicket, and silence is the alarm. Use it for backups, ETL runs, certificate renewals, anything scheduled.

1. *New monitor → Heartbeat (cron / job)*.
2. Set **The job runs** (every 5 or 15 minutes, hourly, every 6 hours, daily, weekly) and a **Grace period (minutes)** for how late it may be.
3. Save, then copy the monitor's heartbeat URL: `https://tickets.example.com/api/heartbeat/<token>`.

The URL accepts any method (GET, POST, HEAD…). Call `…/fail` to report a failure straight away; a message can go in the body or in `?msg=`.

### Examples

Linux cron, ping on success, report failure otherwise:

```bash
0 2 * * * /opt/etl/run.sh && curl -fsS -m 10 https://tickets.example.com/api/heartbeat/<token> \
                         || curl -fsS -m 10 --data "run.sh exited $?" https://tickets.example.com/api/heartbeat/<token>/fail
```

A systemd service, as the last step:

```ini
[Service]
ExecStart=/opt/backup/run.sh
ExecStartPost=/usr/bin/curl -fsS -m 10 https://tickets.example.com/api/heartbeat/<token>
```

Windows Task Scheduler (PowerShell):

```powershell
try {
  & C:\jobs\nightly.ps1
  Invoke-RestMethod -Method Post https://tickets.example.com/api/heartbeat/<token>
} catch {
  Invoke-RestMethod -Method Post -Body $_.Exception.Message https://tickets.example.com/api/heartbeat/<token>/fail
}
```

GitHub Actions, as the last step of a scheduled workflow:

```yaml
- name: Heartbeat
  if: success()
  run: curl -fsS -m 10 "${{ secrets.HEARTBEAT_URL }}"
```

> **Warning** The token in the URL is the only credential, so treat it like a password. Heartbeat URLs cannot currently be rotated from the UI: to change one, delete the monitor and create a new one.

## How state changes

- A monitor starts as *pending*, becomes *up* on its first success and *down* after **Down after** consecutive failures.
- Going down opens an alert and an incident ticket (see [The alert pipeline](alert-pipeline.md)); recovering resolves the alert and, when it was the last open alert, the incident.
- During a [maintenance window](maintenance.md) failures are counted as maintenance, not as an outage.
- Raw results are kept for 7 days; the daily roll-up for the 90-day bars on status pages is kept longer.
- The refresh button on a monitor's row runs it immediately; *Pause* and *Resume* are in its **⋯** menu.

## Monitoring private addresses

Monitors may target private and internal addresses on purpose: watching the company network is the point. Only holders of `monitors.manage` can create them. A monitor runs from the InfraTicket server, so it sees what that server can reach.
