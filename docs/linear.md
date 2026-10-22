# Linear

Linear mirrors tickets as Linear issues, keeps comments and status in sync both ways, and turns issues raised in mapped Linear teams into tickets. Works on Linear's free plan.

[Open Integrations](/integrations)

## Set up

*Integrations → Linear*:

1. **API key**: Linear → **Settings → API → Personal API keys** → create one (`lin_api_…`) and paste it. Save.
2. **Linear team**: load your teams and pick the default team for mirrored issues.
3. **Mirror automatically from**: *Urgent only*, *High and urgent* (default), *Normal and above* or *Everything*. Tickets at this priority or higher create a Linear issue, including when an escalation raises the priority past it.
4. **Create Linear issues automatically**: when off, you can still push a single ticket with *More actions → Create Linear issue* on the ticket.
5. **Test**, then save.

### Team mapping

Under **Team mapping**, link each Linear team to a department. This decides both:

- **Outbound**: a department's tickets are filed in its own Linear team instead of the default.
- **Inbound**: an issue created in a linked Linear team becomes a ticket in that department.

An issue in an unlinked Linear team is left alone rather than dumped into a queue nobody watches, and an issue this app created never comes back as a second ticket.

> **Note** Older guides put this under *Teams → Routing*. A department's **Linear team ID** field there still works for outbound mirroring; the Integrations team mapping is the place to manage both directions.

## Syncing back from Linear

To receive status changes, comments and new issues, Linear must reach InfraTicket at a public https address:

1. In Linear: **Settings → API → Webhooks → New webhook**.
2. URL: `https://tickets.example.com/api/webhooks/linear`.
3. Tick **Issues** and **Comments**.
4. Copy the webhook's signing secret into **Inbound webhook secret** in InfraTicket and save.

Every delivery is verified with an HMAC-SHA256 signature over the raw body (`Linear-Signature` header); unsigned or mismatched deliveries are refused.

## How fields map

| InfraTicket | Linear |
| --- | --- |
| Priority urgent / high / normal / low | 1 Urgent / 2 High / 3 Medium / 4 Low |
| Description | Issue description, with a link back to the ticket |
| Public replies | Linear comments (internal notes never) |
| Status | Linear state type: triage, backlog and unstarted → `open`; started → `in_progress`; completed → `resolved`; canceled → `closed` |

- Comments typed on the Linear issue come back as comments on the ticket, and the requester is told.
- A Linear comment starting with *resolved*, *fixed*, *done*, *sorted*, *completed* or *closed* also resolves the ticket, when the Linear user's email matches an account here with *Update tickets*.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Test: authentication failed | The API key is wrong or revoked |
| Issues are created in the wrong team | Check *Team mapping* and the department's Linear team ID |
| Status changes in Linear do nothing | The webhook is missing, its secret differs, or the Public URL is not reachable |
| Issues raised in Linear do not become tickets | That Linear team is not linked to a department |
