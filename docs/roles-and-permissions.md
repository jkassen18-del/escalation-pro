# Roles and permissions

Access is built from **permissions**, one for each thing a person can do, down to individual buttons. A **role** is a named preset of permissions. Everyone has exactly one role, and can be given **extra permissions** on top of it for anything their role does not cover.

So there are two ways to give someone access, and they combine:

- **Give them a role** with the preset that fits: one of the four built-ins, or a role you created.
- **Give them particular access**: tick extra permissions in their account on the People page.

## Roles

Open **People → Roles** to see every role, how many people hold it and exactly what it grants.

| Role | Intended for |
| --- | --- |
| **Administrator** | Full access. Always holds every permission, including ones added in later versions, and cannot be edited |
| **Manager** | Runs queues and people, and their own departments' on-call. Everything except integrations, system settings, backups and other departments' on-call |
| **Agent** | Works tickets in their departments |
| **Viewer** | Reads tickets in their departments |

- **Create a role** with **New role**: name it, then tick what it may do. Each group has **Select all**.
- **Built-in roles** (other than Administrator) can have their access changed, but cannot be renamed or deleted.
- **Deleting a custom role** that people hold asks which role to move them to. Their extra permissions stay as they are.
- Changing a role's permissions changes them for everyone who holds it, immediately.

Managing roles needs **Manage roles**. Assigning roles and extra permissions to people needs **Assign roles and permissions**.

### Nobody can hand out more than they have

You can only put a permission into a role, or grant it to someone, if you hold it yourself. Choosing a role for someone counts as granting everything in it, so the role picker only offers roles within your own access. On top of that, only administrators can grant the permissions the built-in Manager role does not start with, and only an administrator can make someone an administrator, or edit, reset or delete an administrator's account.

## Departments

Each person belongs to one or more **departments**, chosen when their account is created or edited. Departments decide what they see:

