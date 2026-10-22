import { db, parseJson, toBool } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { getSettings } from '../repositories/settings.ts';
import { findTicket, recordEvent } from '../repositories/tickets.ts';
import { findTeamById } from '../repositories/teams.ts';
import { createTicket, SYSTEM_ACTOR } from '../services/tickets.ts';
import { TERMINAL_STATUSES, type TicketPriority } from '../../shared/types.ts';
import type { Alert, Severity } from '../../shared/ops.ts';
import { maintenanceFor, teamOfSource, type Coverage } from './maintenance.ts';
import { resolvePagesForTicket, triggerPage } from './pager.ts';
import { routeSignal } from './routing.ts';

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
  /** Monitor kind or alert source kind, for routing rules that match on it. */
  sourceKind?: string;
}

export type IngestAction = 'created' | 'grouped' | 'deduplicated' | 'resolved' | 'ignored' | 'suppressed';

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
  rule_name?: string | null;
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
    ruleName: row.rule_name ?? null,
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

export { listMaintenanceWindows } from './maintenance.ts';

/**
 * Whether a maintenance window covers this source right now. Kept for the
 * callers that only know a source id; the team is looked up.
 */
export async function inMaintenance(sourceId: string, at = new Date()): Promise<Coverage | null> {
  return maintenanceFor({ sourceId, teamId: await teamOfSource(sourceId) }, at.getTime());
}

/* ------------------------------- Pipeline -------------------------------- */

