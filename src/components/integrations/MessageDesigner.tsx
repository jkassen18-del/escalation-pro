import { useEffect, useRef, useState, type ReactNode } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/state/auth';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/Field';
import {
  SAMPLE_VALUES,
  TEMPLATE_FIELDS,
  TEMPLATE_FIELD_LABELS,
  TEMPLATE_PLACEHOLDERS,
  fieldPairs,
  fill,
  type MessageTemplate,
  type TemplateProvider,
} from '@shared/message-template';

type TextKey = 'title' | 'subtitle' | 'body' | 'footer';

const APP: Record<TemplateProvider, string> = { slack: 'Slack', msteams: 'Microsoft Teams', linear: 'Linear' };
const PRIORITY_EDGE = '#175cd3';

/**
 * Lays out how ticket messages look in one app, with a preview filled from a
 * sample ticket by the same code the server sends with.
 */
export function MessageDesigner({ provider }: { provider: TemplateProvider }) {
  const toast = useToast();
  const [saved, setSaved] = useState<MessageTemplate | null>(null);
  const [defaults, setDefaults] = useState<MessageTemplate | null>(null);
  const [draft, setDraft] = useState<MessageTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [focus, setFocus] = useState<TextKey>('body');
  const inputs = useRef<Partial<Record<TextKey, HTMLInputElement | HTMLTextAreaElement | null>>>({});

  useEffect(() => {
    let cancelled = false;
    void api.integrations
      .template(provider)
      .then((result) => {
        if (cancelled) return;
        setSaved(result.template);
        setDefaults(result.defaults);
        setDraft(result.template);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [provider]);

  if (!draft || !saved || !defaults) return <p className="text-xs text-subtle">Loading the message design…</p>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const isDefault = JSON.stringify(draft) === JSON.stringify(defaults);
  const set = <K extends keyof MessageTemplate>(key: K, value: MessageTemplate[K]) => setDraft({ ...draft, [key]: value });

  /** Drops a placeholder in at the cursor of the field last typed in. */
  const insert = (key: string) => {
    const element = inputs.current[focus];
    const token = `{{${key}}}`;
    const value = draft[focus];
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    set(focus, `${value.slice(0, start)}${token}${value.slice(end)}`);
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = async (template: MessageTemplate | null) => {
    setSaving(true);
    try {
      const result = await api.integrations.saveTemplate(provider, template);
      setSaved(result.template);
      setDraft(result.template);
      toast.success(template ? `${APP[provider]} messages will look like the preview.` : `${APP[provider]} messages are back to the default design.`);
    } catch (caught) {
      toast.error('Could not save', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const text = (key: TextKey, label: string, hint: string, multiline = false) => (
    <Field label={label} hint={hint}>
      {multiline ? (
        <Textarea
          ref={(element) => {
            inputs.current[key] = element;
          }}
          rows={3}
          value={draft[key]}
          onFocus={() => setFocus(key)}
          onChange={(event) => set(key, event.target.value)}
          className="font-mono text-xs"
        />
      ) : (
        <Input
          ref={(element) => {
            inputs.current[key] = element;
          }}
          value={draft[key]}
          onFocus={() => setFocus(key)}
          onChange={(event) => set(key, event.target.value)}
          className="font-mono text-xs"
        />
      )}
    </Field>
  );

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold">How {APP[provider]} {provider === 'linear' ? 'issues' : 'messages'} look</p>
        <p className="mt-0.5 text-xs text-muted">
          Type <code className="font-mono">{'{{'}</code>placeholders<code className="font-mono">{'}}'}</code> where ticket details go. Click one below to add it where your cursor is.
          {provider === 'slack' && ' Slack formatting works: *bold*, _italic_.'}
          {provider !== 'slack' && ' Markdown works: **bold**, _italic_.'}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-3">
          {text('title', provider === 'linear' ? 'Issue title' : 'Title', 'Bold, first line.')}
          {provider !== 'linear' && text('subtitle', 'Second line', 'Under the title. Leave blank to skip.')}
          <div>
            <p className="mb-1 text-xs font-medium">Details shown</p>
            <div className="flex flex-wrap gap-1">
              {TEMPLATE_FIELDS.map((field) => {
                const on = draft.fields.includes(field);
                const order = draft.fields.indexOf(field);
                return (
                  <button
                    key={field}
                    type="button"
                    aria-pressed={on}
                    onClick={() => set('fields', on ? draft.fields.filter((item) => item !== field) : [...draft.fields, field])}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-0.5 text-2xs',
                      on ? 'border-[var(--accent)] font-medium text-[var(--accent)]' : 'text-muted hover:text-[var(--fg)]',
                    )}
                  >
                    {on && <span className="tabular">{order + 1}.</span>}
                    {TEMPLATE_FIELD_LABELS[field]}
                    {on && <X className="size-2.5" />}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-2xs text-subtle">Shown in the order you pick them.</p>
          </div>
          {text('body', provider === 'linear' ? 'Description' : 'Message', 'Below the details. {{detail}} is what changed: the comment, the new status, the reason.', true)}
          {text('footer', 'Small print', 'At the bottom. Leave blank to skip.')}
          {provider !== 'linear' && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Checkbox
                checked={draft.buttons}
                onChange={(event) => set('buttons', event.target.checked)}
                label={provider === 'slack' ? 'Open, Resolve and Close buttons' : 'Open ticket button'}
              />
              <Checkbox checked={draft.priorityColour} onChange={(event) => set('priorityColour', event.target.checked)} label="Colour by priority" />
            </div>
          )}
          <div>
            <p className="mb-1 text-2xs font-medium text-muted">Placeholders</p>
            <div className="flex flex-wrap gap-1">
              {TEMPLATE_PLACEHOLDERS.map((placeholder) => (
                <button
                  key={placeholder.key}
                  type="button"
                  title={placeholder.label}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insert(placeholder.key)}
                  className="rounded-[3px] border px-1 py-px font-mono text-2xs text-muted surface-2 hover:text-[var(--fg)]"
                >
                  {placeholder.key}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <p className="mb-1 text-xs font-medium">Preview</p>
          <Preview provider={provider} template={draft} />
          <p className="mt-1 text-2xs text-subtle">A sample ticket. Real messages use the ticket's own details.</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {!isDefault && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(defaults)}>
            <RotateCcw className="size-3.5" />
            Default design
          </Button>
        )}
        {dirty && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(saved)}>
            Undo changes
          </Button>
        )}
        <Button variant="primary" size="sm" loading={saving} disabled={!dirty} onClick={() => void save(isDefault ? null : draft)}>
          Save design
        </Button>
      </div>
    </div>
  );
}

/* --------------------------------- Preview --------------------------------- */

/** Undoes Slack's &amp; escaping for display. */
const unescape = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Just enough of each app's formatting to show what a message will look like:
 * links, bold, italic and line breaks. Builds React nodes, never HTML.
 */
function Inline({ text, provider }: { text: string; provider: TemplateProvider }) {
  const pattern =
    provider === 'slack' ? /(<[^|>]+\|[^>]+>|\*[^*\n]+\*|_[^_\n]+_)/g : /(\[[^\]]+\]\([^)]+\)|\*\*[^*\n]+\*\*|_[^_\n]+_)/g;
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, lineIndex) => (
        <span key={lineIndex}>
          {lineIndex > 0 && <br />}
          {line.split(pattern).map((part, index): ReactNode => {
            if (!part) return null;
            const slackLink = provider === 'slack' && /^<([^|>]+)\|([^>]+)>$/.exec(part);
            const mdLink = provider !== 'slack' && /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
            if (slackLink) return <span key={index} className="text-[#1d9bd1] hover:underline">{unescape(slackLink[2])}</span>;
            if (mdLink) return <span key={index} className="text-[#5b5fc7] underline">{mdLink[1]}</span>;
            if (provider === 'slack' && /^\*[^*]+\*$/.test(part)) return <b key={index}>{unescape(part.slice(1, -1))}</b>;
            if (provider !== 'slack' && /^\*\*[^*]+\*\*$/.test(part)) return <b key={index}>{part.slice(2, -2)}</b>;
            if (/^_[^_]+_$/.test(part)) return <i key={index}>{unescape(part.slice(1, -1))}</i>;
            return <span key={index}>{provider === 'slack' ? unescape(part) : part}</span>;
          })}
        </span>
      ))}
    </>
  );
}

