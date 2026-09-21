import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import type { TeamFormField } from '@shared/types';

/**
 * Renders a department's intake questions on the new-ticket page.
 *
 * Values are held by the caller as a plain map keyed by each field's stable
 * key, which is exactly the shape the API expects back.
 */
export type CustomFieldValues = Record<string, unknown>;

export function CustomFieldInputs({
  fields,
  values,
  onChange,
}: {
  fields: TeamFormField[];
  values: CustomFieldValues;
  onChange: (values: CustomFieldValues) => void;
}) {
  if (fields.length === 0) return null;

  const set = (key: string, value: unknown) => onChange({ ...values, [key]: value });

  return (
    <div className="space-y-4 rounded-sm border border-dashed p-4">
      {fields.map((field) => {
        const value = values[field.key];
        const inputId = `custom-${field.key}`;

        if (field.type === 'checkbox') {
          return (
            <Checkbox
              key={field.key}
              id={inputId}
              checked={value === true}
              label={field.label}
              hint={field.helpText ?? undefined}
              onChange={(event) => set(field.key, event.target.checked)}
            />
          );
        }

        return (
          <Field
            key={field.key}
            label={field.label}
            htmlFor={inputId}
            hint={field.helpText ?? undefined}
            required={field.required}
          >
            {field.type === 'textarea' ? (
              <Textarea
                id={inputId}
                rows={3}
                value={String(value ?? '')}
                placeholder={field.placeholder ?? undefined}
                onChange={(event) => set(field.key, event.target.value)}
              />
            ) : field.type === 'select' ? (
              <Select id={inputId} value={String(value ?? '')} onChange={(event) => set(field.key, event.target.value)}>
                <option value="">{field.required ? 'Choose…' : 'No answer'}</option>
                {field.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            ) : field.type === 'multiselect' ? (
              <div className="space-y-1.5">
                {field.options.map((option) => {
                  const selected = Array.isArray(value) ? (value as string[]) : [];
                  return (
                    <Checkbox
                      key={option}
                      label={option}
                      checked={selected.includes(option)}
                      onChange={(event) =>
                        set(
                          field.key,
                          event.target.checked
                            ? [...selected, option]
                            : selected.filter((entry) => entry !== option),
                        )
                      }
                    />
                  );
                })}
              </div>
            ) : (
              <Input
                id={inputId}
                type={
                  field.type === 'number'
                    ? 'number'
                    : field.type === 'date'
                      ? 'date'
                      : field.type === 'email'
                        ? 'email'
                        : field.type === 'url'
                          ? 'url'
                          : 'text'
                }
                value={String(value ?? '')}
                placeholder={field.placeholder ?? undefined}
                onChange={(event) => set(field.key, event.target.value)}
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}

/** Read-only rendering of the answers on a ticket. */
export function CustomFieldSummary({
  values,
}: {
  values: Array<{ key: string; label: string; type: string; value: unknown }>;
}) {
  if (values.length === 0) return null;

  return (
    <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]">
      {values.map((entry) => (
        <div key={entry.key} className="contents">
          <dt className="text-2xs uppercase tracking-wide text-subtle">{entry.label}</dt>
          <dd className="text-xs">{renderValue(entry.type, entry.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function renderValue(type: string, value: unknown) {
  if (value === null || value === undefined || value === '') return <span className="text-subtle">—</span>;
  if (type === 'checkbox') return value === true ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : <span className="text-subtle">—</span>;
  if (type === 'url') {
    // The server only stores http/https for this type, so rendering it as a
    // link cannot introduce a javascript: URL.
    return (
      <a href={String(value)} target="_blank" rel="noopener noreferrer nofollow" className="underline">
        {String(value)}
      </a>
    );
  }
  return String(value);
}
