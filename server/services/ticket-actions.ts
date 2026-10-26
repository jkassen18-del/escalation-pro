import { commentOnGitHubIssue } from '../integrations/github.ts';
import { lengthWithoutInlineImages } from '../lib/inline-images.ts';
import crypto from 'node:crypto';
import { db } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { isEffectivelyEmpty, sanitizeRichText } from '../lib/rich-text.ts';
import { extractInlineImages } from '../lib/inline-images.ts';
import { badRequest, forbidden, optionalDate, optionalString, requireEnum, requireString, toStringArray } from '../lib/http.ts';
import { recordAudit } from '../lib/audit.ts';
import { notifyUsers } from '../lib/notifications.ts';
import { can } from '../middleware/auth.ts';
import { statusPermission } from '../permissions.ts';
import { findTeamById } from '../repositories/teams.ts';
import { findUserById } from '../repositories/users.ts';
import { getSettings } from '../repositories/settings.ts';
import { addLink, addWatcher, findTicket, recordEvent } from '../repositories/tickets.ts';
import { buildTicketUrl, dispatchAsync } from '../integrations/dispatcher.ts';
import { loadIntegration } from '../integrations/store.ts';
import { commentOnLinearIssue } from '../integrations/linear.ts';
import { SEVERITIES } from '../../shared/ops.ts';
import {
  TERMINAL_STATUSES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  type Permission,
  type PublicUser,
  type Ticket,
} from '../../shared/types.ts';

/**
 * Changing a ticket and commenting on it, wherever the change comes from.
 *
 * These lived in the HTTP routes. They are here so the web app and the
 * Claude connector (MCP) apply exactly the same rules - permissions, the
 * lifecycle timestamps the SLA report reads, notifications, the fan-out to
 * Slack, Teams and Linear - and cannot drift apart.
 */

export interface ActionContext {
  actor: PublicUser;
  ip?: string | null;
  /** Origin for links in outbound notifications, when the caller knows one. */
  origin?: string;
  /** Extra audit metadata, e.g. `{ via: 'mcp', client: 'Claude' }`. */
  auditMeta?: Record<string, unknown>;
  /** Prefix for the audit summary, e.g. "via Claude: ". */
  auditPrefix?: string;
}

/** Whether a person may see a ticket at all. */
export function canSeeTicket(user: PublicUser, ticket: Ticket): boolean {
  if (can(user, 'tickets.view_all')) return true;
  if (ticket.assigneeId === user.id || ticket.requesterId === user.id || ticket.createdById === user.id) return true;
  return Boolean(ticket.teamId && user.teamIds.includes(ticket.teamId));
}

/** The fields a ticket update may carry. Undefined means "leave alone". */
export interface TicketPatch {
  subject?: unknown;
  description?: unknown;
  status?: unknown;
  priority?: unknown;
  type?: unknown;
  teamId?: unknown;
  assigneeId?: unknown;
  severity?: unknown;
  commanderId?: unknown;
  dueAt?: unknown;
  tags?: unknown;
}

/**
 * Applies a patch with the same rules as PATCH /api/tickets/:id. The caller
 * has already checked the actor holds tickets.update or tickets.assign and
 * can see the ticket; finer checks (status needs update, assignee needs
 * assign) happen here.
 */
