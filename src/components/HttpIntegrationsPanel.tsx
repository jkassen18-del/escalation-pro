import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, Pencil, Plus, Send, Trash2, Webhook, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { HTTP_METHODS, type HttpIntegration, type HttpIntegrationInput, type HttpMethod, type Team } from '@shared/types';

/**
 * Custom HTTP integrations: an administrator's own endpoints, called on
 * ticket events. For anything without a built-in connector.
 */

const EVENTS: Array<{ key: keyof HttpIntegration['events']; label: string }> = [
  { key: 'ticketCreated', label: 'Ticket created' },
  { key: 'ticketAssigned', label: 'Ticket assigned' },
  { key: 'ticketStatusChanged', label: 'Status changed' },
  { key: 'ticketEscalated', label: 'Escalated' },
  { key: 'ticketCommented', label: 'New comment' },
  { key: 'slaBreached', label: 'SLA breached' },
];

const PLACEHOLDERS = [
  '{{event}}',
  '{{headline}}',
  '{{detail}}',
  '{{actor}}',
  '{{ticket.reference}}',
  '{{ticket.subject}}',
  '{{ticket.status}}',
  '{{ticket.priority}}',
  '{{ticket.severity}}',
  '{{ticket.teamName}}',
  '{{ticket.assigneeName}}',
  '{{ticket.url}}',
];

const EXAMPLE_TEMPLATE = `{
  "text": "{{headline}}",
  "ticket": "{{ticket.reference}}",
  "subject": "{{ticket.subject}}",
  "priority": "{{ticket.priority}}",
  "link": "{{ticket.url}}"
}`;

interface Draft {
  name: string;
  url: string;
  method: HttpMethod;
  /** `stored` marks a header whose value is kept unless retyped. */
  headers: Array<{ name: string; value: string; stored: string | null }>;
  bodyTemplate: string;
  useTemplate: boolean;
  signingSecret: string;
  hasSigningSecret: boolean;
  removeSecret: boolean;
  allowPrivate: boolean;
  events: HttpIntegration['events'];
  teamIds: string[];
  enabled: boolean;
}

const BLANK: Draft = {
  name: '',
  url: '',
  method: 'POST',
  headers: [],
  bodyTemplate: '',
  useTemplate: false,
  signingSecret: '',
  hasSigningSecret: false,
  removeSecret: false,
  allowPrivate: false,
  events: {
    ticketCreated: true,
    ticketAssigned: true,
    ticketStatusChanged: true,
    ticketEscalated: true,
    ticketCommented: false,
    slaBreached: true,
  },
  teamIds: [],
  enabled: true,
};

function toDraft(integration: HttpIntegration): Draft {
  return {
    name: integration.name,
    url: integration.url,
    method: integration.method,
    headers: integration.headers.map((header) => ({ name: header.name, value: '', stored: header.preview })),
    bodyTemplate: integration.bodyTemplate ?? '',
    useTemplate: Boolean(integration.bodyTemplate),
    signingSecret: '',
    hasSigningSecret: integration.hasSigningSecret,
    removeSecret: false,
    allowPrivate: integration.allowPrivate,
    events: { ...integration.events },
    teamIds: [...integration.teamIds],
    enabled: integration.enabled,
  };
}

function toInput(draft: Draft): HttpIntegrationInput {
  return {
    name: draft.name,
    url: draft.url.trim(),
    method: draft.method,
    headers: draft.headers.filter((header) => header.name.trim()).map((header) => ({ name: header.name.trim(), value: header.value })),
    bodyTemplate: draft.useTemplate && draft.bodyTemplate.trim() ? draft.bodyTemplate : null,
    signingSecret: draft.removeSecret ? null : draft.signingSecret,
    allowPrivate: draft.allowPrivate,
    events: draft.events,
    teamIds: draft.teamIds,
    enabled: draft.enabled,
  };
}

