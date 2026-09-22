import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, CircleDashed, ExternalLink, RefreshCw } from 'lucide-react';
import { ProviderIcon } from '@/components/BrandIcons';
import { DataSourcePanel } from '@/components/DataSourcePanel';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { relativeTime, shortDateTime } from '@/lib/format';
import { useToast } from '@/components/ui/Toast';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Select } from '@/components/ui/Field';
import { ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import type { IntegrationProvider, IntegrationSummary } from '@shared/types';
import { useDocumentTitle } from '@/state/branding';

const PROVIDER_META: Record<
  IntegrationProvider,
  { name: string; blurb: string; docsUrl: string; docsLabel: string }
> = {
  slack: {
    name: 'Slack',
    blurb: 'Post ticket activity into a Slack channel, either through an incoming webhook or a bot token.',
    docsUrl: 'https://api.slack.com/messaging/webhooks',
    docsLabel: 'Slack webhook guide',
  },
  msteams: {
    name: 'Microsoft Teams',
    blurb: 'Send adaptive cards to a Teams channel using a Power Automate workflow or a legacy connector.',
    docsUrl: 'https://support.microsoft.com/en-us/office/create-incoming-webhooks-with-workflows-for-microsoft-teams-8ae491c7-0394-4861-ba59-055e33f75498',
    docsLabel: 'Teams workflow guide',
  },
  linear: {
    name: 'Linear',
    blurb: 'Mirror escalations into Linear as tracked issues, and sync their status back automatically.',
    docsUrl: 'https://linear.app/settings/api',
    docsLabel: 'Create a Linear API key',
  },
  email: {
    name: 'Email (SMTP)',
    blurb: 'Email assignees, requesters, and watchers whenever a ticket they follow changes.',
    docsUrl: 'https://nodemailer.com/smtp/',
    docsLabel: 'SMTP settings help',
  },
};

const EVENT_LABELS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'ticketCreated', label: 'Ticket created', hint: 'A new ticket is raised' },
  { key: 'ticketAssigned', label: 'Ticket assigned', hint: 'Ownership changes' },
  { key: 'ticketStatusChanged', label: 'Status changed', hint: 'Moved between open, pending, resolved…' },
  { key: 'ticketEscalated', label: 'Escalated', hint: 'Escalation level raised' },
  { key: 'ticketCommented', label: 'New comment', hint: 'Public replies only, never internal notes' },
  { key: 'slaBreached', label: 'SLA breached', hint: 'A ticket passes its due time' },
];

