import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';

const KINDS = {
  linear: {
    title: 'Create Linear issue',
    description: 'The issue links back to this ticket, and replies in Linear come back as comments.',
    field: 'Linear team',
    noun: 'Linear team',
    where: 'Integrations → Linear',
    load: async (id: string) => {
      const result = await api.tickets.linearTargets(id);
      return { options: result.teams.map((team) => ({ id: team.id, name: `${team.name} (${team.key})` })), suggested: result.suggested };
    },
    push: (id: string, target: string) => api.tickets.pushToLinear(id, target),
  },
  github: {
    title: 'Create GitHub issue',
    description: 'The issue links back to this ticket. Comments there come back here, and closing it resolves the ticket.',
    field: 'Repository',
    noun: 'repository',
    where: 'Integrations → GitHub',
    load: async (id: string) => {
      const result = await api.tickets.githubTargets(id);
      return { options: result.repos, suggested: result.suggested };
    },
    push: (id: string, target: string) => api.tickets.pushToGitHub(id, target),
  },
} as const;

/**
 * Pushes a ticket to Linear or GitHub, asking where. The department's own team
 * or repository is preselected, so the usual case is one click; picking another
 * is for the ticket that belongs somewhere else.
 */
export function LinearPushDialog({
  open,
  ticketId,
  teamName,
  onClose,
  onPushed,
  kind = 'linear',
}: {
  open: boolean;
  ticketId: string;
  teamName: string | null;
  onClose: () => void;
  onPushed: () => Promise<void>;
  kind?: keyof typeof KINDS;
}) {
  const meta = KINDS[kind];
  const [teams, setTeams] = useState<Array<{ id: string; name: string }> | null>(null);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [choice, setChoice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTeams(null);
    setError(null);
    void meta
      .load(ticketId)
      .then((result) => {
        if (cancelled) return;
        setTeams(result.options);
        setSuggested(result.suggested);
        setChoice(result.suggested ?? '');
      })
      .catch((caught) => !cancelled && setError(caught instanceof ApiError ? caught.message : 'Could not reach the service.'));
    return () => {
      cancelled = true;
    };
  }, [open, ticketId, meta]);

  const push = async () => {
    setPushing(true);
    setError(null);
    try {
      await meta.push(ticketId, choice);
      await onPushed();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The issue could not be created.');
    } finally {
      setPushing(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={meta.title}
      description={meta.description}
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
        <p className="text-xs text-subtle">Loading…</p>
      ) : (
        <Field
          label={meta.field}
          hint={
            suggested
              ? choice === suggested
                ? `${teamName ?? 'This department'}'s ${meta.noun}.`
                : `Not ${teamName ?? 'this department'}'s usual ${meta.noun}.`
              : `${teamName ?? 'This department'} has no ${meta.noun} yet; set one under ${meta.where}.`
          }
        >
          <Select value={choice} onChange={(event) => setChoice(event.target.value)} disabled={!teams?.length}>
            <option value="">Choose…</option>
            {(teams ?? []).map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {error && <p className="mt-2 text-xs text-[var(--priority-urgent)]">{error}</p>}
    </Modal>
  );
}
