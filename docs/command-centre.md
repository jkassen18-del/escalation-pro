# Command centre

*Operations → Command centre* is the one screen to keep open during an incident: what is paging, what is down, and who is on call. It refreshes every 15 seconds. Everyone signed in can see it.

[Open the Command centre](/operations)

## What it shows

| Panel | Contents |
| --- | --- |
| **Active pages** | Incidents currently paging someone, with the level reached and who was notified. Acknowledge from here |
| **Monitors down** | Every monitor in the *down* state, with its last error |
| **Open alerts** | Alerts still firing from alert sources and monitors, with their incident ticket |
| **Failing backups** | Backup jobs whose last run failed |
| **On call now** | Who is on call in each schedule at this moment |
| **In maintenance** | Maintenance windows running now; affected monitors carry a *Maintenance* badge |

## Getting started checklist

On a new workspace the page shows **Get to your first page in 15 minutes**, a checklist that ticks itself off as you go:

1. **Watch something**: add an HTTP, TCP, SSL or heartbeat monitor, or an alert source. See [Monitors](monitoring.md).
2. **Set up on-call**: a rotation and an escalation policy, made your team's default. See [On-call](on-call.md).
3. **Make sure you can be woken**: mobile number, notification rules, a test page. See [Paging channels](paging-channels.md).
4. **Connect your chat tools**: Slack in a few clicks; Teams, Discord and Linear in the same catalogue. See [Integrations](integrations.md).
5. **Send alerts from your tools**: AWS, Azure, Grafana, Jenkins, Cloudflare or any webhook. See [Alert sources](alert-sources.md).
6. **Publish a status page**. See [Status pages](status-pages.md).
7. **Back up a database**. See [Databases and backups](databases-and-backups.md).

## During an incident

1. Open the incident from **Active pages** or **Open alerts**.
2. **Acknowledge** to stop the escalation; the incident is assigned to you if nobody had it and moves to *in progress*.
3. Work it on the ticket: notes, replies, *Page someone about this ticket* to pull in more people.
4. Post an update on the [status page](status-pages.md) if customers are affected.
5. When the alert resolves on its own (the monitor recovers, the tool sends *resolved*), the incident resolves and paging stops.
