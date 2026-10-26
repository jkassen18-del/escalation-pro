import { AsyncLocalStorage } from 'node:async_hooks';
import { db, parseJson, placeholders, toBool } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import { notifyUsers } from '../lib/notifications.ts';
import { can } from '../middleware/auth.ts';
import { getSettings } from '../repositories/settings.ts';
import { findTicket, recordEvent } from '../repositories/tickets.ts';
import { loadIntegration } from '../integrations/store.ts';
import { sendPlainEmail } from '../integrations/email.ts';
import { postToDepartmentSlack, postToDepartmentTeams } from '../integrations/channel-post.ts';
import { buildTicketUrl, dispatchAsync } from '../integrations/dispatcher.ts';
import {
  CONDITION_FIELDS,
  CONDITION_OPS,
  DEFAULT_CONFIGS,
  FLOW_EVENTS,
  FLOW_NODE_KINDS,
  NODE_LABELS,
  renderFlowTemplate,
  validateFlowGraph,
  type Flow,
  type FlowEdge,
  type FlowEvent,
  type FlowNode,
  type FlowNodeConfigs,
  type FlowRun,
  type FlowRunStep,
} from '../../shared/flows.ts';
import { TERMINAL_STATUSES, TICKET_PRIORITIES, TICKET_STATUSES, type PublicUser, type Ticket, type TicketStatus } from '../../shared/types.ts';
import { SEVERITIES, type Severity } from '../../shared/ops.ts';

/**
 * Flows: a department's own routes for alerts and escalation, drawn as nodes.
 *
 * A ticket event starts every enabled flow whose "When" node wants it, for
 * the ticket's department (or every department, for an organisation-wide
 * flow). Steps run in order along the arrows; a Wait parks the run, and the
 * ops runner picks it up when it is due. Whatever a flow does is done in a
 * flow context, so its own changes never start flows again.
 */

const flowContext = new AsyncLocalStorage<{ flowId: string }>();
export const insideFlow = () => flowContext.getStore() !== undefined;

const MAX_STEPS = 100;

/* --------------------------------- Storage -------------------------------- */

