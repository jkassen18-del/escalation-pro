import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BellRing, PhoneCall, UserRound } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { opsApi } from '@/lib/ops-api';
import { relativeTime, shortDateTime } from '@/lib/format';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SegmentedControl } from '@/components/ui/Field';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { Avatar } from '@/components/ui/Avatar';
import { useAuth } from '@/state/auth';
import type { Page, Schedule } from '@shared/ops';
import { SeverityBadge, type DirectoryPerson } from './OnCallShared';
import { PageExplainer } from './PageExplainer';

const PAGE_STATUS_COLORS: Record<Page['status'], string> = {
  triggered: 'var(--priority-urgent)',
  acknowledged: 'var(--status-progress)',
  resolved: 'var(--status-resolved)',
  exhausted: 'var(--priority-high)',
};

export function OnCallNow({ people }: { people: DirectoryPerson[] }) {
  const { user, can } = useAuth();
  // Server-side, only people the page reached (or on-call managers) may act on it.
  const respond = can('pages.respond', 'oncall.manage');
  const toast = useToast();
  const [filter, setFilter] = useState<'active' | 'mine' | 'all'>('active');
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  const [policyLevels, setPolicyLevels] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [explaining, setExplaining] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, p, policies] = await Promise.all([opsApi.schedules.list(), opsApi.pages.list({ filter }), opsApi.policies.list()]);
      setSchedules(s.schedules);
      setPages(p.pages);
      setPolicyLevels(Object.fromEntries(policies.policies.map((policy) => [policy.id, policy.levels.length])));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load on-call.');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
    // Pages move on their own; keep the list honest without a manual refresh.
    const timer = window.setInterval(load, 20_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (page: Page, action: 'ack' | 'escalate') => {
    setBusy(page.id + action);
    try {
      if (action === 'ack') await opsApi.pages.ack(page.id);
      else await opsApi.pages.escalate(page.id);
      toast.success(action === 'ack' ? 'Acknowledged. Escalation stopped.' : 'Escalated to the next level.');
      await load();
    } catch (caught) {
      toast.error('Could not update the page', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? 'Unknown';

  if (error) return <ErrorPane message={error} retry={load} />;
  if (loading) return <LoadingPane label="Loading on-call" />;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <section>
        <p className="eyebrow mb-2">On call now</p>
        {schedules.length === 0 ? (
          <p className="text-xs text-muted">No schedules yet. Create one under Schedules.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {schedules.map((schedule) => {
              const person = schedule.onCallNow ? people.find((p) => p.id === schedule.onCallNow!.userId) : null;
              return (
                <article key={schedule.id} className="flex items-center gap-3 rounded-md border p-3 surface">
                  {schedule.onCallNow ? (
                    <Avatar name={schedule.onCallNow.userName} color={person?.avatarColor} size="md" />
                  ) : (
                    <span className="flex size-7 items-center justify-center rounded-full border surface-2">
                      <UserRound className="size-3.5 text-[var(--fg-subtle)]" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-subtle">
                      {schedule.name}
                      {schedule.teamName ? ` · ${schedule.teamName}` : ''}
                    </p>
                    <p className="truncate text-sm font-medium">{schedule.onCallNow?.userName ?? 'Nobody on call'}</p>
                    {schedule.onCallNow?.until && (
                      <p className="text-2xs text-subtle">until {shortDateTime(schedule.onCallNow.until)}</p>
                    )}
                  </div>
                  {schedule.onCallNow?.userId === user?.id && <Badge color="var(--status-resolved)">You</Badge>}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="eyebrow">Pages</p>
          <SegmentedControl
            value={filter}
            onChange={(value) => {
              setLoading(true);
              setFilter(value);
            }}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'mine', label: 'Mine' },
              { value: 'all', label: 'History' },
            ]}
          />
        </div>

        {pages.length === 0 ? (
          <EmptyState
            icon={BellRing}
            title={filter === 'mine' ? 'Nothing is paging you' : filter === 'active' ? 'No active pages' : 'No pages yet'}
            description="When a monitor or alert source opens an incident with an escalation policy, the page shows up here until someone acknowledges it."
            className="rounded-md border surface"
          />
        ) : (
          <ul className="divide-y rounded-md border surface">
            {pages.map((page) => {
              const levels = page.policyId ? policyLevels[page.policyId] : undefined;
              const live = page.status === 'triggered' || page.status === 'exhausted';
              return (
                <li key={page.id} className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-start sm:px-4">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <SeverityBadge severity={page.severity} />
                      <Badge color={PAGE_STATUS_COLORS[page.status]}>{page.status}</Badge>
                      {page.ticketReference && (
                        <Link to={`/tickets/${page.ticketId}`} className="font-mono text-2xs text-[var(--accent)] hover:underline">
                          {page.ticketReference}
                        </Link>
                      )}
                    </div>
                    <Link to={`/tickets/${page.ticketId}`} className="block truncate text-sm font-medium hover:underline">
                      {page.ticketSubject ?? 'Incident'}
                    </Link>
                    <p className="text-xs text-muted">
                      {page.policyName ?? 'No policy'} · level {page.currentLevel + 1}
                      {levels ? ` of ${levels}` : ''}
                      {page.cycle > 0 ? ` · pass ${page.cycle + 1}` : ''} · started {relativeTime(page.createdAt)}
                    </p>
                    <p className="text-xs text-subtle">
                      {page.status === 'acknowledged'
                        ? `Acknowledged by ${page.acknowledgedByName ?? 'someone'} ${relativeTime(page.acknowledgedAt)}`
                        : page.currentTargetIds.length
                          ? `Paging ${page.currentTargetIds.map(nameOf).join(', ')}`
                          : 'Nobody to page at this level'}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => setExplaining(page.id)}>
                      Why?
                    </Button>
                    {respond && page.status === 'triggered' && (
                      <Button variant="secondary" size="sm" loading={busy === page.id + 'escalate'} onClick={() => act(page, 'escalate')}>
                        Escalate now
                      </Button>
                    )}
                    {respond && live && (
                      <Button variant="primary" size="sm" loading={busy === page.id + 'ack'} onClick={() => act(page, 'ack')}>
                        <PhoneCall className="size-3.5" />
                        Acknowledge
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {explaining && <PageExplainer pageId={explaining} onClose={() => setExplaining(null)} />}
    </div>
  );
}