function Preview({ provider, template }: { provider: TemplateProvider; template: MessageTemplate }) {
  const { organizationName } = useAuth();
  const values = { ...SAMPLE_VALUES, org: organizationName || SAMPLE_VALUES.org };
  const title = fill(template.title, values, provider);
  const subtitle = fill(template.subtitle, values, provider);
  const body = fill(template.body, values, provider);
  const footer = fill(template.footer, values, provider);
  const fields = fieldPairs(template, values, provider);

  if (provider === 'slack') {
    return (
      <div className="rounded-md border border-[#2c2d30] bg-[#1a1d21] p-3 text-[13px] leading-snug text-[#d1d2d3]">
        <div className="flex gap-2">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-[#c9a04b] text-xs font-bold text-[#1a1d21]">
            {values.org.slice(0, 1)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px]">
              <b className="text-white">{values.org}</b> <span className="text-[11px] text-[#ababad]">APP 7:55</span>
            </p>
            <div className={cn('mt-1 min-w-0', template.priorityColour && 'border-l-4 pl-2.5')} style={template.priorityColour ? { borderColor: PRIORITY_EDGE } : undefined}>
              <p className="break-words">
                <b className="text-white">
                  <Inline text={title} provider="slack" />
                </b>
                {subtitle && (
                  <>
                    <br />
                    <Inline text={subtitle} provider="slack" />
                  </>
                )}
              </p>
              {fields.length > 0 && (
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
                  {fields.map((field) => (
                    <div key={field.label} className="min-w-0">
                      <b className="block text-white">{field.label}</b>
                      <span className="break-words">{unescape(field.value)}</span>
                    </div>
                  ))}
                </div>
              )}
              {body && (
                <p className="mt-2 break-words">
                  <Inline text={body} provider="slack" />
                </p>
              )}
              {footer && (
                <p className="mt-2 text-[11px] text-[#ababad]">
                  <Inline text={footer} provider="slack" />
                </p>
              )}
              {template.buttons && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="rounded border border-[#565856] px-2 py-0.5 text-xs font-bold text-white">Open ticket</span>
                  <span className="rounded bg-[#007a5a] px-2 py-0.5 text-xs font-bold text-white">Resolve</span>
                  <span className="rounded border border-[#565856] px-2 py-0.5 text-xs font-bold text-white">Close</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (provider === 'msteams') {
    return (
      <div className="rounded-md bg-[#f5f5f5] p-3 text-[13px] text-[#242424]">
        <div className="overflow-hidden rounded-md border border-[#e0e0e0] bg-white">
          <div className={cn('px-3 pt-2.5 pb-2', template.priorityColour && 'bg-[#eaf1fb]')}>
            <p className="font-semibold break-words">
              <Inline text={title} provider="msteams" />
            </p>
            {subtitle && (
              <p className="break-words">
                <Inline text={subtitle} provider="msteams" />
              </p>
            )}
          </div>
          <div className="space-y-2 px-3 pb-3">
            {fields.length > 0 && (
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 pt-1">
                {fields.map((field) => (
                  <div key={field.label} className="contents">
                    <dt className="font-semibold">{field.label}</dt>
                    <dd className="break-words">{field.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {body && (
              <p className="break-words">
                <Inline text={body} provider="msteams" />
              </p>
            )}
            {footer && (
              <p className="text-[11px] text-[#616161]">
                <Inline text={footer} provider="msteams" />
              </p>
            )}
            {template.buttons && (
              <span className="block rounded border border-[#d1d1d1] py-1 text-center text-xs font-semibold text-[#5b5fc7]">Open ticket</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[#2a2b30] bg-[#18191b] p-4 text-[13px] leading-relaxed text-[#d2d3e0]">
      <p className="text-[11px] text-[#858699]">FIN-128</p>
      <p className="mt-1 text-base font-semibold break-words text-[#eeeffc]">{title.replace(/\s+/g, ' ')}</p>
      <div className="mt-3 space-y-2">
        {body && (
          <p className="break-words">
            <Inline text={body} provider="linear" />
          </p>
        )}
        {fields.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5">
            {fields.map((field) => (
              <li key={field.label} className="break-words">
                <b>{field.label}:</b> {field.value}
              </li>
            ))}
          </ul>
        )}
        {footer && (
          <>
            <hr className="border-[#2a2b30]" />
            <p className="break-words">
              <Inline text={footer} provider="linear" />
            </p>
          </>
        )}
      </div>
    </div>
  );
}
