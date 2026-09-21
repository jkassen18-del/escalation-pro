import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Checkbox, Input, Select } from '@/components/ui/Field';
import { FORM_FIELD_TYPES, type FormFieldType, type TeamFormField } from '@shared/types';

/**
 * Editor for a department's intake form.
 *
 * The whole form is submitted at once and the server diffs it, so a field
 * that is only moved or relabelled keeps its identity - and therefore every
 * answer already recorded against it.
 */

const TYPE_LABELS: Record<FormFieldType, string> = {
  text: 'Single line',
  textarea: 'Paragraph',
  number: 'Number',
  date: 'Date',
  select: 'Choose one',
  multiselect: 'Choose several',
  checkbox: 'Tick box',
  email: 'Email address',
  url: 'Web address',
  lookup: 'Database lookup',
};

const NEEDS_OPTIONS = new Set<FormFieldType>(['select', 'multiselect']);

/** A field being edited; `id` is absent until the server has stored it. */
interface DraftField extends Omit<TeamFormField, 'id' | 'teamId' | 'key' | 'position'> {
  id?: string;
  key?: string;
  /** Edited as one line, split on save. */
  optionsText: string;
}

function toDraft(field: TeamFormField): DraftField {
  return { ...field, optionsText: field.options.join(', ') };
}

function blankDraft(): DraftField {
  return {
    label: '',
    type: 'text',
    required: false,
    helpText: null,
    placeholder: null,
    options: [],
    optionsText: '',
    dataSourceId: null,
  };
}

export function FormBuilder({
  teamId,
  teamName,
  dataSources,
}: {
  teamId: string;
  teamName: string;
  dataSources?: Array<{ id: string; name: string }>;
}) {
  const toast = useToast();
  const [drafts, setDrafts] = useState<DraftField[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDrafts(null);
    void api.teams
      .form(teamId)
      .then((result) => {
        if (!cancelled) setDrafts(result.fields.map(toDraft));
      })
      .catch(() => {
        if (!cancelled) toast.error('Could not load this form.');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  const update = (index: number, patch: Partial<DraftField>) =>
    setDrafts((current) => current?.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)) ?? current);

  const move = (index: number, delta: number) =>
    setDrafts((current) => {
      if (!current) return current;
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const save = async () => {
    if (!drafts) return;
    setSaving(true);
    try {
      const payload = drafts.map((draft) => ({
        id: draft.id,
        label: draft.label.trim(),
        type: draft.type,
        required: draft.required,
        helpText: draft.helpText,
        placeholder: draft.placeholder,
        options: NEEDS_OPTIONS.has(draft.type)
          ? draft.optionsText.split(',').map((option) => option.trim()).filter(Boolean)
          : [],
        dataSourceId: draft.type === 'lookup' ? draft.dataSourceId : null,
      }));
      const result = await api.teams.saveForm(teamId, payload);
      setDrafts(result.fields.map(toDraft));
      toast.success(`Form saved for ${teamName}.`);
    } catch (error) {
      toast.error('Could not save the form', error instanceof ApiError ? error.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  if (!drafts) return <p className="p-4 text-xs text-subtle">Loading form…</p>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-subtle">
        Questions asked when someone raises a ticket for {teamName}, in addition to the standard fields.
      </p>

      {drafts.length === 0 && (
        <p className="rounded-sm border border-dashed px-3 py-4 text-center text-xs text-subtle">
          No extra questions yet. This team uses the standard ticket fields only.
        </p>
      )}

      <ol className="space-y-2">
        {drafts.map((draft, index) => (
          <li key={draft.id ?? `new-${index}`} className="rounded-sm border p-3 surface-2">
            <div className="flex items-start gap-2">
              <GripVertical className="mt-2 size-3.5 shrink-0 text-[var(--fg-subtle)]" aria-hidden />

              <div className="min-w-0 flex-1 space-y-2">
                <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                  <Input
                    value={draft.label}
                    placeholder="Question, e.g. Order reference"
                    aria-label={`Field ${index + 1} label`}
                    onChange={(event) => update(index, { label: event.target.value })}
                  />
                  <Select
                    value={draft.type}
                    aria-label={`Field ${index + 1} type`}
                    onChange={(event) => update(index, { type: event.target.value as FormFieldType })}
                  >
                    {FORM_FIELD_TYPES.filter((type) => type !== 'lookup' || (dataSources?.length ?? 0) > 0).map(
                      (type) => (
                        <option key={type} value={type}>
                          {TYPE_LABELS[type]}
                        </option>
                      ),
                    )}
                  </Select>
                </div>

                {NEEDS_OPTIONS.has(draft.type) && (
                  <Input
                    value={draft.optionsText}
                    placeholder="Options, comma separated: Low, Medium, High"
                    aria-label={`Field ${index + 1} options`}
                    onChange={(event) => update(index, { optionsText: event.target.value })}
                  />
                )}

                {draft.type === 'lookup' && (
                  <Select
                    value={draft.dataSourceId ?? ''}
                    aria-label={`Field ${index + 1} data source`}
                    onChange={(event) => update(index, { dataSourceId: event.target.value || null })}
                  >
                    <option value="">Choose a connected database…</option>
                    {dataSources?.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}
                      </option>
                    ))}
                  </Select>
                )}

                <Input
                  value={draft.helpText ?? ''}
                  placeholder="Help text shown under the field (optional)"
                  aria-label={`Field ${index + 1} help text`}
                  onChange={(event) => update(index, { helpText: event.target.value || null })}
                />

                <Checkbox
                  checked={draft.required}
                  label="Required"
                  onChange={(event) => update(index, { required: event.target.checked })}
                />
              </div>

              <div className="flex shrink-0 flex-col gap-0.5">
                <button
                  type="button"
                  aria-label="Move up"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  className="rounded-[3px] p-1 text-[var(--fg-muted)] hover:bg-[var(--surface-3)] disabled:opacity-40"
                >
                  <ChevronUp className="size-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  disabled={index === drafts.length - 1}
                  onClick={() => move(index, 1)}
                  className="rounded-[3px] p-1 text-[var(--fg-muted)] hover:bg-[var(--surface-3)] disabled:opacity-40"
                >
                  <ChevronDown className="size-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${draft.label || 'field'}`}
                  onClick={() => setDrafts((current) => current?.filter((_, i) => i !== index) ?? current)}
                  className="rounded-[3px] p-1 text-[var(--fg-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--priority-urgent)]"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </div>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setDrafts((current) => [...(current ?? []), blankDraft()])}>
          <Plus className="size-3.5" aria-hidden />
          Add question
        </Button>
        <Button size="sm" variant="primary" loading={saving} onClick={save}>
          Save form
        </Button>
      </div>
    </div>
  );
}
