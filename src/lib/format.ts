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
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) {
    const wholeHours = Math.floor(hours);
    const mins = Math.round(minutes - wholeHours * 60);
    return mins ? `${wholeHours}h ${mins}m` : `${wholeHours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = Math.round(hours - days * 24);
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
