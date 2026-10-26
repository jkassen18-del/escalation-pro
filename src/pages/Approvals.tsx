import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { PRIORITY_LABELS, relativeTime, TYPE_LABELS } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { Field, Input, Select, SegmentedControl, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/state/auth';
import { useDocumentTitle } from '@/state/branding';
import { useDepartment } from '@/state/department';
import { APPROVAL_FIELD_OPS, type ApprovalFieldOp, type ApprovalRule, type ApproverSpec } from '@shared/approvals';
import { TICKET_PRIORITIES, TICKET_TYPES, type Role } from '@shared/types';

type Directory = Awaited<ReturnType<typeof api.users.directory>>['users'];
type Waiting = Awaited<ReturnType<typeof api.approvals.mine>>['approvals'];
type RuleDraft = Omit<ApprovalRule, 'id' | 'position'> & { id?: string };

const OP_LABELS: Record<ApprovalFieldOp, string> = { gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most', eq: 'equals', contains: 'contains' };

const EXAMPLES: Array<{ label: string; draft: Partial<RuleDraft> }> = [
  { label: 'Marketing sign-off', draft: { name: 'Marketing sign-off', conditions: { tags: ['campaign', 'artwork'] }, approvers: [{ kind: 'department_managers' }] } },
  { label: 'Finance limit', draft: { name: 'Payments over R50 000', conditions: { field: { key: 'amount', op: 'gt', value: '50000' } }, approvers: [{ kind: 'department_managers' }] } },
  { label: 'Access request', draft: { name: 'Access request', conditions: { keywords: ['access', 'permission', 'admin rights'], types: ['request'] }, approvers: [{ kind: 'shift_leader' }] } },
];

const blank = (teamId: string | null): RuleDraft => ({
  teamId,
  name: '',
  enabled: true,
  conditions: {},
  approvers: [{ kind: 'department_managers' }],
  mode: 'any',
  onReject: 'close',
});

export function ApprovalsPage() {
  useDocumentTitle('Approvals');
  const { current, departments } = useDepartment();
  const { user, can } = useAuth();
  const toast = useToast();
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [directory, setDirectory] = useState<Directory>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [editing, setEditing] = useState<RuleDraft | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});

  const manageable = useMemo(
    () => departments.filter((team) => can('approvals.manage') || user?.managedTeamIds.includes(team.id)),
    [departments, can, user],
  );
  const canManageRules = can('approvals.manage') || manageable.length > 0;

  const load = useCallback(async () => {
    setError(null);
    try {
      const [mine, ruleList] = await Promise.all([api.approvals.mine(), api.approvals.rules(current?.id)]);
      setWaiting(mine.approvals);
      setRules(ruleList.rules);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load approvals.');
    }
  }, [current]);

  useEffect(() => {
    void load();
    void api.users.directory().then((result) => setDirectory(result.users)).catch(() => undefined);
    void api.roles.list().then((result) => setRoles(result.roles)).catch(() => undefined);
  }, [load]);

  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    try {
      await api.approvals.decide(id, decision, comments[id] || undefined);
      toast.success(decision === 'approved' ? 'Approved' : 'Rejected');
      void load();
    } catch (caught) {
      toast.error('Could not record that', caught instanceof ApiError ? caught.message : undefined);
    }
  };

  const remove = async (rule: ApprovalRule) => {
    if (!window.confirm(`Remove the rule "${rule.name}"? Tickets already waiting keep their requests.`)) return;
    await api.approvals.deleteRule(rule.id);
    void load();
  };

  const teamName = (id: string | null) => (id ? (departments.find((team) => team.id === id)?.name ?? 'Unknown department') : 'Every department');

  return (
    <div>
      <PageHeader title="Approvals" description="Sign-off before work starts: Marketing artwork, Finance limits, access requests. Approve here, on the ticket, or from Slack and Teams." />
      {error ? (
        <ErrorPane message={error} retry={load} />
      ) : !waiting ? (
        <LoadingPane label="Loading approvals" />
      ) : (
        <div className="space-y-8 p-4 sm:p-6">
          <section>
            <h2 className="mb-2 text-sm font-semibold">Waiting on you</h2>
            {waiting.length === 0 ? (
              <EmptyState icon={BadgeCheck} title="Nothing to approve" description="Requests for your sign-off show here." />
            ) : (
              <ul className="space-y-2">
                {waiting.map((approval) => (
                  <li key={approval.id} className="rounded-md border p-3 surface">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold">{approval.title}</p>
                        <Link to={`/tickets/${approval.ticketId}`} className="text-xs text-[var(--accent)] hover:underline">
                          {approval.reference} · {approval.subject}
                        </Link>
                        <p className="mt-0.5 text-2xs text-subtle">
                          {approval.teamName ?? 'No department'} · {approval.ruleId ? 'by rule' : `asked by ${approval.requestedByName ?? 'someone'}`} · {relativeTime(approval.createdAt)}
                        </p>
                        {approval.note && <p className="mt-1 text-xs text-muted">{approval.note}</p>}
                      </div>
                      <div className="flex w-full max-w-sm flex-col gap-1.5">
                        <Textarea
                          rows={1}
                          value={comments[approval.id] ?? ''}
                          onChange={(event) => setComments((all) => ({ ...all, [approval.id]: event.target.value }))}
                          placeholder="Comment (optional)"
                        />
                        <div className="flex justify-end gap-1.5">
                          <Button size="sm" variant="primary" onClick={() => void decide(approval.id, 'approved')}>
                            <Check className="size-3.5" /> Approve
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => void decide(approval.id, 'rejected')}>
                            Reject
                          </Button>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {canManageRules && (
            <section>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold">Rules{current ? ` · ${current.name}` : ''}</h2>
                  <p className="text-xs text-muted">A new ticket that matches a rule starts out waiting for its approvers. It cannot be started or resolved until it is approved.</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {EXAMPLES.map((example) => (
                    <Button key={example.label} size="sm" variant="ghost" onClick={() => setEditing({ ...blank(current?.id ?? manageable[0]?.id ?? null), ...example.draft })}>
                      {example.label}
                    </Button>
                  ))}
                  <Button size="sm" onClick={() => setEditing(blank(current?.id ?? (can('approvals.manage') ? null : (manageable[0]?.id ?? null))))}>
                    <Plus className="size-3.5" /> New rule
                  </Button>
                </div>
              </div>
              {rules.length === 0 ? (
                <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted">No rules yet. Start from one of the examples.</p>
              ) : (
                <ul className="divide-y rounded-md border surface">
                  {rules.map((rule) => (
                    <li key={rule.id} className="flex items-start justify-between gap-3 p-3">
                      <div className="min-w-0">
                        <p className={cn('text-sm font-semibold', !rule.enabled && 'text-subtle line-through')}>{rule.name}</p>
                        <p className="text-xs text-muted">{describeRule(rule, directory, roles)}</p>
                        <p className="text-2xs text-subtle">{teamName(rule.teamId)}</p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button variant="ghost" size="icon" onClick={() => setEditing({ ...rule })} aria-label={`Edit ${rule.name}`}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => void remove(rule)} aria-label={`Remove ${rule.name}`}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
      {editing && (
        <RuleEditor
          draft={editing}
          departments={can('approvals.manage') ? departments : manageable}
          allowOrgWide={can('approvals.manage')}
          directory={directory}
          roles={roles}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function describeApprover(spec: ApproverSpec, directory: Directory, roles: Role[]): string {
  if (spec.kind === 'user') return directory.find((person) => person.id === spec.userId)?.name ?? 'a former user';
  if (spec.kind === 'role') return `anyone with the ${roles.find((role) => role.id === spec.roleId)?.name ?? 'chosen'} role`;
  return spec.kind === 'shift_leader' ? 'the shift leader' : 'department managers';
}

function describeRule(rule: ApprovalRule, directory: Directory, roles: Role[]): string {
  const c = rule.conditions;
  const when = [
    c.types?.length ? c.types.map((type) => TYPE_LABELS[type as keyof typeof TYPE_LABELS] ?? type).join(' or ') : null,
    c.priorities?.length ? `${c.priorities.join('/')} priority` : null,
    c.tags?.length ? `labelled ${c.tags.join(' or ')}` : null,
    c.keywords?.length ? `mentioning ${c.keywords.map((word) => `"${word}"`).join(' or ')}` : null,
    c.templateIds?.length ? 'from chosen quick tickets' : null,
    c.field ? `${c.field.key} ${OP_LABELS[c.field.op]} ${c.field.value}` : null,
  ].filter(Boolean);
  const who = rule.approvers.map((spec) => describeApprover(spec, directory, roles)).join(', ');
  return `${when.length ? `Tickets ${when.join(', ')}` : 'Every new ticket'} → ${rule.mode === 'all' ? 'all of' : 'any of'} ${who}${rule.onReject === 'close' ? '; a rejection closes it' : ''}`;
}

const list = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

function RuleEditor({
  draft,
  departments,
  allowOrgWide,
  directory,
  roles,
  onClose,
  onSaved,
}: {
  draft: RuleDraft;
  departments: Array<{ id: string; name: string }>;
  allowOrgWide: boolean;
  directory: Directory;
  roles: Role[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [rule, setRule] = useState<RuleDraft>(draft);
  const [tags, setTags] = useState((draft.conditions.tags ?? []).join(', '));
  const [keywords, setKeywords] = useState((draft.conditions.keywords ?? []).join(', '));
  const [saving, setSaving] = useState(false);
  const [person, setPerson] = useState('');
  const set = (patch: Partial<RuleDraft>) => setRule((current) => ({ ...current, ...patch }));
  const setConditions = (patch: Partial<RuleDraft['conditions']>) => setRule((current) => ({ ...current, conditions: { ...current.conditions, ...patch } }));
  const toggle = (key: 'types' | 'priorities', value: string) => {
    const currentValues = rule.conditions[key] ?? [];
    setConditions({ [key]: currentValues.includes(value) ? currentValues.filter((item) => item !== value) : [...currentValues, value] });
  };
  const hasApprover = (kind: ApproverSpec['kind']) => rule.approvers.some((spec) => spec.kind === kind);
  const toggleKind = (kind: 'department_managers' | 'shift_leader') =>
    set({ approvers: hasApprover(kind) ? rule.approvers.filter((spec) => spec.kind !== kind) : [...rule.approvers, { kind }] });

  const save = async () => {
    setSaving(true);
    const body = { ...rule, conditions: { ...rule.conditions, tags: list(tags), keywords: list(keywords) } };
    delete (body as { id?: string }).id;
    try {
      if (rule.id) await api.approvals.updateRule(rule.id, body);
      else await api.approvals.createRule(body);
      toast.success('Rule saved');
      onSaved();
    } catch (caught) {
      toast.error('Could not save the rule', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={rule.id ? 'Edit approval rule' : 'New approval rule'}
      description="Leave a condition empty to ignore it. Every condition you fill in has to match."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!rule.name.trim() || !rule.approvers.length}>
            Save rule
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input value={rule.name} onChange={(event) => set({ name: event.target.value })} placeholder="e.g. Payments over R50 000" />
          </Field>
          <Field label="Applies to">
            <Select value={rule.teamId ?? ''} onChange={(event) => set({ teamId: event.target.value || null })}>
              {allowOrgWide && <option value="">Every department</option>}
              {departments.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <fieldset className="space-y-3 rounded-md border p-3">
          <legend className="px-1 text-xs font-semibold">When a new ticket…</legend>
          <div className="flex flex-wrap gap-1.5">
            {TICKET_TYPES.map((type) => (
              <Chip key={type} on={Boolean(rule.conditions.types?.includes(type))} onClick={() => toggle('types', type)}>
                {TYPE_LABELS[type]}
              </Chip>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {TICKET_PRIORITIES.map((priority) => (
              <Chip key={priority} on={Boolean(rule.conditions.priorities?.includes(priority))} onClick={() => toggle('priorities', priority)}>
                {PRIORITY_LABELS[priority]}
              </Chip>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Has any of these labels" hint="Comma separated">
              <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="campaign, artwork" />
            </Field>
            <Field label="Mentions any of these words" hint="Subject or description">
              <Input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="access, admin rights" />
            </Field>
          </div>
          <Field label="Form answer" hint="A department form question's key, e.g. amount">
            <div className="flex flex-wrap gap-2">
              <Input
                className="w-36"
                value={rule.conditions.field?.key ?? ''}
                onChange={(event) =>
                  setConditions({ field: event.target.value ? { key: event.target.value, op: rule.conditions.field?.op ?? 'gt', value: rule.conditions.field?.value ?? '' } : null })
                }
                placeholder="amount"
              />
              <Select
                className="w-36"
                value={rule.conditions.field?.op ?? 'gt'}
                disabled={!rule.conditions.field}
                onChange={(event) => rule.conditions.field && setConditions({ field: { ...rule.conditions.field, op: event.target.value as ApprovalFieldOp } })}
              >
                {APPROVAL_FIELD_OPS.map((op) => (
                  <option key={op} value={op}>
                    {OP_LABELS[op]}
                  </option>
                ))}
              </Select>
              <Input
                className="w-36"
                value={rule.conditions.field?.value ?? ''}
                disabled={!rule.conditions.field}
                onChange={(event) => rule.conditions.field && setConditions({ field: { ...rule.conditions.field, value: event.target.value } })}
                placeholder="50000"
              />
            </div>
          </Field>
        </fieldset>

        <fieldset className="space-y-3 rounded-md border p-3">
          <legend className="px-1 text-xs font-semibold">…it needs approval from</legend>
          <div className="flex flex-wrap gap-1.5">
            <Chip on={hasApprover('department_managers')} onClick={() => toggleKind('department_managers')}>
              Department managers
            </Chip>
            <Chip on={hasApprover('shift_leader')} onClick={() => toggleKind('shift_leader')}>
              Shift leader on duty
            </Chip>
            {rule.approvers.map((spec, index) =>
              spec.kind === 'user' || spec.kind === 'role' ? (
                <Chip key={index} on onClick={() => set({ approvers: rule.approvers.filter((_, i) => i !== index) })}>
                  {describeApprover(spec, directory, roles)} ×
                </Chip>
              ) : null,
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Select
              className="w-56"
              value={person}
              onChange={(event) => {
                const value = event.target.value;
                setPerson('');
                if (!value) return;
                const [kind, id] = value.split(':');
                const spec: ApproverSpec = kind === 'role' ? { kind: 'role', roleId: id } : { kind: 'user', userId: id };
                set({ approvers: [...rule.approvers, spec] });
              }}
            >
              <option value="">Add a person or role…</option>
              {roles.length > 0 && (
                <optgroup label="Roles">
                  {roles.map((role) => (
                    <option key={role.id} value={`role:${role.id}`}>
                      {role.name}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="People">
                {directory.map((entry) => (
                  <option key={entry.id} value={`user:${entry.id}`}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
            </Select>
            <SegmentedControl
              value={rule.mode}
              onChange={(mode) => set({ mode })}
              options={[
                { value: 'any', label: 'Any one' },
                { value: 'all', label: 'Everyone' },
              ]}
            />
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-4">
          <SegmentedControl
            value={rule.onReject}
            onChange={(onReject) => set({ onReject })}
            options={[
              { value: 'close', label: 'A rejection closes the ticket' },
              { value: 'keep_open', label: 'A rejection keeps it open' },
            ]}
          />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={rule.enabled} onChange={(event) => set({ enabled: event.target.checked })} />
            Turned on
          </label>
        </div>
      </div>
    </Modal>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
        on ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]' : 'text-muted hover:text-[var(--fg)]',
      )}
    >
      {children}
    </button>
  );
}
