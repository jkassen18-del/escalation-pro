import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Plus, Send, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/state/auth';
import { useToast } from '@/components/ui/Toast';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { LoadingPane } from '@/components/ui/Feedback';
import { SourceIcon, SOURCE_LABELS } from '@/components/BrandIcons';
import { useDocumentTitle } from '@/state/branding';
import { relativeTime } from '@/lib/format';
import {
  ALERT_SOURCE_KINDS,
  PROBE_AUTH_KINDS,
  type Alert,
  type AlertSeverity,
  type AlertSource,
  type Heartbeat,
  type Probe,
  type Team,
} from '@shared/types';

/**
 * InfraGrid: everything watching the estate, in one place.
 *
 * The grid answers one question first - is anything on fire - so firing
 * alerts come before the inventory of what is connected. A source with
 * nothing wrong is deliberately quiet.
 */

const SEVERITY_STYLE: Record<AlertSeverity, string> = {
  critical: 'text-[var(--priority-urgent)] border-[var(--priority-urgent)]/40 bg-[var(--priority-urgent)]/10',
  warning: 'text-[var(--priority-high)] border-[var(--priority-high)]/40 bg-[var(--priority-high)]/10',
  info: 'text-muted border-[var(--border)] bg-[var(--surface)]',
};

export function InfraGridPage() {
  useDocumentTitle('InfraGrid');
  const toast = useToast();
  const { can } = useAuth();
  const manage = can('integrations.manage');

  const [sources, setSources] = useState<AlertSource[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [heartbeats, setHeartbeats] = useState<Heartbeat[]>([]);
  const [probes, setProbes] = useState<Probe[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [issued, setIssued] = useState<{ label: string; url: string } | null>(null);

  const load = async () => {
    try {
      const [data, probeData] = await Promise.all([api.infragrid.overview(), api.infragrid.probes()]);
      setSources(data.sources);
      setAlerts(data.alerts);
      setHeartbeats(data.heartbeats);
      setProbes(probeData.probes);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not load InfraGrid.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    api.teams
      .list()
      .then((data) => setTeams(data.teams))
      .catch(() => undefined);
    /*
     * Polled rather than pushed. A monitoring board left open on a wall is
     * the whole point of it, and thirty seconds is soon enough for something
     * that already took a monitor a minute to notice.
     */
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (loading) return <LoadingPane label="Loading InfraGrid" />;

  const firing = alerts.filter((alert) => alert.status === 'firing');
  const origin = window.location.origin;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="InfraGrid"
          description="Every system watching the estate, and what they are reporting right now."
        />
        {manage && <TestAlert teams={teams} onSent={load} />}
      </div>

      {issued && (
        <div className="rounded-md border border-[var(--status-open)] bg-[var(--status-open)]/5 px-4 py-3">
          <p className="text-xs font-semibold">{issued.label} — copy this now, it is not shown again.</p>
          <code className="mt-2 block break-all rounded-sm bg-[var(--surface)] px-2.5 py-2 font-mono text-xs">
            {issued.url}
          </code>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setIssued(null)}>
            Done
          </Button>
        </div>
      )}

      {/* Firing first: the grid exists to answer "is anything wrong". */}
      <section className="rounded-md border surface">
        <header className="flex items-center justify-between border-b px-4 py-2.5">
          <h2 className="text-xs font-semibold">
            Firing now {firing.length > 0 && <span className="text-[var(--priority-urgent)]">({firing.length})</span>}
          </h2>
        </header>
        {firing.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted">Nothing is firing. Everything reporting is healthy.</p>
        ) : (
          <ul className="divide-y">
            {firing.map((alert) => (
              <li key={alert.id} className="flex items-start gap-3 px-4 py-3">
                <span className={`mt-0.5 shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_STYLE[alert.severity]}`}>
                  {alert.severity}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{alert.title}</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {alert.sourceName}
                    {alert.resource && ` · ${alert.resource}`}
                    {alert.occurrences > 1 && ` · ${alert.occurrences}×`}
                    {` · ${relativeTime(alert.lastSeenAt)}`}
                  </p>
                </div>
                {alert.ticketId && (
                  <Link to={`/tickets/${alert.ticketId}`} className="shrink-0 font-mono text-[11px] underline">
                    {alert.ticketReference}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Sources
        sources={sources}
        teams={teams}
        manage={manage}
        origin={origin}
        onChanged={load}
        onIssued={setIssued}
      />

      <Probes probes={probes} teams={teams} manage={manage} onChanged={load} />

      <Heartbeats
        heartbeats={heartbeats}
        teams={teams}
        manage={manage}
        origin={origin}
        onChanged={load}
        onIssued={setIssued}
      />
    </div>
  );
}

function Sources({
  sources,
  teams,
  manage,
  origin,
  onChanged,
  onIssued,
}: {
  sources: AlertSource[];
  teams: Team[];
  manage: boolean;
  origin: string;
  onChanged: () => void;
  onIssued: (value: { label: string; url: string }) => void;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('linux');
  const [teamId, setTeamId] = useState('');
  const [busy, setBusy] = useState(false);

  // Heartbeats have their own section; the auto-created source is not a thing
  // anybody connects by hand.
  const connectable = ALERT_SOURCE_KINDS.filter((value) => value !== 'heartbeat');
  const visible = sources.filter((source) => source.kind !== 'heartbeat');

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const created = await api.infragrid.createSource({
        name: name.trim(),
        kind,
        teamId: teamId || null,
      });
      onIssued({
        label: `Ingest URL for ${created.source.name}`,
        url: `${origin}/api/ingest/${created.token}`,
      });
      setName('');
      setAdding(false);
      onChanged();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not connect that system.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (source: AlertSource) => {
    try {
      await api.infragrid.removeSource(source.id);
      toast.success(`Disconnected ${source.name}.`);
      onChanged();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not disconnect it.');
    }
  };

  return (
    <section className="rounded-md border surface">
      <header className="flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-xs font-semibold">Connected systems</h2>
        {manage && (
          <Button size="sm" variant="ghost" onClick={() => setAdding((value) => !value)}>
            <Plus size={14} /> Connect a system
          </Button>
        )}
      </header>

      {adding && manage && (
        <div className="flex flex-wrap items-end gap-2 border-b bg-[var(--surface)] px-4 py-3">
          <Field label="Name" className="min-w-40 flex-1">
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Production Jenkins" />
          </Field>
          <Field label="System" className="min-w-44 flex-1">
            <Select value={kind} onChange={(event) => setKind(event.target.value)}>
              {connectable.map((value) => (
                <option key={value} value={value}>
                  {SOURCE_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Route alerts to" className="min-w-40 flex-1">
            <Select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
              <option value="">Default department</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button onClick={add} loading={busy} disabled={!name.trim()}>
            Connect
          </Button>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted">
          Nothing connected yet. Each system gets its own ingest URL to post alerts to.
        </p>
      ) : (
        <ul className="grid gap-px bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((source) => (
            <li key={source.id} className="flex items-start gap-3 bg-[var(--bg)] px-4 py-3">
              <SourceIcon kind={source.kind} className="mt-0.5 h-6 w-6 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{source.name}</p>
                <p className="text-[11px] text-muted">
                  {SOURCE_LABELS[source.kind]}
                  {source.teamName && ` → ${source.teamName}`}
                </p>
                <p className="mt-1 text-[11px]">
                  {!source.enabled ? (
                    <span className="text-muted">Disabled</span>
                  ) : source.firingCount ? (
                    <span className="text-[var(--priority-urgent)]">{source.firingCount} firing</span>
                  ) : source.lastEventAt ? (
                    <span className="text-muted">Healthy · heard {relativeTime(source.lastEventAt)}</span>
                  ) : (
                    <span className="text-muted">Never heard from</span>
                  )}
                </p>
              </div>
              {manage && (
                <button
                  onClick={() => remove(source)}
                  className="shrink-0 text-muted hover:text-[var(--priority-urgent)]"
                  aria-label={`Disconnect ${source.name}`}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Heartbeats({
  heartbeats,
  teams,
  manage,
  origin,
  onChanged,
  onIssued,
}: {
  heartbeats: Heartbeat[];
  teams: Team[];
  manage: boolean;
  origin: string;
  onChanged: () => void;
  onIssued: (value: { label: string; url: string }) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [minutes, setMinutes] = useState('60');
  const [teamId, setTeamId] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const created = await api.infragrid.createHeartbeat({
        name: name.trim(),
        periodSeconds: Math.max(60, Number(minutes) * 60),
        teamId: teamId || null,
      });
      onIssued({
        label: `Check-in URL for ${created.heartbeat.name}`,
        url: `${origin}/api/ingest/heartbeat/${created.heartbeat.slug}`,
      });
      setName('');
      onChanged();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not create the heartbeat.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-md border surface">
      <header className="border-b px-4 py-2.5">
        <h2 className="text-xs font-semibold">Heartbeats</h2>
        <p className="mt-0.5 text-xs text-muted">
          For jobs where silence is the failure. A cron that stops running sends nothing, so nothing else would notice.
        </p>
      </header>

      {manage && (
        <div className="flex flex-wrap items-end gap-2 border-b bg-[var(--surface)] px-4 py-3">
          <Field label="Name" className="min-w-40 flex-1">
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nightly backup" />
          </Field>
          <Field label="Expected every" className="min-w-28">
            <Select value={minutes} onChange={(event) => setMinutes(event.target.value)}>
              <option value="5">5 minutes</option>
              <option value="15">15 minutes</option>
              <option value="60">Hour</option>
              <option value="1440">Day</option>
              <option value="10080">Week</option>
            </Select>
          </Field>
          <Field label="Route to" className="min-w-40 flex-1">
            <Select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
              <option value="">Default department</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button onClick={add} loading={busy} disabled={!name.trim()}>
            Add
          </Button>
        </div>
      )}

      {heartbeats.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted">No heartbeats yet.</p>
      ) : (
        <ul className="divide-y">
          {heartbeats.map((heartbeat) => (
            <li key={heartbeat.id} className="flex items-center gap-3 px-4 py-2.5">
              <Activity
                size={14}
                className={
                  heartbeat.status === 'missed'
                    ? 'text-[var(--priority-urgent)]'
                    : heartbeat.status === 'ok'
                      ? 'text-[var(--status-resolved)]'
                      : 'text-muted'
                }
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{heartbeat.name}</p>
                <p className="text-[11px] text-muted">
                  Every {Math.round(heartbeat.periodSeconds / 60)} min ·{' '}
                  {heartbeat.status === 'missed'
                    ? 'Missed its window'
                    : heartbeat.lastBeatAt
                      ? `Last seen ${relativeTime(heartbeat.lastBeatAt)}`
                      : 'Waiting for the first check-in'}
                </p>
              </div>
              <code className="hidden shrink-0 font-mono text-[10px] text-muted sm:block">
                /api/ingest/heartbeat/{heartbeat.slug.slice(0, 8)}…
              </code>
              {manage && (
                <button
                  onClick={async () => {
                    await api.infragrid.removeHeartbeat(heartbeat.id);
                    onChanged();
                  }}
                  className="shrink-0 text-muted hover:text-[var(--priority-urgent)]"
                  aria-label={`Delete ${heartbeat.name}`}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * APIs this system calls out to and checks.
 *
 * The pull half of InfraGrid. A webhook only arrives while the far end is
 * well enough to send one, so a service that has fallen over entirely is
 * exactly what an inbound-only setup cannot see.
 */
function Probes({
  probes,
  teams,
  manage,
  onChanged,
}: {
  probes: Probe[];
  teams: Team[];
  manage: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: '',
    url: '',
    authKind: 'none',
    authName: '',
    authSecret: '',
    intervalSeconds: '300',
    teamId: '',
  });

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const add = async () => {
    if (!form.name.trim() || !form.url.trim()) return;
    setBusy(true);
    try {
      await api.infragrid.createProbe({
        name: form.name.trim(),
        url: form.url.trim(),
        authKind: form.authKind,
        authName: form.authName || null,
        authSecret: form.authSecret || null,
        intervalSeconds: Number(form.intervalSeconds),
        teamId: form.teamId || null,
      });
      setForm({ name: '', url: '', authKind: 'none', authName: '', authSecret: '', intervalSeconds: '300', teamId: '' });
      setAdding(false);
      onChanged();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not add that check.');
    } finally {
      setBusy(false);
    }
  };

  const runNow = async (probe: Probe) => {
    try {
      const { result } = await api.infragrid.runProbe(probe.id);
      if (result.ok) {
        toast.success(`${probe.name} answered ${result.statusCode} in ${result.latencyMs}ms.`);
      } else {
        // The whole point of running it by hand is to see why it failed.
        toast.error(`${probe.name}: ${result.error}`);
      }
      onChanged();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not run that check.');
    }
  };

  // Only these two kinds need somewhere to put a name.
  const needsName = form.authKind === 'header' || form.authKind === 'query';

  return (
    <section className="rounded-md border surface">
      <header className="flex items-center justify-between border-b px-4 py-2.5">
        <div>
          <h2 className="text-xs font-semibold">API health checks</h2>
          <p className="mt-0.5 text-xs text-muted">
            Polled from here. A webhook only arrives while the far end is well enough to send one.
          </p>
        </div>
        {manage && (
          <Button size="sm" variant="ghost" onClick={() => setAdding((value) => !value)}>
            <Plus size={14} /> Add a check
          </Button>
        )}
      </header>

      {adding && manage && (
        <div className="space-y-2 border-b bg-[var(--surface)] px-4 py-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Name" className="min-w-40 flex-1">
              <Input value={form.name} onChange={set('name')} placeholder="DigitalOcean API" />
            </Field>
            <Field label="URL" className="min-w-64 flex-[2]">
              <Input value={form.url} onChange={set('url')} placeholder="https://api.digitalocean.com/v2/account" />
            </Field>
            <Field label="Every" className="min-w-28">
              <Select value={form.intervalSeconds} onChange={set('intervalSeconds')}>
                <option value="60">Minute</option>
                <option value="300">5 minutes</option>
                <option value="900">15 minutes</option>
                <option value="3600">Hour</option>
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <Field label="Authentication" className="min-w-40 flex-1">
              <Select value={form.authKind} onChange={set('authKind')}>
                {PROBE_AUTH_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {AUTH_LABELS[kind]}
                  </option>
                ))}
              </Select>
            </Field>

            {needsName && (
              <Field label={form.authKind === 'header' ? 'Header name' : 'Parameter name'} className="min-w-40 flex-1">
                <Input value={form.authName} onChange={set('authName')} placeholder="X-Api-Key" />
              </Field>
            )}

            {form.authKind !== 'none' && (
              <Field
                label={form.authKind === 'basic' ? 'user:password' : 'Value'}
                className="min-w-48 flex-1"
                hint={form.authKind === 'basic' ? 'Encoded for you before it is sent.' : undefined}
              >
                <Input
                  type="password"
                  value={form.authSecret}
                  onChange={set('authSecret')}
                  className="font-mono text-xs"
                />
              </Field>
            )}

            <Field label="Route to" className="min-w-36 flex-1">
              <Select value={form.teamId} onChange={set('teamId')}>
                <option value="">Default department</option>
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Button onClick={add} loading={busy} disabled={!form.name.trim() || !form.url.trim()}>
              Add
            </Button>
          </div>
        </div>
      )}

      {probes.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted">
          No checks yet. Add one for any API you have credentials for — or none, if it needs no authentication.
        </p>
      ) : (
        <ul className="divide-y">
          {probes.map((probe) => (
            <li key={probe.id} className="flex items-center gap-3 px-4 py-2.5">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  probe.status === 'down'
                    ? 'bg-[var(--priority-urgent)]'
                    : probe.status === 'up'
                      ? 'bg-[var(--status-resolved)]'
                      : 'bg-[var(--border-strong)]'
                }`}
                aria-label={probe.status}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{probe.name}</p>
                <p className="truncate text-[11px] text-muted">
                  {probe.url}
                  {probe.authKind !== 'none' && ` · ${AUTH_LABELS[probe.authKind]}`}
                </p>
                {probe.status === 'down' && probe.lastError && (
                  <p className="mt-0.5 text-[11px] text-[var(--priority-urgent)]">{probe.lastError}</p>
                )}
              </div>
              <span className="hidden shrink-0 text-[11px] text-muted sm:block">
                {probe.lastCheckedAt
                  ? probe.status === 'up'
                    ? `${probe.lastLatencyMs}ms · ${relativeTime(probe.lastCheckedAt)}`
                    : relativeTime(probe.lastCheckedAt)
                  : 'Not checked yet'}
              </span>
              {manage && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => runNow(probe)}>
                    Run now
                  </Button>
                  <button
                    onClick={async () => {
                      await api.infragrid.removeProbe(probe.id);
                      onChanged();
                    }}
                    className="shrink-0 text-muted hover:text-[var(--priority-urgent)]"
                    aria-label={`Delete ${probe.name}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const AUTH_LABELS: Record<string, string> = {
  none: 'No authentication',
  bearer: 'Bearer token',
  basic: 'Basic auth',
  header: 'Custom header',
  query: 'Query parameter',
};

/**
 * Fires a synthetic alert down the real path.
 *
 * Each integration has a connection test of its own, but those prove the
 * credential works - not that an alert actually reaches a person, which also
 * depends on routing, on which events each integration subscribes to, and on
 * a ticket being created at all. This exercises the lot.
 */
function TestAlert({ teams, onSent }: { teams: Team[]; onSent: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [teamId, setTeamId] = useState('');

  const send = async () => {
    setBusy(true);
    try {
      const result = await api.infragrid.testAlert({ severity: 'critical', teamId: teamId || null });
      toast.success(
        result.ticketReference
          ? `Raised ${result.ticketReference}. Check email, Slack, Teams and Linear.`
          : 'Test alert recorded.',
      );
      onSent();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not send the test alert.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-end gap-2">
      <Field label="Test alert" className="min-w-36">
        <Select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
          <option value="">Default department</option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </Select>
      </Field>
      <Button variant="ghost" onClick={send} loading={busy}>
        <Send size={14} /> Send one
      </Button>
    </div>
  );
}
