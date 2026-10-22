# Finding your way around

The sidebar on the left is the same on every page. On a phone it folds away behind the menu button at the top left. Items you have no permission for are hidden, so two people may see different sidebars.

## Tickets

| Item | Shows |
| --- | --- |
| **My tickets** | Tickets assigned to you (`/tickets?assignee=me`) |
| **All tickets** | Every ticket you are allowed to see |
| **Unassigned** | Tickets nobody has picked up yet |
| **Breached SLA** | Tickets past their due date |

The number beside each item is a live count. See [Working with tickets](tickets.md).

## Operations

| Item | What it is for | Guide |
| --- | --- | --- |
| **Command centre** | What is paging, what is down, who is on call. Refreshes every 15 seconds | [Command centre](command-centre.md) |
| **Monitoring** | Monitors, alert sources, routing rules, alerts and maintenance | [Monitors](monitoring.md) |
| **Maintenance** | Planned work that pauses paging | [Maintenance](maintenance.md) |
| **On-call** | Who is on call now, schedules, escalation policies, phone and SMS | [On-call](on-call.md) |
| **Status pages** | Public and internal status pages | [Status pages](status-pages.md) |
| **Databases** | Database health and encrypted backups (needs *Manage backups*) | [Databases and backups](databases-and-backups.md) |
| **Quick links** | The consoles your teams work in (AWS, Azure, Entra ID…) | [Quick links](quick-links.md) |

## Manage

| Item | Permission | Guide |
| --- | --- | --- |
| **Reports** | `reports.view` | [Reports](reports-and-audit.md) |
| **People** | `users.view` | [People](teams-and-people.md#people) |
| **Teams** | `teams.manage` | [Departments](teams-and-people.md) |
| **Quick tickets** | `teams.manage` | [Quick tickets](quick-tickets.md) |
| **Integrations** | `integrations.manage` | [The integrations catalogue](integrations.md) |
| **Settings** | `settings.manage` | [Settings](settings.md) |
| **Audit log** | `audit.view` | [Audit log](reports-and-audit.md#audit-log) |
| **Docs** | everyone | This documentation |

## The header

- **New ticket** (or the `c` key) opens the ticket form.
- **Quick ticket** opens the list of quick-ticket templates.
- The **bell** holds in-app notifications: assignments, mentions, SLA breaches, pages and maintenance notices. *Mark all read* clears it.
- A **maintenance banner** appears across the top while a maintenance window is running.

## Your account menu

Click your name at the bottom of the sidebar:

- **Your profile**: name, phone number, paging rules, phone push, Discord link, password. See [Paging channels](paging-channels.md).
- **Theme**: cycles through light, dark and system.
- **Sign out**.

## Docs links on every page

Most pages have a **Docs** link in their header that opens the matching guide here. Every guide has an **Open in app** button that goes the other way.
