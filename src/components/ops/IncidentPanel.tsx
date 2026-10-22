import { useCallback, useEffect, useState } from 'react';
import { BellRing, ChevronDown, ChevronRight, PhoneCall } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { opsApi } from '@/lib/ops-api';
import { relativeTime, shortDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import {
  NOTIFY_CHANNEL_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  type Alert,
  type EscalationPolicy,
  type Page,
  type PageStatus,
  type Severity,
} from '@shared/ops';
import type { TicketDetail } from '@shared/types';

export const SEVERITY_COLORS: Record<Severity, string> = {
  sev1: 'var(--priority-urgent)',
  sev2: 'var(--priority-high)',
  sev3: 'var(--priority-normal)',
  sev4: 'var(--priority-low)',
};

const PAGE_STATUS_COLORS: Record<PageStatus, string> = {
  triggered: 'var(--priority-urgent)',
  acknowledged: 'var(--status-progress)',
  resolved: 'var(--status-resolved)',
  exhausted: 'var(--priority-high)',
};

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <Badge color={SEVERITY_COLORS[severity]} className={className}>
      {severity.toUpperCase()}
    </Badge>
  );
}

interface Person {
  id: string;
  name: string;
  role: string;
}

/**
 * The incident side of a ticket: severity, commander, the alerts behind it
 * and every page sent about it. Shown for incidents, and for any ticket that
 * has alerts or pages attached.
 */
