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

Azure portal → **Azure Bot → Create**, using that app registration. Choose the **F0 (free)** pricing tier: standard channels such as Teams have no message limit and cost nothing, so no paid plan or Azure subscription spend is involved. Under **Configuration**, set the messaging endpoint to:

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

### 5. Install the Teams app

Step 3 of the drawer is the app itself: its version, what changed since the last download, anything Teams would reject, the app's name, descriptions, colour and icon, and its commands.

**Download the Teams app** gives `infrabot-teams.zip`: the manifest (your app id, your host, the command menu and the forms) and two icons. The drawer checks it first against the rules Teams enforces (a GUID app id, an https URL, name and description lengths, at most 10 menu commands, a 192x192 colour icon and a 32x32 outline icon) and lists any problem. Then either:

- **Just you, for testing**: Teams → **Apps → Manage your apps → Upload an app → Upload a custom app**.
- **Everyone**: Teams admin centre → **Teams apps → Manage apps → Upload new app** (needs the custom-app upload policy), then allow it in an app permission or setup policy.

#### Updating it

Teams only accepts an update whose version is higher than the installed one. InfraTicket handles this: the version stays the same while nothing changes, and goes up by one (1.1.0 → 1.1.1) the first time anything that ends up in the package changes: name, descriptions, colour, icon, commands, departments, calls, or the app URL. The drawer shows **Update ready** and a list of what changed.

1. Change what you need and **Save Teams app**.
2. **Download updated package**.
3. Teams admin centre → **Manage apps** → the app → **Upload file**. A custom app you uploaded yourself: **Apps → Manage your apps** → the app's **…** → **Update**.

If the app was uploaded at a higher version from somewhere else (an older package, another server), set **Minimum version** above it once.

The command line builds the same package from the same database, and counts as a download:

```bash
npm run build:teams-app -- --from-db --out infrabot-teams.zip
```

Before the app is running at all, it can build one from flags instead:

```bash
npm run build:teams-app -- --app-id 00000000-0000-0000-0000-000000000000 \
  --url https://tickets.example.com --name InfraBot --org "Your Company" --departments finance,hr,it
```

### 6. Add it to a channel and test

Channel → **Apps** → add InfraBot. Microsoft will not let a bot message a conversation it has never seen, so until it is added there is nowhere to post, and **Test** says exactly that. Then **Test** posts a real message.

### Commands

In a personal chat with the bot, type the command. In a channel or group chat, mention the bot first (`@InfraBot status ESC-1042`).

| Command | What it does |
| --- | --- |
| `help` | Lists the commands |
| `new` | Asks which department or quick ticket, then posts its form. **Open as a pop-up form** opens the same form in a dialog |
| `status ESC-1042` | The ticket's status, priority, department and assignee, only if you may see that ticket |
| `mine` | Your open tickets: assigned to you or raised by you |
| `oncall` | Who is on call right now, per schedule |
| a department key, e.g. `finance` | That department's intake form |

Under **Commands** in the drawer you can switch commands off, reorder them (Teams lists the first 10 switched-on ones; the rest still work when typed), reword their descriptions, and **Add command** for your own:

- **Open a department's form**, e.g. `laptop` → IT's form.
- **Open a quick ticket's form**: the template's questions plus its department's. A quick ticket that requires a screenshot is answered with a pointer to the browser, because Teams forms cannot carry one.
- **Reply with text or a link**, e.g. `wifi` → the guest Wi-Fi instructions.

Changing commands changes the package, so download and upload the update for the menu to show it.

### Forms

The package also adds a messaging extension:

- **Raise a ticket**: in the compose box's apps (**…** or **+**) and the command box. Pick a department or quick ticket, fill in its form, and the confirmation card is dropped into the compose box to send.
- **Create ticket from message**: on any message's **… → More actions**. The form opens with the message's text, its author and a link back to it already in **Details**.

Ticket updates arrive in the channel, one thread per ticket; replying in a ticket's thread adds a comment. A command, form or click is honoured only when the Teams account's email matches an active user here, with permission to raise tickets for forms (anyone active for `help`, `status`, `mine` and `oncall`).

### Teams calls

The bot can ring on-call people. See [Paging channels → Teams calls](paging-channels.md#teams-calls).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Test: the bot has not been added to a conversation | Add InfraBot to the channel (step 6) |
| Azure "Test in Web Chat" fails with 401 | App id or client secret wrong, or the tenant id does not match |
| Teams rejects the package | Fix what the drawer lists under *Check before uploading*, then download again; do not edit the manifest by hand |
| Teams says the app already exists, or will not update | The new version must be higher: download the updated package, or set **Minimum version** above the installed one |
| A new command is missing from the menu | Download and upload the updated package; only the first 10 switched-on commands are listed |
| "Raise a ticket" is missing from the compose box | The installed package predates forms: upload the current one |
| Consent: AADSTS50011 | The consent redirect URI is not on the app registration |
| Nothing arrives from a webhook | Try the other **Card format** |
