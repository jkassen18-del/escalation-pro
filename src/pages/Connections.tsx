import { useCallback, useEffect, useMemo, useState } from 'react';
import { Lock, Pencil, Plug, Plus, Send, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/state/auth';
import { useDocumentTitle } from '@/state/branding';
import { useDepartment } from '@/state/department';
import { CONNECTION_KINDS, CONNECTION_LABELS, type ApiConnectionConfig, type Connection, type ConnectionKind } from '@shared/connections';
import type { ApiAuth, ApiTryResult } from '@shared/ops';
import type { IntegrationEventToggles } from '@shared/types';

const EVENT_LABELS: Record<keyof IntegrationEventToggles, string> = {
  ticketCreated: 'New tickets',
  ticketAssigned: 'Assigned',
  ticketStatusChanged: 'Status changes',
  ticketEscalated: 'Escalations',
  ticketCommented: 'Comments',
  slaBreached: 'SLA breaches',
};

const KIND_HINTS: Record<ConnectionKind, string> = {
  api: 'An API this department calls: its address, key and headers, kept once. Monitors and alert sources that poll use it by name, so nobody pastes the key twice.',
  slack_webhook: "The department's own Slack channel. Its tickets, shift handovers and approval requests are posted there, even if the organisation's Slack is not set up.",
  teams_webhook: "The department's own Teams channel, from a Workflows “Post to a channel when a webhook request is received” flow. Same messages as Slack.",
  webhook: "The department's ticket events POSTed as JSON to its own tools. Signed with HMAC-SHA256 when you set a secret.",
};

type Draft = {
  id?: string;
  kind: ConnectionKind;
  teamId: string | null;
  name: string;
  description: string;
  enabled: boolean;
  events: IntegrationEventToggles;
  baseUrl: string;
  auth: ApiAuth;
  headers: string;
  timeoutMs: number;
  url: string;
  signingSecret: string;
  hasSigningSecret?: boolean;
};

const DEFAULT_EVENTS: IntegrationEventToggles = { ticketCreated: true, ticketAssigned: false, ticketStatusChanged: true, ticketEscalated: true, ticketCommented: false, slaBreached: true };

const headersToText = (headers: Record<string, string> | undefined) =>
  Object.entries(headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
const textToHeaders = (text: string) =>
  Object.fromEntries(
    text
      .split('\n')
      .map((line) => line.split(/:(.*)/s).map((part) => part?.trim()))
      .filter(([name, value]) => name && value !== undefined)
      .map(([name, value]) => [name, value ?? '']),
  );

function toDraft(connection: Connection): Draft {
  const api = connection.config as ApiConnectionConfig;
  const hook = connection.config as { url?: string; hasSigningSecret?: boolean };
  return {
    id: connection.id,
    kind: connection.kind,
    teamId: connection.teamId,
    name: connection.name,
    description: connection.description ?? '',
    enabled: connection.enabled,
    events: connection.events,
    baseUrl: api.baseUrl ?? '',
    auth: api.auth ?? { type: 'none' },
    headers: headersToText(api.headers),
    timeoutMs: api.timeoutMs ?? 10_000,
    url: hook.url ?? '',
    signingSecret: '',
    hasSigningSecret: hook.hasSigningSecret,
  };
}

export function ConnectionsPage() {
  useDocumentTitle('Connections');
  const { current, departments } = useDepartment();
  const { user, can } = useAuth();
  const toast = useToast();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [canAddShared, setCanAddShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.connections.list(current ? { teamId: current.id } : {});
      setConnections(result.connections);
      setCanAddShared(result.canAddShared);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load connections.');
    }
  }, [current]);

  useEffect(() => {
    void load();
  }, [load]);

  const manageable = useMemo(
    () => departments.filter((team) => can('integrations.manage') || user?.managedTeamIds.includes(team.id) || (can('connector.manage') && user?.teamIds.includes(team.id))),
    [departments, can, user],
  );
  const canAdd = canAddShared || manageable.length > 0;

  const groups = useMemo(() => {
    const byTeam = new Map<string, { name: string; items: Connection[] }>();
    for (const connection of connections ?? []) {
      const key = connection.teamId ?? '';
      const group = byTeam.get(key) ?? { name: connection.teamName ?? 'Shared with every department', items: [] };
      group.items.push(connection);
      byTeam.set(key, group);
    }
    // The department's own first, shared last.
    return [...byTeam.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : 0)).map(([, group]) => group);
  }, [connections]);

  const startNew = (kind: ConnectionKind) =>
    setEditing({
      kind,
      teamId: current?.id ?? manageable[0]?.id ?? null,
      name: '',
      description: '',
      enabled: true,
      events: DEFAULT_EVENTS,
      baseUrl: '',
      auth: { type: 'none' },
      headers: '',
      timeoutMs: 10_000,
      url: '',
      signingSecret: '',
    });

  const remove = async (connection: Connection) => {
    if (!window.confirm(`Remove ${connection.name}? Monitors and sources that use it will stop working until they are given another.`)) return;
    try {
      await api.connections.remove(connection.id);
      void load();
    } catch (caught) {
      toast.error('Could not remove it', caught instanceof ApiError ? caught.message : undefined);
    }
  };

  return (
    <div>
      <PageHeader
        title="Connections"
        description={`${current ? `${current.name}'s` : 'Your departments’'} own connectors: APIs, channels and webhooks. Other departments do not see them.`}
        actions={
          canAdd && (
            <Select value="" onChange={(event) => event.target.value && startNew(event.target.value as ConnectionKind)} className="w-48" aria-label="Add a connection">
              <option value="">+ Add a connection…</option>
              {CONNECTION_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {CONNECTION_LABELS[kind]}
                </option>
              ))}
            </Select>
          )
        }
      />
      {error ? (
        <ErrorPane message={error} retry={load} />
      ) : !connections ? (
        <LoadingPane label="Loading connections" />
      ) : connections.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No connections yet"
          description={canAdd ? 'Add the APIs and channels this department uses. They stay with the department.' : 'Your department managers add these.'}
          action={
            canAdd ? (
              <Button onClick={() => startNew('api')}>
                <Plus className="size-3.5" /> Add an API connection
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-6 p-4 sm:p-6">
          {groups.map((group) => (
            <section key={group.name}>
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                {group.items[0].teamId && <Lock className="size-3.5 text-subtle" />}
                {group.name}
              </h2>
              <ul className="divide-y rounded-md border surface">
                {group.items.map((connection) => (
                  <li key={connection.id} className="flex items-start justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <p className={cn('text-sm font-semibold', !connection.enabled && 'text-subtle line-through')}>{connection.name}</p>
                      <p className="text-xs text-muted">
                        {CONNECTION_LABELS[connection.kind]} ·{' '}
                        <span className="font-mono">{connection.kind === 'api' ? (connection.config as ApiConnectionConfig).baseUrl : (connection.config as { url: string }).url}</span>
                      </p>
                      <p className={cn('text-2xs', connection.lastError ? 'text-[var(--priority-urgent)]' : 'text-subtle')}>
                        {connection.lastError ? `Last call failed: ${connection.lastError}` : connection.lastUsedAt ? `Last used ${relativeTime(connection.lastUsedAt)}` : 'Not used yet'}
                      </p>
                    </div>
                    {connection.canEdit && (
                      <div className="flex shrink-0 gap-1">
                        <Button variant="ghost" size="icon" onClick={() => setEditing(toDraft(connection))} aria-label={`Edit ${connection.name}`}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => void remove(connection)} aria-label={`Remove ${connection.name}`}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {editing && (
        <ConnectionEditor
          draft={editing}
          departments={manageable}
          allowShared={canAddShared}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function ConnectionEditor({
  draft,
  departments,
  allowShared,
  onClose,
  onSaved,
}: {
  draft: Draft;
  departments: Array<{ id: string; name: string }>;
  allowShared: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState<Draft>(draft);
  const [saving, setSaving] = useState(false);
  const [path, setPath] = useState('');
  const [tried, setTried] = useState<ApiTryResult | null>(null);
  const [trying, setTrying] = useState(false);
  const set = (patch: Partial<Draft>) => setForm((current) => ({ ...current, ...patch }));
  const setAuth = (patch: Partial<ApiAuth>) => set({ auth: { ...form.auth, ...patch } });
  const isApi = form.kind === 'api';

  const body = () => ({
    kind: form.kind,
    teamId: form.teamId,
    name: form.name,
    description: form.description,
    enabled: form.enabled,
    events: form.events,
    config: isApi
      ? { baseUrl: form.baseUrl, auth: form.auth, headers: textToHeaders(form.headers), timeoutMs: form.timeoutMs }
      : { url: form.url, ...(form.kind === 'webhook' ? { signingSecret: form.signingSecret } : {}) },
  });

  const save = async (): Promise<Connection | null> => {
    setSaving(true);
    try {
      const { connection } = form.id ? await api.connections.update(form.id, body()) : await api.connections.create(body());
      return connection;
    } catch (caught) {
      toast.error('Could not save', caught instanceof ApiError ? caught.message : undefined);
      return null;
    } finally {
      setSaving(false);
    }
  };

  // Trying needs the saved credentials, so it saves first.
  const tryIt = async () => {
    setTrying(true);
    const saved = await save();
    if (saved) {
      setForm((current) => ({ ...current, id: saved.id, auth: (saved.config as ApiConnectionConfig).auth ?? { type: 'none' }, headers: headersToText((saved.config as ApiConnectionConfig).headers) }));
      try {
        setTried((await api.connections.tryCall(saved.id, { path })).result);
      } catch (caught) {
        toast.error('The call failed', caught instanceof ApiError ? caught.message : undefined);
      }
    }
    setTrying(false);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${form.id ? 'Edit' : 'New'} ${CONNECTION_LABELS[form.kind].toLowerCase()}`}
      description={KIND_HINTS[form.kind]}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving && !trying} onClick={() => void save().then((saved) => saved && onSaved())}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input value={form.name} onChange={(event) => set({ name: event.target.value })} placeholder={isApi ? 'e.g. Jenkins, Payments API' : 'e.g. #finance-alerts'} />
          </Field>
          <Field label="Belongs to" hint="Only this department sees and uses it.">
            <Select value={form.teamId ?? ''} onChange={(event) => set({ teamId: event.target.value || null })}>
              {allowShared && <option value="">Shared with every department</option>}
              {departments.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {isApi ? (
          <>
            <Field label="Base URL" hint="Paths are added to this, e.g. https://jenkins.example.com or https://api.example.com/v2">
              <Input value={form.baseUrl} onChange={(event) => set({ baseUrl: event.target.value })} placeholder="https://" className="font-mono text-xs" />
            </Field>
            <Field label="Authentication" hint={form.auth.secretSet ? 'A secret is saved. Leave it blank to keep it.' : 'Stored encrypted; never shown again.'}>
              <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
                <Select value={form.auth.type} onChange={(event) => setAuth({ type: event.target.value as ApiAuth['type'] })}>
                  <option value="none">None</option>
                  <option value="bearer">Bearer token</option>
                  <option value="basic">Username and password</option>
                  <option value="apikey">API key</option>
                </Select>
                {form.auth.type === 'bearer' && (
                  <Input type="password" value={form.auth.token ?? ''} onChange={(event) => setAuth({ token: event.target.value })} placeholder={form.auth.secretSet ? 'Saved' : 'Token'} autoComplete="off" />
                )}
                {form.auth.type === 'basic' && (
                  <div className="grid grid-cols-2 gap-2">
                    <Input value={form.auth.username ?? ''} onChange={(event) => setAuth({ username: event.target.value })} placeholder="Username" autoComplete="off" />
                    <Input type="password" value={form.auth.password ?? ''} onChange={(event) => setAuth({ password: event.target.value })} placeholder={form.auth.secretSet ? 'Saved' : 'Password or API token'} autoComplete="off" />
                  </div>
                )}
                {form.auth.type === 'apikey' && (
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem] gap-2">
                    <Input value={form.auth.keyName ?? ''} onChange={(event) => setAuth({ keyName: event.target.value })} placeholder="X-API-Key" />
                    <Input type="password" value={form.auth.keyValue ?? ''} onChange={(event) => setAuth({ keyValue: event.target.value })} placeholder={form.auth.secretSet ? 'Saved' : 'Key'} autoComplete="off" />
                    <Select value={form.auth.keyIn ?? 'header'} onChange={(event) => setAuth({ keyIn: event.target.value as 'header' | 'query' })}>
                      <option value="header">Header</option>
                      <option value="query">Query</option>
                    </Select>
                  </div>
                )}
              </div>
            </Field>
            <Field label="Headers" hint="One per line, Name: value. Values of key-like headers are hidden once saved.">
              <Textarea rows={2} value={form.headers} onChange={(event) => set({ headers: event.target.value })} placeholder="Accept: application/json" className="font-mono text-xs" />
            </Field>
            <div className="space-y-2 rounded-md border p-3 surface-2">
              <p className="text-xs font-medium">Try it</p>
              <div className="flex gap-2">
                <Input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/api/json" className="font-mono text-xs" />
                <Button size="sm" variant="secondary" onClick={() => void tryIt()} loading={trying} disabled={!form.baseUrl || !form.name}>
                  <Send className="size-3.5" /> Save and call
                </Button>
              </div>
              {tried && (
                <div className="space-y-1">
                  <p className={cn('font-mono text-2xs', tried.status && tried.status < 400 ? 'text-[var(--status-resolved)]' : 'text-[var(--priority-urgent)]')}>
                    {tried.url} · {tried.status ? `HTTP ${tried.status}` : tried.message} {tried.latencyMs !== null && `· ${tried.latencyMs} ms`}
                  </p>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-sm border p-2 text-2xs surface">{tried.json !== undefined ? JSON.stringify(tried.json, null, 2).slice(0, 4000) : tried.body.slice(0, 4000)}</pre>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <Field label="Webhook URL" hint={form.id ? 'Saved. Paste a new one to replace it.' : 'Kept encrypted: anyone with it can post to the channel.'}>
              <Input value={form.url} onChange={(event) => set({ url: event.target.value })} placeholder="https://" className="font-mono text-xs" />
            </Field>
            {form.kind === 'webhook' && (
              <Field label="Signing secret" hint={form.hasSigningSecret ? 'A secret is saved. Leave blank to keep it.' : 'Optional. Sent as X-InfraTicket-Signature.'}>
                <Input type="password" value={form.signingSecret} onChange={(event) => set({ signingSecret: event.target.value })} autoComplete="off" />
              </Field>
            )}
            <Field label="Send">
              <div className="flex flex-wrap gap-3">
                {(Object.keys(EVENT_LABELS) as Array<keyof IntegrationEventToggles>).map((event) => (
                  <label key={event} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" checked={form.events[event]} onChange={(changed) => set({ events: { ...form.events, [event]: changed.target.checked } })} />
                    {EVENT_LABELS[event]}
                  </label>
                ))}
              </div>
            </Field>
          </>
        )}
        <Checkbox label="Turned on" checked={form.enabled} onChange={(event) => set({ enabled: event.target.checked })} />
      </div>
    </Modal>
  );
}
