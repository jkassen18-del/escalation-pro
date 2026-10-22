import { db } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
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
import type { PublicUser, TeamFormField, Ticket, TicketPriority, TicketSource, TicketType } from '../../shared/types.ts';

/**
 * Who raised a ticket that no person raised: a monitor going down, an alert
 * arriving from AWS. Its empty id is what createTicket checks for.
 */
export const SYSTEM_ACTOR: PublicUser = {
  id: '',
  email: '',
  username: 'system',
  name: 'InfraTicket',
  role: 'admin',
  status: 'active',
  jobTitle: null,
  phone: null,
  avatarColor: '#6b7280',
  mustChangePassword: false,
  lastLoginAt: null,
  createdAt: '',
  updatedAt: '',
  teamIds: [],
  permissions: [],
  extraPermissions: [],
};

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
  severity?: Ticket['severity'];
  /** Raised from a quick-ticket template: recorded on the ticket. */
  templateId?: string | null;
  /**
   * Questions asked on top of the department's form (a template's own), with
   * their answers. Where a key matches a department question, this one is
   * asked instead of it, so nobody answers the same thing twice.
   */
  extraFields?: TeamFormField[];
  extraAnswers?: Record<string, unknown>;
}

export interface CreateTicketContext {
  /** A person, or SYSTEM_ACTOR for tickets raised by monitors and alert sources. */
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
  // The system actor has no user row, so nothing may reference it.
  const actorId = actor.id || null;
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
  const extraFields = input.extraFields ?? [];
  const extraKeys = new Set(extraFields.map((field) => field.key));
  const formFields = (team ? await listTeamFields(team.id) : []).filter((field) => !extraKeys.has(field.key));
  const answers = [
    ...validateAnswers(formFields, input.customFields ?? {}),
    ...validateAnswers(extraFields, input.extraAnswers ?? {}),
  ];

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
      requesterId: input.requesterId ?? actorId,
      assigneeId,
      status: 'open',
      priority,
      type,
      source,
      tags: (input.tags ?? []).map((tag) => tag.toLowerCase()),
      dueAt,
      createdBy: actorId,
      severity: input.severity ?? null,
      templateId: input.templateId ?? null,
    });

    if (descriptionFormat === 'html') {
      const rewritten = await extractInlineImages(storedDescription, {
        ticketId: created.id,
        uploadedBy: actorId,
      });
      if (rewritten !== storedDescription) {
        await db.run(`UPDATE tickets SET description = ? WHERE id = ?`, [rewritten, created.id]);
      }
    }

    if (answers.length > 0) await saveAnswers(created.id, answers);

    await recordEvent(created.id, actorId, 'created', null, null, input.subject);
    if (assigneeId) {
      await recordEvent(created.id, actorId, 'assigned', 'assignee', null, assigneeId);
      await addWatcher(created.id, assigneeId);
    }
    if (actorId) await addWatcher(created.id, actorId);
    return created;
  });

  const ticket = await findTicket(result.id, settings.ticketPrefix);
  if (!ticket) throw new Error('Ticket creation failed.');

  await recordAudit({
    actorId,
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

/**
 * Hands a ticket to another department: "this is a network problem, not a
 * desktop one". The level goes up, the reason is kept as an internal note,
 * and the new department hears about it in the app and in its own channels.
 *
 * The assignee stays only if they belong to the new department; otherwise the
 * ticket goes to that department's auto-assignment, or to its queue
 * unassigned. The type is left alone, so an incident stays an incident.
 */
export interface EscalateToTeamInput {
  targetTeamId: string;
  reason: string;
  /** Unchanged when left out. */
  priority?: TicketPriority;
  actor: PublicUser;
  ip?: string | null;
  origin?: string;
}

export async function escalateTicketToTeam(ticket: Ticket, input: EscalateToTeamInput): Promise<Ticket> {
  const { targetTeamId, reason, actor: user } = input;
  const settings = await getSettings();
  const target = await findTeamById(targetTeamId);
  if (!target) throw badRequest('That department no longer exists.', { teamId: 'Unknown' });
  if (target.id === ticket.teamId) throw badRequest(`${ticket.reference} is already with ${target.name}.`, { teamId: 'Same department' });

  const priority = input.priority ?? ticket.priority;
  const nextLevel = Math.min(ticket.escalationLevel + 1, 5);

  let assigneeId = ticket.assigneeId;
  if (assigneeId) {
    const member = await db.get<{ user_id: string }>(`SELECT user_id FROM team_members WHERE team_id = ? AND user_id = ?`, [target.id, assigneeId]);
    if (!member) assigneeId = null;
  }
  if (!assigneeId) assigneeId = await pickAssignee(target.id, target.autoAssign);

  const now = new Date().toISOString();
  const fromName = ticket.teamName ?? 'no department';
  await db.run(
    `UPDATE tickets SET team_id = ?, assignee_id = ?, priority = ?, escalation_level = ?, updated_at = ? WHERE id = ?`,
    [target.id, assigneeId, priority, nextLevel, now, ticket.id],
  );
  await recordEvent(ticket.id, user.id, 'escalated', 'team', fromName, target.name);
  if (priority !== ticket.priority) await recordEvent(ticket.id, user.id, 'updated', 'priority', ticket.priority, priority);
  if (assigneeId !== ticket.assigneeId) {
    await recordEvent(ticket.id, user.id, 'updated', 'assignee', ticket.assigneeName, assigneeId);
    if (assigneeId) await addWatcher(ticket.id, assigneeId);
  }
  await db.run(
    `INSERT INTO ticket_comments (id, ticket_id, author_id, body, is_internal, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [randomId(), ticket.id, user.id, `Escalated from ${fromName} to ${target.name}. ${reason}`, now, now],
  );

  const after = await findTicket(ticket.id, settings.ticketPrefix);
  if (!after) throw new Error('Escalation failed.');

  await recordAudit({
    actorId: user.id,
    actorName: user.name,
    entityType: 'ticket',
    entityId: after.id,
    action: 'ticket_escalated',
    summary: `Escalated ${after.reference} from ${fromName} to ${target.name}`,
    meta: { reason, level: nextLevel, fromTeamId: ticket.teamId, toTeamId: target.id, priority },
    ip: input.ip ?? null,
  });

  const members = await db.all<{ user_id: string }>(
    `SELECT tm.user_id FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? AND u.status = 'active'`,
    [target.id],
  );
  await notifyUsers(
    Array.from(new Set([...members.map((m) => m.user_id), ...after.watcherIds])).filter((id) => id !== user.id),
    {
      ticketId: after.id,
      type: 'escalated',
      title: `${after.reference} escalated from ${fromName} to ${target.name}`,
      body: reason.slice(0, 200),
    },
  );

  // Dispatched with the ticket as it is now, so team routing sends it to the new department's channels.
  dispatchAsync({
    event: 'ticketEscalated',
    ticket: after,
    actorName: user.name,
    headline: `Escalated from ${fromName} to ${target.name}: ${after.reference}`,
    detail: reason,
    ticketUrl: await buildTicketUrl(after, input.origin),
  });
  return after;
}
