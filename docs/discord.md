# Discord

Free, and needs **no public URL**: the bot connects *out* to Discord's Gateway, so button clicks, slash commands and thread replies arrive over that connection rather than at an address Discord has to reach. It works from a lab server behind a firewall, or from the portable exe on a laptop.

[Open Integrations](/integrations)

## Set up

*Integrations → Discord*:

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**, named e.g. `InfraTicket`. Under **General Information**, copy the **Application ID**.
2. **Bot → Reset Token**, copy it. Under **Privileged Gateway Intents**, turn on **Message Content Intent** (without it, replies in threads arrive empty).
3. Paste both into **Application ID** and **Bot token** and **Save**.
4. **Add to server**: the invite asks for View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Embed Links, Read Message History and Use Application Commands.
5. Pick the **Default channel** for new tickets and, optionally, a channel per department under **Department channels**. **Only this server (optional)** limits `/ticket` to one server ID; blank registers it in every server the bot joins.
6. Choose what is posted in each ticket's thread (*Post in the ticket's thread when…*), **Test**, then turn it on.

## Linking accounts

Everything people do in Discord is checked against their InfraTicket account, so each person links once:

1. In Discord, type `/link`. The bot replies, only to you, with a code.
2. In InfraTicket, *Profile → Discord* → enter the **Link code**.

`/unlink` in Discord, or the button on the profile, undoes it.

## What people can do

- **`/ticket`** with a `department` (or a quick-ticket `template`) and an optional `priority` opens a form for the subject and details. The ticket goes through the normal path (SLA, auto-assignment, audit, Slack/Teams/Linear) with source `discord`. Text questions the department or template requires are asked in the form (up to three); a department needing choices, dates or lookups gets a link to the web form instead.
- Every ticket gets a **card in its department's channel and a thread**. Status changes, assignments, escalations, SLA breaches and public comments from the web are posted there; replies in the thread from linked people become comments, with images and PDFs copied onto the ticket. The bot's own posts are never read back, and a reply is never echoed into the thread it came from.
- The card's **Take**, **Resolve** and **Escalate** buttons (Escalate asks for the department and a reason) work like the web app, with the linked person's permissions.
- **Pages by direct message** with **Acknowledge** and **Escalate now**: add *Discord DM* to your notification rules. See [Paging channels](paging-channels.md#discord-direct-messages).

## Running several servers

With several InfraTicket instances, one holds the Discord connection (a lease in the database) and another takes over within a minute if it stops. A token Discord rejects, or a missing intent, shows on the tile and is not retried until the settings change.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/ticket` does not appear | Re-invite with **Add to server** (it needs *Use Application Commands*); new commands can take a minute |
| Thread replies are ignored | Turn on **Message Content Intent**, and make sure the person has linked their account |
| "Your Discord account is not linked to InfraTicket yet" | Run `/link` and enter the code under *Profile → Discord* |
| DMs fail | The person shares no server with the bot, or blocks DMs from server members |
