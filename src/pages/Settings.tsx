import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { PRIORITY_LABELS, duration } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { useToast } from '@/components/ui/Toast';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { LoadingPane } from '@/components/ui/Feedback';
import { LogoUploader } from '@/components/LogoUploader';
import { useBranding, useDocumentTitle } from '@/state/branding';
import { TICKET_PRIORITIES, type ApiKeySummary, type AppSettings, type Team } from '@shared/types';

const SLA_PRESETS = [30, 60, 120, 240, 480, 1440, 2880, 4320, 10080];

export function SettingsPage() {
  useDocumentTitle('Settings');
  const toast = useToast();
  const { refresh, can } = useAuth();
  const { refresh: refreshBranding } = useBranding();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void Promise.all([api.settings.get(), api.teams.list()])
      .then(([settingsResult, teamResult]) => {
        setSettings(settingsResult.settings);
        setTeams(teamResult.teams);
      })
      .catch(() => toast.error('Could not load settings.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!settings) return <LoadingPane label="Loading settings" />;

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setSettings((current) => (current ? { ...current, [key]: value } : current));

  const save = async () => {
    setSaving(true);
    try {
      const result = await api.settings.update(settings);
      setSettings(result.settings);
      // Renaming the organisation changes the sidebar and the tab title too.
      await Promise.all([refresh(), refreshBranding()]);
      toast.success('Settings saved.');
    } catch (caught) {
      toast.error('Could not save', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Organisation profile and the defaults applied to new tickets."
        actions={
          <Button variant="primary" size="sm" loading={saving} onClick={save}>
            Save changes
          </Button>
        }
      />

      <div className="max-w-2xl space-y-4 p-4 sm:p-6">
        <Section title="Organisation">
          <Field label="Name" hint="Shown in the sidebar, the browser tab, emails, and chat notifications.">
            <Input
              value={settings.organizationName}
              onChange={(event) => set('organizationName', event.target.value)}
            />
          </Field>

          <LogoUploader />

          <Field label="Support email" hint="Used as the reply-to address on outgoing notifications.">
            <Input
              type="email"
              value={settings.supportEmail}
              onChange={(event) => set('supportEmail', event.target.value)}
              placeholder="support@company.com"
            />
          </Field>

          <Field
            label="Public URL"
            hint="Where this system is reachable. Links in Slack, Teams, and email are built from it."
          >
            <Input
              value={settings.appUrl}
              onChange={(event) => set('appUrl', event.target.value)}
              placeholder={window.location.origin}
              className="font-mono text-xs"
            />
          </Field>
        </Section>

        <Section title="Ticket defaults">
          <Field
            label="Reference prefix"
            hint={`Ticket references look like ${settings.ticketPrefix || 'ESC'}-1042. Changing this affects new and existing references.`}
          >
            <Input
              value={settings.ticketPrefix}
              onChange={(event) => set('ticketPrefix', event.target.value.toUpperCase())}
              maxLength={8}
              className="w-32 font-mono"
            />
          </Field>

          <Field label="Default team" hint="Pre-selected when someone raises a ticket.">
            <Select
              value={settings.defaultTeamId ?? ''}
              onChange={(event) => set('defaultTeamId', event.target.value || null)}
            >
              <option value="">No default</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Default priority">
            <Select
              value={settings.defaultPriority}
              onChange={(event) => set('defaultPriority', event.target.value as AppSettings['defaultPriority'])}
            >
              {TICKET_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {PRIORITY_LABELS[priority]}
                </option>
              ))}
            </Select>
          </Field>
        </Section>

        <Section
          title="Fallback SLA"
          description="Applied when a ticket has no team, or the team has no target of its own."
        >
          <Field label="First response target">
            <Select
              value={String(settings.slaResponseMins)}
              onChange={(event) => set('slaResponseMins', Number(event.target.value))}
            >
              {SLA_PRESETS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {duration(minutes)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Resolution target">
            <Select
              value={String(settings.slaResolveMins)}
              onChange={(event) => set('slaResolveMins', Number(event.target.value))}
            >
              {SLA_PRESETS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {duration(minutes)}
                </option>
              ))}
            </Select>
          </Field>
        </Section>

        <ApiKeys canManage={can('settings.manage')} teams={teams} />
      </div>
    </div>
  );
}

/**
 * Keys for the HTTPS API.
 *
 * The token is shown once, in full, and then never again - so the UI has to
 * make that unmissable rather than leave someone to discover it by closing
 * the panel.
 */
function ApiKeys({ canManage, teams }: { canManage: boolean; teams: Team[] }) {
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [name, setName] = useState('');
  const [defaultTeamId, setDefaultTeamId] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => {
    if (!canManage) return;
    api.apiKeys
      .list()
      .then((data) => setKeys(data.keys))
      .catch(() => undefined);
  };

  useEffect(load, [canManage]);

  if (!canManage) return null;

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const created = await api.apiKeys.create({
        name: name.trim(),
        scopes: ['tickets.create'],
        defaultTeamId: defaultTeamId || null,
      });
      setIssued(created.token);
      setName('');
      setDefaultTeamId('');
      load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not create the key.');
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string, keyName: string) => {
    try {
      await api.apiKeys.revoke(id);
      toast.success(`Revoked "${keyName}".`);
      load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not revoke the key.');
    }
  };

  const live = keys.filter((key) => !key.revokedAt);

  return (
    <Section
      title="API keys"
      description="For raising tickets over HTTPS from a monitoring tool, a script, or another system."
    >
      {issued && (
        <div className="rounded-sm border border-[var(--status-open)] bg-[var(--status-open)]/5 px-3 py-2.5">
          <p className="text-xs font-semibold">Copy this now — it is not shown again.</p>
          <code className="mt-1.5 block break-all rounded-sm bg-[var(--surface)] px-2 py-1.5 font-mono text-xs">
            {issued}
          </code>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setIssued(null)}>
            Done
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <Field label="Name" className="min-w-40 flex-1">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Monitoring" />
        </Field>
        <Field label="Default department" className="min-w-40 flex-1">
          <Select value={defaultTeamId} onChange={(event) => setDefaultTeamId(event.target.value)}>
            <option value="">None</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button onClick={create} loading={creating} disabled={!name.trim()}>
          Create key
        </Button>
      </div>

      {live.length === 0 ? (
        <p className="text-xs text-muted">No keys yet.</p>
      ) : (
        <ul className="divide-y rounded-sm border">
          {live.map((key) => (
            <li key={key.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{key.name}</p>
                <p className="font-mono text-[11px] text-muted">
                  {key.prefix}…{' '}
                  {key.lastUsedAt ? `last used ${new Date(key.lastUsedAt).toLocaleDateString()}` : 'never used'}
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => revoke(key.id, key.name)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted">
        Send it as <code className="font-mono">Authorization: Bearer …</code> to{' '}
        <code className="font-mono">POST /api/v1/tickets</code>. Pass a{' '}
        <code className="font-mono">dedupeKey</code> so a tool that retries does not open the same ticket twice.
      </p>
    </Section>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border surface">
      <header className="border-b px-4 py-2.5">
        <h2 className="text-xs font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </header>
      <div className="space-y-3.5 px-4 py-4">{children}</div>
    </section>
  );
}
