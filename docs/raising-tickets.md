# Ways to raise a ticket

Every route below ends in the same place: a ticket in a department's queue, with that department's SLA, auto-assignment, notifications and audit trail. Only the way in differs.

| Way in | Who uses it | Source shown on the ticket |
| --- | --- | --- |
| [The web form](#the-web-form) | Anyone with *Create tickets* | `web` |
| [A quick ticket](#quick-tickets) | Anyone allowed to use the template | `web` |
| [Slack `/gml`](#slack) | People whose Slack email matches an account | `slack` |
| [Teams `@InfraBot`](#microsoft-teams) | People whose Teams email matches an account | `msteams` |
| [Discord `/ticket`](#discord) | People who linked their Discord account | `discord` |
| [A Linear issue](#linear) | Anyone in a mapped Linear team | `linear` |
| [A monitor or alert](#monitors-and-alerts) | Machines | `monitor` / `webhook` |
| [An AI assistant](#ai-assistants) | People who connected Claude | `claude` |

> **Note** There is no inbound email-to-ticket. Email is used only to send notifications out.

## The web form

*New ticket* in the header, or press `c`.

1. Pick the **Team** (department). Its own intake questions appear below.
2. Fill in **Subject**, **Description**, **Type**, **Priority** and, optionally, **Tags** (comma separated, for example `payments, eu`) and an **Assignee**.
3. Answer the department's questions. Required ones are marked; the server checks them again.
4. Paste screenshots straight into the description, or attach files.
5. **Create ticket**.

If you leave the assignee empty, the department's routing picks one (round robin or least busy) or the ticket waits unassigned. See [SLAs, routing and escalation](sla-and-assignment.md).

## Quick tickets

The tiles at the top of *New ticket*, and the *Quick ticket* button in the header, are templates that fix the department, type and priority and ask only a few questions. See [Quick tickets](quick-tickets.md).

## Slack

Once the Slack bot is installed with the `/gml` command (see [Slack](slack.md)):

```text
/gml finance        opens Finance's intake form as a modal
/gml                asks which department first
```

The department name is matched forgivingly: `finance`, `Finance`, `gml-finance` and `fin` all work. Switching department in the modal rebuilds the form without losing what you typed.

## Microsoft Teams

With the Teams bot installed in a channel (see [Microsoft Teams](microsoft-teams.md)):

```text
@InfraBot finance   posts Finance's intake form as an Adaptive Card
@InfraBot           lists the departments
```

Teams has no slash commands for third-party apps, so mentioning the bot is the equivalent.

## Discord

Link your account first with `/link` (see [Discord](discord.md)), then:

```text
/ticket department:<department> priority:<optional> template:<optional quick ticket>
```

A form asks for the subject and details, plus up to three required text questions. A department whose required questions need choices, dates or lookups gets a link to the web form instead.

## Linear

An issue created in a Linear team that is mapped to a department becomes a ticket in that department. Issues in unmapped Linear teams are left alone. See [Linear](linear.md).

## Monitors and alerts

Monitors that go down and alerts from AWS, Azure, Grafana, Jenkins and others open **incident** tickets automatically. See [The alert pipeline](alert-pipeline.md).

## AI assistants

Claude (Claude Code, Claude Desktop or claude.ai) can raise tickets on your behalf through the MCP connector, with your permissions. See [AI assistants](ai-connector.md).

## Who is allowed

Every route checks the same permission, *Create tickets* (`tickets.create`). A chat message proves nothing on its own, so Slack, Teams and Discord requests are only honoured when the sender maps to an active account here that holds the permission.
