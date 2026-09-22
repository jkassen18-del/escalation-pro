# InfraBot — the Teams app

Teams installs an app from a zip holding a manifest and two icons. **You do
not have to assemble it**: the application builds the package for you, with
the app id, this deployment's host and your current departments already in
it. Those are the three things that are easy to get wrong by hand, and Teams
rejects a mismatch with a message that does not say which field is at fault.

Order matters — the Azure pieces come first, because the package needs the
app id they produce.

## 1. Register the app in Azure

Azure portal → **App registrations** → New registration. Single tenant is
fine for an internal deployment. Keep the **Application (client) ID**: it is
the bot id, and it goes in the manifest twice.

Then **Certificates & secrets** → New client secret. Keep the value; Azure
shows it once.

## 2. Create the bot

Azure portal → **Azure Bot** → Create, using the app registration above
rather than letting it make a new identity. Under **Configuration**, set the
messaging endpoint to:

```
https://<your-host>/api/webhooks/msteams
```

Then **Channels** → add **Microsoft Teams**.

> **This endpoint must be reachable by Microsoft**, with a certificate
> Microsoft trusts. An internal CA that only your own machines trust will
> not do — Microsoft is the client here and it is not on your network. This
> is the one part of an on-premises deployment that needs a publicly trusted
> certificate and a route in from outside.

## 3. Tell the application

In the app: **Integrations → Microsoft Teams**, set the connection method to
**Bot**, and fill in:

- **Bot name** — what it is called in Teams. `InfraBot` unless you want
  something else.
- **Microsoft app id** — from step 1.
- **Client secret** — from step 1. Encrypted at rest.
- **Tenant id** — optional, and worth setting: it makes the endpoint refuse
  activities from any other Microsoft tenant, even ones Microsoft signed.

Also set the **app URL** under Settings if you have not already. The package
needs to know where this deployment lives.

## 4. Download the package

**Integrations → Microsoft Teams → Teams app package → Download.**

You get `infrabot-teams.zip`, containing:

- `manifest.json` — your app id, your host, and a command menu listing your
  actual departments
- `color.png` (192×192) and `outline.png` (32×32)

Re-download it whenever you add a department and want it in the menu. The bot
answers any department whether or not it is listed — the menu is only what
Teams shows when somebody mentions the bot.

### Without a running app

For a developer setting Teams up before the deployment exists, or a CI job
that wants the package as a build artefact:

```bash
npm run build:teams-app -- \
  --app-id 00000000-0000-0000-0000-000000000000 \
  --url https://tickets.example.internal \
  --name InfraBot \
  --org "Your Company" \
  --departments finance,hr,it
```

### Replacing the icons

The icons are generated, and they are deliberately plain. To use your own,
unzip the package, swap the two PNGs keeping the names and the exact sizes
(192×192 and 32×32, both PNG, the outline one white-on-transparent because
Teams tints it), and zip the three files back up **flat** — no folder inside
the archive, or Teams will not find the manifest.

## 5. Upload it to Teams

Either:

- **Just you, for testing** — Teams → **Apps** → *Manage your apps* →
  **Upload an app** → *Upload a customised app*.
- **Everyone** — Teams admin centre → **Teams apps → Manage apps → Upload
  new app**. This needs the custom-app upload policy to be enabled for the
  tenant; if the option is missing, that policy is why.

## 6. Add it to a channel, then test

The app has to be added to each channel it will post in. Microsoft will not
let a bot message a conversation it has never seen, so until it is added
there is nowhere for notifications to go — and the connection test says
exactly that rather than reporting success.

Channel → **Apps** → add InfraBot. Then run **Test connection** in the
application; it posts a real message.

## Using it

- `@InfraBot finance` — posts Finance's intake form as a card.
- `@InfraBot` — lists the departments.
- Ticket updates arrive in the channel, one thread per ticket.
- Replying in a ticket's thread adds a comment to that ticket.

Teams has no slash commands for third-party apps — typing `/` opens Teams'
own palette, not ours — so mentioning the bot is the equivalent, and the
command list is what makes it discoverable.

A mention is only acted on when the Teams account's email matches an active
user here with permission to raise tickets. Anyone in a channel can type, so
the message alone proves nothing.
