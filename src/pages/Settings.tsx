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
import { TICKET_PRIORITIES, type AppSettings, type Team } from '@shared/types';

const SLA_PRESETS = [30, 60, 120, 240, 480, 1440, 2880, 4320, 10080];

export function SettingsPage() {
  useDocumentTitle('Settings');
  const toast = useToast();
  const { refresh } = useAuth();
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
      </div>
    </div>
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
