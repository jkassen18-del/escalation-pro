import { useMemo, useState } from 'react';
import { CalendarPlus, Plus, Repeat, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { buildWeeklyRoster, handoverDate } from '@shared/roster';
import type { RosterEntry } from '@shared/ops';
import { fromLocalInput, personColor, toLocalInput, type DirectoryPerson } from './OnCallShared';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK_MS = 7 * 86_400_000;

/** Today's date as YYYY-MM-DD in a time zone. */
function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** "3–9 Nov" for a week, "Mon 3 Nov 08:00 → Wed 5 Nov 08:00" for anything else. */
export function describeEntry(entry: RosterEntry, timeZone: string): string {
  const start = new Date(entry.startsAt);
  const end = new Date(entry.endsAt);
  const zone = safeZone(timeZone);
  const day = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-GB', { timeZone: zone, ...opts });
  if (end.getTime() - start.getTime() === WEEK_MS) {
    // A week handed over Monday 08:00 to Monday 08:00 reads as Monday to Sunday.
    const last = new Date(start.getTime() + 6 * 86_400_000);
    const sameMonth = day(start, { month: 'short' }) === day(last, { month: 'short' });
    return sameMonth
      ? `${day(start, { day: 'numeric' })}–${day(last, { day: 'numeric', month: 'short' })}`
      : `${day(start, { day: 'numeric', month: 'short' })} – ${day(last, { day: 'numeric', month: 'short' })}`;
  }
  const full = (d: Date) => d.toLocaleString('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `${full(start)} → ${full(end)}`;
}

/** Entries that overlap another, by index, so the editor can flag them before the server refuses. */
function overlapping(entries: RosterEntry[]): Set<number> {
  const bad = new Set<number>();
  entries.forEach((a, i) =>
    entries.forEach((b, j) => {
      if (i < j && a.startsAt < b.endsAt && b.startsAt < a.endsAt) {
        bad.add(i);
        bad.add(j);
      }
    }),
  );
  return bad;
}

/**
 * A fixed roster: who is on standby for which dates, set by hand. The
 * builder lays out whole weeks from a handover day and time in the
 * schedule's own time zone; single entries cover anything else.
 */
export function RosterEditor({
  entries,
  timeZone,
  people,
  onChange,
}: {
  entries: RosterEntry[];
  timeZone: string;
  people: DirectoryPerson[];
  onChange: (entries: RosterEntry[]) => void;
}) {
  const zone = safeZone(timeZone);
  const [weekday, setWeekday] = useState(1);
  const [time, setTime] = useState('08:00');
  const [firstWeek, setFirstWeek] = useState(() => todayIn(zone));
  const [weeks, setWeeks] = useState(4);
  const [cycle, setCycle] = useState<string[]>([]);

  const sorted = useMemo(() => [...entries].sort((a, b) => a.startsAt.localeCompare(b.startsAt)), [entries]);
  const clashes = useMemo(() => overlapping(sorted), [sorted]);
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? 'Unknown';

  /** Generated weeks replace whatever they overlap; everything else is kept. */
  const merge = (generated: RosterEntry[]) => {
    const kept = sorted.filter((e) => !generated.some((g) => e.startsAt < g.endsAt && g.startsAt < e.endsAt));
    onChange([...kept, ...generated].sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
  };

  const layOutWeeks = () => {
    const pool = cycle.length ? cycle : people.slice(0, 1).map((p) => p.id);
    if (!pool.length) return;
    merge(
      buildWeeklyRoster({
        firstWeek,
        weekday,
        time,
        timeZone: zone,
        people: Array.from({ length: weeks }, (_, i) => pool[i % pool.length]),
      }),
    );
  };

  const addWeekAfterLast = () => {
    const last = sorted[sorted.length - 1];
    const start = last ? new Date(last.endsAt) : new Date(buildWeeklyRoster({ firstWeek, weekday, time, timeZone: zone, people: ['x'] })[0].startsAt);
    const userId = last?.userId ?? people[0]?.id;
    if (!userId) return;
    onChange([...sorted, { userId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + WEEK_MS).toISOString() }]);
  };

  const addCustomRange = () => {
    const last = sorted[sorted.length - 1];
    const start = last ? new Date(last.endsAt) : new Date();
    const userId = last?.userId ?? people[0]?.id;
    if (!userId) return;
    onChange([...sorted, { userId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 2 * 86_400_000).toISOString() }]);
  };

  const update = (index: number, patch: Partial<RosterEntry>) => onChange(sorted.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));

  const [y, m, d] = handoverDate(firstWeek || todayIn(zone), weekday, 0);
  const firstHandover = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <div className="space-y-3">
      <div className="rounded-sm border p-3 surface">
        <p className="mb-2 text-xs font-medium">Lay out weeks</p>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Handover day">
            <Select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>
              {WEEKDAYS.map((name, index) => (
                <option key={name} value={index}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Handover time" hint={zone}>
            <Input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
          </Field>
          <Field label="First week" hint={`Starts ${firstHandover}`}>
            <Input type="date" value={firstWeek} onChange={(event) => setFirstWeek(event.target.value)} />
          </Field>
          <Field label="Weeks">
            <Input type="number" min={1} max={52} value={weeks} onChange={(event) => setWeeks(Math.min(52, Math.max(1, Number(event.target.value) || 1)))} />
          </Field>
        </div>
        <div className="mt-3">
          <p className="mb-1 text-xs text-muted">Repeat these people, in order (week 1, week 2, …). Adjust single weeks below afterwards.</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {cycle.map((id, index) => (
              <span key={`${id}-${index}`} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs surface-2">
                <span className="size-2 rounded-full" style={{ background: personColor(id) }} />
                {index + 1}. {nameOf(id)}
                <button type="button" onClick={() => setCycle(cycle.filter((_, i) => i !== index))} aria-label={`Remove ${nameOf(id)}`}>
                  <X className="size-3 text-subtle" />
                </button>
              </span>
            ))}
            <Select
              className="w-auto min-w-40"
              value=""
              onChange={(event) => {
                if (event.target.value) setCycle([...cycle, event.target.value]);
              }}
            >
              <option value="">Add a person…</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
            <Button variant="secondary" size="sm" disabled={!cycle.length} onClick={layOutWeeks}>
              <Repeat className="size-3.5" />
              Fill {weeks} week{weeks === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="text-xs text-subtle">No weeks yet. Lay out weeks above, or add one entry at a time.</p>
      ) : (
        <ol className="space-y-1">
          {sorted.map((entry, index) => {
            const isWeek = new Date(entry.endsAt).getTime() - new Date(entry.startsAt).getTime() === WEEK_MS;
            return (
              <li
                key={`${entry.startsAt}-${index}`}
                className={`rounded-sm border px-2 py-1.5 text-xs surface ${clashes.has(index) ? 'border-[var(--priority-urgent)]' : ''}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: personColor(entry.userId) }} />
                  <span className="w-44 shrink-0 tabular">
                    {isWeek ? <span className="text-subtle">Week {index + 1} · </span> : null}
                    {describeEntry(entry, zone)}
                  </span>
                  <Select className="w-auto min-w-40 flex-1" value={entry.userId} onChange={(event) => update(index, { userId: event.target.value })}>
                    {people.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                      </option>
                    ))}
                  </Select>
                  <Button variant="ghost" size="icon" className="size-6" onClick={() => onChange(sorted.filter((_, i) => i !== index))} aria-label="Remove entry">
                    <X className="size-3" />
                  </Button>
                </div>
                <details className="mt-1">
                  <summary className="cursor-pointer text-2xs text-subtle">Change dates (your local time)</summary>
                  <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                    <Input type="datetime-local" value={toLocalInput(entry.startsAt)} onChange={(event) => event.target.value && update(index, { startsAt: fromLocalInput(event.target.value) })} />
                    <Input type="datetime-local" value={toLocalInput(entry.endsAt)} onChange={(event) => event.target.value && update(index, { endsAt: fromLocalInput(event.target.value) })} />
                  </div>
                </details>
                {clashes.has(index) && <p className="mt-1 text-2xs text-[var(--priority-urgent)]">Overlaps another entry. Use an override for partial cover.</p>}
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={addWeekAfterLast} disabled={!people.length}>
          <Plus className="size-3.5" />
          Add a week
        </Button>
        <Button variant="ghost" size="sm" onClick={addCustomRange} disabled={!people.length}>
          <CalendarPlus className="size-3.5" />
          Add custom dates (e.g. Mon–Wed)
        </Button>
      </div>
    </div>
  );
}
