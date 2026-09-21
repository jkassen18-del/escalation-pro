import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type ToastKind = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
}

interface ToastApi {
  success: (message: string, detail?: string) => void;
  error: (message: string, detail?: string) => void;
  info: (message: string, detail?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info };
const ACCENTS: Record<ToastKind, string> = {
  success: 'var(--status-resolved)',
  error: 'var(--priority-urgent)',
  info: 'var(--status-open)',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, detail?: string) => {
      const id = Date.now() + Math.random();
      setToasts((current) => [...current, { id, kind, message, detail }]);
      // Errors stay longer: people need time to read what went wrong.
      window.setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 4000);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message, detail) => push('success', message, detail),
      error: (message, detail) => push('error', message, detail),
      info: (message, detail) => push('info', message, detail),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-full max-w-sm flex-col gap-2"
      >
        {toasts.map((toast) => {
          const Icon = ICONS[toast.kind];
          return (
            <div
              key={toast.id}
              className={cn(
                'animate-in pointer-events-auto flex items-start gap-2.5 rounded-md border px-3 py-2.5',
                'surface overlay-shadow',
              )}
            >
              <Icon className="mt-px size-4 shrink-0" style={{ color: ACCENTS[toast.kind] }} />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium">{toast.message}</p>
                {toast.detail && <p className="mt-0.5 text-xs break-words text-muted">{toast.detail}</p>}
              </div>
              <button
                onClick={() => dismiss(toast.id)}
                className="shrink-0 rounded-xs p-0.5 text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                aria-label="Dismiss"
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
