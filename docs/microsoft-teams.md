# Microsoft Teams

Two modes, and they are not equivalent:

| | Incoming webhook | Bot (InfraBot) |
| --- | --- | --- |
| Notifications in a channel | Yes | Yes, one thread per ticket |
| Raise tickets (`@InfraBot finance`) | No | Yes |
| Replies become comments | No | Yes |
| Ring on-call people (Teams calls) | No | Yes |
| Needs | A Workflows URL | Azure app registration, Azure Bot, a public https address with a publicly trusted certificate |

Both are free: the Azure Bot Service's standard channels, including Teams, carry no charge. Steps verified against Microsoft's documentation; untested against a live tenant.

[Open Integrations](/integrations)

## Incoming webhook (one-way)

1. In Teams: the channel → **⋯** → **Workflows** → *Post to a channel when a webhook request is received*. Copy the URL it generates.
2. *Integrations → Microsoft Teams* → **Connection method**: *Incoming webhook* → paste it into **Webhook URL**.
3. **Card format**: leave *Detect automatically*. Microsoft is retiring Office 365 connectors in favour of Workflows; the two need different payloads (Adaptive Card or MessageCard) and InfraTicket picks from the URL's host. Override only if detection gets it wrong.
4. **Test**.

A department can post to its own channel: *Teams → (department) → Where these tickets are announced → Teams webhook URL*.

## Bot (two-way)

Order matters: the Azure pieces come first because the app package needs their id.

### 1. Register the app in Azure

Azure portal → **App registrations → New registration**. Single tenant is fine for internal use. Keep the **Application (client) ID**. Then **Certificates & secrets → New client secret** and keep the value (Azure shows it once).

### 2. Create the bot

Azure portal → **Azure Bot → Create**, using that app registration. Under **Configuration**, set the messaging endpoint to:

```text
https://tickets.example.com/api/webhooks/msteams
```

Then **Channels → Microsoft Teams**.

> **Warning** Microsoft must reach this endpoint, with a certificate Microsoft trusts. An internal CA only your own machines trust will not do. A Cloudflare Tunnel exposing `/api/webhooks/*` works.

### 3. Tell InfraTicket

*Integrations → Microsoft Teams* → **Connection method**: *Bot*, then:

- **Bot name**: what it is called in Teams (`InfraBot`).
- **Microsoft app id** and **Client secret** from step 1. The secret is encrypted at rest.
- **Tenant id**: optional but recommended; activities from any other Microsoft tenant are refused even when Microsoft signed them.

Set **Settings → Public URL** too; the package needs it.

### 4. Approve permissions (admin consent)

**Grant admin consent** sends a Global or Cloud Application Administrator to Microsoft to approve everything the bot's app registration asks for, including Graph permissions for Teams calls, in one step. First add this to the app registration's **Authentication → Web → Redirect URIs** (the drawer shows it with a copy button):

```text
https://tickets.example.com/api/integrations/msteams/consent/callback
```

### 5. Install InfraBot in Teams

**Download the app package** gives `infrabot-teams.zip`: the manifest (your app id, your host, and a command menu listing your departments) and two icons. Then either:

- **Just you, for testing**: Teams → **Apps → Manage your apps → Upload an app → Upload a custom app**.
- **Everyone**: Teams admin centre → **Teams apps → Manage apps → Upload new app** (needs the custom-app upload policy).

Re-download whenever you add a department and want it in the menu. To build the package before the app is running:

```bash
npm run build:teams-app -- --app-id 00000000-0000-0000-0000-000000000000 \
  --url https://tickets.example.com --name InfraBot --org "Your Company" --departments finance,hr,it
```

### 6. Add it to a channel and test

Channel → **Apps** → add InfraBot. Microsoft will not let a bot message a conversation it has never seen, so until it is added there is nowhere to post, and **Test** says exactly that. Then **Test** posts a real message.

### Using it

```text
@InfraBot finance    posts Finance's intake form as an Adaptive Card
@InfraBot            lists the departments
```

Ticket updates arrive in the channel, one thread per ticket; replying in a ticket's thread adds a comment. A mention or click is honoured only when the Teams account's email matches an active user with the right permission.

### Teams calls

The bot can ring on-call people. See [Paging channels → Teams calls](paging-channels.md#teams-calls).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Test: the bot has not been added to a conversation | Add InfraBot to the channel (step 6) |
| Azure "Test in Web Chat" fails with 401 | App id or client secret wrong, or the tenant id does not match |
| Teams rejects the package | Download it again after saving the app id and Public URL; do not edit the manifest by hand |
| Consent: AADSTS50011 | The consent redirect URI is not on the app registration |
| Nothing arrives from a webhook | Try the other **Card format** |
