import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, FlaskConical, Pencil, Plus, Route, Trash2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { opsApi, type AlertRuleInput } from '@/lib/ops-api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Menu } from '@/components/ui/Menu';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import {
  ALERT_SOURCE_KINDS,
  ALERT_SOURCE_LABELS,
  MONITOR_KINDS,
  MONITOR_KIND_LABELS,
  SEVERITIES,
  type AlertRule,
  type AlertSource,
  type EscalationPolicy,
  type Monitor,
  type RoutingOutcome,
  type Severity,
} from '@shared/ops';
import type { Team } from '@shared/types';

const KIND_LABELS: Record<string, string> = {
  monitor: 'Any monitor',
  webhook: 'Any alert source',
  ...Object.fromEntries(MONITOR_KINDS.map((k) => [k, `${MONITOR_KIND_LABELS[k]} monitors`])),
  ...Object.fromEntries(ALERT_SOURCE_KINDS.map((k) => [k, ALERT_SOURCE_LABELS[k]])),
};
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function message(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
}

const blank = (): AlertRuleInput => ({ name: '', enabled: true, match: {}, actions: {}, continueEvaluating: false });

/** Starting points that cover the common cases; each opens in the editor to adjust. */
function presets(teams: Team[]): Array<{ label: string; rule: AlertRuleInput }> {
  const find = (re: RegExp) => teams.find((t) => re.test(t.name))?.id ?? null;
  return [
    {
      label: 'Website / HTTP monitors → Web team',
      rule: { ...blank(), name: 'Website down → Web team', match: { sourceKinds: ['http', 'ssl'] }, actions: { teamId: find(/web|site|front/i), tags: ['website'] } },
    },
    {
      label: 'Database alerts → DBA team',
      rule: {
        ...blank(),
        name: 'Database alerts → DBA team',
        match: { text: 'postgres|mysql|mongo|database|replication', textMode: 'regex' },
        actions: { teamId: find(/dba|data/i), tags: ['database'] },
      },
    },
    { label: 'SEV4 → ticket only, no page', rule: { ...blank(), name: 'SEV4 → ticket only', match: { severities: ['sev4'] }, actions: { suppressPaging: true } } },
    {
      label: 'Out of hours: downgrade SEV3',
      rule: {
        ...blank(),
        name: 'SEV3 after hours → no page',
        match: { severities: ['sev3'], timeWindow: { mode: 'after_hours', timeZone: 'Africa/Johannesburg', days: [1, 2, 3, 4, 5], startHour: 8, endHour: 17 } },
        actions: { suppressPaging: true },
      },
    },
  ];
}

function describeMatch(rule: AlertRuleInput, names: { source: (id: string) => string }): string {
  const m = rule.match;
  const parts: string[] = [];
  if (m.sourceIds?.length) parts.push(m.sourceIds.map(names.source).join(' or '));
  if (m.sourceKinds?.length) parts.push(m.sourceKinds.map((k) => KIND_LABELS[k] ?? k).join(' or '));
  if (m.text) parts.push(m.textMode === 'regex' ? `text matches /${m.text}/` : `text contains "${m.text}"`);
  if (m.severities?.length) parts.push(m.severities.map((s) => s.toUpperCase()).join('/'));
  if (m.field) parts.push(`${m.field.path} ${m.field.op === 'equals' ? '=' : 'contains'} "${m.field.value}"`);
  if (m.timeWindow) {
    const w = m.timeWindow;
    parts.push(`${w.mode === 'business_hours' ? 'during' : 'outside'} ${w.days.map((d) => WEEKDAY_SHORT[d]).join(',')} ${w.startHour}:00–${w.endHour}:00`);
  }
  return parts.length ? parts.join(' · ') : 'Every alert';
}

function describeActions(rule: AlertRuleInput, names: { team: (id: string) => string; policy: (id: string) => string }): string {
  const a = rule.actions;
  if (a.drop) return 'Drop the alert';
  const parts: string[] = [];
  if (a.teamId) parts.push(`route to ${names.team(a.teamId)}`);
  if (a.escalationPolicyId) parts.push(`page "${names.policy(a.escalationPolicyId)}"`);
  if (a.severity) parts.push(`set ${a.severity.toUpperCase()}`);
  if (a.tags?.length) parts.push(`tag ${a.tags.join(', ')}`);
  if (a.suppressPaging) parts.push('ticket only, no page');
  return parts.join(' · ') || 'Nothing';
}

