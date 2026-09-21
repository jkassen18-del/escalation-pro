import { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { PRIORITY_COLORS, PRIORITY_LABELS, duration } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/Field';
import { ErrorPane, LoadingPane, MeterBar } from '@/components/ui/Feedback';
import type { ReportSummary } from '@shared/types';

const RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
] as const;

export function ReportsPage() {
  const { can } = useAuth();
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const rangeParams = useCallback(() => {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000).toISOString();
    return { from, to };
  }, [days]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.reports.summary(rangeParams());
      setSummary(result.summary);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load reports.');
    } finally {
      setLoading(false);
    }
  }, [rangeParams]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <PageHeader
        title="Reports"
        description="Volume, workload, and SLA performance across the tickets you can see."
        actions={
          <>
            <SegmentedControl value={days} onChange={setDays} options={RANGES.map((r) => ({ ...r }))} />
            {can('reports.export') && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => window.open(api.reports.exportUrl(rangeParams()), '_blank', 'noopener')}
              >
                <Download className="size-3.5" />
                Export XLSX
              </Button>
            )}
          </>
        }
      />

      {error ? (
        <ErrorPane message={error} retry={load} />
      ) : loading || !summary ? (
        <LoadingPane label="Crunching the numbers" />
      ) : (
        <div className="space-y-4 p-4 sm:p-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Open" value={summary.totals.open + summary.totals.inProgress + summary.totals.pending} />
            <Stat
              label="Overdue"
              value={summary.totals.overdue}
              tone={summary.totals.overdue > 0 ? 'danger' : undefined}
            />
            <Stat label="Unassigned" value={summary.totals.unassigned} />
            <Stat label="Resolved" value={summary.totals.resolved + summary.totals.closed} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Panel title="SLA performance" className="lg:col-span-1">
              <dl className="space-y-3">
                <div>
                  <dt className="text-xs text-subtle">Compliance</dt>
                  <dd className="mt-0.5 flex items-baseline gap-2">
                    <span className="tabular text-2xl font-semibold">
                      {summary.slaCompliancePct === null ? '—' : `${summary.slaCompliancePct}%`}
                    </span>
                    <span className="text-2xs text-subtle">of closed tickets met their target</span>
                  </dd>
                  {summary.slaCompliancePct !== null && (
                    <div className="mt-2">
                      <MeterBar
                        value={summary.slaCompliancePct}
                        max={100}
                        color={
                          summary.slaCompliancePct >= 90
                            ? 'var(--status-resolved)'
                            : summary.slaCompliancePct >= 70
                              ? 'var(--priority-high)'
                              : 'var(--priority-urgent)'
                        }
                      />
                    </div>
                  )}
                </div>
                <div className="flex justify-between border-t pt-3 text-xs">
                  <dt className="text-subtle">Average first reply</dt>
                  <dd className="tabular font-medium">{duration(summary.avgFirstResponseMins)}</dd>
                </div>
                <div className="flex justify-between text-xs">
                  <dt className="text-subtle">Average resolution</dt>
                  <dd className="tabular font-medium">{duration(summary.avgResolutionMins)}</dd>
                </div>
              </dl>
            </Panel>

            <Panel title="Volume" className="lg:col-span-2">
              <VolumeChart data={summary.volumeByDay} />
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Panel title="By priority">
              <BarList
                items={summary.byPriority.map((entry) => ({
                  label: PRIORITY_LABELS[entry.priority],
                  value: entry.count,
                  color: PRIORITY_COLORS[entry.priority],
                }))}
              />
            </Panel>

            <Panel title="By team">
              <BarList
                items={summary.byTeam.map((entry) => ({
                  label: entry.teamName,
                  value: entry.count,
                  suffix: entry.overdue > 0 ? `${entry.overdue} overdue` : undefined,
                  color: 'var(--accent)',
                }))}
              />
            </Panel>

            <Panel title="Workload by assignee">
              <BarList
                items={summary.byAssignee.map((entry) => ({
                  label: entry.assigneeName,
                  value: entry.open,
                  suffix: `${entry.resolved} resolved`,
                  color: 'var(--status-open)',
                }))}
              />
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'danger' }) {
  return (
    <div className="rounded-md border px-4 py-3 surface">
      <p className="eyebrow">{label}</p>
      <p
        className={cn('tabular mt-1 text-2xl font-semibold', tone === 'danger' && 'text-[var(--priority-urgent)]')}
      >
        {value}
      </p>
    </div>
  );
}

function Panel({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-md border surface', className)}>
      <h2 className="border-b px-4 py-2.5 text-xs font-semibold">{title}</h2>
      <div className="px-4 py-3.5">{children}</div>
    </section>
  );
}

function BarList({
  items,
}: {
  items: Array<{ label: string; value: number; suffix?: string; color: string }>;
}) {
  const max = Math.max(1, ...items.map((item) => item.value));
  const visible = items.filter((item) => item.value > 0);

  if (visible.length === 0) {
    return <p className="py-4 text-center text-xs text-subtle">No data in this period.</p>;
  }

  return (
    <ul className="space-y-2.5">
      {visible.map((item) => (
        <li key={item.label}>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="truncate text-xs">{item.label}</span>
            <span className="shrink-0 text-2xs text-subtle">
              {item.suffix && <span className="mr-1.5">{item.suffix}</span>}
              <span className="tabular font-medium text-[var(--fg)]">{item.value}</span>
            </span>
          </div>
          <MeterBar value={item.value} max={max} color={item.color} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Small inline column chart. Created and resolved sit side by side per day, so
 * you can see whether the queue is growing or shrinking at a glance.
 */
function VolumeChart({ data }: { data: ReportSummary['volumeByDay'] }) {
  const max = Math.max(1, ...data.map((day) => Math.max(day.created, day.resolved)));
  // Long ranges get thinned out so the bars stay readable.
  const step = data.length > 45 ? Math.ceil(data.length / 45) : 1;
  const visible = data.filter((_, index) => index % step === 0);

  return (
    <div>
      <div className="flex h-32 items-end gap-px" role="img" aria-label="Tickets created and resolved per day">
        {visible.map((day) => (
          <div key={day.date} className="group relative flex h-full flex-1 items-end gap-px" title={`${day.date}: ${day.created} created, ${day.resolved} resolved`}>
            <div
              className="flex-1 rounded-t-[1px] bg-[var(--status-open)] transition-opacity group-hover:opacity-80"
              style={{ height: `${(day.created / max) * 100}%`, minHeight: day.created ? 2 : 0 }}
            />
            <div
              className="flex-1 rounded-t-[1px] bg-[var(--status-resolved)] transition-opacity group-hover:opacity-80"
              style={{ height: `${(day.resolved / max) * 100}%`, minHeight: day.resolved ? 2 : 0 }}
            />
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between border-t pt-2">
        <div className="flex gap-3 text-2xs">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-[2px] bg-[var(--status-open)]" />
            Created
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-[2px] bg-[var(--status-resolved)]" />
            Resolved
          </span>
        </div>
        <span className="text-2xs text-subtle">
          {visible[0]?.date} → {visible.at(-1)?.date}
        </span>
      </div>
    </div>
  );
}
