import { Router } from 'express';
import * as XLSX from 'xlsx';
import { db } from '../db/index.ts';
import { asyncRoute, optionalString } from '../lib/http.ts';
import { requireAuth, requirePermission, visibleTeamIds, type AuthedRequest } from '../middleware/auth.ts';
import { getSettings } from '../repositories/settings.ts';
import { listTickets, referenceOf, type TicketQuery } from '../repositories/tickets.ts';
import { TICKET_PRIORITIES, type ReportSummary, type TicketPriority } from '../../shared/types.ts';

export const reportsRouter: Router = Router();

reportsRouter.use(requireAuth, requirePermission('reports.view'));

/** Window filter shared by the summary and the export. */
function range(req: { query: Record<string, unknown> }): { from: string; to: string } {
  const to = optionalString(req.query.to, 40) ?? new Date().toISOString();
  const from =
    optionalString(req.query.from, 40) ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

function minutesBetween(a: string, b: string): number {
  return Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 60_000);
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

reportsRouter.get(
  '/summary',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const { from, to } = range(req as never);
    const scoped = visibleTeamIds(user);

    // Pull the window once and aggregate in memory. At departmental volumes
    // this is far simpler than eight dialect-portable GROUP BY queries.
    const query: TicketQuery = {
      createdFrom: from,
      createdTo: to,
      visibleTeamIds: scoped,
      viewerId: user.id,
      limit: 200,
    };

    const collected: Awaited<ReturnType<typeof listTickets>>['tickets'] = [];
    let offset = 0;
    for (;;) {
      const page = await listTickets({ ...query, offset }, settings.ticketPrefix);
      collected.push(...page.tickets);
      offset += page.tickets.length;
      if (collected.length >= page.total || !page.tickets.length || offset > 20_000) break;
    }

    const totals = {
      open: collected.filter((t) => t.status === 'open').length,
      inProgress: collected.filter((t) => t.status === 'in_progress').length,
      pending: collected.filter((t) => t.status === 'pending').length,
      resolved: collected.filter((t) => t.status === 'resolved').length,
      closed: collected.filter((t) => t.status === 'closed').length,
      overdue: collected.filter((t) => t.isOverdue).length,
      unassigned: collected.filter((t) => !t.assigneeId && t.status !== 'closed' && t.status !== 'resolved').length,
    };

    const byPriority = TICKET_PRIORITIES.map((priority: TicketPriority) => ({
      priority,
      count: collected.filter((t) => t.priority === priority).length,
    }));

    const teamMap = new Map<string, { teamId: string; teamName: string; count: number; overdue: number }>();
    for (const ticket of collected) {
      const key = ticket.teamId ?? 'none';
      if (!teamMap.has(key)) {
        teamMap.set(key, { teamId: key, teamName: ticket.teamName ?? 'Unassigned', count: 0, overdue: 0 });
      }
      const entry = teamMap.get(key)!;
      entry.count += 1;
      if (ticket.isOverdue) entry.overdue += 1;
    }

    const assigneeMap = new Map<string, { assigneeId: string | null; assigneeName: string; open: number; resolved: number }>();
    for (const ticket of collected) {
      const key = ticket.assigneeId ?? 'none';
      if (!assigneeMap.has(key)) {
        assigneeMap.set(key, {
          assigneeId: ticket.assigneeId,
          assigneeName: ticket.assigneeName ?? 'Unassigned',
          open: 0,
          resolved: 0,
        });
      }
      const entry = assigneeMap.get(key)!;
      if (ticket.status === 'resolved' || ticket.status === 'closed') entry.resolved += 1;
      else entry.open += 1;
    }

    // Day buckets across the whole window, including days with no activity.
    const volume = new Map<string, { date: string; created: number; resolved: number }>();
    const dayCursor = new Date(from);
    const end = new Date(to);
    while (dayCursor <= end && volume.size < 400) {
      const key = dayCursor.toISOString().slice(0, 10);
      volume.set(key, { date: key, created: 0, resolved: 0 });
      dayCursor.setUTCDate(dayCursor.getUTCDate() + 1);
    }
    for (const ticket of collected) {
      const createdKey = ticket.createdAt.slice(0, 10);
      if (volume.has(createdKey)) volume.get(createdKey)!.created += 1;
      if (ticket.resolvedAt) {
        const resolvedKey = ticket.resolvedAt.slice(0, 10);
        if (volume.has(resolvedKey)) volume.get(resolvedKey)!.resolved += 1;
      }
    }

    const firstResponses = collected
      .filter((t) => t.firstResponseAt)
      .map((t) => minutesBetween(t.createdAt, t.firstResponseAt!));
    const resolutions = collected
      .filter((t) => t.resolvedAt)
      .map((t) => minutesBetween(t.createdAt, t.resolvedAt!));

    // Compliance is measured only over tickets that actually reached a close.
    const withDue = collected.filter((t) => t.dueAt && (t.resolvedAt || t.closedAt));
    const metSla = withDue.filter((t) => new Date(t.resolvedAt ?? t.closedAt!) <= new Date(t.dueAt!));

    const summary: ReportSummary = {
      totals,
      byPriority,
      byTeam: Array.from(teamMap.values()).sort((a, b) => b.count - a.count),
      byAssignee: Array.from(assigneeMap.values()).sort((a, b) => b.open - a.open).slice(0, 15),
      volumeByDay: Array.from(volume.values()),
      avgFirstResponseMins: average(firstResponses),
      avgResolutionMins: average(resolutions),
      slaCompliancePct: withDue.length ? Math.round((metSla.length / withDue.length) * 100) : null,
    };

    res.json({ summary, range: { from, to }, ticketCount: collected.length });
  }),
);

