import { db } from '../db/index.ts';
import { badRequest } from '../lib/http.ts';
import { notifyUsers } from '../lib/notifications.ts';
import { getSchedule } from '../ops/oncall.ts';
import { sendPush } from '../ops/push.ts';
import { findUserById } from '../repositories/users.ts';
import { recordEvent } from '../repositories/tickets.ts';
import { loadIntegration } from '../integrations/store.ts';
import { sendMsTeams } from '../integrations/msteams.ts';
import { buildTicketUrl } from '../integrations/dispatcher.ts';
import type { OnCallContact, PublicUser, Ticket } from '../../shared/types.ts';

/**
 * "Notify on-call": a person who has just raised a ticket for a department
 * can see who that department has on call right now, ring them, or send them
 * a nudge in Teams - without needing an escalation policy or a monitor alert
 * to start a formal page.
 */

/** Who is on call, now, on every schedule that belongs to the department. */
export async function onCallContactsForTeam(teamId: string | null): Promise<OnCallContact[]> {
  if (!teamId) return [];
  const rows = await db.all<{ id: string }>(`SELECT id FROM oncall_schedules WHERE team_id = ? ORDER BY name`, [teamId]);
  const contacts: OnCallContact[] = [];
  for (const row of rows) {
    const schedule = await getSchedule(row.id);
    if (!schedule?.onCallNow) continue;
    const person = await findUserById(schedule.onCallNow.userId);
    if (!person || person.status !== 'active') continue;
    contacts.push({
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      userId: person.id,
      name: person.name,
      email: person.email,
      phone: person.phone,
      jobTitle: person.jobTitle,
      until: schedule.onCallNow.until,
    });
  }
  return contacts;
}

export interface NotifyResult {
  channel: 'in_app' | 'push' | 'msteams';
  userId: string | null;
  status: 'sent' | 'failed' | 'skipped';
  detail: string;
}

/** How long after one nudge another is refused, so a double-click is not two pings. */
export const NOTIFY_COOLDOWN_MS = 2 * 60_000;

export async function notifyOnCall(
  ticket: Ticket,
  actor: Pick<PublicUser, 'id' | 'name'>,
  input: { userIds?: string[]; note?: string | null },
  origin?: string,
): Promise<{ results: NotifyResult[]; notified: OnCallContact[] }> {
  const contacts = await onCallContactsForTeam(ticket.teamId);
  if (!contacts.length) throw badRequest('Nobody in this department is on call right now.');

  const chosen = input.userIds?.length ? contacts.filter((contact) => input.userIds!.includes(contact.userId)) : contacts;
  // The same person can be on call on two schedules; they get one nudge.
  const targets = chosen.filter((contact, index) => chosen.findIndex((other) => other.userId === contact.userId) === index);
  if (!targets.length) throw badRequest('None of those people are on call for this department.');

  const since = new Date(Date.now() - NOTIFY_COOLDOWN_MS).toISOString();
  const recent = await db.get<{ id: string }>(
    `SELECT id FROM ticket_events WHERE ticket_id = ? AND action = 'oncall_notified' AND created_at >= ?`,
    [ticket.id, since],
  );
  if (recent) throw badRequest('On-call was notified about this ticket in the last two minutes. Give them a moment, or phone them.');

  const note = input.note?.trim() || null;
  const names = targets.map((contact) => contact.name).join(', ');
  const ticketUrl = await buildTicketUrl(ticket, origin);
  const results: NotifyResult[] = [];

  await notifyUsers(
    targets.map((contact) => contact.userId),
    {
      ticketId: ticket.id,
      type: 'oncall',
      title: `${actor.name} needs you on ${ticket.reference}`,
      body: note ?? ticket.subject,
    },
  );
  for (const contact of targets) {
    results.push({ channel: 'in_app', userId: contact.userId, status: 'sent', detail: 'Shown in the notification bell' });
    const push = await sendPush(contact.userId, {
      title: `On-call: ${ticket.reference}`,
      body: `${actor.name}: ${note ?? ticket.subject}`,
      ticketId: ticket.id,
      url: `/tickets/${ticket.id}`,
      tag: `oncall-${ticket.id}`,
    }).catch((error: Error) => ({ status: 'failed' as const, detail: error.message }));
    results.push({ channel: 'push', userId: contact.userId, status: push.status, detail: push.detail });
  }

  // One post to the department's Teams channel naming everyone on call.
  const teams = await loadIntegration('msteams');
  if (!teams.enabled) {
    results.push({ channel: 'msteams', userId: null, status: 'skipped', detail: 'Microsoft Teams is not connected under Integrations' });
  } else {
    const delivery = await sendMsTeams(teams, {
      event: 'ticketEscalated',
      ticket,
      actorName: actor.name,
      headline: `On-call needed: ${names}, please pick up ${ticket.reference}`,
      detail: note ? `${actor.name}: ${note}` : `Raised by ${actor.name}.`,
      ticketUrl,
    }).catch((error: Error) => ({ ok: false, statusCode: null, error: error.message }));
    results.push({
      channel: 'msteams',
      userId: null,
      status: delivery.ok ? 'sent' : 'failed',
      detail: delivery.ok ? 'Posted to the department\'s Teams channel' : (delivery.error ?? 'Teams refused the message'),
    });
  }

  // The note rides on the timeline event, so the trail shows why they were called.
  await recordEvent(ticket.id, actor.id, 'oncall_notified', 'oncall', null, note ? `${names}: ${note.slice(0, 300)}` : names);

  return { results, notified: targets };
}
