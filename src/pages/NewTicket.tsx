import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { PRIORITY_LABELS, TYPE_LABELS } from '@/lib/format';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { RichTextEditor } from '@/components/ui/RichTextEditor';
import { TICKET_PRIORITIES, TICKET_TYPES, type Team } from '@shared/types';
import { useDocumentTitle } from '@/state/branding';

export function NewTicketPage() {
  useDocumentTitle('New ticket');
  const navigate = useNavigate();
  const toast = useToast();

  const [teams, setTeams] = useState<Team[]>([]);
  const [directory, setDirectory] = useState<Awaited<ReturnType<typeof api.users.directory>>['users']>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [form, setForm] = useState({
    subject: '',
    description: '',
    teamId: '',
    assigneeId: '',
    priority: 'normal',
    type: 'request',
    tags: '',
  });

  useEffect(() => {
    void Promise.all([api.teams.list(), api.users.directory(), api.settings.get()])
      .then(([teamResult, directoryResult, settingsResult]) => {
        setTeams(teamResult.teams);
        setDirectory(directoryResult.users);
        // Pre-select the organisation default so the common path is one click.
        setForm((current) => ({
          ...current,
          teamId: current.teamId || (settingsResult.settings.defaultTeamId ?? ''),
          priority: settingsResult.settings.defaultPriority,
        }));
      })
      .catch(() => undefined);
  }, []);

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const selectedTeam = teams.find((team) => team.id === form.teamId);
  const assignable = form.teamId
    ? directory.filter((person) => person.teamIds.includes(form.teamId) && person.role !== 'viewer')
    : [];

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setErrors({});
    setSubmitting(true);
    try {
      const { ticket } = await api.tickets.create({
        subject: form.subject,
        description: form.description,
        // The editor always produces HTML; the server decides what to store.
        descriptionFormat: 'html',
        teamId: form.teamId || null,
        assigneeId: form.assigneeId || null,
        priority: form.priority,
        type: form.type,
        tags: form.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      toast.success(`${ticket.reference} created.`);
      navigate(`/tickets/${ticket.id}`);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setErrors(caught.details ?? {});
        toast.error('Could not create the ticket', caught.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <button
        onClick={() => navigate(-1)}
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-[var(--fg)]"
      >
        <ChevronLeft className="size-3.5" />
        Back
      </button>

      <h1 className="text-lg font-semibold tracking-tight">New ticket</h1>
      <p className="mt-0.5 text-xs text-muted">
        The routing rules on the selected team decide who picks this up if you leave the assignee blank.
      </p>

      <form onSubmit={onSubmit} className="mt-5 space-y-4 rounded-md border p-4 surface sm:p-5">
        <Field label="Subject" htmlFor="subject" error={errors.Subject} required>
          <Input
            id="subject"
            value={form.subject}
            onChange={set('subject')}
            placeholder="Checkout returns 502 for EU customers"
            maxLength={200}
            autoFocus
            required
          />
        </Field>

        <Field
          label="Description"
          hint="What happened, who is affected, and anything already tried. Paste screenshots straight in."
        >
          <RichTextEditor
            value={form.description}
            onChange={(html) => setForm((current) => ({ ...current, description: html }))}
            onError={(message) => toast.error(message)}
            minHeight={150}
            ariaLabel="Description"
            placeholder="Customers in the EU region see a 502 at the payment step, starting around 09:40 UTC…"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Team" htmlFor="teamId" hint={selectedTeam?.description ?? undefined}>
            <Select id="teamId" value={form.teamId} onChange={set('teamId')}>
              <option value="">No team</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Assignee"
            htmlFor="assigneeId"
            hint={
              selectedTeam && selectedTeam.autoAssign !== 'none'
                ? `Leave blank to auto-assign (${selectedTeam.autoAssign.replace('_', ' ')}).`
                : 'Optional.'
            }
          >
            <Select id="assigneeId" value={form.assigneeId} onChange={set('assigneeId')} disabled={!form.teamId}>
              <option value="">{form.teamId ? 'Auto / unassigned' : 'Select a team first'}</option>
              {assignable.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Priority" htmlFor="priority" hint="Urgent and high shorten the SLA clock.">
            <Select id="priority" value={form.priority} onChange={set('priority')}>
              {TICKET_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {PRIORITY_LABELS[priority]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Type" htmlFor="type">
            <Select id="type" value={form.type} onChange={set('type')}>
              {TICKET_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Tags" htmlFor="tags" hint="Comma separated, e.g. payments, eu">
          <Input id="tags" value={form.tags} onChange={set('tags')} placeholder="payments, eu" />
        </Field>

        <div className="flex justify-end gap-2 border-t pt-4">
          <Button variant="ghost" type="button" onClick={() => navigate(-1)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={submitting} disabled={!form.subject.trim()}>
            Create ticket
          </Button>
        </div>
      </form>
    </div>
  );
}
