import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type RoutedProvider, type RoutingView } from '@/lib/api';
import { useAuth } from '@/state/auth';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';

const PROVIDERS: Array<{ provider: RoutedProvider; label: string }> = [
  { provider: 'slack', label: 'Slack channel' },
  { provider: 'msteams', label: 'Teams channel' },
  { provider: 'linear', label: 'Linear team' },
];

/**
 * Where this department's tickets go, picked from the real channels and Linear
 * teams. The same choices as the table under Integrations, for one department;
 * left blank, the department uses "Everything else" there.
 */
export function TeamRouting({ teamId, teamName }: { teamId: string; teamName: string }) {
  const toast = useToast();
  const { can } = useAuth();
  const manage = can('integrations.manage');
  const [views, setViews] = useState<Partial<Record<RoutedProvider, RoutingView>>>({});
  const [draft, setDraft] = useState<Record<RoutedProvider, { target: string; mention: string }>>({
    slack: { target: '', mention: '' },
    msteams: { target: '', mention: '' },
    linear: { target: '', mention: '' },
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!manage) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void Promise.allSettled(PROVIDERS.map(({ provider }) => api.integrations.routing(provider))).then((results) => {
      if (cancelled) return;
      const next: Partial<Record<RoutedProvider, RoutingView>> = {};
      const nextDraft = { ...draft };
      results.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        const { provider } = PROVIDERS[index];
        next[provider] = result.value;
        const row = result.value.departments.find((department) => department.teamId === teamId);
        nextDraft[provider] = { target: row?.target ?? '', mention: row?.mention ?? '' };
      });
      setViews(next);
      setDraft(nextDraft);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // The draft is rebuilt from the server whenever the department changes.
  }, [teamId, manage]);

  if (!manage) {
    return (
      <p className="text-xs text-subtle">
        An administrator chooses where {teamName} tickets are posted, under Integrations.
      </p>
    );
  }
  if (loading) return <p className="p-3 text-xs text-subtle">Loading…</p>;

  const save = async () => {
    setSaving(true);
    try {
      for (const { provider } of PROVIDERS) {
        if (!views[provider]) continue;
        await api.integrations.saveRouting(provider, {
          departments: [{ teamId, target: draft[provider].target, mention: provider === 'slack' ? draft[provider].mention || null : undefined }],
        });
      }
      toast.success(`Saved where ${teamName} tickets go.`);
    } catch (error) {
      toast.error('Could not save', error instanceof ApiError ? error.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const set = (provider: RoutedProvider, patch: Partial<{ target: string; mention: string }>) =>
    setDraft((current) => ({ ...current, [provider]: { ...current[provider], ...patch } }));

  return (
    <div className="space-y-3">
      <p className="text-xs text-subtle">
        Left on "Everything else", {teamName} uses the default set in{' '}
        <Link to="/integrations" className="text-[var(--accent)] hover:underline">
          Integrations
        </Link>
        , where every department's destination is in one table.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        {PROVIDERS.map(({ provider, label }) => {
          const view = views[provider];
          if (!view) return null;
          const value = draft[provider].target;
          return (
            <Field key={provider} label={label} hint={view.notice ?? undefined}>
              {view.kind === 'url' ? (
                <Input
                  value={value}
                  onChange={(event) => set(provider, { target: event.target.value })}
                  placeholder="Same as the default webhook"
                  className="font-mono text-xs"
                />
              ) : (
                <Select value={value} onChange={(event) => set(provider, { target: event.target.value })} disabled={!view.destinations.length}>
                  <option value="">Everything else</option>
                  {view.destinations.map((destination) => (
                    <option key={destination.id} value={destination.id}>
                      {destination.name}
                    </option>
                  ))}
                  {value && !view.destinations.some((destination) => destination.id === value) && <option value={value}>{value} (not found)</option>}
                </Select>
              )}
            </Field>
          );
        })}

        {views.slack && (
          <Field label="Ping in Slack" hint="@here, @channel, or a user group's ID (S…).">
            <Input
              value={draft.slack.mention}
              onChange={(event) => set('slack', { mention: event.target.value })}
              placeholder="Nobody"
              className="font-mono text-xs"
            />
          </Field>
        )}
      </div>

      <Button size="sm" variant="primary" loading={saving} onClick={save}>
        Save routing
      </Button>
    </div>
  );
}
