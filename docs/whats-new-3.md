# What's new in 3.0

InfraTicket 3.0 is about departments running their own work: each department has its own selector view, shifts, connectors, mailbox, approval rules and flows, and other departments do not see them.

## Department selector

The selector at the top of every page narrows tickets, counts, the activity heatmap, on-call and shifts to one department. People see the departments they belong to; a department they are not in is shown locked. Anyone with `tickets.view_all` can open every department. The choice is remembered on the device.

## Shifts and team leaders

For departments that work set hours, with or without a standby. Under *Shifts*, each department's card says whether it is in now, which shift, until when, and who leads it, with their number.

- A department's managers (or anyone who manages its on-call) edit its schedule: shifts with their days, start and end times, a team leader and members. An end before the start runs past midnight.
- One-off changes cover a single date: closed (a public holiday), a different leader, or different hours.
- Times are in the department's own time zone.

[Open shifts](/shifts)

## Shift handover

At each shift change, InfraTicket can send the incoming shift a handover. It lists what is open (urgent, high, unassigned, past SLA), what is paging, which monitors are down, and what was raised, resolved and escalated on the shift that is ending.

- Switch it on in the department's schedule editor, choose minutes before the shift starts, and where it goes: Teams, Slack, and an email to the incoming team leader.
- *Preview* shows what it would say now; *Send now* sends it at once.
- It goes to the department's Teams and Slack route (see [Microsoft Teams](microsoft-teams.md)) and to the department's own channels under Connections.

## Approvals

"Needs approval by X before work starts": Marketing sign-offs, Finance limits, access requests.

- **Rules** (*Approvals → Rules*) apply to new tickets. A rule can match on type, priority, labels, words in the subject or description, a quick-ticket template, or a department form answer, such as `amount` is more than `50000`. Amounts with a currency or separators, like R 75,000, are read as numbers.
- **Approvers** can be named people, everyone with a role, the department's managers, or the shift leader on duty. Choose whether any one of them or all of them must approve.
- **By hand**: *Request* in the ticket's Approvals panel (permission `tickets.request_approval`).
- While an approval is waiting, the ticket cannot be started or resolved. This applies from the web, Slack, Teams and Discord alike.
- Approvers are told in the app and by email. The department's Slack channel gets *Approve*/*Reject* buttons, and its Teams channel gets a card with both. Approving from Teams needs the Teams bot (a webhook channel only links to the ticket).
- A rejection closes the ticket, unless the rule says to keep it open. Every decision is noted on the ticket with who made it and where.
- *Approvals* in the sidebar lists what is waiting on you.

[Open approvals](/approvals)

## Connections (department integrations)

The organisation-wide integrations stay as they are. Each department can also have connectors of its own, which other departments never see. Its managers add them under *Connections*; integration administrators can add shared ones.

| Kind | What it is for |
| --- | --- |
| API connection | An API's address, credentials and headers, kept once and encrypted. Monitors, polling alert sources and flows use it by name. |
| Outlook mailbox | New mail becomes the department's tickets; see below. |
| Slack channel | The department's own incoming webhook. Its tickets, handovers and approval requests are posted there even if the organisation's Slack is not set up. |
| Teams channel | The same, through a Teams Workflows webhook. |
| Outgoing webhook | The department's ticket events POSTed as JSON to its own tools, optionally signed (as [custom HTTP integrations](custom-http.md) are). |

An API connection has *Save and call*, which calls a path and shows the response.

[Open connections](/connections)

### API monitors through a connection

In an API monitor, choose a *Saved API connection* and a path. The monitor takes its address and credentials from the connection, and keeps no secret of its own.

## Alert sources that call an API

Jenkins, and every other alert source, can now fetch alerts as well as being sent them. In the source's settings, turn on *Fetch alerts from an API*. Then choose an API connection, a path, how often to call it, and where the list of alerts is in the response. The source's own reading rules (Jenkins, Grafana, or the generic field mapping) turn each item into an alert.

- Something reported as failing raises an alert; when it reports healthy again, or disappears from the list, the alert resolves.
- *Test the poll* shows the alerts that would be read, sending nothing. *Poll now* runs it for real.
- **Jenkins**: make an API connection to `https://jenkins.example.com` with *Username and password*, using a Jenkins API token as the password. Then choose *Every job's health* (path `/api/json?tree=jobs[name,fullName,url,color]`, list at `jobs`). Red jobs raise an incident, yellow (unstable) a lower one, and blue clears it. A job's `lastBuild/api/json` works too.
- **Grafana**: *Firing Grafana alerts* reads Grafana's own Alertmanager with a service account token.

## Outlook mailbox to tickets

Mail sent to a department mailbox, such as `finance@`, becomes that department's tickets. They are routed, auto-assigned and approval-checked like any other. A reply in the same email conversation, or mail with the ticket's reference in its subject, is added to that ticket. Routes can send mail from a sender, or with a word in its subject, to another department.

Set it up once in Microsoft Entra ID:

1. *App registrations → New registration* (single tenant). Note the *Application (client) id* and *Directory (tenant) id*.
2. *Certificates & secrets → New client secret*. Copy the value.
3. *API permissions → Add → Microsoft Graph → Application permissions*: `Mail.Read`. Add `Mail.ReadWrite` to mark handled mail read, and `Mail.Send` to reply with the ticket number. Then *Grant admin consent*.
4. Limit the app to this mailbox with an Exchange application access policy (`New-ApplicationAccessPolicy -AccessRight RestrictAccess -AppId <client id> -PolicyScopeGroupId finance@company.co.za`). Without one, an application permission can read every mailbox in the tenant.
5. In InfraTicket, *Connections → Add → Outlook mailbox*. Enter the address, the two ids and the secret, then *Save and test*.

Mail is read every minute. *Check mail now* reads it at once. With `Mail.Read` alone, each message is remembered once handled, so nothing is raised twice.

## Flows

Flows let a department draw how alerts and escalations move, as connected steps. Department managers build their own department's flows; `flows.manage` builds flows for any department, or for all of them.

| Step | Does |
| --- | --- |
| When | Starts the flow: a ticket is raised, assigned, changes status, is escalated, gets a comment, or breaches its SLA |
| If | Priority, type, status, source, labels, subject, severity, assignee, whether the department is on shift, or the hour. Exits *Yes* and *No* |
| Wait | Minutes; optionally only carry on if the ticket is still open |
| Tell people | The assignee, requester, managers, shift leader, whoever is on call, or chosen people, in the app and optionally by email |
| Page on-call | Through a policy, or the department's default |
| Post to Slack / Teams | To the department's channel |
| Call an API | Through an API connection, with a JSON body. Exits *Worked* and *Failed* |
| Send an email | To any addresses |
| Change the ticket | Priority, status, assignee, labels |
| Ask for approval | As approvals above |
| Escalate to department | Hands it over with a reason |

Messages, paths and bodies can use `{{ticket.reference}}`, `{{ticket.subject}}`, `{{ticket.priority}}`, `{{ticket.url}}` and the other values listed in the editor.

- *Try on ticket* runs the flow now against a ticket. Every run is listed beside the canvas, step by step, with what each step did.
- A flow's own changes never start flows again, and a run stops after 100 steps if the arrows loop.
- A flow can be saved half-built while it is off. To switch it on, it needs one *When* step and its required settings.

[Open flows](/flows)
