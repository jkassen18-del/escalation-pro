import { useEffect, useState } from 'react';
import { PRIORITY_LABELS } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Field, SegmentedControl, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { TICKET_PRIORITIES, type Team, type TicketPriority } from '@shared/types';

export interface EscalateRequest {
  reason: string;
  /** Set to hand the ticket to another department. */
  teamId?: string;
  priority?: TicketPriority;
}

/**
 * Escalating a ticket: either up a level within its department, or across
 * to another department that should own it.
 */
export function EscalateDialog({
  open,
  onClose,
  onSubmit,
  teams,
  currentTeamId,
  currentPriority,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (request: EscalateRequest) => Promise<void>;
  teams: Team[];
  currentTeamId: string | null;
  currentPriority: TicketPriority;
}) {
  const others = teams.filter((team) => team.id !== currentTeamId);
  const [mode, setMode] = useState<'level' | 'department'>('level');
  const [teamId, setTeamId] = useState('');
  const [priority, setPriority] = useState<TicketPriority>(currentPriority);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setPriority(currentPriority);
  }, [open, currentPriority]);

  const toDepartment = mode === 'department';
  const target = others.find((team) => team.id === teamId);
  const ready = reason.trim() && (!toDepartment || teamId);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Escalate this ticket"
      description={
        toDepartment
          ? 'Hands the ticket to another department, raises the escalation level, and lets that department know in the app and its channels.'
          : 'Raises the escalation level, bumps the priority, and alerts every connected channel.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={submitting}
            disabled={!ready}
            onClick={async () => {
              setSubmitting(true);
              await onSubmit(toDepartment ? { reason: reason.trim(), teamId, priority } : { reason: reason.trim() });
              setSubmitting(false);
              setReason('');
              setTeamId('');
              setMode('level');
            }}
          >
            {toDepartment && target ? `Escalate to ${target.name}` : 'Escalate'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {others.length > 0 && (
          <SegmentedControl
            value={mode}
            onChange={setMode}
            options={[
              { value: 'level', label: 'Raise the level' },
              { value: 'department', label: 'Send to another department' },
            ]}
          />
        )}

        {toDepartment && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Department" required hint="Its auto-assignment picks an owner if the current one is not in it.">
              <Select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
                <option value="">Choose…</option>
                {others.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priority">
              <Select value={priority} onChange={(event) => setPriority(event.target.value as TicketPriority)}>
                {TICKET_PRIORITIES.map((value) => (
                  <option key={value} value={value}>
                    {PRIORITY_LABELS[value]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}

        <Field label="Why is this being escalated?" hint="Recorded as an internal note on the ticket." required>
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={4}
            placeholder={
              toDepartment
                ? 'The laptop is fine; the VPN drops at the firewall. Network needs to look at the tunnel logs.'
                : 'Customer impact is growing and the current owner needs support from the on-call engineer.'
            }
          />
        </Field>
      </div>
    </Modal>
  );
}
