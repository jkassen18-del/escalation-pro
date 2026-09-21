import { useEffect, useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/Field';

/**
 * Picks a record from a connected database.
 *
 * Types the search term, the server runs the operator's query with it bound as
 * a parameter, and the matching rows come back as options. The value stored on
 * the ticket is the source's value column; the label is only for display.
 */
export function LookupInput({
  dataSourceId,
  value,
  onChange,
  placeholder,
  id,
}: {
  dataSourceId: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
}) {
  const [term, setTerm] = useState(value);
  const [rows, setRows] = useState<Array<{ value: string; label: string }>>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Debounced: every keystroke would otherwise be a query against someone
  // else's production database.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      setLoading(true);
      void api.dataSources
        .lookup(dataSourceId, term)
        .then((result) => {
          if (!cancelled) setRows(result.rows);
        })
        .catch(() => {
          if (!cancelled) setRows([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [term, dataSourceId, open]);

  // Clicking away closes the list without choosing anything.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-[var(--fg-subtle)]"
          aria-hidden
        />
        <Input
          id={id}
          value={term}
          placeholder={placeholder ?? 'Search records…'}
          autoComplete="off"
          className="pl-7"
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setTerm(event.target.value);
            setOpen(true);
            // Typing past a chosen record clears it, so a half-edited label is
            // never submitted as though it were a selected row.
            onChange('');
          }}
        />
        {loading && (
          <Loader2
            className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-[var(--fg-subtle)]"
            aria-hidden
          />
        )}
      </div>

      {open && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-sm border surface overlay-shadow">
          {rows.length === 0 && !loading && (
            <li className="px-2.5 py-2 text-xs text-subtle">No matching records.</li>
          )}
          {rows.map((row) => (
            <li key={row.value}>
              <button
                type="button"
                className="w-full px-2.5 py-1.5 text-left text-xs hover:bg-[var(--surface-3)]"
                onClick={() => {
                  onChange(row.value);
                  setTerm(row.label);
                  setOpen(false);
                }}
              >
                {row.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      {value && <p className="mt-1 text-2xs text-subtle">Selected record: {value}</p>}
    </div>
  );
}
