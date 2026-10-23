import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowUpRight,
  ChevronLeft,
  Eye,
  EyeOff,
  Lock,
  MoreHorizontal,
  Paperclip,
  Send,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
  fileSize,
  fullDateTime,
  relativeTime,
  shortDateTime,
  slaRemaining,
} from '@/lib/format';
import { useAuth } from '@/state/auth';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { RichText } from '@/components/ui/RichText';
import { CustomFieldSummary } from '@/components/CustomFieldInputs';
import { RichTextEditor } from '@/components/ui/RichTextEditor';
import { PriorityBadge, Reference, StatusBadge, TypeLabel } from '@/components/ui/Badge';
import { Avatar, UserChip } from '@/components/ui/Avatar';
import { ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { ConfirmDialog } from '@/components/ui/Modal';
import { Menu } from '@/components/ui/Menu';
import {
  TERMINAL_STATUSES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  statusPermission,
  type Team,
  type TicketDetail as TicketDetailType,
} from '@shared/types';
import { useDocumentTitle } from '@/state/branding';
import { IncidentPanel, SeverityBadge } from '@/components/ops/IncidentPanel';
import { EscalateDialog } from '@/components/EscalateDialog';
import { NotifyOnCall, useOnCall } from '@/components/NotifyOnCall';
import { LabelChip, LabelPicker, labelFor, useTeamLabels } from '@/components/Labels';

type Directory = Awaited<ReturnType<typeof api.users.directory>>['users'];

export function TicketDetailPage() {
  useDocumentTitle('Ticket');
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user, can } = useAuth();

  const [ticket, setTicket] = useState<TicketDetailType | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [directory, setDirectory] = useState<Directory>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const location = useLocation();
  // Set by the new-ticket forms, so the on-call prompt shows once, right after raising it.
  const [justCreated, setJustCreated] = useState(Boolean((location.state as { justCreated?: boolean } | null)?.justCreated));
  const onCall = useOnCall(id, ticket?.teamId ?? null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.tickets.get(id);
      setTicket(result.ticket);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this ticket.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void Promise.all([api.teams.list(), api.users.directory()])
      .then(([teamResult, directoryResult]) => {
        setTeams(teamResult.teams);
        setDirectory(directoryResult.users);
      })
      .catch(() => undefined);
  }, []);

  const patch = async (body: Record<string, unknown>, successMessage: string) => {
    if (!ticket) return;
    setBusy(true);
    try {
      await api.tickets.update(ticket.id, body);
      await load();
      toast.success(successMessage);
    } catch (caught) {
      toast.error('Update failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingPane label="Loading ticket" />;
  if (error) return <ErrorPane message={error} retry={load} />;
  if (!ticket) return null;

  const isTerminal = TERMINAL_STATUSES.includes(ticket.status);
  const sla = slaRemaining(ticket.dueAt, isTerminal);
  const watching = user ? ticket.watcherIds.includes(user.id) : false;
  const editable = can('tickets.update');
  // Resolve/Reopen from the header follows the same rule as the status field.
  const canResolve = can(statusPermission(ticket.status, isTerminal ? 'open' : 'resolved'));
  const canCloseOrReopen = can(statusPermission(ticket.status, ticket.status === 'closed' ? 'open' : 'closed'));
  const linearLink = ticket.links.find((link) => link.provider === 'linear');

  return (
    <div className="mx-auto max-w-[80rem]">
      <div className="border-b px-4 py-3 surface sm:px-6">
        <Link
          to="/tickets"
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted hover:text-[var(--fg)]"
        >
          <ChevronLeft className="size-3.5" />
          Back to tickets
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Reference value={ticket.reference} className="text-xs" />
              <StatusBadge status={ticket.status} />
              <PriorityBadge priority={ticket.priority} />
              <TypeLabel type={ticket.type} className="text-2xs" />
              {ticket.severity && <SeverityBadge severity={ticket.severity} />}
              {ticket.templateName && (
                <span className="rounded-[3px] border px-1.5 py-0.5 text-2xs text-muted" title="Raised as a quick ticket">
                  {ticket.templateName}
                </span>
              )}
              {ticket.escalationLevel > 0 && (
                <span className="rounded-[3px] border border-[var(--priority-urgent)]/35 bg-[var(--priority-urgent)]/8 px-1.5 py-0.5 text-2xs font-semibold text-[var(--priority-urgent)]">
                  Escalation level {ticket.escalationLevel}
                </span>
              )}
              {sla.breached && (
                <span className="inline-flex items-center gap-1 text-2xs font-medium text-[var(--priority-urgent)]">
                  <TriangleAlert className="size-3" />
                  SLA {sla.label}
                </span>
              )}
            </div>
            <h1 className="mt-1.5 text-lg leading-snug font-semibold tracking-tight">{ticket.subject}</h1>
            <p className="mt-1 text-xs text-subtle">
              Opened by {requesterLabel(ticket)} · {relativeTime(ticket.createdAt)} · last activity{' '}
              {relativeTime(ticket.updatedAt)}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await api.tickets.watch(ticket.id, !watching);
                await load();
              }}
            >
              {watching ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              {watching ? 'Unwatch' : 'Watch'}
            </Button>

            {can('tickets.escalate') && !isTerminal && (
              <Button variant="secondary" size="sm" onClick={() => setEscalateOpen(true)}>
                <TriangleAlert className="size-3.5" />
                Escalate
              </Button>
            )}

            {canResolve && (
              <Button
                variant="primary"
                size="sm"
                loading={busy}
                onClick={() =>
                  patch(
                    { status: isTerminal ? 'open' : 'resolved' },
                    isTerminal ? 'Ticket reopened.' : 'Ticket resolved.',
                  )
                }
              >
                {isTerminal ? 'Reopen' : 'Resolve'}
              </Button>
            )}

            <Menu
              trigger={({ toggle }) => (
                <Button variant="ghost" size="icon" onClick={toggle} aria-label="More actions">
                  <MoreHorizontal className="size-4" />
                </Button>
              )}
              items={[
                ...(can('tickets.push_linear') && !linearLink
                  ? [
                      {
                        label: 'Create Linear issue',
                        icon: ArrowUpRight,
                        onSelect: async () => {
                          try {
                            await api.tickets.pushToLinear(ticket.id);
                            await load();
                            toast.success('Linear issue created.');
                          } catch (caught) {
                            toast.error(
                              'Could not create the Linear issue',
                              caught instanceof ApiError ? caught.message : undefined,
                            );
                          }
                        },
                      },
                    ]
                  : []),
                ...(canCloseOrReopen
                  ? [
                      {
                        label: ticket.status === 'closed' ? 'Reopen ticket' : 'Close ticket',
                        icon: Lock,
                        onSelect: () =>
                          patch(
                            { status: ticket.status === 'closed' ? 'open' : 'closed' },
                            ticket.status === 'closed' ? 'Ticket reopened.' : 'Ticket closed.',
                          ),
                      },
                    ]
                  : []),
                ...(can('tickets.delete')
                  ? [{ label: 'Delete ticket', icon: Trash2, destructive: true, onSelect: () => setDeleteOpen(true) }]
                  : []),
              ]}
            />
          </div>
        </div>
      </div>

      <div className="grid items-start lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 surface">
          {justCreated && !isTerminal && (
            <NotifyOnCall
              ticketId={ticket.id}
              teamName={ticket.teamName}
              state={onCall}
              variant="banner"
              onDismiss={() => setJustCreated(false)}
              onNotified={() => {
                setJustCreated(false);
                void load();
              }}
            />
          )}
          <Conversation ticket={ticket} onChanged={load} />
        </div>

        <aside className="border-t surface lg:sticky lg:top-0 lg:border-t-0 lg:border-l">
          {!isTerminal && (
            <NotifyOnCall ticketId={ticket.id} teamName={ticket.teamName} state={onCall} onNotified={() => void load()} />
          )}
          <IncidentPanel
            ticket={ticket}
            directory={directory}
            editable={editable}
            busy={busy}
            onPatch={patch}
            onChanged={load}
          />
          <PropertiesPanel
            ticket={ticket}
            teams={teams}
            directory={directory}
            editable={editable}
            canAssign={can('tickets.assign')}
            canPriority={can('tickets.change_priority')}
            canStatusTo={(next) => can(statusPermission(ticket.status, next))}
            busy={busy}
            onPatch={patch}
          />
        </aside>
      </div>

      <EscalateDialog
        open={escalateOpen}
        onClose={() => setEscalateOpen(false)}
        teams={teams}
        currentTeamId={ticket.teamId}
        currentPriority={ticket.priority}
        onSubmit={async (request) => {
          try {
            await api.tickets.escalate(ticket.id, request);
            setEscalateOpen(false);
            await load();
            const target = request.teamId ? teams.find((team) => team.id === request.teamId)?.name : null;
            toast.success(
              target ? `Escalated to ${target}` : 'Ticket escalated',
              target ? `${target} has been notified.` : 'Everyone watching has been notified.',
            );
          } catch (caught) {
            toast.error('Escalation failed', caught instanceof ApiError ? caught.message : undefined);
          }
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete this ticket?"
        message={`${ticket.reference} and its entire history will be permanently removed. This cannot be undone.`}
        confirmLabel="Delete permanently"
        destructive
        onConfirm={async () => {
          await api.tickets.remove(ticket.id);
          toast.success('Ticket deleted.');
          navigate('/tickets');
        }}
      />
    </div>
  );
}

/* ----------------------------- conversation ------------------------------ */

function Conversation({ ticket, onChanged }: { ticket: TicketDetailType; onChanged: () => Promise<void> }) {
  const { can } = useAuth();
  const toast = useToast();
  const canReply = can('tickets.reply');
  const canNote = can('tickets.comment_internal');
  const [body, setBody] = useState('');
  // Someone who may only write internal notes starts (and stays) on a note.
  const [internal, setInternal] = useState(!canReply && canNote);
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** `<p><br></p>` is what an emptied editor leaves behind, so look at what renders. */
  const hasText = body.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim().length > 0;
  const hasImage = /<img\b/i.test(body);
  const hasBody = hasText || hasImage;

  const submit = async () => {
    if (!hasBody && files.length === 0) return;
    setSending(true);
    try {
      let commentId: string | null = null;
      if (hasBody) {
        ({ commentId } = await api.tickets.comment(ticket.id, { body, bodyFormat: 'html', isInternal: internal }));
      }
      if (files.length) {
        if (internal && !commentId) {
          // Files on their own would be visible to everyone, so an internal
          // note with only files still needs a note to hang them on.
          ({ commentId } = await api.tickets.comment(ticket.id, { body: '<p>Attached files</p>', bodyFormat: 'html', isInternal: true }));
        }
        await api.tickets.upload(ticket.id, files, commentId);
      }
      setBody('');
      setFiles([]);
      await onChanged();
    } catch (caught) {
      toast.error('Could not post', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSending(false);
    }
  };

  // Merge comments and system events into one chronological timeline.
  const timeline = [
    ...ticket.comments.map((comment) => ({ kind: 'comment' as const, at: comment.createdAt, comment })),
    ...ticket.events
      .filter((event) => event.action !== 'created')
      .map((event) => ({ kind: 'event' as const, at: event.createdAt, event })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const unattached = ticket.attachments.filter((attachment) => !attachment.commentId);

  return (
    <div className="px-4 py-4 sm:px-6">
      <article className="rounded-md border p-4 surface-2">
        <header className="mb-2 flex items-center gap-2">
          <Avatar name={requesterLabel(ticket)} size="sm" />
          <span className="text-xs font-medium">{requesterLabel(ticket)}</span>
          <time className="text-2xs text-subtle" dateTime={ticket.createdAt} title={fullDateTime(ticket.createdAt)}>
            {shortDateTime(ticket.createdAt)}
          </time>
        </header>
        <RichText
          value={ticket.description}
          format={ticket.descriptionFormat}
          empty={<span className="text-sm text-subtle italic">No description was provided.</span>}
        />

        {ticket.fieldValues.length > 0 && (
          <div className="mt-4 rounded-sm border border-dashed p-3">
            <CustomFieldSummary values={ticket.fieldValues} />
          </div>
        )}

        {unattached.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5 border-t pt-3">
            {unattached.map((attachment) => (
              <AttachmentChip key={attachment.id} attachment={attachment} />
            ))}
          </div>
        )}
      </article>

      <div className="mt-4 space-y-3">
        {timeline.map((entry) =>
          entry.kind === 'comment' ? (
            <article
              key={entry.comment.id}
              className={cn(
                'rounded-md border p-3',
                entry.comment.isInternal
                  ? 'border-[var(--color-brass-300)]/45 bg-[var(--color-brass-50)] dark:bg-[var(--color-brass-900)]/20'
                  : 'surface',
              )}
            >
              <header className="mb-1.5 flex flex-wrap items-center gap-2">
                <Avatar name={entry.comment.authorName} size="xs" />
                <span className="text-xs font-medium">{entry.comment.authorName}</span>
                {entry.comment.isInternal && (
                  <span className="inline-flex items-center gap-1 rounded-[3px] border border-[var(--color-brass-400)]/50 px-1 text-2xs font-medium text-[var(--color-brass-700)] dark:text-[var(--color-brass-300)]">
                    <Lock className="size-2.5" />
                    Internal note
                  </span>
                )}
                <time
                  className="text-2xs text-subtle"
                  dateTime={entry.comment.createdAt}
                  title={fullDateTime(entry.comment.createdAt)}
                >
                  {shortDateTime(entry.comment.createdAt)}
                </time>
              </header>
              <RichText value={entry.comment.body} format={entry.comment.bodyFormat} />
              {entry.comment.attachments.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {entry.comment.attachments.map((attachment) => (
                    <AttachmentChip key={attachment.id} attachment={attachment} />
                  ))}
                </div>
              )}
            </article>
          ) : (
            <p key={entry.event.id} className="flex flex-wrap items-center gap-1.5 px-1 text-2xs text-subtle">
              <span className="size-1 rounded-full bg-[var(--border-strong)]" aria-hidden />
              <span className="font-medium text-[var(--fg-muted)]">{entry.event.actorName}</span>
              {describeEvent(entry.event)}
              <time dateTime={entry.event.createdAt} title={fullDateTime(entry.event.createdAt)}>
                {shortDateTime(entry.event.createdAt)}
              </time>
            </p>
          ),
        )}
      </div>

      {(canReply || canNote) && (
      <div className="mt-5 rounded-md border surface">
        <RichTextEditor
          value={body}
          onChange={setBody}
          onError={(message) => toast.error(message)}
          minHeight={96}
          className="rounded-b-none border-0"
          ariaLabel={internal ? 'Internal note' : 'Reply'}
          placeholder={internal ? 'Write an internal note, visible only to your team…' : 'Write a reply…'}
        />

        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-t px-3 py-2">
            {files.map((file, index) => (
              <span
                key={`${file.name}-${index}`}
                className="inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-0.5 text-2xs surface-2"
              >
                {file.name}
                <button
                  onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                  className="text-[var(--fg-subtle)] hover:text-[var(--priority-urgent)]"
                  aria-label={`Remove ${file.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-2.5 py-2 surface-2">
          <div className="flex items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                setFiles((current) => [...current, ...Array.from(event.target.files ?? [])].slice(0, 5));
                event.target.value = '';
              }}
            />
            {can('tickets.attach') && (
              <Button variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Paperclip className="size-3.5" />
                Attach
              </Button>
            )}

            {canNote && canReply && (
              <Button
                variant={internal ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setInternal((value) => !value)}
              >
                <Lock className="size-3.5" />
                Internal
              </Button>
            )}
          </div>

          <Button
            variant="primary"
            size="sm"
            loading={sending}
            disabled={!hasBody && files.length === 0}
            onClick={submit}
          >
            <Send className="size-3.5" />
            {internal ? 'Add note' : 'Reply'}
          </Button>
        </div>
      </div>
      )}
    </div>
  );
}

/** Tickets raised by a monitor or an alert source have no person behind them. */
function requesterLabel(ticket: TicketDetailType): string {
  if (ticket.requesterName) return ticket.requesterName;
  if (ticket.source === 'monitor') return 'Monitoring';
  if (ticket.source === 'webhook') return 'Alert source';
  return 'Unknown';
}

function describeEvent(event: TicketDetailType['events'][number]): string {
  switch (event.action) {
    case 'assigned':
      return 'assigned this ticket';
    case 'escalated':
      if (event.field === 'pageLevel') return `moved paging on to escalation level ${event.toValue}`;
      if (event.field === 'team') return `escalated this from ${event.fromValue} to ${event.toValue}`;
      return `escalated this to level ${event.toValue}`;
    case 'paged':
      return `started paging with "${event.toValue}"`;
    case 'acknowledged':
      return `acknowledged the page via ${event.toValue}`;
    case 'oncall_notified':
      return `notified on-call (${event.toValue})`;
    case 'alert_grouped':
      return `grouped another alert into this incident: ${event.toValue}`;
    case 'routed':
      return `routed this by the rule "${event.toValue}"`;
    case 'attached':
      return `attached ${event.toValue}`;
    case 'linked':
      return `linked ${event.toValue} in Linear`;
    case 'synced':
      return `synced the status to ${event.toValue}`;
    case 'updated':
      if (event.field === 'status') return `changed the status to ${event.toValue}`;
      if (event.field === 'priority') return `changed the priority to ${event.toValue}`;
      if (event.field === 'assignee') return 'reassigned this ticket';
      if (event.field === 'team') return 'moved this to another team';
      if (event.field === 'dueAt') return 'changed the due date';
      if (event.field === 'tags') return 'updated the tags';
      if (event.field === 'severity') return event.toValue ? `set the severity to ${event.toValue.toUpperCase()}` : 'cleared the severity';
      if (event.field === 'commander') return event.toValue ? 'named an incident commander' : 'removed the incident commander';
      return `updated the ${event.field ?? 'ticket'}`;
    default:
      return event.action;
  }
}

function AttachmentChip({ attachment }: { attachment: TicketDetailType['attachments'][number] }) {
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-[3px] border px-1.5 py-1 text-2xs transition-colors surface-2 hover:border-[var(--border-strong)]"
    >
      <Paperclip className="size-3 text-[var(--fg-subtle)]" />
      <span className="max-w-40 truncate">{attachment.originalName}</span>
      <span className="text-subtle">{fileSize(attachment.size)}</span>
    </a>
  );
}

/* --------------------------- properties panel ---------------------------- */

function PropertiesPanel({
  ticket,
  teams,
  directory,
  editable,
  canAssign,
  canPriority,
  canStatusTo,
  busy,
  onPatch,
}: {
  ticket: TicketDetailType;
  teams: Team[];
  directory: Directory;
  editable: boolean;
  canAssign: boolean;
  canPriority: boolean;
  canStatusTo: (next: string) => boolean;
  busy: boolean;
  onPatch: (body: Record<string, unknown>, message: string) => Promise<void>;
}) {
  // Only people on the ticket's team can be assigned, unless it has no team.
  const assignable = ticket.teamId
    ? directory.filter((person) => person.teamIds.includes(ticket.teamId!) && person.role !== 'viewer')
    : directory.filter((person) => person.role !== 'viewer');

  const sla = slaRemaining(ticket.dueAt, TERMINAL_STATUSES.includes(ticket.status));

  return (
    <div className="space-y-4 px-4 py-4">
      <Field label="Status">
        <Select
          value={ticket.status}
          disabled={!TICKET_STATUSES.some((status) => status !== ticket.status && canStatusTo(status)) || busy}
          onChange={(event) => onPatch({ status: event.target.value }, 'Status updated.')}
        >
          {TICKET_STATUSES.map((status) => (
            <option key={status} value={status} disabled={status !== ticket.status && !canStatusTo(status)}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Priority">
        <Select
          value={ticket.priority}
          disabled={!canPriority || busy}
          onChange={(event) => onPatch({ priority: event.target.value }, 'Priority updated.')}
        >
          {TICKET_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {PRIORITY_LABELS[priority]}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Type">
        <Select
          value={ticket.type}
          disabled={!editable || busy}
          onChange={(event) => onPatch({ type: event.target.value }, 'Type updated.')}
        >
          {TICKET_TYPES.map((type) => (
            <option key={type} value={type}>
              {TYPE_LABELS[type]}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Team">
        <Select
          value={ticket.teamId ?? ''}
          disabled={!(canAssign || editable) || busy}
          onChange={(event) => onPatch({ teamId: event.target.value || null }, 'Team updated.')}
        >
          <option value="">Unassigned</option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Assignee" hint={ticket.teamId ? 'Members of the selected team.' : undefined}>
        <Select
          value={ticket.assigneeId ?? ''}
          disabled={!canAssign || busy}
          onChange={(event) => onPatch({ assigneeId: event.target.value || null }, 'Assignee updated.')}
        >
          <option value="">Unassigned</option>
          {assignable.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </Select>
      </Field>

      <dl className="space-y-2 border-t pt-4 text-xs">
        <Row label="Requester">
          <UserChip name={ticket.requesterName} />
        </Row>
        <Row label="Opened">
          <span title={fullDateTime(ticket.createdAt)}>{shortDateTime(ticket.createdAt)}</span>
        </Row>
        <Row label="Due">
          <span className={cn(sla.breached && 'font-medium text-[var(--priority-urgent)]')} title={fullDateTime(ticket.dueAt)}>
            {ticket.dueAt ? `${shortDateTime(ticket.dueAt)} · ${sla.label}` : 'No SLA'}
          </span>
        </Row>
        <Row label="First reply">
          <span>{ticket.firstResponseAt ? shortDateTime(ticket.firstResponseAt) : 'Awaiting'}</span>
        </Row>
        {ticket.resolvedAt && (
          <Row label="Resolved">
            <span>{shortDateTime(ticket.resolvedAt)}</span>
          </Row>
        )}
        <Row label="Source">
          <span className="capitalize">{ticket.source}</span>
        </Row>
        <Row label="Watchers">
          <span className="tabular">{ticket.watcherIds.length}</span>
        </Row>
      </dl>

      <TicketLabels ticket={ticket} editable={editable && !busy} onPatch={onPatch} />

      {/* Only links that go somewhere. The rest are bookkeeping - which Slack
          replies and Linear comments have already been recorded. */}
      {ticket.links.some((link) => link.url) && (
        <div className="border-t pt-4">
          <p className="eyebrow mb-1.5">Linked issues</p>
          <div className="space-y-1">
            {ticket.links.filter((link) => link.url).map((link) => (
              <a
                key={link.id}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-[var(--accent)] hover:underline"
              >
                <ArrowUpRight className="size-3" />
                {link.externalKey ?? link.url}
                <span className="text-subtle capitalize">· {link.provider}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Labels on the ticket: a picker for those who can edit it, coloured links to the filtered list for everyone else. */
function TicketLabels({
  ticket,
  editable,
  onPatch,
}: {
  ticket: TicketDetailType;
  editable: boolean;
  onPatch: (body: Record<string, unknown>, message: string) => Promise<void>;
}) {
  const labels = useTeamLabels(ticket.teamId);
  if (!editable && ticket.tags.length === 0) return null;

  return (
    <div className="border-t pt-4">
      <p className="eyebrow mb-1.5">Labels</p>
      {editable ? (
        <LabelPicker
          labels={labels}
          value={ticket.tags}
          onChange={(next) => void onPatch({ tags: next }, 'Labels updated.')}
          emptyHint={ticket.teamId ? 'This team has no labels yet. Add them under Teams.' : 'Assign a team to pick its labels.'}
        />
      ) : (
        <div className="flex flex-wrap gap-1">
          {ticket.tags.map((tag) => {
            const label = labelFor(tag, labels);
            return (
              <Link key={tag} to={`/tickets?tag=${encodeURIComponent(tag)}`} className="max-w-full hover:opacity-80">
                <LabelChip name={label?.name ?? tag} color={label?.color} className={label ? undefined : 'surface-2'} />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="shrink-0 text-subtle">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}
