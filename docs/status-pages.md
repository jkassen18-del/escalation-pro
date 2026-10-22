# Status pages

Status pages tell everyone else what is going on: customers on a public page, colleagues on an internal one. Make as many as you need under *Operations → Status pages* (permission `statuspages.manage` to change them; everyone signed in can view).

[Open Status pages](/status-pages)

## Creating a page

| Field | Meaning |
| --- | --- |
| **Title**, **Description** | Shown at the top of the page |
| **Address** | The slug: `status` makes the page `/status/status`, `shop` makes it `/status/shop` |
| **Public** | On: anyone with the link can see it. Off: internal, only signed-in people |
| **Components** | The monitors shown, each with a public **Label** (the monitor's own name and target are never shown) |
| **Appearance** | **Theme** (*Automatic*, *Always light*, *Always dark*), **Brand colour**, **Header name**, **Show the organisation logo**, **Footer text**, **Support link**, **Custom CSS** |

## What a page shows

- The overall state and each component's: *Operational*, *Degraded*, *Outage* or *Under maintenance*.
- 90 days of uptime per component as daily bars. Maintenance days show blue and do not count as downtime.
- The updates you post, newest first.
- Scheduled and in-progress [maintenance](maintenance.md) for its components, when the window is published.

Public pages live at:

```text
https://tickets.example.com/status/<address>              HTML, refreshes every minute, no scripts
https://tickets.example.com/api/public/status/<address>   the same data as JSON
```

They expose labels and states only, never monitor targets or ids, so they are safe to put on the internet. See [Exposing only the webhook paths](lab-server.md#exposing-only-the-webhook-paths) for publishing just `/status/*` through a tunnel.

## Posting an update

On a page, post an update with a **State** (*Investigating*, *Identified*, *Monitoring*, *Resolved*), **What people should know**, and an optional **Related incident**.

Updates are written for the page and never copied from ticket comments, so nothing said internally becomes public by accident.

## Embedding the JSON

```bash
curl -s https://tickets.example.com/api/public/status/shop | jq '.components[] | {name, status}'
```

Use it to show a status badge in another site or a chat bot.
