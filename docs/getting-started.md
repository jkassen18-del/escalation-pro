# Welcome to InfraTicket

InfraTicket is one self-hosted platform for **ticketing**, **incident response**, **monitoring**, **on-call paging**, **status pages** and **database backups**. Tickets live in the web app and are mirrored into Slack, Microsoft Teams, Discord and Linear, so people can raise and answer them wherever they already work.

The same build runs as a portable `InfraTicket.exe` on a laptop, on a lab or on-prem server (SQLite, PostgreSQL or MySQL), in Docker, or as a serverless function.

## What is in it

| Area | What it does | Where |
| --- | --- | --- |
| Tickets | Requests, incidents, problems and questions, with SLAs, assignment, comments, internal notes, attachments and escalation | [Working with tickets](tickets.md) |
| Quick tickets | Templates for the requests people raise most, routed straight to a department | [Quick tickets](quick-tickets.md) |
| Monitoring | HTTP(S), TCP, ping, DNS, SSL, heartbeat and database checks, plus webhooks from AWS, Azure, Grafana, Jenkins and others | [Monitors](monitoring.md), [Alert sources](alert-sources.md) |
| Incidents | Alerts become incident tickets, deduplicated and grouped, routed by rules | [The alert pipeline](alert-pipeline.md) |
| On-call | Rotations, fixed rosters, overrides, escalation policies, and paging by push, email, SMS, phone, Teams call or Discord DM until someone acknowledges | [On-call](on-call.md), [Paging channels](paging-channels.md) |
| Maintenance | Planned work that pauses paging or alerting, shown on status pages | [Maintenance](maintenance.md) |
| Status pages | Public and internal pages with 90-day uptime and incident updates | [Status pages](status-pages.md) |
| Backups | Scheduled, encrypted backups of PostgreSQL, Supabase, MySQL, MongoDB, SQLite and SQL Server | [Databases and backups](databases-and-backups.md) |
| Integrations | Slack, Teams, Discord, Linear, email, custom HTTP, database lookups, SSO | [The integrations catalogue](integrations.md) |

## First-run setup

A brand-new database has no users, so the first page you see is **Create the first administrator**. There is no public sign-up: after this, every account is created by an administrator or manager on the People page.

1. Open the app. The portable exe opens <http://localhost:8080> for you; a server install is on whatever address you deployed it to.
2. Fill in:
   - **Setup token** (only shown when the server has `SETUP_TOKEN` set; see [Security model](security.md#first-run-setup)).
   - **Organisation name**, shown in the sidebar, notifications and status pages.
   - **Your name**, **Email** and **Password** (at least 10 characters), twice.
3. Leave **Start with a sample workspace** ticked to get a working operations setup straight away, or untick it for a blank workspace.
4. Click **Create administrator account**. You are signed in.

> **Warning** On an address the internet can reach, set `SETUP_TOKEN` before the first start. Otherwise the first person to open the page becomes the administrator.

### What the sample workspace contains

Setup always creates three departments: **Support** (`SUP`), **Operations** (`OPS`) and **Engineering** (`ENG`). The sample workspace adds, around you:

- You as a lead of **Operations**.
- An on-call schedule, **Operations primary**: a weekly rotation with you on it, handing over on Mondays.
- An escalation policy, **Operations SEV policy**: whoever is on call first, then the Operations team leads after 10 minutes, repeated once. It is set as the Operations team's default.
- Three monitors: an HTTP check of this server's own `/health`, a TCP check of its port, and an example heartbeat for a nightly job.
- A **Generic webhook** alert source.
- A public status page at `/status/status` showing the web app and API.

Everything points at the server itself, so it works on a laptop with no internet access. Delete any of it once you have your own.

## Your first ten minutes

1. **Add your people.** *People → New user*. Give each a role (see [Roles and permissions](roles-and-permissions.md)) and their departments.
2. **Set up your departments.** *Teams*: SLA targets, how tickets are assigned, and the department's own intake questions.
3. **Raise a ticket** from *New ticket* (or press `c` anywhere) and watch it arrive in the department's queue.
4. **Connect a chat tool.** *Integrations* shows every connector as a tile; Slack, Teams and Discord each have a guided setup with a test button.
5. **Set up paging.** *Profile → Notifications when paged*: add your mobile number, turn on phone notifications, and press *Send a test page to me*.
6. **Watch something.** *Monitoring → New monitor* with your website's URL.

## Keyboard shortcuts

| Key | Does |
| --- | --- |
| `c` | New ticket (with the *Create tickets* permission) |
| `/` | Focus the search box on the ticket list |

## Where to go next

- [Finding your way around](navigation.md) explains every item in the sidebar.
- [Portable exe](portable.md) covers the options of `InfraTicket.exe`.
- [Troubleshooting and FAQ](troubleshooting.md) when something does not work.
