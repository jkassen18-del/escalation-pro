import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Connection as FlowConnection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowLeft,
  ArrowUpRight,
  BadgeCheck,
  Bell,
  GitBranch,
  Mail,
  MessageSquare,
  MessagesSquare,
  PenLine,
  Play,
  Plus,
  Save,
  Siren,
  Timer,
  Trash2,
  Webhook,
  Workflow,
  Zap,
} from 'lucide-react';
import { api, ApiError, type FlowInput } from '@/lib/api';
import { opsApi } from '@/lib/ops-api';
import { PRIORITY_LABELS, relativeTime, shortDateTime, STATUS_LABELS } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/state/auth';
import { useDocumentTitle } from '@/state/branding';
import { useDepartment } from '@/state/department';
import { useTheme } from '@/state/theme';
import {
  CONDITION_FIELD_LABELS,
  CONDITION_FIELDS,
  DEFAULT_CONFIGS,
  FLOW_EVENT_LABELS,
  FLOW_EVENTS,
  NODE_LABELS,
  NODE_PORTS,
  TEMPLATE_VARIABLES,
  validateFlowGraph,
  type ConditionOp,
  type Flow,
  type FlowEdge,
  type FlowNode,
  type FlowNodeConfigs,
  type FlowNodeKind,
  type FlowRun,
  type NotifyTarget,
} from '@shared/flows';
import { SEVERITIES, SEVERITY_LABELS, type EscalationPolicy } from '@shared/ops';
import { TICKET_PRIORITIES, TICKET_STATUSES } from '@shared/types';

type Directory = Awaited<ReturnType<typeof api.users.directory>>['users'];
type StepData = { kind: FlowNodeKind; config: FlowNode['config']; invalid?: boolean };
type StepNode = Node<StepData, 'step'>;

const ICONS: Record<FlowNodeKind, React.ComponentType<{ className?: string }>> = {
  trigger: Zap,
  condition: GitBranch,
  wait: Timer,
  notify: Bell,
  page: Siren,
  slack: MessageSquare,
  teams: MessagesSquare,
  api_call: Webhook,
  email: Mail,
  update: PenLine,
  approval: BadgeCheck,
  escalate: ArrowUpRight,
};

const ACCENTS: Record<FlowNodeKind, string> = {
  trigger: 'var(--accent)',
  condition: 'var(--status-pending)',
  wait: 'var(--fg-subtle)',
  notify: 'var(--status-progress)',
  page: 'var(--priority-urgent)',
  slack: 'var(--type-question)',
  teams: 'var(--type-request)',
  api_call: 'var(--type-problem)',
  email: 'var(--status-progress)',
  update: 'var(--status-open)',
  approval: 'var(--status-resolved)',
  escalate: 'var(--priority-high)',
};

const PORT_LABELS: Record<string, string> = { yes: 'Yes', no: 'No', ok: 'Worked', failed: 'Failed', out: '' };
const OP_LABELS: Record<ConditionOp, string> = { is: 'is', is_not: 'is not', any_of: 'is one of', contains: 'contains', gte: 'is at least', lte: 'is at most' };
const NOTIFY_LABELS: Record<NotifyTarget, string> = {
  assignee: 'The assignee',
  requester: 'The requester',
  department_managers: 'Department managers',
  shift_leader: 'Shift leader on duty',
  oncall: 'Whoever is on call',
  people: 'Chosen people',
};

let counter = 0;
const newId = (kind: string) => `${kind}-${Date.now().toString(36)}-${(counter += 1)}`;

