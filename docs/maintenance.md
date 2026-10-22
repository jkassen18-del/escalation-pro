# Maintenance windows

Schedule planned work so that expected disruption does not wake anyone. Maintenance is under *Operations → Maintenance* and on the *Maintenance* tab of Monitoring. Everyone can see it; creating and changing windows needs `monitors.manage`.

[Open Maintenance](/maintenance)

## Creating a window

**Schedule maintenance**, then:

| Field | Meaning |
| --- | --- |
| **What is happening** | The title, shown in the banner, on status pages and in notices |
| **Details** | Optional longer description |
| **What it covers** | **Everything**, or **Chosen systems**: any mix of teams (every monitor and alert source they own), monitors, alert sources and status-page components |
| **During the maintenance** | *Pause paging (still open tickets)* or *Pause alerting (record only, no tickets)* |
| When | **Once**, **Daily**, **Weekly** or **Monthly** (below) |
| **Tell the affected teams beforehand** | An in-app notice 15 minutes to a day before it starts, or *Don't notify* |
| **Publish on status pages** | Show it on every status page that includes an affected component |

### One-off and recurring

- **Once**: **Starts** and **Ends**.
- **Daily**, **Weekly** (**Days of the week**) or **Monthly** (**Day of the month**; a shorter month uses its last day): **Starts at** a wall-clock time in a **Time zone** (Africa/Johannesburg by default), **Lasts (minutes)**, **From** a date and optionally **Until** one.

Recurring windows are worked out on the fly, so editing the series changes every future occurrence.

## What happens during it

| | Pause paging | Pause alerting |
| --- | --- | --- |
| Alert recorded | Yes | Yes, marked as maintenance |
| Incident ticket | Yes | No |
| Anyone paged or notified | No | No |

- A banner across the top of the app says what is in maintenance and until when.
- Affected monitors show a *Maintenance* badge on Monitoring and the Command centre. They keep checking.
- A failed check during maintenance counts as maintenance, not as an outage: it is left out of the uptime figure and the day shows blue on the 90-day bars.
- Published windows appear on status pages under *Scheduled maintenance* (next 7 days) and *Maintenance in progress*, in the window's own time zone. The component shows *Under maintenance*, and "Maintenance in progress" and "Maintenance completed" updates are posted automatically, once each.

## Actions on a window

From its **⋯** menu: **Edit**, **End now**, **Extend by 30 minutes**, **Extend by 1 hour**, **Skip the next one** (recurring windows) or **Cancel**. Each is written to the audit log.

## When it ends

Whether on time, early or cancelled, whatever it held back that is **still firing** is raised normally, once:

- a ticket whose paging was paused is paged now;
- an alert that was only recorded becomes a ticket and pages.

Monitors that came back during the work raise nothing.

## Example: Sunday patching

Every Sunday 02:00–04:00 Johannesburg time, the Operations team patches servers:

1. **What is happening**: `Weekly OS patching`.
2. **What it covers**: Chosen systems → team *Operations*.
3. **During the maintenance**: Pause paging.
4. **Weekly**, Days of the week: *Sunday*; Starts at `02:00`; Time zone `Africa/Johannesburg`; Lasts `120` minutes.
5. **Tell the affected teams beforehand**: 1 hour.
6. **Publish on status pages**: on, if customers notice.
