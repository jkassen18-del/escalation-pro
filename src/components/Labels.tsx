import { useEffect, useState } from 'react';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import type { TicketLabel } from '@shared/types';

/** A palette that reads in both themes; the swatch row offers these first. */
export const LABEL_COLORS = ['#2f80ed', '#0e9f9a', '#3f9d4e', '#c9a04b', '#e07b28', '#d64545', '#c2418f', '#7c5cd6', '#6b7280'];

/** Tickets store a label as its lower-cased name, so that is how they are matched. */
export function labelFor(tag: string, labels: TicketLabel[]): TicketLabel | undefined {
  return labels.find((label) => label.name.toLowerCase() === tag.toLowerCase());
}

/** A coloured chip for a label, or a plain one for a free-text tag with no label behind it. */
export function LabelChip({ name, color, className }: { name: string; color?: string | null; className?: string }) {
  return (
    <span
      className={cn('inline-flex max-w-full items-center gap-1 rounded-[3px] border px-1.5 py-px text-2xs font-medium whitespace-nowrap', className)}
      style={
        color
          ? { color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, background: `color-mix(in srgb, ${color} 12%, transparent)` }
          : undefined
      }
    >
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * Click-to-toggle label picker. Tags already on a ticket that no longer have a
 * label behind them stay selectable, so editing a ticket never silently drops one.
 */
export function LabelPicker({
  labels,
  value,
  onChange,
  disabled,
  emptyHint,
}: {
  labels: TicketLabel[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  emptyHint?: string;
}) {
  const selected = new Set(value.map((tag) => tag.toLowerCase()));
  const orphans = value.filter((tag) => !labelFor(tag, labels));

  const toggle = (name: string) => {
    const key = name.toLowerCase();
    onChange(selected.has(key) ? value.filter((tag) => tag.toLowerCase() !== key) : [...value, key]);
  };

  if (!labels.length && !orphans.length) {
    return <p className="text-xs text-subtle">{emptyHint ?? 'This department has no labels yet.'}</p>;
  }

  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Labels">
      {labels.map((label) => {
        const on = selected.has(label.name.toLowerCase());
        return (
          <button
            key={label.id}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            title={label.description ?? undefined}
            onClick={() => toggle(label.name)}
            className={cn(
              'inline-flex items-center gap-1 rounded-[3px] border px-2 py-1 text-xs transition-colors disabled:opacity-60',
              on ? 'font-medium' : 'text-muted hover:border-[var(--border-strong)] hover:text-[var(--fg)]',
            )}
            style={
              on
                ? { color: label.color, borderColor: label.color, background: `color-mix(in srgb, ${label.color} 14%, transparent)` }
                : undefined
            }
          >
            {on ? <Check className="size-3" /> : <span className="size-2 rounded-full" style={{ background: label.color }} />}
            {label.name}
          </button>
        );
      })}
      {orphans.map((tag) => (
        <button
          key={tag}
          type="button"
          disabled={disabled}
          aria-pressed
          title="A tag with no label behind it. Click to remove."
          onClick={() => toggle(tag)}
          className="inline-flex items-center gap-1 rounded-[3px] border border-dashed px-2 py-1 text-xs disabled:opacity-60"
        >
          <Check className="size-3" />
          {tag}
        </button>
      ))}
    </div>
  );
}

/**
 * Loads the labels offered for a department (its own plus the organisation-wide
 * ones), or with `all` every label in every department.
 */
export function useTeamLabels(teamId: string | null | undefined, { all = false } = {}): TicketLabel[] {
  const [labels, setLabels] = useState<TicketLabel[]>([]);
  useEffect(() => {
    let cancelled = false;
    void api.labels
      .list(teamId ?? undefined)
      .then((result) => {
        if (cancelled) return;
        // Without a department only the organisation-wide labels apply.
        setLabels(teamId || all ? result.labels : result.labels.filter((label) => !label.teamId));
      })
      .catch(() => !cancelled && setLabels([]));
    return () => {
      cancelled = true;
    };
  }, [teamId, all]);
  return labels;
}

interface Draft {
  id: string | null;
  name: string;
  color: string;
  description: string;
}

/** Create, rename, recolour and remove a department's labels. Shown in the team dialog. */
export function LabelManager({ teamId }: { teamId: string | null }) {
  const toast = useToast();
  const [labels, setLabels] = useState<TicketLabel[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLabels(null);
    void api.labels
      .list(teamId ?? undefined)
      .then((result) => !cancelled && setLabels(result.labels.filter((label) => label.teamId === teamId)))
      .catch(() => !cancelled && setLabels([]));
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    const input = { name: draft.name, color: draft.color, description: draft.description || null };
    try {
      if (draft.id) {
        const { label } = await api.labels.update(draft.id, input);
        setLabels((current) => (current ?? []).map((item) => (item.id === label.id ? label : item)));
      } else {
        const { label } = await api.labels.create({ ...input, teamId });
        setLabels((current) => [...(current ?? []), label]);
      }
      setDraft(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the label.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (label: TicketLabel) => {
    try {
      await api.labels.remove(label.id);
      setLabels((current) => (current ?? []).filter((item) => item.id !== label.id));
    } catch (caught) {
      toast.error('Could not remove the label', caught instanceof ApiError ? caught.message : undefined);
    }
  };

  return (
    <div className="space-y-2.5 rounded-sm border p-3 surface-2">
      {labels === null ? (
        <p className="text-xs text-subtle">Loading labels…</p>
      ) : labels.length === 0 && !draft ? (
        <p className="text-xs text-subtle">
          No labels yet. Add the categories this department sorts its work by, e.g. Hardware, Access, Onboarding.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {labels.map((label) => (
            <li key={label.id} className="inline-flex items-center gap-0.5 rounded-sm border py-0.5 pr-0.5 pl-1 surface">
              <LabelChip name={label.name} color={label.color} />
              <button
                type="button"
                onClick={() => setDraft({ id: label.id, name: label.name, color: label.color, description: label.description ?? '' })}
                className="rounded-xs p-1 text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                aria-label={`Edit ${label.name}`}
              >
                <Pencil className="size-3" />
              </button>
              <button
                type="button"
                onClick={() => void remove(label)}
                className="rounded-xs p-1 text-[var(--fg-subtle)] hover:text-[var(--priority-urgent)]"
                aria-label={`Remove ${label.name}`}
              >
                <Trash2 className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {draft ? (
        <div className="space-y-3 rounded-sm border p-3 surface">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="label-name">
              <Input id="label-name" value={draft.name} maxLength={40} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Hardware" />
            </Field>
            <Field label="Description" htmlFor="label-description">
              <Input
                id="label-description"
                value={draft.description}
                maxLength={200}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                placeholder="Optional, shown on hover"
              />
            </Field>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium">Colour</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {LABEL_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => setDraft({ ...draft, color })}
                  className={cn('size-6 rounded-sm border-2', draft.color === color ? 'border-[var(--fg)]' : 'border-transparent')}
                  style={{ background: color }}
                  aria-label={`Colour ${color}`}
                  aria-pressed={draft.color === color}
                />
              ))}
              <input
                type="color"
                value={draft.color}
                onChange={(event) => setDraft({ ...draft, color: event.target.value })}
                className="h-6 w-8 cursor-pointer rounded-sm border bg-transparent"
                aria-label="Custom colour"
              />
              <span className="ml-2">{draft.name.trim() && <LabelChip name={draft.name.trim()} color={draft.color} />}</span>
            </div>
          </div>
          {error && <p className="text-xs text-[var(--priority-urgent)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" type="button" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" type="button" loading={saving} disabled={!draft.name.trim()} onClick={() => void save()}>
              {draft.id ? 'Save label' : 'Add label'}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => {
            setError(null);
            setDraft({ id: null, name: '', color: LABEL_COLORS[(labels?.length ?? 0) % LABEL_COLORS.length], description: '' });
          }}
        >
          <Plus className="size-3.5" />
          Add label
        </Button>
      )}
    </div>
  );
}
