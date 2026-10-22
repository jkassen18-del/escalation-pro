import { Router } from 'express';
import { db } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { lengthWithoutInlineImages } from '../lib/inline-images.ts';
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
import { createTicket, escalateTicketToTeam } from '../services/tickets.ts';
import { TICKET_EDIT_PERMISSIONS } from '../permissions.ts';
import { addTicketComment, canSeeTicket, updateTicket, type TicketPatch } from '../services/ticket-actions.ts';
import { loadIntegration } from '../integrations/store.ts';
import { createLinearIssue } from '../integrations/linear.ts';
import { notifyUsers } from '../lib/notifications.ts';
import {
  TICKET_PRIORITIES,
  TICKET_SOURCES,
  TICKET_STATUSES,
  TICKET_TYPES,
} from '../../shared/types.ts';

export const ticketsRouter: Router = Router();

ticketsRouter.use(requireAuth);

/**
 * A description or comment body. Pasted screenshots are not counted against
 * the text limit (they have their own caps when they are stored); text over
 * the limit is refused rather than silently cut, which used to slice through
 * the middle of an image.
 */
function richTextBody(value: unknown, isHtml: boolean, field: string): string | null {
  const text = typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
  if (!text) return null;
  const limit = isHtml ? 400_000 : 20_000;
  if ((isHtml ? lengthWithoutInlineImages(text) : text.length) > limit) {
    throw badRequest(`${field} must be ${limit.toLocaleString('en')} characters or fewer`, { [field]: 'Too long' });
  }
  return text;
}

function csv(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** A user may open a ticket if they can see all tickets, own it, or share its team. */

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
        description: richTextBody(req.body?.description, isHtml, 'Description') ?? '',
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
  requirePermission(...TICKET_EDIT_PERMISSIONS),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const before = await findTicket(req.params.id, settings.ticketPrefix);
    if (!before) throw notFound('That ticket does not exist.');
    if (!canSeeTicket(user, before)) throw forbidden('You do not have access to this ticket.');

    const after = await updateTicket(before, (req.body ?? {}) as TicketPatch, {
      actor: user,
      ip: clientIp(req),
      origin: `${req.protocol}://${req.get('host')}`,
    });
    res.json({ ticket: after });
  }),
);

/** Raises the escalation level, bumps priority, and notifies every channel. */
ticketsRouter.post(
  '/:id/escalate',
  requirePermission('tickets.escalate'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const ticket = await findTicket(req.params.id, settings.ticketPrefix);
    if (!ticket) throw notFound('That ticket does not exist.');
    if (!canSeeTicket(user, ticket)) throw forbidden('You do not have access to this ticket.');

    const reason = requireString(req.body?.reason, 'Reason', { max: 2000 });

    // Naming a department hands the ticket over to it, rather than only raising the level.
    const targetTeamId = optionalString(req.body?.teamId, 60);
    if (targetTeamId) {
      const priority =
        req.body?.priority === undefined || req.body?.priority === null || req.body?.priority === ''
          ? undefined
          : requireEnum(req.body.priority, TICKET_PRIORITIES, 'Priority');
      const after = await escalateTicketToTeam(ticket, {
        targetTeamId,
        reason,
        priority,
        actor: user,
        ip: clientIp(req),
        origin: `${req.protocol}://${req.get('host')}`,
      });
      res.json({ ticket: after });
      return;
    }

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
      [randomId(), ticket.id, user.id, `Escalated to level ${nextLevel}. ${reason}`, new Date().toISOString(), new Date().toISOString()],
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
  requirePermission('tickets.push_linear'),
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
    const rawBody = richTextBody(req.body?.body, commentIsHtml, 'Comment');
    if (!rawBody) throw badRequest('Comment is required', { Comment: 'Required' });
    const isInternal = req.body?.isInternal === true;
    if (isInternal && !can(user, 'tickets.comment_internal')) {
      throw forbidden('You cannot post internal notes.');
    }

    const after = await addTicketComment(
      ticket,
      { body: rawBody, bodyFormat: commentIsHtml ? 'html' : 'text', isInternal },
      { actor: user, ip: clientIp(req), origin: `${req.protocol}://${req.get('host')}` },
    );

    const detail = await loadTicketDetail(after, { includeInternal: can(user, 'tickets.comment_internal') });
    // Files sent with the comment are uploaded against this id, so files on an
    // internal note stay as private as the note.
    const comment = detail.comments.filter((c) => c.authorId === user.id).at(-1);
    res.status(201).json({ ticket: detail, commentId: comment?.id ?? null });
  }),
);

