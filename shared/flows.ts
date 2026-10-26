import type { ApproverSpec } from './approvals.ts';
import type { Severity } from './ops.ts';

/**
 * Flows: alert and escalation routes drawn as connected nodes. A trigger
 * (something happened to a ticket) leads through conditions, waits and
 * actions - tell people, page on-call, post to a channel, call an API, ask
 * for approval, change the ticket - in whatever order the department wants.
 */

export const FLOW_EVENTS = ['ticketCreated', 'ticketAssigned', 'ticketStatusChanged', 'ticketEscalated', 'ticketCommented', 'slaBreached'] as const;
export type FlowEvent = (typeof FLOW_EVENTS)[number];

export const FLOW_EVENT_LABELS: Record<FlowEvent, string> = {
  ticketCreated: 'A ticket is raised',
  ticketAssigned: 'A ticket is assigned',
  ticketStatusChanged: 'A ticket changes status',
  ticketEscalated: 'A ticket is escalated',
  ticketCommented: 'Someone comments',
  slaBreached: 'A ticket breaches its SLA',
};

export const CONDITION_FIELDS = ['priority', 'type', 'status', 'source', 'tags', 'subject', 'severity', 'assigned', 'department', 'in_shift', 'hour'] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

export const CONDITION_FIELD_LABELS: Record<ConditionField, string> = {
  priority: 'Priority',
  type: 'Type',
  status: 'Status',
  source: 'Raised from',
  tags: 'Labels',
  subject: 'Subject',
  severity: 'Severity',
  assigned: 'Has an assignee',
  department: 'Department',
  in_shift: 'Department is on shift',
  hour: 'Hour of day (department time)',
};

