import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, Inbox, Paperclip, Search, SlidersHorizontal, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { PRIORITY_COLORS, PRIORITY_LABELS, STATUS_LABELS, TYPE_LABELS, relativeTime, slaRemaining } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { PriorityBadge, Reference, StatusBadge } from '@/components/ui/Badge';
import { UserChip } from '@/components/ui/Avatar';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import {
  TERMINAL_STATUSES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  type Team,
  type Ticket,
} from '@shared/types';

const PAGE_SIZE = 50;

export function TicketListPage() {
  const { can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [searchDraft, setSearchDraft] = useState(searchParams.get('search') ?? '');

  const offset = Number(searchParams.get('offset') ?? 0);

  // The URL is the single source of truth for filters, so views are linkable
  // and the browser back button behaves the way people expect.
  const query = useMemo(
    () => ({
      status: searchParams.get('status') ?? undefined,
      priority: searchParams.get('priority') ?? undefined,
      type: searchParams.get('type') ?? undefined,
      teamId: searchParams.get('teamId') ?? undefined,
      assigneeId: searchParams.get('assignee') ?? undefined,
      search: searchParams.get('search') ?? undefined,
      overdue: searchParams.get('overdue') === 'true' || undefined,
      unassigned: searchParams.get('unassigned') === 'true' || undefined,
      sort: searchParams.get('sort') ?? 'newest',
      limit: PAGE_SIZE,
      offset,
    }),
    [searchParams, offset],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.tickets.list(query);
      setTickets(result.tickets);
      setTotal(result.total);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load tickets.');
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api.teams.list().then((result) => setTeams(result.teams)).catch(() => undefined);
  }, []);

  // Debounce the search box so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const current = searchParams.get('search') ?? '';
      if (searchDraft === current) return;
      updateParam('search', searchDraft || null);
    }, 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);

  const updateParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
    next.delete('offset'); // any filter change resets pagination
    setSearchParams(next, { replace: true });
  };

  const activeFilterCount = ['status', 'priority', 'type', 'teamId', 'assignee', 'overdue', 'unassigned'].filter(
    (key) => searchParams.get(key),
  ).length;

  const clearFilters = () => {
    const next = new URLSearchParams();
    if (searchParams.get('search')) next.set('search', searchParams.get('search')!);
    setSearchParams(next, { replace: true });
  };

  const title = searchParams.get('assignee') === 'me'
    ? 'My tickets'
    : searchParams.get('unassigned') === 'true'
      ? 'Unassigned'
      : searchParams.get('overdue') === 'true'
        ? 'Breached SLA'
        : 'All tickets';

  return (
    <div>
      <PageHeader
        title={title}
        description={loading ? 'Loading…' : `${total} ticket${total === 1 ? '' : 's'}`}
        actions={
          can('reports.export') ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.open(api.reports.exportUrl({}), '_blank', 'noopener')}
            >
              <Download className="size-3.5" />
              Export
            </Button>
          ) : undefined
        }
      >
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-[var(--fg-subtle)]" />
            <Input
              data-search-input
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="Search subject, body, or ESC-1042…"
              className="pl-7"
            />
          </div>

          <Button
            variant={showFilters || activeFilterCount ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setShowFilters((value) => !value)}
          >
            <SlidersHorizontal className="size-3.5" />
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-0.5 rounded-[3px] bg-[var(--accent)] px-1 text-2xs font-semibold text-[var(--accent-fg)]">
                {activeFilterCount}
              </span>
            )}
          </Button>

          <Select
            value={searchParams.get('sort') ?? 'newest'}
            onChange={(event) => updateParam('sort', event.target.value)}
            className="w-auto"
            aria-label="Sort order"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="updated">Recently updated</option>
            <option value="priority">Priority</option>
            <option value="due">Due soonest</option>
          </Select>
        </div>

        {showFilters && (
          <div className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
            <FilterSelect
              label="Status"
              value={searchParams.get('status') ?? ''}
              onChange={(value) => updateParam('status', value)}
              options={TICKET_STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] }))}
            />
            <FilterSelect
              label="Priority"
              value={searchParams.get('priority') ?? ''}
              onChange={(value) => updateParam('priority', value)}
              options={TICKET_PRIORITIES.map((priority) => ({ value: priority, label: PRIORITY_LABELS[priority] }))}
            />
            <FilterSelect
              label="Type"
              value={searchParams.get('type') ?? ''}
              onChange={(value) => updateParam('type', value)}
              options={TICKET_TYPES.map((type) => ({ value: type, label: TYPE_LABELS[type] }))}
            />
            <FilterSelect
              label="Team"
              value={searchParams.get('teamId') ?? ''}
              onChange={(value) => updateParam('teamId', value)}
              options={teams.map((team) => ({ value: team.id, label: team.name }))}
            />
            {activeFilterCount > 0 && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="size-3.5" />
                Clear
              </Button>
            )}
          </div>
        )}
      </PageHeader>

      {error ? (
        <ErrorPane message={error} retry={load} />
      ) : loading ? (
        <LoadingPane label="Loading tickets" />
      ) : tickets.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No tickets match this view"
          description={
            activeFilterCount > 0 || searchParams.get('search')
              ? 'Try widening your filters, or clear them to see everything you have access to.'
              : 'Once tickets are raised they will appear here, newest first.'
          }
          action={
            activeFilterCount > 0 ? (
              <Button variant="secondary" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : can('tickets.create') ? (
              <Button variant="primary" size="sm" onClick={() => (window.location.href = '/tickets/new')}>
                Raise the first ticket
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <TicketCards tickets={tickets} />
          <TicketTable tickets={tickets} />
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t px-4 py-2.5 sm:px-6">
              <p className="tabular text-xs text-muted">
                {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => updateOffset(searchParams, setSearchParams, Math.max(0, offset - PAGE_SIZE))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => updateOffset(searchParams, setSearchParams, offset + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function updateOffset(
  params: URLSearchParams,
  setParams: (next: URLSearchParams, options?: { replace?: boolean }) => void,
  offset: number,
) {
  const next = new URLSearchParams(params);
  if (offset <= 0) next.delete('offset');
  else next.set('offset', String(offset));
  setParams(next);
  document.querySelector('main')?.scrollTo({ top: 0 });
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="space-y-1">
      <span className="eyebrow block">{label}</span>
      <Select value={value} onChange={(event) => onChange(event.target.value)} className="w-auto min-w-28">
        <option value="">Any</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

/**
 * Phone layout. A seven-column table cannot be squeezed into 390px without
 * truncating the one column that matters, so below `lg` each ticket becomes a
 * stacked row instead.
 */
function TicketCards({ tickets }: { tickets: Ticket[] }) {
  return (
    <ul className="lg:hidden">
      {tickets.map((ticket) => {
        const sla = slaRemaining(ticket.dueAt, TERMINAL_STATUSES.includes(ticket.status));
        return (
          <li key={ticket.id} className="border-b">
            <Link to={`/tickets/${ticket.id}`} className="block px-4 py-3 hover:bg-[var(--surface-2)]">
              <div className="flex items-center gap-2">
                <Reference value={ticket.reference} />
                <StatusBadge status={ticket.status} />
                <PriorityBadge priority={ticket.priority} />
                {ticket.escalationLevel > 0 && (
                  <span className="rounded-[3px] border border-[var(--priority-urgent)]/35 px-1 text-2xs font-semibold text-[var(--priority-urgent)]">
                    L{ticket.escalationLevel}
                  </span>
                )}
              </div>

              <p className="mt-1.5 flex items-start gap-1.5 text-sm font-medium">
                <span className="truncate">{ticket.subject}</span>
                {ticket.attachmentCount > 0 && (
                  <Paperclip className="mt-0.5 size-3 shrink-0 text-[var(--fg-subtle)]" aria-label="Has attachments" />
                )}
              </p>

              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-subtle">
                <span>{ticket.teamName ?? 'No team'}</span>
                <span aria-hidden>·</span>
                <span>{ticket.assigneeName ?? 'Unassigned'}</span>
                <span aria-hidden>·</span>
                <span className={cn(sla.breached && 'font-medium text-[var(--priority-urgent)]')}>{sla.label}</span>
                <span aria-hidden>·</span>
                <time dateTime={ticket.updatedAt}>{relativeTime(ticket.updatedAt)}</time>
              </p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Desktop layout. At working density an agent can scan roughly 20 tickets
 * without scrolling.
 */
function TicketTable({ tickets }: { tickets: Ticket[] }) {
  return (
    <div className="hidden overflow-x-auto lg:block">
      <table className="w-full min-w-[56rem] border-collapse text-sm">
        <thead>
          <tr className="border-b surface-2">
            <Th className="w-24">Ref</Th>
            <Th>Subject</Th>
            <Th className="w-28">Status</Th>
            <Th className="w-24">Priority</Th>
            <Th className="w-32">Team</Th>
            <Th className="w-40">Assignee</Th>
            <Th className="w-28">SLA</Th>
            <Th className="w-24 text-right">Updated</Th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => {
            const sla = slaRemaining(ticket.dueAt, TERMINAL_STATUSES.includes(ticket.status));
            return (
              <tr key={ticket.id} className="group border-b transition-colors hover:bg-[var(--surface-2)]">
                <Td>
                  <Reference value={ticket.reference} />
                </Td>
                <Td>
                  <Link to={`/tickets/${ticket.id}`} className="block min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ background: PRIORITY_COLORS[ticket.priority] }}
                        aria-hidden
                      />
                      <span className="truncate font-medium group-hover:underline">{ticket.subject}</span>
                      {ticket.attachmentCount > 0 && (
                        <Paperclip className="size-3 shrink-0 text-[var(--fg-subtle)]" aria-label="Has attachments" />
                      )}
                      {ticket.escalationLevel > 0 && (
                        <span className="shrink-0 rounded-[3px] border border-[var(--priority-urgent)]/35 px-1 text-2xs font-semibold text-[var(--priority-urgent)]">
                          L{ticket.escalationLevel}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-2xs text-subtle">
                      {TYPE_LABELS[ticket.type]} · opened by {ticket.requesterName ?? 'unknown'} ·{' '}
                      {ticket.commentCount} comment{ticket.commentCount === 1 ? '' : 's'}
                    </span>
                  </Link>
                </Td>
                <Td>
                  <StatusBadge status={ticket.status} />
                </Td>
                <Td>
                  <PriorityBadge priority={ticket.priority} />
                </Td>
                <Td>
                  <span className="truncate text-xs text-muted">{ticket.teamName ?? '—'}</span>
                </Td>
                <Td>
                  <UserChip name={ticket.assigneeName} muted />
                </Td>
                <Td>
                  <span className={cn('text-xs tabular', sla.breached ? 'font-medium text-[var(--priority-urgent)]' : 'text-muted')}>
                    {sla.label}
                  </span>
                </Td>
                <Td className="text-right">
                  <time dateTime={ticket.updatedAt} className="text-xs whitespace-nowrap text-subtle">
                    {relativeTime(ticket.updatedAt)}
                  </time>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={cn('eyebrow px-3 py-2 text-left font-medium first:pl-4 last:pr-4 sm:first:pl-6 sm:last:pr-6', className)}>{children}</th>;
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn('max-w-0 px-3 py-2 align-middle first:pl-4 last:pr-4 sm:first:pl-6 sm:last:pr-6', className)}>{children}</td>;
}
