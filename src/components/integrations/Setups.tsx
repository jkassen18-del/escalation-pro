import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Plus, Send } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { opsApi } from '@/lib/ops-api';
import { setupApi, type SlackSetup, type TeamsConsentState } from '@/lib/integrations-setup-api';
import { shortDateTime } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { CopyField } from '@/components/ops/MonitorShared';
import { DataSourcePanel } from '@/components/DataSourcePanel';
import { HttpIntegrationsPanel } from '@/components/HttpIntegrationsPanel';
import { SsoSettings } from '@/components/SsoSettings';
import { SourceDialog } from '@/pages/Monitors';
import { Step, Steps } from './SetupDrawer';
import { TeamsAppPanel } from './TeamsAppPanel';
import { SOURCE_STEPS, type CatalogueTile } from './catalogue';
import { ALERT_SOURCE_LABELS, type AlertSource, type EscalationPolicy } from '@shared/ops';
import type { Team } from '@shared/types';

const errorText = (caught: unknown, fallback: string) => (caught instanceof ApiError ? caught.message : fallback);

function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'ok' | 'error'; children: ReactNode }) {
  const color = tone === 'warn' ? 'var(--priority-high)' : tone === 'ok' ? 'var(--status-resolved)' : tone === 'error' ? 'var(--priority-urgent)' : 'var(--fg-subtle)';
  return (
    <p className="rounded-sm border px-3 py-2 text-xs leading-relaxed" style={{ borderColor: `color-mix(in srgb, ${color} 35%, transparent)`, color: tone === 'info' ? 'var(--fg-muted)' : color }}>
      {children}
    </p>
  );
}

function ExternalButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-xs font-medium hover:bg-[var(--surface-3)]">
      {children}
      <ExternalLink className="size-3" />
    </a>
  );
}

/* ---------------------------------- Slack --------------------------------- */

/**
 * Slack in four steps: create the app from a generated manifest, paste its
 * three credentials back once, Add to Slack, pick a channel. The manual
 * webhook / bot-token form stays available underneath for anyone who prefers it.
 */
