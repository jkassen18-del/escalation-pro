import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, Check, Hourglass, Plus, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Field, Input, SegmentedControl, Textarea } from '@/components/ui/Field';
import type { ApprovalMode, TicketApproval } from '@shared/approvals';

type Directory = Awaited<ReturnType<typeof api.users.directory>>['users'];

export const APPROVAL_STATUS: Record<TicketApproval['status'], { label: string; className: string }> = {
  pending: { label: 'Waiting', className: 'text-[var(--status-pending)]' },
  approved: { label: 'Approved', className: 'text-[var(--status-resolved)]' },
  rejected: { label: 'Rejected', className: 'text-[var(--priority-urgent)]' },
  cancelled: { label: 'Withdrawn', className: 'text-subtle' },
};

/**
 * Sign-off on a ticket: what is waiting, who on, and - for an approver -
 * Approve and Reject. While one waits, the ticket cannot be started or
 * resolved.
 */
export function TicketApprovals({
  ticketId,
  teamId,
  directory,
  onChanged,
}: {
  ticketId: string;
  teamId: string | null;
  directory: Directory;
  onChanged: () => void;
}) {
  const { user, can } = useAuth();
  const toast = useToast();
  const [approvals, setApprovals] = useState<TicketApproval[]>([]);
  const [canRequest, setCanRequest] = useState(false);
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.approvals.forTicket(ticketId);
      setApprovals(result.approvals);
      setCanRequest(result.canRequest);
    } catch {
      // The panel is secondary; the ticket itself still shows.
    }
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (approval: TicketApproval, decision: 'approved' | 'rejected') => {
    setBusy(approval.id);
    try {
      await api.approvals.decide(approval.id, decision, comment || undefined);
      setComment('');
      toast.success(decision === 'approved' ? 'Approved' : 'Rejected');
      await load();
      onChanged();
    } catch (caught) {
      toast.error('Could not record that', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async (approval: TicketApproval) => {
    try {
      await api.approvals.cancel(approval.id);
      await load();
      onChanged();
    } catch (caught) {
      toast.error('Could not withdraw it', caught instanceof ApiError ? caught.message : undefined);
    }
  };

  if (!approvals.length && !canRequest) return null;
  const managesDepartment = Boolean(teamId && user?.managedTeamIds?.includes(teamId));

  return (
    <div className="border-b px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="eyebrow">Approvals</p>
        {canRequest && !asking && (
          <button onClick={() => setAsking(true)} className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline">
            <Plus className="size-3" /> Request
          </button>
        )}
      </div>

      {approvals.length === 0 && !asking && <p className="text-xs text-muted">Nothing needs sign-off.</p>}

      <ul className="space-y-2">
        {approvals.map((approval) => {
          const mine = approval.status === 'pending' && user && approval.approverIds.includes(user.id) && !approval.decisions.some((d) => d.userId === user.id);
          const mayWithdraw = approval.status === 'pending' && (approval.requestedById === user?.id || can('approvals.manage') || managesDepartment);
          const status = APPROVAL_STATUS[approval.status];
          return (
            <li key={approval.id} className={cn('rounded-sm border p-2.5 surface', approval.status === 'pending' && 'border-[var(--accent)]')}>
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 text-xs font-semibold">{approval.title}</p>
                <span className={cn('inline-flex shrink-0 items-center gap-1 text-2xs font-semibold', status.className)}>
                  {approval.status === 'pending' ? <Hourglass className="size-3" /> : approval.status === 'approved' ? <BadgeCheck className="size-3" /> : <X className="size-3" />}
                  {status.label}
                </span>
              </div>
              {approval.note && <p className="mt-1 text-xs text-muted">{approval.note}</p>}
              <p className="mt-1 text-2xs text-subtle">
                {approval.mode === 'all' ? 'Everyone of' : 'Any one of'}:{' '}
                {approval.approverIds.map((id, index) => {
                  const decision = approval.decisions.find((d) => d.userId === id);
                  return (
                    <span key={id} className={cn(decision?.decision === 'approved' && 'text-[var(--status-resolved)]', decision?.decision === 'rejected' && 'text-[var(--priority-urgent)]')}>
                      {index > 0 && ', '}
                      {approval.approverNames[index]}
                      {decision ? (decision.decision === 'approved' ? ' ✓' : ' ✗') : ''}
                    </span>
                  );
                })}
              </p>
              {approval.decisions
                .filter((decision) => decision.comment)
                .map((decision) => (
                  <p key={decision.userId} className="mt-1 text-2xs text-muted">
                    <b className="font-medium">{decision.name}</b>: {decision.comment}
                  </p>
                ))}
              <p className="mt-1 text-2xs text-subtle">
                {approval.ruleId ? 'By rule' : `Asked by ${approval.requestedByName ?? 'someone'}`} · {relativeTime(approval.createdAt)}
              </p>

              {mine && (
                <div className="mt-2 space-y-1.5">
                  <Textarea rows={2} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Comment (optional)" />
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="primary" loading={busy === approval.id} onClick={() => void decide(approval, 'approved')}>
                      <Check className="size-3.5" /> Approve
                    </Button>
                    <Button size="sm" variant="danger" disabled={busy === approval.id} onClick={() => void decide(approval, 'rejected')}>
                      Reject
                    </Button>
                  </div>
                </div>
              )}
              {mayWithdraw && (
                <button onClick={() => void withdraw(approval)} className="mt-1.5 text-2xs text-subtle hover:text-[var(--fg)] hover:underline">
                  Withdraw request
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {asking && (
        <RequestForm
          ticketId={ticketId}
          teamId={teamId}
          directory={directory}
          onCancel={() => setAsking(false)}
          onDone={() => {
            setAsking(false);
            void load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function RequestForm({
  ticketId,
  teamId,
  directory,
  onCancel,
  onDone,
}: {
  ticketId: string;
  teamId: string | null;
  directory: Directory;
  onCancel: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const { user } = useAuth();
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [mode, setMode] = useState<ApprovalMode>('any');
  const [onReject, setOnReject] = useState<'close' | 'keep_open'>('close');
  const [saving, setSaving] = useState(false);

  const people = directory
    .filter((person) => person.id !== user?.id)
    .filter((person) => !search || `${person.name} ${person.email} ${person.jobTitle ?? ''}`.toLowerCase().includes(search.toLowerCase()))
    // The department's own people first.
    .sort((a, b) => Number(Boolean(teamId && b.teamIds.includes(teamId))) - Number(Boolean(teamId && a.teamIds.includes(teamId))))
    .slice(0, 30);

  const submit = async () => {
    setSaving(true);
    try {
      await api.approvals.request(ticketId, { title, note: note || null, approverIds: chosen, mode, onReject });
      toast.success('Approval requested', 'The approvers have been told.');
      onDone();
    } catch (caught) {
      toast.error('Could not request approval', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 space-y-2 rounded-sm border p-2.5 surface-2">
      <Field label="What needs approving">
        <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Campaign artwork sign-off" />
      </Field>
      <Field label="Approvers">
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search people" />
        <ul className="mt-1 max-h-40 space-y-px overflow-y-auto">
          {people.map((person) => (
            <li key={person.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-xs px-1 py-0.5 text-xs hover:bg-[var(--surface)]">
                <input
                  type="checkbox"
                  checked={chosen.includes(person.id)}
                  onChange={() => setChosen((all) => (all.includes(person.id) ? all.filter((id) => id !== person.id) : [...all, person.id]))}
                />
                <span className="truncate">{person.name}</span>
                {person.jobTitle && <span className="truncate text-2xs text-subtle">{person.jobTitle}</span>}
              </label>
            </li>
          ))}
        </ul>
      </Field>
      {chosen.length > 1 && (
        <SegmentedControl
          value={mode}
          onChange={setMode}
          options={[
            { value: 'any', label: 'Any one approves' },
            { value: 'all', label: 'Everyone approves' },
          ]}
        />
      )}
      <Field label="Note for the approvers">
        <Textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
      </Field>
      <SegmentedControl
        value={onReject}
        onChange={setOnReject}
        options={[
          { value: 'close', label: 'Rejected: close it' },
          { value: 'keep_open', label: 'Rejected: keep open' },
        ]}
      />
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" loading={saving} disabled={!title.trim() || !chosen.length} onClick={() => void submit()}>
          Request
        </Button>
      </div>
    </div>
  );
}
