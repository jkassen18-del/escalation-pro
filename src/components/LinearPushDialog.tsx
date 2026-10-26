import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';

/**
 * Pushes a ticket to Linear, asking which Linear team. The department's own
 * team is preselected, so the usual case is one click; picking another is for
 * the ticket that belongs somewhere else.
 */
export function LinearPushDialog({
  open,
  ticketId,
  teamName,
  onClose,
  onPushed,
}: {
  open: boolean;
  ticketId: string;
  teamName: string | null;
  onClose: () => void;
  onPushed: () => Promise<void>;
}) {
  const [teams, setTeams] = useState<Array<{ id: string; key: string; name: string }> | null>(null);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [choice, setChoice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTeams(null);
    setError(null);
    void api.tickets
      .linearTargets(ticketId)
      .then((result) => {
        if (cancelled) return;
        setTeams(result.teams);
        setSuggested(result.suggested);
        setChoice(result.suggested ?? '');
      })
      .catch((caught) => !cancelled && setError(caught instanceof ApiError ? caught.message : 'Could not reach Linear.'));
    return () => {
      cancelled = true;
    };
  }, [open, ticketId]);

  const push = async () => {
    setPushing(true);
    setError(null);
    try {
      await api.tickets.pushToLinear(ticketId, choice);
      await onPushed();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Linear declined to create the issue.');
    } finally {
      setPushing(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create Linear issue"
      description="The issue links back to this ticket, and replies in Linear come back as comments."
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" loading={pushing} disabled={!choice} onClick={() => void push()}>
            Create issue
          </Button>
        </>
      }
    >
      {teams === null && !error ? (
        <p className="text-xs text-subtle">Loading Linear teams…</p>
      ) : (
        <Field
          label="Linear team"
          hint={
            suggested
              ? choice === suggested
                ? `${teamName ?? 'This department'}'s Linear team.`
                : `Not ${teamName ?? 'this department'}'s usual Linear team.`
              : `${teamName ?? 'This department'} has no Linear team yet; set one under Integrations → Linear.`
          }
        >
          <Select value={choice} onChange={(event) => setChoice(event.target.value)} disabled={!teams?.length}>
            <option value="">Choose a team…</option>
            {(teams ?? []).map((team) => (
              <option key={team.id} value={team.id}>
                {team.name} ({team.key})
              </option>
            ))}
          </Select>
        </Field>
      )}
      {error && <p className="mt-2 text-xs text-[var(--priority-urgent)]">{error}</p>}
    </Modal>
  );
}
