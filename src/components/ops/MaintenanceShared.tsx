import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Wrench } from 'lucide-react';
import { opsApi } from '@/lib/ops-api';
import { useAuth } from '@/state/auth';
import type { MaintenanceEffect, MaintenanceOccurrence } from '@shared/ops';

export const MAINTENANCE_COLOR = '#2563eb';

/** "until 14:30" today, "until Sat 25 Oct 02:00" otherwise. */
export function untilLabel(iso: string): string {
  const end = new Date(iso);
  const sameDay = end.toDateString() === new Date().toDateString();
  return sameDay
    ? end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : end.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** "2h 15m left". */
export function remainingLabel(iso: string): string {
  const mins = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
  if (mins < 60) return `${mins}m left`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m left`;
  return `${Math.round(hours / 24)} days left`;
}

export function effectShort(effect: MaintenanceEffect): string {
  return effect === 'pause_alerting' ? 'alerting paused' : 'paging paused';
}

/** Shown next to a monitor that a window covers right now. */
export function MaintenanceBadge({ maintenance }: { maintenance: { title: string; endsAt: string; effect: MaintenanceEffect } }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-[3px] border px-1 py-px text-2xs font-medium"
      style={{ color: MAINTENANCE_COLOR, borderColor: `${MAINTENANCE_COLOR}55`, background: `${MAINTENANCE_COLOR}12` }}
      title={`${maintenance.title}: ${effectShort(maintenance.effect)} until ${untilLabel(maintenance.endsAt)}`}
    >
      <Wrench className="size-2.5" />
      Maintenance
    </span>
  );
}

/**
 * The thin strip under the app header while any maintenance is running, so
 * nobody wonders why an obvious outage did not page them.
 */
export function MaintenanceBanner() {
  const location = useLocation();
  const allowed = useAuth().can('ops.view');
  const [active, setActive] = useState<Array<MaintenanceOccurrence & { scopeSummary: string }>>([]);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    const load = () =>
      opsApi.maintenance
        .active()
        .then((result) => !cancelled && setActive(result.active))
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [location.pathname, allowed]);

  if (!allowed || !active.length) return null;
  const [first, ...others] = active;
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs sm:px-4"
      style={{ background: `${MAINTENANCE_COLOR}14`, borderColor: `${MAINTENANCE_COLOR}33`, color: MAINTENANCE_COLOR }}
      role="status"
    >
      <Wrench className="size-3.5 shrink-0" />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-semibold">Maintenance in progress:</span> {first.title} — {effectShort(first.effect)} for {first.scopeSummary.toLowerCase()} until{' '}
        {untilLabel(first.endsAt)}
        {others.length > 0 && ` (+${others.length} more)`}
      </p>
      <Link to="/maintenance" className="shrink-0 font-medium underline-offset-2 hover:underline">
        View
      </Link>
    </div>
  );
}
