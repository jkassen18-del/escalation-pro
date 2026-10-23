import { formatDistanceToNowStrict, format, isToday, isYesterday } from 'date-fns';
import type { TicketPriority, TicketStatus, TicketType, UserRole } from '@shared/types';

export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  pending: 'Pending',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const STATUS_COLORS: Record<TicketStatus, string> = {
  open: 'var(--status-open)',
  in_progress: 'var(--status-progress)',
  pending: 'var(--status-pending)',
  resolved: 'var(--status-resolved)',
  closed: 'var(--status-closed)',
};

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

export const PRIORITY_COLORS: Record<TicketPriority, string> = {
  urgent: 'var(--priority-urgent)',
  high: 'var(--priority-high)',
  normal: 'var(--priority-normal)',
  low: 'var(--priority-low)',
};

export const TYPE_LABELS: Record<TicketType, string> = {
  incident: 'Incident',
  request: 'Request',
  question: 'Question',
  problem: 'Problem',
  escalation: 'Escalation',
};

export const TYPE_COLORS: Record<TicketType, string> = {
  incident: 'var(--type-incident)',
  request: 'var(--type-request)',
  question: 'var(--type-question)',
  problem: 'var(--type-problem)',
  escalation: 'var(--type-escalation)',
};

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Administrator',
  manager: 'Manager',
  agent: 'Agent',
  viewer: 'Viewer',
};

/** "3h ago" style relative time, used throughout the ticket lists. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return `${formatDistanceToNowStrict(new Date(iso))} ago`;
  } catch {
    return '—';
  }
}

/** Compact absolute time: "14:32" today, "Yesterday 14:32", else "12 Mar 14:32". */
export function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  if (isToday(date)) return format(date, 'HH:mm');
  if (isYesterday(date)) return `Yesterday ${format(date, 'HH:mm')}`;
  return format(date, 'd MMM HH:mm');
}

export function fullDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return format(date, "d MMMM yyyy 'at' HH:mm");
}

/** Turns a minute count into "4h 30m" / "2d 3h" for SLA displays. */
export function duration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  // Round once, up front: rounding each part separately produced "1d 24h" and "1h 60m".
  const total = Math.round(minutes);
  if (total < 60) return `${total}m`;
  if (total < 24 * 60) {
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    return mins ? `${hours}h ${mins}m` : `${hours}h`;
  }
  const totalHours = Math.round(total / 60);
  const days = Math.floor(totalHours / 24);
  const remainingHours = totalHours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

/** Time remaining before a due date, or how far past it we are. */
export function slaRemaining(dueAt: string | null, isTerminal: boolean): { label: string; breached: boolean } {
  if (!dueAt) return { label: 'No SLA', breached: false };
  if (isTerminal) return { label: 'Met', breached: false };

  const diffMins = (new Date(dueAt).getTime() - Date.now()) / 60_000;
  if (diffMins < 0) return { label: `${duration(Math.abs(diffMins))} over`, breached: true };
  return { label: `${duration(diffMins)} left`, breached: false };
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
