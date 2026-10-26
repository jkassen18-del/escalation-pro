import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { SegmentedControl } from '@/components/ui/Field';
import type { ActivityDay } from '@shared/types';

type Metric = 'created' | 'resolved' | 'both';

const METRIC_LABELS: Record<Metric, string> = { created: 'Created', resolved: 'Resolved', both: 'All activity' };

/* One hue per metric, stepped light to dark by mixing into the empty-cell colour. */
const METRIC_HUES: Record<Metric, string> = {
  created: 'var(--accent)',
  resolved: 'var(--status-resolved)',
  both: 'var(--status-open)',
};
const STEPS = [0, 30, 55, 78, 100];
const WEEKS = 53;

/** yyyy-mm-dd of a local date, matching the server's tzOffset bucketing. */
function localKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function cellColor(metric: Metric, step: number): string {
  if (step === 0) return 'var(--surface-3)';
  return `color-mix(in srgb, ${METRIC_HUES[metric]} ${STEPS[step]}%, var(--surface-3))`;
}

/**
 * A year of ticket activity, one square a day, in the style of a contribution
 * graph. Clicking a square opens the tickets raised that day.
 */
export function ActivityHeatmap() {
  const navigate = useNavigate();
  const [metric, setMetric] = useState<Metric>('created');
  const [days, setDays] = useState<ActivityDay[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.tickets
      .activity({ days: WEEKS * 7 })
      .then((result) => !cancelled && setDays(result.days))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const byDate = useMemo(() => new Map((days ?? []).map((day) => [day.date, day])), [days]);

  // Columns of weeks ending with the current one; rows Sunday to Saturday.
  const { columns, months } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - today.getDay() - (WEEKS - 1) * 7);
    const cols: Array<Array<{ key: string; date: Date; future: boolean }>> = [];
    const labels: Array<{ col: number; label: string }> = [];
    for (let w = 0; w < WEEKS; w += 1) {
      const col = [];
      for (let d = 0; d < 7; d += 1) {
        const date = new Date(start);
        date.setDate(start.getDate() + w * 7 + d);
        col.push({ key: localKey(date), date, future: date > today });
      }
      // A month is labelled over the first week that starts in it.
      if (w > 0 && col[0].date.getMonth() !== cols[w - 1][0].date.getMonth()) {
        labels.push({ col: w, label: col[0].date.toLocaleDateString(undefined, { month: 'short' }) });
      }
      cols.push(col);
    }
    return { columns: cols, months: labels };
  }, []);

  const valueOf = (key: string) => {
    const day = byDate.get(key);
    if (!day) return 0;
    return metric === 'created' ? day.created : metric === 'resolved' ? day.resolved : day.created + day.resolved;
  };

  // Quartile-ish steps from the busiest day, so a quiet desk still shows texture.
  const max = Math.max(1, ...columns.flat().map((cell) => valueOf(cell.key)));
  const stepOf = (value: number) => (value <= 0 ? 0 : Math.min(4, Math.ceil((value / max) * 4)));

  const totals = (days ?? []).reduce((sum, day) => ({ created: sum.created + day.created, resolved: sum.resolved + day.resolved }), {
    created: 0,
    resolved: 0,
  });

  const showTip = (target: HTMLElement, key: string) => {
    const box = target.getBoundingClientRect();
    const parent = target.closest('section')!.getBoundingClientRect();
    setHover({ key, x: box.left - parent.left + box.width / 2, y: box.top - parent.top });
  };

  const hovered = hover ? { ...(byDate.get(hover.key) ?? { created: 0, resolved: 0 }), key: hover.key } : null;

  return (
    <section className="relative min-w-0 rounded-md border surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <div>
          <h2 className="text-xs font-semibold">Ticket activity</h2>
          <p className="text-2xs text-muted">
            {days
              ? `${totals.created.toLocaleString()} created · ${totals.resolved.toLocaleString()} resolved in the last year`
              : failed
                ? 'Could not load activity.'
                : 'Loading…'}
          </p>
        </div>
        <SegmentedControl
          value={metric}
          onChange={setMetric}
          options={(Object.keys(METRIC_LABELS) as Metric[]).map((value) => ({ value, label: METRIC_LABELS[value] }))}
        />
      </div>

      <div className="relative overflow-x-auto px-4 py-3">
        {/* Squares grow with the card (up to a comfortable size) and scroll on a phone. */}
        <div className="grid min-w-[44rem] max-w-[72rem] grid-cols-[2rem_minmax(0,1fr)] gap-x-2">
          <span />
          <div className="mb-1 grid text-2xs text-muted" style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` }}>
            {columns.map((_, w) => (
              <span key={w} className="overflow-visible whitespace-nowrap">
                {months.find((month) => month.col === w)?.label ?? ''}
              </span>
            ))}
          </div>
          <div className="grid grid-rows-7 gap-[3px] text-2xs text-muted">
            {['', 'Mon', '', 'Wed', '', 'Fri', ''].map((label, index) => (
              <span key={index} className="flex items-center">
                {label}
              </span>
            ))}
          </div>
          <div
            className="grid grid-flow-col grid-rows-7 gap-[3px]"
            style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` }}
            onMouseLeave={() => setHover(null)}
          >
            {columns.flatMap((col) =>
              col.map((cell) =>
                cell.future ? (
                  <span key={cell.key} className="aspect-square" />
                ) : (
                  <button
                    key={cell.key}
                    type="button"
                    aria-label={`${cell.date.toDateString()}: ${byDate.get(cell.key)?.created ?? 0} created, ${byDate.get(cell.key)?.resolved ?? 0} resolved`}
                    onMouseEnter={(event) => showTip(event.currentTarget, cell.key)}
                    onFocus={(event) => showTip(event.currentTarget, cell.key)}
                    onBlur={() => setHover(null)}
                    onClick={() => {
                      // Midnight to midnight on the calendar, which is not always 24 hours.
                      const from = new Date(cell.date);
                      const to = new Date(from);
                      to.setDate(to.getDate() + 1);
                      const range = `=${encodeURIComponent(from.toISOString())}`;
                      const end = `=${encodeURIComponent(to.toISOString())}`;
                      navigate(metric === 'resolved' ? `/tickets?resolvedFrom${range}&resolvedTo${end}` : `/tickets?from${range}&to${end}`);
                    }}
                    className="aspect-square w-full rounded-[2px] outline-offset-1 hover:outline hover:outline-1 hover:outline-[var(--fg-muted)]"
                    style={{ background: cellColor(metric, stepOf(valueOf(cell.key))) }}
                  />
                ),
              ),
            )}
          </div>
        </div>

        <div className="mt-2 flex max-w-[72rem] min-w-[44rem] items-center justify-end gap-1 text-2xs text-muted">
          Less
          {[0, 1, 2, 3, 4].map((step) => (
            <span key={step} className="size-[11px] rounded-[2px]" style={{ background: cellColor(metric, step) }} />
          ))}
          More
        </div>
      </div>

      {hovered && hover && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-sm border px-2 py-1 text-2xs whitespace-nowrap surface overlay-shadow"
          style={{ left: hover.x, top: hover.y - 6 }}
          role="tooltip"
        >
          <p className="font-medium text-[var(--fg)]">
            {hovered.created} created · {hovered.resolved} resolved
          </p>
          <p className="text-muted">
            {new Date(`${hovered.key}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
          </p>
        </div>
      )}
    </section>
  );
}