export function HttpIntegrationsPanel({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const [integrations, setIntegrations] = useState<HttpIntegration[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const [deleting, setDeleting] = useState<HttpIntegration | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, teamList] = await Promise.all([api.integrations.http.list(), api.teams.list()]);
      setIntegrations(list.integrations);
      setTeams(teamList.teams);
    } catch (caught) {
      toast.error('Could not load custom integrations', caught instanceof ApiError ? caught.message : undefined);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const input = toInput(editing.draft);
      if (editing.id) await api.integrations.http.update(editing.id, input);
      else await api.integrations.http.create(input);
      toast.success(`${editing.draft.name} saved.`);
      setEditing(null);
      await load();
    } catch (caught) {
      toast.error('Could not save', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const test = async (integration: HttpIntegration) => {
    setTesting(integration.id);
    try {
      const { result } = await api.integrations.http.test(integration.id);
      const status = result.statusCode ? `HTTP ${result.statusCode}` : 'No response';
      setTestResult({
        id: integration.id,
        ok: result.ok,
        text: result.ok ? `${status}${result.responseExcerpt ? ` · ${result.responseExcerpt}` : ''}` : result.error ?? status,
      });
      onChanged?.();
    } catch (caught) {
      toast.error('Test failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setTesting(null);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await api.integrations.http.remove(deleting.id);
      setDeleting(null);
      await load();
    } catch (caught) {
      toast.error('Could not delete', caught instanceof ApiError ? caught.message : undefined);
    }
  };

  const teamName = (id: string) => teams.find((team) => team.id === id)?.name ?? 'Deleted team';

  return (
    <section className="rounded-md border surface">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border surface-2">
            <Webhook className="size-4 text-[var(--fg-subtle)]" aria-hidden />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Custom HTTP</h2>
            <p className="mt-0.5 text-xs text-muted">
              Call your own endpoints on ticket events: an internal dashboard, a CMDB, an automation platform.
            </p>
          </div>
        </div>
        <Button size="sm" onClick={() => setEditing({ id: null, draft: { ...BLANK, events: { ...BLANK.events } } })}>
          <Plus className="size-3.5" aria-hidden />
          Add endpoint
        </Button>
      </header>

      <div className="space-y-3 p-4">
        {integrations.length === 0 && <p className="text-xs text-subtle">No custom endpoints yet.</p>}

        {integrations.map((integration) => (
          <div key={integration.id} className="rounded-sm border p-3 surface-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold">{integration.name}</span>
                  {integration.enabled ? (
                    <span className="rounded-[3px] border border-[var(--status-resolved)]/40 px-1 text-2xs font-medium text-[var(--status-resolved)]">
                      Enabled
                    </span>
                  ) : (
                    <span className="rounded-[3px] border px-1 text-2xs text-subtle">Paused</span>
                  )}
                  {integration.hasSigningSecret && <span className="text-2xs text-subtle">Signed</span>}
                </div>
                <p className="mt-0.5 truncate font-mono text-2xs text-subtle" title={integration.url}>
                  {integration.method} {integration.url}
                </p>
                <p className="mt-1 text-2xs text-muted">
                  {EVENTS.filter((event) => integration.events[event.key])
                    .map((event) => event.label)
                    .join(', ') || 'No events selected'}
                  {' · '}
                  {integration.teamIds.length ? integration.teamIds.map(teamName).join(', ') : 'All teams'}
                </p>
                {testResult?.id === integration.id && (
                  <p
                    className="mt-1.5 inline-flex max-w-full items-start gap-1 text-2xs break-all"
                    style={{ color: testResult.ok ? 'var(--status-resolved)' : 'var(--priority-urgent)' }}
                  >
                    {testResult.ok ? <CheckCircle2 className="mt-px size-3 shrink-0" /> : <CircleAlert className="mt-px size-3 shrink-0" />}
                    {testResult.text}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="secondary" size="sm" loading={testing === integration.id} onClick={() => void test(integration)}>
                  <Send className="size-3.5" aria-hidden />
                  Test
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setEditing({ id: integration.id, draft: toDraft(integration) })} aria-label={`Edit ${integration.name}`}>
                  <Pencil className="size-3.5" aria-hidden />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDeleting(integration)} aria-label={`Delete ${integration.name}`}>
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <HttpIntegrationDialog
          draft={editing.draft}
          isNew={!editing.id}
          teams={teams}
          saving={saving}
          onChange={(draft) => setEditing((current) => (current ? { ...current, draft } : current))}
          onClose={() => setEditing(null)}
          onSave={() => void save()}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        title={`Delete ${deleting?.name ?? 'endpoint'}?`}
        message="Ticket events will stop being sent to this endpoint. Its past deliveries stay in the log."
        confirmLabel="Delete"
        destructive
      />
    </section>
  );
}

function HttpIntegrationDialog({
  draft,
  isNew,
  teams,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  draft: Draft;
  isNew: boolean;
  teams: Team[];
  saving: boolean;
  onChange: (draft: Draft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => onChange({ ...draft, [key]: value });
  const setHeader = (index: number, patch: Partial<Draft['headers'][number]>) =>
    set(
      'headers',
      draft.headers.map((header, i) => (i === index ? { ...header, ...patch } : header)),
    );

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={isNew ? 'Add a custom HTTP endpoint' : `Edit ${draft.name}`}
      description="InfraTicket calls this URL whenever a selected ticket event happens."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={onSave} disabled={!draft.name.trim() || !draft.url.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
          <Field label="Name" required>
            <Input value={draft.name} onChange={(event) => set('name', event.target.value)} placeholder="CMDB updates" />
          </Field>
          <Field label="Method">
            <Select value={draft.method} onChange={(event) => set('method', event.target.value as HttpMethod)}>
              {HTTP_METHODS.map((method) => (
                <option key={method}>{method}</option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label="URL"
          required
          hint={draft.allowPrivate ? 'http or https, including internal addresses.' : 'Must be https and on the public internet.'}
        >
          <Input
            value={draft.url}
            onChange={(event) => set('url', event.target.value)}
            placeholder="https://automation.example.com/hooks/infraticket"
            className="font-mono text-xs"
          />
        </Field>

        <Checkbox
          checked={draft.allowPrivate}
          onChange={(event) => set('allowPrivate', event.target.checked)}
          label="Allow private and internal addresses"
          hint="For a system on your own network (10.x, 192.168.x, plain http). Cloud metadata addresses stay blocked."
        />

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-xs font-medium">Headers</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => set('headers', [...draft.headers, { name: '', value: '', stored: null }])}
            >
              <Plus className="size-3.5" aria-hidden />
              Add header
            </Button>
          </div>
          {draft.headers.length === 0 && <p className="text-2xs text-subtle">None. Add an Authorization header if the endpoint needs one.</p>}
          <div className="space-y-2">
            {draft.headers.map((header, index) => (
              <div key={index} className="flex gap-2">
                <Input
                  value={header.name}
                  onChange={(event) => setHeader(index, { name: event.target.value })}
                  placeholder="Authorization"
                  className="w-2/5 font-mono text-xs"
                  aria-label="Header name"
                />
                <Input
                  type="password"
                  value={header.value}
                  onChange={(event) => setHeader(index, { value: event.target.value })}
                  placeholder={header.stored ? `Saved · ${header.stored}` : 'Bearer …'}
                  className="flex-1 font-mono text-xs"
                  aria-label="Header value"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => set('headers', draft.headers.filter((_, i) => i !== index))}
                  aria-label="Remove header"
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              </div>
            ))}
          </div>
          <p className="mt-1 text-2xs text-subtle">Values are encrypted and never shown again. Leave a saved value blank to keep it.</p>
        </div>

        <div className="space-y-2">
          <Checkbox
            checked={draft.useTemplate}
            onChange={(event) =>
              onChange({ ...draft, useTemplate: event.target.checked, bodyTemplate: draft.bodyTemplate || EXAMPLE_TEMPLATE })
            }
            label="Use my own body template"
            hint="Otherwise the body is a JSON document with the event, headline, detail, actor and the ticket."
          />
          {draft.useTemplate && (
            <>
              <Textarea
                value={draft.bodyTemplate}
                onChange={(event) => set('bodyTemplate', event.target.value)}
                rows={8}
                className="font-mono text-xs"
                spellCheck={false}
              />
              <p className="text-2xs leading-relaxed text-subtle">
                Placeholders: {PLACEHOLDERS.map((placeholder) => (
                  <code key={placeholder} className="mr-1.5 font-mono">
                    {placeholder}
                  </code>
                ))}
                <br />A template starting with <code className="font-mono">{'{'}</code> or <code className="font-mono">[</code> is sent as JSON, and every value is escaped so the document stays valid.
              </p>
            </>
          )}
        </div>

        <Field
          label="Signing secret"
          hint="Optional. Each request carries X-InfraTicket-Signature: sha256=HMAC(secret, timestamp + '.' + body) and X-InfraTicket-Timestamp."
        >
          <Input
            type="password"
            value={draft.signingSecret}
            disabled={draft.removeSecret}
            onChange={(event) => set('signingSecret', event.target.value)}
            placeholder={draft.hasSigningSecret ? 'Saved · leave blank to keep' : 'A long random string'}
            className="font-mono text-xs"
          />
        </Field>
        {draft.hasSigningSecret && (
          <Checkbox
            checked={draft.removeSecret}
            onChange={(event) => set('removeSecret', event.target.checked)}
            label="Stop signing requests"
          />
        )}

        <div>
          <p className="mb-2 text-xs font-medium">Send when…</p>
          <div className="grid gap-2 rounded-sm border p-3 surface-2 sm:grid-cols-3">
            {EVENTS.map((event) => (
              <Checkbox
                key={event.key}
                checked={draft.events[event.key]}
                onChange={(changeEvent) => set('events', { ...draft.events, [event.key]: changeEvent.target.checked })}
                label={event.label}
              />
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium">Only for these teams</p>
          <p className="mb-2 text-2xs text-subtle">Leave all unticked to send for every team.</p>
          <div className="grid gap-2 rounded-sm border p-3 surface-2 sm:grid-cols-3">
            {teams.map((team) => (
              <Checkbox
                key={team.id}
                checked={draft.teamIds.includes(team.id)}
                onChange={(event) =>
                  set('teamIds', event.target.checked ? [...draft.teamIds, team.id] : draft.teamIds.filter((id) => id !== team.id))
                }
                label={team.name}
              />
            ))}
          </div>
        </div>

        <Checkbox checked={draft.enabled} onChange={(event) => set('enabled', event.target.checked)} label="Enabled" />
      </div>
    </Modal>
  );
}
