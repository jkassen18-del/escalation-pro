# Email (SMTP)

InfraTicket emails the assignee, the requester and every watcher when a ticket is created, assigned, changes status, is escalated, gets a public reply or breaches its SLA, and sends email pages to people whose notification rules include *Email*. Internal notes are never emailed.

Email is **outbound only**: replying to an email does not add a comment, and there is no email-to-ticket address.

[Open Integrations](/integrations)

## Set up

*Integrations → Email (SMTP)*:

| Field | Example |
| --- | --- |
| **SMTP host** | `smtp.office365.com` |
| **Port** | `587` |
| **Encryption** | *STARTTLS (587)* or *SSL/TLS (465)* |
| **Username** | `tickets@company.com` |
| **Password** | Stored encrypted |
| **From name** | `Service Desk` |
| **From address** | `tickets@company.com` |

**Test** sends a message to the from address (or only verifies the login when no from address is set).

> **Note** The *Support email* field under Settings says it is used as the reply-to address, but outgoing mail currently has no reply-to header: replies go to the **From address**. Point that at a mailbox someone reads.

## Free options

| Provider | Host | Notes |
| --- | --- | --- |
| Microsoft 365 | `smtp.office365.com:587` STARTTLS | The mailbox needs *Authenticated SMTP* enabled in the Microsoft 365 admin centre. Security defaults may block basic-auth SMTP; use a relay connector in that case |
| Google Workspace / Gmail | `smtp.gmail.com:587` STARTTLS | Use an app password (needs 2-step verification) |
| Your own relay | e.g. `mail.internal:25` | Postfix or Exchange on the internal network |

Provider details verified against their documentation; untested against a live tenant.

## Troubleshooting

| Error | Usually |
| --- | --- |
| `Invalid login` / `535` | Wrong username or password, or SMTP AUTH disabled for the mailbox |
| Timeout | Outbound port 587/465 blocked by the firewall |
| `self signed certificate` | An internal relay with its own certificate; use a publicly trusted one |
| Mail arrives as spam | Add SPF and DKIM for the from domain |
