import { db, nextTicketNumber, parseJson, placeholders } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import type {
  RichTextFormat,
  Ticket,
  TicketAttachment,
  TicketComment,
  TicketDetail,
  TicketEvent,
  TicketLink,
  TicketPriority,
  TicketSource,
  TicketStatus,
  TicketType,
} from '../../shared/types.ts';
import { TERMINAL_STATUSES } from '../../shared/types.ts';

/** Joined shape returned by every ticket query. */
interface TicketRow {
  id: string;
  number: number;
  subject: string;
  description: string;
  description_format: RichTextFormat | null;
  team_id: string | null;
  team_name: string | null;
  requester_id: string | null;
  requester_name: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  type: TicketType;
  source: TicketSource;
  tags: string;
  escalation_level: number;
  due_at: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  comment_count: number | string;
  attachment_count: number | string;
}

const SELECT_TICKET = `
  SELECT t.*,
         team.name AS team_name,
         req.name AS requester_name,
         asg.name AS assignee_name,
         crt.name AS created_by_name,
         (SELECT COUNT(*) FROM ticket_comments c WHERE c.ticket_id = t.id) AS comment_count,
         (SELECT COUNT(*) FROM ticket_attachments a WHERE a.ticket_id = t.id) AS attachment_count
  FROM tickets t
  LEFT JOIN teams team ON team.id = t.team_id
  LEFT JOIN users req ON req.id = t.requester_id
  LEFT JOIN users asg ON asg.id = t.assignee_id
  LEFT JOIN users crt ON crt.id = t.created_by
`;

export function referenceOf(prefix: string, number: number): string {
  return `${prefix}-${number}`;
}

function mapTicket(row: TicketRow, prefix: string, watcherIds: string[], links: TicketLink[]): Ticket {
  const isOpen = !TERMINAL_STATUSES.includes(row.status);
  return {
    id: row.id,
    number: Number(row.number),
    reference: referenceOf(prefix, Number(row.number)),
    subject: row.subject,
    description: row.description,
    descriptionFormat: (row.description_format ?? 'text') as RichTextFormat,
    teamId: row.team_id,
    teamName: row.team_name,
    requesterId: row.requester_id,
    requesterName: row.requester_name,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    status: row.status,
    priority: row.priority,
    type: row.type,
    source: row.source,
    tags: parseJson<string[]>(row.tags, []),
    escalationLevel: Number(row.escalation_level),
    dueAt: row.due_at,
    firstResponseAt: row.first_response_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    createdById: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    commentCount: Number(row.comment_count ?? 0),
    attachmentCount: Number(row.attachment_count ?? 0),
    watcherIds,
    links,
    isOverdue: Boolean(row.due_at) && isOpen && new Date(row.due_at!).getTime() < Date.now(),
  };
}

export interface TicketQuery {
  status?: TicketStatus[];
  priority?: TicketPriority[];
  type?: TicketType[];
  teamIds?: string[];
  assigneeIds?: string[];
  requesterIds?: string[];
  search?: string;
  tag?: string;
  overdueOnly?: boolean;
  unassignedOnly?: boolean;
  createdFrom?: string;
  createdTo?: string;
  /** Restricts results to these teams plus tickets the user owns or raised. */
  visibleTeamIds?: string[] | null;
  viewerId?: string;
  sort?: 'newest' | 'oldest' | 'priority' | 'due' | 'updated';
  limit?: number;
  offset?: number;
}

