# Departments, people and forms

## Departments (Teams)

A department (called a *team* in the app) owns a queue of tickets. Setup creates **Support** (`SUP`), **Operations** (`OPS`) and **Engineering** (`ENG`); rename, delete or add more under *Manage → Teams* (permission `teams.manage`).

[Open Teams](/teams)

Click **New team**, or a team's name, to open its dialog:

| Field | Purpose |
| --- | --- |
| **Name**, **Key**, **Description**, **Colour** | How the department appears. The key is a short code such as `FIN` |
| **Default priority** | Pre-selected on new tickets for this department |
| **First response target**, **Resolution target** | Its SLA (see [SLAs](sla-and-assignment.md#sla-targets)) |
| **Routing** | Manual, Round robin or Least busy (see [Auto-assignment](sla-and-assignment.md#auto-assignment)) |
| **Members** | Tick who belongs to it. A person's departments can also be set on the People page |
| **Where these tickets are announced** | Its own Slack channel, Slack ping, Linear team and Teams webhook |
| **Links to other systems** | Consoles shown under [Quick links](quick-links.md) |
| **Intake form** | The questions asked when someone raises a ticket here |

The announcement, links and intake form sections appear once the team has been saved.

Departments are also what monitors, alert sources, on-call escalation policies and maintenance windows belong to.

## Intake forms

Each department has its own form, asked on the web, in the Slack `/gml` modal, on the Teams card and (partly) in Discord. Add a question with **Add question**, then set its label, type, help text and whether it is **Required**. Reorder with *Move up* / *Move down*.

| Type | Answer |
| --- | --- |
| `text`, `textarea` | Free text |
| `number` | A number |
| `date` | A date |
| `select`, `multiselect` | One or several of the options you list |
| `checkbox` | Yes or no |
| `email`, `url` | Validated email address or link |
| `lookup` | A record picked from your own database (see [Database lookups](database-lookups.md)) |

Answers are validated against the field definitions on the server, whichever tool they were typed into, because a chat submission is an HTTP request and can claim anything. Each question has a stable **key**; answers are stored under it, so renaming a label does not lose history.

## People

*Manage → People* (permission `users.view` to see, `users.create` to add). There is **no open sign-up**: every account is created here, by someone using an invite link you made, or by single sign-on if you turn on account creation.

[Open People](/people)

### Adding someone

1. **New user**.
2. Fill in **Full name**, **Email**, optionally **Username**, **Job title** and **Phone** (international format, `+27 82 123 4567`, used for SMS and calls).
3. Choose a **Role** (see [Roles and permissions](roles-and-permissions.md)) and their departments.
4. Optionally tick extra permissions on top of the role.
5. Save. A **Temporary password** is shown **once**: copy it and send it to the person securely. They should change it under *Profile → Change password*.

### Inviting people

Rather than typing everyone in, make an invite link and share it (permission `users.invite`, which Administrators and Managers start with).

1. *People → Invite people*.
2. Choose the **Role** they get. You can only pick roles within your own access, as when creating an account.
3. **Company email domains**: only addresses ending in these are accepted, e.g. `goldmedialab.com`. It starts with your own domain; empty accepts any address.
4. Optionally limit the **departments** they can pick (none ticked means any), the **expiry** (7 days by default) and **how many people** can use it (empty for no limit).
5. Or fill in **For one person** to make a single-use link for one address. It is emailed to them when [email](email.md) is set up.
6. **Create invite link** and copy it. It is shown **once**: only a fingerprint of it is stored, so a lost link cannot be recovered, only replaced.

Whoever opens the link enters their **first name**, **surname**, **company email**, picks their **department** from the list and chooses a password (at least 10 characters). Their account is made with the invite's role as a plain member of that department, and they are signed straight in. Everyone who manages people gets a notification, so an admin can then decide whether they should be a department manager.

The **Invites** tab lists every invite with its uses, expiry and status. **Revoke** stops a link working at once; accounts already made with it are kept. Expired, used-up, revoked and mistyped links all show the same message, so a guessed link learns nothing.

### Department managers

Each member of a department is either a **member** or a **manager** of it. New people, invited or not, start as members; an admin chooses the managers afterwards (permission `teams.manage` or `users.update`):

- in someone's account (*Edit account → Departments*), with the Member / Manager choice next to each department; or
- in *Teams → Edit department → Members*, with the same choice next to each person.

A department's managers can edit that department's on-call schedules, rosters and overrides, whatever their role, and act on pages about its tickets. They are also who a "team leads" escalation step reaches.

### Changing and removing accounts

- **Status**: *active* or *suspended*. Suspending ends the person's sessions at once and stops them being paged.
- **Reset password** issues a new temporary password and ends their sessions.
- **Delete** removes the account (permission `users.delete`). Tickets keep the person's name in their history.
- The last active administrator cannot be suspended, deleted or demoted.

### Your own profile

Everyone can edit their own name, phone number, paging rules, phone push devices, Discord link, theme and password under *Profile*. See [Paging channels](paging-channels.md).

> **Note** Escalation policies can page "a team's leads": its department managers. A department with no managers pages every active member instead.
