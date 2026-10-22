import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, GitBranch, Plus, Trash2, X } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { opsApi, type PolicyInput } from '@/lib/ops-api';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Menu } from '@/components/ui/Menu';
import { useAuth } from '@/state/auth';
import { ESCALATION_TARGET_TYPES, type EscalationPolicy, type EscalationTargetType, type Schedule } from '@shared/ops';
import type { Team } from '@shared/types';
import type { DirectoryPerson } from './OnCallShared';

const TARGET_LABELS: Record<EscalationTargetType, string> = { user: 'Person', schedule: 'On-call schedule', team: 'Team leads' };

export function PolicyTab({ people, teams }: { people: DirectoryPerson[]; teams: Team[] }) {
  const { can } = useAuth();
  const manage = can('oncall.manage');
  const toast = useToast();
  const [policies, setPolicies] = useState<EscalationPolicy[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [defaults, setDefaults] = useState<Array<{ teamId: string; teamName: string; policyId: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EscalationPolicy | 'new' | null>(null);
  const [deleting, setDeleting] = useState<EscalationPolicy | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, s, d] = await Promise.all([opsApi.policies.list(), opsApi.schedules.list(), opsApi.policies.teamDefaults()]);
      setPolicies(p.policies);
      setSchedules(s.schedules);
      setDefaults(d.teams);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load escalation policies.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setDefault = async (teamId: string, policyId: string) => {
    try {
      await opsApi.policies.setTeamDefault(teamId, policyId || null);
      setDefaults((current) => current.map((row) => (row.teamId === teamId ? { ...row, policyId: policyId || null } : row)));
      toast.success('Team default saved.');
    } catch (caught) {
      toast.error('Could not save', caught instanceof ApiError ? caught.message : undefined);
    }
  };

  if (error) return <ErrorPane message={error} retry={load} />;
  if (loading) return <LoadingPane label="Loading escalation policies" />;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="eyebrow">Escalation policies</p>
          {manage && (
            <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
              <Plus className="size-3.5" />
              New policy
            </Button>
          )}
        </div>
        {policies.length === 0 ? (
          <EmptyState
            icon={GitBranch}
            title="No escalation policies"
            description="A policy is who gets paged, in what order, and how long each level has to acknowledge before the next is woken."
            className="rounded-md border surface"
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {policies.map((policy) => (
              <article key={policy.id} className="rounded-md border p-4 surface">
                <header className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold">{policy.name}</h2>
                    <p className="text-xs text-subtle">
                      {policy.teamName ?? 'No team'}
                      {policy.repeatCount > 0 ? ` · repeats ${policy.repeatCount}×` : ''}
                    </p>
                  </div>
                  {manage && (
                    <Menu
                      trigger={({ toggle }) => (
                        <Button variant="ghost" size="sm" onClick={toggle}>
                          Actions
                        </Button>
                      )}
                      items={[
                        { label: 'Edit policy', onSelect: () => setEditing(policy) },
                        { label: 'Delete policy', icon: Trash2, destructive: true, onSelect: () => setDeleting(policy) },
                      ]}
                    />
                  )}
                </header>
                {policy.description && <p className="mt-1 text-xs text-muted">{policy.description}</p>}
                <ol className="mt-3 space-y-1.5 border-t pt-3">
                  {policy.levels.map((level, index) => (
                    <li key={level.id} className="flex gap-2 text-xs">
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border text-2xs font-medium surface-2">{index + 1}</span>
                      <span className="min-w-0 flex-1">
                        {level.targets.map((t) => t.name ?? t.id).join(', ')}
                        <span className="block text-subtle">escalates after {level.delayMins} min without an acknowledgement</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </article>
            ))}
          </div>
        )}
      </section>

      {defaults.length > 0 && (
        <section>
          <p className="eyebrow mb-1">Team defaults</p>
          <p className="mb-2 text-xs text-muted">Used for a team's alerts when the monitor or alert source does not name its own policy.</p>
          <div className="overflow-x-auto rounded-md border surface">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b surface-2">
                  <th className="eyebrow px-4 py-2 text-left font-medium">Team</th>
                  <th className="eyebrow px-4 py-2 text-left font-medium">Default policy</th>
                </tr>
              </thead>
              <tbody>
                {defaults.map((row) => (
                  <tr key={row.teamId} className="border-b last:border-b-0">
                    <td className="px-4 py-2 text-xs font-medium">{row.teamName}</td>
                    <td className="px-4 py-2">
                      <Select value={row.policyId ?? ''} disabled={!manage} onChange={(event) => setDefault(row.teamId, event.target.value)} className="max-w-72">
                        <option value="">None (tickets only, no paging)</option>
                        {policies.map((policy) => (
                          <option key={policy.id} value={policy.id}>
                            {policy.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {editing && (
        <PolicyDialog
          policy={editing === 'new' ? null : editing}
          people={people}
          teams={teams}
          schedules={schedules}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
            toast.success('Policy saved.');
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name ?? ''}?`}
        message="Monitors, alert sources and teams using it will stop paging until they are given another policy."
        confirmLabel="Delete policy"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await opsApi.policies.remove(deleting.id);
            setDeleting(null);
            await load();
          } catch (caught) {
            toast.error('Could not delete', caught instanceof ApiError ? caught.message : undefined);
          }
        }}
      />
    </div>
  );
}

type LevelDraft = PolicyInput['levels'][number] & { key: string };

function PolicyDialog({
  policy,
  people,
  teams,
  schedules,
  onClose,
  onSaved,
}: {
  policy: EscalationPolicy | null;
  people: DirectoryPerson[];
  teams: Team[];
  schedules: Schedule[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: policy?.name ?? '',
    description: policy?.description ?? '',
    teamId: policy?.teamId ?? '',
    repeatCount: policy?.repeatCount ?? 0,
  });
  const [levels, setLevels] = useState<LevelDraft[]>(
    policy?.levels.map((level) => ({ key: level.id, delayMins: level.delayMins, targets: level.targets.map(({ type, id }) => ({ type, id })) })) ?? [
      { key: 'l0', delayMins: 10, targets: [] },
    ],
  );
  const [submitting, setSubmitting] = useState(false);

  const options: Record<EscalationTargetType, Array<{ id: string; name: string }>> = {
    user: people,
    schedule: schedules,
    team: teams,
  };
  const nameOf = (type: EscalationTargetType, id: string) => options[type].find((o) => o.id === id)?.name ?? '(deleted)';
  const update = (key: string, patch: Partial<LevelDraft>) => setLevels((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const move = (index: number, by: number) =>
    setLevels((current) => {
      const next = [...current];
      [next[index], next[index + by]] = [next[index + by], next[index]];
      return next;
    });

  const submit = async () => {
    setSubmitting(true);
    try {
      const input: PolicyInput = {
        name: form.name,
        description: form.description || null,
        teamId: form.teamId || null,
        repeatCount: form.repeatCount,
        levels: levels.map(({ delayMins, targets }) => ({ delayMins, targets })),
      };
      if (policy) await opsApi.policies.update(policy.id, input);
      else await opsApi.policies.create(input);
      await onSaved();
    } catch (caught) {
      toast.error('Could not save the policy', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={policy ? `Edit ${policy.name}` : 'New escalation policy'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={submitting}
            disabled={!form.name.trim() || levels.some((l) => l.targets.length === 0)}
            onClick={submit}
          >
            {policy ? 'Save changes' : 'Create policy'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_12rem_8rem]">
          <Field label="Name" required>
            <Input value={form.name} onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))} placeholder="SEV1 default" autoFocus />
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
          <Field label="Repeat policy">
            <Select value={String(form.repeatCount)} onChange={(event) => setForm((f) => ({ ...f, repeatCount: Number(event.target.value) }))}>
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? 'Once' : `${n} more time${n === 1 ? '' : 's'}`}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Description">
          <Textarea rows={2} value={form.description} onChange={(event) => setForm((f) => ({ ...f, description: event.target.value }))} />
        </Field>

        <div className="space-y-3">
          {levels.map((level, index) => (
            <div key={level.key} className="space-y-2 rounded-md border p-3 surface-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold">Level {index + 1}</span>
                <div className="flex-1" />
                <Button variant="ghost" size="icon" className="size-7" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up">
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={index === levels.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label="Move down"
                >
                  <ArrowDown className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={levels.length === 1}
                  onClick={() => setLevels((current) => current.filter((l) => l.key !== level.key))}
                  aria-label="Remove level"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {level.targets.length === 0 && <span className="text-xs text-[var(--priority-urgent)]">Add at least one target.</span>}
                {level.targets.map((target, t) => (
                  <span key={`${target.type}-${target.id}`} className="inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-0.5 text-2xs surface">
                    <span className="text-subtle">{target.type}</span> {nameOf(target.type, target.id)}
                    <button
                      onClick={() => update(level.key, { targets: level.targets.filter((_, i) => i !== t) })}
                      aria-label="Remove target"
                      className="text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>

              <TargetPicker
                options={options}
                onAdd={(type, id) => {
                  if (level.targets.some((t) => t.type === type && t.id === id)) return;
                  update(level.key, { targets: [...level.targets, { type, id }] });
                }}
              />

              <Field label="Escalate after (minutes without an acknowledgement)">
                <Input
                  type="number"
                  min={1}
                  max={1440}
                  value={level.delayMins}
                  onChange={(event) => update(level.key, { delayMins: Number(event.target.value) })}
                  className="max-w-32"
                />
              </Field>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setLevels((current) => [...current, { key: Math.random().toString(36).slice(2), delayMins: 10, targets: [] }])}
          >
            <Plus className="size-3.5" />
            Add level
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function TargetPicker({
  options,
  onAdd,
}: {
  options: Record<EscalationTargetType, Array<{ id: string; name: string }>>;
  onAdd: (type: EscalationTargetType, id: string) => void;
}) {
  const [type, setType] = useState<EscalationTargetType>('schedule');
  return (
    <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
      <Select value={type} onChange={(event) => setType(event.target.value as EscalationTargetType)}>
        {ESCALATION_TARGET_TYPES.map((t) => (
          <option key={t} value={t}>
            {TARGET_LABELS[t]}
          </option>
        ))}
      </Select>
      <Select
        value=""
        onChange={(event) => {
          if (event.target.value) onAdd(type, event.target.value);
        }}
      >
        <option value="">{options[type].length ? 'Add…' : `No ${type}s yet`}</option>
        {options[type].map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
