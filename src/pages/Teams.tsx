import { useCallback, useEffect, useState } from 'react';
import { Building2, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { duration } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { useToast } from '@/components/ui/Toast';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { FormBuilder } from '@/components/FormBuilder';
import { TeamRouting } from '@/components/TeamRouting';
import { TeamLinks } from '@/components/TeamLinks';
import { LabelManager } from '@/components/Labels';
import { Menu } from '@/components/ui/Menu';
import { AUTO_ASSIGN_MODES, TICKET_PRIORITIES, type Team } from '@shared/types';
import { useDocumentTitle } from '@/state/branding';

const AUTO_ASSIGN_LABELS: Record<string, string> = {
  none: 'Manual — someone picks it up',
  round_robin: 'Round robin — share evenly in turn',
  least_busy: 'Least busy — whoever has fewest open tickets',
};

/** Minute presets that map to how people actually talk about SLAs. */
const SLA_PRESETS = [
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
  { value: 240, label: '4 hours' },
  { value: 480, label: '8 hours' },
  { value: 1440, label: '1 day' },
  { value: 2880, label: '2 days' },
  { value: 4320, label: '3 days' },
  { value: 10080, label: '1 week' },
];

export function TeamsPage() {
  useDocumentTitle('Teams');
  const toast = useToast();
  const { can } = useAuth();
  const [teams, setTeams] = useState<Team[]>([]);
  const [directory, setDirectory] = useState<Awaited<ReturnType<typeof api.users.directory>>['users']>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Team | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Team | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [teamResult, directoryResult] = await Promise.all([api.teams.list(), api.users.directory()]);
      setTeams(teamResult.teams);
      setDirectory(directoryResult.users);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load teams.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <PageHeader
        title="Teams"
        description="Teams own queues of tickets. Routing rules and SLA targets are set per team."
        actions={
          can('teams.manage') ? (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" />
              New team
            </Button>
          ) : undefined
        }
      />

      {error ? (
        <ErrorPane message={error} retry={load} />
      ) : loading ? (
        <LoadingPane label="Loading teams" />
      ) : teams.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No teams yet"
          description="Create a team for each queue you want tickets routed into — Support, Operations, Engineering, and so on."
          action={
            can('teams.manage') ? (
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                Create the first team
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-6 xl:grid-cols-3">
          {teams.map((team) => (
            <article key={team.id} className="rounded-md border p-4 surface">
              <header className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: team.color }} />
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold">{team.name}</h2>
                    <p className="font-mono text-2xs text-subtle">{team.key}</p>
                  </div>
                </div>
                <Menu
                  trigger={({ toggle }) => (
                    <Button variant="ghost" size="icon" onClick={toggle} aria-label={`Actions for ${team.name}`}>
                      <MoreHorizontal className="size-4" />
                    </Button>
                  )}
                  items={[
                    { label: can('teams.manage') ? 'Edit team' : 'Open team', onSelect: () => setEditing(team) },
                    ...(can('teams.manage')
                      ? [{ label: 'Delete team', icon: Trash2, destructive: true, onSelect: () => setDeleting(team) }]
                      : []),
                  ]}
                />
              </header>

              {team.description && <p className="mt-2 text-xs leading-relaxed text-muted">{team.description}</p>}

              <dl className="mt-3 space-y-1.5 border-t pt-3 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-subtle">Open tickets</dt>
                  <dd className="tabular font-medium">{team.openTicketCount ?? 0}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-subtle">Routing</dt>
                  <dd className="truncate text-right">{team.autoAssign.replace('_', ' ')}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-subtle">First response</dt>
                  <dd className="tabular">{duration(team.slaResponseMins)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-subtle">Resolution</dt>
                  <dd className="tabular">{duration(team.slaResolveMins)}</dd>
                </div>
              </dl>

              <div className="mt-3 border-t pt-3">
                <p className="eyebrow mb-1.5">{team.memberIds.length} member{team.memberIds.length === 1 ? '' : 's'}</p>
                <div className="flex flex-wrap gap-1">
                  {team.memberIds.slice(0, 8).map((id) => {
                    const person = directory.find((entry) => entry.id === id);
                    return person ? (
                      <Avatar key={id} name={person.name} color={person.avatarColor} size="sm" />
                    ) : null;
                  })}
                  {team.memberIds.length > 8 && (
                    <span className="text-2xs text-subtle">+{team.memberIds.length - 8}</span>
                  )}
                  {team.memberIds.length === 0 && (
                    <span className="text-2xs text-subtle italic">Nobody assigned yet</span>
                  )}
                </div>
                {team.managerIds.length > 0 && (
                  <p className="mt-1.5 truncate text-2xs text-subtle">
                    Managed by{' '}
                    {team.managerIds
                      .map((id) => directory.find((entry) => entry.id === id)?.name)
                      .filter(Boolean)
                      .join(', ')}
                  </p>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {!loading && !error && can('teams.manage') && (
        <section className="mx-4 mb-6 sm:mx-6">
          <h2 className="text-sm font-semibold">Labels for every department</h2>
          <p className="mt-0.5 mb-2 text-xs text-muted">
            Offered on every ticket alongside the department's own labels. Each department's labels are under Edit team.
          </p>
          <LabelManager teamId={null} />
        </section>
      )}

      {(creating || editing) && (
        <TeamDialog
          team={editing}
          directory={directory}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditing(null);
            await load();
            toast.success('Team saved.');
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name ?? ''}?`}
        message="Teams with open tickets cannot be deleted. Resolved tickets keep their history but lose the team label."
        confirmLabel="Delete team"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api.teams.remove(deleting.id);
            setDeleting(null);
            await load();
            toast.success('Team deleted.');
          } catch (caught) {
            toast.error('Could not delete', caught instanceof ApiError ? caught.message : undefined);
          }
        }}
      />
    </div>
  );
}

function TeamDialog({
  team,
  directory,
  onClose,
  onSaved,
}: {
  team: Team | null;
  directory: Awaited<ReturnType<typeof api.users.directory>>['users'];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const { can } = useAuth();
  // Department details and routing need "Manage departments"; links and the
  // intake form have their own permissions and can be edited without it.
  const manage = can('teams.manage');
  /* Offered as a field type only where a connection actually exists. */
  const [dataSources, setDataSources] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    void api.dataSources
      .list()
      .then((result) => setDataSources(result.dataSources.map(({ id, name }) => ({ id, name }))))
      .catch(() => setDataSources([]));
  }, []);
  const [form, setForm] = useState({
    name: team?.name ?? '',
    key: team?.key ?? '',
    description: team?.description ?? '',
    color: team?.color ?? '#4d6b8a',
    autoAssign: team?.autoAssign ?? 'none',
    defaultPriority: team?.defaultPriority ?? 'normal',
    slaResponseMins: team?.slaResponseMins ?? 240,
    slaResolveMins: team?.slaResolveMins ?? 2880,
  });
  const [memberIds, setMemberIds] = useState<string[]>(team?.memberIds ?? []);
  const [managerIds, setManagerIds] = useState<string[]>(team?.managerIds ?? []);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      const payload = { ...form, memberIds, managerIds: managerIds.filter((id) => memberIds.includes(id)) };
      if (team) await api.teams.update(team.id, payload);
      else await api.teams.create(payload);
      await onSaved();
    } catch (caught) {
      toast.error('Could not save the team', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={team ? `Edit ${team.name}` : 'New team'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {manage && (
            <Button variant="primary" loading={submitting} disabled={!form.name.trim()} onClick={submit}>
              {team ? 'Save changes' : 'Create team'}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <fieldset disabled={!manage} className="min-w-0 space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem_5rem]">
          <Field label="Name" required>
            <Input
              value={form.name}
              onChange={(event) => {
                const name = event.target.value;
                setForm((current) => ({
                  ...current,
                  name,
                  // Derive the key from the name until the user edits it directly.
                  key: team ? current.key : name.slice(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, ''),
                }));
              }}
              placeholder="Operations"
              autoFocus
            />
          </Field>
          <Field label="Key" hint="Used in references.">
            <Input
              value={form.key}
              onChange={(event) => setForm((c) => ({ ...c, key: event.target.value.toUpperCase() }))}
              maxLength={10}
              className="font-mono"
            />
          </Field>
          <Field label="Colour">
            <input
              type="color"
              value={form.color}
              onChange={(event) => setForm((c) => ({ ...c, color: event.target.value }))}
              className="h-8 w-full cursor-pointer rounded-sm border border-[var(--border-strong)] bg-transparent p-0.5"
            />
          </Field>
        </div>

        <Field label="Description">
          <Textarea
            value={form.description}
            onChange={(event) => setForm((c) => ({ ...c, description: event.target.value }))}
            rows={2}
            placeholder="Service disruptions, incidents, and operational escalations."
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Routing" hint={AUTO_ASSIGN_LABELS[form.autoAssign]}>
            <Select
              value={form.autoAssign}
              onChange={(event) => setForm((c) => ({ ...c, autoAssign: event.target.value as Team['autoAssign'] }))}
            >
              {AUTO_ASSIGN_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Default priority">
            <Select
              value={form.defaultPriority}
              onChange={(event) =>
                setForm((c) => ({ ...c, defaultPriority: event.target.value as Team['defaultPriority'] }))
              }
            >
              {TICKET_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {priority}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="First response target">
            <Select
              value={String(form.slaResponseMins)}
              onChange={(event) => setForm((c) => ({ ...c, slaResponseMins: Number(event.target.value) }))}
            >
              {SLA_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Resolution target" hint="Urgent tickets get a quarter of this; low priority gets double.">
            <Select
              value={String(form.slaResolveMins)}
              onChange={(event) => setForm((c) => ({ ...c, slaResolveMins: Number(event.target.value) }))}
            >
              {SLA_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium">Members</p>
          <p className="mb-2 text-xs text-subtle">
            Managers edit this department’s on-call and are who a “team leads” escalation step reaches.
          </p>
          <div className="grid max-h-72 gap-2 overflow-y-auto rounded-sm border p-3 surface-2 sm:grid-cols-2">
            {directory.map((person) => (
              <div key={person.id} className="flex items-start justify-between gap-2">
                <Checkbox
                  checked={memberIds.includes(person.id)}
                  onChange={() =>
                    setMemberIds((current) =>
                      current.includes(person.id)
                        ? current.filter((id) => id !== person.id)
                        : [...current, person.id],
                    )
                  }
                  label={person.name}
                  hint={person.jobTitle ?? person.email}
                />
                {memberIds.includes(person.id) && (
                  <Select
                    aria-label={`${person.name}'s role in the department`}
                    className="h-7 w-auto shrink-0 text-xs"
                    value={managerIds.includes(person.id) ? 'manager' : 'member'}
                    onChange={(event) =>
                      setManagerIds((current) =>
                        event.target.value === 'manager'
                          ? [...current.filter((id) => id !== person.id), person.id]
                          : current.filter((id) => id !== person.id),
                      )
                    }
                  >
                    <option value="member">Member</option>
                    <option value="manager">Manager</option>
                  </Select>
                )}
              </div>
            ))}
          </div>
        </div>

        </fieldset>

        {/*
          * Only offered for a team that already exists: the form is stored
          * against a team id, so there is nothing to attach questions to until
          * the team has been created.
          */}
        {team && manage && (
          <div>
            <p className="mb-2 text-xs font-medium">Where these tickets are announced</p>
            <TeamRouting teamId={team.id} teamName={team.name} />
          </div>
        )}

        {team && can('teams.links') && (
          <div>
            <p className="mb-2 text-xs font-medium">Links to other systems</p>
            <TeamLinks teamId={team.id} />
          </div>
        )}

        {team && (can('teams.manage') || can('teams.forms')) && (
          <div>
            <p className="mb-0.5 text-xs font-medium">Labels</p>
            <p className="mb-2 text-xs text-muted">Picked from on this department's tickets instead of typing free-text tags.</p>
            <LabelManager teamId={team.id} />
          </div>
        )}

        {team && can('teams.forms') && (
          <div>
            <p className="mb-2 text-xs font-medium">Intake form</p>
            <FormBuilder teamId={team.id} teamName={team.name} dataSources={dataSources} />
          </div>
        )}
      </div>
    </Modal>
  );
}
