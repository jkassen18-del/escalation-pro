import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, CircleDashed, ExternalLink, RefreshCw } from 'lucide-react';
import { DiscordIcon } from '@/components/BrandIcons';
import { api, ApiError } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import type { IntegrationSummary, Team } from '@shared/types';

type Channel = { id: string; name: string; guildId: string; guildName: string };

const EVENTS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'ticketCreated', label: 'Ticket created', hint: 'Posts the ticket card and starts its thread' },
  { key: 'ticketAssigned', label: 'Ticket assigned', hint: 'Ownership changes' },
  { key: 'ticketStatusChanged', label: 'Status changed', hint: 'Moved between open, pending, resolved…' },
  { key: 'ticketEscalated', label: 'Escalated', hint: 'Level raised or moved to another department' },
  { key: 'ticketCommented', label: 'New comment', hint: 'Public replies only, never internal notes' },
  { key: 'slaBreached', label: 'SLA breached', hint: 'A ticket passes its due time' },
];

const STEPS = [
  <>Open the <a className="text-[var(--accent)] hover:underline" href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">Discord Developer Portal</a> and choose <b>New Application</b>. Name it, e.g. InfraTicket.</>,
  <>On <b>General Information</b>, copy the <b>Application ID</b>.</>,
  <>On <b>Bot</b>, choose <b>Reset Token</b> and copy it. Under <b>Privileged Gateway Intents</b>, turn on <b>Message Content Intent</b>.</>,
  <>Paste both below and <b>Save</b>, then use <b>Add to server</b> and pick your server.</>,
  <>Pick the channel new tickets go to, <b>Save</b> again, and <b>Test</b>. Then turn it on.</>,
];

/**
 * Discord, set up from one card. The bot connects out to Discord, so this
 * works from a server nobody on the internet can reach.
 */