export async function updateTicket(before: Ticket, patch: TicketPatch, ctx: ActionContext): Promise<Ticket> {
  const user = ctx.actor;
  const settings = await getSettings();
  const updates: string[] = [];
  const params: Array<string | number | null> = [];
  const changes: Array<{ field: string; from: string | null; to: string | null }> = [];
  const push = (column: string, value: string | number | null) => {
    updates.push(`${column} = ?`);
    params.push(value);
  };

  const now = new Date().toISOString();
  const needs = (permission: Permission, what: string) => {
    if (!can(user, permission)) throw forbidden(`You cannot ${what}.`);
  };

  if (patch.subject !== undefined) {
    const subject = requireString(patch.subject, 'Subject', { max: 200 });
    if (subject !== before.subject) {
      needs('tickets.update', 'edit ticket details');
      push('subject', subject);
      changes.push({ field: 'subject', from: before.subject, to: subject });
    }
  }

  if (patch.description !== undefined) {
    // Refused rather than cut: slicing used to land in the middle of a pasted image.
    let description = typeof patch.description === 'string' ? patch.description.trim() : '';
    const limit = before.descriptionFormat === 'html' ? 400_000 : 20_000;
    if ((before.descriptionFormat === 'html' ? lengthWithoutInlineImages(description) : description.length) > limit) {
      throw badRequest(`Description must be ${limit.toLocaleString('en')} characters or fewer`, { Description: 'Too long' });
    }
    // An HTML description is rendered as markup, so an edit goes through the
    // same sanitiser and inline-image extraction as a new ticket's.
    if (before.descriptionFormat === 'html') {
      description = sanitizeRichText(description);
      description = await extractInlineImages(description, { ticketId: before.id, uploadedBy: user.id || null });
    }
    if (description !== before.description) {
      needs('tickets.update', 'edit ticket details');
      push('description', description);
      changes.push({ field: 'description', from: null, to: null });
    }
  }

  if (patch.status !== undefined) {
    const status = requireEnum(patch.status, TICKET_STATUSES, 'Status');
    if (status !== before.status) {
      const permission = statusPermission(before.status, status);
      needs(permission, permission === 'tickets.close' ? 'resolve or close tickets' : permission === 'tickets.reopen' ? 'reopen tickets' : 'change a ticket status');
      push('status', status);
      changes.push({ field: 'status', from: before.status, to: status });

      // Stamp/clear the lifecycle timestamps that the SLA report reads.
      if (status === 'resolved') push('resolved_at', now);
      if (status === 'closed') push('closed_at', now);
      if (!TERMINAL_STATUSES.includes(status)) {
        push('resolved_at', null);
        push('closed_at', null);
      }
    }
  }

  if (patch.priority !== undefined) {
    const priority = requireEnum(patch.priority, TICKET_PRIORITIES, 'Priority');
    if (priority !== before.priority) {
      needs('tickets.change_priority', 'change priority');
      push('priority', priority);
      changes.push({ field: 'priority', from: before.priority, to: priority });
    }
  }

  if (patch.type !== undefined) {
    const type = requireEnum(patch.type, TICKET_TYPES, 'Type');
    if (type !== before.type) {
      needs('tickets.update', 'edit ticket details');
      push('type', type);
      changes.push({ field: 'type', from: before.type, to: type });
    }
  }

  if (patch.teamId !== undefined) {
    const teamId = optionalString(patch.teamId, 60);
    if (teamId !== before.teamId) {
      if (!can(user, 'tickets.update') && !can(user, 'tickets.assign')) throw forbidden('You cannot move tickets between departments.');
      if (teamId && !(await findTeamById(teamId))) throw badRequest('That team no longer exists.');
      push('team_id', teamId);
      changes.push({ field: 'team', from: before.teamName, to: teamId });
    }
  }

  if (patch.assigneeId !== undefined) {
    if (!can(user, 'tickets.assign')) throw forbidden('You cannot reassign tickets.');
    const assigneeId = optionalString(patch.assigneeId, 60);
    if (assigneeId !== before.assigneeId) {
      if (assigneeId && !(await findUserById(assigneeId))) throw badRequest('That person no longer exists.');
      push('assignee_id', assigneeId);
      changes.push({ field: 'assignee', from: before.assigneeName, to: assigneeId });
      if (assigneeId) await addWatcher(before.id, assigneeId);
    }
  }

  if (patch.severity !== undefined) {
    const severity = patch.severity === null || patch.severity === '' ? null : requireEnum(patch.severity, SEVERITIES, 'Severity');
    if (severity !== before.severity) {
      needs('tickets.update', 'edit ticket details');
      push('severity', severity);
      changes.push({ field: 'severity', from: before.severity, to: severity });
    }
  }

  if (patch.commanderId !== undefined) {
    const commanderId = optionalString(patch.commanderId, 60);
    if (commanderId !== before.commanderId) {
      needs('tickets.update', 'edit ticket details');
      if (commanderId && !(await findUserById(commanderId))) throw badRequest('That person no longer exists.');
      push('commander_id', commanderId);
      changes.push({ field: 'commander', from: before.commanderName, to: commanderId });
    }
  }

  if (patch.dueAt !== undefined) {
    const dueAt = optionalDate(patch.dueAt, 'Due date');
    if (dueAt !== before.dueAt) {
      needs('tickets.update', 'edit ticket details');
      push('due_at', dueAt);
      changes.push({ field: 'dueAt', from: before.dueAt, to: dueAt });
    }
  }

  if (patch.tags !== undefined) {
    const tags = toStringArray(patch.tags, 20).map((tag) => tag.toLowerCase());
    if (tags.join(',') !== before.tags.join(',')) {
      needs('tickets.update', 'edit ticket details');
      push('tags', JSON.stringify(tags));
      changes.push({ field: 'tags', from: before.tags.join(', '), to: tags.join(', ') });
    }
  }

  if (!updates.length) return before;

  push('updated_at', now);
  params.push(before.id);
  await db.run(`UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`, params);

  for (const change of changes) {
    await recordEvent(before.id, user.id, 'updated', change.field, change.from, change.to);
  }

  const after = await findTicket(before.id, settings.ticketPrefix);
  if (!after) throw new Error('Ticket update failed.');

  await recordAudit({
    actorId: user.id,
    actorName: user.name,
    entityType: 'ticket',
    entityId: after.id,
    action: 'ticket_updated',
    summary: `${ctx.auditPrefix ?? ''}Updated ${after.reference} (${changes.map((c) => c.field).join(', ')})`,
    meta: { changes, ...ctx.auditMeta },
    ip: ctx.ip ?? null,
  });

  const ticketUrl = await buildTicketUrl(after, ctx.origin);

  if (after.assigneeId && after.assigneeId !== before.assigneeId && after.assigneeId !== user.id) {
    await notifyUsers([after.assigneeId], {
      ticketId: after.id,
      type: 'assigned',
      title: `${after.reference} assigned to you`,
      body: after.subject,
    });
    dispatchAsync({
      event: 'ticketAssigned',
      ticket: after,
      actorName: user.name,
      headline: `Assigned to ${after.assigneeName ?? 'someone'}: ${after.reference}`,
      ticketUrl,
    });
  }

  if (after.status !== before.status) {
    await notifyUsers(
      after.watcherIds.filter((id) => id !== user.id),
      {
        ticketId: after.id,
        type: 'status',
        title: `${after.reference} is now ${after.status.replace('_', ' ')}`,
        body: after.subject,
      },
    );
    dispatchAsync({
      event: 'ticketStatusChanged',
      ticket: after,
      actorName: user.name,
      headline: `${after.reference} moved to ${after.status.replace('_', ' ')}`,
      detail: `Previous status: ${before.status.replace('_', ' ')}`,
      ticketUrl,
    });
  }

  return after;
}