function buildWhere(query: TicketQuery): { clause: string; params: Array<string | number> } {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (query.status?.length) {
    conditions.push(`t.status IN (${placeholders(query.status.length)})`);
    params.push(...query.status);
  }
  if (query.priority?.length) {
    conditions.push(`t.priority IN (${placeholders(query.priority.length)})`);
    params.push(...query.priority);
  }
  if (query.type?.length) {
    conditions.push(`t.type IN (${placeholders(query.type.length)})`);
    params.push(...query.type);
  }
  if (query.teamIds?.length) {
    conditions.push(`t.team_id IN (${placeholders(query.teamIds.length)})`);
    params.push(...query.teamIds);
  }
  if (query.assigneeIds?.length) {
    conditions.push(`t.assignee_id IN (${placeholders(query.assigneeIds.length)})`);
    params.push(...query.assigneeIds);
  }
  if (query.requesterIds?.length) {
    conditions.push(`t.requester_id IN (${placeholders(query.requesterIds.length)})`);
    params.push(...query.requesterIds);
  }
  if (query.unassignedOnly) {
    conditions.push(`t.assignee_id IS NULL`);
  }
  if (query.overdueOnly) {
    conditions.push(`t.due_at IS NOT NULL AND t.due_at < ? AND t.status NOT IN ('resolved', 'closed')`);
    params.push(new Date().toISOString());
  }
  if (query.createdFrom) {
    conditions.push(`t.created_at >= ?`);
    params.push(query.createdFrom);
  }
  if (query.createdTo) {
    conditions.push(`t.created_at <= ?`);
    params.push(query.createdTo);
  }
  if (query.tag) {
    conditions.push(`LOWER(t.tags) LIKE ?`);
    params.push(`%"${query.tag.toLowerCase()}"%`);
  }
  if (query.search) {
    const needle = `%${query.search.toLowerCase()}%`;
    // Ticket references are typed as "ESC-1042" or just "1042"; match the number too.
    const numeric = query.search.replace(/\D/g, '');
    if (numeric) {
      conditions.push(`(LOWER(t.subject) LIKE ? OR LOWER(t.description) LIKE ? OR CAST(t.number AS TEXT) = ?)`);
      params.push(needle, needle, numeric);
    } else {
      conditions.push(`(LOWER(t.subject) LIKE ? OR LOWER(t.description) LIKE ?)`);
      params.push(needle, needle);
    }
  }

  // Team-scoped visibility for users without tickets.view_all.
  if (query.visibleTeamIds) {
    const parts: string[] = [];
    if (query.visibleTeamIds.length) {
      parts.push(`t.team_id IN (${placeholders(query.visibleTeamIds.length)})`);
      params.push(...query.visibleTeamIds);
    }
    if (query.viewerId) {
      parts.push(`t.assignee_id = ?`, `t.requester_id = ?`, `t.created_by = ?`);
      params.push(query.viewerId, query.viewerId, query.viewerId);
    }
    conditions.push(parts.length ? `(${parts.join(' OR ')})` : '1 = 0');
  }

  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

function buildOrder(sort: TicketQuery['sort']): string {
  switch (sort) {
    case 'oldest':
      return 'ORDER BY t.created_at ASC';
    case 'updated':
      return 'ORDER BY t.updated_at DESC';
    case 'due':
      // Tickets without a due date sort last rather than first.
      return 'ORDER BY CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at ASC';
    case 'priority':
      return `ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.created_at DESC`;
    default:
      return 'ORDER BY t.created_at DESC';
  }
}

async function watcherMap(ticketIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!ticketIds.length) return map;
  const rows = await db.all<{ ticket_id: string; user_id: string }>(
    `SELECT ticket_id, user_id FROM ticket_watchers WHERE ticket_id IN (${placeholders(ticketIds.length)})`,
    ticketIds,
  );
  for (const row of rows) {
    if (!map.has(row.ticket_id)) map.set(row.ticket_id, []);
    map.get(row.ticket_id)!.push(row.user_id);
  }
  return map;
}

async function linkMap(ticketIds: string[]): Promise<Map<string, TicketLink[]>> {
  const map = new Map<string, TicketLink[]>();
  if (!ticketIds.length) return map;
  const rows = await db.all<Record<string, string>>(
    `SELECT * FROM ticket_links WHERE ticket_id IN (${placeholders(ticketIds.length)}) ORDER BY created_at`,
    ticketIds,
  );
  for (const row of rows) {
    const link: TicketLink = {
      id: row.id,
      provider: row.provider as TicketLink['provider'],
      externalId: row.external_id,
      externalKey: row.external_key ?? null,
      url: row.url,
      createdAt: row.created_at,
    };
    if (!map.has(row.ticket_id)) map.set(row.ticket_id, []);
    map.get(row.ticket_id)!.push(link);
  }
  return map;
}