interface FlowRow {
  id: string;
  team_id: string | null;
  team_name?: string | null;
  name: string;
  description: string | null;
  enabled: number | string;
  graph: string;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export type FlowRecord = Omit<Flow, 'canEdit'>;

function toRecord(row: FlowRow): FlowRecord {
  const graph = parseJson<{ nodes: FlowNode[]; edges: FlowEdge[] }>(row.graph, { nodes: [], edges: [] });
  return {
    id: row.id,
    teamId: row.team_id,
    teamName: row.team_name ?? null,
    name: row.name,
    description: row.description,
    enabled: toBool(row.enabled),
    nodes: graph.nodes ?? [],
    edges: graph.edges ?? [],
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = `SELECT f.*, t.name AS team_name FROM flows f LEFT JOIN teams t ON t.id = f.team_id`;

export function canManageFlow(user: PublicUser, teamId: string | null): boolean {
  if (can(user, 'flows.manage')) return true;
  return Boolean(teamId && user.managedTeamIds.includes(teamId));
}

export function canSeeFlow(user: PublicUser, teamId: string | null): boolean {
  return canManageFlow(user, teamId) || !teamId || user.teamIds.includes(teamId);
}

export async function listFlows(): Promise<FlowRecord[]> {
  return (await db.all<FlowRow>(`${SELECT} ORDER BY f.name`)).map(toRecord);
}

export async function findFlow(id: string): Promise<FlowRecord | null> {
  const row = await db.get<FlowRow>(`${SELECT} WHERE f.id = ?`, [id]);
  return row ? toRecord(row) : null;
}

const clampText = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');

/** Keeps only what each kind of node understands, with its defaults filled in. */
function cleanConfig(kind: FlowNode['kind'], raw: Record<string, unknown>): FlowNode['config'] {
  const base = { ...(DEFAULT_CONFIGS[kind] as object), ...raw } as Record<string, unknown>;
  switch (kind) {
    case 'trigger':
      return { events: (Array.isArray(base.events) ? base.events : []).filter((event): event is FlowEvent => FLOW_EVENTS.includes(event as FlowEvent)) };
    case 'condition':
      return {
        field: CONDITION_FIELDS.includes(base.field as never) ? (base.field as FlowNodeConfigs['condition']['field']) : 'priority',
        op: CONDITION_OPS.includes(base.op as never) ? (base.op as FlowNodeConfigs['condition']['op']) : 'is',
        value: clampText(base.value, 500),
      };
    case 'wait':
      return { minutes: Math.min(7 * 24 * 60, Math.max(1, Math.round(Number(base.minutes) || 15))), onlyIfOpen: base.onlyIfOpen !== false };
    case 'notify':
      return {
        to: (Array.isArray(base.to) ? base.to : []).filter((to) => ['people', 'assignee', 'requester', 'department_managers', 'shift_leader', 'oncall'].includes(to as string)) as FlowNodeConfigs['notify']['to'],
        userIds: (Array.isArray(base.userIds) ? base.userIds : []).filter((id): id is string => typeof id === 'string').slice(0, 30),
        message: clampText(base.message, 2000),
        email: base.email === true,
      };
    case 'page':
      return { policyId: typeof base.policyId === 'string' && base.policyId ? base.policyId : null, severity: SEVERITIES.includes(base.severity as Severity) ? (base.severity as Severity) : 'sev2' };
    case 'slack':
    case 'teams':
      return { message: clampText(base.message, 3000) };
    case 'api_call':
      return {
        connectionId: clampText(base.connectionId, 60),
        method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(base.method as string) ? (base.method as FlowNodeConfigs['api_call']['method']) : 'POST',
        path: clampText(base.path, 1000),
        body: clampText(base.body, 20_000),
      };
    case 'email':
      return { to: clampText(base.to, 1000), subject: clampText(base.subject, 300), body: clampText(base.body, 10_000) };
    case 'update': {
      const out: FlowNodeConfigs['update'] = {};
      if (TICKET_PRIORITIES.includes(base.priority as never)) out.priority = base.priority as string;
      if (TICKET_STATUSES.includes(base.status as never)) out.status = base.status as string;
      if (typeof base.assigneeId === 'string' && base.assigneeId) out.assigneeId = base.assigneeId;
      if (Array.isArray(base.addTags)) out.addTags = base.addTags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '').map((tag) => tag.trim().toLowerCase().slice(0, 40)).slice(0, 10);
      return out;
    }
    case 'approval':
      return {
        title: clampText(base.title, 160) || 'Sign-off',
        approvers: Array.isArray(base.approvers) ? (base.approvers as FlowNodeConfigs['approval']['approvers']).slice(0, 10) : [],
        mode: base.mode === 'all' ? 'all' : 'any',
      };
    case 'escalate':
      return { teamId: clampText(base.teamId, 60), reason: clampText(base.reason, 1000) || 'Escalated by a flow' };
  }
}

export function validateFlow(body: Record<string, unknown>): Omit<FlowRecord, 'id' | 'teamName' | 'lastRunAt' | 'createdAt' | 'updatedAt'> {
  const name = clampText(body.name, 120).trim();
  if (!name) throw badRequest('Give the flow a name.');
  const rawNodes = Array.isArray(body.nodes) ? (body.nodes as Array<Record<string, unknown>>) : [];
  const nodes: FlowNode[] = rawNodes.slice(0, 80).map((node) => {
    const kind = node.kind as FlowNode['kind'];
    if (!FLOW_NODE_KINDS.includes(kind)) throw badRequest('One of the steps is not something a flow can do.');
    const position = (node.position ?? {}) as { x?: number; y?: number };
    return {
      id: clampText(node.id, 60) || randomId(),
      kind,
      position: { x: Math.round(Number(position.x) || 0), y: Math.round(Number(position.y) || 0) },
      config: cleanConfig(kind, (node.config ?? {}) as Record<string, unknown>),
    };
  });
  const edges: FlowEdge[] = (Array.isArray(body.edges) ? (body.edges as Array<Record<string, unknown>>) : []).slice(0, 200).map((edge) => ({
    id: clampText(edge.id, 80) || randomId(),
    source: clampText(edge.source, 60),
    sourceHandle: clampText(edge.sourceHandle, 20) || 'out',
    target: clampText(edge.target, 60),
  }));
  const enabled = body.enabled !== false;
  const check = validateFlowGraph(nodes, edges);
  // A draft may be saved half-built; only a flow that is switched on has to be complete.
  if (enabled && !check.ok) throw badRequest(check.errors.join(' '));
  return {
    teamId: typeof body.teamId === 'string' && body.teamId ? body.teamId : null,
    name,
    description: clampText(body.description, 500) || null,
    enabled,
    nodes,
    edges,
  };
}

export async function saveFlow(id: string | null, input: ReturnType<typeof validateFlow>, user: PublicUser): Promise<FlowRecord> {
  const now = new Date().toISOString();
  const graph = JSON.stringify({ nodes: input.nodes, edges: input.edges });
  if (id) {
    await db.run(`UPDATE flows SET team_id = ?, name = ?, description = ?, enabled = ?, graph = ?, updated_at = ? WHERE id = ?`, [input.teamId, input.name, input.description, input.enabled ? 1 : 0, graph, now, id]);
    return (await findFlow(id))!;
  }
  const flowId = randomId();
  await db.run(`INSERT INTO flows (id, team_id, name, description, enabled, graph, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    flowId,
    input.teamId,
    input.name,
    input.description,
    input.enabled ? 1 : 0,
    graph,
    user.id || null,
    now,
    now,
  ]);
  return (await findFlow(flowId))!;
}

export async function deleteFlow(id: string): Promise<void> {
  await db.run(`DELETE FROM flows WHERE id = ?`, [id]);
}

/* ---------------------------------- Runs ---------------------------------- */

interface RunRow {
  id: string;
  flow_id: string;
  ticket_id: string | null;
  event: string;
  status: FlowRun['status'];
  pending: string;
  steps: string;
  next_at: string | null;
  created_at: string;
  actor_name: string | null;
}

interface Pending {
  nodeId: string;
  at: string;
}

export async function listRuns(flowId: string, limit = 30): Promise<FlowRun[]> {
  const settings = await getSettings();
  const rows = await db.all<RunRow & { number: number | string | null }>(
    `SELECT r.*, t.number FROM flow_runs r LEFT JOIN tickets t ON t.id = r.ticket_id WHERE r.flow_id = ? ORDER BY r.created_at DESC LIMIT ?`,
    [flowId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    flowId: row.flow_id,
    ticketId: row.ticket_id,
    ticketReference: row.number !== null && row.number !== undefined ? `${settings.ticketPrefix}-${row.number}` : null,
    event: row.event,
    status: row.status,
    steps: parseJson<FlowRunStep[]>(row.steps, []),
    nextAt: row.next_at,
    createdAt: row.created_at,
  }));
}

/** Starts every flow that wants this event for this ticket. Called by the dispatcher. */
export async function runFlowsForEvent(event: string, ticket: Ticket, actorName: string): Promise<number> {
  if (insideFlow() || !(FLOW_EVENTS as readonly string[]).includes(event)) return 0;
  const flows = (await listFlows()).filter(
    (flow) =>
      flow.enabled &&
      (!flow.teamId || flow.teamId === ticket.teamId) &&
      flow.nodes.some((node) => node.kind === 'trigger' && (node.config as FlowNodeConfigs['trigger']).events.includes(event as FlowEvent)),
  );
  for (const flow of flows) await startRun(flow, ticket, event, actorName).catch((error) => console.error(`[flows] ${flow.name}`, error));
  return flows.length;
}

export async function startRun(flow: FlowRecord, ticket: Ticket, event: string, actorName: string): Promise<FlowRun['id']> {
  const id = randomId();
  const now = new Date().toISOString();
  await db.run(`INSERT INTO flow_runs (id, flow_id, ticket_id, event, status, pending, steps, actor_name, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', '[]', '[]', ?, ?, ?)`, [
    id,
    flow.id,
    ticket.id,
    event,
    actorName,
    now,
    now,
  ]);
  await db.run(`UPDATE flows SET last_run_at = ? WHERE id = ?`, [now, flow.id]);
  const trigger = flow.nodes.find((node) => node.kind === 'trigger');
  await advance(flow, id, trigger ? nextOf(flow, trigger.id, 'out') : [], [], []);
  return id;
}

const nextOf = (flow: FlowRecord, nodeId: string, port: string) => flow.edges.filter((edge) => edge.source === nodeId && edge.sourceHandle === port).map((edge) => edge.target);

/** Runs steps from `queue` until the flow ends or every branch is waiting. */
async function advance(flow: FlowRecord, runId: string, queue: string[], pending: Pending[], steps: FlowRunStep[]): Promise<void> {
  const run = (await db.get<RunRow>(`SELECT * FROM flow_runs WHERE id = ?`, [runId]))!;
  const settings = await getSettings();
  let failed = false;
  await flowContext.run({ flowId: flow.id }, async () => {
    while (queue.length) {
      if (steps.length >= MAX_STEPS) {
        steps.push({ nodeId: '', at: new Date().toISOString(), ok: false, message: `Stopped after ${MAX_STEPS} steps: the arrows probably loop.` });
        failed = true;
        queue.length = 0;
        break;
      }
      const nodeId = queue.shift()!;
      const node = flow.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) continue;
      const ticket = run.ticket_id ? await findTicket(run.ticket_id, settings.ticketPrefix) : null;
      if (!ticket) {
        steps.push({ nodeId, at: new Date().toISOString(), ok: false, message: 'The ticket no longer exists.' });
        failed = true;
        break;
      }
      if (node.kind === 'wait') {
        const config = node.config as FlowNodeConfigs['wait'];
        pending.push({ nodeId, at: new Date(Date.now() + config.minutes * 60_000).toISOString() });
        steps.push({ nodeId, at: new Date().toISOString(), ok: true, message: `Waiting ${config.minutes} min` });
        continue;
      }
      let result: { ok: boolean; message: string; port: string };
      try {
        result = await runNode(node, ticket, run);
      } catch (error) {
        result = { ok: false, message: (error as Error).message, port: node.kind === 'api_call' ? 'failed' : 'out' };
      }
      steps.push({ nodeId, at: new Date().toISOString(), ok: result.ok, message: result.message.slice(0, 500) });
      // A failed action does not stop the flow: what comes after it may be the fallback.
      queue.push(...nextOf(flow, nodeId, result.port));
    }
  });
  const nextAt = pending.length ? pending.map((entry) => entry.at).sort()[0] : null;
  const status: FlowRun['status'] = failed ? 'failed' : pending.length ? 'waiting' : 'done';
  await db.run(`UPDATE flow_runs SET status = ?, pending = ?, steps = ?, next_at = ?, updated_at = ? WHERE id = ?`, [
    status,
    JSON.stringify(pending),
    JSON.stringify(steps.slice(-200)),
    nextAt,
    new Date().toISOString(),
    runId,
  ]);
}

/** Called by the ops runner: waits that have run their time. */
export async function resumeDueRuns(now = Date.now()): Promise<number> {
  const due = await db.all<RunRow>(`SELECT * FROM flow_runs WHERE status = 'waiting' AND next_at <= ? ORDER BY next_at LIMIT 50`, [new Date(now).toISOString()]);
  const settings = await getSettings();
  let resumed = 0;
  for (const run of due) {
    const flow = await findFlow(run.flow_id);
    const pending = parseJson<Pending[]>(run.pending, []);
    const steps = parseJson<FlowRunStep[]>(run.steps, []);
    if (!flow || !flow.enabled) {
      steps.push({ nodeId: '', at: new Date().toISOString(), ok: false, message: 'The flow was turned off or removed while waiting.' });
      await db.run(`UPDATE flow_runs SET status = 'done', pending = '[]', steps = ?, next_at = NULL WHERE id = ?`, [JSON.stringify(steps), run.id]);
      continue;
    }
    const ready = pending.filter((entry) => Date.parse(entry.at) <= now);
    const later = pending.filter((entry) => Date.parse(entry.at) > now);
    const queue: string[] = [];
    const ticket = run.ticket_id ? await findTicket(run.ticket_id, settings.ticketPrefix) : null;
    for (const entry of ready) {
      const node = flow.nodes.find((candidate) => candidate.id === entry.nodeId);
      if (!node) continue;
      if ((node.config as FlowNodeConfigs['wait']).onlyIfOpen !== false && ticket && TERMINAL_STATUSES.includes(ticket.status)) {
        steps.push({ nodeId: node.id, at: new Date().toISOString(), ok: true, message: `Stopped: ${ticket.reference} was ${ticket.status} by then` });
        continue;
      }
      queue.push(...nextOf(flow, node.id, 'out'));
    }
    // Claimed first, so two runners cannot both resume it.
    await db.run(`UPDATE flow_runs SET status = 'running', next_at = NULL WHERE id = ? AND status = 'waiting'`, [run.id]);
    await advance(flow, run.id, queue, later, steps);
    resumed += 1;
  }
  return resumed;
}

/* --------------------------------- Steps --------------------------------- */

async function templateValues(ticket: Ticket, run: Pick<RunRow, 'event' | 'actor_name'>): Promise<Record<string, string>> {
  return {
    'ticket.reference': ticket.reference,
    'ticket.subject': ticket.subject,
    'ticket.priority': ticket.priority,
    'ticket.status': ticket.status.replace('_', ' '),
    'ticket.type': ticket.type,
    'ticket.department': ticket.teamName ?? '',
    'ticket.assignee': ticket.assigneeName ?? 'unassigned',
    'ticket.requester': ticket.requesterName ?? '',
    'ticket.url': await buildTicketUrl(ticket),
    event: run.event,
    actor: run.actor_name ?? '',
  };
}

async function departmentHour(teamId: string | null): Promise<number> {
  const { getDepartmentSchedule } = await import('./shifts.ts');
  const timeZone = teamId ? (await getDepartmentSchedule(teamId)).timeZone : 'Africa/Johannesburg';
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
}

export async function evaluateCondition(config: FlowNodeConfigs['condition'], ticket: Ticket): Promise<boolean> {
  const wanted = config.value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const compare = (actual: string | null) => {
    const value = (actual ?? '').toLowerCase();
    switch (config.op) {
      case 'is':
        return value === (wanted[0] ?? '');
      case 'is_not':
        return value !== (wanted[0] ?? '');
      case 'any_of':
        return wanted.includes(value);
      case 'contains':
        return wanted.some((needle) => value.includes(needle));
      case 'gte':
        return Number(value) >= Number(wanted[0]);
      case 'lte':
        return Number(value) <= Number(wanted[0]);
    }
  };
  switch (config.field) {
    case 'tags': {
      const tags = ticket.tags.map((tag) => tag.toLowerCase());
      const hit = wanted.some((tag) => tags.includes(tag));
      return config.op === 'is_not' ? !hit : hit;
    }
    case 'assigned':
      return (wanted[0] === 'no') !== Boolean(ticket.assigneeId);
    case 'in_shift': {
      const { getDepartmentSchedule } = await import('./shifts.ts');
      const { shiftStatus } = await import('../../shared/shifts.ts');
      if (!ticket.teamId) return wanted[0] === 'no';
      const schedule = await getDepartmentSchedule(ticket.teamId);
      const inShift = Boolean(shiftStatus(schedule.patterns, schedule.exceptions, schedule.timeZone, Date.now()).current);
      return (wanted[0] === 'no') !== inShift;
    }
    case 'hour':
      return compare(String(await departmentHour(ticket.teamId)));
    case 'department':
      return compare(ticket.teamId) || compare(ticket.teamName);
    case 'subject':
      return compare(ticket.subject);
    default:
      return compare(String((ticket as unknown as Record<string, unknown>)[config.field] ?? ''));
  }
}

async function recipients(config: FlowNodeConfigs['notify'], ticket: Ticket): Promise<string[]> {
  const ids = new Set<string>(config.to.includes('people') ? config.userIds : []);
  if (config.to.includes('assignee') && ticket.assigneeId) ids.add(ticket.assigneeId);
  if (config.to.includes('requester') && ticket.requesterId) ids.add(ticket.requesterId);
  const { resolveApprovers } = await import('../services/approvals.ts');
  if (config.to.includes('department_managers')) for (const id of await resolveApprovers([{ kind: 'department_managers' }], ticket.teamId)) ids.add(id);
  if (config.to.includes('shift_leader')) for (const id of await resolveApprovers([{ kind: 'shift_leader' }], ticket.teamId)) ids.add(id);
  if (config.to.includes('oncall')) {
    const { onCallContactsForTeam } = await import('../services/oncall-notify.ts');
    for (const contact of await onCallContactsForTeam(ticket.teamId)) ids.add(contact.userId);
  }
  return [...ids];
}

async function runNode(node: FlowNode, ticket: Ticket, run: RunRow): Promise<{ ok: boolean; message: string; port: string }> {
  const values = await templateValues(ticket, run);
  const fill = (template: string, json = false) => renderFlowTemplate(template, values, json);
  const done = (message: string, ok = true) => ({ ok, message, port: 'out' });

  switch (node.kind) {
    case 'condition': {
      const yes = await evaluateCondition(node.config as FlowNodeConfigs['condition'], ticket);
      return { ok: true, message: yes ? 'Yes' : 'No', port: yes ? 'yes' : 'no' };
    }
    case 'notify': {
      const config = node.config as FlowNodeConfigs['notify'];
      const people = await recipients(config, ticket);
      if (!people.length) return done('Nobody to tell', false);
      const message = fill(config.message || '{{ticket.reference}}: {{ticket.subject}}');
      await notifyUsers(people, { ticketId: ticket.id, type: 'flow', title: message.slice(0, 200), body: ticket.subject });
      if (config.email) {
        const email = await loadIntegration('email');
        const rows = await db.all<{ email: string | null }>(`SELECT email FROM users WHERE id IN (${placeholders(people.length)})`, people);
        for (const row of rows) if (row.email) await sendPlainEmail(email, row.email, { subject: message.slice(0, 200), text: `${message}\n\n${values['ticket.url']}` });
      }
      const names = await db.all<{ name: string }>(`SELECT name FROM users WHERE id IN (${placeholders(people.length)})`, people);
      return done(`Told ${names.map((row) => row.name).join(', ')}`);
    }
    case 'page': {
      const config = node.config as FlowNodeConfigs['page'];
      const policyId =
        config.policyId ??
        (ticket.teamId ? ((await db.get<{ escalation_policy_id: string | null }>(`SELECT escalation_policy_id FROM teams WHERE id = ?`, [ticket.teamId]))?.escalation_policy_id ?? null) : null);
      if (!policyId) return done('No escalation policy: choose one, or give the department a default', false);
      const { triggerPage } = await import('./pager.ts');
      const pageId = await triggerPage(ticket.id, { policyId, severity: config.severity, reason: `Flow: ${run.flow_id}` });
      return done(pageId ? 'Paging on-call' : 'Already paging');
    }
    case 'slack': {
      const text = fill((node.config as FlowNodeConfigs['slack']).message);
      const result = await postToDepartmentSlack(ticket.teamId, { text });
      return done(result.ok ? 'Posted to Slack' : (result.error ?? 'Slack refused it'), result.ok);
    }
    case 'teams': {
      const text = fill((node.config as FlowNodeConfigs['teams']).message);
      const result = await postToDepartmentTeams(ticket.teamId, {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [{ type: 'TextBlock', text, wrap: true }],
        actions: [{ type: 'Action.OpenUrl', title: 'Open ticket', url: values['ticket.url'] }],
      });
      return done(result.ok ? 'Posted to Teams' : (result.error ?? 'Teams refused it'), result.ok);
    }
    case 'api_call': {
      const config = node.config as FlowNodeConfigs['api_call'];
      const { callThrough, findConnection } = await import('./connections.ts');
      const connection = await findConnection(config.connectionId);
      if (!connection || !connection.enabled) return { ok: false, message: 'The API connection was removed or turned off', port: 'failed' };
      // The flow's department may only use its own connections, or shared ones.
      if (connection.teamId && connection.teamId !== ticket.teamId && connection.teamId !== (await findFlow(run.flow_id))?.teamId) {
        return { ok: false, message: `${connection.name} belongs to another department`, port: 'failed' };
      }
      const withBody = config.method !== 'GET' && config.method !== 'DELETE';
      const result = await callThrough(connection, { method: config.method, path: fill(config.path), body: withBody ? fill(config.body, true) : undefined, bodyType: withBody ? 'json' : undefined });
      const ok = result.status !== null && result.status < 400;
      return { ok, message: result.status ? `HTTP ${result.status} from ${connection.name}` : result.message, port: ok ? 'ok' : 'failed' };
    }
    case 'email': {
      const config = node.config as FlowNodeConfigs['email'];
      const email = await loadIntegration('email');
      const to = fill(config.to)
        .split(/[,;\s]+/)
        .filter((address) => /^[^@\s]+@[^@\s]+$/.test(address));
      if (!to.length) return done('No address to send to', false);
      const failures: string[] = [];
      for (const address of to.slice(0, 20)) {
        const result = await sendPlainEmail(email, address, { subject: fill(config.subject), text: fill(config.body) });
        if (!result.ok) failures.push(`${address}: ${result.error}`);
      }
      return done(failures.length ? failures.join('; ') : `Emailed ${to.join(', ')}`, failures.length === 0);
    }
    case 'update': {
      const config = node.config as FlowNodeConfigs['update'];
      const changes: string[] = [];
      const now = new Date().toISOString();
      if (config.priority && config.priority !== ticket.priority) {
        await db.run(`UPDATE tickets SET priority = ?, updated_at = ? WHERE id = ?`, [config.priority, now, ticket.id]);
        await recordEvent(ticket.id, null, 'updated', 'priority', ticket.priority, config.priority);
        changes.push(`priority ${config.priority}`);
      }
      if (config.assigneeId && config.assigneeId !== ticket.assigneeId) {
        const person = await db.get<{ name: string }>(`SELECT name FROM users WHERE id = ? AND status = 'active'`, [config.assigneeId]);
        if (person) {
          await db.run(`UPDATE tickets SET assignee_id = ?, updated_at = ? WHERE id = ?`, [config.assigneeId, now, ticket.id]);
          await recordEvent(ticket.id, null, 'assigned', 'assignee', ticket.assigneeId, config.assigneeId);
          await notifyUsers([config.assigneeId], { ticketId: ticket.id, type: 'assigned', title: `${ticket.reference} assigned to you`, body: ticket.subject });
          changes.push(`assigned to ${person.name}`);
        }
      }
      if (config.addTags?.length) {
        const tags = [...new Set([...ticket.tags, ...config.addTags])];
        if (tags.length !== ticket.tags.length) {
          await db.run(`UPDATE tickets SET tags = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(tags), now, ticket.id]);
          changes.push(`labelled ${config.addTags.join(', ')}`);
        }
      }
      if (config.status && config.status !== ticket.status) {
        const { applyStatus } = await import('../integrations/slack-actions.ts');
        const change = await applyStatus(ticket.id, config.status as TicketStatus, null);
        if (change?.blocked) return done(`Status left alone: ${change.blocked}`, false);
        if (change?.changed) changes.push(`status ${config.status.replace('_', ' ')}`);
      }
      if (changes.length) {
        const settings = await getSettings();
        const after = (await findTicket(ticket.id, settings.ticketPrefix))!;
        dispatchAsync({ event: 'ticketStatusChanged', ticket: after, actorName: 'Flow', headline: `${ticket.reference} updated by a flow: ${changes.join(', ')}`, ticketUrl: values['ticket.url'] });
      }
      return done(changes.length ? `Set ${changes.join(', ')}` : 'Nothing to change');
    }
    case 'approval': {
      const config = node.config as FlowNodeConfigs['approval'];
      const { requestApproval, resolveApprovers } = await import('../services/approvals.ts');
      const approverIds = await resolveApprovers(config.approvers, ticket.teamId);
      if (!approverIds.length) return done('Nobody could be found to approve it', false);
      await requestApproval(ticket, { title: config.title, approverIds, mode: config.mode, onReject: 'close' }, null);
      return done(`Asked ${approverIds.length} approver${approverIds.length === 1 ? '' : 's'}`);
    }
    case 'escalate': {
      const config = node.config as FlowNodeConfigs['escalate'];
      if (config.teamId === ticket.teamId) return done('Already with that department');
      const { escalateTicketToTeam, SYSTEM_ACTOR } = await import('../services/tickets.ts');
      const after = await escalateTicketToTeam(ticket, { targetTeamId: config.teamId, reason: fill(config.reason), actor: { ...SYSTEM_ACTOR, name: 'Flow' } });
      return done(`Escalated to ${after.teamName}`);
    }
    default:
      return done(`${NODE_LABELS[node.kind]}: nothing to do`);
  }
}