export const CONDITION_OPS = ['is', 'is_not', 'any_of', 'contains', 'gte', 'lte'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export type NotifyTarget = 'people' | 'assignee' | 'requester' | 'department_managers' | 'shift_leader' | 'oncall';

export interface FlowNodeConfigs {
  trigger: { events: FlowEvent[] };
  condition: { field: ConditionField; op: ConditionOp; value: string };
  wait: { minutes: number; /** Stop here if the ticket was resolved or closed meanwhile. */ onlyIfOpen: boolean };
  notify: { to: NotifyTarget[]; userIds: string[]; message: string; email: boolean };
  page: { policyId: string | null; severity: Severity };
  slack: { message: string };
  teams: { message: string };
  api_call: { connectionId: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; body: string };
  email: { to: string; subject: string; body: string };
  update: { priority?: string; status?: string; assigneeId?: string; addTags?: string[] };
  approval: { title: string; approvers: ApproverSpec[]; mode: 'any' | 'all' };
  escalate: { teamId: string; reason: string };
}

export type FlowNodeKind = keyof FlowNodeConfigs;

export const FLOW_NODE_KINDS = Object.keys({
  trigger: 1,
  condition: 1,
  wait: 1,
  notify: 1,
  page: 1,
  slack: 1,
  teams: 1,
  api_call: 1,
  email: 1,
  update: 1,
  approval: 1,
  escalate: 1,
} satisfies Record<FlowNodeKind, 1>) as FlowNodeKind[];

/** Where a node's arrows can leave from. */
export const NODE_PORTS: Record<FlowNodeKind, string[]> = {
  trigger: ['out'],
  condition: ['yes', 'no'],
  wait: ['out'],
  notify: ['out'],
  page: ['out'],
  slack: ['out'],
  teams: ['out'],
  api_call: ['ok', 'failed'],
  email: ['out'],
  update: ['out'],
  approval: ['out'],
  escalate: ['out'],
};

export const NODE_LABELS: Record<FlowNodeKind, string> = {
  trigger: 'When',
  condition: 'If',
  wait: 'Wait',
  notify: 'Tell people',
  page: 'Page on-call',
  slack: 'Post to Slack',
  teams: 'Post to Teams',
  api_call: 'Call an API',
  email: 'Send an email',
  update: 'Change the ticket',
  approval: 'Ask for approval',
  escalate: 'Escalate to department',
};

export interface FlowNode<K extends FlowNodeKind = FlowNodeKind> {
  id: string;
  kind: K;
  position: { x: number; y: number };
  config: FlowNodeConfigs[K];
}

export interface FlowEdge {
  id: string;
  source: string;
  /** The port on the source node: out, yes/no, ok/failed. */
  sourceHandle: string;
  target: string;
}

export interface Flow {
  id: string;
  /** Null: runs for every department's tickets. */
  teamId: string | null;
  teamName: string | null;
  name: string;
  description: string | null;
  enabled: boolean;
  nodes: FlowNode[];
  edges: FlowEdge[];
  canEdit: boolean;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FlowRunStep {
  nodeId: string;
  at: string;
  ok: boolean;
  message: string;
}

export interface FlowRun {
  id: string;
  flowId: string;
  ticketId: string | null;
  ticketReference: string | null;
  event: string;
  status: 'running' | 'waiting' | 'done' | 'failed';
  steps: FlowRunStep[];
  nextAt: string | null;
  createdAt: string;
}

export const DEFAULT_CONFIGS: FlowNodeConfigs = {
  trigger: { events: ['ticketCreated'] },
  condition: { field: 'priority', op: 'any_of', value: 'urgent,high' },
  wait: { minutes: 15, onlyIfOpen: true },
  notify: { to: ['assignee'], userIds: [], message: '{{ticket.reference}}: {{ticket.subject}}', email: false },
  page: { policyId: null, severity: 'sev2' },
  slack: { message: ':rotating_light: {{ticket.reference}} {{ticket.subject}} ({{ticket.priority}}) {{ticket.url}}' },
  teams: { message: '{{ticket.reference}} {{ticket.subject}} ({{ticket.priority}})' },
  api_call: { connectionId: '', method: 'POST', path: '/', body: '{"ticket": "{{ticket.reference}}", "subject": "{{ticket.subject}}"}' },
  email: { to: '', subject: '{{ticket.reference}}: {{ticket.subject}}', body: '{{ticket.subject}}\n\n{{ticket.url}}' },
  update: {},
  approval: { title: 'Sign-off', approvers: [{ kind: 'department_managers' }], mode: 'any' },
  escalate: { teamId: '', reason: 'Escalated by a flow' },
};

/** The values a message can use: {{ticket.reference}}, {{ticket.url}} and the rest. */
export const TEMPLATE_VARIABLES = ['ticket.reference', 'ticket.subject', 'ticket.priority', 'ticket.status', 'ticket.type', 'ticket.department', 'ticket.assignee', 'ticket.requester', 'ticket.url', 'event', 'actor'] as const;

export function renderFlowTemplate(template: string, values: Record<string, string>, escapeJson = false): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => {
    if (!(key in values)) return match;
    const value = values[key] ?? '';
    return escapeJson ? JSON.stringify(value).slice(1, -1) : value;
  });
}

export interface FlowValidation {
  ok: boolean;
  errors: string[];
}

/** Structural checks: one trigger, real nodes on each arrow, ports that exist. */
export function validateFlowGraph(nodes: FlowNode[], edges: FlowEdge[]): FlowValidation {
  const errors: string[] = [];
  const triggers = nodes.filter((node) => node.kind === 'trigger');
  if (triggers.length !== 1) errors.push('A flow starts from exactly one "When" node.');
  if (nodes.length > 60) errors.push('A flow can have up to 60 steps.');
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) {
      errors.push('An arrow points at a step that no longer exists.');
      continue;
    }
    if (!NODE_PORTS[source.kind].includes(edge.sourceHandle)) errors.push(`"${NODE_LABELS[source.kind]}" has no "${edge.sourceHandle}" exit.`);
    if (target.kind === 'trigger') errors.push('Nothing can lead back into the "When" node.');
  }
  for (const node of nodes) {
    if (node.kind === 'trigger' && !(node.config as FlowNodeConfigs['trigger']).events?.length) errors.push('Choose what starts the flow.');
    if (node.kind === 'api_call' && !(node.config as FlowNodeConfigs['api_call']).connectionId) errors.push('"Call an API" needs a connection.');
    if (node.kind === 'escalate' && !(node.config as FlowNodeConfigs['escalate']).teamId) errors.push('"Escalate to department" needs a department.');
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}