export function SlackSetup({ result, card }: { result: URLSearchParams; card: ReactNode; onChanged?: () => void }) {
  const toast = useToast();
  const [setup, setSetup] = useState<SlackSetup | null>(null);
  const [form, setForm] = useState({ clientId: '', clientSecret: '', signingSecret: '', command: '', appName: '' });
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [showManual, setShowManual] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await setupApi.slack.setup();
      setSetup(next);
      setForm((f) => ({ ...f, clientId: next.app.clientId ?? '', command: next.app.command, appName: next.app.appName }));
    } catch (caught) {
      toast.error('Could not load Slack setup', errorText(caught, ''));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!setup) return <p className="text-xs text-subtle">Loading…</p>;
  const { app } = setup;
  const credentialsSaved = Boolean(app.clientId && app.hasClientSecret && app.hasSigningSecret);

  const saveCredentials = async () => {
    setSaving(true);
    try {
      await setupApi.slack.saveApp(form);
      setForm((f) => ({ ...f, clientSecret: '', signingSecret: '' }));
      await load();
      toast.success('Slack app details saved');
    } catch (caught) {
      toast.error('Could not save', errorText(caught, ''));
    } finally {
      setSaving(false);
    }
  };

  const install = async () => {
    setInstalling(true);
    try {
      const { url } = await setupApi.slack.startInstall();
      window.location.assign(url);
    } catch (caught) {
      toast.error('Could not start the install', errorText(caught, ''));
      setInstalling(false);
    }
  };

  return (
    <div className="space-y-5">
      {result.get('slack') === 'installed' && <Notice tone="ok">Added to Slack workspace “{result.get('team')}”. Now pick each department's channel below.</Notice>}
      {result.get('slack') === 'error' && <Notice tone="error">{result.get('reason') ?? 'The Slack install did not finish.'}</Notice>}
      {!setup.publicUrl && (
        <Notice tone="warn">
          InfraTicket is at <span className="font-mono">{setup.base}</span>, which Slack cannot reach from the internet. Notifications will work; replies in threads, buttons and
          the slash command need a public https address (a port forward, reverse proxy or tunnel). Set it under Settings → App URL, then come back: the manifest updates itself.
        </Notice>
      )}

      <Steps>
        <Step n={1} title="Create the Slack app" done={Boolean(app.clientId)}>
          <p>Opens Slack with the app already described: name, permissions{setup.publicUrl ? ', events, buttons and the slash command' : ''}. Pick your workspace and click Create.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="App name">
              <Input value={form.appName} onChange={(e) => setForm((f) => ({ ...f, appName: e.target.value }))} maxLength={35} />
            </Field>
            {setup.publicUrl && (
              <Field label="Slash command">
                <Input value={form.command} onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))} className="font-mono text-xs" placeholder="/gml" />
              </Field>
            )}
          </div>
          {(form.appName !== app.appName || (setup.publicUrl && form.command !== app.command)) && (
            <Button size="sm" variant="secondary" onClick={saveCredentials} loading={saving}>
              Update the manifest
            </Button>
          )}
          <div>
            <ExternalButton href={setup.createUrl}>Create the Slack app</ExternalButton>
          </div>
          <details className="min-w-0 text-2xs">
            <summary className="cursor-pointer text-[var(--accent)]">Show the manifest</summary>
            <pre className="mt-2 max-h-56 max-w-full overflow-auto rounded-sm border p-2 font-mono text-2xs surface-2">{JSON.stringify(setup.manifest, null, 2)}</pre>
          </details>
        </Step>

        <Step n={2} title="Paste the app's credentials" done={credentialsSaved}>
          <p>
            In the new app, open <b>Settings → Basic Information → App Credentials</b> and copy the Client ID, Client Secret and Signing Secret. They are stored encrypted and
            never shown again.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Client ID">
              <Input value={form.clientId} onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))} className="font-mono text-xs" placeholder="1234567890.1234567890" />
            </Field>
            <Field label="Client Secret">
              <Input type="password" value={form.clientSecret} onChange={(e) => setForm((f) => ({ ...f, clientSecret: e.target.value }))} placeholder={app.hasClientSecret ? 'Saved' : ''} />
            </Field>
            <Field label="Signing Secret">
              <Input type="password" value={form.signingSecret} onChange={(e) => setForm((f) => ({ ...f, signingSecret: e.target.value }))} placeholder={app.hasSigningSecret ? 'Saved' : ''} />
            </Field>
          </div>
          <Button size="sm" onClick={saveCredentials} loading={saving} disabled={!form.clientId}>
            Save
          </Button>
        </Step>

        <Step n={3} title="Add to Slack" done={app.hasBotToken}>
          <p>Approve the permissions in Slack; you come straight back here.{app.installedTeam ? ` Installed in “${app.installedTeam}”${app.installedAt ? ` on ${shortDateTime(app.installedAt)}` : ''}.` : ''}</p>
          <Button size="sm" variant={app.hasBotToken ? 'secondary' : 'primary'} onClick={install} loading={installing} disabled={!credentialsSaved}>
            {app.hasBotToken ? 'Reinstall' : 'Add to Slack'}
          </Button>
        </Step>

        <Step n={4} title="Choose each department's channel" done={app.hasBotToken}>
          <p>
            Below, under <b>Where each department's tickets go</b>, pick a channel for every department, then send a test to all of them at once. Departments you leave
            blank use "Everything else", which can also be set to post nothing.
          </p>
        </Step>
      </Steps>

      <div className="border-t pt-4">
        <button type="button" className="text-xs text-[var(--accent)] hover:underline" onClick={() => setShowManual((v) => !v)}>
          {showManual ? 'Hide' : 'Show'} manual setup (incoming webhook or existing bot token) and notification events
        </button>
        {showManual && <div className="mt-3">{card}</div>}
      </div>
    </div>
  );
}

