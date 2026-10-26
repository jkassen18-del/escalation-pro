import { useEffect, useRef, useState } from 'react';
import { Building2, Check, ChevronDown, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { useDepartment } from '@/state/department';

/**
 * The department selector in the top bar. Departments a person does not
 * belong to are listed but locked, so it is clear they exist and who to ask,
 * without showing anything inside them.
 */
export function DepartmentSwitcher() {
  const { can } = useAuth();
  const { departments, accessible, current, scope, setScope, canOpen } = useDepartment();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  if (!departments.length) return null;
  const allLabel = can('tickets.view_all') ? 'All departments' : accessible.length > 1 ? 'My departments' : 'All my tickets';

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex max-w-[14rem] min-w-0 items-center gap-2 rounded-sm border px-2 py-1 text-xs transition-colors surface hover:bg-[var(--surface-3)] sm:max-w-[18rem]"
      >
        {current ? (
          <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: current.color }} />
        ) : (
          <Building2 className="size-3.5 shrink-0 text-[var(--fg-subtle)]" />
        )}
        <span className="min-w-0 truncate font-medium">{current?.name ?? allLabel}</span>
        <ChevronDown className="size-3.5 shrink-0 text-[var(--fg-subtle)]" />
      </button>

      {open && (
        <div role="listbox" aria-label="Department" className="animate-in absolute left-0 z-40 mt-1 max-h-[70vh] w-64 overflow-y-auto rounded-md border p-1 surface overlay-shadow">
          <Option selected={scope === 'all'} onSelect={() => (setScope('all'), setOpen(false))}>
            <Building2 className="size-3.5 text-[var(--fg-subtle)]" />
            <span className="flex-1 truncate">{allLabel}</span>
          </Option>
          <div className="my-1 border-t" />
          {departments.map((team) => {
            const locked = !canOpen(team.id);
            return (
              <Option
                key={team.id}
                selected={scope === team.id}
                locked={locked}
                onSelect={() => {
                  if (locked) return;
                  setScope(team.id);
                  setOpen(false);
                }}
              >
                <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: team.color, opacity: locked ? 0.4 : 1 }} />
                <span className="flex-1 truncate">{team.name}</span>
                {locked && <Lock className="size-3 text-[var(--fg-subtle)]" aria-label="No access" />}
              </Option>
            );
          })}
          {accessible.length < departments.length && (
            <p className="px-2 pt-1.5 pb-1 text-2xs text-subtle">Locked departments need an administrator to add you.</p>
          )}
        </div>
      )}
    </div>
  );
}

function Option({ children, selected, locked, onSelect }: { children: React.ReactNode; selected: boolean; locked?: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={locked}
      onClick={onSelect}
      title={locked ? 'You are not in this department' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs',
        locked ? 'cursor-not-allowed text-subtle' : 'hover:bg-[var(--surface-3)]',
        selected && 'font-medium',
      )}
    >
      {children}
      {selected && <Check className="size-3.5 text-[var(--accent)]" />}
    </button>
  );
}