export interface CommentInput {
  /** Already length-checked by the caller. */
  body: string;
  bodyFormat: 'text' | 'html';
  isInternal: boolean;
}

/** Adds a comment with the same rules as POST /api/tickets/:id/comments. */
export async function addTicketComment(ticket: Ticket, input: CommentInput, ctx: ActionContext): Promise<Ticket> {
  const user = ctx.actor;
  const settings = await getSettings();
  const cleanBody = input.bodyFormat === 'html' ? sanitizeRichText(input.body) : input.body;
  if (input.bodyFormat === 'html' && isEffectivelyEmpty(cleanBody)) throw badRequest('Write something before posting.');
  if (!cleanBody.trim()) throw badRequest('Comment is required', { Comment: 'Required' });
  const body = cleanBody;
  const { bodyFormat, isInternal } = input;
  if (isInternal && !can(user, 'tickets.comment_internal')) {
    throw forbidden('You cannot post internal notes.');
  }
  if (!isInternal && !can(user, 'tickets.reply')) {
    throw forbidden('You cannot reply on tickets.');
  }

  const now = new Date().toISOString();
  const commentId = randomId();
  await db.run(
    `INSERT INTO ticket_comments (id, ticket_id, author_id, body, body_format, is_internal, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [commentId, ticket.id, user.id, body, bodyFormat, isInternal ? 1 : 0, now, now],
  );

  /*
   * Only after the comment row exists: each extracted image is an attachment
   * that references this comment, and Postgres enforces that foreign key.
   */
  if (bodyFormat === 'html') {
    const rewritten = await extractInlineImages(body, { ticketId: ticket.id, commentId, uploadedBy: user.id });
    if (rewritten !== body) {
      await db.run(`UPDATE ticket_comments SET body = ? WHERE id = ?`, [rewritten, commentId]);
    }
  }

  // The first public reply from anyone other than the requester stops the
  // first-response SLA clock.
  if (!ticket.firstResponseAt && !isInternal && user.id !== ticket.requesterId) {
    await db.run(`UPDATE tickets SET first_response_at = ? WHERE id = ?`, [now, ticket.id]);
  }
  await db.run(`UPDATE tickets SET updated_at = ? WHERE id = ?`, [now, ticket.id]);
  await addWatcher(ticket.id, user.id);

  const after = await findTicket(ticket.id, settings.ticketPrefix);
  if (!after) throw new Error('Comment failed.');

  if (ctx.auditMeta) {
    // Comments from the web are not audited individually (the timeline is the
    // record); ones written by an assistant are, so they can be told apart.
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'ticket',
      entityId: after.id,
      action: 'ticket_commented',
      summary: `${ctx.auditPrefix ?? ''}${isInternal ? 'Internal note' : 'Comment'} on ${after.reference}`,
      meta: { commentId, isInternal, ...ctx.auditMeta },
      ip: ctx.ip ?? null,
    });
  }

  // An internal note only reaches watchers who may read internal notes; anyone
  // can watch a ticket they can see, and the bell shows the note's text.
  let recipients = after.watcherIds.filter((id) => id !== user.id);
  if (isInternal) {
    const allowed = await Promise.all(recipients.map(async (id) => (await findUserById(id))?.permissions.includes('tickets.comment_internal') ?? false));
    recipients = recipients.filter((_, index) => allowed[index]);
  }
  await notifyUsers(
    recipients,
    {
      ticketId: after.id,
      type: 'comment',
      title: `${user.name} commented on ${after.reference}`,
      body: body.slice(0, 200),
    },
  );

  if (!isInternal) {
    dispatchAsync({
      event: 'ticketCommented',
      ticket: after,
      actorName: user.name,
      headline: `New comment on ${after.reference}`,
      detail: body,
      ticketUrl: await buildTicketUrl(after, ctx.origin),
    });
  }

  // Mirror public replies onto the linked Linear issue so both stay in sync.
  const linearLink = after.links.find((link) => link.provider === 'linear');
  if (linearLink && !isInternal) {
    const record = await loadIntegration('linear');
    if (record.enabled) {
      // Recorded first, so the copy Linear's webhook sends back is known to be ours.
      const linearCommentId = crypto.randomUUID();
      await addLink(after.id, 'linear_comment', linearCommentId, null, '');
      void commentOnLinearIssue(
        record,
        linearLink.externalId,
        `**${user.name}** (${settings.organizationName}):\n\n${body}`,
        linearCommentId,
      );
    }
  }

  // And onto a linked GitHub issue. Marked as ours, so GitHub's echo of it is ignored.
  const githubLink = after.links.find((link) => link.provider === 'github');
  if (githubLink && !isInternal) {
    const record = await loadIntegration('github');
    if (record.enabled) void commentOnGitHubIssue(record, githubLink.externalId, `**${user.name}** (${settings.organizationName}):\n\n${body}`);
  }

  return after;
}
