import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: React.ComponentType<{ className?: string }>;
  destructive?: boolean;
  disabled?: boolean;
}

/**
 * Lightweight dropdown. Closes on outside click, Escape, and after a selection.
 */
export function Menu({
  trigger,
  items,
  align = 'end',
  className,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  items: MenuItem[];
  align?: 'start' | 'end';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /*
   * The menu is portalled to <body> and positioned against the trigger.
   * Rendered in place, it was clipped by any scrolling ancestor - a table in
   * an overflow container - and the options were only reachable by scrolling
   * inside it. It opens upwards when there is no room below.
   */
  useLayoutEffect(() => {
    if (!open) {
      setPosition({ visibility: 'hidden' });
      return;
    }
    const place = () => {
      const anchor = containerRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const height = menu.offsetHeight;
      const width = menu.offsetWidth;
      const gap = 4;
      const below = window.innerHeight - anchor.bottom;
      const top = below < height + gap && anchor.top > below ? anchor.top - height - gap : anchor.bottom + gap;
      const rawLeft = align === 'end' ? anchor.right - width : anchor.left;
      const left = Math.min(Math.max(8, rawLeft), window.innerWidth - width - 8);
      setPosition({ top: Math.max(8, top), left });
    };
    place();
    window.addEventListener('resize', place);
    // Capture: scrolling any ancestor container moves the trigger too.
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, align]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: 'fixed', ...position }}
            className={cn('animate-in z-[60] min-w-44 rounded-md border py-1 surface overlay-shadow', className)}
          >
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors',
                    'hover:bg-[var(--surface-3)] disabled:cursor-not-allowed disabled:opacity-40',
                    item.destructive ? 'text-[var(--priority-urgent)]' : 'text-[var(--fg)]',
                  )}
                >
                  {Icon && <Icon className="size-3.5 shrink-0 opacity-70" />}
                  {item.label}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
