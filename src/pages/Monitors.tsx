import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, BellRing, MoreHorizontal, Pause, Play, Plus, RefreshCw, Send, Trash2, Webhook } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { opsApi, type AlertSourceInput, type MonitorInput } from '@/lib/ops-api';
import { fullDateTime, relativeTime, shortDateTime } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { useDocumentTitle } from '@/state/branding';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, SegmentedControl, Textarea } from '@/components/ui/Field';
import { Menu } from '@/components/ui/Menu';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { RoutingTab } from '@/components/ops/AlertRouting';
import { MaintenanceBadge } from '@/components/ops/MaintenanceShared';
import { CopyField, MonitorTabs, SeverityBadge, StateDot, STATE_LABELS, UptimeBars } from '@/components/ops/MonitorShared';
import {
  ALERT_SOURCE_KINDS,
  ALERT_SOURCE_LABELS,
  MONITOR_KIND_LABELS,
  MONITOR_KINDS,
  SEVERITIES,
  SEVERITY_LABELS,
  type Alert,
  type AlertSource,
  type AlertSourceKind,
  type BackupJob,
  type EscalationPolicy,
  type Monitor,
  type MonitorCheck,
  type MonitorConfig,
  type MonitorDay,
  type MonitorKind,
  type Severity,
} from '@shared/ops';
import type { Team } from '@shared/types';

type Tab = 'monitors' | 'sources' | 'routing' | 'alerts' | 'maintenance';

function message(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
}

/** Teams and policies feed every form on this page; loaded once. */
function useRoutingChoices() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [policies, setPolicies] = useState<EscalationPolicy[]>([]);
  useEffect(() => {
    void api.teams.list().then((r) => setTeams(r.teams)).catch(() => undefined);
    void opsApi.policies.list().then((r) => setPolicies(r.policies)).catch(() => undefined);
  }, []);
  return { teams, policies };
}

export function MonitorsPage() {
  useDocumentTitle('Monitoring');
  const { can } = useAuth();
  const canManage = can('monitors.manage');
  const [tab, setTab] = useState<Tab>('monitors');
  const choices = useRoutingChoices();
  const navigate = useNavigate();

  return (
    <div>
      <PageHeader
        title="Monitoring"
        description="Built-in checks and alert sources. A failing check or an incoming alert opens an incident and pages whoever is on call."
      >
        <MonitorTabs
          value={tab}
          // Maintenance has its own page now; the tab stays as a way there.
          onChange={(value) => (value === 'maintenance' ? navigate('/maintenance') : setTab(value))}
          tabs={[
            { value: 'monitors', label: 'Monitors' },
            { value: 'sources', label: 'Alert sources' },
            { value: 'routing', label: 'Routing' },
            { value: 'alerts', label: 'Alerts' },
            { value: 'maintenance', label: 'Maintenance' },
          ]}
        />
      </PageHeader>

      {tab === 'monitors' && <MonitorsTab canManage={canManage} {...choices} />}
      {tab === 'sources' && <SourcesTab canManage={canManage} {...choices} />}
      {tab === 'routing' && <RoutingTab canManage={canManage} {...choices} />}
      {tab === 'alerts' && <AlertsTab />}
    </div>
  );
}

/* --------------------------------- Monitors -------------------------------- */

