import { Router } from 'express';
import { db, placeholders } from '../db/index.ts';
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
import { createLinearIssue, linearTeamFor, listLinearTeams } from '../integrations/linear.ts';
import { createGitHubIssue, githubRepoFor, listGitHubRepos } from '../integrations/github.ts';
import { notifyUsers } from '../lib/notifications.ts';
import { findUserById } from '../repositories/users.ts';
import { notifyOnCall, onCallContactsForTeam } from '../services/oncall-notify.ts';
import type { ActivityDay } from '../../shared/types.ts';
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
      resolvedFrom: optionalString(q.resolvedFrom, 40) ?? undefined,
      resolvedTo: optionalString(q.resolvedTo, 40) ?? undefined,
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

/**
 * Tickets created and resolved per day, for the activity heatmap. Scoped the
 * same way as the list; `tzOffset` is the browser's getTimezoneOffset() so a
 * ticket raised just after local midnight lands on the right square.
 */
ticketsRouter.get(
  '/activity',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const days = parseIntOr(req.query.days as string, 365, { min: 7, max: 400 });
    const offsetMs = parseIntOr(req.query.tzOffset as string, 0, { min: -900, max: 900 }) * 60_000;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const conditions = [`(t.created_at >= ? OR t.resolved_at >= ?)`];
    const params: Array<string | number> = [since, since];
    const teamIds = csv((req.query as Record<string, string>).teamId);
    if (teamIds.length) {
      conditions.push(`t.team_id IN (${placeholders(teamIds.length)})`);
      params.push(...teamIds);
    }
    const scoped = visibleTeamIds(user);
    if (scoped) {
      // Matches listTickets: their departments' tickets, plus any they are personally on.
      const parts: string[] = [];
      if (scoped.length) {
        parts.push(`t.team_id IN (${placeholders(scoped.length)})`);
        params.push(...scoped);
      }
      parts.push(`t.assignee_id = ?`, `t.requester_id = ?`, `t.created_by = ?`);
      params.push(user.id, user.id, user.id);
      conditions.push(`(${parts.join(' OR ')})`);
    }

    const rows = await db.all<{ created_at: string; resolved_at: string | null }>(
      `SELECT t.created_at, t.resolved_at FROM tickets t WHERE ${conditions.join(' AND ')}`,
      params,
    );

    const dayOf = (iso: string) => new Date(new Date(iso).getTime() - offsetMs).toISOString().slice(0, 10);
    const counts = new Map<string, ActivityDay>();
    const bump = (iso: string | null, key: 'created' | 'resolved') => {
      if (!iso || iso < since) return;
      const date = dayOf(iso);
      const entry = counts.get(date) ?? { date, created: 0, resolved: 0 };
      entry[key] += 1;
      counts.set(date, entry);
    };
    for (const row of rows) {
      bump(row.created_at, 'created');
      bump(row.resolved_at, 'resolved');
    }
    res.json({ days: [...counts.values()].sort((a, b) => a.date.localeCompare(b.date)), from: since });
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

    // Filing for someone else, or choosing who works it, is assigning: it needs tickets.assign.
    const askedRequester = optionalString(req.body?.requesterId, 60);
    const askedAssignee = optionalString(req.body?.assigneeId, 60);
    const mayAssign = can(user, 'tickets.assign');
    if (askedRequester && askedRequester !== user.id && !mayAssign) throw forbidden('You can only raise tickets as yourself.');
    if (askedAssignee && !mayAssign) throw forbidden('You cannot choose who a ticket is assigned to.');
    for (const id of [askedRequester, askedAssignee]) {
      if (id && id !== user.id && !(await findUserById(id))) throw badRequest('That person no longer exists.');
    }
    const requesterId = askedRequester ?? user.id;
    const assigneeId = askedAssignee;

    const ticket = await createTicket(
      {
        subject: requireString(req.body?.subject, 'Subject', { max: 200 }),
        // The larger cap reflects markup overhead, not more prose.
        description: richTextBody(req.body?.description, isHtml, 'Description') ?? '',
        descriptionFormat: isHtml ? 'html' : 'text',
        teamId: optionalString(req.body?.teamId, 60) ?? settings.defaultTeamId,
        requesterId,
        assigneeId,
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

/** Who the ticket's department has on call right now, with numbers to ring. */
ticketsRouter.get(
  '/:id/oncall',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const ticket = await findTicket(req.params.id, settings.ticketPrefix);
    if (!ticket) throw notFound('That ticket does not exist.');
    if (!canSeeTicket(user, ticket)) throw forbidden('You do not have access to this ticket.');
    const teams = await loadIntegration('msteams');
    res.json({ contacts: await onCallContactsForTeam(ticket.teamId), teamsConnected: teams.enabled });
  }),
);

/** Nudges whoever is on call: the bell, their phone's push, and the department's Teams channel. */
ticketsRouter.post(
  '/:id/notify-oncall',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const ticket = await findTicket(req.params.id, settings.ticketPrefix);
    if (!ticket) throw notFound('That ticket does not exist.');
    if (!canSeeTicket(user, ticket)) throw forbidden('You do not have access to this ticket.');
    const result = await notifyOnCall(
      ticket,
      user,
      { userIds: toStringArray(req.body?.userIds, 20), note: optionalString(req.body?.note, 500) },
      `${req.protocol}://${req.get('host')}`,
    );
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'ticket',
      entityId: ticket.id,
      action: 'oncall_notified',
      summary: `Notified on-call about ${ticket.reference}: ${result.notified.map((contact) => contact.name).join(', ')}`,
      ip: clientIp(req),
    });
    res.json(result);
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
/** The Linear teams a ticket could be pushed to, with the department's own preselected. */
ticketsRouter.get(
  '/:id/linear-targets',
  requirePermission('tickets.push_linear'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const ticket = await findTicket(req.params.id, settings.ticketPrefix);
    if (!ticket) throw notFound('That ticket does not exist.');
    if (!canSeeTicket(user, ticket)) throw forbidden('You do not have access to this ticket.');
    const record = await loadIntegration('linear');
    if (!record.enabled || !record.config.apiKey) throw badRequest('The Linear integration is not enabled.');
    let teams: Array<{ id: string; key: string; name: string }> = [];
    try {
      teams = await listLinearTeams(record.config.apiKey as string);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : 'Could not reach Linear.');
    }
    res.json({ teams, suggested: await linearTeamFor(record, ticket.teamId) });
  }),
);

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

    // Chosen in the "Create Linear issue" dialog; otherwise the department's own Linear team.
    const result = await createLinearIssue(
      record,
      {
        event: 'ticketEscalated',
        ticket,
        actorName: user.name,
        headline: `Escalated from ${ticket.reference}`,
        ticketUrl: await buildTicketUrl(ticket, `${req.protocol}://${req.get('host')}`),
      },
      { linearTeamId: optionalString(req.body?.linearTeamId, 100) },
    );

    if (!result.ok || !result.issueId || !result.url) {
      throw badRequest(result.error ?? 'Linear declined to create the issue.');
    }

    await addLink(ticket.id, 'linear', result.issueId, result.identifier ?? null, result.url);
    await recordEvent(ticket.id, user.id, 'linked', 'linear', null, result.identifier ?? result.issueId);

    res.json({ ticket: await findTicket(ticket.id, settings.ticketPrefix) });
  }),
);