export function RoutingTab({ canManage, teams, policies }: { canManage: boolean; teams: Team[]; policies: EscalationPolicy[] }) {
  const toast = useToast();
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [sources, setSources] = useState<AlertSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; rule: AlertRuleInput } | null>(null);
  const [deleting, setDeleting] = useState<AlertRule | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, m, s] = await Promise.all([opsApi.alertRules.list(), opsApi.monitors.list(), opsApi.sources.list()]);
      setRules(r.rules);
      setMonitors(m.monitors);
      setSources(s.sources);
    } catch (caught) {
      setError(message(caught, 'Could not load routing rules.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const names = {
    source: (id: string) => monitors.find((m) => m.id === id)?.name ?? sources.find((s) => s.id === id)?.name ?? 'deleted source',
    team: (id: string) => teams.find((t) => t.id === id)?.name ?? 'deleted team',
    policy: (id: string) => policies.find((p) => p.id === id)?.name ?? 'deleted policy',
  };

  const move = async (index: number, delta: number) => {
    const ids = rules.map((r) => r.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    try {
      setRules((await opsApi.alertRules.reorder(ids)).rules);
    } catch (caught) {
      toast.error('Could not reorder', message(caught, ''));
    }
  };

  if (error) return <ErrorPane message={error} retry={load} />;
  if (loading) return <LoadingPane label="Loading routing rules" />;

  const presetMenu = canManage && (
    <Menu
      trigger={({ toggle }) => (
        <Button variant="secondary" size="sm" onClick={toggle}>
          Start from a preset
        </Button>
      )}
      items={presets(teams).map((preset) => ({ label: preset.label, onSelect: () => setEditing({ id: null, rule: preset.rule }) }))}
    />
  );

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-2xl text-xs text-muted">
          Rules run top to bottom on every new alert, before the source's own routing. The first rule that matches decides where
          the incident goes, unless it is set to keep evaluating. Alerts no rule matches go to their monitor's or source's team.
        </p>
        {canManage && (
          <div className="flex gap-2">
            {presetMenu}
            <Button variant="primary" size="sm" onClick={() => setEditing({ id: null, rule: blank() })}>
              <Plus className="size-3.5" />
              New rule
            </Button>
          </div>
        )}
      </div>

      {rules.length === 0 ? (
        <EmptyState
          icon={Route}
          title="No routing rules"
          description="Send website alerts to the web team, database alerts to the DBAs, and keep low-severity noise from paging anyone."
          action={presetMenu || undefined}
        />
      ) : (
        <ol className="space-y-2">
          {rules.map((rule, index) => (
            <li key={rule.id} className={`flex flex-wrap items-start gap-3 rounded-md border p-3 surface ${rule.enabled ? '' : 'opacity-60'}`}>
              <span className="mt-0.5 w-5 shrink-0 text-xs text-subtle tabular">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {rule.name}
                  {!rule.enabled && <Badge dot={false}>Off</Badge>}
                  {rule.continueEvaluating && <Badge dot={false}>Keeps evaluating</Badge>}
                </p>
                <p className="mt-1 text-xs">
                  <span className="text-subtle">When </span>
                  {describeMatch(rule, names)}
                </p>
                <p className="mt-0.5 text-xs">
                  <span className="text-subtle">Then </span>
                  {describeActions(rule, names)}
                </p>
              </div>
              {canManage && (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up">
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" disabled={index === rules.length - 1} onClick={() => move(index, 1)} aria-label="Move down">
                    <ArrowDown className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setEditing({ id: rule.id, rule })} aria-label="Edit rule">
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setDeleting(rule)} aria-label="Delete rule">
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      <RuleTester monitors={monitors} sources={sources} names={names} />

      {editing && (
        <RuleDialog
          initial={editing.rule}
          editingId={editing.id}
          teams={teams}
          policies={policies}
          monitors={monitors}
          sources={sources}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
            toast.success('Rule saved.');
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title={`Delete "${deleting?.name ?? ''}"?`}
        message="Alerts it matched will fall through to later rules or the default routing."
        confirmLabel="Delete rule"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await opsApi.alertRules.remove(deleting.id);
            setDeleting(null);
            await load();
          } catch (caught) {
            toast.error('Could not delete', message(caught, ''));
          }
        }}
      />
    </div>
  );
}

function MultiPick({ options, value, onChange, placeholder }: { options: Array<{ value: string; label: string }>; value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onChange(value.filter((x) => x !== v))}
              className="rounded-full border px-2 py-0.5 text-xs surface-2 hover:line-through"
              title="Remove"
            >
              {options.find((o) => o.value === v)?.label ?? v} ×
            </button>
          ))}
        </div>
      )}
      <Select
        value=""
        onChange={(event) => {
          if (event.target.value && !value.includes(event.target.value)) onChange([...value, event.target.value]);
        }}
      >
        <option value="">{placeholder}</option>
        {options
          .filter((o) => !value.includes(o.value))
          .map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
      </Select>
    </div>
  );
}

