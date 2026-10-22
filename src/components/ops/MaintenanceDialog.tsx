import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { opsApi } from '@/lib/ops-api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Select, SegmentedControl, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import {
  MAINTENANCE_EFFECT_LABELS,
  type AlertSource,
  type MaintenanceEffect,
  type MaintenanceInput,
  type MaintenanceRecurrenceKind,
  type MaintenanceScope,
  type MaintenanceWindow,
  type Monitor,
  type StatusPage,
} from '@shared/ops';
import type { Team } from '@shared/types';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ZONES = ['Africa/Johannesburg', 'UTC', 'Europe/London', 'Europe/Amsterdam', 'America/New_York', 'Asia/Dubai', 'Australia/Sydney'];

function toLocalInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function today(): string {
  return toLocalInput(new Date()).slice(0, 10);
}

interface Choices {
  teams: Team[];
  monitors: Monitor[];
  sources: AlertSource[];
  pages: StatusPage[];
}

/** Teams, monitors, sources and status pages, for the scope picker. */
export function useScopeChoices(): Choices {
  const [choices, setChoices] = useState<Choices>({ teams: [], monitors: [], sources: [], pages: [] });
  useEffect(() => {
    void Promise.all([
      api.teams.list().then((r) => r.teams).catch(() => [] as Team[]),
      opsApi.monitors.list().then((r) => r.monitors).catch(() => [] as Monitor[]),
      opsApi.sources.list().then((r) => r.sources).catch(() => [] as AlertSource[]),
      opsApi.statusPages.list().then((r) => r.pages).catch(() => [] as StatusPage[]),
    ]).then(([teams, monitors, sources, pages]) => setChoices({ teams, monitors, sources, pages }));
  }, []);
  return choices;
}

type ScopeKind = 'teamIds' | 'monitorIds' | 'sourceIds' | 'components';

/** One searchable list across teams, monitors, alert sources and status page components. */
function ScopePicker({ value, onChange, choices }: { value: MaintenanceScope; onChange: (scope: MaintenanceScope) => void; choices: Choices }) {
  const [query, setQuery] = useState('');
  const rows = useMemo(() => {
    const all: Array<{ kind: ScopeKind; id: string; label: string; hint: string; component?: { statusPageId: string; monitorId: string } }> = [
      ...choices.teams.map((t) => ({ kind: 'teamIds' as const, id: t.id, label: t.name, hint: 'Team: every monitor and alert source it owns' })),
      ...choices.monitors.map((m) => ({ kind: 'monitorIds' as const, id: m.id, label: m.name, hint: `Monitor${m.teamName ? ` · ${m.teamName}` : ''}` })),
      ...choices.sources.map((s) => ({ kind: 'sourceIds' as const, id: s.id, label: s.name, hint: `Alert source${s.teamName ? ` · ${s.teamName}` : ''}` })),
      ...choices.pages.flatMap((p) =>
        p.components.map((c) => ({
          kind: 'components' as const,
          id: `${p.id}:${c.monitorId}`,
          label: c.label,
          hint: `Status page "${p.title}"`,
          component: { statusPageId: p.id, monitorId: c.monitorId },
        })),
      ),
    ];
    const needle = query.trim().toLowerCase();
    return needle ? all.filter((r) => `${r.label} ${r.hint}`.toLowerCase().includes(needle)) : all;
  }, [choices, query]);

  const isOn = (row: (typeof rows)[number]) =>
    row.kind === 'components'
      ? Boolean(value.components?.some((c) => `${c.statusPageId}:${c.monitorId}` === row.id))
      : Boolean(value[row.kind]?.includes(row.id));

  const toggle = (row: (typeof rows)[number], on: boolean) => {
    if (row.kind === 'components') {
      const rest = (value.components ?? []).filter((c) => `${c.statusPageId}:${c.monitorId}` !== row.id);
      onChange({ ...value, components: on ? [...rest, row.component!] : rest });
      return;
    }
    const rest = (value[row.kind] ?? []).filter((id) => id !== row.id);
    onChange({ ...value, [row.kind]: on ? [...rest, row.id] : rest });
  };

  const selected = (value.teamIds?.length ?? 0) + (value.monitorIds?.length ?? 0) + (value.sourceIds?.length ?? 0) + (value.components?.length ?? 0);

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 border-b px-2.5 py-1.5">
        <Search className="size-3.5 text-[var(--fg-subtle)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search teams, monitors, alert sources, status page components"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none"
        />
        <span className="shrink-0 text-2xs text-subtle">{selected} selected</span>
      </div>
      <div className="max-h-56 space-y-2 overflow-y-auto p-3">
        {rows.length === 0 && <p className="text-xs text-subtle">Nothing matches.</p>}
        {rows.map((row) => (
          <Checkbox key={`${row.kind}:${row.id}`} label={row.label} hint={row.hint} checked={isOn(row)} onChange={(e) => toggle(row, e.target.checked)} />
        ))}
      </div>
    </div>
  );
}

