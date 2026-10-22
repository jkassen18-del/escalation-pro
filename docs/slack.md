# Slack

Slack announces tickets in channels with a priority-coloured bar and an *Open ticket* button, takes replies in the ticket's thread, resolves tickets from a button, a reply or a ✅, and raises tickets with `/gml`. Free on every Slack plan.

[Open Integrations](/integrations)

## Recommended: the guided setup

*Integrations → Slack*. Four steps, about five minutes.

### Before you start

For replies, buttons and the slash command, Slack must reach InfraTicket at a public https address. Set **Settings → Public URL** first (a Cloudflare Tunnel is free; see [Lab server](lab-server.md#exposing-only-the-webhook-paths)). Without one, notifications still work and the manifest leaves out the parts Slack would have to call back.

### 1. Create the Slack app

Optionally change **App name** and **Slash command** (`/gml` by default), then **Create the Slack app**. Slack opens its *create from manifest* screen with everything filled in:

- Bot scopes: `chat:write`, `chat:write.public`, `commands`, `users:read`, `users:read.email`, `channels:history`, `groups:history`, `channels:read`, `groups:read`, `reactions:read`.
- Events (`message.channels`, `message.groups`, `reaction_added`) to `<Public URL>/api/webhooks/slack`.
- Interactivity to `<Public URL>/api/webhooks/slack/interactive`.
- The slash command to `<Public URL>/api/webhooks/slack/commands`.
- OAuth redirect `<Public URL>/api/integrations/slack/oauth/callback`.

Pick your workspace and click **Create**. *Show the manifest* displays exactly what is sent.

### 2. Paste the app's credentials

In the new Slack app: **Settings → Basic Information → App Credentials**. Copy **Client ID**, **Client Secret** and **Signing Secret** into InfraTicket and **Save**.

### 3. Add to Slack

**Add to Slack**, approve, and you come straight back. The install uses OAuth with a one-time `state` bound to your session, so a stray or replayed callback is refused.

### 4. Pick the channel and test

Choose the channel for ticket notifications and **Save and send a test**. For a private channel, invite the app first (`/invite @InfraTicket`).

Departments can post to their own channels: *Teams → (department) → Where these tickets are announced → Slack channel*.

## Using it

### Notifications

New tickets, assignments, status changes, escalations, SLA breaches and public replies are posted, one thread per ticket. Internal notes never are.

### Replying

Anything typed in a ticket's thread becomes a public comment on the ticket, attributed to the InfraTicket account with the same email as the Slack user.

### Resolving

- The **Resolve**, **Close** and **Reopen** buttons on each message.
- A thread reply that **starts** with *resolved*, *fixed*, *done*, *sorted*, *completed* or *closed* (or ✅) is kept as a comment **and** resolves the ticket.
- A ✅ reaction on the ticket's message or a reply in its thread.

Questions never count: "fixed?" and "have you fixed it?" are just comments. All three need the Slack user's email to match an active account with *Update tickets*; anyone else is told privately that nothing changed.

### Raising tickets

```text
/gml finance      Finance's intake form as a modal
/gml              asks which department first
```

The department is matched forgivingly (`finance`, `Finance`, `gml-finance`, `fin`). There is one command rather than one per department, so a department added in InfraTicket works at once without changing the Slack app.

## Alternatives

Under the Slack tile's **Connection method** you can instead use:

- **Incoming webhook**: paste a `https://hooks.slack.com/services/…` URL (Slack → Your apps → Incoming Webhooks). One channel, notifications only.
- **Bot token**: an existing app's `xoxb-…` token (needs `chat:write`) and a **Channel** ID or `#name`. Add the **Signing secret** and point **Request URL** and **Interactivity Request URL** at the addresses shown to get replies and buttons.

The whole app can also be created from `deploy/slack/manifest.yml` in the repository (Slack API → Your apps → Create New App → From an app manifest).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Test says `channel_not_found` or `not_in_channel` | Invite the app to the channel |
| Buttons do nothing | Interactivity is not pointing at `/api/webhooks/slack/interactive`, or the Public URL is not reachable |
| Replies are not picked up | Event subscriptions missing, or the signing secret is wrong (Slack's delivery log shows 401) |
| A private reply says the ticket was left alone | Your Slack email does not match an active account with *Update tickets* |
| `invalid_auth` | Reinstall (step 3); the token was revoked |
