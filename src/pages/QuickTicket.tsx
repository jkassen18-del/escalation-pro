import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, ImagePlus, Info, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { templatesApi } from '@/lib/templates-api';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { RichTextEditor } from '@/components/ui/RichTextEditor';
import { ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { CustomFieldInputs, type CustomFieldValues } from '@/components/CustomFieldInputs';
import { TemplateBadge } from '@/components/quick/TemplateIcon';
import { useDocumentTitle } from '@/state/branding';
import type { TeamFormField } from '@shared/types';
import type { TicketTemplate } from '@shared/templates';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** The attachments route's default cap. A larger file is refused there anyway. */
const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024;
const MAX_SCREENSHOTS = 6;

/**
 * Raising a ticket from a quick-ticket template: only the template's
 * questions, a short summary and the details. Department, type and priority
 * come from the template.
 */
export function QuickTicketPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [template, setTemplate] = useState<TicketTemplate | null>(null);
  const [teamFields, setTeamFields] = useState<TeamFormField[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [answers, setAnswers] = useState<CustomFieldValues>({});
  const [teamAnswers, setTeamAnswers] = useState<CustomFieldValues>({});
  const [description, setDescription] = useState('');
  const [screenshots, setScreenshots] = useState<File[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  useDocumentTitle(template ? template.name : 'Quick ticket');

  useEffect(() => {
    void Promise.allSettled([templatesApi.usable(), api.teams.allForms()]).then(([templateResult, formResult]) => {
      if (templateResult.status === 'rejected') {
        setError(templateResult.reason instanceof ApiError ? templateResult.reason.message : 'Could not load quick tickets.');
        return;
      }
      const found = templateResult.value.templates.find((candidate) => candidate.id === id);
      if (!found) {
        setError('This quick ticket does not exist or is not available to you.');
        return;
      }
      setTemplate(found);
      // The department's own questions still apply, except where the template asks the same thing.
      if (formResult.status === 'fulfilled' && found.teamId) {
        const own = new Set(found.fields.map((field) => field.key));
        setTeamFields((formResult.value.forms[found.teamId] ?? []).filter((field) => !own.has(field.key)));
      }
    });
  }, [id]);

  const templateFields = useMemo<TeamFormField[]>(
    () => (template ? template.fields.map((field) => ({ ...field, teamId: template.teamId ?? '', dataSourceId: null })) : []),
    [template],
  );

  if (error) return <ErrorPane message={error} />;
  if (!template) return <LoadingPane />;

  const usesSummary = /\{\{\s*summary\s*\}\}/i.test(template.subjectTemplate);
  const hasInlineImage = /<img\b/i.test(description);
  const screenshotMissing = template.screenshot === 'required' && !hasInlineImage && screenshots.length === 0;

  const addFiles = (files: File[]) => {
    const images = files.filter((file) => IMAGE_TYPES.includes(file.type));
    if (images.length < files.length) toast.error('Only PNG, JPEG, GIF and WebP images can be added here.');
    const tooBig = images.find((file) => file.size > MAX_SCREENSHOT_BYTES);
    if (tooBig) toast.error(`${tooBig.name} is larger than ${MAX_SCREENSHOT_BYTES / 1024 / 1024}MB.`);
    setScreenshots((current) => [...current, ...images.filter((file) => file.size <= MAX_SCREENSHOT_BYTES)].slice(0, MAX_SCREENSHOTS));
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (screenshotMissing) {
      setErrors({ screenshot: 'Required' });
      toast.error(`${template.name} needs a screenshot`, 'Paste one into the details or add one below.');
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const { ticket } = await templatesApi.raise(template.id, {
        summary,
        answers,
        customFields: teamAnswers,
        description,
        screenshotsToFollow: screenshots.length,
      });
      if (screenshots.length) {
        try {
          await templatesApi.upload(ticket.id, screenshots);
        } catch (caught) {
          toast.error(
            `${ticket.reference} was raised, but the screenshots did not upload`,
            caught instanceof ApiError ? caught.message : 'Add them from the ticket.',
          );
        }
      }
      toast.success(`${ticket.reference} sent to ${template.teamName ?? 'the department'}.`);
      navigate(`/tickets/${ticket.id}`, { state: { justCreated: true } });
    } catch (caught) {
      if (caught instanceof ApiError) {
        setErrors(caught.details ?? {});
        toast.error('Could not raise the ticket', caught.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <button onClick={() => navigate(-1)} className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-[var(--fg)]">
        <ChevronLeft className="size-3.5" />
        Back
      </button>

      <div className="flex items-start gap-3">
        <TemplateBadge name={template.icon} color={template.color} />
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">{template.name}</h1>
          <p className="mt-0.5 text-xs text-muted">
            Goes to <span className="font-medium text-[var(--fg)]">{template.teamName ?? 'a department'}</span>
            {template.description ? ` · ${template.description}` : ''}
          </p>
        </div>
      </div>

      <form onSubmit={onSubmit} className="mt-5 space-y-4 rounded-md border p-4 surface sm:p-5">
        {template.guidance && (
          <p className="flex gap-2 rounded-sm border px-3 py-2 text-xs leading-relaxed surface-2">
            <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--accent)]" aria-hidden />
            <span className="whitespace-pre-line">{template.guidance}</span>
          </p>
        )}

        {usesSummary && (
          <Field label="Summary" htmlFor="summary" hint="One line, used in the ticket's title.">
            <Input id="summary" value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={150} autoFocus />
          </Field>
        )}

        {templateFields.length > 0 && <CustomFieldInputs fields={templateFields} values={answers} onChange={setAnswers} />}

        <Field label="Details" hint="What happened and anything already tried. Paste screenshots straight in (Win+Shift+S, then Ctrl+V).">
          <RichTextEditor
            value={description}
            onChange={setDescription}
            onError={(message) => toast.error(message)}
            minHeight={140}
            ariaLabel="Details"
          />
        </Field>

        {template.screenshot !== 'off' && (
          <ScreenshotPicker
            files={screenshots}
            required={template.screenshot === 'required'}
            satisfiedInline={hasInlineImage}
            error={Boolean(errors.screenshot)}
            onAdd={addFiles}
            onRemove={(index) => setScreenshots((current) => current.filter((_, i) => i !== index))}
          />
        )}

        {teamFields.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium">{template.teamName} also asks</p>
            <CustomFieldInputs fields={teamFields} values={teamAnswers} onChange={setTeamAnswers} />
          </div>
        )}

        <div className="flex justify-end gap-2 border-t pt-4">
          <Button variant="ghost" type="button" onClick={() => navigate(-1)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={submitting}>
            Send to {template.teamName ?? 'department'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function ScreenshotPicker({
  files,
  required,
  satisfiedInline,
  error,
  onAdd,
  onRemove,
}: {
  files: File[];
  required: boolean;
  satisfiedInline: boolean;
  error: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (index: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const previews = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);
  useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews]);

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">
        Screenshots{' '}
        <span className="font-normal text-subtle">
          {required ? (satisfiedInline ? '(required — one is in the details)' : '(required)') : '(optional)'}
        </span>
      </p>
      <div
        tabIndex={0}
        role="button"
        aria-label="Add screenshots: click to choose, or paste an image here"
        onClick={() => input.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            input.current?.click();
          }
        }}
        onPaste={(event) => {
          const pasted = Array.from(event.clipboardData.files);
          if (pasted.length) {
            event.preventDefault();
            onAdd(pasted);
          }
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          onAdd(Array.from(event.dataTransfer.files));
        }}
        className={`flex cursor-pointer items-center justify-center gap-2 rounded-sm border border-dashed px-3 py-4 text-xs text-subtle transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${
          error ? 'border-[var(--priority-urgent)] text-[var(--priority-urgent)]' : ''
        }`}
      >
        <ImagePlus className="size-4" aria-hidden />
        Add screenshot — click, drop, or select this box and paste
      </div>
      <input
        ref={input}
        type="file"
        accept={IMAGE_TYPES.join(',')}
        multiple
        hidden
        onChange={(event) => {
          onAdd(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`} className="relative">
              <img src={previews[index]} alt={file.name} className="size-20 rounded-sm border object-cover" />
              <button
                type="button"
                onClick={() => onRemove(index)}
                aria-label={`Remove ${file.name}`}
                className="absolute -top-1.5 -right-1.5 rounded-full border p-0.5 surface"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
