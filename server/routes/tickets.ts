import { Router } from 'express';
import { db } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { isEffectivelyEmpty, sanitizeRichText } from '../lib/rich-text.ts';
import { extractInlineImages } from '../lib/inline-images.ts';
import {
  asyncRoute,
  badRequest,
  forbidden,
  notFound,
  optionalDate,
  optionalEnum,
  optionalString,
  parseIntOr,
  requireEnum,
  requireString,
  toStringArray,
} from '../lib/http.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { can, requireAuth, requirePermission, visibleTeamIds, type AuthedRequest } from '../middleware/auth.ts';
import { findTeamById } from '../repositories/teams.ts';
import { getSettings } from '../repositories/settings.ts';
import {
  addLink,
  addWatcher,
  findTicket,
  listTickets,
  loadTicketDetail,
  recordEvent,
  removeWatcher,
  type TicketQuery,
} from '../repositories/tickets.ts';
import { buildTicketUrl, dispatchAsync } from '../integrations/dispatcher.ts';
import { createTicket } from '../services/tickets.ts';
import { loadIntegration } from '../integrations/store.ts';
import { commentOnLinearIssue, createLinearIssue } from '../integrations/linear.ts';
import { notifyUsers } from '../lib/notifications.ts';
import {
  TERMINAL_STATUSES,
  TICKET_PRIORITIES,
  TICKET_SOURCES,
  TICKET_STATUSES,
  TICKET_TYPES,
  type PublicUser,
  type Ticket,
} from '../../shared/types.ts';

export const ticketsRouter: Router = Router();

ticketsRouter.use(requireAuth);

function csv(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** A user may open a ticket if they can see all tickets, own it, or share its team. */
function canSeeTicket(user: PublicUser, ticket: Ticket): boolean {
  if (can(user, 'tickets.view_all')) return true;
  if (ticket.assigneeId === user.id || ticket.requesterId === user.id || ticket.createdById === user.id) return true;
  return Boolean(ticket.teamId && user.teamIds.includes(ticket.teamId));
}

ticketsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const q = req.query as Record<string, string>;

    const query: TicketQuery = {
      status: csv(q.status).filter((s): s is (typeof TICKET_STATUSES)[number] =>
        (TICKET_STATUSES as readonly string[]).includes(s),
      ),
      priority: csv(q.priority).filter((p): p is (typeof TICKET_PRIORITIES)[number] =>
        (TICKET_PRIORITIES as readonly string[]).includes(p),
      ),
      type: csv(q.type).filter((t): t is (typeof TICKET_TYPES)[number] =>
        (TICKET_TYPES as readonly string[]).includes(t),
      ),
      teamIds: csv(q.teamId),
      assigneeIds: q.assigneeId === 'me' ? [user.id] : csv(q.assigneeId),
      requesterIds: q.requesterId === 'me' ? [user.id] : csv(q.requesterId),
      search: optionalString(q.search, 200) ?? undefined,
      tag: optionalString(q.tag, 60) ?? undefined,
      overdueOnly: q.overdue === 'true',
      unassignedOnly: q.unassigned === 'true',
      createdFrom: optionalString(q.from, 40) ?? undefined,
      createdTo: optionalString(q.to, 40) ?? undefined,
      visibleTeamIds: visibleTeamIds(user),
      viewerId: user.id,
      sort: (optionalEnum(q.sort, ['newest', 'oldest', 'priority', 'due', 'updated'] as const) ?? 'newest'),
      limit: parseIntOr(q.limit, 50, { min: 1, max: 200 }),
      offset: parseIntOr(q.offset, 0, { min: 0 }),
    };

    const { tickets, total } = await listTickets(query, settings.ticketPrefix);
    res.json({ tickets, total, limit: query.limit, offset: query.offset });
  }),
);

