import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/Badge';
import type { ComponentStatus, MonitorDay, MonitorState, Severity } from '@shared/ops';

/** Building blocks shared by the Monitoring and Status pages screens. */

export const SEVERITY_COLORS: Record<Severity, string> = {
  sev1: 'var(--priority-urgent)',
  sev2: 'var(--priority-high)',
  sev3: 'var(--priority-normal)',
  sev4: 'var(--priority-low)',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge color={SEVERITY_COLORS[severity]}>{severity.toUpperCase()}</Badge>;
}

export const STATE_COLORS: Record<MonitorState, string> = {
  up: '#16a34a',
  down: '#dc2626',
  pending: '#9ca3af',
  paused: '#6b7280',
};

export const STATE_LABELS: Record<MonitorState, string> = {
  up: 'Up',
  down: 'Down',
  pending: 'Pending',
  paused: 'Paused',
};

export function StateDot({ state, className }: { state: MonitorState; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2.5 shrink-0', className)} title={STATE_LABELS[state]}>
      {state === 'down' && <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ background: STATE_COLORS[state] }} />}
      <span className="relative size-2.5 rounded-full" style={{ background: STATE_COLORS[state] }} />
    </span>
  );
}

export const COMPONENT_STATUS_COLORS: Record<ComponentStatus, string> = {
  operational: '#16a34a',
  degraded: '#d97706',
  outage: '#dc2626',
  maintenance: '#2563eb',
  unknown: '#9ca3af',
};

export const COMPONENT_STATUS_LABELS: Record<ComponentStatus, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  outage: 'Outage',
  maintenance: 'Maintenance',
  unknown: 'No data',
};

/** A read-only value with a copy button: webhook and heartbeat URLs. */
export function CopyField({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn('flex min-w-0 items-center gap-1 rounded-sm border border-[var(--border-strong)] surface-2 pl-2', className)}>
      <code className="min-w-0 flex-1 truncate py-1.5 font-mono text-2xs" title={value}>
        {value}
      </code>
      <button
        type="button"
        className="flex size-7 shrink-0 items-center justify-center text-[var(--fg-subtle)] hover:text-[var(--fg)]"
        aria-label="Copy to clipboard"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          } catch {
            // Clipboard blocked (plain http on a non-localhost address); the text is selectable.
          }
        }}
      >
        {copied ? <Check className="size-3.5 text-[#16a34a]" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

/** Ninety daily bars, oldest on the left, coloured by that day's failure ratio. */
export function UptimeBars({ days, className }: { days: MonitorDay[]; className?: string }) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const today = Date.now();
  return (
    <div className={cn('flex h-6 gap-px', className)} aria-label="Uptime over the last 90 days">
      {Array.from({ length: 90 }, (_, i) => {
        const date = new Date(today - (89 - i) * 86_400_000).toISOString().slice(0, 10);
        const day = byDay.get(date);
        // Failed checks during planned maintenance count neither way.
        const counted = day ? day.total - (day.maintenance ?? 0) : 0;
        const ratio = day && counted > 0 ? day.failures / counted : null;
        const color =
          day && day.maintenance && !day.failures
            ? '#2563eb'
            : ratio === null
              ? 'var(--surface-3)'
              : ratio === 0
                ? '#16a34a'
                : ratio < 0.05
                  ? '#d97706'
                  : '#dc2626';
        const title =
          day && day.total
            ? `${date}: ${counted > 0 ? `${(((counted - day.failures) / counted) * 100).toFixed(2)}% up` : 'maintenance'}${day.maintenance ? ', planned maintenance' : ''}`
            : `${date}: no data`;
        return <span key={date} className="min-w-px flex-1 rounded-[1px]" style={{ background: color }} title={title} />;
      })}
    </div>
  );
}

/** Underlined tabs below a page header. */
export function MonitorTabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: Array<{ value: T; label: string; count?: number }>;
}) {
  return (
    <div className="-mb-3 mt-3 flex gap-4 overflow-x-auto" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={cn(
            'flex shrink-0 items-center gap-1.5 border-b-2 pb-2 text-xs font-medium transition-colors',
            value === tab.value ? 'border-[var(--fg)] text-[var(--fg)]' : 'border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]',
          )}
        >
          {tab.label}
          {tab.count !== undefined && <span className="tabular rounded-[3px] px-1 text-2xs surface-3">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