/** A one-line description of what a step will do, shown on the canvas. */
function summarise(kind: FlowNodeKind, config: FlowNode['config'], lookups: { team: (id: string) => string; connection: (id: string) => string }): string {
  switch (kind) {
    case 'trigger': {
      const events = (config as FlowNodeConfigs['trigger']).events;
      return events.length ? events.map((event) => FLOW_EVENT_LABELS[event]).join(' or ') : 'Choose what starts it';
    }
    case 'condition': {
      const c = config as FlowNodeConfigs['condition'];
      return `${CONDITION_FIELD_LABELS[c.field]} ${OP_LABELS[c.op]} ${c.value || '…'}`;
    }
    case 'wait': {
      const c = config as FlowNodeConfigs['wait'];
      return `${c.minutes >= 60 && c.minutes % 60 === 0 ? `${c.minutes / 60} h` : `${c.minutes} min`}${c.onlyIfOpen ? ', then only if still open' : ''}`;
    }
    case 'notify': {
      const c = config as FlowNodeConfigs['notify'];
      return c.to.length ? c.to.map((to) => NOTIFY_LABELS[to]).join(', ') + (c.email ? ' (+ email)' : '') : 'Choose who';
    }
    case 'page':
      return `${SEVERITY_LABELS[(config as FlowNodeConfigs['page']).severity]} · ${(config as FlowNodeConfigs['page']).policyId ? 'chosen policy' : "department's policy"}`;
    case 'slack':
    case 'teams':
      return (config as FlowNodeConfigs['slack']).message.slice(0, 60) || 'Write the message';
    case 'api_call': {
      const c = config as FlowNodeConfigs['api_call'];
      return c.connectionId ? `${c.method} ${lookups.connection(c.connectionId)}${c.path}` : 'Choose a connection';
    }
    case 'email':
      return (config as FlowNodeConfigs['email']).to || 'Choose who';
    case 'update': {
      const c = config as FlowNodeConfigs['update'];
      const parts = [c.priority && `priority ${c.priority}`, c.status && `status ${c.status.replace('_', ' ')}`, c.assigneeId && 'assign', c.addTags?.length && `label ${c.addTags.join(', ')}`].filter(Boolean);
      return parts.length ? parts.join(', ') : 'Choose what changes';
    }
    case 'approval':
      return (config as FlowNodeConfigs['approval']).title;
    case 'escalate':
      return (config as FlowNodeConfigs['escalate']).teamId ? `To ${lookups.team((config as FlowNodeConfigs['escalate']).teamId)}` : 'Choose a department';
  }
}

/* --------------------------------- List --------------------------------- */

