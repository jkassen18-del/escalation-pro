import { runDueBackups } from './backups.ts';
import { acquireLease } from './lease.ts';
import { pruneMonitorHistory, runDueMonitors } from './monitors.ts';
import { pagerTick } from './pager.ts';

/**
 * The background loop for monitoring, paging and backups.
 *
 * Every instance runs it, but only the lease holder does anything, so a
 * cluster behaves like one scheduler with automatic failover. Serverless
 * deployments call `runOpsTick` from /api/cron/ops instead.
 */
const TICK_MS = Number(process.env.OPS_TICK_MS || 10_000);
const LEASE_MS = TICK_MS * 3;

let ticking = false;
let lastPrune = 0;

export async function runOpsTick(): Promise<{ leader: boolean; monitors: number; pages: number; backups: number }> {
  if (!(await acquireLease('ops-scheduler', LEASE_MS))) return { leader: false, monitors: 0, pages: 0, backups: 0 };
  const [monitors, pages, backups] = await Promise.all([
    runDueMonitors().catch((error) => (console.error('[ops] monitors', error), 0)),
    pagerTick().catch((error) => (console.error('[ops] pager', error), 0)),
    runDueBackups().catch((error) => (console.error('[ops] backups', error), 0)),
  ]);
  if (Date.now() - lastPrune > 3_600_000) {
    lastPrune = Date.now();
    await pruneMonitorHistory().catch((error) => console.error('[ops] prune', error));
  }
  return { leader: true, monitors, pages, backups };
}

export function startOpsRunner(): () => void {
  const run = () => {
    // A slow tick (a hung probe) must not stack a second one on top of it.
    if (ticking) return;
    ticking = true;
    void runOpsTick()
      .catch((error) => console.error('[ops] tick failed', error))
      .finally(() => {
        ticking = false;
      });
  };
  const initial = setTimeout(run, 3000);
  const timer = setInterval(run, TICK_MS);
  initial.unref();
  timer.unref();
  return () => {
    clearTimeout(initial);
    clearInterval(timer);
  };
}
