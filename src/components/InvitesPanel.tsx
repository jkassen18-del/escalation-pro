import { useCallback, useEffect, useState } from 'react';
import { Copy, Link2, Send } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Checkbox, Field, Input, Select } from '@/components/ui/Field';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import type { Invite, InviteStatus, Role, Team } from '@shared/types';

const STATUS_LABELS: Record<InviteStatus, string> = {
  active: 'Active',
  expired: 'Expired',
  used_up: 'Used',
  revoked: 'Revoked',
};

async function copy(text: string, toast: ReturnType<typeof useToast>) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Link copied.');
  } catch {
    toast.error('Could not copy', 'Select the link and copy it manually.');
  }
}

/**
 * Invite links: who they let in, as what, and how much use they have left.
 * The link itself is shown once, when it is made; only a hash is kept.
 */
export function InvitesPanel({
  teams,
  roles,
  onInvite,
  reloadKey,
}: {
  teams: Team[];
  roles: Role[];
  onInvite: () => void;
  reloadKey: number;
}) {
  const toast = useToast();
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Invite | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setInvites((await api.invites.list()).invites);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load invites.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const teamNames = (ids: string[]) =>
    ids.length ? ids.map((id) => teams.find((team) => team.id === id)?.name ?? 'Deleted department').join(', ') : 'Any department';

  if (error) return <ErrorPane message={error} retry={load} />;
  if (!invites) return <LoadingPane label="Loading invites" />;
  if (!invites.length) {
    return (
      <EmptyState
        icon={Link2}
        title="No invites yet"
        description="Make an invite link and share it. People who open it enter their name, company email and department, and get an account with the role you chose."
        action={<Button onClick={onInvite}>Invite people</Button>}
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] border-collapse text-sm">
        <thead>
          <tr className="border-b surface-2">
            <th className="eyebrow px-3 py-2 pl-4 text-left font-medium sm:pl-6">Invite</th>
            <th className="eyebrow px-3 py-2 text-left font-medium">Role</th>
            <th className="eyebrow px-3 py-2 text-left font-medium">Departments</th>
            <th className="eyebrow px-3 py-2 text-left font-medium">Uses</th>
            <th className="eyebrow px-3 py-2 text-left font-medium">Expires</th>
            <th className="eyebrow px-3 py-2 text-left font-medium">Status</th>
            <th className="w-24 px-3 py-2 pr-4 sm:pr-6" />
          </tr>
        </thead>
        <tbody>
          {invites.map((invite) => (
            <tr key={invite.id} className="border-b hover:bg-[var(--surface-2)]">
              <td className="px-3 py-2 pl-4 sm:pl-6">
                <p className="text-xs font-medium">{invite.label || invite.email || 'Shareable link'}</p>
                <p className="text-2xs text-subtle">
                  {invite.allowedDomains.length ? invite.allowedDomains.map((d) => `@${d}`).join(', ') : 'Any email'}
                  {invite.createdByName ? ` · by ${invite.createdByName}` : ''} · {relativeTime(invite.createdAt)}
                </p>
              </td>
              <td className="px-3 py-2">
                <Badge dot={false}>{roles.find((role) => role.id === invite.roleId)?.name ?? invite.roleName}</Badge>
              </td>
              <td className="px-3 py-2 text-xs text-muted">{teamNames(invite.teamIds)}</td>
              <td className="px-3 py-2 text-xs text-muted tabular">
                {invite.uses}
                {invite.maxUses !== null ? ` of ${invite.maxUses}` : ''}
              </td>
              <td className="px-3 py-2 text-xs text-subtle">{relativeTime(invite.expiresAt)}</td>
              <td className="px-3 py-2">
                <Badge color={invite.status === 'active' ? 'var(--status-resolved)' : 'var(--fg-subtle)'}>{STATUS_LABELS[invite.status]}</Badge>
              </td>
              <td className="px-3 py-2 pr-4 text-right sm:pr-6">
                {invite.status === 'active' && (
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(invite)}>
                    Revoke
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ConfirmDialog
        open={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        title="Revoke this invite?"
        message="The link stops working straight away. Accounts already made with it are kept."
        confirmLabel="Revoke"
        destructive
        onConfirm={async () => {
          if (!revoking) return;
          try {
            await api.invites.revoke(revoking.id);
            setRevoking(null);
            await load();
            toast.success('Invite revoked.');
          } catch (caught) {
            toast.error('Could not revoke', caught instanceof ApiError ? caught.message : undefined);
          }
        }}
      />
    </div>
  );
}

/** Makes an invite, then shows its link once. */
export function InviteDialog({
  teams,
  roles,
  onClose,
  onCreated,
}: {
  teams: Team[];
  roles: Role[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const { user } = useAuth();
  const mine = user?.permissions ?? [];
  const isAdmin = user?.role === 'admin';
  // Only roles you could give someone yourself.
  const offerable = roles.filter((role) => (role.systemKey === 'admin' ? isAdmin : role.permissions.every((key) => mine.includes(key))));
  const defaultRole = offerable.find((role) => role.systemKey === 'agent') ?? offerable[0];

  const [label, setLabel] = useState('');
  const [roleId, setRoleId] = useState(defaultRole?.id ?? '');
  const [email, setEmail] = useState('');
  const [domains, setDomains] = useState(() => {
    const own = user?.email.split('@')[1];
    return own ?? '';
  });
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [days, setDays] = useState('7');
  const [maxUses, setMaxUses] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<{ url: string; emailed: { ok: boolean; error: string | null } | null } | null>(null);

  const submit = async () => {
    setErrors({});
    setSubmitting(true);
    try {
      const result = await api.invites.create({
        label: label || null,
        roleId,
        email: email || null,
        allowedDomains: domains
          .split(/[\s,;]+/)
          .map((domain) => domain.trim())
          .filter(Boolean),
        teamIds,
        expiresInDays: Number(days) || 7,
        maxUses: email ? 1 : maxUses ? Number(maxUses) : null,
      });
      // Built from where the admin is looking at the app, which is where people reach it.
      const url = `${window.location.origin}/invite/${result.token}`;
      setCreated({ url, emailed: result.emailed });
      onCreated();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setErrors(caught.details ?? {});
        toast.error('Could not create the invite', caught.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (created) {
    return (
      <Modal
        open
        onClose={onClose}
        title="Invite link ready"
        description="Copy it now: it is shown only once. Anyone with the link can use it until it expires or runs out."
        size="md"
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-sm border p-2.5 surface-2">
            <p className="min-w-0 flex-1 font-mono text-xs break-all select-all">{created.url}</p>
            <Button variant="ghost" size="icon" aria-label="Copy link" onClick={() => void copy(created.url, toast)}>
              <Copy className="size-3.5" />
            </Button>
          </div>
          {created.emailed && (
            <p className="text-xs text-muted">
              {created.emailed.ok ? `Emailed to ${email}.` : `Not emailed (${created.emailed.error}). Send the link yourself.`}
            </p>
          )}
          <p className="text-xs text-muted">
            Share it in Teams, email or anywhere else. When someone joins you get a notification; make them a department manager from
            their account or the Teams page.
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Invite people"
      description="People who open the link enter their first name, surname, company email and department, then choose a password."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} disabled={!roleId} onClick={submit}>
            <Send className="size-3.5" />
            Create invite link
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Label" hint="Only you see this, e.g. “Finance team, October”.">
            <Input value={label} onChange={(event) => setLabel(event.target.value)} autoFocus />
          </Field>
          <Field label="Role they get" error={errors.roleId} hint="Department managers are chosen after they join.">
            <Select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
              {offerable.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                  {role.systemKey ? '' : ' (custom)'}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Company email domains"
            error={errors.allowedDomains}
            hint="Only addresses ending in these are accepted. Separate several with commas; leave empty to accept any."
          >
            <Input value={domains} onChange={(event) => setDomains(event.target.value)} placeholder="goldmedialab.com" />
          </Field>
          <Field label="For one person (optional)" error={errors.email} hint="Makes it a single-use link; emailed when email is set up.">
            <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="dana@goldmedialab.com" />
          </Field>
          <Field label="Expires after">
            <Select value={days} onChange={(event) => setDays(event.target.value)}>
              <option value="1">1 day</option>
              <option value="3">3 days</option>
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </Select>
          </Field>
          <Field label="How many people can use it" hint={email ? 'One, since it is for one person.' : 'Leave empty for no limit.'}>
            <Input type="number" min={1} value={email ? '1' : maxUses} disabled={Boolean(email)} onChange={(event) => setMaxUses(event.target.value)} placeholder="No limit" />
          </Field>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium">Departments they can pick</p>
          <p className="mb-2 text-xs text-subtle">Leave all unticked to let them choose any department.</p>
          <div className="grid gap-2 rounded-sm border p-3 surface-2 sm:grid-cols-2">
            {teams.map((team) => (
              <Checkbox
                key={team.id}
                checked={teamIds.includes(team.id)}
                onChange={() =>
                  setTeamIds((current) => (current.includes(team.id) ? current.filter((id) => id !== team.id) : [...current, team.id]))
                }
                label={team.name}
              />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
