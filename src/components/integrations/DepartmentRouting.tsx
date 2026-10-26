import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, RefreshCw, Send } from 'lucide-react';
import { api, ApiError, type RoutedProvider, type RoutingView } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';

const NOUN: Record<RoutedProvider, { thing: string; things: string; app: string }> = {
  slack: { thing: 'channel', things: 'channels', app: 'Slack' },
  msteams: { thing: 'channel', things: 'channels', app: 'Teams' },
  linear: { thing: 'Linear team', things: 'Linear teams', app: 'Linear' },
  github: { thing: 'repository', things: 'repositories', app: 'GitHub' },
};

/** Linear and GitHub create issues rather than post messages. */
const makesIssues = (provider: RoutedProvider) => provider === 'linear' || provider === 'github';

/** Stands for "post nothing" in the selects; the server stores it as an empty target. */
const NONE = 'none';

/**
 * One row per department: where its tickets are posted (Slack, Teams) or which
 * Linear team its issues are created in. Replaces the single channel picker:
 * the last row, "Everything else", only catches departments left blank.
 */
export function DepartmentRouting({ provider }: { provider: RoutedProvider }) {
  const toast = useToast();
  const noun = NOUN[provider];
  const [view, setView] = useState<RoutingView | null>(null);
  const [draft, setDraft] = useState<Record<string, { target: string; mention: string }>>({});
  const [fallback, setFallback] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<Awaited<ReturnType<typeof api.integrations.testRouting>>['results'] | null>(null);

  const apply = (next: RoutingView) => {
    setView(next);
    setDraft(Object.fromEntries(next.departments.map((row) => [row.teamId, { target: row.target, mention: row.mention ?? '' }])));
    setFallback(next.fallback === '' && provider !== 'msteams' ? NONE : next.fallback);
  };

  const load = useCallback(async () => {
    setError(null);
    try {
      apply(await api.integrations.routing(provider));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load routing.');
    }
  }, [provider]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="text-xs text-[var(--priority-urgent)]">{error}</p>;
  if (!view) return <p className="text-xs text-subtle">Loading departments…</p>;

  const canPick = view.kind === 'pick' && view.destinations.length > 0;
  const urlMode = view.kind === 'url';
  const dirty =
    view.departments.some((row) => draft[row.teamId]?.target !== row.target || (draft[row.teamId]?.mention ?? '') !== (row.mention ?? '')) ||
    (!urlMode && fallback !== (view.fallback === '' && provider !== 'msteams' ? NONE : view.fallback));

  const nameOf = (id: string) => view.destinations.find((destination) => destination.id === id)?.name ?? id;
  const nothing = makesIssues(provider) ? 'no issue created' : 'not posted';
  const fallbackLabel =
    fallback === NONE
      ? nothing
      : fallback
        ? nameOf(fallback)
        : provider === 'msteams'
          ? 'the channel the bot was last active in'
          : nothing;

  const save = async () => {
    setSaving(true);
    try {
      apply(
        await api.integrations.saveRouting(provider, {
          departments: view.departments.map((row) => ({
            teamId: row.teamId,
            target: draft[row.teamId]?.target ?? '',
            mention: provider === 'slack' ? draft[row.teamId]?.mention || null : undefined,
          })),
          ...(urlMode ? {} : { fallback }),
        }),
      );
      toast.success(`Saved where each department's tickets go in ${noun.app}.`);
    } catch (caught) {
      toast.error('Could not save', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setResults(null);
    try {
      setResults((await api.integrations.testRouting(provider as 'slack' | 'msteams')).results);
    } catch (caught) {
      toast.error('Test failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setTesting(false);
    }
  };

  const destinationSelect = (value: string, onChange: (next: string) => void, blankLabel: string, extra: Array<{ id: string; name: string }> = []) => (
    <Select value={value} onChange={(event) => onChange(event.target.value)} disabled={!canPick && (!value || value === NONE)} className="min-w-0">
      <option value="">{blankLabel}</option>
      {extra.map((option) => (
        <option key={`x-${option.id}`} value={option.id}>
          {option.name}
        </option>
      ))}
      {view.destinations.map((destination) => (
        <option key={destination.id} value={destination.id}>
          {destination.name}
          {destination.warning ? ` (${destination.warning.toLowerCase()})` : ''}
        </option>
      ))}
      {/* A saved target the list no longer shows (archived channel, removed bot) stays visible. */}
      {value && value !== NONE && !view.destinations.some((destination) => destination.id === value) && !extra.some((option) => option.id === value) && (
        <option value={value}>{value} (not found)</option>
      )}
    </Select>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">Where each department's tickets go</p>
          <p className="mt-0.5 text-xs text-muted">
            {provider === 'github'
              ? "A ticket pushed to GitHub becomes an issue in its department's repository, and issues labelled for tickets there come back to that department."
              : provider === 'linear'
              ? 'Pushing a ticket to Linear, by hand or automatically, creates the issue in its department\'s Linear team.'
              : `Each department posts into its own ${noun.thing}. A ticket escalated to another department carries on in that department's ${noun.thing}.`}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => void load()} aria-label={`Reload ${noun.things}`}>
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      {view.notice && <p className="rounded-sm border border-dashed px-2.5 py-2 text-xs text-muted">{view.notice}</p>}

      <div className="overflow-x-auto rounded-sm border">
        <table className="w-full min-w-[34rem] text-xs">
          <thead>
            <tr className="border-b surface-2 text-left">
              <th className="eyebrow w-[35%] px-3 py-2 font-medium">Department</th>
              <th className="eyebrow px-3 py-2 font-medium">{provider === 'linear' ? 'Linear team' : provider === 'github' ? 'Repository' : urlMode ? 'Workflows webhook URL' : 'Channel'}</th>
              {provider === 'slack' && <th className="eyebrow w-40 px-3 py-2 font-medium">Ping</th>}
            </tr>
          </thead>
          <tbody>
            {view.departments.map((row) => {
              const current = draft[row.teamId] ?? { target: '', mention: '' };
              const set = (patch: Partial<typeof current>) => setDraft((all) => ({ ...all, [row.teamId]: { ...current, ...patch } }));
              const warning = view.destinations.find((destination) => destination.id === current.target)?.warning;
              return (
                <tr key={row.teamId} className="border-b last:border-0">
                  <td className="px-3 py-2 font-medium">{row.teamName}</td>
                  <td className="px-3 py-1.5">
                    {urlMode ? (
                      <Input
                        value={current.target}
                        onChange={(event) => set({ target: event.target.value })}
                        placeholder="Same as the default webhook"
                        className="font-mono text-2xs"
                      />
                    ) : (
                      destinationSelect(current.target, (target) => set({ target }), `Everything else (${fallbackLabel})`)
                    )}
                    {warning && <p className="mt-0.5 text-2xs text-[var(--priority-high)]">{warning}</p>}
                  </td>
                  {provider === 'slack' && (
                    <td className="px-3 py-1.5">
                      <Input
                        value={current.mention}
                        onChange={(event) => set({ mention: event.target.value })}
                        placeholder="Nobody"
                        title="@here, @channel, or a user group ID (S…)"
                        className="font-mono text-2xs"
                      />
                    </td>
                  )}
                </tr>
              );
            })}
            {!urlMode && (
              <tr className="surface-2">
                <td className="px-3 py-2">
                  <span className="font-medium">Everything else</span>
                  <span className="block text-2xs text-muted">Departments left on "Everything else", and tickets with no department</span>
                </td>
                <td className="px-3 py-1.5" colSpan={provider === 'slack' ? 2 : 1}>
                  {destinationSelect(
                    fallback,
                    setFallback,
                    provider === 'msteams' ? 'The channel the bot was last active in' : makesIssues(provider) ? "Don't create an issue" : "Don't post",
                    provider === 'msteams' ? [{ id: NONE, name: "Don't post" }] : [],
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {view.departments.length === 0 && <p className="text-xs text-subtle">No departments yet. Create them under Teams.</p>}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {!makesIssues(provider) && (
          <Button variant="secondary" size="sm" loading={testing} disabled={dirty} onClick={() => void test()} title={dirty ? 'Save first' : undefined}>
            <Send className="size-3.5" />
            Send a test to every {noun.thing}
          </Button>
        )}
        <Button variant="primary" size="sm" loading={saving} disabled={!dirty} onClick={() => void save()}>
          Save routing
        </Button>
      </div>

      {results && (
        <ul className="space-y-1 rounded-sm border p-2.5 text-xs surface-2">
          {results.length === 0 && <li className="text-muted">Nothing to test: no department has a {noun.thing} yet.</li>}
          {results.map((result) => (
            <li key={result.target} className="flex items-start gap-1.5">
              {result.ok ? (
                <CheckCircle2 className="mt-px size-3.5 shrink-0 text-[var(--status-resolved)]" />
              ) : (
                <CircleAlert className="mt-px size-3.5 shrink-0 text-[var(--priority-urgent)]" />
              )}
              <span className={cn('min-w-0', !result.ok && 'text-[var(--priority-urgent)]')}>
                <span className="font-medium">{result.name}</span> · {result.departments.join(', ')}
                {result.error ? ` — ${result.error}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
