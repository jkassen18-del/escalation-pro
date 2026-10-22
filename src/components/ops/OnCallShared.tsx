import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/Badge';
import type { Severity } from '@shared/ops';

/** Shared bits for the on-call and database pages. */

export const SEVERITY_COLORS: Record<Severity, string> = {
  sev1: 'var(--priority-urgent)',
  sev2: 'var(--priority-high)',
  sev3: 'var(--priority-normal)',
  sev4: 'var(--priority-low)',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge color={SEVERITY_COLORS[severity]}>{severity.toUpperCase()}</Badge>;
}

export interface DirectoryPerson {
  id: string;
  name: string;
  email: string;
  avatarColor: string;
  jobTitle: string | null;
}

/** ISO -> the value a datetime-local input wants, in the browser's zone. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function fromLocalInput(value: string): string {
  return value ? new Date(value).toISOString() : '';
}

/** Underlined tab strip, sitting under a PageHeader. */
export function OnCallTabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="-mb-3 mt-3 flex gap-1 overflow-x-auto" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={cn(
            'shrink-0 border-b-2 px-2.5 pb-2 text-xs font-medium transition-colors',
            value === tab.value
              ? 'border-[var(--fg)] text-[var(--fg)]'
              : 'border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** Stable colour per person for timeline bars. */
const PALETTE = ['#4d6b8a', '#9a7b2f', '#5b8a5a', '#8a4d6b', '#4d8a86', '#7a5fa8', '#a8673f', '#5f6fa8'];
export function personColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
