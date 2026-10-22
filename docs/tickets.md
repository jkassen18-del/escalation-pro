# Working with tickets

A ticket is one piece of work: a request, an incident, a problem, a question or an escalation. Each has a reference such as `ESC-1042`, a status, a priority, a type, an owning department, an optional assignee, and a timeline of comments and system events.

[Open the ticket list](/tickets)

## Statuses

| Status | Meaning |
| --- | --- |
| `open` | Raised, not yet being worked |
| `in_progress` | Someone is on it |
| `pending` | Blocked, usually waiting on someone else |
| `resolved` | Fixed, awaiting confirmation |
| `closed` | Finished |

## Priorities, types and severity

- **Priority**: `urgent`, `high`, `normal`, `low`. Priority scales the SLA (see [SLAs, routing and escalation](sla-and-assignment.md)).
- **Type**: `incident`, `request`, `question`, `problem`, `escalation`.
- **Severity** (incidents only): SEV1 to SEV4. Incidents opened by monitors and alert sources carry the alert's severity.

The reference prefix (`ESC` by default) is set under [Settings](settings.md). Changing it changes new and existing references.

## The ticket list

*All tickets* has a search box (`/` focuses it) that matches the subject, the body and the reference, plus filters for **Status**, **Priority**, **Type**, **Team** and **Has attachments**, and a **Sort order**: newest first, oldest first, recently updated, priority, or due soonest.

Every filter is in the address bar, so a filtered view can be bookmarked or shared:

```text
/tickets?status=open&priority=urgent
/tickets?teamId=<team id>&sort=due
/tickets?assignee=me
/tickets?unassigned=true
/tickets?overdue=true
```

## The ticket page

The right-hand panel shows and edits **Status**, **Priority**, **Type**, **Team**, **Assignee**, **Requester**, **Source** (web, email, Slack, Teams, Discord, Linear, monitor, webhook, API, phone or Claude), **Watchers**, and the **Opened**, **First reply**, **Due** and **Resolved** times.

The *More actions* menu holds **Create Linear issue** (when Linear is connected), **Close ticket** or **Reopen ticket**, and **Delete ticket** (with `tickets.delete`).

### Comments and internal notes

The reply box at the bottom posts either a **public reply** or an **Internal note**:

- Public replies go to the requester and watchers and are mirrored to the ticket's Slack, Teams, Discord thread and Linear issue.
- Internal notes are visible only to people with *Internal notes* (`tickets.comment_internal`) and are **never** sent to Slack, Teams, Discord, Linear or email.

The first public reply from someone other than the requester stops the first-response clock.

### Attachments and screenshots

Paste a screenshot straight into the description or a comment (for example `Win+Shift+S`, then `Ctrl+V`), or add files with the picker. Allowed are images (PNG, JPEG, GIF, WebP, SVG), PDF, plain text, CSV, JSON, ZIP, and Word, Excel and PowerPoint files (old and new formats). Anything else is refused. The size limit is 15 MB per file by default (`MAX_UPLOAD_MB`), or 6 MB when attachments are stored in the database on serverless hosting.

SVG files are always downloaded rather than shown, and every file is served with `X-Content-Type-Options: nosniff`.

### Watchers

Click **Watch** to be notified of every change to a ticket you are not assigned to. Requesters and assignees are notified anyway.

### Escalating

**Escalate** raises the ticket's level, bumps its priority, records your reason as an internal note and notifies every connected channel. It can also **send the ticket to another department**; see [Escalation](sla-and-assignment.md#escalation).

### Paging someone about a ticket

On an incident ticket, **Page someone about this ticket** starts an escalation policy by hand. The incident panel then shows each attempt, and *Why did this page me?* explains the routing. See [On-call](on-call.md).

## Notifications

You get an in-app notification (the bell) and, if email is set up, an email when:

- a ticket is assigned to you,
- a ticket you raised, are assigned or watch changes status or gets a public reply,
- a ticket in your care breaches its SLA.

## Related

- [Ways to raise a ticket](raising-tickets.md)
- [Quick tickets](quick-tickets.md)
- [Reports and exports](reports-and-audit.md)
