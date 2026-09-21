import { db } from '../db/index.ts';
import { notifyUsers } from '../lib/notifications.ts';
import { getSettings } from '../repositories/settings.ts';
import { findTicket } from '../repositories/tickets.ts';
import { buildTicketUrl, dispatchAsync } from '../integrations/dispatcher.ts';

const CHECK_INTERVAL_MS = Number(process.env.SLA_CHECK_INTERVAL_MS || 5 * 60 * 1000);

/** Tickets already announced, so a breach is reported once rather than every tick. */
const announced = new Set<string>();

async function checkBreaches(): Promise<void> {
  const settings = await getSettings();
  const now = new Date().toISOString();

  const rows = await db.all<{ id: string }>(
    `SELECT id FROM tickets
     WHERE due_at IS NOT NULL AND due_at < ? AND status NOT IN ('resolved', 'closed')
     ORDER BY due_at ASC LIMIT 100`,
    [now],
  );

  for (const row of rows) {
    if (announced.has(row.id)) continue;

    const ticket = await findTicket(row.id, settings.ticketPrefix);
    if (!ticket) continue;

    announced.add(ticket.id);

    const recipients = [ticket.assigneeId, ...ticket.watcherIds].filter((id): id is string => Boolean(id));
    await notifyUsers(recipients, {
      ticketId: ticket.id,
      type: 'sla',
      title: `${ticket.reference} has breached its SLA`,
      body: ticket.subject,
    });

    dispatchAsync({
      event: 'slaBreached',
      ticket,
      actorName: 'SLA monitor',
      headline: `SLA breached: ${ticket.reference}`,
      detail: `This ticket was due ${ticket.dueAt} and is still ${ticket.status.replace('_', ' ')}.`,
      ticketUrl: await buildTicketUrl(ticket),
    });
  }

  // Forget tickets that are no longer breaching so a reopened ticket can alert again.
  const stillBreaching = new Set(rows.map((row) => row.id));
  for (const id of announced) {
    if (!stillBreaching.has(id)) announced.delete(id);
  }
}

/** Starts the periodic SLA sweep. Returns a function that stops it. */
export function startSlaMonitor(): () => void {
  const run = () => {
    void checkBreaches().catch((error) => console.error('[sla] check failed', error));
  };

  // Give the server a moment to finish booting before the first sweep.
  const initial = setTimeout(run, 15_000);
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  initial.unref();
  timer.unref();

  return () => {
    clearTimeout(initial);
    clearInterval(timer);
  };
}
