import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { opsApi } from '@/lib/ops-api';
import { Button } from '@/components/ui/Button';
import type { Schedule, Shift } from '@shared/ops';

const DAY_MS = 86_400_000;

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}

/**
 * "Who's on call" for a whole month, one cell per day. A day shows whoever is
 * on call at noon, plus a dot when someone else covers part of it.
 */
export function ScheduleCalendar({ schedule, colorOf }: { schedule: Schedule; colorOf: (userId: string) => string }) {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [shifts, setShifts] = useState<Shift[]>([]);

  // Monday-first grid covering the month.
  const gridStart = new Date(month);
  gridStart.setDate(1 - ((month.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  const from = days[0].getTime();
  const to = days[days.length - 1].getTime() + DAY_MS;

  const load = useCallback(async () => {
    const result = await opsApi.schedules.get(schedule.id, { from: new Date(from).toISOString(), to: new Date(to).toISOString() });
    setShifts(result.shifts);
  }, [schedule.id, from, to]);

  useEffect(() => {
    void load().catch(() => setShifts([]));
  }, [load, schedule.updatedAt, schedule.overrides.length]);

  const covering = (day: Date) => {
    const start = day.getTime();
    const end = start + DAY_MS;
    const during = shifts.filter((s) => new Date(s.startsAt).getTime() < end && new Date(s.endsAt).getTime() > start);
    const noon = start + DAY_MS / 2;
    const main = during.find((s) => new Date(s.startsAt).getTime() <= noon && new Date(s.endsAt).getTime() > noon) ?? during[0];
    return { main, others: during.filter((s) => s.userId !== main?.userId) };
  };

  const today = new Date().toDateString();

  return (
    <div className="rounded-md border p-4 surface">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold">Who's on call · {month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</p>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month">
            <ChevronLeft className="size-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
            Today
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-sm border bg-[var(--border)] text-2xs">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((name) => (
          <div key={name} className="px-1.5 py-1 text-center text-subtle surface-2">
            {name}
          </div>
        ))}
        {days.map((day) => {
          const { main, others } = covering(day);
          const inMonth = day.getMonth() === month.getMonth();
          return (
            <div
              key={day.toISOString()}
              title={main ? [main, ...others].map((s) => s.userName).join(', ') : 'Nobody on call'}
              className={`min-h-14 p-1 surface ${inMonth ? '' : 'opacity-45'}`}
            >
              <span className={`tabular ${day.toDateString() === today ? 'rounded-sm bg-[var(--accent)] px-1 text-[var(--accent-fg,#fff)]' : 'text-subtle'}`}>
                {day.getDate()}
              </span>
              {main ? (
                <div className="mt-1 flex items-center gap-1">
                  <span
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                    style={{ background: colorOf(main.userId) }}
                  >
                    {initials(main.userName)}
                  </span>
                  <span className="hidden min-w-0 truncate sm:inline">{main.userName.split(' ')[0]}</span>
                  {others.length > 0 && <span className="size-1.5 shrink-0 rounded-full bg-[var(--fg-subtle)]" aria-label="Others cover part of this day" />}
                </div>
              ) : (
                <div className="mt-1 text-subtle">—</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
