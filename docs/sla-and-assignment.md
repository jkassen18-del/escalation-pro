# SLAs, routing and escalation

Each department decides how its tickets find an owner, how fast they must be answered and resolved, and what happens when they stall. All of it is set on the department under *Teams* (permission `teams.manage`).

[Open Teams](/teams)

## Auto-assignment

The department's **Routing** setting decides who gets a new ticket that arrives without an assignee:

| Option | Behaviour |
| --- | --- |
| **Manual** | Stays unassigned until someone picks it up |
| **Round robin** | Each new ticket goes to the next member in turn |
| **Least busy** | Goes to the member with the fewest open tickets |

Only active members with the Agent role or above are eligible. Viewers never receive work.

## SLA targets

A department sets a **First response target** and a **Resolution target**. Departments without targets, and tickets with no department, use the **Fallback SLA** under [Settings](settings.md).

The due date comes from the resolution target, scaled by priority:

| Priority | Multiplier | With a 24-hour target |
| --- | --- | --- |
| Urgent | ×0.25 | 6 hours |
| High | ×0.5 | 12 hours |
| Normal | ×1 | 24 hours |
| Low | ×2 | 48 hours |

- The **first-response clock** stops at the first public reply from someone other than the requester.
- A background job checks for breaches every five minutes (`SLA_CHECK_INTERVAL_MS`). Each breach is announced once: an in-app notification to the assignee and watchers, plus the department's Slack, Teams, Discord and email channels.
- *Breached SLA* in the sidebar lists every ticket past its due date.

> **Note** On serverless hosting there is no background process. Call `/api/cron/sla` on a schedule; see [Environment variables](environment-variables.md#scheduled-jobs-on-serverless).

## Escalation

**Escalate** on a ticket:

1. Raises its escalation level (up to 5).
2. Bumps its priority: low and normal become high, high becomes urgent.
3. Records your reason as an internal note.
4. Notifies every connected channel.
5. If Linear is connected with **Create Linear issues automatically**, opens a Linear issue once the priority reaches the **Mirror automatically from** threshold.

### Sending a ticket to another department

The escalate dialog can also move the ticket to another department ("this is a network problem, not a desktop one"):

- The ticket moves to that department and its level goes up.
- The reason is kept as an internal note.
- The new department is told in the app and in its own Slack channel, Teams webhook and Linear team.
- The assignee stays only if they belong to the new department; otherwise its auto-assignment picks someone, or the ticket waits in its queue.
- The type is kept, so an incident stays an incident. You can change the priority at the same time.

## Where a department's tickets are announced

The department dialog's **Where these tickets are announced** section overrides the organisation-wide channels for that department:

| Field | Example |
| --- | --- |
| **Slack channel** | `C01234ABCDE` |
| **Ping on each ticket** | A Slack user group such as `@hr-team` or `@here`. Paste the group's ID (`S…`) to be certain it notifies |
| **Linear team ID** | Mirror this department's escalations into its own Linear team |
| **Teams webhook URL** | A Workflows URL for the department's channel |

For Linear, the newer place to map departments to Linear teams in both directions is *Integrations → Linear → team mapping*; see [Linear](linear.md).
