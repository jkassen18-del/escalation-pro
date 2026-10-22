import { db, parseJson, toBool } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { getSettings } from '../repositories/settings.ts';
import { findTicket, recordEvent } from '../repositories/tickets.ts';
import { findTeamById } from '../repositories/teams.ts';
import { createTicket, SYSTEM_ACTOR } from '../services/tickets.ts';
import { TERMINAL_STATUSES, type TicketPriority } from '../../shared/types.ts';
import type { Alert, MaintenanceWindow, Severity } from '../../shared/ops.ts';
import { resolvePagesForTicket, triggerPage } from './pager.ts';

/**
 * The alert pipeline. Every signal - a monitor going down, a CloudWatch
 * alarm, a Jenkins build failing - comes through `ingestSignal`, which:
 *
 *  1. deduplicates: a repeat of an alert that is still open bumps its count;
 *  2. groups: a new alert from a source that already has an open incident
 *     within the grouping window joins that incident instead of opening another;
 *  3. opens an incident ticket and pages, routed by the source's escalation
 *     policy or its team's default - unless a maintenance window covers it;
 *  4. auto-resolves: when the last open alert on an incident resolves, the
 *     incident resolves and paging stops.
 */

export interface AlertSignal {
  sourceType: 'monitor' | 'webhook';
  sourceId: string;
  sourceName: string;
  dedupKey: string;
  title: string;
  summary?: string;
  severity: Severity;
  status: 'firing' | 'resolved';
  payload?: unknown;
  teamId: string | null;
  escalationPolicyId: string | null;
}

export type IngestAction = 'created' | 'grouped' | 'deduplicated' | 'resolved' | 'ignored';

export interface IngestResult {
  action: IngestAction;
  alertId: string | null;
  ticketId: string | null;
  suppressed: boolean;
  paged: boolean;
}

/** Alerts from the same source this close together belong to one incident. */
const GROUP_WINDOW_MS = Number(process.env.ALERT_GROUP_WINDOW_MINS || 15) * 60_000;

export const SEVERITY_PRIORITY: Record<Severity, TicketPriority> = {
  sev1: 'urgent',
  sev2: 'high',
  sev3: 'normal',
  sev4: 'low',
};

/** SEV4 opens a ticket but wakes nobody up. */
export function severityPages(severity: Severity): boolean {
  return severity !== 'sev4';
}

interface AlertRow {
  id: string;
  source_type: Alert['sourceType'];
  source_id: string;
  source_name: string;
  dedup_key: string;
  title: string;
  summary: string;
  severity: Severity;
  status: Alert['status'];
  count: number | string;
  ticket_id: string | null;
  ticket_number?: number | string | null;
  suppressed: number | string;
  payload: string | null;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

export function mapAlert(row: AlertRow, prefix: string): Alert {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceName: row.source_name,
    dedupKey: row.dedup_key,
    title: row.title,
    summary: row.summary,
    severity: row.severity,
    status: row.status,
    count: Number(row.count),
    ticketId: row.ticket_id,
    ticketReference: row.ticket_number ? `${prefix}-${row.ticket_number}` : null,
    suppressed: toBool(row.suppressed),
    payload: parseJson<unknown>(row.payload, null),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
  };
}

export async function listAlerts(filter: { status?: string; ticketId?: string; limit?: number } = {}): Promise<Alert[]> {
  const settings = await getSettings();
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (filter.status === 'open') conditions.push(`a.status <> 'resolved'`);
  else if (filter.status) {
    conditions.push(`a.status = ?`);
    params.push(filter.status);
  }
  if (filter.ticketId) {
    conditions.push(`a.ticket_id = ?`);
    params.push(filter.ticketId);
  }
  const rows = await db.all<AlertRow>(
    `SELECT a.*, t.number AS ticket_number FROM alerts a LEFT JOIN tickets t ON t.id = a.ticket_id
     ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY a.last_seen_at DESC LIMIT ?`,
    [...params, filter.limit ?? 200],
  );
  return rows.map((row) => mapAlert(row, settings.ticketPrefix));
}

/* --------------------------- Maintenance windows ------------------------- */

