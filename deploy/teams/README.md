# The Teams app package

Teams needs three things: an Azure app registration, a Bot Service resource
pointing at this application, and an app package installed into the tenant.
There is no shortcut — an incoming webhook cannot do any of this, because
Microsoft provides no callback on one.

## 1. Register the app

Azure portal → **App registrations** → New registration (single tenant is
fine for an internal deployment). Keep the **Application (client) ID**.

Then **Certificates & secrets** → New client secret. Keep the value; it is
shown once.

## 2. Create the bot

Azure portal → **Azure Bot** → Create, using the app registration above
rather than a new identity. Under **Configuration**, set the messaging
endpoint to:

```
https://tickets.example.internal/api/webhooks/msteams
```

Then **Channels** → add **Microsoft Teams**.

The endpoint must be reachable from Microsoft with a certificate it trusts.
An internal CA that only your machines trust will fail here — Microsoft is
the client, and it is not on your network. Use a publicly trusted
certificate for this host, or put the endpoint behind one.

## 3. Tell the application

In the app: **Integrations → Microsoft Teams → Bot**. Paste the app id and
client secret, and optionally the tenant id (which makes the endpoint refuse
activities from any other tenant, even ones Microsoft signed).

## 4. Build and install the package

Edit `manifest.json`: replace both `REPLACE-WITH-YOUR-AZURE-APP-ID` values
with the app id, set `validDomains` and the developer URLs to your host, and
edit the command list to your actual departments — the commands are only the
menu Teams shows when the bot is mentioned, so any department works whether
or not it is listed.

Add two icons beside the manifest: `color.png` (192×192) and `outline.png`
(32×32, transparent with a white glyph). Then:

```bash
zip -j infraticket-teams.zip manifest.json color.png outline.png
```

Teams admin centre → **Teams apps → Manage apps → Upload new app**, or for
testing, a team → **Apps → Manage apps → Upload a custom app**.

## 5. Add it to a channel, then test

The app has to be added to the channel it will post in. Microsoft will not
let a bot message a conversation it has never seen, so until it is added
there is nowhere for notifications to go — and the connection test says
exactly that rather than reporting success.

Once it is added, run **Test connection**. It posts a real message.

## Using it

- `@Service Desk finance` — raises a ticket on the Finance form.
- `@Service Desk` — lists the departments.
- Replying in a ticket's thread adds a comment to that ticket.

Teams has no slash commands for third-party apps: typing `/` opens Teams'
own palette, not ours. Mentioning the bot is the equivalent, and the command
list in the manifest is what makes it discoverable.