/** Filtered export. Always a real .xlsx binary, never an HTML fallback. */
reportsRouter.get(
  '/export',
  requirePermission('reports.export'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const { from, to } = range(req as never);

    const { tickets } = await listTickets(
      {
        createdFrom: from,
        createdTo: to,
        visibleTeamIds: visibleTeamIds(user),
        viewerId: user.id,
        limit: 200,
        offset: 0,
      },
      settings.ticketPrefix,
    );

    // Pull everything in the window, not just the first page.
    const all = [...tickets];
    let offset = tickets.length;
    for (;;) {
      const page = await listTickets(
        {
          createdFrom: from,
          createdTo: to,
          visibleTeamIds: visibleTeamIds(user),
          viewerId: user.id,
          limit: 200,
          offset,
        },
        settings.ticketPrefix,
      );
      if (!page.tickets.length) break;
      all.push(...page.tickets);
      offset += page.tickets.length;
      if (all.length >= page.total || offset > 50_000) break;
    }

    const ticketSheet = all.map((ticket) => ({
      Reference: ticket.reference,
      Subject: ticket.subject,
      Status: ticket.status,
      Priority: ticket.priority,
      Type: ticket.type,
      Source: ticket.source,
      Team: ticket.teamName ?? '',
      Assignee: ticket.assigneeName ?? '',
      Requester: ticket.requesterName ?? '',
      'Escalation level': ticket.escalationLevel,
      Tags: ticket.tags.join(', '),
      Created: ticket.createdAt,
      Updated: ticket.updatedAt,
      Due: ticket.dueAt ?? '',
      'First response': ticket.firstResponseAt ?? '',
      Resolved: ticket.resolvedAt ?? '',
      Closed: ticket.closedAt ?? '',
      Overdue: ticket.isOverdue ? 'Yes' : 'No',
      Comments: ticket.commentCount,
      Attachments: ticket.attachmentCount,
    }));

    const commentRows = await db.all<Record<string, string>>(
      `SELECT t.number, c.created_at, u.name AS author, c.is_internal, c.body
       FROM ticket_comments c
       JOIN tickets t ON t.id = c.ticket_id
       LEFT JOIN users u ON u.id = c.author_id
       WHERE t.created_at >= ? AND t.created_at <= ?
       ORDER BY t.number, c.created_at`,
      [from, to],
    );

    const eventRows = await db.all<Record<string, string>>(
      `SELECT t.number, e.created_at, u.name AS actor, e.action, e.field, e.from_value, e.to_value
       FROM ticket_events e
       JOIN tickets t ON t.id = e.ticket_id
       LEFT JOIN users u ON u.id = e.actor_id
       WHERE t.created_at >= ? AND t.created_at <= ?
       ORDER BY t.number, e.created_at`,
      [from, to],
    );

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(ticketSheet), 'Tickets');
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(
        commentRows.map((row) => ({
          Reference: referenceOf(settings.ticketPrefix, Number(row.number)),
          When: row.created_at,
          Author: row.author ?? 'Unknown',
          Internal: Number(row.is_internal) === 1 ? 'Yes' : 'No',
          Comment: row.body,
        })),
      ),
      'Comments',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(
        eventRows.map((row) => ({
          Reference: referenceOf(settings.ticketPrefix, Number(row.number)),
          When: row.created_at,
          Actor: row.actor ?? 'System',
          Action: row.action,
          Field: row.field ?? '',
          From: row.from_value ?? '',
          To: row.to_value ?? '',
        })),
      ),
      'History',
    );

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const filename = `escalation-pro-${from.slice(0, 10)}-to-${to.slice(0, 10)}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }),
);