/** The repositories a ticket could become an issue in, with the department's own preselected. */
ticketsRouter.get(
  '/:id/github-targets',
  requirePermission('tickets.push_linear'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const ticket = await findTicket(req.params.id, settings.ticketPrefix);
    if (!ticket) throw notFound('That ticket does not exist.');
    if (!canSeeTicket(user, ticket)) throw forbidden('You do not have access to this ticket.');
    const record = await loadIntegration('github');
    if (!record.enabled || !record.config.token) throw badRequest('The GitHub integration is not enabled.');
    let repos: Array<{ id: string; name: string }> = [];
    try {
      repos = await listGitHubRepos(record.config.token as string);
    } catch (error) {
      throw badRequest((error as Error).message);
    }
    res.json({ repos, suggested: await githubRepoFor(record, ticket.teamId) });
  }),
);

/** Opens a GitHub issue for the ticket and links the two. Uses the same permission as pushing to Linear. */
ticketsRouter.post(
  '/:id/push-to-github',
  requirePermission('tickets.push_linear'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const ticket = await findTicket(req.params.id, settings.ticketPrefix);
    if (!ticket) throw notFound('That ticket does not exist.');
    if (!canSeeTicket(user, ticket)) throw forbidden('You do not have access to this ticket.');
    const existing = ticket.links.find((link) => link.provider === 'github');
    if (existing) throw badRequest(`This ticket is already linked to ${existing.externalKey ?? 'a GitHub issue'}.`);

    const record = await loadIntegration('github');
    if (!record.enabled) throw badRequest('The GitHub integration is not enabled.');
    const result = await createGitHubIssue(
      record,
      {
        event: 'ticketEscalated',
        ticket,
        actorName: user.name,
        headline: `Raised from ${ticket.reference}`,
        ticketUrl: await buildTicketUrl(ticket, `${req.protocol}://${req.get('host')}`),
      },
      { repo: optionalString(req.body?.repo, 200) },
    );
    if (!result.ok) throw badRequest(result.error);

    const key = `${result.repo}#${result.number}`;
    await addLink(ticket.id, 'github', key, key, result.url);
    await recordEvent(ticket.id, user.id, 'linked', 'github', null, key);
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
    if (!canSeeTicket(user, ticket)) throw forbidden('You do not have access to this ticket.');

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