async function addSystemComment(ticketId: string, body: string): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO ticket_comments (id, ticket_id, author_id, body, body_format, is_internal, is_system, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'text', 1, 1, ?, ?)`,
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

  let open = await db.get<AlertRow>(
    `SELECT * FROM alerts WHERE source_id = ? AND dedup_key = ? AND status <> 'resolved' ORDER BY first_seen_at DESC LIMIT 1`,
    [signal.sourceId, signal.dedupKey],
  );

  // Someone closed the ticket while the alert was still firing. A fresh
  // failure must not vanish into that closed ticket as a dedup count: the
  // old alert ends with its ticket and this signal starts a new one.
  if (open?.ticket_id && signal.status !== 'resolved') {
    const ticket = await db.get<{ status: string }>(`SELECT status FROM tickets WHERE id = ?`, [open.ticket_id]);
    if (!ticket || TERMINAL_STATUSES.includes(ticket.status as (typeof TERMINAL_STATUSES)[number])) {
      await db.run(`UPDATE alerts SET status = 'resolved', resolved_at = ? WHERE id = ?`, [now, open.id]);
      open = undefined;
    }
  }

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

  // Routing rules see the alert before anything is recorded, so a rule can
  // change its severity or drop it outright.
  const routing = await routeSignal(signal);
  if (routing.drop) return { action: 'ignored', alertId: null, ticketId: null, suppressed: true, paged: false };
  const ruleName = routing.matchedRules.length ? routing.matchedRules.map((rule) => rule.name).join(' → ') : null;
  const routed: AlertSignal = { ...signal, severity: routing.severity, teamId: routing.teamId, escalationPolicyId: routing.escalationPolicyId };

  // Maintenance is matched against the source's own team, before routing
  // moves the alert anywhere: planned work on a team's systems is theirs.
  const maintenance = await maintenanceFor({ sourceId: signal.sourceId, teamId: signal.teamId ?? (await teamOfSource(signal.sourceId)) });
  const suppressed = Boolean(maintenance) || routing.suppressPaging;
  const alertId = randomId();
  await db.run(
    `INSERT INTO alerts (id, source_type, source_id, source_name, dedup_key, title, summary, severity, status, count,
       ticket_id, suppressed, rule_name, maintenance_id, payload, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'firing', 1, NULL, ?, ?, ?, ?, ?, ?)`,
    [
      alertId,
      signal.sourceType,
      signal.sourceId,
      signal.sourceName,
      signal.dedupKey,
      signal.title.slice(0, 300),
      (signal.summary ?? '').slice(0, 4000),
      routed.severity,
      suppressed ? 1 : 0,
      ruleName,
      maintenance?.windowId ?? null,
      payload,
      now,
      now,
    ],
  );

  // Pausing alerting records the alert and stops there: no ticket, no page.
  // When the window ends and the problem is still there, it is raised again.
  if (maintenance?.effect === 'pause_alerting') {
    return { action: 'suppressed', alertId, ticketId: null, suppressed: true, paged: false };
  }

  // Grouping: another open alert from this source, recent, on an incident
  // still open - and with the same department. A rule that sends this alert
  // somewhere else means it is not the same incident, whatever the source.
  const since = new Date(Date.now() - GROUP_WINDOW_MS).toISOString();
  const sibling = await db.get<{ ticket_id: string }>(
    `SELECT a.ticket_id FROM alerts a JOIN tickets t ON t.id = a.ticket_id
     WHERE a.source_id = ? AND a.id <> ? AND a.status <> 'resolved' AND a.last_seen_at >= ?
       AND t.status NOT IN ('resolved', 'closed') AND COALESCE(t.team_id, '') = ?
     ORDER BY a.last_seen_at DESC LIMIT 1`,
    [signal.sourceId, alertId, since, routed.teamId ?? ''],
  );
  if (sibling) {
    await db.run(`UPDATE alerts SET ticket_id = ? WHERE id = ?`, [sibling.ticket_id, alertId]);
    await addSystemComment(sibling.ticket_id, `Another alert joined this incident: ${signal.title}\n\n${signal.summary ?? ''}`.trim());
    await recordEvent(sibling.ticket_id, null, 'alert_grouped', 'alert', null, signal.title);
    return { action: 'grouped', alertId, ticketId: sibling.ticket_id, suppressed, paged: false };
  }

  const team = routed.teamId ? await findTeamById(routed.teamId) : null;
  const ticket = await createTicket(
    {
      subject: `[${routed.severity.toUpperCase()}] ${signal.title}`.slice(0, 200),
      description: describePayload(routed),
      teamId: team?.id ?? null,
      priority: SEVERITY_PRIORITY[routed.severity],
      type: 'incident',
      source: signal.sourceType,
      tags: Array.from(new Set(['alert', signal.sourceType, ...routing.tags])),
      severity: routed.severity,
    },
    { actor: SYSTEM_ACTOR },
  );
  await db.run(`UPDATE alerts SET ticket_id = ? WHERE id = ?`, [ticket.id, alertId]);
  if (ruleName) {
    await addSystemComment(ticket.id, `${routing.explanation}${team ? ` Sent to ${team.name}.` : ''}`);
    await recordEvent(ticket.id, null, 'routed', 'rule', null, ruleName);
  }

  if (maintenance) {
    await addSystemComment(ticket.id, `Paging suppressed: maintenance "${maintenance.title}" is in effect until ${maintenance.endsAt}. If this is still open when it ends, it pages then.`);
    return { action: 'created', alertId, ticketId: ticket.id, suppressed: true, paged: false };
  }
  if (routing.suppressPaging) {
    await addSystemComment(ticket.id, `Nobody was paged: rule '${ruleName}' records this alert as a ticket only.`);
    return { action: 'created', alertId, ticketId: ticket.id, suppressed: true, paged: false };
  }

  const teamPolicyId = team ? (await db.get<{ escalation_policy_id: string | null }>(`SELECT escalation_policy_id FROM teams WHERE id = ?`, [team.id]))?.escalation_policy_id ?? null : null;
  const policyId = routed.escalationPolicyId || teamPolicyId;
  let paged = false;
  if (policyId && severityPages(routed.severity)) {
    const via = routed.escalationPolicyId
      ? ruleName && routed.escalationPolicyId !== signal.escalationPolicyId
        ? `the escalation policy set by rule '${ruleName}'`
        : `its own escalation policy`
      : `the default escalation policy of team ${team?.name}`;
    await triggerPage(ticket.id, {
      policyId,
      severity: routed.severity,
      reason:
        `${signal.sourceType === 'monitor' ? 'Monitor' : 'Alert source'} "${signal.sourceName}" raised a ${routed.severity.toUpperCase()} alert ("${signal.title}") and was routed to ${via}.` +
        (ruleName ? ` ${routing.explanation}` : ''),
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

/**
 * After a maintenance window ends: anything it held back that is still open
 * is raised normally, once.
 *
 * An alert that only had its paging paused already has a ticket, so that
 * ticket is paged now. An alert whose alerting was paused never got a ticket,
 * so it is closed quietly and fed through the pipeline again as new. Either
 * way it is one signal per alert still firing - a fleet of monitors that were
 * down for planned work and came back produces nothing at all.
 */
export async function reraiseAfterMaintenance(windowId: string): Promise<number> {
  const held = await db.all<AlertRow & { team_id: string | null; escalation_policy_id: string | null }>(
    `SELECT a.*, COALESCE(m.team_id, s.team_id) AS team_id, COALESCE(m.escalation_policy_id, s.escalation_policy_id) AS escalation_policy_id
     FROM alerts a
     LEFT JOIN monitors m ON m.id = a.source_id
     LEFT JOIN alert_sources s ON s.id = a.source_id
     WHERE a.maintenance_id = ? AND a.status <> 'resolved'`,
    [windowId],
  );
  let raised = 0;
  for (const alert of held) {
    // Another window may still cover it; then that window's end handles it.
    const still = await maintenanceFor({ sourceId: alert.source_id, teamId: alert.team_id });
    if (still) {
      await db.run(`UPDATE alerts SET maintenance_id = ? WHERE id = ?`, [still.windowId, alert.id]);
      continue;
    }
    if (alert.ticket_id) {
      await db.run(`UPDATE alerts SET maintenance_id = NULL, suppressed = 0 WHERE id = ?`, [alert.id]);
      const ticket = await db.get<{ status: string; team_id: string | null }>(`SELECT status, team_id FROM tickets WHERE id = ?`, [alert.ticket_id]);
      if (!ticket || TERMINAL_STATUSES.includes(ticket.status as (typeof TERMINAL_STATUSES)[number])) continue;
      const teamPolicy = ticket.team_id
        ? (await db.get<{ escalation_policy_id: string | null }>(`SELECT escalation_policy_id FROM teams WHERE id = ?`, [ticket.team_id]))?.escalation_policy_id
        : null;
      const policyId = alert.escalation_policy_id || teamPolicy;
      await addSystemComment(alert.ticket_id, `Maintenance has ended and "${alert.title}" is still firing.${policyId ? ' Paging now.' : ''}`);
      if (policyId && severityPages(alert.severity)) {
        await triggerPage(alert.ticket_id, {
          policyId,
          severity: alert.severity,
          reason: `"${alert.source_name}" was still alerting ("${alert.title}") when its maintenance window ended.`,
        });
      }
      raised += 1;
      continue;
    }
    await db.run(`UPDATE alerts SET status = 'resolved', resolved_at = ?, maintenance_id = NULL WHERE id = ?`, [new Date().toISOString(), alert.id]);
    await ingestSignal({
      sourceType: alert.source_type,
      sourceId: alert.source_id,
      sourceName: alert.source_name,
      dedupKey: alert.dedup_key,
      title: alert.title,
      summary: `${alert.summary}\n\nStill firing when its maintenance window ended.`.trim(),
      severity: alert.severity,
      status: 'firing',
      teamId: alert.team_id,
      escalationPolicyId: alert.escalation_policy_id,
      payload: parseJson<unknown>(alert.payload, undefined),
    });
    raised += 1;
  }
  return raised;
}