- **Tickets.** Without **View all tickets**, people see only the tickets of their own departments, plus any ticket they raised, are assigned to or created. That applies everywhere: lists, counts, search, reports and exports, the AI connector, and Slack, Teams, Discord and Linear actions.
- **Alerts and pages** tied to a ticket follow the same rule. A page that is ringing you is always shown to you.
- **Department links** show the links of your own departments.
- **On-call** schedules and who is on call are visible to everyone. Changing them needs **Manage all on-call** (any department), **Manage own department's on-call** (only the departments you belong to), or being one of that department's **managers** (see [Department managers](teams-and-people.md#department-managers)). Escalation policies and phone settings span departments and need **Manage all on-call**.

Internal notes, and files attached to them, are visible only with **Internal notes**.

The API checks every permission on every request. Hiding a button in the web app is a convenience, not the security boundary.

## Permissions by built-in role

✓ means the built-in role starts with the permission. Roles you create start with none.

### Tickets

| Permission | What it allows | Administrator | Manager | Agent | Viewer |
| --- | --- | --- | --- | --- | --- |
| `tickets.view_all` | View all tickets: See tickets outside their own departments | ✓ | ✓ |  |  |
| `tickets.create` | Create tickets: Raise new tickets, including from quick-ticket templates | ✓ | ✓ | ✓ |  |
| `tickets.update` | Edit ticket details: Subject, description, type, department, severity, commander, due date and tags | ✓ | ✓ | ✓ |  |
| `tickets.change_status` | Change status: Move a ticket between open, in progress and pending | ✓ | ✓ | ✓ |  |
| `tickets.close` | Resolve and close: Mark a ticket resolved or closed | ✓ | ✓ | ✓ |  |
| `tickets.reopen` | Reopen: Bring a resolved or closed ticket back | ✓ | ✓ | ✓ |  |
| `tickets.change_priority` | Change priority: Raise or lower a ticket’s priority | ✓ | ✓ | ✓ |  |
| `tickets.assign` | Assign tickets: Choose who works a ticket | ✓ | ✓ | ✓ |  |
| `tickets.escalate` | Escalate: Escalate a ticket to another department | ✓ | ✓ | ✓ |  |
| `tickets.page` | Page on-call about a ticket: Start an escalation policy by hand from a ticket | ✓ | ✓ | ✓ |  |
| `tickets.request_approval` | Request approval: Ask named people to sign a ticket off before work starts | ✓ | ✓ | ✓ |  |
| `approvals.manage` | Manage approval rules: Which tickets need sign-off, and from whom | ✓ | ✓ |  |  |
| `tickets.push_linear` | Send to Linear: Create a Linear issue from a ticket | ✓ | ✓ | ✓ |  |
| `tickets.reply` | Reply: Post public replies on tickets they can see | ✓ | ✓ | ✓ | ✓ |
| `tickets.comment_internal` | Internal notes: Read and write notes hidden from requesters | ✓ | ✓ | ✓ |  |
| `tickets.attach` | Attach files: Upload files and screenshots to tickets they can see | ✓ | ✓ | ✓ | ✓ |
| `tickets.delete_attachment` | Delete any attachment: Remove files other people uploaded (anyone may remove their own) | ✓ |  |  |  |
| `tickets.delete` | Delete tickets: Permanently remove a ticket | ✓ |  |  |  |
| `templates.manage` | Manage quick tickets: Create and edit quick-ticket templates | ✓ | ✓ |  |  |

### People and departments

| Permission | What it allows | Administrator | Manager | Agent | Viewer |
| --- | --- | --- | --- | --- | --- |
| `users.view` | View users: Browse the user directory | ✓ | ✓ | ✓ | ✓ |
| `users.create` | Create users: Provision new accounts | ✓ | ✓ |  |  |
| `users.update` | Edit users: Change profile details, departments and account status | ✓ | ✓ |  |  |
| `users.assign_roles` | Assign roles and permissions: Change someone’s role and extra permissions (never beyond their own) | ✓ | ✓ |  |  |
| `users.invite` | Invite people: Create invite links people use to sign themselves up into a department | ✓ | ✓ |  |  |
| `users.delete` | Delete users: Remove accounts | ✓ |  |  |  |
| `users.reset_password` | Reset passwords: Issue a new password for an account | ✓ | ✓ |  |  |
| `roles.manage` | Manage roles: Create, edit and delete roles (never beyond their own permissions) | ✓ |  |  |  |
| `teams.manage` | Manage departments: Create departments and set their routing and SLA rules | ✓ | ✓ |  |  |
| `teams.forms` | Edit intake forms: Change the questions a department asks on new tickets | ✓ | ✓ |  |  |
| `teams.links` | Manage department links: Links to AWS, Azure, Entra ID and other systems on a department | ✓ | ✓ |  |  |

### Administration

| Permission | What it allows | Administrator | Manager | Agent | Viewer |
| --- | --- | --- | --- | --- | --- |
| `settings.manage` | Manage settings: Organisation profile, ticket prefix and global SLA defaults | ✓ |  |  |  |
| `branding.manage` | Manage branding: Logo, colours and product name | ✓ |  |  |  |
| `sso.manage` | Manage single sign-on: Microsoft Entra ID and SAML sign-in | ✓ |  |  |  |
| `integrations.manage` | Manage integrations: Slack, Microsoft Teams, Discord, Linear, email, custom HTTP and database lookups | ✓ |  |  |  |
| `connector.manage` | Manage the AI connector: Turn the Claude/Copilot connector on and register clients | ✓ |  |  |  |
| `connector.use` | Use the AI connector: Create personal access tokens and connect an AI assistant | ✓ | ✓ | ✓ | ✓ |
| `reports.view` | View reports: Open the analytics dashboard | ✓ | ✓ | ✓ |  |
| `reports.export` | Export reports: Download ticket data as XLSX or CSV | ✓ | ✓ |  |  |
| `audit.view` | View audit log: Inspect the full system activity trail | ✓ | ✓ |  |  |

### Operations

| Permission | What it allows | Administrator | Manager | Agent | Viewer |
| --- | --- | --- | --- | --- | --- |
| `ops.view` | View operations: Monitors, alerts, maintenance, on-call schedules and status pages | ✓ | ✓ | ✓ | ✓ |
| `monitors.manage` | Manage monitoring: Create monitors and alert sources | ✓ | ✓ |  |  |
| `alerts.routing` | Manage alert routing: Rules that send alerts to departments and policies | ✓ | ✓ |  |  |
| `flows.manage` | Build flows: Draw alert and escalation flows for any department (department managers can build their own) | ✓ | ✓ |  |  |
| `maintenance.manage` | Manage maintenance: Schedule, extend and end maintenance windows | ✓ | ✓ |  |  |
| `oncall.manage` | Manage all on-call: Every department’s schedules and overrides, escalation policies and telephony | ✓ |  |  |  |
| `oncall.manage_own_department` | Manage own department’s on-call: Schedules, rosters and overrides for the departments they belong to | ✓ | ✓ |  |  |
| `oncall.cover` | Cover shifts: Add or remove themselves as cover on a schedule | ✓ | ✓ | ✓ | ✓ |
| `pages.respond` | Respond to pages: Acknowledge or escalate pages that reached them | ✓ | ✓ | ✓ | ✓ |
| `statuspages.manage` | Manage status pages: Create, edit and delete status pages | ✓ | ✓ |  |  |
| `statuspages.post` | Post status updates: Post incident updates to status pages | ✓ | ✓ |  |  |
| `databases.manage` | Manage database connectors: Add, edit and remove databases, health checks and backup schedules | ✓ |  |  |  |
| `backups.manage` | Run backups: Start a database backup now | ✓ |  |  |  |
| `backups.restore` | Download backups: Download decrypted backups for a restore | ✓ |  |  |  |

## Upgrading from fixed roles

Before roles could be edited, each of the four roles had a fixed list. On upgrade everyone keeps the role they had. Permissions that were split out of an older one (for example **Resolve and close** out of **Update tickets**) are given to everyone who held the older one, including as an extra permission, so nobody loses access.

The one deliberate change: managers' on-call access is now limited to their own departments (**Manage own department's on-call**) instead of every department. To restore the old behaviour, give the Manager role **Manage all on-call**.

## Safety rails

- The last active administrator cannot be removed, suspended or demoted.
- Suspending or deleting someone, or resetting their password, ends their sessions immediately.
- With [single sign-on](single-sign-on.md) required, administrators can still sign in with their password, so a broken identity provider cannot lock everyone out.

[Manage people and roles in the app](/people)