export async function listMaintenanceWindows(): Promise<MaintenanceWindow[]> {
  const rows = await db.all<Record<string, string | null>>(
    `SELECT m.*, u.name AS created_by_name FROM maintenance_windows m
     LEFT JOIN users u ON u.id = m.created_by ORDER BY m.starts_at DESC LIMIT 200`,
  );
  return rows.map((row) => ({
    id: row.id!,
    title: row.title!,
    startsAt: row.starts_at!,
    endsAt: row.ends_at!,
    monitorIds: parseJson<string[]>(row.monitor_ids, []),
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at!,
  }));
}

/** Whether a maintenance window covers this source right now. Suppresses paging, never recording. */
export async function inMaintenance(sourceId: string, at = new Date()): Promise<MaintenanceWindow | null> {
  const now = at.toISOString();
  const rows = await db.all<Record<string, string>>(
    `SELECT * FROM maintenance_windows WHERE starts_at <= ? AND ends_at > ?`,
    [now, now],
  );
  for (const row of rows) {
    const ids = parseJson<string[]>(row.monitor_ids, []);
    if (ids.length === 0 || ids.includes(sourceId)) {
      return { id: row.id, title: row.title, startsAt: row.starts_at, endsAt: row.ends_at, monitorIds: ids, createdByName: null, createdAt: row.created_at };
    }
  }
  return null;
}

/* ------------------------------- Pipeline -------------------------------- */