export function FlowsPage() {
  useDocumentTitle('Flows');
  const { current } = useDepartment();
  const navigate = useNavigate();
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { user, can } = useAuth();
  const canBuild = can('flows.manage') || Boolean(user?.managedTeamIds.length);

  const load = useCallback(async () => {
    setError(null);
    try {
      setFlows((await api.flows.list(current?.id)).flows);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load flows.');
    }
  }, [current]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <PageHeader
        title="Flows"
        description="Draw how alerts and escalations move: who hears first, what waits, which channel, which API, who signs off. Each department builds its own."
        actions={
          canBuild && (
            <Button variant="primary" onClick={() => navigate('/flows/new')}>
              <Plus className="size-3.5" /> New flow
            </Button>
          )
        }
      />
      {error ? (
        <ErrorPane message={error} retry={load} />
      ) : !flows ? (
        <LoadingPane label="Loading flows" />
      ) : flows.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No flows yet"
          description="Start from the urgent-escalation example, or a blank canvas."
          action={canBuild ? <Button onClick={() => navigate('/flows/new')}>New flow</Button> : undefined}
        />
      ) : (
        <ul className="m-4 divide-y rounded-md border surface sm:m-6">
          {flows.map((flow) => (
            <li key={flow.id}>
              <Link to={`/flows/${flow.id}`} className="flex items-center justify-between gap-3 p-3 hover:bg-[var(--bg)]">
                <div className="min-w-0">
                  <p className={cn('text-sm font-semibold', !flow.enabled && 'text-subtle')}>
                    {flow.name} {!flow.enabled && <span className="text-2xs font-normal">(off)</span>}
                  </p>
                  <p className="text-xs text-muted">
                    {flow.teamName ?? 'Every department'} · {flow.nodes.length} steps · {flow.lastRunAt ? `last ran ${relativeTime(flow.lastRunAt)}` : 'not run yet'}
                  </p>
                </div>
                <Workflow className="size-4 shrink-0 text-subtle" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------- Editor -------------------------------- */

function starter(kind: 'example' | 'blank'): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const at = (x: number, y: number) => ({ x, y });
  if (kind === 'blank') return { nodes: [{ id: 'start', kind: 'trigger', position: at(0, 0), config: DEFAULT_CONFIGS.trigger }], edges: [] };
  const nodes: FlowNode[] = [
    { id: 'start', kind: 'trigger', position: at(0, 0), config: { events: ['ticketCreated'] } },
    { id: 'urgent', kind: 'condition', position: at(0, 120), config: { field: 'priority', op: 'any_of', value: 'urgent, high' } },
    { id: 'teams', kind: 'teams', position: at(-150, 250), config: DEFAULT_CONFIGS.teams },
    { id: 'page', kind: 'page', position: at(-150, 370), config: DEFAULT_CONFIGS.page },
    { id: 'wait', kind: 'wait', position: at(-150, 490), config: { minutes: 15, onlyIfOpen: true } },
    { id: 'managers', kind: 'notify', position: at(-150, 610), config: { ...DEFAULT_CONFIGS.notify, to: ['department_managers'], message: '{{ticket.reference}} is still open after 15 minutes', email: true } },
    { id: 'tell', kind: 'notify', position: at(150, 250), config: { ...DEFAULT_CONFIGS.notify, to: ['shift_leader'] } },
  ];
  const edges: FlowEdge[] = [
    { id: 'e1', source: 'start', sourceHandle: 'out', target: 'urgent' },
    { id: 'e2', source: 'urgent', sourceHandle: 'yes', target: 'teams' },
    { id: 'e3', source: 'teams', sourceHandle: 'out', target: 'page' },
    { id: 'e4', source: 'page', sourceHandle: 'out', target: 'wait' },
    { id: 'e5', source: 'wait', sourceHandle: 'out', target: 'managers' },
    { id: 'e6', source: 'urgent', sourceHandle: 'no', target: 'tell' },
  ];
  return { nodes, edges };
}

const toCanvasNodes = (nodes: FlowNode[]): StepNode[] => nodes.map((node) => ({ id: node.id, type: 'step', position: node.position, data: { kind: node.kind, config: node.config } }));
const toCanvasEdges = (edges: FlowEdge[]): Edge[] =>
  edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    markerEnd: { type: MarkerType.ArrowClosed },
  }));

export function FlowEditorPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const toast = useToast();
  const { user, can } = useAuth();
  const { resolved } = useTheme();
  const { current, departments } = useDepartment();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [teamId, setTeamId] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [nodes, setNodes] = useState<StepNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // The canvas fits the view when it mounts, so it mounts once the steps are in.
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testTicket, setTestTicket] = useState('');
  const [directory, setDirectory] = useState<Directory>([]);
  const [connections, setConnections] = useState<Array<{ id: string; name: string }>>([]);
  const [policies, setPolicies] = useState<EscalationPolicy[]>([]);
  useDocumentTitle(name || 'Flow');

  const manageable = departments.filter((team) => can('flows.manage') || user?.managedTeamIds.includes(team.id));
  const editable = isNew || Boolean(flow?.canEdit);

  useEffect(() => {
    void api.users.directory().then((result) => setDirectory(result.users)).catch(() => undefined);
    void api.connections.list({ kind: 'api' }).then((result) => setConnections(result.connections.map((c) => ({ id: c.id, name: c.name })))).catch(() => undefined);
    void opsApi.policies.list().then((result) => setPolicies(result.policies)).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    if (isNew) {
      const graph = starter('example');
      setNodes(toCanvasNodes(graph.nodes));
      setEdges(toCanvasEdges(graph.edges));
      setName('Urgent escalation');
      setTeamId(current?.id ?? manageable[0]?.id ?? null);
      setReady(true);
      return;
    }
    try {
      const result = await api.flows.get(id!);
      setFlow(result.flow);
      setRuns(result.runs);
      setName(result.flow.name);
      setTeamId(result.flow.teamId);
      setEnabled(result.flow.enabled);
      setNodes(toCanvasNodes(result.flow.nodes));
      setEdges(toCanvasEdges(result.flow.edges));
      setReady(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the flow.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isNew]);

  useEffect(() => {
    void load();
  }, [load]);

  const graph = useMemo(
    () => ({
      nodes: nodes.map((node) => ({ id: node.id, kind: node.data.kind, position: node.position, config: node.data.config }) as FlowNode),
      edges: edges.map((edge) => ({ id: edge.id, source: edge.source, sourceHandle: edge.sourceHandle ?? 'out', target: edge.target })),
    }),
    [nodes, edges],
  );
  const check = useMemo(() => validateFlowGraph(graph.nodes, graph.edges), [graph]);

  const lookups = useMemo(
    () => ({
      team: (teamIdToFind: string) => departments.find((team) => team.id === teamIdToFind)?.name ?? 'a department',
      connection: (connectionId: string) => connections.find((c) => c.id === connectionId)?.name ?? 'a connection',
    }),
    [departments, connections],
  );
  const nodeTypes = useMemo(() => ({ step: (props: NodeProps<StepNode>) => <StepCard {...props} lookups={lookups} /> }), [lookups]);

  const onNodesChange = useCallback((changes: NodeChange<StepNode>[]) => setNodes((all) => applyNodeChanges(changes, all)), []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges((all) => applyEdgeChanges(changes, all)), []);
  const onConnect = useCallback(
    (connection: FlowConnection) =>
      setEdges((all) =>
        addEdge(
          { ...connection, id: newId('edge'), markerEnd: { type: MarkerType.ArrowClosed } },
          // One arrow per exit: drawing a new one replaces the old.
          all.filter((edge) => !(edge.source === connection.source && (edge.sourceHandle ?? 'out') === (connection.sourceHandle ?? 'out'))),
        ),
      ),
    [],
  );

  const addStep = (kind: FlowNodeKind) => {
    // Below the lowest step, under whichever step is selected.
    const lowest = nodes.reduce((max, node) => Math.max(max, node.position.y), -120);
    const under = nodes.find((node) => node.id === selected)?.position.x ?? 0;
    const step: StepNode = { id: newId(kind), type: 'step', position: { x: under, y: lowest + 120 }, data: { kind, config: structuredClone(DEFAULT_CONFIGS[kind]) } };
    setNodes((all) => [...all, step]);
    setSelected(step.id);
  };

  const setConfig = (nodeId: string, config: FlowNode['config']) => setNodes((all) => all.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, config } } : node)));
  const removeStep = (nodeId: string) => {
    setNodes((all) => all.filter((node) => node.id !== nodeId));
    setEdges((all) => all.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
    setSelected(null);
  };

  const save = async (): Promise<Flow | null> => {
    setSaving(true);
    const body: FlowInput = { name, teamId, enabled, description: flow?.description ?? null, nodes: graph.nodes, edges: graph.edges };
    try {
      const { flow: saved } = flow ? await api.flows.update(flow.id, body) : await api.flows.create(body);
      setFlow(saved);
      toast.success('Flow saved', saved.enabled ? 'It runs from now on.' : 'It is off until you switch it on.');
      if (isNew) navigate(`/flows/${saved.id}`, { replace: true });
      return saved;
    } catch (caught) {
      toast.error('Could not save the flow', caught instanceof ApiError ? caught.message : undefined);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const testRun = async () => {
    const saved = flow ?? (await save());
    if (!saved || !testTicket.trim()) return;
    try {
      const result = await api.flows.run(saved.id, testTicket.trim());
      setRuns((await api.flows.get(saved.id)).runs);
      const run = result.runs.find((entry) => entry.id === result.runId);
      toast.success('Ran the flow', run ? `${run.steps.length} step${run.steps.length === 1 ? '' : 's'}${run.status === 'waiting' ? ', now waiting' : ''}.` : undefined);
    } catch (caught) {
      toast.error('Could not run it', caught instanceof ApiError ? caught.message : undefined);
    }
  };

  const remove = async () => {
    if (!flow || !window.confirm(`Remove ${flow.name}? Runs that are waiting stop.`)) return;
    await api.flows.remove(flow.id);
    navigate('/flows');
  };

  if (error) return <ErrorPane message={error} retry={load} />;
  if (!isNew && !flow) return <LoadingPane label="Loading the flow" />;

  const selectedNode = nodes.find((node) => node.id === selected) ?? null;
  const hasTrigger = nodes.some((node) => node.data.kind === 'trigger');
  const stepName = (nodeId: string) => {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    return node ? NODE_LABELS[node.data.kind] : '';
  };

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 surface">
        <Button variant="ghost" size="icon" onClick={() => navigate('/flows')} aria-label="Back to flows">
          <ArrowLeft className="size-4" />
        </Button>
        <Input value={name} onChange={(event) => setName(event.target.value)} className="w-56" disabled={!editable} aria-label="Flow name" />
        <Select value={teamId ?? ''} onChange={(event) => setTeamId(event.target.value || null)} className="w-44" disabled={!editable} aria-label="Department">
          {can('flows.manage') && <option value="">Every department</option>}
          {(editable ? manageable : departments).map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={!editable} /> On
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {editable && (
            <>
              <Input value={testTicket} onChange={(event) => setTestTicket(event.target.value)} placeholder="Ticket, e.g. INC-1042" className="w-40" aria-label="Ticket to try it on" />
              <Button size="sm" variant="secondary" onClick={() => void testRun()} disabled={!testTicket.trim()}>
                <Play className="size-3.5" /> Try on ticket
              </Button>
              <Button size="sm" variant="primary" onClick={() => void save()} loading={saving}>
                <Save className="size-3.5" /> Save
              </Button>
              {flow && (
                <Button size="sm" variant="ghost" onClick={() => void remove()} aria-label="Remove flow">
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {editable && (
          <aside className="w-44 shrink-0 space-y-1 overflow-y-auto border-r p-2 surface">
            <p className="eyebrow px-1 pb-1">Add a step</p>
            {(Object.keys(NODE_LABELS) as FlowNodeKind[])
              .filter((kind) => kind !== 'trigger' || !hasTrigger)
              .map((kind) => {
                const Icon = ICONS[kind];
                return (
                  <button key={kind} onClick={() => addStep(kind)} className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-[var(--bg)]">
                    <Icon className="size-3.5 shrink-0" />
                    {NODE_LABELS[kind]}
                  </button>
                );
              })}
            <p className="px-1 pt-3 text-2xs leading-relaxed text-subtle">Drag from the dot under a step to the next one. Select a step to set it up; Delete removes it.</p>
          </aside>
        )}

        <div className="relative min-w-0 flex-1">
          {ready && (
            <ReactFlow
              nodes={nodes.map((node) => ({ ...node, selected: node.id === selected }))}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={editable ? onNodesChange : undefined}
              onEdgesChange={editable ? onEdgesChange : undefined}
              onConnect={editable ? onConnect : undefined}
              onNodeClick={(_, node) => setSelected(node.id)}
              onPaneClick={() => setSelected(null)}
              isValidConnection={(connection) => connection.source !== connection.target && nodes.find((node) => node.id === connection.target)?.data.kind !== 'trigger'}
              nodesDraggable={editable}
              nodesConnectable={editable}
              deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
              colorMode={resolved}
              fitView
              fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
              minZoom={0.2}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={20} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable className="!hidden md:!block" />
            </ReactFlow>
          )}
          {!check.ok && (
            <div className="absolute top-2 left-1/2 max-w-md -translate-x-1/2 rounded-sm border border-[var(--status-pending)]/40 bg-[var(--surface)] px-3 py-1.5 text-xs shadow-sm">
              {check.errors[0]} {enabled && '(needed before it can be switched on)'}
            </div>
          )}
        </div>

        <aside className="w-80 shrink-0 overflow-y-auto border-l surface">
          {selectedNode ? (
            <StepSettings
              key={selectedNode.id}
              node={selectedNode}
              editable={editable}
              directory={directory}
              departments={departments}
              connections={connections}
              policies={policies}
              onChange={(config) => setConfig(selectedNode.id, config)}
              onRemove={() => removeStep(selectedNode.id)}
            />
          ) : (
            <RunsPanel runs={runs} stepName={stepName} />
          )}
        </aside>
      </div>
    </div>
  );
}

function StepCard({ data, selected, lookups }: NodeProps<StepNode> & { lookups: Parameters<typeof summarise>[2] }) {
  const Icon = ICONS[data.kind];
  const ports = NODE_PORTS[data.kind];
  return (
    <div
      className={cn('w-56 rounded-md border bg-[var(--surface)] text-[var(--fg)] shadow-sm', selected && 'ring-2 ring-[var(--accent)]')}
      style={{ borderLeft: `4px solid ${ACCENTS[data.kind]}` }}
    >
      {data.kind !== 'trigger' && <Handle type="target" position={Position.Top} className="!size-2.5 !bg-[var(--fg-subtle)]" />}
      <div className="flex items-center gap-1.5 px-2.5 pt-2 text-xs font-semibold">
        <Icon className="size-3.5" />
        {NODE_LABELS[data.kind]}
      </div>
      <p className="line-clamp-2 px-2.5 pt-0.5 pb-2 text-2xs text-muted">{summarise(data.kind, data.config, lookups)}</p>
      {ports.map((port, index) => (
        <div key={port}>
          <Handle id={port} type="source" position={Position.Bottom} style={{ left: `${((index + 1) / (ports.length + 1)) * 100}%` }} className="!size-2.5 !bg-[var(--accent)]" />
          {PORT_LABELS[port] && (
            <span className="pointer-events-none absolute -bottom-4 -translate-x-1/2 text-[10px] font-medium text-subtle" style={{ left: `${((index + 1) / (ports.length + 1)) * 100}%` }}>
              {PORT_LABELS[port]}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function RunsPanel({ runs, stepName }: { runs: FlowRun[]; stepName: (nodeId: string) => string }) {
  return (
    <div className="p-3">
      <p className="eyebrow mb-2">Recent runs</p>
      {runs.length === 0 ? (
        <p className="text-xs text-muted">None yet. Save it, then try it on a ticket, or wait for its trigger.</p>
      ) : (
        <ul className="space-y-2">
          {runs.map((run) => (
            <li key={run.id} className="rounded-sm border p-2 text-xs surface-2">
              <div className="flex items-center justify-between gap-2">
                {run.ticketId ? (
                  <Link to={`/tickets/${run.ticketId}`} className="font-medium text-[var(--accent)] hover:underline">
                    {run.ticketReference ?? 'Ticket'}
                  </Link>
                ) : (
                  <span>Ticket removed</span>
                )}
                <span className={cn('text-2xs', run.status === 'failed' ? 'text-[var(--priority-urgent)]' : 'text-subtle')}>
                  {run.status === 'waiting' && run.nextAt ? `waiting until ${shortDateTime(run.nextAt)}` : run.status} · {relativeTime(run.createdAt)}
                </span>
              </div>
              <ol className="mt-1 space-y-0.5">
                {run.steps.map((step, index) => (
                  <li key={index} className={cn('text-2xs', step.ok ? 'text-muted' : 'text-[var(--priority-urgent)]')}>
                    {step.ok ? '✓' : '✗'} {stepName(step.nodeId) ? <b className="font-medium">{stepName(step.nodeId)}:</b> : null} {step.message}
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------ Step settings ------------------------------ */

function TemplateHint() {
  return <p className="text-2xs text-subtle">Use {TEMPLATE_VARIABLES.map((variable) => `{{${variable}}}`).join(' ')}</p>;
}

function StepSettings({
  node,
  editable,
  directory,
  departments,
  connections,
  policies,
  onChange,
  onRemove,
}: {
  node: StepNode;
  editable: boolean;
  directory: Directory;
  departments: Array<{ id: string; name: string }>;
  connections: Array<{ id: string; name: string }>;
  policies: EscalationPolicy[];
  onChange: (config: FlowNode['config']) => void;
  onRemove: () => void;
}) {
  const { kind, config } = node.data;
  const Icon = ICONS[kind];
  const set = <K extends FlowNodeKind>(patch: Partial<FlowNodeConfigs[K]>) => onChange({ ...(config as FlowNodeConfigs[K]), ...patch } as FlowNode['config']);

  let body: React.ReactNode = null;
  switch (kind) {
    case 'trigger': {
      const c = config as FlowNodeConfigs['trigger'];
      body = (
        <Field label="Starts when">
          <div className="space-y-1">
            {FLOW_EVENTS.map((event) => (
              <Checkbox
                key={event}
                label={FLOW_EVENT_LABELS[event]}
                checked={c.events.includes(event)}
                onChange={(e) => set<'trigger'>({ events: e.target.checked ? [...c.events, event] : c.events.filter((x) => x !== event) })}
              />
            ))}
          </div>
        </Field>
      );
      break;
    }
    case 'condition': {
      const c = config as FlowNodeConfigs['condition'];
      const hint: Record<string, string> = {
        priority: TICKET_PRIORITIES.join(', '),
        status: TICKET_STATUSES.join(', '),
        type: 'incident, request, question, problem, escalation',
        source: 'web, email, slack, msteams, monitor, webhook…',
        severity: 'sev1, sev2, sev3, sev4',
        assigned: 'yes or no',
        in_shift: 'yes or no',
        hour: '0-23, e.g. at least 17',
        department: 'the department name',
        tags: 'label names, comma separated',
        subject: 'words, comma separated',
      };
      body = (
        <>
          <Field label="If">
            <Select value={c.field} onChange={(e) => set<'condition'>({ field: e.target.value as typeof c.field })}>
              {CONDITION_FIELDS.map((field) => (
                <option key={field} value={field}>
                  {CONDITION_FIELD_LABELS[field]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Is">
            <Select value={c.op} onChange={(e) => set<'condition'>({ op: e.target.value as ConditionOp })}>
              {(Object.keys(OP_LABELS) as ConditionOp[]).map((op) => (
                <option key={op} value={op}>
                  {OP_LABELS[op]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Value" hint={hint[c.field]}>
            <Input value={c.value} onChange={(e) => set<'condition'>({ value: e.target.value })} />
          </Field>
          <p className="text-2xs text-subtle">Two exits: Yes and No.</p>
        </>
      );
      break;
    }
    case 'wait': {
      const c = config as FlowNodeConfigs['wait'];
      body = (
        <>
          <Field label="Minutes">
            <Input type="number" min={1} value={c.minutes} onChange={(e) => set<'wait'>({ minutes: Number(e.target.value) || 1 })} />
          </Field>
          <Checkbox label="Then only if the ticket is still open" hint="A ticket resolved meanwhile ends the flow here." checked={c.onlyIfOpen} onChange={(e) => set<'wait'>({ onlyIfOpen: e.target.checked })} />
        </>
      );
      break;
    }
    case 'notify': {
      const c = config as FlowNodeConfigs['notify'];
      body = (
        <>
          <Field label="Who">
            <div className="space-y-1">
              {(Object.keys(NOTIFY_LABELS) as NotifyTarget[]).map((to) => (
                <Checkbox key={to} label={NOTIFY_LABELS[to]} checked={c.to.includes(to)} onChange={(e) => set<'notify'>({ to: e.target.checked ? [...c.to, to] : c.to.filter((x) => x !== to) })} />
              ))}
            </div>
          </Field>
          {c.to.includes('people') && (
            <Field label="People">
              <Select
                multiple
                value={c.userIds}
                onChange={(e) => set<'notify'>({ userIds: Array.from(e.target.selectedOptions).map((option) => option.value) })}
                className="h-32"
              >
                {directory.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Message">
            <Textarea rows={3} value={c.message} onChange={(e) => set<'notify'>({ message: e.target.value })} />
          </Field>
          <TemplateHint />
          <Checkbox label="Email them too" checked={c.email} onChange={(e) => set<'notify'>({ email: e.target.checked })} />
        </>
      );
      break;
    }
    case 'page': {
      const c = config as FlowNodeConfigs['page'];
      body = (
        <>
          <Field label="Escalation policy">
            <Select value={c.policyId ?? ''} onChange={(e) => set<'page'>({ policyId: e.target.value || null })}>
              <option value="">The department’s default</option>
              {policies.map((policy) => (
                <option key={policy.id} value={policy.id}>
                  {policy.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Severity">
            <Select value={c.severity} onChange={(e) => set<'page'>({ severity: e.target.value as typeof c.severity })}>
              {SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {SEVERITY_LABELS[severity]}
                </option>
              ))}
            </Select>
          </Field>
        </>
      );
      break;
    }
    case 'slack':
    case 'teams': {
      const c = config as FlowNodeConfigs['slack'];
      body = (
        <>
          <Field label="Message" hint={`Posted to the ticket's department channel in ${kind === 'slack' ? 'Slack' : 'Teams'}: its route, or its own channel under Connections.`}>
            <Textarea rows={4} value={c.message} onChange={(e) => set<'slack'>({ message: e.target.value })} />
          </Field>
          <TemplateHint />
        </>
      );
      break;
    }
    case 'api_call': {
      const c = config as FlowNodeConfigs['api_call'];
      body = (
        <>
          <Field label="Connection" hint="Add APIs under Connections; the key stays there.">
            <Select value={c.connectionId} onChange={(e) => set<'api_call'>({ connectionId: e.target.value })}>
              <option value="">Choose…</option>
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
            <Field label="Method">
              <Select value={c.method} onChange={(e) => set<'api_call'>({ method: e.target.value as typeof c.method })}>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
                  <option key={method}>{method}</option>
                ))}
              </Select>
            </Field>
            <Field label="Path">
              <Input value={c.path} onChange={(e) => set<'api_call'>({ path: e.target.value })} className="font-mono text-xs" />
            </Field>
          </div>
          {c.method !== 'GET' && c.method !== 'DELETE' && (
            <Field label="JSON body">
              <Textarea rows={5} value={c.body} onChange={(e) => set<'api_call'>({ body: e.target.value })} className="font-mono text-xs" />
            </Field>
          )}
          <TemplateHint />
          <p className="text-2xs text-subtle">Two exits: Worked (any 2xx or 3xx) and Failed.</p>
        </>
      );
      break;
    }
    case 'email': {
      const c = config as FlowNodeConfigs['email'];
      body = (
        <>
          <Field label="To" hint="Addresses, comma separated">
            <Input value={c.to} onChange={(e) => set<'email'>({ to: e.target.value })} placeholder="finance-leads@company.co.za" />
          </Field>
          <Field label="Subject">
            <Input value={c.subject} onChange={(e) => set<'email'>({ subject: e.target.value })} />
          </Field>
          <Field label="Body">
            <Textarea rows={4} value={c.body} onChange={(e) => set<'email'>({ body: e.target.value })} />
          </Field>
          <TemplateHint />
        </>
      );
      break;
    }
    case 'update': {
      const c = config as FlowNodeConfigs['update'];
      body = (
        <>
          <Field label="Priority">
            <Select value={c.priority ?? ''} onChange={(e) => set<'update'>({ priority: e.target.value || undefined })}>
              <option value="">Leave it</option>
              {TICKET_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {PRIORITY_LABELS[priority]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={c.status ?? ''} onChange={(e) => set<'update'>({ status: e.target.value || undefined })}>
              <option value="">Leave it</option>
              {TICKET_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Assign to">
            <Select value={c.assigneeId ?? ''} onChange={(e) => set<'update'>({ assigneeId: e.target.value || undefined })}>
              <option value="">Leave it</option>
              {directory.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Add labels" hint="Comma separated">
            <Input
              value={(c.addTags ?? []).join(', ')}
              onChange={(e) =>
                set<'update'>({
                  addTags: e.target.value
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
        </>
      );
      break;
    }
    case 'approval': {
      const c = config as FlowNodeConfigs['approval'];
      const has = (approverKind: 'department_managers' | 'shift_leader') => c.approvers.some((spec) => spec.kind === approverKind);
      const toggle = (approverKind: 'department_managers' | 'shift_leader') =>
        set<'approval'>({ approvers: has(approverKind) ? c.approvers.filter((spec) => spec.kind !== approverKind) : [...c.approvers, { kind: approverKind }] });
      const people = c.approvers.filter((spec): spec is { kind: 'user'; userId: string } => spec.kind === 'user').map((spec) => spec.userId);
      body = (
        <>
          <Field label="What needs approving">
            <Input value={c.title} onChange={(e) => set<'approval'>({ title: e.target.value })} />
          </Field>
          <Checkbox label="Department managers" checked={has('department_managers')} onChange={() => toggle('department_managers')} />
          <Checkbox label="Shift leader on duty" checked={has('shift_leader')} onChange={() => toggle('shift_leader')} />
          <Field label="And these people">
            <Select
              multiple
              value={people}
              onChange={(e) =>
                set<'approval'>({
                  approvers: [...c.approvers.filter((spec) => spec.kind !== 'user'), ...Array.from(e.target.selectedOptions).map((option) => ({ kind: 'user' as const, userId: option.value }))],
                })
              }
              className="h-28"
            >
              {directory.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Needs">
            <Select value={c.mode} onChange={(e) => set<'approval'>({ mode: e.target.value as 'any' | 'all' })}>
              <option value="any">Any one of them</option>
              <option value="all">All of them</option>
            </Select>
          </Field>
          <p className="text-2xs text-subtle">The ticket cannot be started or resolved until it is approved; a rejection closes it.</p>
        </>
      );
      break;
    }
    case 'escalate': {
      const c = config as FlowNodeConfigs['escalate'];
      body = (
        <>
          <Field label="To department">
            <Select value={c.teamId} onChange={(e) => set<'escalate'>({ teamId: e.target.value })}>
              <option value="">Choose…</option>
              {departments.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reason" hint="Kept as an internal note">
            <Textarea rows={3} value={c.reason} onChange={(e) => set<'escalate'>({ reason: e.target.value })} />
          </Field>
          <TemplateHint />
        </>
      );
      break;
    }
  }

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <Icon className="size-4" /> {NODE_LABELS[kind]}
        </p>
        {editable && kind !== 'trigger' && (
          <Button variant="ghost" size="icon" onClick={onRemove} aria-label="Remove step">
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
      <fieldset disabled={!editable} className="space-y-3">
        {body}
      </fieldset>
    </div>
  );
}
