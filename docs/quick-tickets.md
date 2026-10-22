# Quick tickets

Quick tickets are templates for the requests people raise most: *Site issue*, *Password reset*, *New laptop*. Each fixes the department, type and priority (and severity, for incidents) and asks only its own few questions. SLAs, auto-assignment and the Slack, Teams, Discord and Linear fan-out apply exactly as for any other ticket.

[Manage quick tickets](/quick-tickets)

## Raising one

1. Click a tile at the top of *New ticket*, or **Quick ticket** in the header.
2. Add a short summary, answer the template's questions, add the details and paste a screenshot if asked.
3. Submit. The ticket goes straight to the template's department.

In Discord, `/ticket template:<name>` starts from a template too.

## Creating a template

*Manage → Quick tickets* (permission `teams.manage`). Start from blank or from one of the starters (*Site issue*, *Password reset*, *New laptop*…).

| Field | What it does |
| --- | --- |
| **Name**, **Short description**, **Icon and colour** | The tile people click |
| **Guidance** | Shown at the top of the form |
| **Goes to** | The department that receives the ticket |
| **Type**, **Priority**, **Severity**, **Status**, **Tags** | Fixed for every ticket raised from it |
| Questions (with **Required**) | The template's own fields, with the same types as intake forms |
| **Ticket title** | Built from the answers, e.g. `Site issue: {{site}} - {{summary}}` |
| **Screenshot** | Not asked, optional or required |
| **Who can use it** / **Available to people** | Everyone who can raise tickets, or members of selected teams only |

### Title fill-ins

The title can use each question's key, plus `{{summary}}` and `{{requester}}`. A fill-in nobody answered is dropped together with the separator next to it, so `Site issue: {{site}} - {{summary}}` with no site becomes `Site issue: Checkout is slow`.

### Screenshots

People paste them into the details (`Win+Shift+S`, then `Ctrl+V`) or use the picker. The server enforces *required* for pasted screenshots. A file added with the picker is uploaded straight after the ticket is created, so for that case *required* is a prompt in the form rather than a server check.

### Department questions

The department's own intake questions are still asked, except where the template asks the same thing.

## Deleting a template

Deleting hides the template. Tickets already raised from it keep their history.