export function IncidentPanel({
  ticket,
  directory,
  editable,
  busy,
  onPatch,
  onChanged,
}: {
  ticket: TicketDetail;
  directory: Person[];
  editable: boolean;
  busy: boolean;
  onPatch: (body: Record<string, unknown>, message: string) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const canPage = useAuth().can('tickets.page');
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pageOpen, setPageOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [alertResult, pageResult] = await Promise.all([
        opsApi.alerts.list({ ticketId: ticket.id }),
        opsApi.pages.list({ ticketId: ticket.id, filter: 'all' }),
      ]);
      setAlerts(alertResult.alerts);
      setPages(pageResult.pages);
    } catch {
      // The ticket itself still renders; the incident details are a bonus.
    } finally {
      setLoaded(true);
    }
  }, [ticket.id]);

  useEffect(() => {
    void load();
  }, [load, ticket.updatedAt]);

  const isIncident = ticket.type === 'incident' || Boolean(ticket.severity);
  if (!loaded || (!isIncident && alerts.length === 0 && pages.length === 0)) return null;

  const act = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      toast.success(message);
      await Promise.all([load(), onChanged()]);
    } catch (caught) {
      toast.error('That did not work', caught instanceof ApiError ? caught.message : undefined);
    }
  };

  return (
    <section className="space-y-3 border-b px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold">
          <BellRing className="size-3.5 text-[var(--priority-urgent)]" />
          Incident
        </h2>
        {canPage && (
          <Button size="sm" variant="secondary" onClick={() => setPageOpen(true)}>
            <PhoneCall className="size-3.5" />
            Page someone
          </Button>
        )}
      </div>

      <Field label="Severity">
        <Select
          value={ticket.severity ?? ''}
          disabled={!editable || busy}
          onChange={(event) =>
            void onPatch({ severity: event.target.value || null }, event.target.value ? `Severity set to ${event.target.value.toUpperCase()}` : 'Severity cleared')
          }
        >
          <option value="">Not set</option>
          {SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>
              {SEVERITY_LABELS[severity]}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Incident commander">
        <Select
          value={ticket.commanderId ?? ''}
          disabled={!editable || busy}
          onChange={(event) => void onPatch({ commanderId: event.target.value || null }, 'Incident commander updated')}
        >
          <option value="">Nobody yet</option>
          {directory
            .filter((person) => person.role !== 'viewer')
            .map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
        </Select>
      </Field>

      {pages.length > 0 && (
        <div className="space-y-2">
          <p className="eyebrow">Pages</p>
          {pages.map((page) => (
            <PageCard
              key={page.id}
              page={page}
              onAck={() => act(() => opsApi.pages.ack(page.id), 'Acknowledged. Escalation stopped.')}
              onEscalate={() => act(() => opsApi.pages.escalate(page.id), 'Escalated to the next level')}
            />
          ))}
        </div>
      )}

      {alerts.length > 0 && (
        <div className="space-y-1.5">
          <p className="eyebrow">Alerts ({alerts.length})</p>
          <ul className="space-y-1.5">
            {alerts.map((alert) => (
              <li key={alert.id} className="rounded-sm border px-2.5 py-2 surface-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-xs font-medium break-words">{alert.title}</p>
                  <Badge color={alert.status === 'resolved' ? 'var(--status-resolved)' : 'var(--priority-urgent)'} className="shrink-0">
                    {alert.status}
                  </Badge>
                </div>
                <p className="mt-0.5 text-2xs text-subtle">
                  {alert.sourceName} · {alert.count > 1 ? `${alert.count}× · ` : ''}
                  {relativeTime(alert.lastSeenAt)}
                  {alert.suppressed ? ' · paging suppressed (maintenance)' : ''}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <PageSomeoneDialog
        open={pageOpen}
        defaultSeverity={ticket.severity ?? 'sev2'}
        onClose={() => setPageOpen(false)}
        onSubmit={async (policyId, severity) => {
          await act(() => opsApi.pages.trigger(ticket.id, { policyId, severity }), 'Paging started');
          setPageOpen(false);
        }}
      />
    </section>
  );
}

function PageCard({ page, onAck, onEscalate }: { page: Page; onAck: () => Promise<void>; onEscalate: () => Promise<void> }) {
  const { user, can } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<Page | null>(null);
  const [working, setWorking] = useState<'ack' | 'esc' | null>(null);
  const live = page.status === 'triggered';
  const canRespond = can('pages.respond', 'oncall.manage');
  const pagingMe = Boolean(user && page.currentTargetIds.includes(user.id));

  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !detail) {
      try {
        setDetail((await opsApi.pages.get(page.id)).page);
      } catch {
        // Shown as "no attempts" below.
      }
    }
  };

  const run = async (kind: 'ack' | 'esc', fn: () => Promise<void>) => {
    setWorking(kind);
    try {
      await fn();
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className={cn('rounded-sm border px-2.5 py-2', live ? 'border-[var(--priority-urgent)]/40 bg-[var(--priority-urgent)]/5' : 'surface-2')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Badge color={PAGE_STATUS_COLORS[page.status]}>{page.status}</Badge>
          <span className="text-2xs text-subtle">
            {page.policyName ?? 'Policy deleted'} · level {page.currentLevel + 1}
            {page.cycle > 0 ? ` · pass ${page.cycle + 1}` : ''}
          </span>
        </div>
        {live && canRespond && (
          <div className="flex gap-1.5">
            <Button size="sm" variant={pagingMe ? 'danger' : 'primary'} loading={working === 'ack'} onClick={() => run('ack', onAck)}>
              Acknowledge
            </Button>
            <Button size="sm" variant="ghost" loading={working === 'esc'} onClick={() => run('esc', onEscalate)}>
              Escalate
            </Button>
          </div>
        )}
      </div>
      {page.acknowledgedByName && (
        <p className="mt-1 text-2xs text-subtle">
          Acknowledged by {page.acknowledgedByName} {relativeTime(page.acknowledgedAt)}
        </p>
      )}
      <button
        onClick={() => void toggle()}
        className="mt-1.5 inline-flex items-center gap-1 text-2xs font-medium text-[var(--accent)] hover:underline"
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        Why was I paged?
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-2 text-2xs">
          <p className="leading-relaxed text-muted">{page.reason || 'Paged by hand.'}</p>
          {detail?.policy && (
            <ol className="space-y-0.5 text-muted">
              {detail.policy.levels.map((level, index) => (
                <li key={level.id} className={cn(index === page.currentLevel && 'font-medium text-[var(--fg)]')}>
                  Level {index + 1}: {level.targets.map((target) => target.name ?? target.id).join(', ')} — escalates after {level.delayMins} min
                </li>
              ))}
            </ol>
          )}
          {detail?.attempts && detail.attempts.length > 0 ? (
            <ul className="divide-y rounded-sm border surface">
              {detail.attempts.map((attempt) => (
                <li key={attempt.id} className="px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">
                      {attempt.userName ?? 'Someone'} · {NOTIFY_CHANNEL_LABELS[attempt.channel]}
                      {attempt.seq > 0 ? ` #${attempt.seq + 1}` : ''}
                    </span>
                    <span className="shrink-0 text-subtle">{shortDateTime(attempt.createdAt)}</span>
                  </div>
                  <p className="text-subtle">
                    {attempt.status}
                    {attempt.detail ? ` — ${attempt.detail}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            detail && <p className="text-subtle">No notifications sent yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

function PageSomeoneDialog({
  open,
  defaultSeverity,
  onClose,
  onSubmit,
}: {
  open: boolean;
  defaultSeverity: Severity;
  onClose: () => void;
  onSubmit: (policyId: string, severity: Severity) => Promise<void>;
}) {
  const [policies, setPolicies] = useState<EscalationPolicy[] | null>(null);
  const [policyId, setPolicyId] = useState('');
  const [severity, setSeverity] = useState<Severity>(defaultSeverity);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSeverity(defaultSeverity);
    void opsApi.policies
      .list()
      .then((result) => {
        setPolicies(result.policies);
        setPolicyId((current) => current || result.policies[0]?.id || '');
      })
      .catch(() => setPolicies([]));
  }, [open, defaultSeverity]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Page someone about this ticket"
      description="Runs an escalation policy until someone acknowledges."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!policyId}
            loading={submitting}
            onClick={async () => {
              setSubmitting(true);
              try {
                await onSubmit(policyId, severity);
              } finally {
                setSubmitting(false);
              }
            }}
          >
            Start paging
          </Button>
        </>
      }
    >
      {policies && policies.length === 0 ? (
        <p className="text-xs text-muted">No escalation policies yet. Create one under On-call first.</p>
      ) : (
        <div className="space-y-3">
          <Field label="Escalation policy">
            <Select value={policyId} onChange={(event) => setPolicyId(event.target.value)}>
              {(policies ?? []).map((policy) => (
                <option key={policy.id} value={policy.id}>
                  {policy.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Severity" hint="SEV1 and SEV2 are high urgency: SMS and phone calls.">
            <Select value={severity} onChange={(event) => setSeverity(event.target.value as Severity)}>
              {SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {SEVERITY_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </Modal>
  );
}
