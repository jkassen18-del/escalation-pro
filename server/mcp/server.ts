import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { HttpError } from '../lib/http.ts';
import { recordAudit } from '../lib/audit.ts';
import { can, visibleTeamIds } from '../middleware/auth.ts';
import { getSettings } from '../repositories/settings.ts';
import { findTeamById, listTeams } from '../repositories/teams.ts';
import { findTicket, listTickets, loadTicketDetail, type TicketQuery } from '../repositories/tickets.ts';
import { asFormFields, canUseTemplate, findTemplate, listTemplates, renderSubject } from '../repositories/ticket-templates.ts';
import { buildReportSummary } from '../routes/reports.ts';
import { createTicket, escalateTicketToTeam } from '../services/tickets.ts';
import { addTicketComment, canSeeTicket, updateTicket } from '../services/ticket-actions.ts';
import { listAlerts } from '../ops/alerts.ts';
import { listMaintenanceWindows } from '../ops/maintenance.ts';
import { getMonitor, listMonitors, monitorChecks } from '../ops/monitors.ts';
import { listSchedules, scheduleShifts } from '../ops/oncall.ts';
import { acknowledgePage, getPage, listPages } from '../ops/pager.ts';
import { canActOnPage, redactMonitor } from '../ops/access.ts';
import { getStatusPage, listStatusPages, renderStatusPage } from '../ops/status-pages.ts';
import { APP_VERSION } from '../../shared/version.ts';
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  type Permission,
  type Ticket,
} from '../../shared/types.ts';
import { SEVERITIES } from '../../shared/ops.ts';
import type { Caller } from './auth.ts';

/**
 * The MCP server Claude talks to: tools over the same services the web app
 * uses, run as the person who connected Claude.
 *
 * One is built per request (the transport is stateless), around a caller
 * whose user was loaded fresh for that request.
 */

export interface ServerContext {
  caller: Caller;
  /** Public base URL, for links back into the app. */
  baseUrl: string;
  /** Org-wide cap from Settings: read_only turns every write tool off. */
  orgMode: 'read_write' | 'read_only';
  ip: string | null;
}

const MAX_LIMIT = 50;

/** Results are JSON as text: compact enough for a model, exact enough to act on. */
function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function refuse(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Domain errors (403/404/400) become tool errors the model can read and explain. */
async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpError) {
      const details = error.details ? ` (${Object.entries(error.details).map(([k, v]) => `${k}: ${v}`).join('; ')})` : '';
      return refuse(`${error.message}${details}`);
    }
    console.error('[mcp] tool failed', error);
    return refuse('InfraTicket hit an unexpected error running that tool.');
  }
}

/** A ticket as Claude sees it: the useful fields and a link, nothing internal. */
function ticketSummary(ticket: Ticket, baseUrl: string) {
  return {
    id: ticket.id,
    reference: ticket.reference,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    type: ticket.type,
    severity: ticket.severity,
    team: ticket.teamName,
    assignee: ticket.assigneeName,
    requester: ticket.requesterName,
    overdue: ticket.isOverdue,
    dueAt: ticket.dueAt,
    escalationLevel: ticket.escalationLevel,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    url: `${baseUrl}/tickets/${ticket.id}`,
  };
}

