import { db } from '../db/index.ts';
import { isEffectivelyEmpty, sanitizeRichText } from '../lib/rich-text.ts';
import { extractInlineImages } from '../lib/inline-images.ts';
import { listTeamFields, saveAnswers, validateAnswers } from '../repositories/form-fields.ts';
import { badRequest } from '../lib/http.ts';
import { recordAudit } from '../lib/audit.ts';
import { findTeamById, pickAssignee } from '../repositories/teams.ts';
import { getSettings } from '../repositories/settings.ts';
import {
  addWatcher,
  dueDateFrom,
  findTicket,
  insertTicket,
  recordEvent,
  slaMultiplier,
} from '../repositories/tickets.ts';
import { buildTicketUrl, dispatchAsync } from '../integrations/dispatcher.ts';
import { notifyUsers } from '../lib/notifications.ts';
import type { PublicUser, Ticket, TicketPriority, TicketSource, TicketType } from '../../shared/types.ts';

/**
 * Raising a ticket, wherever it was raised from.
 *
 * This used to live inside the POST /api/tickets handler, reading straight
 * off `req`. That was fine while the web form was the only way in; it is not
 * fine now that a Slack command and a Teams card raise tickets too, because
 * the parts that matter - the department's own questions, the SLA due date,
 * auto-assignment, the audit entry, the fan-out to the chat tools - would
 * have had to be reimplemented once per channel, and would have drifted.
 *
 * The HTTP route still owns parsing and permissions. Everything after that
 * is here.
 */
export interface CreateTicketInput {
  subject: string;
  description?: string;
  /** 'html' arrives from the rich editor and is sanitised here, never trusted. */
  descriptionFormat?: 'text' | 'html';
  teamId?: string | null;
  requesterId?: string | null;
  assigneeId?: string | null;
  priority?: TicketPriority;
  type?: TicketType;
  source?: TicketSource;
  tags?: string[];
  dueAt?: string | null;
  /** Answers to the department's form, keyed by field key. */
  customFields?: Record<string, unknown>;
}

export interface CreateTicketContext {
  actor: PublicUser;
  /** Where the audit entry says it came from. */
  ip?: string | null;
  /** Origin for links in outbound notifications, when the caller knows one. */
  origin?: string;
}

export async function createTicket(
  input: CreateTicketInput,
  context: CreateTicketContext,
): Promise<Ticket> {
  const { actor } = context;
  const settings = await getSettings();

  const isHtml = input.descriptionFormat === 'html';
  const rawDescription = input.description ?? '';
  const description = isHtml ? sanitizeRichText(rawDescription) : rawDescription;
  const descriptionFormat: 'text' | 'html' = isHtml && !isEffectivelyEmpty(description) ? 'html' : 'text';
  const storedDescription = descriptionFormat === 'html' ? description : isHtml ? '' : description;

  const teamId = input.teamId ?? settings.defaultTeamId;
  const priority = input.priority ?? settings.defaultPriority;
  const type = input.type ?? 'request';
  const source = input.source ?? 'web';

  const team = teamId ? await findTeamById(teamId) : null;
  if (teamId && !team) throw badRequest('That team no longer exists.', { teamId: 'Unknown' });

  /*
   * The department's own questions, checked here rather than wherever the
   * answers were typed: a form is data, and a caller can always omit a
   * required answer or send a choice that is not on the list.
   */
  const formFields = team ? await listTeamFields(team.id) : [];
  const answers = validateAnswers(formFields, input.customFields ?? {});

  const result = await db.transaction(async () => {
    // Explicit assignee wins; otherwise fall back to the team's routing rule.
    let assigneeId = input.assigneeId ?? null;
    if (!assigneeId && team && team.autoAssign !== 'none') {
      assigneeId = await pickAssignee(team.id, team.autoAssign);
    }

    const resolveMins = team?.slaResolveMins ?? settings.slaResolveMins;
    const dueAt = input.dueAt ?? dueDateFrom(Math.round(resolveMins * slaMultiplier(priority)));

    const created = await insertTicket({
      subject: input.subject,
      description: storedDescription,
      descriptionFormat,
      teamId: team?.id ?? null,
      requesterId: input.requesterId ?? actor.id,
      assigneeId,
      status: 'open',
      priority,
      type,
      source,
      tags: (input.tags ?? []).map((tag) => tag.toLowerCase()),
      dueAt,
      createdBy: actor.id,
    });

    if (descriptionFormat === 'html') {
      const rewritten = await extractInlineImages(storedDescription, {
        ticketId: created.id,
        uploadedBy: actor.id,
      });
      if (rewritten !== storedDescription) {
        await db.run(`UPDATE tickets SET description = ? WHERE id = ?`, [rewritten, created.id]);
      }
    }

    if (answers.length > 0) await saveAnswers(created.id, answers);

    await recordEvent(created.id, actor.id, 'created', null, null, input.subject);
    if (assigneeId) {
      await recordEvent(created.id, actor.id, 'assigned', 'assignee', null, assigneeId);
      await addWatcher(created.id, assigneeId);
    }
    await addWatcher(created.id, actor.id);
    return created;
  });

  const ticket = await findTicket(result.id, settings.ticketPrefix);
  if (!ticket) throw new Error('Ticket creation failed.');

  await recordAudit({
    actorId: actor.id,
    actorName: actor.name,
    entityType: 'ticket',
    entityId: ticket.id,
    action: 'ticket_created',
    summary: `Created ${ticket.reference}: ${ticket.subject}`,
    meta: { priority, teamId: ticket.teamId, assigneeId: ticket.assigneeId, source },
    ip: context.ip ?? null,
  });

  if (ticket.assigneeId && ticket.assigneeId !== actor.id) {
    await notifyUsers([ticket.assigneeId], {
      ticketId: ticket.id,
      type: 'assigned',
      title: `${ticket.reference} assigned to you`,
      body: ticket.subject,
    });
  }

  dispatchAsync({
    event: 'ticketCreated',
    ticket,
    actorName: actor.name,
    headline: `New ${priority} ${type}: ${ticket.reference}`,
    detail: description.slice(0, 1500) || undefined,
    ticketUrl: await buildTicketUrl(ticket, context.origin),
  });

  return ticket;
}