function MonitorsTab({ canManage, teams, policies }: { canManage: boolean; teams: Team[]; policies: EscalationPolicy[] }) {
  const toast = useToast();
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Monitor | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Monitor | null>(null);
  const [viewing, setViewing] = useState<Monitor | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setMonitors((await opsApi.monitors.list()).monitors);
    } catch (caught) {
      setError(message(caught, 'Could not load monitors.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const checkNow = async (monitor: Monitor) => {
    setBusy(monitor.id);
    try {
      const result = await opsApi.monitors.check(monitor.id);
      toast.info(`${monitor.name}: ${STATE_LABELS[result.monitor.state]}`, result.monitor.lastMessage ?? undefined);
      await load();
    } catch (caught) {
      toast.error('Check failed', message(caught, ''));
    } finally {
      setBusy(null);
    }
  };

  const togglePause = async (monitor: Monitor) => {
    try {
      await opsApi.monitors.update(monitor.id, { ...toInput(monitor), enabled: !monitor.enabled });
      await load();
    } catch (caught) {
      toast.error('Could not update', message(caught, ''));
    }
  };

  const down = monitors.filter((m) => m.state === 'down').length;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 sm:px-6">
        <p className="text-xs text-muted">
          {monitors.length} monitor{monitors.length === 1 ? '' : 's'}
          {down > 0 && <span className="ml-1 font-medium text-[var(--priority-urgent)]">· {down} down</span>}
        </p>
        {canManage && (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            New monitor
          </Button>
        )}
      </div>

      {error ? (
        <ErrorPane message={error} retry={load} />
      ) : loading ? (
        <LoadingPane label="Loading monitors" />
      ) : monitors.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="Nothing is being watched yet"
          description="Add an HTTP check for your website, a heartbeat for a nightly job, or a database health check. Failures open incidents and page the on-call."
          action={
            canManage && (
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                Add the first monitor
              </Button>
            )
          }
        />
      ) : (
        <div className="p-4 sm:p-6">
          <div className="overflow-x-auto rounded-md border surface">
            <table className="w-full table-fixed border-collapse text-sm md:table-auto">
              <thead>
                <tr className="border-b surface-2">
                  <th className="eyebrow px-3 py-2 pl-4 text-left font-medium">Monitor</th>
                  <th className="eyebrow hidden px-3 py-2 text-left font-medium sm:table-cell">Last check</th>
                  <th className="eyebrow hidden px-3 py-2 text-right font-medium md:table-cell">24h uptime</th>
                  <th className="eyebrow hidden px-3 py-2 text-left font-medium md:table-cell">Severity</th>
                  <th className="eyebrow hidden px-3 py-2 text-left font-medium lg:table-cell">Team</th>
                  <th className="w-24 px-3 py-2 pr-4 md:w-auto" />
                </tr>
              </thead>
              <tbody>
                {monitors.map((monitor) => (
                  <tr key={monitor.id} className="border-b last:border-b-0 hover:bg-[var(--surface-2)]">
                    <td className="px-3 py-2 pl-4">
                      <button className="flex w-full min-w-0 items-center gap-2.5 text-left" onClick={() => setViewing(monitor)}>
                        <StateDot state={monitor.state} />
                        <span className="min-w-0">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-xs font-medium hover:underline">{monitor.name}</span>
                            {monitor.maintenance && <MaintenanceBadge maintenance={monitor.maintenance} />}
                          </span>
                          <span className="block max-w-[22rem] truncate text-2xs text-subtle">
                            {MONITOR_KIND_LABELS[monitor.kind]}
                            {monitor.target ? ` · ${monitor.target}` : ''}
                          </span>
                        </span>
                      </button>
                    </td>
                    <td className="hidden max-w-[18rem] px-3 py-2 sm:table-cell">
                      <p className="truncate text-xs" title={monitor.lastMessage ?? undefined}>
                        {monitor.lastMessage ?? <span className="text-subtle">Not checked yet</span>}
                      </p>
                      <p className="text-2xs text-subtle" title={fullDateTime(monitor.lastCheckedAt)}>
                        {monitor.lastCheckedAt ? relativeTime(monitor.lastCheckedAt) : '—'}
                        {monitor.lastLatencyMs !== null && ` · ${monitor.lastLatencyMs} ms`}
                      </p>
                    </td>
                    <td className="tabular hidden px-3 py-2 text-right text-xs md:table-cell">{monitor.uptime24h === null ? '—' : `${monitor.uptime24h}%`}</td>
                    <td className="hidden px-3 py-2 md:table-cell">
                      <SeverityBadge severity={monitor.severity} />
                    </td>
                    <td className="hidden px-3 py-2 text-xs lg:table-cell">{monitor.teamName ?? <span className="text-subtle">—</span>}</td>
                    <td className="px-3 py-2 pr-4 text-right">
                      {canManage && (
                        <div className="flex justify-end gap-1">
                          {monitor.kind !== 'heartbeat' && (
                            <Button variant="ghost" size="sm" loading={busy === monitor.id} onClick={() => checkNow(monitor)} aria-label={`Check ${monitor.name} now`}>
                              <RefreshCw className="size-3.5" />
                              <span className="hidden sm:inline">Check</span>
                            </Button>
                          )}
                          <Menu
                            trigger={({ toggle }) => (
                              <Button variant="ghost" size="icon" onClick={toggle} aria-label={`Actions for ${monitor.name}`}>
                                <MoreHorizontal className="size-4" />
                              </Button>
                            )}
                            items={[
                              { label: 'Edit', onSelect: () => setEditing(monitor) },
                              {
                                label: monitor.enabled ? 'Pause' : 'Resume',
                                icon: monitor.enabled ? Pause : Play,
                                onSelect: () => void togglePause(monitor),
                              },
                              { label: 'Delete', icon: Trash2, destructive: true, onSelect: () => setDeleting(monitor) },
                            ]}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(creating || editing) && (
        <MonitorDialog
          monitor={editing}
          teams={teams}
          policies={policies}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async (saved) => {
            setCreating(false);
            setEditing(null);
            await load();
            toast.success('Monitor saved.');
            if (saved.kind === 'heartbeat') setViewing(saved);
          }}
        />
      )}

      {viewing && <MonitorDetail monitorId={viewing.id} onClose={() => setViewing(null)} />}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name ?? ''}?`}
        message="Its check history goes with it. Incidents it already opened stay as they are."
        confirmLabel="Delete monitor"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await opsApi.monitors.remove(deleting.id);
            setDeleting(null);
            await load();
            toast.success('Monitor deleted.');
          } catch (caught) {
            toast.error('Could not delete', message(caught, ''));
          }
        }}
      />
    </>
  );
}

function toInput(monitor: Monitor): MonitorInput {
  const { name, kind, target, config, intervalSecs, graceSecs, failureThreshold, teamId, severity, escalationPolicyId, enabled } = monitor;
  return { name, kind, target, config, intervalSecs, graceSecs, failureThreshold, teamId, severity, escalationPolicyId, enabled };
}

const INTERVALS = [
  { value: 30, label: 'Every 30 seconds' },
  { value: 60, label: 'Every minute' },
  { value: 300, label: 'Every 5 minutes' },
  { value: 900, label: 'Every 15 minutes' },
  { value: 3600, label: 'Every hour' },
  { value: 86400, label: 'Once a day' },
];

const HEARTBEAT_PERIODS = [
  { value: 300, label: 'Every 5 minutes' },
  { value: 900, label: 'Every 15 minutes' },
  { value: 3600, label: 'Hourly' },
  { value: 21600, label: 'Every 6 hours' },
  { value: 86400, label: 'Daily' },
  { value: 604800, label: 'Weekly' },
];

const TARGET_LABELS: Partial<Record<MonitorKind, { label: string; placeholder: string; hint?: string }>> = {
  http: { label: 'URL', placeholder: 'https://shop.example.com/health' },
  tcp: { label: 'Host and port', placeholder: 'db.internal:5432' },
  ping: { label: 'Host', placeholder: 'gateway.internal or 10.0.0.1' },
  dns: { label: 'Hostname', placeholder: 'example.com' },
  ssl: { label: 'Hostname', placeholder: 'example.com or example.com:8443', hint: 'The certificate served on port 443 unless you give another.' },
};

function headersToText(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

function textToHeaders(text: string): Record<string, string> | undefined {
  const entries = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf(':');
      return index > 0 ? ([line.slice(0, index).trim(), line.slice(index + 1).trim()] as const) : null;
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function MonitorDialog({
  monitor,
  teams,
  policies,
  onClose,
  onSaved,
}: {
  monitor: Monitor | null;
  teams: Team[];
  policies: EscalationPolicy[];
  onClose: () => void;
  onSaved: (monitor: Monitor) => void;
}) {
  const [form, setForm] = useState<MonitorInput>(
    monitor
      ? toInput(monitor)
      : {
          name: '',
          kind: 'http',
          target: '',
          config: {},
          intervalSecs: 60,
          graceSecs: 300,
          failureThreshold: 2,
          teamId: teams[0]?.id ?? null,
          severity: 'sev2',
          escalationPolicyId: null,
          enabled: true,
        },
  );
  const [headersText, setHeadersText] = useState(headersToText(monitor?.config.headers));
  const [databases, setDatabases] = useState<BackupJob[] | null>(null);
  const [databaseError, setDatabaseError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const set = <K extends keyof MonitorInput>(key: K, value: MonitorInput[K]) => setForm((current) => ({ ...current, [key]: value }));
  const setConfig = <K extends keyof MonitorConfig>(key: K, value: MonitorConfig[K]) =>
    setForm((current) => ({ ...current, config: { ...current.config, [key]: value } }));

  useEffect(() => {
    if (form.kind !== 'database' || databases) return;
    opsApi.databases
      .list()
      .then((r) => setDatabases(r.databases))
      .catch((caught) => {
        setDatabases([]);
        setDatabaseError(
          caught instanceof ApiError && caught.status === 403
            ? 'Only people who manage backups can see the database connectors. Ask one of them to add this monitor.'
            : message(caught, 'Could not load the database connectors.'),
        );
      });
  }, [form.kind, databases]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    const input: MonitorInput = {
      ...form,
      target: form.kind === 'heartbeat' || form.kind === 'database' ? '' : form.target.trim(),
      config: { ...form.config, headers: form.kind === 'http' ? textToHeaders(headersText) : undefined },
    };
    try {
      const result = monitor ? await opsApi.monitors.update(monitor.id, input) : await opsApi.monitors.create(input);
      onSaved(result.monitor);
    } catch (caught) {
      setError(message(caught, 'Could not save the monitor.'));
      if (caught instanceof ApiError && caught.details) setFieldErrors(caught.details);
    } finally {
      setSaving(false);
    }
  };

  const target = TARGET_LABELS[form.kind];
  const isHeartbeat = form.kind === 'heartbeat';

  return (
    <Modal
      open
      onClose={onClose}
      title={monitor ? `Edit ${monitor.name}` : 'New monitor'}
      description="Checks run from this server. A monitor is marked down only after the failure threshold is reached."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving}>
            {monitor ? 'Save changes' : 'Create monitor'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <p className="rounded-sm border border-[var(--priority-urgent)]/30 bg-[var(--priority-urgent)]/5 px-3 py-2 text-xs text-[var(--priority-urgent)]">{error}</p>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required error={fieldErrors.name}>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Checkout API" />
          </Field>
          <Field label="Type">
            <Select value={form.kind} onChange={(e) => set('kind', e.target.value as MonitorKind)} disabled={Boolean(monitor)}>
              {MONITOR_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {MONITOR_KIND_LABELS[kind]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {target && (
          <Field label={target.label} required hint={target.hint} error={fieldErrors.target}>
            <Input value={form.target} onChange={(e) => set('target', e.target.value)} placeholder={target.placeholder} />
          </Field>
        )}

        {form.kind === 'http' && (
          <div className="space-y-4 rounded-md border p-3 surface-2">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Method">
                <Select value={form.config.method ?? 'GET'} onChange={(e) => setConfig('method', e.target.value as MonitorConfig['method'])}>
                  {['GET', 'HEAD', 'POST', 'PUT'].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Expected status" hint="e.g. 200-299 or 200,204">
                <Input value={form.config.expectedStatus ?? ''} onChange={(e) => setConfig('expectedStatus', e.target.value || undefined)} placeholder="200-399" />
              </Field>
              <Field label="Slower than (ms) fails">
                <Input
                  type="number"
                  min={0}
                  value={form.config.maxResponseMs ?? ''}
                  onChange={(e) => setConfig('maxResponseMs', e.target.value ? Number(e.target.value) : undefined)}
                  placeholder="No limit"
                />
              </Field>
            </div>
            <Field label="Response must contain" hint="Optional text the page has to include.">
              <Input value={form.config.keyword ?? ''} onChange={(e) => setConfig('keyword', e.target.value || undefined)} placeholder='"status":"ok"' />
            </Field>
            {form.config.keyword && (
              <Checkbox
                label="Fail when the text is present instead"
                checked={Boolean(form.config.keywordInverted)}
                onChange={(e) => setConfig('keywordInverted', e.target.checked)}
              />
            )}
            <Field label="Request headers" hint="One per line, as Name: value. Use this for bearer tokens or API keys.">
              <Textarea rows={2} value={headersText} onChange={(e) => setHeadersText(e.target.value)} placeholder="Authorization: Bearer …" className="font-mono text-xs" />
            </Field>
            {(form.config.method === 'POST' || form.config.method === 'PUT') && (
              <Field label="Request body">
                <Textarea rows={3} value={form.config.body ?? ''} onChange={(e) => setConfig('body', e.target.value || undefined)} className="font-mono text-xs" />
              </Field>
            )}
          </div>
        )}

        {form.kind === 'dns' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Record type">
              <Select value={form.config.recordType ?? 'A'} onChange={(e) => setConfig('recordType', e.target.value as MonitorConfig['recordType'])}>
                {['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Select>
            </Field>
            <Field label="Expected value" hint="Optional. Fails if no record matches.">
              <Input value={form.config.expectedValue ?? ''} onChange={(e) => setConfig('expectedValue', e.target.value || undefined)} placeholder="203.0.113.10" />
            </Field>
          </div>
        )}

        {form.kind === 'ssl' && (
          <Field label="Warn this many days before expiry" hint="The monitor goes down (and pages) once the certificate is this close to expiring.">
            <Input type="number" min={1} max={120} value={form.config.warnDays ?? 14} onChange={(e) => setConfig('warnDays', Number(e.target.value))} />
          </Field>
        )}

        {form.kind === 'database' && (
          <Field label="Database" required error={fieldErrors.databaseId} hint={databaseError ?? 'Connects, runs a light query, and reports latency, connections and replication lag.'}>
            <Select value={form.config.databaseId ?? ''} onChange={(e) => setConfig('databaseId', e.target.value || undefined)} disabled={!databases?.length}>
              <option value="">{databases === null ? 'Loading…' : databases.length ? 'Choose a database' : 'No databases connected'}</option>
              {databases?.map((db) => (
                <option key={db.id} value={db.id}>
                  {db.name} ({db.engine})
                </option>
              ))}
            </Select>
          </Field>
        )}

        {isHeartbeat ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="The job runs" hint="How often a ping is expected.">
              <Select value={form.intervalSecs} onChange={(e) => set('intervalSecs', Number(e.target.value))}>
                {(HEARTBEAT_PERIODS.some((p) => p.value === form.intervalSecs) ? HEARTBEAT_PERIODS : [...HEARTBEAT_PERIODS, { value: form.intervalSecs, label: `Every ${form.intervalSecs}s` }]).map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Grace period (minutes)" hint="How late a ping may be before it counts as missed.">
              <Input type="number" min={0} value={Math.round(form.graceSecs / 60)} onChange={(e) => set('graceSecs', Number(e.target.value) * 60)} />
            </Field>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Check">
              <Select value={form.intervalSecs} onChange={(e) => set('intervalSecs', Number(e.target.value))}>
                {(INTERVALS.some((p) => p.value === form.intervalSecs) ? INTERVALS : [...INTERVALS, { value: form.intervalSecs, label: `Every ${form.intervalSecs}s` }]).map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Down after" hint="Consecutive failures before anyone is paged.">
              <Select value={form.failureThreshold} onChange={(e) => set('failureThreshold', Number(e.target.value))}>
                {[1, 2, 3, 5].map((n) => (
                  <option key={n} value={n}>
                    {n} failure{n === 1 ? '' : 's'} in a row
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}

        <div className="grid gap-4 border-t pt-4 sm:grid-cols-3">
          <Field label="Team">
            <Select value={form.teamId ?? ''} onChange={(e) => set('teamId', e.target.value || null)}>
              <option value="">No team</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Severity when down">
            <Select value={form.severity} onChange={(e) => set('severity', e.target.value as Severity)}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Escalation policy" hint="Empty uses the team's default.">
            <Select value={form.escalationPolicyId ?? ''} onChange={(e) => set('escalationPolicyId', e.target.value || null)}>
              <option value="">Team default</option>
              {policies.map((policy) => (
                <option key={policy.id} value={policy.id}>
                  {policy.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {form.severity === 'sev4' && <p className="text-xs text-subtle">SEV4 opens a ticket but never pages anyone.</p>}

        <Checkbox label="Enabled" hint="Paused monitors keep their history but are not checked." checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
      </div>
    </Modal>
  );
}

function MonitorDetail({ monitorId, onClose }: { monitorId: string; onClose: () => void }) {
  const [data, setData] = useState<{ monitor: Monitor; checks: MonitorCheck[]; days: MonitorDay[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    opsApi.monitors
      .get(monitorId)
      .then(setData)
      .catch((caught) => setError(message(caught, 'Could not load the monitor.')));
  }, [monitorId]);

  const monitor = data?.monitor;
  const uptime90 = useMemo(() => {
    const total = data?.days.reduce((sum, d) => sum + d.total, 0) ?? 0;
    const failures = data?.days.reduce((sum, d) => sum + d.failures, 0) ?? 0;
    return total ? (((total - failures) / total) * 100).toFixed(2) : null;
  }, [data]);

  return (
    <Modal open onClose={onClose} title={monitor?.name ?? 'Monitor'} description={monitor ? `${MONITOR_KIND_LABELS[monitor.kind]}${monitor.target ? ` · ${monitor.target}` : ''}` : undefined} size="lg">
      {error ? (
        <p className="text-xs text-[var(--priority-urgent)]">{error}</p>
      ) : !data || !monitor ? (
        <LoadingPane />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-2 text-sm font-medium">
              <StateDot state={monitor.state} />
              {STATE_LABELS[monitor.state]}
            </span>
            <SeverityBadge severity={monitor.severity} />
            <span className="text-xs text-muted">since {monitor.lastChangeAt ? relativeTime(monitor.lastChangeAt) : '—'}</span>
          </div>

          {monitor.heartbeatUrl && <HeartbeatInstructions url={monitor.heartbeatUrl} />}

          <section>
            <div className="mb-1.5 flex items-baseline justify-between">
              <p className="eyebrow">Last 90 days</p>
              <p className="tabular text-2xs text-muted">{uptime90 === null ? 'No data yet' : `${uptime90}% uptime`}</p>
            </div>
            <UptimeBars days={data.days} />
          </section>

          <section>
            <p className="eyebrow mb-1.5">Recent checks</p>
            {data.checks.length === 0 ? (
              <p className="text-xs text-subtle">No checks yet.</p>
            ) : (
              <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
                {data.checks.map((check) => (
                  <li key={check.id} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                    <span className="size-2 shrink-0 rounded-full" style={{ background: check.ok ? '#16a34a' : '#dc2626' }} />
                    <time className="w-24 shrink-0 text-subtle" title={fullDateTime(check.createdAt)}>
                      {shortDateTime(check.createdAt)}
                    </time>
                    <span className="min-w-0 flex-1 truncate" title={check.message}>
                      {check.message}
                    </span>
                    <span className="tabular shrink-0 text-subtle">{check.latencyMs === null ? '' : `${check.latencyMs} ms`}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

function HeartbeatInstructions({ url }: { url: string }) {
  return (
    <section className="space-y-2 rounded-md border p-3 surface-2">
      <p className="text-xs font-medium">Ping this URL when the job finishes</p>
      <CopyField value={url} />
      <p className="text-2xs text-subtle">Examples — call it at the end of the job; call /fail to report an error with a message:</p>
      <pre className="overflow-x-auto rounded-sm border bg-[var(--surface)] p-2 font-mono text-2xs leading-relaxed">
        {`# cron: back up, then check in
0 2 * * *  /opt/backup.sh && curl -fsS -m 10 ${url}

# report a failure with its reason
curl -fsS -m 10 --data "exit code $?" ${url}/fail

# PowerShell
Invoke-RestMethod ${url}`}
      </pre>
    </section>
  );
}

/* ------------------------------ Alert sources ----------------------------- */

export const SOURCE_HINTS: Record<AlertSourceKind, string> = {
  generic: 'POST any JSON. Title, severity, status and dedup key are found automatically, or map them with JSON paths below.',
  aws_sns:
    'Create an SNS topic for your CloudWatch alarms (or an EventBridge rule for AWS Health) and add an HTTPS subscription to this URL. The subscription is confirmed automatically and every message signature is verified.',
  azure_monitor: 'In an Azure Monitor action group, add a Webhook action with this URL and turn on "Enable the common alert schema". Resolved alerts close the incident.',
  cloudflare: 'In Cloudflare: Notifications → Destinations → Webhooks → Create, paste this URL, then attach it to the notifications you want.',
  jenkins: 'Use the Notification plugin (JSON, HTTP) or a post-build "curl -X POST -H \'Content-Type: application/json\' -d \'{"name":"$JOB_NAME","build":{"status":"FAILURE"}}\'" step. A SUCCESS build resolves the incident.',
  grafana: 'Add a webhook contact point (Grafana) or a webhook_configs receiver (Prometheus Alertmanager) pointing at this URL. Each alert in a batch is tracked separately by fingerprint.',
  digitalocean: 'DigitalOcean has no native webhook for every product; use a Monitoring alert policy with a Slack-compatible webhook or a small forwarder posting JSON here.',
  entra_id: 'Forward Microsoft 365 service health or Entra ID alerts (e.g. via a Logic App or Power Automate flow) as JSON to this URL.',
  stratigix: 'Post Stratigix alerts as JSON to this URL and map the fields below until a native connector is available.',
};

const MAPPABLE: AlertSourceKind[] = ['generic', 'stratigix', 'digitalocean', 'entra_id'];

function SourcesTab({ canManage, teams, policies }: { canManage: boolean; teams: Team[]; policies: EscalationPolicy[] }) {
  const toast = useToast();
  const [sources, setSources] = useState<AlertSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AlertSource | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AlertSource | null>(null);
  const [rotating, setRotating] = useState<AlertSource | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSources((await opsApi.sources.list()).sources);
    } catch (caught) {
      setError(message(caught, 'Could not load alert sources.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sendTest = async (source: AlertSource) => {
    try {
      const { result } = await opsApi.sources.test(source.id);
      toast.success(
        'Test alert sent',
        result.paged ? 'An incident was opened and the on-call is being paged.' : result.ticketId ? 'An incident was opened. Nobody was paged.' : `Result: ${result.action}`,
      );
      await load();
    } catch (caught) {
      toast.error('Test failed', message(caught, ''));
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 sm:px-6">
        <p className="text-xs text-muted">Every source gets its own secret URL. Anything that can POST JSON can raise an alert.</p>
        {canManage && (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            New source
          </Button>
        )}
      </div>

      {error ? (
        <ErrorPane message={error} retry={load} />
      ) : loading ? (
        <LoadingPane label="Loading sources" />
      ) : sources.length === 0 ? (
        <EmptyState
          icon={Webhook}
          title="No alert sources yet"
          description="Connect AWS CloudWatch, Azure Monitor, Grafana, Jenkins, Cloudflare or anything that sends webhooks."
          action={
            canManage && (
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                Add a source
              </Button>
            )
          }
        />
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 p-4 sm:p-6 lg:grid-cols-2">
          {sources.map((source) => (
            <article key={source.id} className="min-w-0 rounded-md border p-4 surface">
              <header className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 truncate text-sm font-semibold">
                    {source.name}
                    {!source.enabled && <Badge dot={false}>Disabled</Badge>}
                  </h2>
                  <p className="text-2xs text-subtle">{ALERT_SOURCE_LABELS[source.kind]}</p>
                </div>
                {canManage && (
                  <Menu
                    trigger={({ toggle }) => (
                      <Button variant="ghost" size="icon" onClick={toggle} aria-label={`Actions for ${source.name}`}>
                        <MoreHorizontal className="size-4" />
                      </Button>
                    )}
                    items={[
                      { label: 'Edit', onSelect: () => setEditing(source) },
                      { label: 'Send test alert', icon: Send, onSelect: () => void sendTest(source) },
                      { label: 'Issue a new URL', icon: RefreshCw, onSelect: () => setRotating(source) },
                      { label: 'Delete', icon: Trash2, destructive: true, onSelect: () => setDeleting(source) },
                    ]}
                  />
                )}
              </header>
              {canManage && <CopyField value={source.webhookUrl} className="mt-3" />}
              <dl className="mt-3 grid grid-cols-3 gap-2 border-t pt-3 text-xs">
                <div>
                  <dt className="text-subtle">Last event</dt>
                  <dd title={fullDateTime(source.lastEventAt)}>{source.lastEventAt ? relativeTime(source.lastEventAt) : 'Never'}</dd>
                </div>
                <div>
                  <dt className="text-subtle">Events</dt>
                  <dd className="tabular">{source.eventCount}</dd>
                </div>
                <div>
                  <dt className="text-subtle">Team</dt>
                  <dd className="truncate">{source.teamName ?? '—'}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <SourceDialog
          source={editing}
          teams={teams}
          policies={policies}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditing(null);
            await load();
            toast.success('Alert source saved.');
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(rotating)}
        onClose={() => setRotating(null)}
        title="Issue a new URL?"
        message="The current URL stops working immediately. Update it wherever this source is configured."
        confirmLabel="Issue new URL"
        onConfirm={async () => {
          if (!rotating) return;
          try {
            await opsApi.sources.rotate(rotating.id);
            setRotating(null);
            await load();
            toast.success('New URL issued.');
          } catch (caught) {
            toast.error('Could not rotate', message(caught, ''));
          }
        }}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name ?? ''}?`}
        message="Its URL stops accepting alerts. Existing alerts and incidents are kept."
        confirmLabel="Delete source"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await opsApi.sources.remove(deleting.id);
            setDeleting(null);
            await load();
            toast.success('Alert source deleted.');
          } catch (caught) {
            toast.error('Could not delete', message(caught, ''));
          }
        }}
      />
    </>
  );
}

