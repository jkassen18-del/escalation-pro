import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin-slow text-[var(--fg-subtle)]', className)} />;
}

export function LoadingPane({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-xs text-subtle">
      <Spinner />
      {label}
    </div>
  );
}

/**
 * Empty states explain what the view is for and what to do next, rather than
 * showing an illustration and a single word.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-16 text-center', className)}>
      {Icon && (
        <div className="mb-3 flex size-9 items-center justify-center rounded-md border surface-2">
          <Icon className="size-4 text-[var(--fg-subtle)]" />
        </div>
      )}
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorPane({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="m-4 rounded-md border border-[var(--priority-urgent)]/30 bg-[var(--priority-urgent)]/5 px-4 py-3">
      <p className="text-xs font-medium text-[var(--priority-urgent)]">Something went wrong</p>
      <p className="mt-1 text-xs text-muted">{message}</p>
      {retry && (
        <button onClick={retry} className="mt-2 text-xs font-medium text-[var(--accent)] underline-offset-2 hover:underline">
          Try again
        </button>
      )}
    </div>
  );
}

/** Thin progress bar used for SLA burn-down. */
export function MeterBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="h-1 w-full overflow-hidden rounded-full surface-3">
      <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}
