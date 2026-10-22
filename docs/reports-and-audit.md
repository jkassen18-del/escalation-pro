# Reports, exports and the audit log

## Reports

*Manage → Reports* (permission `reports.view`). Pick a window of **7 days**, **30 days** or **90 days**.

| Section | Shows |
| --- | --- |
| Headline figures | **Open**, **Overdue**, **Unassigned** and **Resolved** counts |
| **Volume** | Tickets created and resolved per day |
| **SLA performance** | **Average first reply**, **Average resolution** and **Compliance** (share resolved within their due date) |
| **By team** | Tickets per department |
| **By priority** | The mix of priorities |
| **Workload by assignee** | Open tickets per person |

Reports count only the tickets you are allowed to see, so an agent's report covers their own departments.

[Open reports](/reports)

### Export XLSX

**Export XLSX** (permission `reports.export`, administrators and managers by default) downloads an Excel workbook for the selected window with three sheets:

| Sheet | Columns |
| --- | --- |
| **Tickets** | Reference, Subject, Status, Priority, Type, Source, Team, Assignee, Requester, Escalation level, Tags, Created, Updated, Due, First response, Resolved, Closed, Overdue, Comments, Attachments |
| **Comments** | Ticket, when, author, Internal (Yes/No), body |
| **History** | Ticket, when, who, what changed, from, to |

> **Warning** The **Tickets** sheet is limited to tickets you can see. The **Comments** and **History** sheets currently cover every ticket created in the window, including internal notes, whatever the exporter's department membership. Grant `reports.export` only to people who may read everything.

## Audit log

*Manage → Audit log* (permission `audit.view`). Every privileged action is recorded with **When**, the **Area**, **What happened** in plain words, who did it, and the **Source** IP address.

Use the search box and the **All areas** filter to narrow it down. It shows 100 entries per page.

Examples of what is recorded:

- Failed single sign-on (`sso_login_failed`) and setup attempts with a wrong token.
- Users created, suspended or deleted; role and permission changes; password resets.
- Integration settings saved or tested (never the credential itself).
- Ticket deletions and escalations, and status changes made from Slack, Teams or Discord buttons.
- Maintenance windows ended, extended, skipped or cancelled.
- Decrypted backup downloads.
- Actions an AI assistant took on someone's behalf.

> **Note** The audit log is append-only by convention: the app never edits or deletes entries, but someone with direct database access could.

[Open the audit log](/audit)