/** Counts behind the sidebar badges, scoped to what this user may see. */
ticketsRouter.get(
  '/counts',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const scope: TicketQuery = { visibleTeamIds: visibleTeamIds(user), viewerId: user.id, limit: 1 };

    const [all, mine, unassigned, overdue, open] = await Promise.all([
      listTickets(scope, settings.ticketPrefix),
      listTickets({ ...scope, assigneeIds: [user.id], status: ['open', 'in_progress', 'pending'] }, settings.ticketPrefix),
      listTickets({ ...scope, unassignedOnly: true, status: ['open', 'in_progress', 'pending'] }, settings.ticketPrefix),
      listTickets({ ...scope, overdueOnly: true }, settings.ticketPrefix),
      listTickets({ ...scope, status: ['open', 'in_progress', 'pending'] }, settings.ticketPrefix),
    ]);

    res.json({
      all: all.total,
      mine: mine.total,
      unassigned: unassigned.total,
      overdue: overdue.total,
      open: open.total,
    });
  }),
);

ticketsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const ticket = await findTicket(req.params.id, settings.ticketPrefix);
    if (!ticket) throw notFound('That ticket does not exist.');
    if (!canSeeTicket(user, ticket)) throw forbidden('You do not have access to this ticket.');

    const detail = await loadTicketDetail(ticket, { includeInternal: can(user, 'tickets.comment_internal') });
    res.json({ ticket: detail });
  }),
);

ticketsRouter.post(
  '/',
  requirePermission('tickets.create'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();

    /*
     * Parsing and permissions are the route's job; everything after it is the
     * same work whether the ticket came from this form, a Slack command or a
     * Teams card, and lives in the service so the three cannot drift.
     */
    const isHtml = req.body?.descriptionFormat === 'html';

    const ticket = await createTicket(
      {
        subject: requireString(req.body?.subject, 'Subject', { max: 200 }),
        // The larger cap reflects markup overhead, not more prose.
        description: optionalString(req.body?.description, isHtml ? 400_000 : 20_000) ?? '',
        descriptionFormat: isHtml ? 'html' : 'text',
        teamId: optionalString(req.body?.teamId, 60) ?? settings.defaultTeamId,
        requesterId: optionalString(req.body?.requesterId, 60) ?? user.id,
        assigneeId: optionalString(req.body?.assigneeId, 60),
        priority: requireEnum(req.body?.priority ?? settings.defaultPriority, TICKET_PRIORITIES, 'Priority'),
        type: requireEnum(req.body?.type ?? 'request', TICKET_TYPES, 'Type'),
        source: requireEnum(req.body?.source ?? 'web', TICKET_SOURCES, 'Source'),
        tags: toStringArray(req.body?.tags, 20),
        dueAt: optionalDate(req.body?.dueAt, 'Due date'),
        customFields: (req.body?.customFields ?? {}) as Record<string, unknown>,
      },
      { actor: user, ip: clientIp(req), origin: `${req.protocol}://${req.get('host')}` },
    );

    res.status(201).json({ ticket });
  }),
);

