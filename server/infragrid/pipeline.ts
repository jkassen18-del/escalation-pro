import { db } from '../db/index.ts';
import { createTicket } from '../services/tickets.ts';
import { findUserById } from '../repositories/users.ts';
import { getSettings } from '../repositories/settings.ts';
import { findTicket, recordEvent } from '../repositories/tickets.ts';
import { randomId } from '../lib/crypto.ts';
import {
  findFiringAlert,
  insertAlert,
  linkAlertToTicket,
  resolveAlert,
  touchAlert,
} from './store.ts';
import type { NormalisedAlert } from './adapters.ts';
import type { AlertSeverity, AlertSource, PublicUser, TicketPriority } from '../../shared/types.ts';

/**
 * What happens when an alert arrives.
 *
 * The rules, in order of how much they matter:
 *
 *  1. A repeat of something already firing advances a counter. It does not
 *     open a second ticket. A monitor re-fires every minute while a disk is
 *     full, and a queue with four hundred copies of one problem is worse than
 *     no monitoring at all.
 *  2. A recovery closes the loop: the alert is marked resolved, and the
 *     ticket it opened is told so rather than being left for somebody to
 *     notice.
 *  3. Only alerts at or above the source's threshold open a ticket. Below it
 *     they are still recorded and still shown on the grid - the point is to
 *     have the history without waking anyone for an informational message.
 */

const RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

/** Severity decides how urgently a person should look at it. */
const PRIORITY_FOR: Record<AlertSeverity, TicketPriority> = {
  critical: 'urgent',
  warning: 'high',
  info: 'normal',
};

export interface IngestOutcome {
  alertId: string;
  status: 'created' | 'repeated' | 'resolved' | 'recorded';
  ticketReference?: string | null;
}

/**
 * The account alerts are raised as.
 *
 * A monitoring system is not a person, but a ticket has a requester and an
 * audit entry needs an actor. The oldest active administrator is used, and
 * the alert's own source is named in the ticket - so it is never mistaken for
 * something a human typed.
 */
async function systemActor(): Promise<PublicUser | null> {
  const row = await db.get<{ id: string }>(
    `SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1`,
  );
  return row ? findUserById(row.id) : null;
}

export async function ingestAlert(source: AlertSource, incoming: NormalisedAlert): Promise<IngestOutcome> {
  const existing = await findFiringAlert(source.id, incoming.dedupeKey);
  const settings = await getSettings();

  /* ------------------------------ Recovery ------------------------------- */
  if (incoming.status === 'resolved') {
    if (!existing) {
      // A recovery for something that was never firing here. Recorded so the
      // history is not silently incomplete, but nothing is opened.
      const id = await insertAlert({ ...incoming, sourceId: source.id, severity: 'info' });
      await resolveAlert(id);
      return { alertId: id, status: 'resolved' };
    }

    await resolveAlert(existing.id);

    if (existing.ticketId) {
      const ticket = await findTicket(existing.ticketId, settings.ticketPrefix);
      if (ticket && ticket.status !== 'closed' && ticket.status !== 'resolved') {
        const now = new Date().toISOString();
        await db.run(
          `INSERT INTO ticket_comments (id, ticket_id, author_id, body, body_format, is_internal, created_at, updated_at)
           VALUES (?, ?, NULL, ?, 'text', 0, ?, ?)`,
          [
            randomId(),
            ticket.id,
            `${source.name} reports this has recovered:\n\n${incoming.title}`,
            now,
            now,
          ],
        );
        /*
         * Deliberately not closed automatically. The condition clearing is
         * not the same as the cause being understood, and a ticket that
         * closes itself is how a recurring fault goes uninvestigated. The
         * person closes it.
         */
        await recordEvent(ticket.id, null, 'commented', 'source', null, 'infragrid');
      }
      return { alertId: existing.id, status: 'resolved', ticketReference: ticket?.reference ?? null };
    }

    return { alertId: existing.id, status: 'resolved' };
  }

  /* ------------------------------- Repeat -------------------------------- */
  if (existing) {
    // A condition that worsens should say so; one that improves while still
    // firing keeps the worse severity, because that is what was acted on.
    const worse = RANK[incoming.severity] > RANK[existing.severity] ? incoming.severity : undefined;
    await touchAlert(existing.id, worse);
    return {
      alertId: existing.id,
      status: 'repeated',
      ticketReference: existing.ticketReference ?? null,
    };
  }

  /* -------------------------------- New ---------------------------------- */
  const alertId = await insertAlert({ ...incoming, sourceId: source.id });

  if (RANK[incoming.severity] < RANK[source.ticketThreshold]) {
    return { alertId, status: 'recorded' };
  }

  const actor = await systemActor();
  if (!actor) return { alertId, status: 'recorded' };

  const ticket = await createTicket(
    {
      subject: incoming.title.slice(0, 200),
      description: [
        incoming.body ?? '',
        '',
        `Raised automatically by ${source.name}.`,
        incoming.resource ? `Resource: ${incoming.resource}` : '',
        incoming.externalUrl ? `Details: ${incoming.externalUrl}` : '',
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 20_000),
      descriptionFormat: 'text',
      teamId: source.teamId,
      priority: PRIORITY_FOR[incoming.severity],
      type: 'incident',
      source: 'api',
      tags: ['infragrid', source.kind],
    },
    { actor },
  );

  await linkAlertToTicket(alertId, ticket.id);
  return { alertId, status: 'created', ticketReference: ticket.reference };
}
