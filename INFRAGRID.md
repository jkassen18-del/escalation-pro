# InfraGrid

Every system watching the estate, in one place. A monitoring tool posts to
its own ingest URL; InfraGrid normalises the payload, folds repeats into one
alert, opens a ticket when it is serious enough, and clears it when the
system says the condition has gone.

## Connecting a system

**InfraGrid → Connect a system.** Pick the vendor, choose which department
its alerts should go to, and you get an ingest URL:

```
https://tickets.example.internal/api/ingest/ing_a1b2c3d4_...
```

Shown once. Each system gets its own, so a compromised Jenkins cannot post
as CrowdStrike, and any one can be revoked without touching the rest.

The credential is in the path because most of these tools take a URL and
nothing else — a CloudWatch SNS subscription or a DigitalOcean alert policy
has nowhere to put a header. It can also be sent as
`Authorization: Bearer ...` or `X-Ingest-Token` where the tool allows it,
which keeps it out of access logs.

## What each system needs

| System | Where to put the URL |
|---|---|
| **DigitalOcean** | Monitoring → Alert Policy → *Send alerts to* → Slack/webhook field |
| **Jenkins** | *Notification* plugin → job or global config → endpoint, JSON format |
| **Azure** | Monitor → Action group → **Webhook**, with the *common alert schema* on |
| **AWS** | CloudWatch alarm → SNS topic → subscription of type **HTTPS**. The subscription handshake is answered automatically — no link to go and click. |
| **CrowdStrike** | Falcon → Workflows / Fusion → webhook action on detections |
| **Ansible** | AWX/Tower → Notifications → **Webhook** on job failure *and* success |
| **Linux** | Prometheus Alertmanager `webhook_config`, or `curl` from a script |
| **Windows** | Scheduled task or `Invoke-RestMethod` from PowerShell |

Anything else can use **Generic webhook**, which reads `title`, `severity`,
`status`, `resource` and `dedupeKey` from a flat JSON body.

For Linux and Windows the plain shape is:

```bash
curl -X POST "$INGEST_URL" -H 'Content-Type: application/json' \
  -d '{"host":"db-01","check":"disk","state":"critical","message":"/ is at 95%"}'
```

Send the same body with `"state":"ok"` when it recovers.

## Deduplication, and why it matters

A monitor re-fires every minute while a disk is full. Without deduplication
one bad disk fills the queue with hundreds of identical tickets, and the
queue becomes useless precisely when you need it.

Each adapter derives a **dedupe key** identifying the *condition*, not the
delivery — the policy plus the droplet, the Jenkins job, the alarm name.
While a condition is firing, repeats advance a counter on the one alert and
open nothing new.

## Recovery

Every adapter recognises its vendor's "it is better now" signal: a Jenkins
`SUCCESS`, a CloudWatch `OK`, an Azure `Resolved`, an Alertmanager
`status: resolved`, an Ansible `successful`.

A recovery marks the alert resolved and **comments on the ticket**. It does
not close it. The condition clearing is not the same as the cause being
understood, and a ticket that closes itself is how a recurring fault goes
uninvestigated. A person closes it.

CrowdStrike is the exception: a security detection has no automatic
all-clear, so it stays until somebody decides it is dealt with.

## Severity and when a ticket opens

Three levels — `critical`, `warning`, `info` — because the only decision
this drives is how loudly to react, and nobody holds six levels in their
head consistently at three in the morning.

Each source has a **ticket threshold**. At or above it an alert opens a
ticket (`critical` → urgent, `warning` → high). Below it the alert is still
recorded and still shown on the grid, but wakes nobody.

## Heartbeats

For jobs where **silence is the failure**. A cron that stops running sends
nothing, so nothing else in this system would ever notice.

**InfraGrid → Heartbeats → Add.** You get a check-in URL:

```bash
# At the end of the job, so it only reports on success:
0 2 * * *  /usr/local/bin/backup.sh && curl -fsS https://tickets.example.internal/api/ingest/heartbeat/XXXX
```

GET or POST, both work. Miss the window — the period plus its grace — and an
alert is raised like any other. Check in again and it clears itself
immediately, without waiting for the next sweep.

A heartbeat that has *never* checked in is not considered late, so creating
one does not alert before you have had the chance to wire up the job.

Misses are detected by the same sweep that checks SLA breaches: in-process
on a long-running server, or via `/api/cron/sla` on serverless.
