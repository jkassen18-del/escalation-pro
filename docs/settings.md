# Settings and branding

*Manage → Settings* (permission `settings.manage`, administrators by default). Click **Save changes** at the top after editing the first three sections; single sign-on and the AI connector save on their own.

[Open Settings](/settings)

## Organisation

| Field | Used for |
| --- | --- |
| **Name** | The sidebar, the browser tab, emails and chat notifications |
| **Logo** | The sidebar, the sign-in screen and the browser tab icon. PNG, JPEG, GIF or WebP, up to 512 KB |
| **Support email** | Shown as the contact on push subscriptions. The hint says reply-to for email, but outgoing mail does not set one yet; see [Email](email.md) |
| **Public URL** | Where this system is reachable, e.g. `https://tickets.example.com`. Links in Slack, Teams, Discord, email and push are built from it, as are the Slack manifest, the Teams package, SSO addresses and Twilio callbacks |

> **Note** Many guides and some screens call **Public URL** the *App URL*. They are the same thing. When it is empty, the `APP_URL` environment variable is used, and failing that the address of the request.

## Ticket defaults

| Field | Effect |
| --- | --- |
| **Reference prefix** | `ESC` gives `ESC-1042`. Up to 8 characters. Changing it changes new **and** existing references |
| **Default team** | Pre-selected when someone raises a ticket |
| **Default priority** | Pre-selected priority |

## Fallback SLA

**First response target** and **Resolution target** for tickets with no department, or whose department has no target. See [SLAs](sla-and-assignment.md#sla-targets).

## Single sign-on (SAML)

See [Single sign-on](single-sign-on.md).

## AI connectors (MCP)

Whether Claude and other assistants may connect, read-only or read-write, the public address they use, OAuth clients and every personal token. See [AI assistants](ai-connector.md#administration).

## Things that are not settings

- **Integration credentials** live under [Integrations](integrations.md), encrypted.
- **Server configuration** (database, ports, secrets) is in environment variables; see [Environment variables](environment-variables.md).
- **Theme** (light, dark, system) is per person, in the account menu.
