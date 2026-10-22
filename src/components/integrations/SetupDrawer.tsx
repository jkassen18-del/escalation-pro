import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, CircleAlert, CircleDashed, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import type { CatalogueStatus } from '@shared/types';

/** A panel that slides in from the right, holding one integration's guided setup. */
export function SetupDrawer({
  title,
  icon,
  status,
  onClose,
  children,
}: {
  title: string;
  icon: ReactNode;
  status: CatalogueStatus | undefined;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Set up ${title}`}>
      <div className="absolute inset-0 bg-[var(--color-ink-950)]/35 backdrop-blur-[1px]" onClick={onClose} />
      <aside className="animate-in relative flex h-full w-full max-w-2xl flex-col border-l surface overlay-shadow">
        <header className="flex items-center gap-3 border-b px-5 py-3.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border surface-2">{icon}</div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{title}</h2>
            <StatusLine status={status} />
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
        <footer className="flex justify-end border-t px-5 py-3">
          <Button variant={status?.state === 'connected' ? 'primary' : 'secondary'} onClick={onClose}>
            {status?.state === 'connected' ? 'Done' : 'Close'}
          </Button>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}

export function StatusLine({ status, className }: { status: CatalogueStatus | undefined; className?: string }) {
  const state = status?.state ?? 'not_set_up';
  const Icon = state === 'connected' ? CheckCircle2 : state === 'attention' ? CircleAlert : CircleDashed;
  const color = state === 'connected' ? 'var(--status-resolved)' : state === 'attention' ? 'var(--priority-high)' : 'var(--fg-subtle)';
  const label = state === 'connected' ? 'Connected' : state === 'attention' ? 'Needs attention' : 'Not set up';
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1 text-2xs', className)} style={{ color }} title={status?.detail ?? undefined}>
      <Icon className="size-3 shrink-0" />
      <span className="shrink-0">{label}</span>
      {status?.detail && state !== 'not_set_up' && <span className="truncate text-subtle">· {status.detail}</span>}
    </span>
  );
}

/** Numbered steps. A step marked done shows a tick instead of its number. */
export function Steps({ children }: { children: ReactNode }) {
  return <ol className="space-y-4">{children}</ol>;
}

export function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-2xs font-semibold',
          done ? 'border-[var(--status-resolved)] bg-[var(--status-resolved)] text-white' : 'text-[var(--fg-muted)]',
        )}
      >
        {done ? <CheckCircle2 className="size-3.5" /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{title}</p>
        {children && <div className="mt-1.5 space-y-2 text-xs leading-relaxed text-muted">{children}</div>}
      </div>
    </li>
  );
}
