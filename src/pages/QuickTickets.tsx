import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, MoreHorizontal, Plus, Trash2, Zap } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { templatesApi, type TemplateInput } from '@/lib/templates-api';
import { PRIORITY_LABELS, TYPE_LABELS } from '@/lib/format';
import { useToast } from '@/components/ui/Toast';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Checkbox, Field, Input, SegmentedControl, Select, Textarea } from '@/components/ui/Field';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Menu } from '@/components/ui/Menu';
import { TemplateBadge, TemplateIcon } from '@/components/quick/TemplateIcon';
import { useDocumentTitle } from '@/state/branding';
import { FORM_FIELD_TYPES, TICKET_PRIORITIES, TICKET_TYPES, type FormFieldType, type Team } from '@shared/types';
import { SEVERITIES, SEVERITY_LABELS } from '@shared/ops';
import { TEMPLATE_ICONS, type ScreenshotMode, type TicketTemplate } from '@shared/templates';

const QUESTION_TYPES: Array<{ value: FormFieldType; label: string }> = [
  { value: 'text', label: 'Single line' },
  { value: 'textarea', label: 'Paragraph' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Choose one' },
  { value: 'multiselect', label: 'Choose several' },
  { value: 'checkbox', label: 'Tick box' },
  { value: 'email', label: 'Email address' },
  { value: 'url', label: 'Web address' },
];
const NEEDS_OPTIONS = new Set<FormFieldType>(['select', 'multiselect']);
const COLORS = ['#b54708', '#c4320a', '#4d6b8a', '#2563eb', '#6b5c8a', '#0e7490', '#6b7f5c', '#9a7b2f', '#6b7280'];

/** Starting points, so the first quick ticket takes seconds rather than a blank form. */
const STARTERS: Array<Partial<TemplateInput> & { name: string }> = [
  {
    name: 'Site issue',
    icon: 'globe',
    color: '#c4320a',
    ticketType: 'incident',
    priority: 'high',
    severity: 'sev2',
    subjectTemplate: 'Site issue: {{site}} - {{summary}}',
    guidance: 'Say which site, what stopped working and roughly when. A screenshot of any error helps.',
    screenshot: 'encouraged',
    fields: [{ label: 'Site', type: 'text', required: true }, { label: 'People affected', type: 'number' }],
  },
  {
    name: 'Password reset',
    icon: 'key',
    color: '#4d6b8a',
    ticketType: 'request',
    priority: 'normal',
    subjectTemplate: 'Password reset: {{system}}',
    screenshot: 'off',
    fields: [{ label: 'System', type: 'select', required: true, options: ['Windows / Microsoft 365', 'VPN', 'Other'] }],
  },
  {
    name: 'New laptop',
    icon: 'laptop',
    color: '#6b5c8a',
    ticketType: 'request',
    priority: 'low',
    subjectTemplate: 'New laptop for {{for_whom}}',
    screenshot: 'off',
    fields: [
      { label: 'For whom', type: 'text', required: true },
      { label: 'Needed by', type: 'date' },
    ],
  },
];

function blankInput(teamId: string): TemplateInput {
  return {
    name: '',
    description: null,
    icon: 'ticket',
    color: COLORS[0],
    teamId,
    ticketType: 'request',
    priority: 'normal',
    severity: null,
    subjectTemplate: '{{name}}: {{summary}}',
    guidance: null,
    fields: [],
    screenshot: 'encouraged',
    tags: [],
    audienceTeamIds: [],
    enabled: true,
  };
}

function toInput(template: TicketTemplate): TemplateInput {
  const { id: _id, teamName: _teamName, position: _position, createdAt: _c, updatedAt: _u, ...rest } = template;
  return rest;
}

export function QuickTicketsPage() {
  useDocumentTitle('Quick tickets');
  const toast = useToast();
  const [templates, setTemplates] = useState<TicketTemplate[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; input: TemplateInput } | null>(null);
  const [deleting, setDeleting] = useState<TicketTemplate | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [templateResult, teamResult] = await Promise.all([templatesApi.all(), api.teams.list()]);
      setTemplates(templateResult.templates);
      setTeams(teamResult.teams);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load quick tickets.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startNew = (starter?: (typeof STARTERS)[number]) =>
    setEditing({ id: null, input: { ...blankInput(teams[0]?.id ?? ''), ...starter } as TemplateInput });

  return (
    <div>
      <PageHeader
        title="Quick tickets"
        description="Templated tickets for common requests. People pick one, add the details and a screenshot, and it goes straight to the right department."
        actions={
          <Button variant="primary" size="sm" onClick={() => startNew()} disabled={!teams.length}>
            <Plus className="size-3.5" />
            New quick ticket
          </Button>
        }
      />

      <div className="px-4 py-4 sm:px-6">
        {loading ? (
          <LoadingPane />
        ) : error ? (
          <ErrorPane message={error} retry={load} />
        ) : templates.length === 0 ? (
          <div className="space-y-4">
            <EmptyState icon={Zap} title="No quick tickets yet" description="Start from one of these, or create your own." />
            <div className="mx-auto grid max-w-2xl gap-2 sm:grid-cols-3">
              {STARTERS.map((starter) => (
                <button
                  key={starter.name}
                  onClick={() => startNew(starter)}
                  className="flex items-center gap-2 rounded-md border p-3 text-left surface hover:bg-[var(--surface-2)]"
                >
                  <TemplateBadge name={starter.icon ?? 'ticket'} color={starter.color ?? COLORS[0]} size="sm" />
                  <span className="text-xs font-medium">{starter.name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ul className="divide-y rounded-md border surface">
            {templates.map((template) => (
              <li key={template.id} className="flex items-center gap-3 px-4 py-3">
                <TemplateBadge name={template.icon} color={template.color} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-xs font-medium">
                    {template.name}
                    {!template.enabled && <Badge dot={false}>Off</Badge>}
                    {template.audienceTeamIds.length > 0 && <Badge dot={false}>Some teams only</Badge>}
                  </p>
                  <p className="truncate text-2xs text-subtle">
                    → {template.teamName ?? 'No department (deleted)'} · {TYPE_LABELS[template.ticketType]} · {PRIORITY_LABELS[template.priority]}
                    {template.fields.length ? ` · ${template.fields.length} question${template.fields.length === 1 ? '' : 's'}` : ''}
                    {template.screenshot === 'required' ? ' · screenshot required' : ''}
                  </p>
                </div>
                <Menu
                  trigger={({ toggle }) => (
                    <Button variant="ghost" size="icon" onClick={toggle} aria-label={`Actions for ${template.name}`}>
                      <MoreHorizontal className="size-4" />
                    </Button>
                  )}
                  items={[
                    { label: 'Edit', onSelect: () => setEditing({ id: template.id, input: toInput(template) }) },
                    {
                      label: 'Duplicate',
                      onSelect: () => setEditing({ id: null, input: { ...toInput(template), name: `${template.name} (copy)`, fields: template.fields.map(({ id: _id, key: _key, ...field }) => field) } }),
                    },
                    { label: 'Delete', icon: Trash2, destructive: true, onSelect: () => setDeleting(template) },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {editing && (
        <TemplateEditor
          key={editing.id ?? 'new'}
          initial={editing.input}
          isNew={!editing.id}
          teams={teams}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            try {
              if (editing.id) await templatesApi.update(editing.id, input);
              else await templatesApi.create(input);
              toast.success(`${input.name} saved.`);
              setEditing(null);
              await load();
            } catch (caught) {
              toast.error('Could not save the quick ticket', caught instanceof ApiError ? caught.message : undefined);
            }
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title={`Delete "${deleting?.name}"?`}
        message="People will no longer see it. Tickets already raised from it are kept."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          await templatesApi.remove(deleting.id);
          setDeleting(null);
          await load();
        }}
      />
    </div>
  );
}

type DraftQuestion = TemplateInput['fields'][number] & { optionsText?: string };

function TemplateEditor({
  initial,
  isNew,
  teams,
  onClose,
  onSave,
}: {
  initial: TemplateInput;
  isNew: boolean;
  teams: Team[];
  onClose: () => void;
  onSave: (input: TemplateInput) => Promise<void>;
}) {
  const [input, setInput] = useState<TemplateInput>(initial);
  const [questions, setQuestions] = useState<DraftQuestion[]>(initial.fields.map((field) => ({ ...field, optionsText: (field.options ?? []).join(', ') })));
  const [tagsText, setTagsText] = useState(initial.tags.join(', '));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof TemplateInput>(key: K, value: TemplateInput[K]) => setInput((current) => ({ ...current, [key]: value }));
  const updateQuestion = (index: number, patch: Partial<DraftQuestion>) =>
    setQuestions((current) => current.map((question, i) => (i === index ? { ...question, ...patch } : question)));
  const move = (index: number, delta: number) =>
    setQuestions((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const placeholders = ['summary', 'requester', ...questions.filter((q) => q.key).map((q) => q.key!)];

  const save = async () => {
    setSaving(true);
    await onSave({
      ...input,
      tags: tagsText.split(',').map((tag) => tag.trim()).filter(Boolean),
      fields: questions.map(({ optionsText, ...question }) => ({
        ...question,
        options: NEEDS_OPTIONS.has(question.type) ? (optionsText ?? '').split(',').map((option) => option.trim()).filter(Boolean) : [],
      })),
    });
    setSaving(false);
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={isNew ? 'New quick ticket' : `Edit ${initial.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!input.name.trim() || !input.teamId} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required>
            <Input value={input.name} onChange={(event) => set('name', event.target.value)} placeholder="Site issue" maxLength={80} />
          </Field>
          <Field label="Goes to" required hint="The department that receives these tickets.">
            <Select value={input.teamId ?? ''} onChange={(event) => set('teamId', event.target.value)}>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Short description" hint="Shown on the tile.">
          <Input value={input.description ?? ''} onChange={(event) => set('description', event.target.value || null)} maxLength={300} />
        </Field>

        <Field label="Icon and colour">
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {TEMPLATE_ICONS.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  aria-label={icon}
                  aria-pressed={input.icon === icon}
                  onClick={() => set('icon', icon)}
                  className={`rounded-sm border p-1.5 ${input.icon === icon ? 'border-[var(--accent)] bg-[var(--surface-3)]' : 'border-transparent hover:bg-[var(--surface-2)]'}`}
                >
                  <TemplateIcon name={icon} className="size-4" />
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`Colour ${color}`}
                  aria-pressed={input.color === color}
                  onClick={() => set('color', color)}
                  className={`size-6 rounded-full border-2 ${input.color === color ? 'border-[var(--fg)]' : 'border-transparent'}`}
                  style={{ background: color }}
                />
              ))}
            </div>
          </div>
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Type">
            <Select value={input.ticketType} onChange={(event) => set('ticketType', event.target.value as TemplateInput['ticketType'])}>
              {TICKET_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={input.priority} onChange={(event) => set('priority', event.target.value as TemplateInput['priority'])}>
              {TICKET_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {PRIORITY_LABELS[priority]}
                </option>
              ))}
            </Select>
          </Field>
          {input.ticketType === 'incident' && (
            <Field label="Severity">
              <Select value={input.severity ?? ''} onChange={(event) => set('severity', (event.target.value || null) as TemplateInput['severity'])}>
                <option value="">None</option>
                {SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {SEVERITY_LABELS[severity]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        <Field label="Ticket title" hint={`Fill-ins: ${placeholders.map((p) => `{{${p}}}`).join(' ')}. Save once to get keys for new questions.`}>
          <Input value={input.subjectTemplate} onChange={(event) => set('subjectTemplate', event.target.value)} className="font-mono text-xs" maxLength={200} />
        </Field>

        <Field label="Guidance" hint="Shown at the top of the form: what to include, what happens next.">
          <Textarea value={input.guidance ?? ''} onChange={(event) => set('guidance', event.target.value || null)} rows={2} />
        </Field>

        <div className="space-y-2">
          <p className="text-xs font-medium">Questions</p>
          {questions.length === 0 && <p className="text-2xs text-subtle">None. People only add the details and a screenshot.</p>}
          <ol className="space-y-2">
            {questions.map((question, index) => (
              <li key={question.id ?? `new-${index}`} className="flex items-start gap-2 rounded-sm border p-2.5 surface-2">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                    <Input value={question.label} placeholder="Question, e.g. Site" aria-label={`Question ${index + 1}`} onChange={(event) => updateQuestion(index, { label: event.target.value })} />
                    <Select value={question.type} aria-label={`Question ${index + 1} type`} onChange={(event) => updateQuestion(index, { type: event.target.value as FormFieldType })}>
                      {QUESTION_TYPES.filter((type) => FORM_FIELD_TYPES.includes(type.value)).map((type) => (
                        <option key={type.value} value={type.value}>
                          {type.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {NEEDS_OPTIONS.has(question.type) && (
                    <Input value={question.optionsText ?? ''} placeholder="Options, comma separated" aria-label={`Question ${index + 1} options`} onChange={(event) => updateQuestion(index, { optionsText: event.target.value })} />
                  )}
                  <div className="flex flex-wrap items-center gap-3">
                    <Checkbox checked={Boolean(question.required)} label="Required" onChange={(event) => updateQuestion(index, { required: event.target.checked })} />
                    {question.key && <span className="font-mono text-2xs text-subtle">{`{{${question.key}}}`}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col gap-0.5">
                  <button type="button" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)} className="rounded-[3px] p-1 text-[var(--fg-muted)] hover:bg-[var(--surface-3)] disabled:opacity-40">
                    <ChevronUp className="size-3.5" />
                  </button>
                  <button type="button" aria-label="Move down" disabled={index === questions.length - 1} onClick={() => move(index, 1)} className="rounded-[3px] p-1 text-[var(--fg-muted)] hover:bg-[var(--surface-3)] disabled:opacity-40">
                    <ChevronDown className="size-3.5" />
                  </button>
                  <button type="button" aria-label="Remove question" onClick={() => setQuestions((current) => current.filter((_, i) => i !== index))} className="rounded-[3px] p-1 text-[var(--fg-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--priority-urgent)]">
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ol>
          <Button size="sm" onClick={() => setQuestions((current) => [...current, { label: '', type: 'text', required: false }])} disabled={questions.length >= 20}>
            <Plus className="size-3.5" />
            Add question
          </Button>
        </div>

        <Field label="Screenshot">
          <SegmentedControl<ScreenshotMode>
            value={input.screenshot}
            onChange={(value) => set('screenshot', value)}
            options={[
              { value: 'off', label: 'Not asked' },
              { value: 'encouraged', label: 'Optional' },
              { value: 'required', label: 'Required' },
            ]}
          />
        </Field>

        <Field label="Who can use it" hint="Leave all unticked for everyone who can raise tickets.">
          <div className="grid gap-1.5 sm:grid-cols-2">
            {teams.map((team) => (
              <Checkbox
                key={team.id}
                label={team.name}
                checked={input.audienceTeamIds.includes(team.id)}
                onChange={(event) =>
                  set('audienceTeamIds', event.target.checked ? [...input.audienceTeamIds, team.id] : input.audienceTeamIds.filter((id) => id !== team.id))
                }
              />
            ))}
          </div>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tags" hint="Comma separated, added to every ticket.">
            <Input value={tagsText} onChange={(event) => setTagsText(event.target.value)} />
          </Field>
          <Field label="Status">
            <Checkbox checked={input.enabled} label="Available to people" onChange={(event) => set('enabled', event.target.checked)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