export async function listTickets(
  query: TicketQuery,
  prefix: string,
): Promise<{ tickets: Ticket[]; total: number }> {
  const { clause, params } = buildWhere(query);
  const limit = Math.min(query.limit ?? 50, 200);
  const offset = Math.max(query.offset ?? 0, 0);

  const rows = await db.all<TicketRow>(
    `${SELECT_TICKET} ${clause} ${buildOrder(query.sort)} LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const countRow = await db.get<{ count: number | string }>(
    `SELECT COUNT(*) AS count FROM tickets t ${clause}`,
    params,
  );

  const ids = rows.map((r) => r.id);
  const watchers = await watcherMap(ids);
  const links = await linkMap(ids);

  return {
    tickets: rows.map((row) => mapTicket(row, prefix, watchers.get(row.id) ?? [], links.get(row.id) ?? [])),
    total: Number(countRow?.count ?? 0),
  };
}

export async function findTicket(idOrNumber: string, prefix: string): Promise<Ticket | null> {
  const numeric = Number.parseInt(idOrNumber.replace(/^\D+-?/, ''), 10);
  const row = await db.get<TicketRow>(
    `${SELECT_TICKET} WHERE t.id = ? ${Number.isNaN(numeric) ? '' : 'OR t.number = ?'} LIMIT 1`,
    Number.isNaN(numeric) ? [idOrNumber] : [idOrNumber, numeric],
  );
  if (!row) return null;
  const watchers = await watcherMap([row.id]);
  const links = await linkMap([row.id]);
  return mapTicket(row, prefix, watchers.get(row.id) ?? [], links.get(row.id) ?? []);
}

export async function loadTicketDetail(
  ticket: Ticket,
  options: { includeInternal: boolean },
): Promise<TicketDetail> {
  const commentRows = await db.all<Record<string, string | number>>(
    `SELECT c.*, u.name AS author_name FROM ticket_comments c
     LEFT JOIN users u ON u.id = c.author_id
     WHERE c.ticket_id = ? ${options.includeInternal ? '' : 'AND c.is_internal = 0'}
     ORDER BY c.created_at ASC`,
    [ticket.id],
  );

  const attachmentRows = await db.all<Record<string, string | number>>(
    `SELECT a.*, u.name AS uploaded_by_name FROM ticket_attachments a
     LEFT JOIN users u ON u.id = a.uploaded_by
     WHERE a.ticket_id = ? ORDER BY a.created_at ASC`,
    [ticket.id],
  );

  const eventRows = await db.all<Record<string, string>>(
    `SELECT e.*, u.name AS actor_name FROM ticket_events e
     LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.ticket_id = ? ORDER BY e.created_at ASC`,
    [ticket.id],
  );

  const attachments: TicketAttachment[] = attachmentRows.map((row) => ({
    id: String(row.id),
    ticketId: String(row.ticket_id),
    commentId: row.comment_id ? String(row.comment_id) : null,
    originalName: String(row.original_name),
    mimeType: String(row.mime_type),
    size: Number(row.size),
    uploadedById: row.uploaded_by ? String(row.uploaded_by) : null,
    uploadedByName: String(row.uploaded_by_name ?? 'Unknown'),
    createdAt: String(row.created_at),
    url: `/api/tickets/${ticket.id}/attachments/${row.id}`,
  }));

  const comments: TicketComment[] = commentRows.map((row) => ({
    id: String(row.id),
    ticketId: String(row.ticket_id),
    authorId: row.author_id ? String(row.author_id) : null,
    authorName: String(row.author_name ?? 'Unknown'),
    body: String(row.body),
    bodyFormat: (String(row.body_format ?? 'text') as RichTextFormat),
    isInternal: Number(row.is_internal) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    attachments: attachments.filter((a) => a.commentId === String(row.id)),
  }));

  const events: TicketEvent[] = eventRows.map((row) => ({
    id: String(row.id),
    ticketId: String(row.ticket_id),
    actorId: row.actor_id ?? null,
    actorName: String(row.actor_name ?? 'System'),
    action: String(row.action),
    field: row.field ?? null,
    fromValue: row.from_value ?? null,
    toValue: row.to_value ?? null,
    createdAt: String(row.created_at),
  }));

  return { ...ticket, comments, events, attachments };
}

export interface CreateTicketInput {
  subject: string;
  description: string;
  descriptionFormat: RichTextFormat;
  teamId: string | null;
  requesterId: string | null;
  assigneeId: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  type: TicketType;
  source: TicketSource;
  tags: string[];
  dueAt: string | null;
  createdBy: string | null;
}

export async function insertTicket(input: CreateTicketInput): Promise<{ id: string; number: number }> {
  const id = randomId();
  const number = await nextTicketNumber();
  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO tickets (id, number, subject, description, description_format, team_id, requester_id,
       assignee_id, status, priority, type, source, tags, escalation_level, due_at, created_by,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      id,
      number,
      input.subject,
      input.description,
      input.descriptionFormat,
      input.teamId,
      input.requesterId,
      input.assigneeId,
      input.status,
      input.priority,
      input.type,
      input.source,
      JSON.stringify(input.tags),
      input.dueAt,
      input.createdBy,
      now,
      now,
    ],
  );

  return { id, number };
}

export async function recordEvent(
  ticketId: string,
  actorId: string | null,
  action: string,
  field?: string | null,
  fromValue?: string | null,
  toValue?: string | null,
): Promise<void> {
  await db.run(
    `INSERT INTO ticket_events (id, ticket_id, actor_id, action, field, from_value, to_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomId(), ticketId, actorId, action, field ?? null, fromValue ?? null, toValue ?? null, new Date().toISOString()],
  );
}

export async function addWatcher(ticketId: string, userId: string): Promise<void> {
  await db.run(
    `INSERT INTO ticket_watchers (ticket_id, user_id) VALUES (?, ?) ON CONFLICT (ticket_id, user_id) DO NOTHING`,
    [ticketId, userId],
  );
}

export async function removeWatcher(ticketId: string, userId: string): Promise<void> {
  await db.run(`DELETE FROM ticket_watchers WHERE ticket_id = ? AND user_id = ?`, [ticketId, userId]);
}

export async function addLink(
  ticketId: string,
  provider: string,
  externalId: string,
  externalKey: string | null,
  url: string,
): Promise<void> {
  await db.run(
    `INSERT INTO ticket_links (id, ticket_id, provider, external_id, external_key, url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [randomId(), ticketId, provider, externalId, externalKey, url, new Date().toISOString()],
  );
}

/** Minutes from now, as an ISO timestamp, for SLA due dates. */
export function dueDateFrom(minutes: number, from = new Date()): string {
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}

/** Urgent work gets a tighter clock than the team default. */
export function slaMultiplier(priority: TicketPriority): number {
  switch (priority) {
    case 'urgent':
      return 0.25;
    case 'high':
      return 0.5;
    case 'low':
      return 2;
    default:
      return 1;
  }
}
