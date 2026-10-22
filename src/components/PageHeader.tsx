import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  description,
  actions,
  className,
  children,
  docs,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
  /** A docs page slug (optionally with #anchor) to link from the header. */
  docs?: string;
}) {
  return (
    <div className={cn('border-b px-4 py-3 surface sm:px-6', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {(actions || docs) && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {docs && (
              <Link
                to={`/docs/${docs}`}
                className="inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-xs text-[var(--fg-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
              >
                <BookOpen className="size-3.5" />
                Docs
              </Link>
            )}
            {actions}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