ticketsRouter.patch(
  '/:id',
  requirePermission('tickets.update', 'tickets.assign'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const before = await findTicket(req.params.id, settings.ticketPrefix);
    if (!before) throw notFound('That ticket does not exist.');
    if (!canSeeTicket(user, before)) throw forbidden('You do not have access to this ticket.');

    const updates: string[] = [];
    const params: Array<string | number | null> = [];
    const changes: Array<{ field: string; from: string | null; to: string | null }> = [];
    const push = (column: string, value: string | number | null) => {
      updates.push(`${column} = ?`);
      params.push(value);
    };

    const now = new Date().toISOString();

    if (req.body?.subject !== undefined) {
      const subject = requireString(req.body.subject, 'Subject', { max: 200 });
      if (subject !== before.subject) {
        push('subject', subject);
        changes.push({ field: 'subject', from: before.subject, to: subject });
      }
    }

    if (req.body?.description !== undefined) {
      const description = optionalString(req.body.description, 20_000) ?? '';
      if (description !== before.description) {
        push('description', description);
        changes.push({ field: 'description', from: null, to: null });
      }
    }

    if (req.body?.status !== undefined) {
      const status = requireEnum(req.body.status, TICKET_STATUSES, 'Status');
      if (status !== before.status) {
        if (!can(user, 'tickets.update')) throw forbidden('You cannot change a ticket status.');
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

    if (req.body?.priority !== undefined) {
      const priority = requireEnum(req.body.priority, TICKET_PRIORITIES, 'Priority');
      if (priority !== before.priority) {
        push('priority', priority);
        changes.push({ field: 'priority', from: before.priority, to: priority });
      }
    }

    if (req.body?.type !== undefined) {
      const type = requireEnum(req.body.type, TICKET_TYPES, 'Type');
      if (type !== before.type) {
        push('type', type);
        changes.push({ field: 'type', from: before.type, to: type });
      }
    }

    if (req.body?.teamId !== undefined) {
      const teamId = optionalString(req.body.teamId, 60);
      if (teamId !== before.teamId) {
        if (teamId && !(await findTeamById(teamId))) throw badRequest('That team no longer exists.');
        push('team_id', teamId);
        changes.push({ field: 'team', from: before.teamName, to: teamId });
      }
    }

    if (req.body?.assigneeId !== undefined) {
      if (!can(user, 'tickets.assign')) throw forbidden('You cannot reassign tickets.');
      const assigneeId = optionalString(req.body.assigneeId, 60);
      if (assigneeId !== before.assigneeId) {
        push('assignee_id', assigneeId);
        changes.push({ field: 'assignee', from: before.assigneeName, to: assigneeId });
        if (assigneeId) await addWatcher(before.id, assigneeId);
      }
    }

    if (req.body?.dueAt !== undefined) {
      const dueAt = optionalDate(req.body.dueAt, 'Due date');
      push('due_at', dueAt);
      changes.push({ field: 'dueAt', from: before.dueAt, to: dueAt });
    }

    if (req.body?.tags !== undefined) {
      const tags = toStringArray(req.body.tags, 20).map((tag) => tag.toLowerCase());
      push('tags', JSON.stringify(tags));
      changes.push({ field: 'tags', from: before.tags.join(', '), to: tags.join(', ') });
    }

    if (!updates.length) {
      return res.json({ ticket: before });
    }

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
      summary: `Updated ${after.reference} (${changes.map((c) => c.field).join(', ')})`,
      meta: { changes },
      ip: clientIp(req),
    });

    const ticketUrl = await buildTicketUrl(after, `${req.protocol}://${req.get('host')}`);

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

    res.json({ ticket: after });
  }),
);

/** Raises the escalation level, bumps priority, and notifies every channel. */
ticketsRouter.post(
  '/:id/escalate',
  requirePermission('tickets.update'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const ticket = await findTicket(req.params.id, settings.ticketPrefix);
    if (!ticket) throw notFound('That ticket does not exist.');
    if (!canSeeTicket(user, ticket)) throw forbidden('You do not have access to this ticket.');

    const reason = requireString(req.body?.reason, 'Reason', { max: 2000 });
    const nextPriority = ticket.priority === 'urgent' ? 'urgent' : ticket.priority === 'high' ? 'urgent' : 'high';
    const nextLevel = Math.min(ticket.escalationLevel + 1, 5);

    await db.run(
      `UPDATE tickets SET escalation_level = ?, priority = ?, type = 'escalation', updated_at = ? WHERE id = ?`,
      [nextLevel, nextPriority, new Date().toISOString(), ticket.id],
    );
    await recordEvent(ticket.id, user.id, 'escalated', 'escalationLevel', String(ticket.escalationLevel), String(nextLevel));

    await db.run(
      `INSERT INTO ticket_comments (id, ticket_id, author_id, body, is_internal, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [randomId(), ticket.id, user.id, `**Escalated to level ${nextLevel}.** ${reason}`, new Date().toISOString(), new Date().toISOString()],
    );

    const after = await findTicket(ticket.id, settings.ticketPrefix);
    if (!after) throw new Error('Escalation failed.');

    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'ticket',
      entityId: after.id,
      action: 'ticket_escalated',
      summary: `Escalated ${after.reference} to level ${nextLevel}`,
      meta: { reason, level: nextLevel },
      ip: clientIp(req),
    });

    await notifyUsers(
      after.watcherIds.filter((id) => id !== user.id),
      {
        ticketId: after.id,
        type: 'escalated',
        title: `${after.reference} escalated to level ${nextLevel}`,
        body: reason.slice(0, 200),
      },
    );

    dispatchAsync({
      event: 'ticketEscalated',
      ticket: after,
      actorName: user.name,
      headline: `Escalated to level ${nextLevel}: ${after.reference}`,
      detail: reason,
      ticketUrl: await buildTicketUrl(after, `${req.protocol}://${req.get('host')}`),
    });

    res.json({ ticket: after });
  }),
);