export function MaintenanceDialog({ window: existing, onClose, onSaved }: { window: MaintenanceWindow | null; onClose: () => void; onSaved: (w: MaintenanceWindow) => void }) {
  const choices = useScopeChoices();
  const recurring = existing?.recurrence.kind && existing.recurrence.kind !== 'none';
  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [everything, setEverything] = useState<'all' | 'some'>(existing?.scope.everything ? 'all' : existing ? 'some' : 'some');
  const [scope, setScope] = useState<MaintenanceScope>(existing && !existing.scope.everything ? existing.scope : {});
  const [effect, setEffect] = useState<MaintenanceEffect>(existing?.effect ?? 'pause_paging');
  const [kind, setKind] = useState<MaintenanceRecurrenceKind>(existing?.recurrence.kind ?? 'none');
  const [startsAt, setStartsAt] = useState(existing && !recurring ? toLocalInput(new Date(existing.startsAt)) : toLocalInput(new Date(Date.now() + 3_600_000)));
  const [endsAt, setEndsAt] = useState(existing && !recurring ? toLocalInput(new Date(existing.endsAt)) : toLocalInput(new Date(Date.now() + 3 * 3_600_000)));
  const [timeZone, setTimeZone] = useState(existing?.timeZone ?? 'Africa/Johannesburg');
  const [startTime, setStartTime] = useState(existing?.recurrence.startTime ?? '22:00');
  const [durationMins, setDurationMins] = useState(existing?.recurrence.durationMins ?? 120);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(existing?.recurrence.daysOfWeek ?? [0]);
  const [dayOfMonth, setDayOfMonth] = useState(existing?.recurrence.dayOfMonth ?? 1);
  const [startDate, setStartDate] = useState(existing?.recurrence.startDate ?? today());
  const [until, setUntil] = useState(existing?.recurrence.until ?? '');
  const [notifyBeforeMins, setNotifyBeforeMins] = useState(existing?.notifyBeforeMins ?? 60);
  const [publish, setPublish] = useState(existing?.publishToStatusPages ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const input: MaintenanceInput = {
      title,
      description: description || null,
      scope: everything === 'all' ? { everything: true } : scope,
      effect,
      timeZone,
      recurrence:
        kind === 'none'
          ? { kind }
          : { kind, startTime, durationMins, startDate, until: until || null, daysOfWeek: kind === 'weekly' ? daysOfWeek : undefined, dayOfMonth: kind === 'monthly' ? dayOfMonth : undefined },
      startsAt: kind === 'none' ? new Date(startsAt).toISOString() : undefined,
      endsAt: kind === 'none' ? new Date(endsAt).toISOString() : undefined,
      notifyBeforeMins,
      publishToStatusPages: publish,
    };
    try {
      const result = existing ? await opsApi.maintenance.update(existing.id, input) : await opsApi.maintenance.create(input);
      onSaved(result.window);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the maintenance.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={existing ? `Edit ${existing.title}` : 'Schedule maintenance'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={!title.trim()}>
            {existing ? 'Save changes' : 'Schedule'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && (
          <p role="alert" className="rounded-sm border border-[var(--priority-urgent)]/30 bg-[var(--priority-urgent)]/5 px-3 py-2 text-xs text-[var(--priority-urgent)]">
            {error}
          </p>
        )}
        <Field label="What is happening" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Website upgrade, firewall swap, patch night…" />
        </Field>
        <Field label="Details" hint="Shown on status pages when the maintenance is published there.">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="The site may be unavailable for up to 15 minutes." />
        </Field>

        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-xs font-medium">What it covers</legend>
          <SegmentedControl
            value={everything}
            onChange={setEverything}
            options={[
              { value: 'some', label: 'Chosen systems' },
              { value: 'all', label: 'Everything' },
            ]}
          />
          {everything === 'some' ? (
            <ScopePicker value={scope} onChange={setScope} choices={choices} />
          ) : (
            <p className="text-2xs text-subtle">Every monitor and alert source, for every team.</p>
          )}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-xs font-medium">During the maintenance</legend>
          {(['pause_paging', 'pause_alerting'] as const).map((value) => (
            <label key={value} className={cn('flex cursor-pointer gap-2.5 rounded-md border p-2.5', effect === value && 'border-[var(--accent)]')}>
              <input type="radio" name="effect" checked={effect === value} onChange={() => setEffect(value)} className="mt-0.5 accent-[var(--accent)]" />
              <span>
                <span className="block text-xs font-medium">{MAINTENANCE_EFFECT_LABELS[value]}</span>
                <span className="block text-2xs text-subtle">
                  {value === 'pause_paging'
                    ? 'Problems still open incident tickets so there is a record, but nobody is called, texted or notified.'
                    : 'Problems are only recorded, marked as maintenance. No tickets, no pages. Anything still broken when the window ends is raised then.'}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="mb-1.5 text-xs font-medium">When</legend>
          <SegmentedControl
            value={kind}
            onChange={setKind}
            options={[
              { value: 'none', label: 'Once' },
              { value: 'daily', label: 'Daily' },
              { value: 'weekly', label: 'Weekly' },
              { value: 'monthly', label: 'Monthly' },
            ]}
          />
          {kind === 'none' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Starts">
                <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
              </Field>
              <Field label="Ends">
                <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
              </Field>
            </div>
          ) : (
            <>
              {kind === 'weekly' && (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days of the week">
                  {WEEKDAYS.map((day, index) => {
                    const on = daysOfWeek.includes(index);
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setDaysOfWeek((current) => (on ? current.filter((d) => d !== index) : [...current, index].sort()))}
                        className={cn(
                          'h-7 w-11 rounded-sm border text-xs font-medium transition-colors',
                          on ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]' : 'hover:bg-[var(--surface-3)]',
                        )}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="grid gap-4 sm:grid-cols-3">
                {kind === 'monthly' && (
                  <Field label="Day of the month" hint="A shorter month uses its last day.">
                    <Input type="number" min={1} max={31} value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))} />
                  </Field>
                )}
                <Field label="Starts at">
                  <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                </Field>
                <Field label="Lasts (minutes)">
                  <Input type="number" min={5} max={1440} step={5} value={durationMins} onChange={(e) => setDurationMins(Number(e.target.value))} />
                </Field>
                <Field label="Time zone">
                  <Select value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
                    {Array.from(new Set([timeZone, ...ZONES])).map((zone) => (
                      <option key={zone} value={zone}>
                        {zone.replace('_', ' ')}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="From">
                  <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                </Field>
                <Field label="Until" hint="Optional.">
                  <Input type="date" value={until ?? ''} onChange={(e) => setUntil(e.target.value)} />
                </Field>
              </div>
            </>
          )}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tell the affected teams beforehand" hint="An in-app notification to everyone in those teams.">
            <Select value={notifyBeforeMins} onChange={(e) => setNotifyBeforeMins(Number(e.target.value))}>
              <option value={0}>Don't notify</option>
              <option value={15}>15 minutes before</option>
              <option value={60}>1 hour before</option>
              <option value={240}>4 hours before</option>
              <option value={1440}>1 day before</option>
            </Select>
          </Field>
          <div className="pt-5">
            <Checkbox
              label="Publish on status pages"
              hint="Pages showing an affected component list it as scheduled, then in progress, and post when it starts and ends."
              checked={publish}
              onChange={(e) => setPublish(e.target.checked)}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