async function addSystemComment(ticketId: string, body: string): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO ticket_comments (id, ticket_id, author_id, body, body_format, is_internal, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'text', 1, ?, ?)`,
    [randomId(), ticketId, body, now, now],
  );
  await db.run(`UPDATE tickets SET updated_at = ? WHERE id = ?`, [now, ticketId]);
}

function describePayload(signal: AlertSignal): string {
  const lines = [signal.summary || signal.title, '', `Source: ${signal.sourceName}`, `Severity: ${signal.severity.toUpperCase()}`];
  if (signal.payload && typeof signal.payload === 'object') {
    const json = JSON.stringify(signal.payload, null, 2);
    lines.push('', 'Payload:', json.length > 4000 ? `${json.slice(0, 4000)}\n…` : json);
  }
  return lines.join('\n');
}

export async function ingestSignal(signal: AlertSignal): Promise<IngestResult> {
  const now = new Date().toISOString();
  const payload = signal.payload === undefined ? null : JSON.stringify(signal.payload).slice(0, 64_000);

  const open = await db.get<AlertRow>(
    `SELECT * FROM alerts WHERE source_id = ? AND dedup_key = ? AND status <> 'resolved' ORDER BY first_seen_at DESC LIMIT 1`,
    [signal.sourceId, signal.dedupKey],
  );

  if (signal.status === 'resolved') {
    if (!open) return { action: 'ignored', alertId: null, ticketId: null, suppressed: false, paged: false };
    await db.run(`UPDATE alerts SET status = 'resolved', resolved_at = ?, last_seen_at = ?, payload = COALESCE(?, payload) WHERE id = ?`, [
      now,
      now,
      payload,
      open.id,
    ]);
    if (open.ticket_id) await autoResolveTicket(open.ticket_id, signal);
    return { action: 'resolved', alertId: open.id, ticketId: open.ticket_id, suppressed: false, paged: false };
  }

  if (open) {
    await db.run(`UPDATE alerts SET count = count + 1, last_seen_at = ?, payload = COALESCE(?, payload) WHERE id = ?`, [now, payload, open.id]);
    return { action: 'deduplicated', alertId: open.id, ticketId: open.ticket_id, suppressed: toBool(open.suppressed), paged: false };
  }

  const maintenance = await inMaintenance(signal.sourceId);
  const alertId = randomId();
  await db.run(
    `INSERT INTO alerts (id, source_type, source_id, source_name, dedup_key, title, summary, severity, status, count,
       ticket_id, suppressed, payload, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'firing', 1, NULL, ?, ?, ?, ?)`,
    [
      alertId,
      signal.sourceType,
      signal.sourceId,
      signal.sourceName,
      signal.dedupKey,
      signal.title.slice(0, 300),
      (signal.summary ?? '').slice(0, 4000),
      signal.severity,
      maintenance ? 1 : 0,
      payload,
      now,
      now,
    ],
  );

  // Grouping: another open alert from this source, recent, on an incident still open.
  const since = new Date(Date.now() - GROUP_WINDOW_MS).toISOString();
  const sibling = await db.get<{ ticket_id: string }>(
    `SELECT a.ticket_id FROM alerts a JOIN tickets t ON t.id = a.ticket_id
     WHERE a.source_id = ? AND a.id <> ? AND a.status <> 'resolved' AND a.last_seen_at >= ?
       AND t.status NOT IN ('resolved', 'closed')
     ORDER BY a.last_seen_at DESC LIMIT 1`,
    [signal.sourceId, alertId, since],
  );
  if (sibling) {
    await db.run(`UPDATE alerts SET ticket_id = ? WHERE id = ?`, [sibling.ticket_id, alertId]);
    await addSystemComment(sibling.ticket_id, `Another alert joined this incident: ${signal.title}\n\n${signal.summary ?? ''}`.trim());
    await recordEvent(sibling.ticket_id, null, 'alert_grouped', 'alert', null, signal.title);
    return { action: 'grouped', alertId, ticketId: sibling.ticket_id, suppressed: Boolean(maintenance), paged: false };
  }

  const team = signal.teamId ? await findTeamById(signal.teamId) : null;
  const ticket = await createTicket(
    {
      subject: `[${signal.severity.toUpperCase()}] ${signal.title}`.slice(0, 200),
      description: describePayload(signal),
      teamId: team?.id ?? null,
      priority: SEVERITY_PRIORITY[signal.severity],
      type: 'incident',
      source: signal.sourceType,
      tags: ['alert', signal.sourceType],
      severity: signal.severity,
    },
    { actor: SYSTEM_ACTOR },
  );
  await db.run(`UPDATE alerts SET ticket_id = ? WHERE id = ?`, [ticket.id, alertId]);

  if (maintenance) {
    await addSystemComment(ticket.id, `Paging suppressed: maintenance window "${maintenance.title}" is in effect until ${maintenance.endsAt}.`);
    return { action: 'created', alertId, ticketId: ticket.id, suppressed: true, paged: false };
  }

  const teamPolicyId = team ? (await db.get<{ escalation_policy_id: string | null }>(`SELECT escalation_policy_id FROM teams WHERE id = ?`, [team.id]))?.escalation_policy_id ?? null : null;
  const policyId = signal.escalationPolicyId || teamPolicyId;
  let paged = false;
  if (policyId && severityPages(signal.severity)) {
    const via = signal.escalationPolicyId ? `its own escalation policy` : `the default escalation policy of team ${team?.name}`;
    await triggerPage(ticket.id, {
      policyId,
      severity: signal.severity,
      reason: `${signal.sourceType === 'monitor' ? 'Monitor' : 'Alert source'} "${signal.sourceName}" raised a ${signal.severity.toUpperCase()} alert ("${signal.title}") and was routed to ${via}.`,
    });
    paged = true;
  } else if (!policyId) {
    await addSystemComment(
      ticket.id,
      `Nobody was paged: neither "${signal.sourceName}" nor ${team ? `team ${team.name}` : 'a team'} has an escalation policy.`,
    );
  }
  return { action: 'created', alertId, ticketId: ticket.id, suppressed: false, paged };
}

/** The last open alert on an incident resolving resolves the incident and stops paging. */
async function autoResolveTicket(ticketId: string, signal: AlertSignal): Promise<void> {
  const remaining = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM alerts WHERE ticket_id = ? AND status <> 'resolved'`,
    [ticketId],
  );
  if (Number(remaining?.n ?? 0) > 0) {
    await addSystemComment(ticketId, `Recovered: ${signal.title}. Other alerts on this incident are still open.`);
    return;
  }

  const settings = await getSettings();
  const ticket = await findTicket(ticketId, settings.ticketPrefix);
  if (!ticket || TERMINAL_STATUSES.includes(ticket.status)) return;

  const now = new Date().toISOString();
  await db.run(`UPDATE tickets SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?`, [now, now, ticketId]);
  await recordEvent(ticketId, null, 'updated', 'status', ticket.status, 'resolved');
  await addSystemComment(ticketId, `Auto-resolved: ${signal.sourceName} reports the problem has cleared.`);
  await resolvePagesForTicket(ticketId, 'The alert resolved.');
}
