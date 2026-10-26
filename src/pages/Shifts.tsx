import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, ChevronLeft, ChevronRight, Pencil, Phone, Plus, Trash2, UserRound } from 'lucide-react';
import { api, ApiError, type DepartmentSchedule, type DepartmentShiftStatus, type StaffedShift } from '@/lib/api';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/PageHeader';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/state/auth';
import { useDocumentTitle } from '@/state/branding';
import { useDepartment } from '@/state/department';
import { WEEKDAYS, type ShiftException, type ShiftPattern } from '@shared/shifts';

type Directory = Awaited<ReturnType<typeof api.users.directory>>['users'];

/** A time in the department's own zone, e.g. "17:00" or "Mon 08:00". */
function at(iso: string, timeZone: string, withDay = false): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', ...(withDay ? { weekday: 'short' } : {}) }).format(new Date(iso));
}

/**
 * Who is in: each department's working shift, its team leader and until when.
 * For departments that work set hours and carry no standby, and for the shifts
 * of those that do.
 */
export function ShiftsPage() {
  useDocumentTitle('Shifts');
  const { current } = useDepartment();
  const { user, can } = useAuth();
  const [board, setBoard] = useState<DepartmentShiftStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [directory, setDirectory] = useState<Directory>([]);
  const [editing, setEditing] = useState<{ teamId: string; teamName: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setBoard((await api.shifts.board()).departments);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the shifts.');
    }
  }, []);

  useEffect(() => {
    void load();
    void api.users.directory().then((result) => setDirectory(result.users)).catch(() => undefined);
    // Who is in changes on the hour; keep the board honest without a refresh.
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const canEdit = (teamId: string) =>
    can('teams.manage', 'oncall.manage') ||
    Boolean(user?.managedTeamIds.includes(teamId)) ||
    (can('oncall.manage_own_department') && Boolean(user?.teamIds.includes(teamId)));

  const shown = useMemo(() => (board ?? []).filter((entry) => !current || entry.teamId === current.id), [board, current]);

  return (
    <div>
      <PageHeader
        title="Shifts"
        description="Which departments are in, who leads each shift, and until when. For teams that work set hours, with or without a standby."
      />
      {error ? (
        <ErrorPane message={error} retry={load} />
      ) : !board ? (
        <LoadingPane label="Loading shifts" />
      ) : shown.length === 0 ? (
        <EmptyState icon={CalendarClock} title="No departments" description="Create departments under Teams first." />
      ) : (
        <div className="space-y-6 p-4 sm:p-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((entry) => (
              <ShiftCard key={entry.teamId} entry={entry} canEdit={canEdit(entry.teamId)} onEdit={() => setEditing({ teamId: entry.teamId, teamName: entry.teamName })} />
            ))}
          </div>
          {current && shown[0]?.configured && <WeekView teamId={current.id} timeZone={shown[0].timeZone} />}
        </div>
      )}
      {editing && (
        <ScheduleEditor
          teamId={editing.teamId}
          teamName={editing.teamName}
          directory={directory}
          onClose={() => setEditing(null)}
          onSaved={() => void load()}
        />
      )}
    </div>
  );
}

function ShiftCard({ entry, canEdit, onEdit }: { entry: DepartmentShiftStatus; canEdit: boolean; onEdit: () => void }) {
  const shift = entry.current;
  return (
    <article className={cn('rounded-md border p-4 surface', shift && 'border-[var(--status-resolved)]/45')}>
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: entry.color }} />
          <h2 className="truncate text-sm font-semibold">{entry.teamName}</h2>
        </div>
        {canEdit && (
          <Button variant="ghost" size="icon" onClick={onEdit} aria-label={`Edit ${entry.teamName}'s shifts`}>
            <Pencil className="size-3.5" />
          </Button>
        )}
      </header>

      {!entry.configured ? (
        <p className="mt-2 text-xs text-muted">
          No shifts set up yet.{' '}
          {canEdit && (
            <button type="button" className="text-[var(--accent)] hover:underline" onClick={onEdit}>
              Set them up
            </button>
          )}
        </p>
      ) : shift ? (
        <>
          <p className="mt-2 inline-flex items-center gap-1.5 rounded-[3px] bg-[var(--status-resolved)]/12 px-1.5 py-0.5 text-2xs font-semibold text-[var(--status-resolved)]">
            <span className="size-1.5 rounded-full bg-[var(--status-resolved)]" />
            In now · {shift.name} until {at(shift.endsAt, entry.timeZone)}
          </p>
          <Leader shift={shift} />
          {shift.members.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {shift.members.slice(0, 8).map((person) => (
                <Avatar key={person.id} name={person.name} size="sm" />
              ))}
              {shift.members.length > 8 && <span className="text-2xs text-subtle">+{shift.members.length - 8}</span>}
            </div>
          )}
          {shift.note && <p className="mt-1.5 text-2xs text-muted">{shift.note}</p>}
        </>
      ) : (
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-[3px] bg-[var(--surface-3)] px-1.5 py-0.5 text-2xs font-semibold text-muted">Closed</p>
      )}

      {entry.next && (
        <p className="mt-3 border-t pt-2 text-2xs text-muted">
          Next: <b className="font-medium text-[var(--fg)]">{entry.next.name}</b> {at(entry.next.startsAt, entry.timeZone, true)}–{at(entry.next.endsAt, entry.timeZone)}
          {entry.next.leader ? ` · led by ${entry.next.leader.name}` : ''}
        </p>
      )}
    </article>
  );
}