export function IntegrationsPage() {
  useDocumentTitle('Integrations');
  const toast = useToast();
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [deliveries, setDeliveries] = useState<Awaited<ReturnType<typeof api.integrations.deliveries>>['deliveries']>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [integrationResult, deliveryResult] = await Promise.all([
        api.integrations.list(),
        api.integrations.deliveries(),
      ]);
      setIntegrations(integrationResult.integrations);
      setDeliveries(deliveryResult.deliveries);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load integrations.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingPane label="Loading integrations" />;
  if (error) return <ErrorPane message={error} retry={load} />;

  return (
    <div>
      <PageHeader
        title="Integrations"
        description="Connect the tools your team already lives in. Each one can be tested against the real service before you rely on it."
      />

      <div className="space-y-4 p-4 sm:p-6">
        {integrations.map((integration) => (
          <IntegrationCard
            key={integration.provider}
            integration={integration}
            onChanged={load}
            onToast={toast}
          />
        ))}

        <DataSourcePanel />

        <section className="rounded-md border surface">
          <header className="flex items-center justify-between border-b px-4 py-2.5">
            <div>
              <h2 className="text-sm font-semibold">Recent deliveries</h2>
              <p className="text-xs text-muted">The last 60 outbound notifications, newest first.</p>
            </div>
            <Button variant="ghost" size="sm" onClick={load}>
              <RefreshCw className="size-3.5" />
              Refresh
            </Button>
          </header>

          {deliveries.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-subtle">
              Nothing has been sent yet. Deliveries appear here once a ticket event fires.
            </p>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 surface-2">
                  <tr className="border-b">
                    <th className="eyebrow px-4 py-2 text-left font-medium">Provider</th>
                    <th className="eyebrow px-3 py-2 text-left font-medium">Event</th>
                    <th className="eyebrow px-3 py-2 text-left font-medium">Result</th>
                    <th className="eyebrow px-4 py-2 text-right font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((delivery) => (
                    <tr key={delivery.id} className="border-b last:border-b-0">
                      <td className="px-4 py-1.5 text-xs font-medium">
                        {PROVIDER_META[delivery.provider as IntegrationProvider]?.name ?? delivery.provider}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-muted">{delivery.event}</td>
                      <td className="px-3 py-1.5">
                        {delivery.ok ? (
                          <span className="inline-flex items-center gap-1 text-xs text-[var(--status-resolved)]">
                            <CheckCircle2 className="size-3" />
                            Delivered
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 text-xs text-[var(--priority-urgent)]"
                            title={delivery.error ?? undefined}
                          >
                            <CircleAlert className="size-3" />
                            <span className="max-w-60 truncate">{delivery.error ?? 'Failed'}</span>
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-1.5 text-right text-xs whitespace-nowrap text-subtle">
                        {shortDateTime(delivery.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function IntegrationCard({
  integration,
  onChanged,
  onToast,
}: {
  integration: IntegrationSummary;
  onChanged: () => Promise<void>;
  onToast: ReturnType<typeof useToast>;
}) {
  const meta = PROVIDER_META[integration.provider];
  const [config, setConfig] = useState<Record<string, unknown>>(integration.config);
  const [events, setEvents] = useState<Record<string, boolean>>({ ...integration.events });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [expanded, setExpanded] = useState(!integration.configured);
  const [linearTeams, setLinearTeams] = useState<Array<{ id: string; key: string; name: string }>>([]);

  useEffect(() => {
    setConfig(integration.config);
    setEvents({ ...integration.events });
  }, [integration]);

  const set = (key: string, value: unknown) => setConfig((current) => ({ ...current, [key]: value }));

  const save = async (patch?: { enabled?: boolean }) => {
    setSaving(true);
    try {
      await api.integrations.update(integration.provider, { config, events, ...patch });
      await onChanged();
      onToast.success(`${meta.name} settings saved.`);
    } catch (caught) {
      onToast.error('Could not save', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const result = await api.integrations.test(integration.provider);
      if (result.ok) onToast.success(`${meta.name} connected`, result.message);
      else onToast.error(`${meta.name} test failed`, result.message);

      // The Linear test returns the visible teams, which populates the picker.
      if (integration.provider === 'linear' && result.details?.teams) {
        setLinearTeams(result.details.teams as Array<{ id: string; key: string; name: string }>);
      }
      await onChanged();
    } catch (caught) {
      onToast.error('Test failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setTesting(false);
    }
  };

  const StatusIcon =
    integration.status === 'ok' ? CheckCircle2 : integration.status === 'error' ? CircleAlert : CircleDashed;
  const statusColor =
    integration.status === 'ok'
      ? 'var(--status-resolved)'
      : integration.status === 'error'
        ? 'var(--priority-urgent)'
        : 'var(--fg-subtle)';

  return (
    <section className="rounded-md border surface">
      <header className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border surface-2">
            <ProviderIcon provider={integration.provider} className="size-4 text-[var(--fg-subtle)]" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">{meta.name}</h2>
              <span className="inline-flex items-center gap-1 text-2xs" style={{ color: statusColor }}>
                <StatusIcon className="size-3" />
                {integration.status === 'ok'
                  ? 'Connection verified'
                  : integration.status === 'error'
                    ? 'Last test failed'
                    : integration.configured
                      ? 'Not tested yet'
                      : 'Not configured'}
              </span>
              {integration.enabled && (
                <span className="rounded-[3px] border border-[var(--status-resolved)]/40 px-1 text-2xs font-medium text-[var(--status-resolved)]">
                  Enabled
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">{meta.blurb}</p>
            {integration.status === 'error' && integration.lastError && (
              <p className="mt-1.5 rounded-sm border border-[var(--priority-urgent)]/25 bg-[var(--priority-urgent)]/5 px-2 py-1 text-2xs text-[var(--priority-urgent)]">
                {integration.lastError}
              </p>
            )}
            {integration.lastCheckedAt && (
              <p className="mt-1 text-2xs text-subtle">Last tested {relativeTime(integration.lastCheckedAt)}</p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Hide' : 'Configure'}
          </Button>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={integration.enabled}
              disabled={!integration.configured}
              onChange={(event) => void save({ enabled: event.target.checked })}
              className="size-3.5 cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed"
            />
            <span className={cn(!integration.configured && 'text-subtle')}>Enabled</span>
          </label>
        </div>
      </header>

      {expanded && (
        <div className="space-y-4 border-t px-4 py-4">
          {integration.provider === 'slack' && <SlackFields config={config} set={set} />}
          {integration.provider === 'msteams' && <TeamsFields config={config} set={set} />}
          {integration.provider === 'linear' && (
            <LinearFields config={config} set={set} teams={linearTeams} setTeams={setLinearTeams} />
          )}
          {integration.provider === 'email' && <EmailFields config={config} set={set} />}

          <div>
            <p className="mb-2 text-xs font-medium">Send a notification when…</p>
            <div className="grid gap-2 rounded-sm border p-3 surface-2 sm:grid-cols-2 lg:grid-cols-3">
              {EVENT_LABELS.map((event) => (
                <Checkbox
                  key={event.key}
                  checked={Boolean(events[event.key])}
                  onChange={(changeEvent) =>
                    setEvents((current) => ({ ...current, [event.key]: changeEvent.target.checked }))
                  }
                  label={event.label}
                  hint={event.hint}
                />
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <a
              href={meta.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline"
            >
              {meta.docsLabel}
              <ExternalLink className="size-3" />
            </a>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" loading={testing} onClick={test} disabled={!integration.configured}>
                Test connection
              </Button>
              <Button variant="primary" size="sm" loading={saving} onClick={() => save()}>
                Save
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** A saved secret comes back blank with a masked preview; show that as the placeholder. */
function secretPlaceholder(config: Record<string, unknown>, field: string, fallback: string): string {
  return config[`${field}Set`] ? `Saved · ${config[`${field}Preview`]}` : fallback;
}

function SlackFields({ config, set }: { config: Record<string, unknown>; set: (k: string, v: unknown) => void }) {
  const mode = (config.mode as string) ?? 'webhook';
  return (
    <div className="space-y-3">
      <Field label="Connection method">
        <Select
          value={mode}
          onChange={(event) => {
            const next = event.target.value;
            set('mode', next);
            /*
             * Clear whatever was typed into the other method's field. It is
             * not the credential being configured, and carrying it along
             * failed the save on a field this method never reads. An empty
             * value leaves anything already stored untouched, so switching
             * back does not lose a saved webhook or token.
             */
            set(next === 'bot' ? 'webhookUrl' : 'botToken', '');
          }}
        >
          <option value="webhook">Incoming webhook — simplest, posts to one channel</option>
          <option value="bot">Bot token — lets you change channel without a new URL</option>
        </Select>
      </Field>

      {mode === 'webhook' ? (
        <Field
          label="Incoming webhook URL"
          hint="Slack → Your apps → Incoming Webhooks → Add New Webhook to Workspace."
        >
          <Input
            type="password"
            value={(config.webhookUrl as string) ?? ''}
            onChange={(event) => set('webhookUrl', event.target.value)}
            placeholder={secretPlaceholder(config, 'webhookUrl', 'https://hooks.slack.com/services/T000/B000/xxxx')}
            className="font-mono text-xs"
          />
        </Field>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Bot user OAuth token" hint="Needs the chat:write scope.">
            <Input
              type="password"
              value={(config.botToken as string) ?? ''}
              onChange={(event) => set('botToken', event.target.value)}
              placeholder={secretPlaceholder(config, 'botToken', 'xoxb-…')}
              className="font-mono text-xs"
            />
          </Field>
          <Field label="Channel" hint="Channel ID (C01234ABCDE) or #name.">
            <Input
              value={(config.channel as string) ?? ''}
              onChange={(event) => set('channel', event.target.value)}
              placeholder="#escalations"
            />
          </Field>
        </div>
      )}

      {mode === 'bot' && (
        <div className="space-y-3 rounded-sm border border-dashed p-3">
          <div>
            <p className="text-xs font-medium">Replies from Slack</p>
            <p className="mt-0.5 text-2xs text-muted">
              Each ticket gets its own thread in the channel. Set this up and a reply in that thread becomes a
              comment on the ticket, and the requester, assignee and watchers are notified.
            </p>
          </div>

          <Field
            label="Signing secret"
            hint="Slack API → your app → Basic Information → App Credentials → Signing Secret."
          >
            <Input
              type="password"
              value={(config.signingSecret as string) ?? ''}
              onChange={(event) => set('signingSecret', event.target.value)}
              placeholder={secretPlaceholder(config, 'signingSecret', 'Paste the signing secret')}
              className="font-mono text-xs"
            />
          </Field>

          <Field
            label="Request URL"
            hint="Slack API → Event Subscriptions → Enable Events. Save the signing secret here first, then paste this there: Slack verifies the URL immediately. Subscribe to message.channels, and add the users:read and users:read.email scopes so replies are attributed to the right person."
          >
            <Input
              readOnly
              value={`${window.location.origin}/api/webhooks/slack`}
              onFocus={(event) => event.currentTarget.select()}
              className="font-mono text-xs"
            />
          </Field>
        </div>
      )}
    </div>
  );
}

function TeamsFields({ config, set }: { config: Record<string, unknown>; set: (k: string, v: unknown) => void }) {
  return (
    <div className="space-y-3">
      <Field
        label="Webhook URL"
        hint="In Teams: channel → ⋯ → Workflows → 'Post to a channel when a webhook request is received'."
      >
        <Input
          type="password"
          value={(config.webhookUrl as string) ?? ''}
          onChange={(event) => set('webhookUrl', event.target.value)}
          placeholder={secretPlaceholder(config, 'webhookUrl', 'https://prod-00.westeurope.logic.azure.com:443/workflows/…')}
          className="font-mono text-xs"
        />
      </Field>

      <Field
        label="Card format"
        hint="Auto detects the right format from the URL. Microsoft is retiring the older Office 365 connectors in favour of Workflows."
      >
        <Select value={(config.format as string) ?? 'auto'} onChange={(event) => set('format', event.target.value)}>
          <option value="auto">Detect automatically</option>
          <option value="adaptive">Adaptive card (Power Automate Workflows)</option>
          <option value="messagecard">Message card (legacy Office 365 connector)</option>
        </Select>
      </Field>
    </div>
  );
}

function LinearFields({
  config,
  set,
  teams,
  setTeams,
}: {
  config: Record<string, unknown>;
  set: (k: string, v: unknown) => void;
  teams: Array<{ id: string; key: string; name: string }>;
  setTeams: (teams: Array<{ id: string; key: string; name: string }>) => void;
}) {
  const toast = useToast();
  const [loadingTeams, setLoadingTeams] = useState(false);

  return (
    <div className="space-y-3">
      <Field label="API key" hint="Linear → Settings → API → Personal API keys.">
        <Input
          type="password"
          value={(config.apiKey as string) ?? ''}
          onChange={(event) => set('apiKey', event.target.value)}
          placeholder={secretPlaceholder(config, 'apiKey', 'lin_api_…')}
          className="font-mono text-xs"
        />
      </Field>

      <Field label="Linear team" hint="Where mirrored issues are created. Save the API key first, then load teams.">
        <div className="flex gap-2">
          <Select
            value={(config.teamId as string) ?? ''}
            onChange={(event) => {
              set('teamId', event.target.value);
              set('teamKey', teams.find((team) => team.id === event.target.value)?.key ?? '');
            }}
            className="flex-1"
          >
            <option value="">
              {config.teamKey ? `Currently: ${config.teamKey}` : 'Select a team…'}
            </option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.key} · {team.name}
              </option>
            ))}
          </Select>
          <Button
            variant="secondary"
            size="md"
            loading={loadingTeams}
            onClick={async () => {
              setLoadingTeams(true);
              try {
                // Send whatever is currently typed, so the key does not have to
                // be saved before the list can be loaded.
                const result = await api.integrations.linearTeams((config.apiKey as string) || undefined);
                setTeams(result.teams);
                if (result.teams.length === 0) {
                  toast.error('That key works, but it can see no teams in Linear.');
                }
              } catch (caught) {
                /*
                 * Say what went wrong. This used to swallow the error on the
                 * grounds that the test button would explain it, which left
                 * the button spinning, stopping, and the list still empty with
                 * nothing said.
                 */
                toast.error(
                  'Could not load teams',
                  caught instanceof ApiError ? caught.message : 'Linear could not be reached.',
                );
              } finally {
                setLoadingTeams(false);
              }
            }}
          >
            Load teams
          </Button>
        </div>
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Mirror automatically from" hint="Tickets at this priority or higher create a Linear issue.">
          <Select
            value={(config.minPriority as string) ?? 'high'}
            onChange={(event) => set('minPriority', event.target.value)}
          >
            <option value="urgent">Urgent only</option>
            <option value="high">High and urgent</option>
            <option value="normal">Normal and above</option>
            <option value="low">Everything</option>
          </Select>
        </Field>

        <Field label="Inbound webhook secret" hint="Optional. Lets Linear push status changes back to this system.">
          <Input
            type="password"
            value={(config.webhookSecret as string) ?? ''}
            onChange={(event) => set('webhookSecret', event.target.value)}
            placeholder={secretPlaceholder(config, 'webhookSecret', 'lin_wh_…')}
            className="font-mono text-xs"
          />
        </Field>
      </div>

      <Checkbox
        checked={Boolean(config.autoCreate)}
        onChange={(event) => set('autoCreate', event.target.checked)}
        label="Create Linear issues automatically"
        hint="When off, you can still push individual tickets to Linear from the ticket menu."
      />

      {Boolean(config.webhookSecret) || config.webhookSecretSet ? (
        <p className="rounded-sm border px-2.5 py-2 text-2xs text-muted surface-2">
          Point your Linear webhook at <code className="font-mono">{window.location.origin}/api/webhooks/linear</code>{' '}
          and subscribe to issue events.
        </p>
      ) : null}
    </div>
  );
}

function EmailFields({ config, set }: { config: Record<string, unknown>; set: (k: string, v: unknown) => void }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_6rem_7rem]">
        <Field label="SMTP host">
          <Input
            value={(config.host as string) ?? ''}
            onChange={(event) => set('host', event.target.value)}
            placeholder="smtp.office365.com"
          />
        </Field>
        <Field label="Port">
          <Input
            type="number"
            value={String(config.port ?? 587)}
            onChange={(event) => set('port', Number(event.target.value))}
          />
        </Field>
        <Field label="Encryption">
          <Select
            value={config.secure ? 'ssl' : 'starttls'}
            onChange={(event) => set('secure', event.target.value === 'ssl')}
          >
            <option value="starttls">STARTTLS (587)</option>
            <option value="ssl">SSL/TLS (465)</option>
          </Select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Username">
          <Input
            value={(config.username as string) ?? ''}
            onChange={(event) => set('username', event.target.value)}
            autoComplete="off"
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={(config.password as string) ?? ''}
            onChange={(event) => set('password', event.target.value)}
            placeholder={secretPlaceholder(config, 'password', '')}
            autoComplete="new-password"
          />
        </Field>
        <Field label="From name">
          <Input
            value={(config.fromName as string) ?? ''}
            onChange={(event) => set('fromName', event.target.value)}
            placeholder="Escalation Pro"
          />
        </Field>
        <Field label="From address">
          <Input
            type="email"
            value={(config.fromEmail as string) ?? ''}
            onChange={(event) => set('fromEmail', event.target.value)}
            placeholder="tickets@company.com"
          />
        </Field>
      </div>
    </div>
  );
}