/* ----------------------------- Microsoft Teams ----------------------------- */

export function TeamsSetup({ result, card }: { result: URLSearchParams; card: ReactNode }) {
  const toast = useToast();
  const [state, setState] = useState<TeamsConsentState | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    void setupApi.teams.consent().then(setState).catch(() => setState(null));
  }, []);

  const consent = async () => {
    setStarting(true);
    try {
      const { url } = await setupApi.teams.startConsent();
      window.location.assign(url);
    } catch (caught) {
      toast.error('Could not start consent', errorText(caught, ''));
      setStarting(false);
    }
  };

  return (
    <div className="space-y-5">
      {result.get('consent') === 'granted' && <Notice tone="ok">Admin consent granted. The bot can now use the permissions its app registration asks for.</Notice>}
      {result.get('consent') === 'failed' && <Notice tone="error">{result.get('reason') ?? 'Admin consent was not granted.'}</Notice>}
      <Steps>
        <Step n={1} title="Register the bot and enter its details" done={Boolean(state?.appId)}>
          <p>
            Create a free <b>Azure Bot</b> (Single tenant) in the Azure portal, add the Microsoft Teams channel, and set its messaging endpoint to{' '}
            <span className="font-mono">…/api/webhooks/msteams</span>. Paste its Microsoft App ID, client secret and tenant ID below and test.
          </p>
          <div>{card}</div>
        </Step>
        <Step n={2} title="Approve permissions (admin consent)" done={Boolean(state?.consent.grantedAt)}>
          <p>
            A Global or Cloud Application Administrator approves everything the bot's app registration asks for in one click. First add this redirect URI to the app registration (Authentication → Add a
            platform → Web):
          </p>
          {state && <CopyField value={state.redirectUrl} />}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant={state?.consent.grantedAt ? 'secondary' : 'primary'} onClick={consent} loading={starting} disabled={!state?.appId}>
              {state?.consent.grantedAt ? 'Run admin consent again' : 'Grant admin consent'}
            </Button>
            {state?.consent.grantedAt && <span className="text-2xs text-subtle">Granted {shortDateTime(state.consent.grantedAt)}</span>}
            {state?.consent.error && !state.consent.grantedAt && <span className="text-2xs text-[var(--priority-urgent)]">{state.consent.error}</span>}
          </div>
        </Step>
        <Step n={3} title="Install, update and customise the Teams app">
          <TeamsAppPanel appConfigured={Boolean(state?.appId)} />
        </Step>
        <Step n={4} title="Optional: ring on-call people in Teams">
          <p>
            Teams calls are set up on the <Link to="/oncall" className="text-[var(--accent)] hover:underline">On-call → Phone &amp; SMS</Link> tab.
          </p>
        </Step>
      </Steps>
    </div>
  );
}

/* ---------------------------- Monitoring sources --------------------------- */