function Leader({ shift }: { shift: StaffedShift }) {
  if (!shift.leader) {
    return (
      <p className="mt-2 flex items-center gap-2 text-xs text-[var(--priority-high)]">
        <UserRound className="size-3.5" />
        No team leader set for this shift
      </p>
    );
  }
  const leader = shift.leader;
  return (
    <div className="mt-2 flex items-center gap-2.5">
      <Avatar name={leader.name} size="md" />
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold">{leader.name}</p>
        <p className="truncate text-2xs text-subtle">Team leader{leader.jobTitle ? ` · ${leader.jobTitle}` : ''}</p>
        {leader.phone && (
          <a href={`tel:${leader.phone.replace(/[^\d+]/g, '')}`} className="inline-flex items-center gap-1 font-mono text-2xs text-[var(--accent)] hover:underline">
            <Phone className="size-3" />
            {leader.phone}
          </a>
        )}
      </div>
    </div>
  );
}

/* --------------------------------- Week view --------------------------------- */

function WeekView({ teamId, timeZone }: { teamId: string; timeZone: string }) {
  const [weekStart, setWeekStart] = useState(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    today.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    return today;
  });
  const [shifts, setShifts] = useState<StaffedShift[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setShifts(null);
    void api.shifts
      .calendar(teamId, weekStart.toISOString(), 7)
      .then((result) => !cancelled && setShifts(result.shifts))
      .catch(() => !cancelled && setShifts([]));
    return () => {
      cancelled = true;
    };
  }, [teamId, weekStart]);

  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(weekStart);
    day.setDate(day.getDate() + index);
    return day;
  });
  const key = (day: Date) => `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const move = (weeks: number) => {
    const next = new Date(weekStart);
    next.setDate(next.getDate() + weeks * 7);
    setWeekStart(next);
  };

  return (
    <section className="rounded-md border surface">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-xs font-semibold">Week of {weekStart.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</h2>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" onClick={() => move(-1)} aria-label="Previous week">
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => move(1)} aria-label="Next week">
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[48rem] grid-cols-7 divide-x">
          {days.map((day) => {
            const todays = (shifts ?? []).filter((shift) => shift.date === key(day));
            const isToday = key(day) === key(new Date());
            return (
              <div key={key(day)} className="min-h-28 p-2">
                <p className={cn('mb-1.5 text-2xs font-medium', isToday ? 'text-[var(--accent)]' : 'text-muted')}>
                  {day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}
                </p>
                {shifts === null ? null : todays.length === 0 ? (
                  <p className="text-2xs text-subtle">Closed</p>
                ) : (
                  todays.map((shift) => (
                    <div key={shift.patternId + shift.startsAt} className="mb-1.5 rounded-sm border px-1.5 py-1 surface-2">
                      <p className="truncate text-2xs font-semibold">{shift.name}</p>
                      <p className="text-2xs text-muted tabular">
                        {at(shift.startsAt, timeZone)}–{at(shift.endsAt, timeZone)}
                      </p>
                      <p className="truncate text-2xs">{shift.leader?.name ?? <span className="text-[var(--priority-high)]">No leader</span>}</p>
                      {shift.note && <p className="truncate text-2xs text-subtle">{shift.note}</p>}
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------- Editor ---------------------------------- */

type Draft = Omit<ShiftPattern, 'id'> & { id?: string };
const BLANK: Draft = { name: 'Day shift', days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', leaderId: null, memberIds: [] };

function ScheduleEditor({
  teamId,
  teamName,
  directory,
  onClose,
  onSaved,
}: {
  teamId: string;
  teamName: string;
  directory: Directory;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [schedule, setSchedule] = useState<DepartmentSchedule | null>(null);
  const [patterns, setPatterns] = useState<Draft[]>([]);
  const [timeZone, setTimeZone] = useState('');
  const [saving, setSaving] = useState(false);
  const [exception, setException] = useState<Omit<ShiftException, 'id'>>({ date: '', patternId: null, kind: 'closed', leaderId: null, start: '08:00', end: '13:00', note: '' });

  useEffect(() => {
    void api.shifts
      .get(teamId)
      .then(({ schedule: loaded }) => {
        setSchedule(loaded);
        setPatterns(loaded.patterns.length ? loaded.patterns : [{ ...BLANK }]);
        setTimeZone(loaded.timeZone);
      })
      .catch((caught) => toast.error('Could not load the schedule', caught instanceof ApiError ? caught.message : undefined));
  }, [teamId, toast]);

  // The department's people first, everyone else after: a leader may come from elsewhere.
  const people = [...directory.filter((person) => person.teamIds.includes(teamId)), ...directory.filter((person) => !person.teamIds.includes(teamId))];
  const set = (index: number, patch: Partial<Draft>) => setPatterns((all) => all.map((pattern, i) => (i === index ? { ...pattern, ...patch } : pattern)));

  const save = async () => {
    setSaving(true);
    try {
      const { schedule: saved } = await api.shifts.save(teamId, { timeZone, patterns });
      setSchedule(saved);
      setPatterns(saved.patterns);
      toast.success(`Saved ${teamName}'s shifts.`);
      onSaved();
    } catch (caught) {
      toast.error('Could not save', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const addException = async () => {
    try {
      const { schedule: saved } = await api.shifts.addException(teamId, { ...exception, note: exception.note || null });
      setSchedule(saved);
      setException({ ...exception, date: '', note: '' });
      onSaved();
    } catch (caught) {
      toast.error('Could not add the change', caught instanceof ApiError ? caught.message : undefined);
    }
  };

  const removeException = async (id: string) => {
    const { schedule: saved } = await api.shifts.removeException(teamId, id);
    setSchedule(saved);
    onSaved();
  };

  const nameOf = (id: string | null) => directory.find((person) => person.id === id)?.name ?? '—';

  return (
    <Modal
      open
      onClose={onClose}
      title={`${teamName} shifts`}
      description="When the department is in, and who leads. Overnight shifts are fine: an end before the start runs past midnight."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!schedule}>
            Save shifts
          </Button>
        </>
      }
    >
      {!schedule ? (
        <LoadingPane label="Loading" />
      ) : (
        <div className="space-y-5">
          <Field label="Time zone" hint="Shift times are in this zone.">
            <Input value={timeZone} onChange={(event) => setTimeZone(event.target.value)} placeholder="Africa/Johannesburg" className="max-w-xs" />
          </Field>

          <div className="space-y-3">
            {patterns.map((pattern, index) => (
              <div key={pattern.id ?? `new-${index}`} className="space-y-3 rounded-md border p-3 surface-2">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_auto]">
                  <Field label="Shift">
                    <Input value={pattern.name} onChange={(event) => set(index, { name: event.target.value })} />
                  </Field>
                  <Field label="Starts">
                    <Input type="time" value={pattern.start} onChange={(event) => set(index, { start: event.target.value })} />
                  </Field>
                  <Field label="Ends">
                    <Input type="time" value={pattern.end} onChange={(event) => set(index, { end: event.target.value })} />
                  </Field>
                  <div className="flex items-end">
                    <Button variant="ghost" size="icon" onClick={() => setPatterns((all) => all.filter((_, i) => i !== index))} aria-label={`Remove ${pattern.name}`}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium">Days</p>
                  <div className="flex flex-wrap gap-1">
                    {WEEKDAYS.map((day, weekday) => {
                      const on = pattern.days.includes(weekday);
                      return (
                        <button
                          key={day}
                          type="button"
                          aria-pressed={on}
                          onClick={() => set(index, { days: on ? pattern.days.filter((d) => d !== weekday) : [...pattern.days, weekday].sort() })}
                          className={cn('w-11 rounded-[3px] border py-1 text-xs', on ? 'border-[var(--accent)] font-medium text-[var(--accent)]' : 'text-muted')}
                        >
                          {day}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Team leader">
                    <Select value={pattern.leaderId ?? ''} onChange={(event) => set(index, { leaderId: event.target.value || null })}>
                      <option value="">Nobody</option>
                      {people.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.name}
                          {person.teamIds.includes(teamId) ? '' : ' (other department)'}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Working this shift" hint="Optional. Shown on the board.">
                    <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                      {directory
                        .filter((person) => person.teamIds.includes(teamId))
                        .map((person) => {
                          const on = pattern.memberIds.includes(person.id);
                          return (
                            <button
                              key={person.id}
                              type="button"
                              aria-pressed={on}
                              onClick={() => set(index, { memberIds: on ? pattern.memberIds.filter((id) => id !== person.id) : [...pattern.memberIds, person.id] })}
                              className={cn('rounded-[3px] border px-1.5 py-0.5 text-2xs', on ? 'border-[var(--accent)] text-[var(--accent)]' : 'text-muted')}
                            >
                              {person.name}
                            </button>
                          );
                        })}
                    </div>
                  </Field>
                </div>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => setPatterns((all) => [...all, { ...BLANK, name: `Shift ${all.length + 1}` }])}>
              <Plus className="size-3.5" />
              Add a shift
            </Button>
          </div>

          <div className="space-y-2 border-t pt-4">
            <p className="text-sm font-semibold">Changes on particular days</p>
            <p className="text-xs text-muted">Public holidays, a different leader for the day, or different hours. These save straight away.</p>
            {schedule.exceptions.length > 0 && (
              <ul className="divide-y rounded-sm border">
                {schedule.exceptions.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <span className="w-24 font-mono tabular">{item.date}</span>
                    <span className="flex-1">
                      {schedule.patterns.find((pattern) => pattern.id === item.patternId)?.name ?? 'All shifts'}:{' '}
                      {item.kind === 'closed' ? 'closed' : item.kind === 'leader' ? `led by ${nameOf(item.leaderId)}` : `${item.start}–${item.end}`}
                      {item.note ? ` · ${item.note}` : ''}
                    </span>
                    <Button variant="ghost" size="icon" onClick={() => void removeException(item.id)} aria-label="Remove this change">
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_9rem]">
              <Input type="date" value={exception.date} onChange={(event) => setException({ ...exception, date: event.target.value })} aria-label="Date" />
              <Select value={exception.patternId ?? ''} onChange={(event) => setException({ ...exception, patternId: event.target.value || null })} aria-label="Which shift">
                <option value="">All shifts that day</option>
                {schedule.patterns.map((pattern) => (
                  <option key={pattern.id} value={pattern.id}>
                    {pattern.name}
                  </option>
                ))}
              </Select>
              <Select value={exception.kind} onChange={(event) => setException({ ...exception, kind: event.target.value as ShiftException['kind'] })} aria-label="Change">
                <option value="closed">Closed</option>
                <option value="leader">Different leader</option>
                <option value="hours">Different hours</option>
              </Select>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              {exception.kind === 'leader' ? (
                <Select value={exception.leaderId ?? ''} onChange={(event) => setException({ ...exception, leaderId: event.target.value || null })} aria-label="Leader">
                  <option value="">Who leads instead…</option>
                  {people.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </Select>
              ) : exception.kind === 'hours' ? (
                <div className="grid grid-cols-2 gap-2">
                  <Input type="time" value={exception.start ?? ''} onChange={(event) => setException({ ...exception, start: event.target.value })} aria-label="Starts" />
                  <Input type="time" value={exception.end ?? ''} onChange={(event) => setException({ ...exception, end: event.target.value })} aria-label="Ends" />
                </div>
              ) : (
                <span />
              )}
              <Input value={exception.note ?? ''} onChange={(event) => setException({ ...exception, note: event.target.value })} placeholder="Note, e.g. Heritage Day" />
              <Button variant="secondary" size="md" onClick={() => void addException()} disabled={!exception.date || !schedule.patterns.length}>
                Add
              </Button>
            </div>
            {!schedule.patterns.length && <p className="text-2xs text-subtle">Save at least one shift first.</p>}
          </div>
        </div>
      )}
    </Modal>
  );
}