/** Also opened prefilled from the Integrations catalogue, for one-click alert sources. */
export function SourceDialog({
  source,
  teams,
  policies,
  onClose,
  onSaved,
  initialKind,
  initialName,
}: {
  source: AlertSource | null;
  teams: Team[];
  policies: EscalationPolicy[];
  onClose: () => void;
  onSaved: () => void;
  initialKind?: AlertSourceKind;
  initialName?: string;
}) {
  const [form, setForm] = useState<AlertSourceInput>(
    source
      ? { name: source.name, kind: source.kind, teamId: source.teamId, escalationPolicyId: source.escalationPolicyId, defaultSeverity: source.defaultSeverity, mapping: source.mapping, enabled: source.enabled }
      : { name: initialName ?? '', kind: initialKind ?? 'generic', teamId: teams[0]?.id ?? null, escalationPolicyId: null, defaultSeverity: 'sev3', mapping: {}, enabled: true },
  );
  const [resolvedText, setResolvedText] = useState((source?.mapping.resolvedValues ?? []).join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof AlertSourceInput>(key: K, value: AlertSourceInput[K]) => setForm((current) => ({ ...current, [key]: value }));
  const setMapping = (key: 'title' | 'summary' | 'severity' | 'dedupKey' | 'status', value: string) =>
    setForm((current) => ({ ...current, mapping: { ...current.mapping, [key]: value || undefined } }));

  const save = async () => {
    setSaving(true);
    setError(null);
    const resolvedValues = resolvedText
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    const input = { ...form, mapping: { ...form.mapping, resolvedValues: resolvedValues.length ? resolvedValues : undefined } };
    try {
      if (source) await opsApi.sources.update(source.id, input);
      else await opsApi.sources.create(input);
      onSaved();
    } catch (caught) {
      setError(message(caught, 'Could not save the source.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={source ? `Edit ${source.name}` : 'New alert source'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving}>
            {source ? 'Save changes' : 'Create source'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <p className="rounded-sm border border-[var(--priority-urgent)]/30 bg-[var(--priority-urgent)]/5 px-3 py-2 text-xs text-[var(--priority-urgent)]">{error}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Production CloudWatch" />
          </Field>
          <Field label="Sends from">
            <Select value={form.kind} onChange={(e) => set('kind', e.target.value as AlertSourceKind)}>
              {ALERT_SOURCE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {ALERT_SOURCE_LABELS[kind]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="rounded-sm border px-3 py-2 text-xs leading-relaxed text-muted surface-2">{SOURCE_HINTS[form.kind]}</p>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Team">
            <Select value={form.teamId ?? ''} onChange={(e) => set('teamId', e.target.value || null)}>
              <option value="">No team</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Default severity" hint="Used when the alert does not say.">
            <Select value={form.defaultSeverity} onChange={(e) => set('defaultSeverity', e.target.value as Severity)}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Escalation policy">
            <Select value={form.escalationPolicyId ?? ''} onChange={(e) => set('escalationPolicyId', e.target.value || null)}>
              <option value="">Team default</option>
              {policies.map((policy) => (
                <option key={policy.id} value={policy.id}>
                  {policy.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {MAPPABLE.includes(form.kind) && (
          <fieldset className="space-y-3 rounded-md border p-3 surface-2">
            <legend className="px-1 text-xs font-medium">Field mapping (optional)</legend>
            <p className="text-2xs text-subtle">Dot paths into the payload, e.g. alert.labels.severity or items[0].name. Leave empty to detect automatically.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ['title', 'Title', 'alert.name'],
                  ['summary', 'Summary', 'alert.description'],
                  ['severity', 'Severity', 'alert.severity'],
                  ['dedupKey', 'Dedup key', 'alert.id'],
                  ['status', 'Status', 'alert.state'],
                ] as const
              ).map(([key, label, placeholder]) => (
                <Field key={key} label={label}>
                  <Input value={form.mapping[key] ?? ''} onChange={(e) => setMapping(key, e.target.value)} placeholder={placeholder} className="font-mono text-xs" />
                </Field>
              ))}
              <Field label="Status values that mean resolved" hint="Comma separated. Default: resolved, ok, recovered…">
                <Input value={resolvedText} onChange={(e) => setResolvedText(e.target.value)} placeholder="resolved, ok" />
              </Field>
            </div>
          </fieldset>
        )}

        <Checkbox label="Enabled" hint="A disabled source answers 404 and records nothing." checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
      </div>
    </Modal>
  );
}

/* ---------------------------------- Alerts -------------------------------- */

const ALERT_STATUS_COLORS: Record<Alert['status'], string> = {
  firing: 'var(--priority-urgent)',
  acknowledged: 'var(--priority-high)',
  resolved: '#16a34a',
};

function AlertsTab() {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setAlerts((await opsApi.alerts.list(filter === 'open' ? { status: 'open' } : {})).alerts);
    } catch (caught) {
      setError(message(caught, 'Could not load alerts.'));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <>
      <div className="flex items-center justify-between gap-2 px-4 pt-4 sm:px-6">
        <SegmentedControl
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          <RefreshCw className="size-3.5" />
          Refresh
        </Button>
      </div>
      {error ? (
        <ErrorPane message={error} retry={load} />
      ) : loading ? (
        <LoadingPane label="Loading alerts" />
      ) : alerts.length === 0 ? (
        <EmptyState icon={BellRing} title={filter === 'open' ? 'No open alerts' : 'No alerts yet'} description="Alerts from monitors and sources appear here, deduplicated and grouped into incidents." />
      ) : (
        <div className="p-4 sm:p-6">
          <div className="overflow-x-auto rounded-md border surface">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b surface-2">
                  <th className="eyebrow px-3 py-2 pl-4 text-left font-medium">Severity</th>
                  <th className="eyebrow px-3 py-2 text-left font-medium">Alert</th>
                  <th className="eyebrow hidden px-3 py-2 text-left font-medium md:table-cell">Source</th>
                  <th className="eyebrow hidden px-3 py-2 text-right font-medium md:table-cell">Count</th>
                  <th className="eyebrow hidden px-3 py-2 text-left font-medium sm:table-cell">Status</th>
                  <th className="eyebrow hidden px-3 py-2 text-left font-medium md:table-cell">Last seen</th>
                  <th className="eyebrow px-3 py-2 pr-4 text-left font-medium">Incident</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((alert) => (
                  <tr key={alert.id} className="border-b last:border-b-0 hover:bg-[var(--surface-2)]">
                    <td className="px-3 py-2 pl-4">
                      <SeverityBadge severity={alert.severity} />
                    </td>
                    <td className="max-w-[10rem] px-3 py-2 sm:max-w-[22rem]">
                      <p className="truncate text-xs font-medium" title={alert.title}>
                        {alert.title}
                      </p>
                      {alert.summary && (
                        <p className="truncate text-2xs text-subtle" title={alert.summary}>
                          {alert.summary}
                        </p>
                      )}
                    </td>
                    <td className="hidden px-3 py-2 text-xs md:table-cell">
                      {alert.sourceName}
                      {alert.ruleName && <span className="block text-2xs text-subtle">via rule {alert.ruleName}</span>}
                    </td>
                    <td className="tabular hidden px-3 py-2 text-right text-xs md:table-cell">{alert.count}</td>
                    <td className="hidden px-3 py-2 sm:table-cell">
                      <div className="flex flex-wrap gap-1">
                        <Badge color={ALERT_STATUS_COLORS[alert.status]}>{alert.status}</Badge>
                        {alert.suppressed && <Badge dot={false}>Suppressed</Badge>}
                      </div>
                    </td>
                    <td className="hidden px-3 py-2 text-xs text-muted md:table-cell" title={fullDateTime(alert.lastSeenAt)}>
                      {shortDateTime(alert.lastSeenAt)}
                    </td>
                    <td className="px-3 py-2 pr-4 text-xs">
                      {alert.ticketId ? (
                        <Link to={`/tickets/${alert.ticketId}`} className="font-mono text-2xs text-[var(--accent)] hover:underline">
                          {alert.ticketReference ?? 'Open'}
                        </Link>
                      ) : (
                        <span className="text-subtle">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