export function SourceSetup({ tile }: { tile: CatalogueTile }) {
  const toast = useToast();
  const kind = tile.sourceKind!;
  const [sources, setSources] = useState<AlertSource[] | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [policies, setPolicies] = useState<EscalationPolicy[]>([]);
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [list, teamList, policyList] = await Promise.all([
      opsApi.sources.list(),
      api.teams.list().catch(() => ({ teams: [] as Team[] })),
      opsApi.policies.list().catch(() => ({ policies: [] as EscalationPolicy[] })),
    ]);
    setSources(list.sources.filter((s) => s.kind === kind));
    setTeams(teamList.teams);
    setPolicies(policyList.policies);
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const test = async (source: AlertSource) => {
    setTesting(source.id);
    try {
      const { result } = await opsApi.sources.test(source.id);
      toast.success('Test alert sent', result.paged ? 'It opened an incident and paged the on-call person.' : 'It opened an incident.');
    } catch (caught) {
      toast.error('Test failed', errorText(caught, ''));
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-5">
      <Steps>
        <Step n={1} title={`Create the ${tile.name} source`} done={Boolean(sources?.length)}>
          <p>Choose which department its alerts belong to and how severe they are by default. Each source gets its own secret webhook URL.</p>
          <Button size="sm" variant={sources?.length ? 'secondary' : 'primary'} onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            {sources?.length ? 'Add another' : 'Create source'}
          </Button>
        </Step>
        <Step n={2} title={`Point ${tile.name} at it`}>
          <ol className="list-decimal space-y-1 pl-4">
            {SOURCE_STEPS[kind].map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
          {sources?.map((source) => (
            <div key={source.id} className="space-y-1.5 rounded-sm border p-2.5 surface-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-[var(--fg)]">{source.name}</span>
                <span className="text-2xs text-subtle">{source.eventCount ? `${source.eventCount} alerts · last ${shortDateTime(source.lastEventAt!)}` : 'No alerts yet'}</span>
              </div>
              <CopyField value={source.webhookUrl} />
              <Button size="sm" variant="ghost" onClick={() => test(source)} loading={testing === source.id}>
                <Send className="size-3.5" />
                Send a test alert
              </Button>
            </div>
          ))}
        </Step>
        <Step n={3} title="Check it arrived" done={Boolean(sources?.some((s) => s.eventCount > 0))}>
          <p>
            Trigger a test from {tile.name} (most have a "Test" button next to the webhook). The source shows its first alert here, and the incident appears under{' '}
            <Link to="/monitors" className="text-[var(--accent)] hover:underline">Monitoring → Alerts</Link>.
          </p>
        </Step>
      </Steps>
      {creating && (
        <SourceDialog
          source={null}
          teams={teams}
          policies={policies}
          initialKind={kind}
          initialName={ALERT_SOURCE_LABELS[kind].replace(/ \(.*\)$/, '')}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------ Developer tiles ---------------------------- */

export function DeveloperSetup({ tile, onChanged }: { tile: CatalogueTile; onChanged: () => void }) {
  const [teams, setTeams] = useState<Team[]>([]);
  useEffect(() => {
    if (tile.kind === 'sso') void api.teams.list().then((r) => setTeams(r.teams)).catch(() => undefined);
  }, [tile.kind]);

  switch (tile.kind) {
    case 'custom_http':
      return <HttpIntegrationsPanel onChanged={onChanged} />;
    case 'lookups':
      return <DataSourcePanel />;
    case 'sso':
      return <SsoSettings teams={teams} />;
    case 'heartbeats':
      return (
        <Steps>
          <Step n={1} title="Create a heartbeat monitor">
            <p>
              On <Link to="/monitors" className="text-[var(--accent)] hover:underline">Monitoring → Monitors</Link>, choose New monitor → Heartbeat, and set how often the job runs plus a grace period.
            </p>
          </Step>
          <Step n={2} title="Ping it when the job succeeds">
            <p>Add one line to the end of the job, e.g. <span className="font-mono">curl -fsS https://…/api/heartbeat/&lt;token&gt;</span>, and <span className="font-mono">…/fail</span> to report a failure.</p>
          </Step>
          <Step n={3} title="That's it">
            <p>If the ping does not arrive on time, the job's team is paged like any other incident.</p>
          </Step>
        </Steps>
      );
    case 'databases':
      return (
        <Steps>
          <Step n={1} title="Add the database">
            <p>
              On <Link to="/databases" className="text-[var(--accent)] hover:underline">Databases</Link>, add the connection and press Test. Use a read-only backup account; the form shows the SQL to
              create one.
            </p>
          </Step>
          <Step n={2} title="Choose the schedule and where backups go">
            <p>Nightly by default, to this server's disk or any S3-compatible storage (MinIO is free and self-hosted).</p>
          </Step>
          <Step n={3} title="Watch its health">
            <p>Each database gets a heartbeat monitor that pages if backups stop, and can have a database health monitor too.</p>
          </Step>
        </Steps>
      );
    default:
      return null;
  }
}
