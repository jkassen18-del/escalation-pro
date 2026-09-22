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

## API health checks (polling)

The other direction. A webhook only arrives while the far end is *well
enough to send one*, so a service that has fallen over entirely is precisely
what an inbound-only setup cannot see. A check calls out on a schedule.

**InfraGrid → API health checks → Add a check.**

Authentication is **per check**, because not every endpoint needs one:

| Kind | What you supply | Sent as |
|---|---|---|
| **No authentication** | nothing | — |
| **Bearer token** | the token | `Authorization: Bearer <token>` |
| **Basic auth** | `user:password` | `Authorization: Basic <base64>`, encoded for you |
| **Custom header** | header name + value | that header |
| **Query parameter** | parameter name + value | appended to the URL, keeping any existing query |

Credentials are encrypted at rest with the same key as every other secret
here and are never returned to the browser — the UI only knows *whether* one
is set.

Examples:

| System | URL | Auth |
|---|---|---|
| DigitalOcean | `https://api.digitalocean.com/v2/account` | Bearer |
| Jenkins | `https://jenkins.internal/api/json` | Basic, `user:api-token` |
| Azure | any app's `/health` endpoint | usually none |
| Internal service | `http://10.0.4.12:8080/health` | whatever it wants |

**Run now** calls it immediately and tells you what came back, so a typo or a
wrong credential surfaces in a second rather than at the next sweep. It
deliberately does not raise or clear alerts — it answers "does this work",
not "is the service down".

### What counts as unhealthy

- the status code does not match (default: any `2xx`)
- an optional **expected body** string is missing — this is what catches the
  service that is up and answering `200` while its own health endpoint says
  it cannot reach its database
- nothing answers within the timeout

A failure must repeat **`failureThreshold` times** (default 2) before it
alerts. One timeout is a blip, and waking somebody for a blip is how people
learn to ignore the alerts — which costs far more than the blip did.

Recovery is immediate: the next successful check clears the alert and
comments on the ticket.

### What cannot be probed

Internal and private addresses **are** allowed — checking that the internal
Jenkins still answers is the whole point, and the outbound-webhook guard's
refusal of private ranges would make this useless on-premises.

Cloud **metadata endpoints** are blocked: `169.254.169.254`,
`metadata.google.internal` and friends. Those are never a legitimate health
check and are the actual prize in an SSRF — they hand out instance
credentials to anything that asks from the right place.

## Sending a test alert

**InfraGrid → Test alert → Send one.**

Each integration has a connection test of its own, but those prove the
*credential* works. They do not prove an alert reaches a person, which also
depends on the routing, on which events each integration subscribes to, and
on a ticket being created at all.

This pushes a synthetic alert down the same path a real one takes: it becomes
an alert, opens a ticket at urgent priority, and fans out. **Wherever it
arrives is where a genuine alert would arrive** — email, Slack, Teams, and
Linear if the priority meets its mirror threshold.

Two presses give two tickets: deduplication is right for a real condition
re-firing and wrong for a test you are trying to watch. Close them afterwards.

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
