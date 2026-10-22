# On-call schedules and escalation

On-call decides **who** is responsible right now (schedules) and **how** an incident climbs until someone acknowledges it (escalation policies). How each person is reached is theirs to set; see [Paging channels](paging-channels.md).

*Operations → On-call* has four tabs: **Now**, **Schedules**, **Escalation policies** and **Phone & SMS** (the last needs `oncall.manage`).

[Open On-call](/oncall)

## Now

Who is on call in every schedule at this moment, and pages that are active, with **Mine**, **Active** and **History** filters. Acknowledge or escalate from here.

## Schedules

**New schedule** (permission `oncall.manage`): a **Name**, an optional **Team**, a **Time zone** and one or more **layers**.

### Layers

A layer is either a rotation or a fixed roster. **Add layer** to stack them: a higher layer wins wherever it has someone, and a layer with a gap falls through to the one below. A common shape is a roster on top and a backstop rotation underneath.

| Rotation | How it works |
| --- | --- |
| **Daily** | Hands over every day at the handover time |
| **Weekly** | Hands over every week on the **Handover day** at the **Handover time** |
| **Custom** | Shifts of **Shift hours** each, from the **First handover** |
| **Roster** | Who is on standby for which dates, set by hand (below) |

For rotations, add people under **Rotation order** in the order they take shifts.

### Rosters

A roster is laid out week by week from a handover day and time in the schedule's time zone (Monday 08:00 by default):

1. **Lay out weeks**: pick the people to repeat, the **First week** and how many **Weeks**, and the roster is filled in, e.g. week 1 Jamal, week 2 Kopano, week 3 Jamal…
2. Change any single week afterwards, or **Add a week**.
3. **Add custom dates (e.g. Mon–Wed)** for a short stint or a long weekend.

Entries may not overlap. A week left empty falls through to the layer below.

### Overrides

An override wins over every layer for its time range: holiday cover, a swap, a sick day. **Add override** with **Who is on call**, **From**, **Until** and an optional **Note**.

- **Anyone** can add themselves as cover, and remove their own cover.
- People with `oncall.manage` can put anyone in.

### Calendar

Each schedule shows the next 14 days as a timeline and a month view of who is on call each day. **Download calendar (.ics)** exports the next 90 days for Outlook or Google Calendar.

## Escalation policies

**New policy**: a **Name**, **Description**, optional **Team**, and ordered **levels**. **Add level**, then for each one:

- **Targets**: specific people, whoever is on call in a schedule, or a team (its leads, or every member when it has none).
- **Escalate after (minutes without an acknowledgement)**.

**Repeat policy** runs the whole policy again, up to five times, if nobody acknowledges.

Example *Operations SEV policy*:

| Level | Notifies | Then waits |
| --- | --- | --- |
| 1 | Whoever is on call in *Operations primary* | 10 minutes |
| 2 | The Operations team | 10 minutes |
| | Repeat once | |

### Team defaults

Under **Team defaults**, choose each department's **Default policy**, or *None (tickets only, no paging)*. Alerts for that department page through it unless a monitor, alert source or routing rule names another.

## How a page runs

1. An incident opens with a policy (see [The alert pipeline](alert-pipeline.md)).
2. Level 1's targets are notified through their own [notification rules](paging-channels.md#notification-rules).
3. If nobody acknowledges within the level's wait, level 2 is notified, and so on.
4. After the last level the policy repeats if set; then the page is *exhausted*.
5. **Acknowledge** stops it, assigns the incident to whoever acknowledged (if unassigned) and moves it to *in progress*. **Escalate** jumps to the next level now.

The pager keeps its state in the database: the current level, when it started and every attempt. A restart, or another server taking over, carries on where it left off and never repeats an attempt.

## Paging someone by hand

On any ticket, **Page someone about this ticket** starts the escalation policy you choose for that ticket, for example a database team's policy to pull in a DBA during an incident.

## Phone & SMS

Telephony settings (Twilio or the sandbox) and Teams calls. See [Paging channels](paging-channels.md#sms-and-phone-calls).
