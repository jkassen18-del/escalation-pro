import { db } from '../db/index.ts';
import { notifyUsers } from '../lib/notifications.ts';
import { acquireLease } from '../ops/lease.ts';
import { getSettings } from '../repositories/settings.ts';
import { findTicket } from '../repositories/tickets.ts';
import { buildTicketUrl, dispatchAsync } from '../integrations/dispatcher.ts';

const CHECK_INTERVAL_MS = Number(process.env.SLA_CHECK_INTERVAL_MS || 5 * 60 * 1000);
const LEASE_MS = Math.max(CHECK_INTERVAL_MS * 2, 60_000);
const BATCH = 100;

/**
 * Announces each SLA breach once.
 *
 * What has been announced lives on the ticket (the due date it was announced
 * for), not in memory, so a restart does not announce everything again and
 * two instances do not both announce it. A new due date is a new deadline,
 * so moving it re-arms the announcement. Only the lease holder sweeps.
 */
export async function checkBreaches(): Promise<number> {
  if (!(await acquireLease('sla-monitor', LEASE_MS))) return 0;
  const settings = await getSettings();
  const now = new Date().toISOString();

  let notified = 0;
  // Every row taken is marked before anything else happens, so each batch
  // moves on to the next and a large backlog is worked through in one sweep.
  for (;;) {
    const rows = await db.all<{ id: string; due_at: string }>(
      `SELECT id, due_at FROM tickets
       WHERE due_at IS NOT NULL AND due_at < ? AND status NOT IN ('resolved', 'closed')
         AND (sla_notified_due IS NULL OR sla_notified_due <> due_at)
       ORDER BY due_at ASC LIMIT ${BATCH}`,
      [now],
    );
    if (!rows.length) break;

    for (const row of rows) {
      await db.run(`UPDATE tickets SET sla_notified_due = ? WHERE id = ?`, [row.due_at, row.id]);
      const ticket = await findTicket(row.id, settings.ticketPrefix);
      if (!ticket) continue;
      notified += 1;

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
    if (rows.length < BATCH) break;
  }

  return notified;
}

/**
 * Starts the periodic SLA sweep for a long-running server. Serverless
 * deployments have no process to hold a timer, so they call `checkBreaches`
 * from a scheduled HTTP request instead (see the /api/cron/sla route).
 */
export function startSlaMonitor(): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void checkBreaches()
      .catch((error) => console.error('[sla] check failed', error))
      .finally(() => {
        running = false;
      });
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
