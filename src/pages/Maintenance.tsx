import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, Globe, MoreHorizontal, Plus, Repeat, Wrench } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { opsApi } from '@/lib/ops-api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { useDocumentTitle } from '@/state/branding';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { MaintenanceDialog } from '@/components/ops/MaintenanceDialog';
import { MAINTENANCE_COLOR, effectShort, remainingLabel } from '@/components/ops/MaintenanceShared';
import type { MaintenanceOccurrence, MaintenanceState, MaintenanceWindow } from '@shared/ops';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATE_COLORS: Record<MaintenanceState, string> = {
  in_progress: MAINTENANCE_COLOR,
  scheduled: 'var(--priority-normal)',
  completed: '#9ca3af',
  cancelled: '#9ca3af',
};
const STATE_LABELS: Record<MaintenanceState, string> = {
  in_progress: 'In progress',
  scheduled: 'Scheduled',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function message(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
}

function range(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const day = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return day(start) === day(end) ? `${day(start)}, ${time(start)} – ${time(end)}` : `${day(start)}, ${time(start)} – ${day(end)}, ${time(end)}`;
}

/** "Every Sun, Wed at 22:00 for 2h (Africa/Johannesburg)". */
function recurrenceLabel(w: MaintenanceWindow): string | null {
  const r = w.recurrence;
  if (r.kind === 'none') return null;
  const mins = r.durationMins ?? 60;
  const length = mins % 60 ? `${Math.floor(mins / 60) ? `${Math.floor(mins / 60)}h ` : ''}${mins % 60}m` : `${mins / 60}h`;
  const when =
    r.kind === 'daily'
      ? 'Every day'
      : r.kind === 'weekly'
        ? `Every ${(r.daysOfWeek ?? []).map((d) => WEEKDAYS[d]).join(', ')}`
        : `Monthly on day ${r.dayOfMonth}`;
  return `${when} at ${r.startTime} for ${length} (${w.timeZone.replace('_', ' ')})${r.until ? `, until ${r.until}` : ''}`;
}

export function MaintenancePage() {
  useDocumentTitle('Maintenance');
  const { can } = useAuth();
  const canManage = can('maintenance.manage');
  const toast = useToast();
  const [windows, setWindows] = useState<MaintenanceWindow[]>([]);
  const [occurrences, setOccurrences] = useState<MaintenanceOccurrence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<MaintenanceWindow | 'new' | null>(null);
  const [cancelling, setCancelling] = useState<MaintenanceWindow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await opsApi.maintenance.list();
      setWindows(result.windows);
      setOccurrences(result.occurrences);
    } catch (caught) {
      setError(message(caught, 'Could not load maintenance.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
      toast.success(label);
      await load();
    } catch (caught) {
      toast.error('That did not work', message(caught, ''));
    }
  };

  const groups: Array<{ title: string; items: MaintenanceWindow[] }> = [
    { title: 'In progress', items: windows.filter((w) => w.state === 'in_progress') },
    { title: 'Upcoming', items: windows.filter((w) => w.state === 'scheduled') },
    { title: 'Past and cancelled', items: windows.filter((w) => w.state === 'completed' || w.state === 'cancelled') },
  ];

  const menuFor = (w: MaintenanceWindow): MenuItem[] => {
    const items: MenuItem[] = [{ label: 'Edit', onSelect: () => setEditing(w) }];
    if (w.state === 'in_progress') items.push({ label: 'End now', onSelect: () => act('Maintenance ended.', () => opsApi.maintenance.end(w.id)) });
    if (w.state === 'in_progress' || w.state === 'scheduled') {
      items.push(
        { label: 'Extend by 30 minutes', onSelect: () => act('Extended by 30 minutes.', () => opsApi.maintenance.extend(w.id, { minutes: 30 })) },
        { label: 'Extend by 1 hour', onSelect: () => act('Extended by an hour.', () => opsApi.maintenance.extend(w.id, { minutes: 60 })) },
      );
    }
    if (w.state === 'scheduled' && w.recurrence.kind !== 'none' && w.nextOccurrence) {
      const next = w.nextOccurrence;
      items.push({ label: 'Skip the next one', onSelect: () => act('Next occurrence skipped.', () => opsApi.maintenance.cancel(w.id, next.key)) });
    }
    if (w.state === 'in_progress' || w.state === 'scheduled') items.push({ label: 'Cancel', destructive: true, onSelect: () => setCancelling(w) });
    return items;
  };

  return (
    <div>
      <PageHeader docs="maintenance"
        title="Maintenance"
        description="Planned work pauses paging or alerting for what it touches, so expected disruption does not wake anyone. Published windows appear on status pages."
        actions={
          canManage && (
            <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
              <Plus className="size-3.5" />
              Schedule maintenance
            </Button>
          )
        }
      />

      {error ? (
        <ErrorPane message={error} retry={load} />
      ) : loading ? (
        <LoadingPane label="Loading maintenance" />
      ) : (
        <div className="space-y-6 p-4 sm:p-6">
          <CalendarStrip occurrences={occurrences} />

          {windows.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="No maintenance scheduled"
              description="Schedule a window before planned work - a deploy, a firewall swap, Sunday patching - so the reboot does not page anyone."
            />
          ) : (
            groups.map(
              (group) =>
                group.items.length > 0 && (
                  <section key={group.title}>
                    <h2 className="eyebrow mb-2">{group.title}</h2>
                    <ul className="space-y-2">
                      {group.items.map((w) => (
                        <WindowCard key={w.id} window={w} menu={canManage ? menuFor(w) : null} />
                      ))}
                    </ul>
                  </section>
                ),
            )
          )}
        </div>
      )}

      {editing && (
        <MaintenanceDialog
          window={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            const wasNew = editing === 'new';
            setEditing(null);
            await load();
            toast.success(wasNew ? 'Maintenance scheduled.' : 'Maintenance updated.');
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(cancelling)}
        onClose={() => setCancelling(null)}
        title={`Cancel "${cancelling?.title}"?`}
        message={
          cancelling?.recurrence.kind !== 'none'
            ? 'Every future occurrence is cancelled. Anything it is holding back and still firing is raised straight away.'
            : 'Paging and alerting resume immediately. Anything it is holding back and still firing is raised straight away.'
        }
        confirmLabel="Cancel maintenance"
        destructive
        onConfirm={async () => {
          if (!cancelling) return;
          const w = cancelling;
          setCancelling(null);
          await act('Maintenance cancelled.', () => opsApi.maintenance.cancel(w.id));
        }}
      />
    </div>
  );
}

function WindowCard({ window: w, menu }: { window: MaintenanceWindow; menu: MenuItem[] | null }) {
  const occurrence = w.currentOccurrence ?? w.nextOccurrence;
  const recurrence = recurrenceLabel(w);
  return (
    <li className={cn('rounded-md border p-3 surface', w.state === 'in_progress' && 'border-l-[3px]')} style={w.state === 'in_progress' ? { borderLeftColor: MAINTENANCE_COLOR } : undefined}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {w.title}
            <Badge color={STATE_COLORS[w.state]}>{STATE_LABELS[w.state]}</Badge>
            {w.publishToStatusPages && (
              <span className="inline-flex items-center gap-1 text-2xs text-subtle" title="Shown on status pages">
                <Globe className="size-3" /> Published
              </span>
            )}
          </p>
          {occurrence && (
            <p className="mt-0.5 text-xs text-muted">
              {range(occurrence.startsAt, occurrence.endsAt)}
              {w.state === 'in_progress' && <span style={{ color: MAINTENANCE_COLOR }}> · {remainingLabel(occurrence.endsAt)}</span>}
            </p>
          )}
          {!occurrence && w.recurrence.kind === 'none' && w.endsAt && <p className="mt-0.5 text-xs text-muted">{range(w.startsAt, w.endsAt)}</p>}
          {recurrence && (
            <p className="mt-0.5 flex items-center gap-1 text-2xs text-subtle">
              <Repeat className="size-3" /> {recurrence}
            </p>
          )}
          <p className="mt-1 text-2xs text-subtle">
            {w.scopeSummary} · {effectShort(w.effect)}
            {w.notifyBeforeMins > 0 && ` · teams told ${w.notifyBeforeMins >= 60 ? `${w.notifyBeforeMins / 60}h` : `${w.notifyBeforeMins}m`} before`}
            {w.createdByName && ` · by ${w.createdByName}`}
          </p>
          {w.description && <p className="mt-1.5 text-xs">{w.description}</p>}
        </div>
        {menu && (
          <Menu
            items={menu}
            trigger={({ toggle }) => (
              <Button variant="ghost" size="icon" onClick={toggle} aria-label={`Actions for ${w.title}`}>
                <MoreHorizontal className="size-4" />
              </Button>
            )}
          />
        )}
      </div>
    </li>
  );
}

/** The next 30 days, one column each, with a bar for every day touched by maintenance. */
function CalendarStrip({ occurrences }: { occurrences: MaintenanceOccurrence[] }) {
  const days = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return Array.from({ length: 30 }, (_, i) => {
      const from = new Date(start.getTime() + i * 86_400_000);
      const to = new Date(from.getTime() + 86_400_000);
      const hits = occurrences.filter((o) => new Date(o.startsAt) < to && new Date(o.endsAt) > from);
      return { from, hits };
    });
  }, [occurrences]);

  return (
    <section aria-label="Maintenance in the next 30 days">
      <h2 className="eyebrow mb-2">Next 30 days</h2>
      <div className="overflow-x-auto rounded-md border surface">
        <div className="grid min-w-[42rem] grid-cols-[repeat(30,minmax(0,1fr))]">
          {days.map(({ from, hits }, i) => {
            const weekend = from.getDay() === 0 || from.getDay() === 6;
            return (
              <div
                key={from.toISOString()}
                className={cn('flex h-20 flex-col border-r px-0.5 pt-1 last:border-r-0', weekend && 'bg-[var(--surface-2)]')}
                title={hits.length ? hits.map((h) => `${h.title}: ${range(h.startsAt, h.endsAt)}`).join('\n') : undefined}
              >
                <span className={cn('text-center text-2xs', i === 0 ? 'font-semibold text-[var(--fg)]' : 'text-subtle')}>
                  {from.toLocaleDateString(undefined, { weekday: 'narrow' })}
                </span>
                <span className={cn('tabular text-center text-2xs', i === 0 ? 'font-semibold' : 'text-muted')}>{from.getDate()}</span>
                <div className="mt-1 flex flex-col gap-0.5">
                  {hits.slice(0, 3).map((h) => (
                    <span key={`${h.windowId}:${h.key}`} className="block h-1.5 rounded-full" style={{ background: MAINTENANCE_COLOR, opacity: h.effect === 'pause_alerting' ? 1 : 0.55 }} />
                  ))}
                  {hits.length > 3 && <span className="text-center text-[9px] text-subtle">+{hits.length - 3}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <p className="mt-1.5 flex items-center gap-3 text-2xs text-subtle">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-1.5 w-3 rounded-full" style={{ background: MAINTENANCE_COLOR, opacity: 0.55 }} /> Paging paused
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-1.5 w-3 rounded-full" style={{ background: MAINTENANCE_COLOR }} /> Alerting paused
        </span>
        <span className="inline-flex items-center gap-1">
          <Wrench className="size-3" /> Hover a day for details
        </span>
      </p>
    </section>
  );
}