function cursorOf(value: string | undefined): number {
  const n = Number.parseInt(value ?? '0', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Plain text, for a model: HTML descriptions and comments lose their markup and keep their words. */
function plain(text: string, format: string): string {
  if (format !== 'html') return text;
  return text
    .replace(/<img[^>]*>/gi, '[image]')
    .replace(/<\/(p|div|li|h\d)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildMcpServer(ctx: ServerContext): McpServer {
  const { caller, baseUrl } = ctx;
  const user = caller.user;
  const server = new McpServer(
    { name: 'infraticket', title: 'InfraTicket', version: APP_VERSION },
    {
      instructions:
        `InfraTicket is ${user.name}'s ticketing, incident and on-call system. Every tool runs as ${user.name} ` +
        `with their permissions. Tickets are referred to as e.g. ESC-1042. Prefer search_tickets and get_ticket ` +
        `before changing anything, and say what you changed with the ticket link.`,
    },
  );

  /** Writes need the token's scope, the org's mode and the person's permission - all three. */
  const writeBlocked = (permission?: Permission): string | null => {
    if (ctx.orgMode === 'read_only') return 'Your organisation has set the Claude connector to read-only, so Claude cannot change anything.';
    if (caller.scope !== 'read_write') return 'This connection is read-only. Reconnect Claude with read and write access to make changes.';
    if (permission && !can(user, permission)) return `${user.name} does not have the "${permission}" permission in InfraTicket.`;
    return null;
  };

  const audit = async (action: string, summary: string, entityType: 'ticket' | 'oncall', entityId: string | null, meta: Record<string, unknown> = {}) => {
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType,
      entityId,
      action: `claude_${action}`,
      summary: `${user.name} via Claude: ${summary}`,
      meta: { via: 'mcp', client: caller.clientName, ...meta },
      ip: ctx.ip,
    });
  };

  const loadVisibleTicket = async (idOrReference: string) => {
    const settings = await getSettings();
    const ticket = await findTicket(idOrReference.trim(), settings.ticketPrefix);
    if (!ticket || !canSeeTicket(user, ticket)) return null;
    return ticket;
  };

  /* --------------------------------- Read --------------------------------- */

  server.registerTool(
    'search_tickets',
    {
      title: 'Search tickets',
      description:
        'Find tickets the user can see. Filter by text, status, priority, type, team, assignee, overdue and creation date. ' +
        'Returns summaries with links; use get_ticket for the full history. Paginate with the returned nextCursor.',
      inputSchema: {
        text: z.string().max(200).optional().describe('Words in the subject, description or reference'),
        status: z.array(z.enum(TICKET_STATUSES)).optional(),
        priority: z.array(z.enum(TICKET_PRIORITIES)).optional(),
        type: z.array(z.enum(TICKET_TYPES)).optional(),
        team: z.string().optional().describe('Team id or name'),
        assignedToMe: z.boolean().optional(),
        unassigned: z.boolean().optional(),
        overdue: z.boolean().optional(),
        createdFrom: z.string().optional().describe('ISO date, inclusive'),
        createdTo: z.string().optional().describe('ISO date, inclusive'),
        sort: z.enum(['newest', 'oldest', 'priority', 'due', 'updated']).optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        cursor: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      guarded(async () => {
        const settings = await getSettings();
        let teamIds: string[] | undefined;
        if (args.team) {
          const teams = await listTeams();
          const match = teams.find((t) => t.id === args.team || t.name.toLowerCase() === args.team!.toLowerCase() || t.key.toLowerCase() === args.team!.toLowerCase());
          if (!match) return refuse(`No team called "${args.team}". Use list_teams to see them.`);
          teamIds = [match.id];
        }
        const limit = args.limit ?? 20;
        const offset = cursorOf(args.cursor);
        const query: TicketQuery = {
          search: args.text,
          status: args.status,
          priority: args.priority,
          type: args.type,
          teamIds,
          assigneeIds: args.assignedToMe ? [user.id] : undefined,
          unassignedOnly: args.unassigned,
          overdueOnly: args.overdue,
          createdFrom: args.createdFrom,
          createdTo: args.createdTo,
          sort: args.sort ?? 'newest',
          visibleTeamIds: visibleTeamIds(user),
          viewerId: user.id,
          limit,
          offset,
        };
        const { tickets, total } = await listTickets(query, settings.ticketPrefix);
        return ok({
          total,
          tickets: tickets.map((t) => ticketSummary(t, baseUrl)),
          nextCursor: offset + tickets.length < total ? String(offset + tickets.length) : null,
        });
      }),
  );

  server.registerTool(
    'get_ticket',
    {
      title: 'Get a ticket',
      description:
        'Everything about one ticket: description, comments (internal notes only if the user may read them), timeline, ' +
        'form answers, linked Slack/Teams/Linear items, alerts and paging. Accepts the id or a reference like ESC-1042.',
      inputSchema: { ticket: z.string().min(1).max(80).describe('Ticket id or reference, e.g. ESC-1042') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ticket: ref }) =>
      guarded(async () => {
        const ticket = await loadVisibleTicket(ref);
        if (!ticket) return refuse(`No ticket "${ref}" that ${user.name} can see.`);
        const detail = await loadTicketDetail(ticket, { includeInternal: can(user, 'tickets.comment_internal') });
        const [alerts, pages] = await Promise.all([listAlerts({ ticketId: ticket.id, limit: 20 }), listPages({ ticketId: ticket.id, limit: 10 })]);
        return ok({
          ...ticketSummary(ticket, baseUrl),
          description: plain(detail.description, detail.descriptionFormat),
          tags: detail.tags,
          commander: detail.commanderName,
          template: detail.templateName,
          answers: detail.fieldValues.map((f) => ({ question: f.label, answer: f.value })),
          comments: detail.comments.map((c) => ({
            author: c.authorName,
            internal: c.isInternal,
            at: c.createdAt,
            body: plain(c.body, c.bodyFormat),
            attachments: c.attachments.map((a) => a.originalName),
          })),
          timeline: detail.events.slice(-50).map((e) => ({ at: e.createdAt, by: e.actorName, action: e.action, field: e.field, from: e.fromValue, to: e.toValue })),
          attachments: detail.attachments.map((a) => ({ name: a.originalName, type: a.mimeType, size: a.size })),
          links: detail.links.map((l) => ({ provider: l.provider, key: l.externalKey, url: l.url })),
          alerts: alerts.map((a) => ({ title: a.title, severity: a.severity, status: a.status, count: a.count, source: a.sourceName, lastSeen: a.lastSeenAt })),
          pages: pages.map((p) => ({ id: p.id, status: p.status, level: p.currentLevel + 1, policy: p.policyName, acknowledgedBy: p.acknowledgedByName, reason: p.reason })),
        });
      }),
  );

  server.registerTool(
    'my_queue',
    {
      title: 'My queue',
      description: "The user's own open tickets (assigned to them), most urgent and overdue first.",
      inputSchema: { limit: z.number().int().min(1).max(MAX_LIMIT).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) =>
      guarded(async () => {
        const settings = await getSettings();
        const { tickets, total } = await listTickets(
          { assigneeIds: [user.id], status: ['open', 'in_progress', 'pending'], sort: 'priority', visibleTeamIds: visibleTeamIds(user), viewerId: user.id, limit: limit ?? 25 },
          settings.ticketPrefix,
        );
        return ok({ total, tickets: tickets.map((t) => ticketSummary(t, baseUrl)) });
      }),
  );

  server.registerTool(
    'list_incidents',
    {
      title: 'Open incidents',
      description: 'Open incident tickets with severity, commander and whether someone is being paged right now.',
      inputSchema: { limit: z.number().int().min(1).max(MAX_LIMIT).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) =>
      guarded(async () => {
        const settings = await getSettings();
        const { tickets } = await listTickets(
          { type: ['incident'], status: ['open', 'in_progress', 'pending'], sort: 'priority', visibleTeamIds: visibleTeamIds(user), viewerId: user.id, limit: limit ?? 25 },
          settings.ticketPrefix,
        );
        const active = await listPages({ status: 'active', limit: 200 });
        return ok({
          incidents: tickets.map((t) => {
            const page = active.find((p) => p.ticketId === t.id);
            return {
              ...ticketSummary(t, baseUrl),
              commander: t.commanderName,
              paging: page ? { pageId: page.id, level: page.currentLevel + 1, policy: page.policyName, since: page.createdAt } : null,
            };
          }),
        });
      }),
  );

  server.registerTool(
    'who_is_on_call',
    {
      title: 'Who is on call',
      description: 'Who is on call for each schedule, now or at a given time, and when the next handover is.',
      inputSchema: {
        at: z.string().optional().describe('ISO date-time; defaults to now'),
        schedule: z.string().optional().describe('Schedule id or name to narrow to one'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ at, schedule }) =>
      guarded(async () => {
        const when = at ? new Date(at).getTime() : Date.now();
        if (!Number.isFinite(when)) return refuse('"at" must be an ISO date-time.');
        const schedules = (await listSchedules()).filter(
          (s) => !schedule || s.id === schedule || s.name.toLowerCase().includes(schedule.toLowerCase()),
        );
        const results = [];
        for (const s of schedules) {
          const shifts = await scheduleShifts(s.id, when, when + 30 * 86_400_000);
          const current = shifts.find((shift) => new Date(shift.startsAt).getTime() <= when && new Date(shift.endsAt).getTime() > when);
          const next = shifts.find((shift) => new Date(shift.startsAt).getTime() > when);
          results.push({
            schedule: s.name,
            team: s.teamName,
            timeZone: s.timeZone,
            onCall: current ? { name: current.userName, until: current.endsAt, override: current.source === 'override' } : null,
            nextHandover: next ? { to: next.userName, at: next.startsAt } : null,
          });
        }
        return ok({ at: new Date(when).toISOString(), schedules: results });
      }),
  );

  server.registerTool(
    'list_monitors',
    {
      title: 'Monitors',
      description: 'Built-in monitors (HTTP, TCP, ping, DNS, SSL, heartbeat, database) with state, last result and 24h uptime.',
      inputSchema: { state: z.enum(['up', 'down', 'pending', 'paused']).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ state }) =>
      guarded(async () => {
        const monitors = (await listMonitors()).filter((m) => !state || m.state === state);
        return ok({
          monitors: monitors.map((m) => ({
            id: m.id,
            name: m.name,
            kind: m.kind,
            target: m.target ? redactMonitor(m, user).target : null,
            state: m.state,
            team: m.teamName,
            severity: m.severity,
            lastCheckedAt: m.lastCheckedAt,
            lastMessage: m.lastMessage,
            latencyMs: m.lastLatencyMs,
            uptime24h: m.uptime24h,
          })),
        });
      }),
  );

  server.registerTool(
    'get_monitor',
    {
      title: 'Get a monitor',
      description: 'One monitor with its recent checks.',
      inputSchema: { monitor: z.string().describe('Monitor id or exact name') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ monitor: ref }) =>
      guarded(async () => {
        const monitor = (await getMonitor(ref)) ?? (await listMonitors()).find((m) => m.name.toLowerCase() === ref.toLowerCase()) ?? null;
        if (!monitor) return refuse(`No monitor "${ref}".`);
        const checks = await monitorChecks(monitor.id, 20);
        return ok({
          id: monitor.id,
          name: monitor.name,
          kind: monitor.kind,
          target: monitor.target ? redactMonitor(monitor, user).target : null,
          state: monitor.state,
          team: monitor.teamName,
          severity: monitor.severity,
          intervalSecs: monitor.intervalSecs,
          uptime24h: monitor.uptime24h,
          lastChangeAt: monitor.lastChangeAt,
          recentChecks: checks.map((c) => ({ at: c.createdAt, ok: c.ok, latencyMs: c.latencyMs, message: c.message })),
        });
      }),
  );

  server.registerTool(
    'list_alerts',
    {
      title: 'Alerts',
      description: 'Alerts from monitors and alert sources (AWS, Azure, Grafana, Jenkins...). Defaults to open alerts.',
      inputSchema: {
        status: z.enum(['open', 'firing', 'acknowledged', 'resolved']).optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, limit }) =>
      guarded(async () => {
        const alerts = await listAlerts({ status: status ?? 'open', limit: limit ?? 25 });
        return ok({
          alerts: alerts.map((a) => ({
            title: a.title,
            severity: a.severity,
            status: a.status,
            source: a.sourceName,
            count: a.count,
            ticket: a.ticketReference,
            ticketUrl: a.ticketId ? `${baseUrl}/tickets/${a.ticketId}` : null,
            suppressed: a.suppressed,
            firstSeen: a.firstSeenAt,
            lastSeen: a.lastSeenAt,
          })),
        });
      }),
  );

  server.registerTool(
    'get_status_page',
    {
      title: 'Status page',
      description: 'What a status page currently shows: overall state, each service, and recent updates. Without a page, lists them.',
      inputSchema: { page: z.string().optional().describe('Status page id or address (slug)') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ page: ref }) =>
      guarded(async () => {
        if (!ref) {
          const pages = await listStatusPages();
          return ok({ pages: pages.map((p) => ({ id: p.id, title: p.title, slug: p.slug, public: p.isPublic, url: `${baseUrl}/status/${p.slug}` })) });
        }
        const page = await getStatusPage(ref);
        if (!page) return refuse(`No status page "${ref}".`);
        const view = await renderStatusPage(page);
        return ok({
          title: page.title,
          public: page.isPublic,
          url: `${baseUrl}/status/${page.slug}`,
          overall: view.overall,
          services: view.components.map((c) => ({ name: c.label, status: c.status, uptime90d: c.uptime90d })),
          updates: view.updates.slice(0, 10).map((u) => ({ title: u.title, state: u.state, body: u.body, at: u.createdAt })),
        });
      }),
  );

  server.registerTool(
    'list_maintenance',
    {
      title: 'Maintenance windows',
      description: 'Maintenance in progress and coming up, with what it covers and whether paging or alerting is paused.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guarded(async () => {
        const windows = await listMaintenanceWindows();
        const relevant = windows.filter((w) => w.state === 'in_progress' || w.state === 'scheduled');
        return ok({
          windows: relevant.map((w) => ({
            title: w.title,
            state: w.state,
            effect: w.effect,
            covers: w.scopeSummary,
            current: w.currentOccurrence ? { from: w.currentOccurrence.startsAt, to: w.currentOccurrence.endsAt } : null,
            next: w.nextOccurrence ? { from: w.nextOccurrence.startsAt, to: w.nextOccurrence.endsAt } : null,
            recurrence: w.recurrence,
          })),
        });
      }),
  );

  server.registerTool(
    'list_teams',
    {
      title: 'Teams (departments)',
      description: 'Departments tickets can be routed to, with their SLA targets. Use the id or name with other tools.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guarded(async () => {
        const teams = await listTeams();
        return ok({
          teams: teams.map((t) => ({
            id: t.id,
            key: t.key,
            name: t.name,
            description: t.description,
            slaResponseMins: t.slaResponseMins,
            slaResolveMins: t.slaResolveMins,
            members: t.memberIds.length,
            isMine: user.teamIds.includes(t.id),
          })),
        });
      }),
  );

  server.registerTool(
    'list_quick_tickets',
    {
      title: 'Quick ticket templates',
      description: 'Ticket templates the user may raise (e.g. "Site issue"), with their questions. Use with create_ticket.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guarded(async () => {
        const templates = (await listTemplates()).filter((t) => t.enabled && t.teamId && canUseTemplate(t, user));
        return ok({
          templates: templates.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            department: t.teamName,
            priority: t.priority,
            guidance: t.guidance,
            questions: t.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required, options: f.options })),
          })),
        });
      }),
  );

  server.registerTool(
    'ticket_report',
    {
      title: 'Ticket report',
      description: 'Counts by status, priority, team and assignee, average first response and resolution times, and SLA compliance over a date range (default the last 30 days).',
      inputSchema: { from: z.string().optional().describe('ISO date'), to: z.string().optional().describe('ISO date') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ from, to }) =>
      guarded(async () => {
        if (!can(user, 'reports.view')) return refuse(`${user.name} does not have access to reports.`);
        const end = to ?? new Date().toISOString();
        const start = from ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
        const { summary, ticketCount } = await buildReportSummary(user, start, end);
        return ok({ range: { from: start, to: end }, ticketCount, ...summary, volumeByDay: undefined });
      }),
  );

  /* --------------------------------- Write -------------------------------- */

  server.registerTool(
    'create_ticket',
    {
      title: 'Create a ticket',
      description:
        'Raise a ticket as the user. Either give subject/description/team/priority/type, or a quick ticket template id with ' +
        'answers to its questions (the template decides department and priority). Required department questions must be answered in "answers".',
      inputSchema: {
        subject: z.string().min(1).max(200).optional(),
        description: z.string().max(20_000).optional(),
        team: z.string().optional().describe('Team id or name'),
        priority: z.enum(TICKET_PRIORITIES).optional(),
        type: z.enum(TICKET_TYPES).optional(),
        severity: z.enum(SEVERITIES).optional().describe('Incidents only'),
        templateId: z.string().optional(),
        answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      guarded(async () => {
        const blocked = writeBlocked('tickets.create');
        if (blocked) return refuse(blocked);
        const settings = await getSettings();
        let ticket: Ticket;
        if (args.templateId) {
          const template = await findTemplate(args.templateId);
          if (!template || !template.enabled) return refuse('That quick ticket does not exist.');
          if (!template.teamId) return refuse('That quick ticket has no department any more.');
          if (!canUseTemplate(template, user)) return refuse(`${user.name} cannot use that quick ticket.`);
          const answers = (args.answers ?? {}) as Record<string, unknown>;
          ticket = await createTicket(
            {
              subject: args.subject ?? renderSubject(template, answers, { summary: '', requester: user.name }),
              description: args.description ?? '',
              descriptionFormat: 'text',
              teamId: template.teamId,
              requesterId: user.id,
              priority: template.priority,
              type: template.ticketType,
              severity: template.severity,
              source: 'claude',
              tags: template.tags,
              customFields: answers,
              extraFields: asFormFields(template),
              extraAnswers: answers,
              templateId: template.id,
            },
            { actor: user, ip: ctx.ip, origin: baseUrl },
          );
        } else {
          if (!args.subject) return refuse('A subject is required (or use a quick ticket template).');
          let teamId: string | null = settings.defaultTeamId;
          if (args.team) {
            const team = (await findTeamById(args.team)) ?? (await listTeams()).find((t) => t.name.toLowerCase() === args.team!.toLowerCase() || t.key.toLowerCase() === args.team!.toLowerCase());
            if (!team) return refuse(`No team called "${args.team}". Use list_teams to see them.`);
            teamId = team.id;
          }
          ticket = await createTicket(
            {
              subject: args.subject,
              description: args.description ?? '',
              descriptionFormat: 'text',
              teamId,
              requesterId: user.id,
              priority: args.priority ?? settings.defaultPriority,
              type: args.type ?? 'request',
              severity: args.type === 'incident' ? (args.severity ?? null) : null,
              source: 'claude',
              customFields: (args.answers ?? {}) as Record<string, unknown>,
            },
            { actor: user, ip: ctx.ip, origin: baseUrl },
          );
        }
        await audit('create_ticket', `created ${ticket.reference}: ${ticket.subject}`, 'ticket', ticket.id);
        return ok({ created: ticketSummary(ticket, baseUrl) });
      }),
  );

  server.registerTool(
    'add_comment',
    {
      title: 'Comment on a ticket',
      description: 'Add a reply to a ticket as the user. Public replies reach the requester and the linked Slack/Teams/Linear threads; set internal for a note only staff see.',
      inputSchema: {
        ticket: z.string().min(1).max(80),
        body: z.string().min(1).max(20_000),
        internal: z.boolean().optional().describe('Internal note, hidden from the requester'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ ticket: ref, body, internal }) =>
      guarded(async () => {
        const blocked = writeBlocked(internal ? 'tickets.comment_internal' : undefined);
        if (blocked) return refuse(blocked);
        const ticket = await loadVisibleTicket(ref);
        if (!ticket) return refuse(`No ticket "${ref}" that ${user.name} can see.`);
        const after = await addTicketComment(ticket, { body, bodyFormat: 'text', isInternal: Boolean(internal) }, { actor: user, ip: ctx.ip, origin: baseUrl });
        await audit('add_comment', `${internal ? 'added an internal note to' : 'replied on'} ${after.reference}`, 'ticket', after.id, { internal: Boolean(internal) });
        return ok({ commentedOn: ticketSummary(after, baseUrl), internal: Boolean(internal) });
      }),
  );

  server.registerTool(
    'update_ticket',
    {
      title: 'Update a ticket',
      description: 'Change a ticket\'s status, priority, assignee, team or severity, with the same rules as the web app. Give only the fields to change.',
      inputSchema: {
        ticket: z.string().min(1).max(80),
        status: z.enum(TICKET_STATUSES).optional(),
        priority: z.enum(TICKET_PRIORITIES).optional(),
        assignee: z.string().optional().describe('"me", a user id, or "none" to unassign'),
        team: z.string().optional().describe('Team id or name'),
        severity: z.enum([...SEVERITIES, 'none']).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      guarded(async () => {
        const needsAssign = args.assignee !== undefined;
        const needsUpdate = args.status !== undefined || args.priority !== undefined || args.team !== undefined || args.severity !== undefined;
        const blocked = writeBlocked(needsUpdate ? 'tickets.update' : needsAssign ? 'tickets.assign' : 'tickets.update');
        if (blocked) return refuse(blocked);
        if (needsAssign && !can(user, 'tickets.assign')) return refuse(`${user.name} cannot reassign tickets.`);
        const ticket = await loadVisibleTicket(args.ticket);
        if (!ticket) return refuse(`No ticket "${args.ticket}" that ${user.name} can see.`);

        const patch: Record<string, unknown> = {};
        if (args.status) patch.status = args.status;
        if (args.priority) patch.priority = args.priority;
        if (args.severity) patch.severity = args.severity === 'none' ? null : args.severity;
        if (args.assignee !== undefined) patch.assigneeId = args.assignee === 'me' ? user.id : args.assignee === 'none' ? null : args.assignee;
        if (args.team) {
          const team = (await findTeamById(args.team)) ?? (await listTeams()).find((t) => t.name.toLowerCase() === args.team!.toLowerCase() || t.key.toLowerCase() === args.team!.toLowerCase());
          if (!team) return refuse(`No team called "${args.team}".`);
          patch.teamId = team.id;
        }
        if (!Object.keys(patch).length) return refuse('Nothing to change: give a status, priority, assignee, team or severity.');
        const after = await updateTicket(ticket, patch, { actor: user, ip: ctx.ip, origin: baseUrl });
        await audit('update_ticket', `updated ${after.reference} (${Object.keys(patch).join(', ')})`, 'ticket', after.id, { patch });
        return ok({ updated: ticketSummary(after, baseUrl) });
      }),
  );

  server.registerTool(
    'escalate_ticket',
    {
      title: 'Escalate to another department',
      description: 'Hand a ticket to another department with a reason (recorded as an internal note and sent to that team), optionally changing priority.',
      inputSchema: {
        ticket: z.string().min(1).max(80),
        team: z.string().describe('Target team id or name'),
        reason: z.string().min(1).max(2000),
        priority: z.enum(TICKET_PRIORITIES).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guarded(async () => {
        const blocked = writeBlocked('tickets.update');
        if (blocked) return refuse(blocked);
        const ticket = await loadVisibleTicket(args.ticket);
        if (!ticket) return refuse(`No ticket "${args.ticket}" that ${user.name} can see.`);
        const team = (await findTeamById(args.team)) ?? (await listTeams()).find((t) => t.name.toLowerCase() === args.team.toLowerCase() || t.key.toLowerCase() === args.team.toLowerCase());
        if (!team) return refuse(`No team called "${args.team}".`);
        const after = await escalateTicketToTeam(ticket, { targetTeamId: team.id, reason: args.reason, priority: args.priority, actor: user, ip: ctx.ip, origin: baseUrl });
        await audit('escalate_ticket', `escalated ${after.reference} to ${team.name}`, 'ticket', after.id, { reason: args.reason });
        return ok({ escalated: ticketSummary(after, baseUrl) });
      }),
  );

  server.registerTool(
    'acknowledge_page',
    {
      title: 'Acknowledge a page',
      description: 'Acknowledge an on-call page so escalation stops (takes the incident if nobody owns it). Find page ids with list_incidents or get_ticket.',
      inputSchema: { pageId: z.string().min(1).max(80) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ pageId }) =>
      guarded(async () => {
        const blocked = writeBlocked();
        if (blocked) return refuse(blocked);
        const page = await getPage(pageId);
        if (!page) return refuse('No such page.');
        const ticket = await loadVisibleTicket(page.ticketId);
        if (!ticket) return refuse(`${user.name} cannot see the incident this page is for.`);
        if (!(await canActOnPage(user, page.id, page.currentTargetIds))) {
          return refuse('Only the people this page reached, or an on-call manager, can acknowledge it.');
        }
        const outcome = await acknowledgePage(pageId, user, 'claude');
        if (outcome === 'closed') return refuse('That page has already been resolved.');
        await audit('acknowledge_page', `acknowledged the page for ${ticket.reference}`, 'oncall', pageId);
        return ok({ outcome, ticket: ticketSummary(ticket, baseUrl) });
      }),
  );

  /* -------------------------------- Prompts ------------------------------- */

  server.registerPrompt(
    'daily_briefing',
    { title: 'Daily briefing', description: 'My queue, open incidents and who is on call, summarised.' },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              'Give me my InfraTicket briefing. Use my_queue, list_incidents, who_is_on_call and list_maintenance. ' +
              'Lead with anything overdue or paging, then my queue by priority, then who is on call and any maintenance today. Include ticket links.',
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'incident_summary',
    { title: 'Incident summary', description: 'A status summary of one incident, from its timeline, alerts and paging.', argsSchema: { ticket: z.string().describe('e.g. ESC-1042') } },
    ({ ticket }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Summarise incident ${ticket} for a status update. Use get_ticket. Cover: what is affected, when it started, ` +
              'severity, who is commanding and who was paged, what has been tried (from the timeline and comments), current state and next steps. ' +
              'Keep internal notes out of anything meant for customers, and say which parts came from internal notes.',
          },
        },
      ],
    }),
  );

  return server;
}
