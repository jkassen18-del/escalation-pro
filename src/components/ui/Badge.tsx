import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { PRIORITY_COLORS, PRIORITY_LABELS, STATUS_COLORS, STATUS_LABELS } from '@/lib/format';
import type { TicketPriority, TicketStatus } from '@shared/types';

/**
 * Small, square-ish tags with a leading colour dot. Deliberately not pill
 * shaped - full rounding reads as decorative, and these carry real meaning.
 */
export function Badge({
  children,
  color,
  className,
  dot = true,
}: {
  children: ReactNode;
  color?: string;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[3px] border px-1.5 py-0.5 text-2xs font-medium',
        'border-[var(--border)] surface-2 whitespace-nowrap',
        className,
      )}
    >
      {dot && color && <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />}
      <span style={color && !dot ? { color } : undefined}>{children}</span>
    </span>
  );
}

export function StatusBadge({ status, className }: { status: TicketStatus; className?: string }) {
  return (
    <Badge color={STATUS_COLORS[status]} className={className}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}

export function PriorityBadge({ priority, className }: { priority: TicketPriority; className?: string }) {
  return (
    <Badge
      color={PRIORITY_COLORS[priority]}
      className={cn(priority === 'urgent' && 'border-[var(--priority-urgent)]/35', className)}
    >
      {PRIORITY_LABELS[priority]}
    </Badge>
  );
}

/** Monospaced ticket reference, e.g. ESC-1042. */
export function Reference({ value, className }: { value: string; className?: string }) {
  return <span className={cn('font-mono text-2xs tracking-tight text-[var(--fg-muted)]', className)}>{value}</span>;
}
