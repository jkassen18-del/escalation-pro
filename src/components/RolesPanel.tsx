import { useMemo, useState } from 'react';
import { Lock, MoreHorizontal, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/state/auth';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Menu } from '@/components/ui/Menu';
import { Modal } from '@/components/ui/Modal';
import { PermissionPicker, type PermissionGroup } from '@/components/PermissionPicker';
import type { Permission, Role } from '@shared/types';

interface RolesMeta {
  roles: Role[];
  permissionGroups: PermissionGroup[];
  allPermissions: Permission[];
}

/**
 * Roles: named sets of permissions. Built-ins are labelled and cannot be
 * deleted; Administrator always holds everything. Anyone who can see people
 * can see what each role grants; changing roles needs "Manage roles".
 */
export function RolesPanel({ meta, onChanged }: { meta: RolesMeta; onChanged: () => Promise<void> }) {
  const { can } = useAuth();
  const manage = can('roles.manage');
  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Role | null>(null);

  return (
    <div className="space-y-3 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-xs text-muted">
          A role is a preset of access. Give someone a role, then add individual permissions on top in their account if
          they need a little more. Nobody can put a permission into a role that they do not hold themselves.
        </p>
        {manage && (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            New role
          </Button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {meta.roles.map((role) => (
          <article key={role.id} className="flex min-w-0 flex-col rounded-md border p-4 surface">
            <header className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 truncate text-sm font-semibold">
                  {role.systemKey === 'admin' ? <ShieldCheck className="size-3.5 shrink-0" /> : null}
                  {role.name}
                </h2>
                <p className="mt-0.5 text-2xs text-subtle">
                  {role.memberCount} {role.memberCount === 1 ? 'person' : 'people'} · {role.permissions.length} of{' '}
                  {meta.allPermissions.length} permissions
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Badge dot={false}>{role.systemKey ? 'Built-in' : 'Custom'}</Badge>
                {manage && role.systemKey !== 'admin' && (
                  <Menu
                    trigger={({ toggle }) => (
                      <Button variant="ghost" size="icon" onClick={toggle} aria-label={`Actions for ${role.name}`}>
                        <MoreHorizontal className="size-4" />
                      </Button>
                    )}
                    items={[
                      { label: 'Edit role', onSelect: () => setEditing(role) },
                      ...(role.systemKey
                        ? []
                        : [{ label: 'Delete role', icon: Trash2, destructive: true, onSelect: () => setDeleting(role) }]),
                    ]}
                  />
                )}
              </div>
            </header>
            {role.description && <p className="mt-2 text-xs leading-relaxed text-muted">{role.description}</p>}
            <div className="mt-auto pt-3">
              <Button variant="secondary" size="sm" onClick={() => setEditing(role)}>
                {manage && role.systemKey !== 'admin' ? 'Edit access' : 'View access'}
              </Button>
            </div>
          </article>
        ))}
      </div>

      {(creating || editing) && (
        <RoleDialog
          role={editing}
          meta={meta}
          readOnly={!manage || editing?.systemKey === 'admin'}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditing(null);
            await onChanged();
          }}
        />
      )}
      {deleting && (
        <DeleteRoleDialog
          role={deleting}
          roles={meta.roles}
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            setDeleting(null);
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

function RoleDialog({
  role,
  meta,
  readOnly,
  onClose,
  onSaved,
}: {
  role: Role | null;
  meta: RolesMeta;
  readOnly: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const { user } = useAuth();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [permissions, setPermissions] = useState<Permission[]>(role?.permissions ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What the editor holds is what they may switch on; administrators hold all.
  const grantable = useMemo(
    () => (user?.role === 'admin' ? meta.allPermissions : user?.permissions ?? []),
    [user, meta.allPermissions],
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (role) {
        await api.roles.update(role.id, {
          ...(role.systemKey ? {} : { name }),
          description: description || null,
          permissions,
        });
      } else {
        await api.roles.create({ name, description: description || null, permissions });
      }
      toast.success(role ? 'Role saved.' : 'Role created.');
      await onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the role.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={role ? (readOnly ? role.name : `Edit ${role.name}`) : 'New role'}
      description={
        role?.systemKey === 'admin'
          ? 'Administrators always hold every permission, including ones added in later versions.'
          : role?.systemKey
            ? 'A built-in role. Its access can be changed; it cannot be renamed or deleted.'
            : 'Pick everything people with this role may do.'
      }
      size="lg"
      footer={
        readOnly ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} disabled={!name.trim()} onClick={save}>
              {role ? 'Save role' : 'Create role'}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {!readOnly && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" required>
              <Input value={name} onChange={(event) => setName(event.target.value)} disabled={Boolean(role?.systemKey)} placeholder="Service desk lead" autoFocus />
            </Field>
            <Field label="Description">
              <Textarea rows={1} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this role is for" />
            </Field>
          </div>
        )}
        {readOnly && role?.systemKey === 'admin' && (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Lock className="size-3.5" /> Locked
          </p>
        )}
        {error && <p className="text-xs text-[var(--priority-urgent)]">{error}</p>}
        <PermissionPicker groups={meta.permissionGroups} value={permissions} onChange={setPermissions} grantable={grantable} readOnly={readOnly} />
      </div>
    </Modal>
  );
}

function DeleteRoleDialog({
  role,
  roles,
  onClose,
  onDeleted,
}: {
  role: Role;
  roles: Role[];
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const toast = useToast();
  const others = roles.filter((other) => other.id !== role.id && other.systemKey !== 'admin');
  const [replacement, setReplacement] = useState(others.find((other) => other.systemKey === 'viewer')?.id ?? others[0]?.id ?? '');
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await api.roles.remove(role.id, role.memberCount > 0 ? replacement : undefined);
      toast.success('Role deleted.');
      await onDeleted();
    } catch (caught) {
      toast.error('Could not delete', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Delete ${role.name}?`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} disabled={role.memberCount > 0 && !replacement} onClick={remove}>
            Delete role
          </Button>
        </>
      }
    >
      {role.memberCount > 0 ? (
        <Field
          label={`Move ${role.memberCount} ${role.memberCount === 1 ? 'person' : 'people'} to`}
          hint="Their extra permissions stay as they are."
        >
          <Select value={replacement} onChange={(event) => setReplacement(event.target.value)}>
            {others.map((other) => (
              <option key={other.id} value={other.id}>
                {other.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <p className="text-sm text-muted">Nobody holds this role, so nothing else changes.</p>
      )}
    </Modal>
  );
}
