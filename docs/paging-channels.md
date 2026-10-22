# Paging channels and acknowledging

When an escalation policy reaches you, InfraTicket notifies you through **your own notification rules**. Everything on this page is set by each person for themselves under *Profile*, except telephony and Teams calls, which an on-call manager sets up once.

[Open your profile](/profile)

## Channels

| Channel | What arrives | Needs |
| --- | --- | --- |
| **In-app / browser** | The bell, and a browser notification if the tab is open | Nothing |
| **Phone push** | A notification with an **Acknowledge** button, even with InfraTicket closed | Turning push on per device; https (see below) |
| **Email** | An email with a link | [Email (SMTP)](email.md) set up |
| **Slack / Teams** | A message in the ticket's chat thread | [Slack](slack.md) or [Teams](microsoft-teams.md) |
| **SMS** | A text; reply `ACK` to acknowledge | Twilio and a mobile number |
| **Phone call** | A call that reads the alert; **1** acknowledges, **2** escalates now, **3** reads the details | Twilio and a mobile number |
| **Teams call** | Teams rings on desktop and phone; **1** acknowledges, **2** escalates | The Teams bot with calling enabled |
| **Discord DM** | A direct message with **Acknowledge** and **Escalate now** buttons | [Discord](discord.md) and a linked account |

**Wake-up channels** are the loud ones: SMS, phone call, Teams call and Discord DM.

## Notification rules

*Profile → Notifications when paged*. Each rule is an urgency, a **Channel** and a **Delay in minutes** after the page reaches you. SEV1 and SEV2 are **High urgency**; SEV3 and SEV4 are **Low urgency**.

Until you save your own, the defaults apply:

| Urgency | Immediately | After 1 minute | After 3 minutes |
| --- | --- | --- | --- |
| High | In-app, push, email, chat thread | SMS | Phone call |
| Low | In-app, push, email | | |

Calls repeat every 2 minutes, up to 5 calls, until someone acknowledges (an on-call manager can change both under *Phone & SMS*).

High urgency must include at least one wake-up channel. Fill in **Mobile number for SMS and calls** in international format (`+27 82 123 4567`), then **Save rules**.

**Send a test page to me** sends a real page through your rules, so you can check each channel arrives. Do it before your first shift.

## Acknowledging

Any of these stops the escalation, assigns the incident to you if nobody had it and moves it to *in progress*:

- **Acknowledge** on the Command centre, the On-call *Now* tab or the incident ticket.
- **Acknowledge** on the push notification.
- Reply `ACK` to the SMS.
- Press **1** on a phone call or Teams call.
- **Acknowledge** on the Discord DM.

**Escalate now** (press **2**, or the button) moves straight to the next level.

## Phone push notifications

Pages arrive as notifications with an **Acknowledge** button through the browser's own push service (Web Push). There is no app-store app, and sending is outbound only, so it works from a server nothing on the internet can reach.

Turn it on once per device under *Profile → Phone notifications*:

- **Android**: open InfraTicket in Chrome, tap **Turn on for this device** and allow notifications. **Install app** from Chrome's menu keeps it one tap away.
- **iPhone (iOS 16.4 or later)**: in Safari tap *Share → Add to Home Screen*, open InfraTicket from the new icon, then turn it on there. iOS allows push only from the home-screen app.
- **Computers**: Chrome, Edge and Firefox, the same way.

Push needs InfraTicket opened over **https** (or on `localhost`). A notification reaches the phone wherever it is; tapping *Acknowledge* needs the phone to reach InfraTicket (company Wi-Fi, VPN or a tunnel), and otherwise opens InfraTicket instead. **Send a test notification** proves a device works. Devices that uninstall or revoke permission are forgotten on the next send.

> **Warning** The key pair that signs pushes is stored encrypted with `SECRET_KEY`. Keep `SECRET_KEY` when moving a workspace, or everyone has to turn push on again.

## SMS and phone calls

*On-call → Phone & SMS* (permission `oncall.manage`).

- **Sandbox** (default): SMS and calls are written to the incident timeline as *simulated* and nothing is sent. Good for trying escalations without a telephony account.
- **Twilio**: enter the account SID, auth token and a Twilio number. Calls read the alert and take a keypress.

For acknowledging by SMS and keypad, Twilio must reach InfraTicket:

1. Set **Settings → Public URL** to this server's https address.
2. On the Twilio number, set *A message comes in* to `<Public URL>/api/webhooks/telephony/twilio/sms`.

Inbound requests are checked against Twilio's signature, and call callbacks carry a signed token bound to the one call attempt. Ask every on-call person to save the Twilio number as a contact and allow it through Do Not Disturb.

> **Note** Twilio is a paid service. Without it, use push, Teams calls or Discord DMs as free wake-up channels.

## Teams calls

The Teams bot can ring the person being paged in Microsoft Teams, on desktop and on the Teams phone app, repeating until someone acknowledges. People add **Teams call** to their rules. Setup (*On-call → Phone & SMS → Teams calls* shows the same steps with ticks):

1. The Teams integration is in **bot mode** with the app id, client secret and **tenant id** filled in (*Integrations → Microsoft Teams*).
2. **Settings → Public URL** is a public https address. A Cloudflare Tunnel exposing only `/api/webhooks/*` and `/api/public/*` is enough.
3. Azure portal → your **Azure Bot** → *Channels* → *Microsoft Teams* → **Calling** → *Enable calling*, with *Webhook (for calling)* set to `<Public URL>/api/webhooks/msteams/calling`.
4. Entra admin centre → *App registrations* → the bot's app → *API permissions* → *Add a permission* → *Microsoft Graph* → **Application permissions**: `Calls.Initiate.All`, `Calls.AccessMedia.All` and `User.Read.All` → **Grant admin consent**.
5. Download the Teams app package again (*Integrations → Microsoft Teams*); with calls on it declares `supportsCalling`. Upload the new version in the Teams admin centre.
6. Turn Teams calls on and press **Call me in Teams now**. If Microsoft refuses, the message names the missing permission.

Steps verified against Microsoft's documentation; untested against a live tenant.

**Spoken prompt.** Teams plays recordings only, so upload a WAV prompt: mono, 16-bit, 16 kHz PCM, up to 512 KB (about 15 seconds), e.g. *"This is InfraTicket. You are being paged for an incident. Press 1 to acknowledge, or 2 to escalate."* In Audacity: project rate 16000 Hz, mono track, *File → Export → WAV (signed 16-bit PCM)*.

With a prompt, **1** acknowledges and **2** escalates. **Without a prompt, answering is recorded but does not acknowledge** (a call answered in a pocket looks the same); acknowledge from the Teams card, the web or push. When a page is acknowledged anywhere, Teams calls still ringing for it are hung up.

## Discord direct messages

Free and needs no public URL. Type `/link` in Discord, enter the code under *Profile → Discord*, then add **Discord DM** to your rules. For it to be loud, set the InfraTicket server (or the bot's DMs) to *All messages* in Discord and allow Discord through Do Not Disturb. Discord refuses a DM to someone who shares no server with the bot or has turned off DMs from that server; the attempt then shows that reason.
