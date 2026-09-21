import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, KeyRound, MoreHorizontal, Trash2, UserPlus, Users } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ROLE_LABELS, relativeTime } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { useToast } from '@/components/ui/Toast';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Select } from '@/components/ui/Field';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Menu } from '@/components/ui/Menu';
import { USER_ROLES, type Permission, type PublicUser, type Team } from '@shared/types';
import { useDocumentTitle } from '@/state/branding';

type Meta = Awaited<ReturnType<typeof api.users.meta>>;

export function PeoplePage() {
  useDocumentTitle('People');
  const { user: currentUser, can } = useAuth();
  const toast = useToast();

  const [users, setUsers] = useState<PublicUser[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<PublicUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<PublicUser | null>(null);
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [userResult, teamResult, metaResult] = await Promise.all([
        api.users.list(),
        api.teams.list(),
        api.users.meta(),
      ]);
      setUsers(userResult.users);
      setTeams(teamResult.teams);
      setMeta(metaResult);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load users.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return users;
    return users.filter(
      (user) =>
        user.name.toLowerCase().includes(needle) ||
        user.email.toLowerCase().includes(needle) ||
        user.username.toLowerCase().includes(needle),
    );
  }, [users, search]);

  const teamName = (id: string) => teams.find((team) => team.id === id)?.name ?? 'Unknown';

  return (
    <div>
      <PageHeader
        title="People"
        description="Accounts are created here. There is no public sign-up — every user is provisioned by an administrator or manager."
        actions={
          can('users.create') ? (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <UserPlus className="size-3.5" />
              New user
            </Button>
          ) : undefined
        }
      >
        <div className="mt-3 max-w-xs">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, email, or username…"
          />
        </div>
      </PageHeader>

      {error ? (
        <ErrorPane message={error} retry={load} />
      ) : loading ? (
        <LoadingPane label="Loading people" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Users}
          title={search ? 'No matching people' : 'No users yet'}
          description={
            search
              ? 'Try a different name or email address.'
              : 'Create the first account to let someone else into the system.'
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] border-collapse text-sm">
            <thead>
              <tr className="border-b surface-2">
                <th className="eyebrow px-3 py-2 pl-4 text-left font-medium sm:pl-6">Name</th>
                <th className="eyebrow px-3 py-2 text-left font-medium">Role</th>
                <th className="eyebrow px-3 py-2 text-left font-medium">Teams</th>
                <th className="eyebrow px-3 py-2 text-left font-medium">Status</th>
                <th className="eyebrow px-3 py-2 text-left font-medium">Last seen</th>
                <th className="w-10 px-3 py-2 pr-4 sm:pr-6" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((user) => (
                <tr key={user.id} className="border-b hover:bg-[var(--surface-2)]">
                  <td className="px-3 py-2 pl-4 sm:pl-6">
                    <div className="flex items-center gap-2">
                      <Avatar name={user.name} color={user.avatarColor} size="md" />
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium">
                          {user.name}
                          {user.id === currentUser?.id && <span className="ml-1.5 text-2xs text-subtle">You</span>}
                        </p>
                        <p className="truncate text-2xs text-subtle">{user.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge dot={false}>{ROLE_LABELS[user.role]}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-xs text-muted">
                      {user.teamIds.length ? user.teamIds.map(teamName).join(', ') : '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 text-xs',
                        user.status === 'active' ? 'text-muted' : 'text-[var(--priority-urgent)]',
                      )}
                    >
                      <span
                        className="size-1.5 rounded-full"
                        style={{
                          background:
                            user.status === 'active' ? 'var(--status-resolved)' : 'var(--priority-urgent)',
                        }}
                      />
                      {user.status === 'active' ? 'Active' : 'Suspended'}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-xs text-subtle">
                      {user.lastLoginAt ? relativeTime(user.lastLoginAt) : 'Never signed in'}
                    </span>
                  </td>
                  <td className="px-3 py-2 pr-4 sm:pr-6">
                    <Menu
                      trigger={({ toggle }) => (
                        <Button variant="ghost" size="icon" onClick={toggle} aria-label={`Actions for ${user.name}`}>
                          <MoreHorizontal className="size-4" />
                        </Button>
                      )}
                      items={[
                        ...(can('users.update')
                          ? [{ label: 'Edit account', onSelect: () => setEditing(user) }]
                          : []),
                        ...(can('users.reset_password')
                          ? [
                              {
                                label: 'Reset password',
                                icon: KeyRound,
                                onSelect: async () => {
                                  try {
                                    const result = await api.users.resetPassword(user.id, {});
                                    if (result.temporaryPassword) {
                                      setCredentials({ email: user.email, password: result.temporaryPassword });
                                    }
                                  } catch (caught) {
                                    toast.error(
                                      'Reset failed',
                                      caught instanceof ApiError ? caught.message : undefined,
                                    );
                                  }
                                },
                              },
                            ]
                          : []),
                        ...(can('users.update') && user.id !== currentUser?.id
                          ? [
                              {
                                label: user.status === 'active' ? 'Suspend account' : 'Reactivate account',
                                onSelect: async () => {
                                  try {
                                    await api.users.update(user.id, {
                                      status: user.status === 'active' ? 'suspended' : 'active',
                                    });
                                    await load();
                                    toast.success(
                                      user.status === 'active' ? 'Account suspended.' : 'Account reactivated.',
                                    );
                                  } catch (caught) {
                                    toast.error(
                                      'Could not update',
                                      caught instanceof ApiError ? caught.message : undefined,
                                    );
                                  }
                                },
                              },
                            ]
                          : []),
                        ...(can('users.delete') && user.id !== currentUser?.id
                          ? [
                              {
                                label: 'Delete account',
                                icon: Trash2,
                                destructive: true,
                                onSelect: () => setDeleting(user),
                              },
                            ]
                          : []),
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {meta && (creating || editing) && (
        <UserDialog
          open
          user={editing}
          teams={teams}
          meta={meta}
          currentUserRole={currentUser?.role ?? 'agent'}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async (temporaryPassword, email) => {
            setCreating(false);
            setEditing(null);
            await load();
            if (temporaryPassword) setCredentials({ email, password: temporaryPassword });
            else toast.success('Account saved.');
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name ?? ''}?`}
        message="Their account is removed and their sessions end immediately. Tickets they created or worked on are kept, but will show the author as unknown."
        confirmLabel="Delete account"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api.users.remove(deleting.id);
            setDeleting(null);
            await load();
            toast.success('Account deleted.');
          } catch (caught) {
            toast.error('Could not delete', caught instanceof ApiError ? caught.message : undefined);
          }
        }}
      />

      <CredentialsDialog credentials={credentials} onClose={() => setCredentials(null)} />
    </div>
  );
}

/** Shown once after provisioning, since the password is never recoverable later. */
function CredentialsDialog({
  credentials,
  onClose,
}: {
  credentials: { email: string; password: string } | null;
  onClose: () => void;
}) {
  const toast = useToast();

  return (
    <Modal
      open={Boolean(credentials)}
      onClose={onClose}
      title="Temporary password"
      description="Copy this now — it is shown only once and cannot be retrieved later."
      size="sm"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-2">
        <div className="rounded-sm border p-2.5 surface-2">
          <p className="eyebrow">Email</p>
          <p className="font-mono text-xs">{credentials?.email}</p>
        </div>
        <div className="rounded-sm border p-2.5 surface-2">
          <p className="eyebrow">Password</p>
          <div className="flex items-center justify-between gap-2">
            <p className="font-mono text-xs break-all select-all">{credentials?.password}</p>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Copy password"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(credentials?.password ?? '');
                  toast.success('Copied to clipboard.');
                } catch {
                  toast.error('Could not copy', 'Select the text and copy it manually.');
                }
              }}
            >
              <Copy className="size-3.5" />
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted">
          The user will be asked to choose a new password the first time they sign in.
        </p>
      </div>
    </Modal>
  );
}

function UserDialog({
  open,
  user,
  teams,
  meta,
  currentUserRole,
  onClose,
  onSaved,
}: {
  open: boolean;
  user: PublicUser | null;
  teams: Team[];
  meta: Meta;
  currentUserRole: string;
  onClose: () => void;
  onSaved: (temporaryPassword: string | undefined, email: string) => Promise<void>;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: user?.name ?? '',
    email: user?.email ?? '',
    username: user?.username ?? '',
    jobTitle: user?.jobTitle ?? '',
    phone: user?.phone ?? '',
    role: user?.role ?? 'agent',
    status: user?.status ?? 'active',
  });
  const [teamIds, setTeamIds] = useState<string[]>(user?.teamIds ?? []);
  const [extraPermissions, setExtraPermissions] = useState<Permission[]>(user?.extraPermissions ?? []);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  const submit = async () => {
    setErrors({});
    setSubmitting(true);
    try {
      const payload = {
        name: form.name,
        email: form.email,
        username: form.username || undefined,
        jobTitle: form.jobTitle || null,
        phone: form.phone || null,
        role: form.role,
        status: form.status,
        teamIds,
        extraPermissions,
      };

      if (user) {
        await api.users.update(user.id, payload);
        await onSaved(undefined, form.email);
      } else {
        const result = await api.users.create(payload);
        await onSaved(result.temporaryPassword, form.email);
      }
    } catch (caught) {
      if (caught instanceof ApiError) {
        setErrors(caught.details ?? {});
        toast.error(user ? 'Could not save' : 'Could not create the account', caught.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={user ? `Edit ${user.name}` : 'New user'}
      description={
        user
          ? 'Changes take effect immediately.'
          : 'A temporary password is generated and shown once after you save.'
      }
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={submitting}
            disabled={!form.name.trim() || !form.email.trim()}
            onClick={submit}
          >
            {user ? 'Save changes' : 'Create account'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name" error={errors.Name} required>
            <Input value={form.name} onChange={set('name')} placeholder="Dana Reyes" autoFocus />
          </Field>
          <Field label="Email" error={errors.email ?? errors.Email} required>
            <Input type="email" value={form.email} onChange={set('email')} placeholder="dana@company.com" />
          </Field>
          <Field label="Username" hint="Defaults to the part before the @.">
            <Input value={form.username} onChange={set('username')} placeholder="dana" />
          </Field>
          <Field label="Job title">
            <Input value={form.jobTitle} onChange={set('jobTitle')} placeholder="Support Manager" />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={set('phone')} placeholder="+44 20 7946 0000" />
          </Field>
          <Field label="Status">
            <Select value={form.status} onChange={set('status')}>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </Select>
          </Field>
        </div>

        <Field
          label="Role"
          hint={meta.roles.find((role) => role.value === form.role)?.description}
        >
          <Select value={form.role} onChange={set('role')}>
            {USER_ROLES.filter((role) => role !== 'admin' || currentUserRole === 'admin').map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </Select>
        </Field>

        <div>
          <p className="mb-2 text-xs font-medium">Team membership</p>
          {teams.length === 0 ? (
            <p className="text-xs text-subtle">No teams have been created yet.</p>
          ) : (
            <div className="grid gap-2 rounded-sm border p-3 surface-2 sm:grid-cols-2">
              {teams.map((team) => (
                <Checkbox
                  key={team.id}
                  checked={teamIds.includes(team.id)}
                  onChange={() => setTeamIds((current) => toggle(current, team.id))}
                  label={team.name}
                  hint={team.description ?? undefined}
                />
              ))}
            </div>
          )}
        </div>

        <details className="rounded-sm border surface-2">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium select-none">
            Additional permissions
            {extraPermissions.length > 0 && (
              <span className="ml-1.5 text-subtle">({extraPermissions.length} granted)</span>
            )}
          </summary>
          <div className="space-y-4 border-t px-3 py-3">
            <p className="text-xs text-muted">
              These are granted on top of the role. The role&apos;s own permissions always apply and cannot be
              revoked here — change the role instead.
            </p>
            {meta.permissionGroups.map((group) => (
              <div key={group.label}>
                <p className="eyebrow mb-1.5">{group.label}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {group.permissions.map((permission) => (
                    <Checkbox
                      key={permission.key}
                      checked={extraPermissions.includes(permission.key)}
                      onChange={() => setExtraPermissions((current) => toggle(current, permission.key))}
                      label={permission.label}
                      hint={permission.hint}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
      </div>
    </Modal>
  );
}
