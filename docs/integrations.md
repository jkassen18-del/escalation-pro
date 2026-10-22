# The integrations catalogue

*Manage → Integrations* (permission `integrations.manage`, administrators by default) is a catalogue: every tool is a tile showing **Connected**, **Needs attention** or **Not set up**, worked out from real data (a chat tool counts as connected once its test passes, an alert source once an alert has arrived). Click a tile for a guided setup with numbered steps, the few fields it needs and a test. Nothing in the catalogue needs a paid plan.

[Open Integrations](/integrations)

`/integrations?setup=<tile>` opens one tile directly, for example `/integrations?setup=slack` or `/integrations?setup=source:aws_sns`.

## Tiles

| Group | Tile | Guide |
| --- | --- | --- |
| Chat & collaboration | Slack | [Slack](slack.md) |
| | Microsoft Teams | [Microsoft Teams](microsoft-teams.md) |
| | Discord | [Discord](discord.md) |
| | Linear | [Linear](linear.md) |
| | Email (SMTP) | [Email](email.md) |
| Monitoring & cloud | AWS CloudWatch, Azure Monitor, Grafana / Alertmanager, Jenkins, Cloudflare, DigitalOcean, Entra ID / Microsoft 365, Stratigix, Generic webhook | [Alert sources](alert-sources.md) |
| Developer | Custom HTTP | [Custom HTTP](custom-http.md) |
| | Heartbeats | [Heartbeats](monitoring.md#heartbeats) |
| | Database connectors | [Databases and backups](databases-and-backups.md) |
| | Database lookups | [Database lookups](database-lookups.md) |
| Sign-in | Microsoft sign-in (SSO) | [Single sign-on](single-sign-on.md) |

AI assistants connect separately; see [AI assistants](ai-connector.md).

## What each chat tool can do

| | Raise a ticket | Notifications out | Reply to a ticket | Change its status |
| --- | --- | --- | --- | --- |
| **Slack** (bot) | `/gml finance` opens the form | Yes | Yes, in the ticket's thread | Buttons, a reply starting "Fixed", or ✅ |
| **Slack** (webhook) | No | Yes | No | No |
| **Teams** (bot) | `@InfraBot finance` posts the form | Yes | Yes, in the ticket's thread | Via the link on the card |
| **Teams** (webhook) | No | Yes | No | No |
| **Discord** | `/ticket` | Yes, card and thread per ticket | Yes, in the thread | **Take**, **Resolve**, **Escalate** buttons |
| **Linear** | An issue in a mapped team | Yes, as a mirrored issue | Comments sync both ways | Moving the issue, or a comment starting "Fixed" |
| **Email** | No | Yes | No | No |

The form each tool opens is the **department's own intake form**, validated on the server.

## Who an action is attributed to

A chat message proves nothing on its own: anyone in a channel can type or click. So an action from Slack, Teams, Linear or Discord is honoured only when the person maps to an **active account here with the right permission**: by email for Slack, Teams and Linear, by the `/link` code for Discord. A refused action is answered privately and changes nothing. Accepted ones are written to the audit log against that person.

## Which public URLs each needs

| Tool | Needs InfraTicket reachable from the internet? |
| --- | --- |
| Slack notifications, Teams webhook, Email, Linear outbound, Custom HTTP | No, outbound only |
| Discord (everything) | No, the bot connects out to Discord |
| Slack replies, buttons, `/gml` | Yes: `/api/webhooks/slack*` |
| Teams bot | Yes: `/api/webhooks/msteams`, with a publicly trusted certificate |
| Linear inbound sync | Yes: `/api/webhooks/linear` |
| Alert sources from cloud tools | Yes: `/api/ingest/*` |
| Twilio SMS and keypad | Yes: `/api/webhooks/telephony/*` |

See [Exposing only the webhook paths](lab-server.md#exposing-only-the-webhook-paths).

## Credentials

Every credential is encrypted with AES-256-GCM before it is stored, using `SECRET_KEY`, and never sent back to the browser: the UI shows only a masked preview such as `xoxb••••alue`. Webhook URLs are checked on save: https only, not resolving to localhost, private or link-local addresses. Each tile's **Test** calls the real service and shows exactly what came back.

## Recent deliveries

The **Recent deliveries** tab lists the last outbound notifications to each tool with the status code and any error. The tab title counts failures. An integration failure never blocks a ticket update: it is logged and the update goes ahead.