function RuleDialog({
  initial,
  editingId,
  teams,
  policies,
  monitors,
  sources,
  onClose,
  onSaved,
}: {
  initial: AlertRuleInput;
  editingId: string | null;
  teams: Team[];
  policies: EscalationPolicy[];
  monitors: Monitor[];
  sources: AlertSource[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [rule, setRule] = useState<AlertRuleInput>(() => JSON.parse(JSON.stringify(initial)));
  const [tags, setTags] = useState((initial.actions.tags ?? []).join(', '));
  const [submitting, setSubmitting] = useState(false);
  const m = rule.match;
  const a = rule.actions;
  const setMatch = (patch: Partial<typeof m>) => setRule((r) => ({ ...r, match: { ...r.match, ...patch } }));
  const setActions = (patch: Partial<typeof a>) => setRule((r) => ({ ...r, actions: { ...r.actions, ...patch } }));

  const submit = async () => {
    setSubmitting(true);
    const input = { ...rule, actions: { ...rule.actions, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) } };
    try {
      if (editingId) await opsApi.alertRules.update(editingId, input);
      else await opsApi.alertRules.create(input);
      await onSaved();
    } catch (caught) {
      toast.error('Could not save the rule', message(caught, ''));
    } finally {
      setSubmitting(false);
    }
  };

  const sourceOptions = [
    ...monitors.map((mon) => ({ value: mon.id, label: `Monitor: ${mon.name}` })),
    ...sources.map((src) => ({ value: src.id, label: `Source: ${src.name}` })),
  ];
  const window = m.timeWindow;

  return (
    <Modal
      open
      onClose={onClose}
      title={editingId ? `Edit ${initial.name}` : 'New routing rule'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} disabled={!rule.name.trim()} onClick={submit}>
            {editingId ? 'Save rule' : 'Create rule'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input value={rule.name} onChange={(event) => setRule((r) => ({ ...r, name: event.target.value }))} placeholder="Website down → Web team" autoFocus />
        </Field>

        <section className="space-y-3 rounded-md border p-3 surface-2">
          <p className="text-xs font-semibold">When an alert… <span className="font-normal text-subtle">(every condition you set must hold)</span></p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Comes from these monitors or sources">
              <MultiPick options={sourceOptions} value={m.sourceIds ?? []} onChange={(sourceIds) => setMatch({ sourceIds })} placeholder="Any source" />
            </Field>
            <Field label="From this kind of source">
              <MultiPick
                options={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))}
                value={m.sourceKinds ?? []}
                onChange={(sourceKinds) => setMatch({ sourceKinds })}
                placeholder="Any kind"
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
            <Field label="Title or summary" hint={m.textMode === 'regex' ? 'Case-insensitive regular expression.' : 'Case-insensitive.'}>
              <Input value={m.text ?? ''} onChange={(event) => setMatch({ text: event.target.value })} placeholder="checkout" />
            </Field>
            <Field label="Match">
              <Select value={m.textMode ?? 'contains'} onChange={(event) => setMatch({ textMode: event.target.value as 'contains' | 'regex' })}>
                <option value="contains">contains</option>
                <option value="regex">regex</option>
              </Select>
            </Field>
          </div>
          <Field label="Severity">
            <div className="flex flex-wrap gap-3">
              {SEVERITIES.map((severity) => (
                <Checkbox
                  key={severity}
                  label={severity.toUpperCase()}
                  checked={(m.severities ?? []).includes(severity)}
                  onChange={(event) =>
                    setMatch({
                      severities: event.target.checked ? [...(m.severities ?? []), severity] : (m.severities ?? []).filter((s) => s !== severity),
                    })
                  }
                />
              ))}
            </div>
          </Field>
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem_1fr]">
            <Field label="Payload field" hint="e.g. labels.service">
              <Input
                value={m.field?.path ?? ''}
                onChange={(event) => setMatch({ field: event.target.value ? { path: event.target.value, op: m.field?.op ?? 'equals', value: m.field?.value ?? '' } : undefined })}
              />
            </Field>
            <Field label=" ">
              <Select disabled={!m.field} value={m.field?.op ?? 'equals'} onChange={(event) => m.field && setMatch({ field: { ...m.field, op: event.target.value as 'equals' | 'contains' } })}>
                <option value="equals">equals</option>
                <option value="contains">contains</option>
              </Select>
            </Field>
            <Field label="Value">
              <Input disabled={!m.field} value={m.field?.value ?? ''} onChange={(event) => m.field && setMatch({ field: { ...m.field, value: event.target.value } })} />
            </Field>
          </div>
          <Field label="Time of day">
            <Select
              value={window?.mode ?? ''}
              onChange={(event) =>
                setMatch({
                  timeWindow: event.target.value
                    ? { mode: event.target.value as 'business_hours' | 'after_hours', timeZone: window?.timeZone ?? 'Africa/Johannesburg', days: window?.days ?? [1, 2, 3, 4, 5], startHour: window?.startHour ?? 8, endHour: window?.endHour ?? 17 }
                    : undefined,
                })
              }
            >
              <option value="">Any time</option>
              <option value="business_hours">Only during working hours</option>
              <option value="after_hours">Only outside working hours</option>
            </Select>
          </Field>
          {window && (
            <div className="grid gap-3 sm:grid-cols-[1fr_6rem_6rem_12rem]">
              <Field label="Working days">
                <div className="flex flex-wrap gap-2">
                  {WEEKDAY_SHORT.map((label, day) => (
                    <Checkbox
                      key={label}
                      label={label}
                      checked={window.days.includes(day)}
                      onChange={(event) =>
                        setMatch({ timeWindow: { ...window, days: event.target.checked ? [...window.days, day].sort() : window.days.filter((d) => d !== day) } })
                      }
                    />
                  ))}
                </div>
              </Field>
              <Field label="From">
                <Input type="number" min={0} max={23} value={window.startHour} onChange={(event) => setMatch({ timeWindow: { ...window, startHour: Number(event.target.value) } })} />
              </Field>
              <Field label="Until">
                <Input type="number" min={1} max={24} value={window.endHour} onChange={(event) => setMatch({ timeWindow: { ...window, endHour: Number(event.target.value) } })} />
              </Field>
              <Field label="Time zone">
                <Input value={window.timeZone} onChange={(event) => setMatch({ timeWindow: { ...window, timeZone: event.target.value } })} />
              </Field>
            </div>
          )}
        </section>

        <section className="space-y-3 rounded-md border p-3 surface-2">
          <p className="text-xs font-semibold">Then…</p>
          <Checkbox
            label="Drop the alert"
            hint="Record nothing and page nobody. It still counts as received on its source."
            checked={Boolean(a.drop)}
            onChange={(event) => setActions({ drop: event.target.checked })}
          />
          {!a.drop && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Route to department">
                  <Select value={a.teamId ?? ''} onChange={(event) => setActions({ teamId: event.target.value || null })}>
                    <option value="">Keep the source's team</option>
                    {teams.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Escalation policy" hint={a.teamId ? 'Blank uses the department default.' : undefined}>
                  <Select value={a.escalationPolicyId ?? ''} onChange={(event) => setActions({ escalationPolicyId: event.target.value || null })}>
                    <option value="">{a.teamId ? "The department's default" : 'Keep as routed'}</option>
                    {policies.map((policy) => (
                      <option key={policy.id} value={policy.id}>
                        {policy.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Set severity">
                  <Select value={a.severity ?? ''} onChange={(event) => setActions({ severity: (event.target.value || null) as Severity | null })}>
                    <option value="">Keep</option>
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {s.toUpperCase()}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Add tags" hint="Comma-separated, added to the incident ticket.">
                <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="website, customer-facing" />
              </Field>
              <Checkbox
                label="Ticket only, page nobody"
                checked={Boolean(a.suppressPaging)}
                onChange={(event) => setActions({ suppressPaging: event.target.checked })}
              />
            </>
          )}
        </section>

        <div className="flex flex-wrap gap-4">
          <Checkbox label="Enabled" checked={rule.enabled} onChange={(event) => setRule((r) => ({ ...r, enabled: event.target.checked }))} />
          <Checkbox
            label="Keep evaluating later rules"
            hint="Later matching rules add tags and override what this one set."
            checked={rule.continueEvaluating}
            onChange={(event) => setRule((r) => ({ ...r, continueEvaluating: event.target.checked }))}
          />
        </div>
      </div>
    </Modal>
  );
}

function RuleTester({
  monitors,
  sources,
  names,
}: {
  monitors: Monitor[];
  sources: AlertSource[];
  names: { team: (id: string) => string; policy: (id: string) => string };
}) {
  const [sample, setSample] = useState({ title: 'Checkout website is down', summary: '', severity: 'sev2', sourceId: '', payload: '' });
  const [outcome, setOutcome] = useState<RoutingOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setOutcome(
        (
          await opsApi.alertRules.test({
            title: sample.title,
            summary: sample.summary,
            severity: sample.severity,
            sourceId: sample.sourceId || undefined,
            payload: sample.payload.trim() || undefined,
          })
        ).outcome,
      );
    } catch (caught) {
      setOutcome(null);
      setError(message(caught, 'The test failed.'));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="rounded-md border surface">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <FlaskConical className="size-3.5 text-subtle" />
        <p className="text-xs font-semibold">Try a sample alert</p>
        <p className="text-2xs text-subtle">Shows which rule would match. Nothing is created.</p>
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <Field label="Title">
          <Input value={sample.title} onChange={(event) => setSample((s) => ({ ...s, title: event.target.value }))} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Severity">
            <Select value={sample.severity} onChange={(event) => setSample((s) => ({ ...s, severity: event.target.value }))}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From">
            <Select value={sample.sourceId} onChange={(event) => setSample((s) => ({ ...s, sourceId: event.target.value }))}>
              <option value="">No particular source</option>
              {monitors.map((m) => (
                <option key={m.id} value={m.id}>
                  Monitor: {m.name}
                </option>
              ))}
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  Source: {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Summary">
          <Textarea rows={2} value={sample.summary} onChange={(event) => setSample((s) => ({ ...s, summary: event.target.value }))} />
        </Field>
        <Field label="Payload (JSON, optional)">
          <Textarea rows={2} className="font-mono text-xs" value={sample.payload} onChange={(event) => setSample((s) => ({ ...s, payload: event.target.value }))} placeholder='{"labels": {"service": "checkout"}}' />
        </Field>
      </div>
      <div className="flex flex-wrap items-start gap-3 border-t px-4 py-3">
        <Button variant="secondary" size="sm" loading={running} onClick={run}>
          Test routing
        </Button>
        {error && <p className="text-xs text-[var(--priority-urgent)]">{error}</p>}
        {outcome && (
          <div className="min-w-0 flex-1 text-xs">
            <p className="font-medium">{outcome.explanation}</p>
            {!outcome.drop && (
              <p className="mt-0.5 text-muted">
                Department: {outcome.teamId ? names.team(outcome.teamId) : 'none'} · Policy:{' '}
                {outcome.escalationPolicyId ? names.policy(outcome.escalationPolicyId) : outcome.teamId ? "the department's default" : 'none'} · Severity{' '}
                {outcome.severity.toUpperCase()}
                {outcome.tags.length > 0 && ` · Tags: ${outcome.tags.join(', ')}`}
                {outcome.suppressPaging && ' · Nobody paged'}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