/** Manually mirrors a ticket into Linear, independent of the auto-create rule. */
ticketsRouter.post(
  '/:id/push-to-linear',
  requirePermission('tickets.update'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const ticket = await findTicket(req.params.id, settings.ticketPrefix);
    if (!ticket) throw notFound('That ticket does not exist.');
    if (!canSeeTicket(user, ticket)) throw forbidden('You do not have access to this ticket.');

    const existing = ticket.links.find((link) => link.provider === 'linear');
    if (existing) throw badRequest(`This ticket is already linked to ${existing.externalKey ?? 'a Linear issue'}.`);

    const record = await loadIntegration('linear');
    if (!record.enabled) throw badRequest('The Linear integration is not enabled.');

    const result = await createLinearIssue(record, {
      event: 'ticketEscalated',
      ticket,
      actorName: user.name,
      headline: `Escalated from ${ticket.reference}`,
      ticketUrl: await buildTicketUrl(ticket, `${req.protocol}://${req.get('host')}`),
    });

    if (!result.ok || !result.issueId || !result.url) {
      throw badRequest(result.error ?? 'Linear declined to create the issue.');
    }

    await addLink(ticket.id, 'linear', result.issueId, result.identifier ?? null, result.url);
    await recordEvent(ticket.id, user.id, 'linked', 'linear', null, result.identifier ?? result.issueId);

    res.json({ ticket: await findTicket(ticket.id, settings.ticketPrefix) });
  }),
);

ticketsRouter.post(
  '/:id/watch',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const ticket = await findTicket(req.params.id, settings.ticketPrefix);
    if (!ticket) throw notFound('That ticket does not exist.');
    if (!canSeeTicket(user, ticket)) throw forbidden('You do not have access to this ticket.');

    if (req.body?.watch === false) await removeWatcher(ticket.id, user.id);
    else await addWatcher(ticket.id, user.id);

    res.json({ ticket: await findTicket(ticket.id, settings.ticketPrefix) });
  }),
);

ticketsRouter.delete(
  '/:id',
  requirePermission('tickets.delete'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const ticket = await findTicket(req.params.id, settings.ticketPrefix);
    if (!ticket) throw notFound('That ticket does not exist.');

    await db.run(`DELETE FROM tickets WHERE id = ?`, [ticket.id]);
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'ticket',
      entityId: ticket.id,
      action: 'ticket_deleted',
      summary: `Deleted ${ticket.reference}: ${ticket.subject}`,
      ip: clientIp(req),
    });

    res.json({ ok: true });
  }),
);

/* ------------------------------- comments -------------------------------- */

ticketsRouter.post(
  '/:id/comments',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const ticket = await findTicket(req.params.id, settings.ticketPrefix);
    if (!ticket) throw notFound('That ticket does not exist.');
    if (!canSeeTicket(user, ticket)) throw forbidden('You do not have access to this ticket.');

    const commentIsHtml = req.body?.bodyFormat === 'html';
    const rawBody = requireString(req.body?.body, 'Comment', { max: commentIsHtml ? 400_000 : 20_000 });
    const cleanBody = commentIsHtml ? sanitizeRichText(rawBody) : rawBody;
    if (commentIsHtml && isEffectivelyEmpty(cleanBody)) throw badRequest('Write something before posting.');
    const body = cleanBody;
    const bodyFormat: 'text' | 'html' = commentIsHtml ? 'html' : 'text';
    const isInternal = req.body?.isInternal === true;
    if (isInternal && !can(user, 'tickets.comment_internal')) {
      throw forbidden('You cannot post internal notes.');
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

    await notifyUsers(
      after.watcherIds.filter((id) => id !== user.id),
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
        ticketUrl: await buildTicketUrl(after, `${req.protocol}://${req.get('host')}`),
      });
    }

    // Mirror public replies onto the linked Linear issue so both stay in sync.
    const linearLink = after.links.find((link) => link.provider === 'linear');
    if (linearLink && !isInternal) {
      const record = await loadIntegration('linear');
      if (record.enabled) {
        void commentOnLinearIssue(record, linearLink.externalId, `**${user.name}** (${settings.organizationName}):\n\n${body}`);
      }
    }

    const detail = await loadTicketDetail(after, { includeInternal: can(user, 'tickets.comment_internal') });
    res.status(201).json({ ticket: detail });
  }),
);