export function DiscordIntegrationPanel({ onClose }: { onClose?: () => void } = {}) {
  const toast = useToast();
  const [integration, setIntegration] = useState<IntegrationSummary | null>(null);
  const [overview, setOverview] = useState<Awaited<ReturnType<typeof api.integrations.discord.overview>> | null>(null);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [events, setEvents] = useState<Record<string, boolean>>({});
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [routes, setRoutes] = useState<Record<string, string>>({});
  // Open by default: it is usually shown inside the catalogue's setup drawer, where setup is the point.
  const [expanded, setExpanded] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [savingRoutes, setSavingRoutes] = useState(false);

  const load = useCallback(async () => {
    const [list, info, teamList] = await Promise.all([api.integrations.list(), api.integrations.discord.overview(), api.teams.list()]);
    const found = list.integrations.find((item) => item.provider === 'discord') ?? null;
    setIntegration(found);
    setOverview(info);
    setTeams(teamList.teams);
    setRoutes(Object.fromEntries(info.routes.map((route) => [route.teamId, route.channelId])));
    if (found) {
      setConfig(found.config);
      setEvents({ ...found.events });
    }
  }, []);

  const loadChannels = useCallback(async () => {
    setChannelsError(null);
    try {
      setChannels((await api.integrations.discord.channels()).channels);
    } catch (caught) {
      setChannels(null);
      setChannelsError(caught instanceof ApiError ? caught.message : 'Could not list channels.');
    }
  }, []);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  useEffect(() => {
    if (expanded && integration?.config.botTokenSet && channels === null && !channelsError) void loadChannels();
  }, [expanded, integration, channels, channelsError, loadChannels]);

  if (!integration) return null;

  const set = (key: string, value: unknown) => setConfig((current) => ({ ...current, [key]: value }));

  const save = async (patch?: { enabled?: boolean }) => {
    setSaving(true);
    try {
      await api.integrations.update('discord', { config, events, ...patch });
      await load();
      setChannels(null);
      setChannelsError(null);
      toast.success(patch?.enabled === undefined ? 'Discord settings saved.' : patch.enabled ? 'Discord is on. The bot connects within a few seconds.' : 'Discord is off.');
    } catch (caught) {
      toast.error('Could not save', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const result = await api.integrations.test('discord');
      if (result.ok) toast.success('Discord connected', result.message);
      else toast.error('Discord test failed', result.message);
      await load();
    } catch (caught) {
      toast.error('Test failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setTesting(false);
    }
  };

  const saveRoutes = async () => {
    setSavingRoutes(true);
    try {
      await api.integrations.discord.saveRoutes(teams.map((team) => ({ teamId: team.id, channelId: routes[team.id] ?? '' })));
      toast.success('Department channels saved.');
    } catch (caught) {
      toast.error('Could not save', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSavingRoutes(false);
    }
  };

  const status = integration.status;
  const StatusIcon = status === 'ok' ? CheckCircle2 : status === 'error' ? CircleAlert : CircleDashed;
  const statusColor = status === 'ok' ? 'var(--status-resolved)' : status === 'error' ? 'var(--priority-urgent)' : 'var(--fg-subtle)';
  const gateway = overview?.gateway;

  const channelPicker = (value: string, onChange: (next: string) => void, emptyLabel: string) =>
    channels && channels.length ? (
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{emptyLabel}</option>
        {channels.map((channel) => (
          <option key={channel.id} value={channel.id}>
            #{channel.name} · {channel.guildName}
          </option>
        ))}
      </Select>
    ) : (
      <Input value={value} onChange={(event) => onChange(event.target.value.trim())} placeholder="Channel ID, e.g. 1234567890123456789" className="font-mono text-xs" />
    );

  return (
    <section className="rounded-md border surface">
      <header className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border surface-2">
            <DiscordIcon className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">Discord</h2>
              <span className="inline-flex items-center gap-1 text-2xs" style={{ color: statusColor }}>
                <StatusIcon className="size-3" />
                {status === 'ok' ? 'Connection verified' : status === 'error' ? 'Needs attention' : integration.configured ? 'Not tested yet' : 'Not configured'}
              </span>
              {integration.enabled && (
                <span
                  className={cn(
                    'rounded-[3px] border px-1 text-2xs font-medium',
                    gateway?.connected ? 'border-[var(--status-resolved)]/40 text-[var(--status-resolved)]' : 'border-[var(--border-strong)] text-subtle',
                  )}
                  title={gateway?.running ? undefined : 'Another instance may hold the connection, or it is still starting'}
                >
                  {gateway?.connected ? 'Bot online' : 'Enabled'}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">
              Raise tickets with <code>/ticket</code>, follow each one in its own thread, and get paged by direct message. Free, and needs no public URL.
            </p>
            {status === 'error' && integration.lastError && (
              <p className="mt-1.5 rounded-sm border border-[var(--priority-urgent)]/25 bg-[var(--priority-urgent)]/5 px-2 py-1 text-2xs text-[var(--priority-urgent)]">
                {integration.lastError}
              </p>
            )}
            {integration.lastCheckedAt && <p className="mt-1 text-2xs text-subtle">Last tested {relativeTime(integration.lastCheckedAt)}</p>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Hide' : 'Configure'}
          </Button>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={integration.enabled}
              disabled={!integration.configured || saving}
              onChange={(event) => void save({ enabled: event.target.checked })}
              className="size-3.5 cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed"
            />
            <span className={cn(!integration.configured && 'text-subtle')}>Enabled</span>
          </label>
        </div>
      </header>

      {expanded && (
        <div className="space-y-4 border-t px-4 py-4">
          <ol className="list-decimal space-y-1 rounded-sm border p-3 pl-7 text-xs leading-relaxed surface-2">
            {STEPS.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Application ID" hint="General Information → Application ID.">
              <Input value={String(config.applicationId ?? '')} onChange={(event) => set('applicationId', event.target.value.trim())} className="font-mono text-xs" placeholder="1234567890123456789" />
            </Field>
            <Field label="Bot token" hint="Bot → Reset Token. Stored encrypted, never shown again.">
              <Input
                type="password"
                autoComplete="off"
                value={String(config.botToken ?? '')}
                onChange={(event) => set('botToken', event.target.value.trim())}
                placeholder={config.botTokenSet ? `Saved · ${String(config.botTokenPreview ?? '')}` : 'Paste the bot token'}
                className="font-mono text-xs"
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {overview?.inviteUrl ? (
              <a href={overview.inviteUrl} target="_blank" rel="noopener noreferrer">
                <Button variant="secondary" size="sm">
                  <ExternalLink className="size-3.5" />
                  Add to server
                </Button>
              </a>
            ) : (
              <p className="text-2xs text-subtle">Save the Application ID to get the "Add to server" link.</p>
            )}
            {integration.config.botTokenSet ? (
              <Button variant="ghost" size="sm" onClick={() => void loadChannels()}>
                <RefreshCw className="size-3.5" />
                Reload channels
              </Button>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Default channel" hint={channelsError ?? 'New tickets go here unless their department has its own channel.'}>
              {channelPicker(String(config.channel ?? ''), (next) => set('channel', next), 'Pick a channel…')}
            </Field>
            <Field label="Only this server (optional)" hint="A server ID to register /ticket in. Blank registers it in every server the bot joins.">
              <Input value={String(config.guildId ?? '')} onChange={(event) => set('guildId', event.target.value.trim())} className="font-mono text-xs" placeholder="Server ID" />
            </Field>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium">Post in the ticket's thread when…</p>
            <div className="grid gap-2 rounded-sm border p-3 surface-2 sm:grid-cols-2 lg:grid-cols-3">
              {EVENTS.map((event) => (
                <Checkbox
                  key={event.key}
                  checked={Boolean(events[event.key])}
                  onChange={(change) => setEvents((current) => ({ ...current, [event.key]: change.target.checked }))}
                  label={event.label}
                  hint={event.hint}
                />
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
            <Button variant="secondary" size="sm" loading={testing} onClick={test} disabled={!integration.configured}>
              Test connection
            </Button>
            <Button variant="primary" size="sm" loading={saving} onClick={() => save()}>
              Save
            </Button>
          </div>

          {teams.length > 0 && integration.configured && (
            <div className="space-y-2 border-t pt-3">
              <div>
                <p className="text-xs font-medium">Department channels</p>
                <p className="text-2xs text-subtle">Each department's tickets go to its own channel. Leave one on "Default channel" to use the default.</p>
              </div>
              <div className="divide-y rounded-sm border">
                {teams.map((team) => (
                  <div key={team.id} className="grid items-center gap-2 px-3 py-2 sm:grid-cols-[12rem_1fr]">
                    <span className="truncate text-xs font-medium">{team.name}</span>
                    {channelPicker(routes[team.id] ?? '', (next) => setRoutes((current) => ({ ...current, [team.id]: next })), 'Default channel')}
                  </div>
                ))}
              </div>
              <div className="flex justify-end">
                <Button variant="secondary" size="sm" loading={savingRoutes} onClick={saveRoutes}>
                  Save department channels
                </Button>
              </div>
            </div>
          )}

          <p className="rounded-sm border p-3 text-2xs leading-relaxed text-muted surface-2">
            People link their own account by typing <code>/link</code> in Discord and entering the code on their profile. Only linked
            people can raise tickets, reply in threads, use the buttons, or be paged by direct message; their InfraTicket permissions apply to everything they do.
          </p>
        </div>
      )}
    </section>
  );
}
