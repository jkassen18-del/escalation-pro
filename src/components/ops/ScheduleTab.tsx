import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, CalendarClock, Plus, Trash2, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { opsApi, type ScheduleInput } from '@/lib/ops-api';
import { shortDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { useAuth } from '@/state/auth';
import { ROTATION_KINDS, type RotationKind, type Schedule, type Shift } from '@shared/ops';
import type { Team } from '@shared/types';
import { fromLocalInput, personColor, toLocalInput, type DirectoryPerson } from './OnCallShared';

const DAY_MS = 86_400_000;
const TIMELINE_DAYS = 14;
const LANE_COLORS = ['#4d6b8a', '#9a7b2f', '#5b8a5a', '#8a4d6b', '#4d8a86', '#7a5fa8', '#a8673f', '#5f6fa8'];

const ROTATION_LABELS: Record<RotationKind, string> = { daily: 'Daily (24 h)', weekly: 'Weekly (7 days)', custom: 'Custom length' };

export function ScheduleTab({ people, teams }: { people: DirectoryPerson[]; teams: Team[] }) {
  const { can } = useAuth();
  const toast = useToast();
  const manage = can('oncall.manage');
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await opsApi.schedules.list();
      setSchedules(result.schedules);
      setSelected((current) => current ?? result.schedules[0]?.id ?? null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load schedules.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorPane message={error} retry={load} />;
  if (loading) return <LoadingPane label="Loading schedules" />;

  const current = schedules.find((s) => s.id === selected) ?? null;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {schedules.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No on-call schedules"
          description="A schedule says who is on call when: a rotation of people, handing over daily or weekly, with overrides for swaps and holidays."
          action={
            manage && (
              <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
                Create a schedule
              </Button>
            )
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={selected ?? ''} onChange={(event) => setSelected(event.target.value)} className="w-auto min-w-48">
              {schedules.map((schedule) => (
                <option key={schedule.id} value={schedule.id}>
                  {schedule.name}
                </option>
              ))}
            </Select>
            <div className="flex-1" />
            {manage && current && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setDeleting(current)}>
                  <Trash2 className="size-3.5" />
                  Delete
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setEditing(current)}>
                  Edit
                </Button>
              </>
            )}
            {manage && (
              <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
                <Plus className="size-3.5" />
                New schedule
              </Button>
            )}
          </div>
          {current && <ScheduleDetail key={current.id} schedule={current} people={people} onChanged={load} />}
        </>
      )}

      {editing && (
        <ScheduleDialog
          schedule={editing === 'new' ? null : editing}
          people={people}
          teams={teams}
          onClose={() => setEditing(null)}
          onSaved={async (saved) => {
            setEditing(null);
            setSelected(saved.id);
            await load();
            toast.success('Schedule saved.');
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name ?? ''}?`}
        message="Escalation levels that target this schedule will have nobody to page from it."
        confirmLabel="Delete schedule"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await opsApi.schedules.remove(deleting.id);
            setDeleting(null);
            setSelected(null);
            await load();
          } catch (caught) {
            toast.error('Could not delete', caught instanceof ApiError ? caught.message : undefined);
          }
        }}
      />
    </div>
  );
}

function ScheduleDetail({ schedule, people, onChanged }: { schedule: Schedule; people: DirectoryPerson[]; onChanged: () => Promise<void> }) {
  const { user, can } = useAuth();
  const toast = useToast();
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [adding, setAdding] = useState(false);
  const [from] = useState(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  });
  const to = from + TIMELINE_DAYS * DAY_MS;

  const loadShifts = useCallback(async () => {
    const result = await opsApi.schedules.get(schedule.id, { from: new Date(from).toISOString(), to: new Date(to).toISOString() });
    setShifts(result.shifts);
  }, [schedule.id, from, to]);

  useEffect(() => {
    void loadShifts().catch(() => setShifts([]));
  }, [loadShifts, schedule.updatedAt, schedule.overrides.length]);

  const removeOverride = async (id: string) => {
    try {
      await opsApi.schedules.removeOverride(schedule.id, id);
      await onChanged();
    } catch (caught) {
      toast.error('Could not remove the override', caught instanceof ApiError ? caught.message : undefined);
    }
  };

  // One lane per person who has a shift in the window.
  const lanes = Array.from(new Set(shifts.map((s) => s.userId)));
  // Colours by lane, so two people on one schedule never share one.
  const colorOf = (userId: string) => {
    const index = lanes.indexOf(userId);
    return index >= 0 ? LANE_COLORS[index % LANE_COLORS.length] : personColor(userId);
  };
  const pct = (iso: string) => Math.min(100, Math.max(0, ((new Date(iso).getTime() - from) / (to - from)) * 100));
  const nowPct = ((Date.now() - from) / (to - from)) * 100;

  return (
    <div className="space-y-4">
      <div className="rounded-md border p-4 surface">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">{schedule.name}</h2>
            <p className="text-xs text-muted">
              {schedule.teamName ?? 'No team'} · {schedule.timeZone} · {schedule.layers.length} layer{schedule.layers.length === 1 ? '' : 's'}
            </p>
          </div>
          <p className="text-xs">
            On call now: <span className="font-medium">{schedule.onCallNow?.userName ?? 'nobody'}</span>
            {schedule.onCallNow?.until && <span className="text-subtle"> until {shortDateTime(schedule.onCallNow.until)}</span>}
          </p>
        </div>
        {schedule.description && <p className="mt-2 text-xs text-muted">{schedule.description}</p>}

        <p className="eyebrow mt-4 mb-2">Next {TIMELINE_DAYS} days</p>
        <div className="overflow-x-auto">
          <div className="min-w-[40rem]">
            <div className="ml-28 flex border-b text-2xs text-subtle">
              {Array.from({ length: TIMELINE_DAYS }, (_, i) => {
                const day = new Date(from + i * DAY_MS);
                return (
                  <span key={i} className="flex-1 truncate border-l px-1 py-0.5">
                    {day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}
                  </span>
                );
              })}
            </div>
            {lanes.length === 0 ? (
              <p className="py-4 text-xs text-muted">Nobody is scheduled in this window.</p>
            ) : (
              lanes.map((userId) => {
                const name = shifts.find((s) => s.userId === userId)?.userName ?? 'Unknown';
                return (
                  <div key={userId} className="flex items-center border-b py-1.5">
                    <span className="w-28 shrink-0 truncate pr-2 text-xs">{name}</span>
                    <div className="relative h-5 flex-1 rounded-sm surface-2">
                      {shifts
                        .filter((s) => s.userId === userId)
                        .map((shift) => (
                          <span
                            key={shift.startsAt}
                            title={`${name}: ${shortDateTime(shift.startsAt)} – ${shortDateTime(shift.endsAt)}${shift.source === 'override' ? ' (override)' : ''}`}
                            className={cn('absolute top-0 h-full rounded-[3px]', shift.source === 'override' && 'ring-2 ring-[var(--fg)] ring-inset')}
                            style={{
                              left: `${pct(shift.startsAt)}%`,
                              width: `${Math.max(0.4, pct(shift.endsAt) - pct(shift.startsAt))}%`,
                              background: colorOf(userId),
                            }}
                          />
                        ))}
                      {nowPct >= 0 && nowPct <= 100 && (
                        <span className="absolute top-[-4px] h-[calc(100%+8px)] w-px bg-[var(--priority-urgent)]" style={{ left: `${nowPct}%` }} />
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
        <p className="mt-2 text-2xs text-subtle">Outlined bars are overrides. The red line is now.</p>
      </div>

      <div className="rounded-md border surface">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <p className="text-xs font-semibold">Overrides</p>
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            Add override
          </Button>
        </div>
        {schedule.overrides.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted">No overrides. Add one to cover a shift, swap, or holiday.</p>
        ) : (
          <ul className="divide-y">
            {schedule.overrides.map((override) => (
              <li key={override.id} className="flex items-center gap-3 px-4 py-2 text-xs">
                <span className="size-2 shrink-0 rounded-full" style={{ background: colorOf(override.userId) }} />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{override.userName ?? 'Unknown'}</span>{' '}
                  <span className="text-muted">
                    {shortDateTime(override.startsAt)} – {shortDateTime(override.endsAt)}
                  </span>
                  {override.note && <span className="block truncate text-subtle">{override.note}</span>}
                </span>
                {(can('oncall.manage') || override.userId === user?.id) && (
                  <Button variant="ghost" size="icon" onClick={() => removeOverride(override.id)} aria-label="Remove override">
                    <X className="size-3.5" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {adding && (
        <OverrideDialog
          schedule={schedule}
          people={people}
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            await onChanged();
            toast.success('Override added.');
          }}
        />
      )}
    </div>
  );
}

function OverrideDialog({
  schedule,
  people,
  onClose,
  onSaved,
}: {
  schedule: Schedule;
  people: DirectoryPerson[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { user, can } = useAuth();
  const toast = useToast();
  const manage = can('oncall.manage');
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const [form, setForm] = useState({
    userId: user?.id ?? '',
    startsAt: toLocalInput(start.toISOString()),
    endsAt: toLocalInput(new Date(start.getTime() + 4 * 3_600_000).toISOString()),
    note: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      await opsApi.schedules.addOverride(schedule.id, {
        userId: form.userId,
        startsAt: fromLocalInput(form.startsAt),
        endsAt: fromLocalInput(form.endsAt),
        note: form.note || undefined,
      });
      await onSaved();
    } catch (caught) {
      toast.error('Could not add the override', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Cover a shift on ${schedule.name}`}
      description={manage ? 'Put anyone on call for a stretch of time.' : 'You can add yourself as cover.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} disabled={!form.startsAt || !form.endsAt} onClick={submit}>
            Add override
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Who is on call">
          <Select value={form.userId} disabled={!manage} onChange={(event) => setForm((f) => ({ ...f, userId: event.target.value }))}>
            {(manage ? people : people.filter((p) => p.id === user?.id)).map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From">
            <Input type="datetime-local" value={form.startsAt} onChange={(event) => setForm((f) => ({ ...f, startsAt: event.target.value }))} />
          </Field>
          <Field label="Until">
            <Input type="datetime-local" value={form.endsAt} onChange={(event) => setForm((f) => ({ ...f, endsAt: event.target.value }))} />
          </Field>
        </div>
        <Field label="Note" hint="Optional, e.g. covering for Jane's leave.">
          <Input value={form.note} onChange={(event) => setForm((f) => ({ ...f, note: event.target.value }))} maxLength={300} />
        </Field>
      </div>
    </Modal>
  );
}

type LayerDraft = ScheduleInput['layers'][number] & { key: string };

function newLayer(index: number): LayerDraft {
  const start = new Date();
  start.setHours(9, 0, 0, 0);
  return {
    key: Math.random().toString(36).slice(2),
    name: `Layer ${index + 1}`,
    position: index,
    rotation: 'weekly',
    shiftHours: 168,
    startsAt: start.toISOString(),
    memberIds: [],
  };
}

function ScheduleDialog({
  schedule,
  people,
  teams,
  onClose,
  onSaved,
}: {
  schedule: Schedule | null;
  people: DirectoryPerson[];
  teams: Team[];
  onClose: () => void;
  onSaved: (schedule: Schedule) => Promise<void>;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: schedule?.name ?? '',
    description: schedule?.description ?? '',
    teamId: schedule?.teamId ?? '',
    timeZone: schedule?.timeZone ?? 'Africa/Johannesburg',
  });
  const [layers, setLayers] = useState<LayerDraft[]>(
    schedule?.layers.length ? schedule.layers.map(({ id, ...layer }) => ({ ...layer, key: id })) : [newLayer(0)],
  );
  const [submitting, setSubmitting] = useState(false);

  const updateLayer = (key: string, patch: Partial<LayerDraft>) =>
    setLayers((current) => current.map((layer) => (layer.key === key ? { ...layer, ...patch } : layer)));

  const submit = async () => {
    setSubmitting(true);
    try {
      const input: ScheduleInput = {
        name: form.name,
        description: form.description || null,
        teamId: form.teamId || null,
        timeZone: form.timeZone,
        layers: layers.map(({ key: _key, ...layer }, position) => ({ ...layer, position })),
      };
      const result = schedule ? await opsApi.schedules.update(schedule.id, input) : await opsApi.schedules.create(input);
      await onSaved(result.schedule);
    } catch (caught) {
      toast.error('Could not save the schedule', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={schedule ? `Edit ${schedule.name}` : 'New on-call schedule'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} disabled={!form.name.trim() || layers.length === 0} onClick={submit}>
            {schedule ? 'Save changes' : 'Create schedule'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name" required className="sm:col-span-1">
            <Input value={form.name} onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))} placeholder="Platform primary" autoFocus />
          </Field>
          <Field label="Team">
            <Select value={form.teamId} onChange={(event) => setForm((f) => ({ ...f, teamId: event.target.value }))}>
              <option value="">No team</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Time zone" hint="For display; handovers are exact instants.">
            <Input value={form.timeZone} onChange={(event) => setForm((f) => ({ ...f, timeZone: event.target.value }))} />
          </Field>
        </div>
        <Field label="Description">
          <Textarea rows={2} value={form.description} onChange={(event) => setForm((f) => ({ ...f, description: event.target.value }))} />
        </Field>

        <div>
          <p className="mb-1 text-xs font-medium">Layers</p>
          <p className="mb-2 text-xs text-subtle">
            Each layer is a rotation. When two layers both have someone on call, the lower one in this list wins, so put
            weekend or holiday cover below the main rotation.
          </p>
          <div className="space-y-3">
            {layers.map((layer, index) => (
              <div key={layer.key} className="space-y-3 rounded-md border p-3 surface-2">
                <div className="grid gap-3 sm:grid-cols-[1fr_10rem_6rem_12rem_auto]">
                  <Field label="Layer name">
                    <Input value={layer.name} onChange={(event) => updateLayer(layer.key, { name: event.target.value })} />
                  </Field>
                  <Field label="Rotation">
                    <Select
                      value={layer.rotation}
                      onChange={(event) => {
                        const rotation = event.target.value as RotationKind;
                        updateLayer(layer.key, {
                          rotation,
                          shiftHours: rotation === 'daily' ? 24 : rotation === 'weekly' ? 168 : layer.shiftHours,
                        });
                      }}
                    >
                      {ROTATION_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {ROTATION_LABELS[kind]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Shift hours">
                    <Input
                      type="number"
                      min={1}
                      max={672}
                      disabled={layer.rotation !== 'custom'}
                      value={layer.shiftHours}
                      onChange={(event) => updateLayer(layer.key, { shiftHours: Number(event.target.value) })}
                    />
                  </Field>
                  <Field label="First handover">
                    <Input
                      type="datetime-local"
                      value={toLocalInput(layer.startsAt)}
                      onChange={(event) => updateLayer(layer.key, { startsAt: fromLocalInput(event.target.value) })}
                    />
                  </Field>
                  <div className="flex items-end">
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={layers.length === 1}
                      onClick={() => setLayers((current) => current.filter((l) => l.key !== layer.key))}
                      aria-label="Remove layer"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>

                <div>
                  <p className="mb-1.5 text-xs font-medium">Rotation order</p>
                  {layer.memberIds.length === 0 && <p className="mb-1.5 text-xs text-subtle">Add people in the order they take shifts.</p>}
                  <ol className="space-y-1">
                    {layer.memberIds.map((memberId, position) => (
                      <li key={`${memberId}-${position}`} className="flex items-center gap-2 rounded-sm border px-2 py-1 text-xs surface">
                        <span className="w-4 text-subtle tabular">{position + 1}</span>
                        <span className="size-2 rounded-full" style={{ background: personColor(memberId) }} />
                        <span className="min-w-0 flex-1 truncate">{people.find((p) => p.id === memberId)?.name ?? 'Unknown'}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          disabled={position === 0}
                          onClick={() => {
                            const ids = [...layer.memberIds];
                            [ids[position - 1], ids[position]] = [ids[position], ids[position - 1]];
                            updateLayer(layer.key, { memberIds: ids });
                          }}
                          aria-label="Move up"
                        >
                          <ArrowUp className="size-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          disabled={position === layer.memberIds.length - 1}
                          onClick={() => {
                            const ids = [...layer.memberIds];
                            [ids[position + 1], ids[position]] = [ids[position], ids[position + 1]];
                            updateLayer(layer.key, { memberIds: ids });
                          }}
                          aria-label="Move down"
                        >
                          <ArrowDown className="size-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          onClick={() => updateLayer(layer.key, { memberIds: layer.memberIds.filter((_, i) => i !== position) })}
                          aria-label="Remove from rotation"
                        >
                          <X className="size-3" />
                        </Button>
                      </li>
                    ))}
                  </ol>
                  <Select
                    className="mt-1.5"
                    value=""
                    onChange={(event) => {
                      if (event.target.value) updateLayer(layer.key, { memberIds: [...layer.memberIds, event.target.value] });
                    }}
                  >
                    <option value="">Add a person…</option>
                    {people.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                      </option>
                    ))}
                  </Select>
                </div>
                {index === 0 && layers.length > 1 && <p className="text-2xs text-subtle">This is the base layer.</p>}
              </div>
            ))}
          </div>
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => setLayers((current) => [...current, newLayer(current.length)])}>
            <Plus className="size-3.5" />
            Add layer
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Kept here so the page can fetch the directory once for every tab. */
export async function loadPeople(): Promise<DirectoryPerson[]> {
  const result = await api.users.directory();
  return result.users;
}
