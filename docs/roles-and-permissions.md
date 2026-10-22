# Roles and permissions

Every account has one **role**, which grants a fixed set of permissions. Administrators and managers can grant individual extra permissions on top of a role on the People page, but cannot take away what a role includes; to give someone less, choose a lower role.

| Role | Intended for |
| --- | --- |
| **Administrator** | Full access, including integrations, settings, backups and the audit log |
| **Manager** | Runs queues, people and operations; everything except integrations, system settings and backups |
| **Agent** | Works tickets in their assigned departments |
| **Viewer** | Read-only access to tickets in their assigned departments |

The API checks every permission on every request. Hiding a button in the web app is a convenience, not the security boundary.

## Who sees which tickets

People without **View all tickets** see tickets in the departments they belong to, plus any ticket they raised, are assigned to, or created. Internal notes are visible only with **Internal notes**.

## Permissions by role

✓ means the role includes the permission. Anything else can be granted individually.

| Permission | What it allows | Administrator | Manager | Agent | Viewer |
| --- | --- | --- | --- | --- | --- |
| `tickets.view_all` | See tickets outside their own departments | ✓ | ✓ |  |  |
| `tickets.create` | Raise new tickets and escalations | ✓ | ✓ | ✓ |  |
| `tickets.update` | Change status, priority and fields | ✓ | ✓ | ✓ |  |
| `tickets.assign` | Route tickets to a department or agent | ✓ | ✓ | ✓ |  |
| `tickets.delete` | Permanently remove a ticket | ✓ |  |  |  |
| `tickets.comment_internal` | Read and write internal notes | ✓ | ✓ | ✓ |  |
| `users.view` | Browse the user directory | ✓ | ✓ | ✓ | ✓ |
| `users.create` | Create accounts | ✓ | ✓ |  |  |
| `users.update` | Change profile, role and department membership | ✓ | ✓ |  |  |
| `users.delete` | Suspend or remove accounts | ✓ |  |  |  |
| `users.reset_password` | Issue a new password for an account | ✓ | ✓ |  |  |
| `teams.manage` | Create departments, set routing, SLAs, forms, links and quick tickets | ✓ | ✓ |  |  |
| `settings.manage` | Organisation profile, defaults, branding and SSO | ✓ |  |  |  |
| `integrations.manage` | Configure Slack, Teams, Discord, Linear, email, custom HTTP and lookups | ✓ |  |  |  |
| `reports.view` | Open the reports dashboard | ✓ | ✓ | ✓ |  |
| `reports.export` | Download ticket data as XLSX | ✓ | ✓ |  |  |
| `audit.view` | Read the audit log | ✓ | ✓ |  |  |
| `monitors.manage` | Monitors, alert sources, routing rules and maintenance windows | ✓ | ✓ |  |  |
| `oncall.manage` | Schedules, overrides for others, escalation policies and telephony | ✓ | ✓ |  |  |
| `statuspages.manage` | Status pages and their updates | ✓ | ✓ |  |  |
| `backups.manage` | Database connectors and running backups | ✓ |  |  |  |
| `backups.restore` | Download decrypted backups | ✓ |  |  |  |

## Things everyone signed in can do

Regardless of role, every signed-in person can:

- See what is down, open alerts, who is on call, maintenance windows and status pages.
- Acknowledge or escalate a page.
- Add themselves as cover on an on-call schedule, and remove their own cover.
- Set their own notification rules, mobile number, phone notifications and linked Discord account.
- Read this documentation.

## Safety rails

- The last active administrator cannot be removed, suspended or demoted.
- Suspending or deleting someone, or resetting their password, ends their sessions immediately.
- With [single sign-on](single-sign-on.md) required, administrators can still sign in with their password, so a broken identity provider cannot lock everyone out.

[Manage people in the app](/people)
