import { runDueBackups } from './backups.ts';
import { acquireLease } from './lease.ts';
import { maintenanceTick } from './maintenance-tick.ts';
import { handoverTick } from './handover.ts';
import { pollDueSources } from './source-poll.ts';
import { pruneMonitorHistory, runDueMonitors } from './monitors.ts';
import { pagerTick } from './pager.ts';
import { pruneOAuth } from '../mcp/auth.ts';
import { getOpsSetting, setOpsSetting } from '../repositories/settings.ts';

/**
 * The background loops for monitoring, paging and backups.
 *
 * Every instance runs them, but only the lease holder does anything, so a
 * cluster behaves like one scheduler with automatic failover. Serverless
 * deployments call `runOpsTick` from /api/cron/ops instead.
 *
 * Paging has a loop of its own: a monitor probe that hangs until its timeout,
 * or a backup that takes minutes, must never hold back an escalation. The
 * lease is renewed on its own timer too, so a long tick does not let it lapse
 * and hand the work to a second instance halfway through.
 */
const TICK_MS = Number(process.env.OPS_TICK_MS || 10_000);
const PAGER_TICK_MS = Number(process.env.OPS_PAGER_TICK_MS || Math.min(TICK_MS, 5_000));
const LEASE_MS = TICK_MS * 3;
const LEASE_NAME = 'ops-scheduler';

let ticking = false;
let pagerTicking = false;
let lastPrune = 0;
/** Until when this instance's last successful renewal makes it the leader. */
let leaderUntil = 0;

export interface OpsHealth {
  leader: boolean;
  lastTickAt: string | null;
  lastPagerTickAt: string | null;
}

/** For /health: when the loops last finished, wherever they ran. */
export async function opsHealth(): Promise<OpsHealth> {
  const [main, pager] = await Promise.all([
    getOpsSetting<{ at: string | null }>('tick.main', { at: null }),
    getOpsSetting<{ at: string | null }>('tick.pager', { at: null }),
  ]);
  return { leader: Date.now() < leaderUntil, lastTickAt: main.at, lastPagerTickAt: pager.at };
}

async function renewLease(): Promise<boolean> {
  const started = Date.now();
  const held = await acquireLease(LEASE_NAME, LEASE_MS);
  leaderUntil = held ? started + LEASE_MS : 0;
  return held;
}

const isLeader = () => Date.now() < leaderUntil;

async function runPager(): Promise<number> {
  const pages = await pagerTick().catch((error) => (console.error('[ops] pager', error), 0));
  await setOpsSetting('tick.pager', { at: new Date().toISOString() }).catch(() => undefined);
  return pages;
}

async function runMain(): Promise<{ monitors: number; backups: number }> {
  const [monitors, backups] = await Promise.all([
    runDueMonitors().catch((error) => (console.error('[ops] monitors', error), 0)),
    runDueBackups().catch((error) => (console.error('[ops] backups', error), 0)),
    pollDueSources().catch((error) => (console.error('[ops] polling sources', error), 0)),
  ]);
  // After the monitors, so a monitor checked this tick is judged against the
  // windows as they stand now.
  await maintenanceTick().catch((error) => console.error('[ops] maintenance', error));
  await handoverTick().catch((error) => console.error('[ops] handover', error));
  const { resumeDueRuns } = await import('./flows.ts');
  await resumeDueRuns().catch((error) => console.error('[ops] flows', error));
  const { mailboxTick } = await import('../integrations/mailbox.ts');
  await mailboxTick().catch((error) => console.error('[ops] mailboxes', error));
  if (Date.now() - lastPrune > 3_600_000) {
    lastPrune = Date.now();
    await pruneMonitorHistory().catch((error) => console.error('[ops] prune', error));
    await pruneOAuth().catch((error) => console.error('[ops] prune oauth', error));
  }
  await setOpsSetting('tick.main', { at: new Date().toISOString() }).catch(() => undefined);
  return { monitors, backups };
}

/** One pass of everything, for /api/cron/ops. */
export async function runOpsTick(): Promise<{ leader: boolean; monitors: number; pages: number; backups: number }> {
  if (!(await renewLease())) return { leader: false, monitors: 0, pages: 0, backups: 0 };
  const [pages, { monitors, backups }] = await Promise.all([runPager(), runMain()]);
  return { leader: true, monitors, pages, backups };
}

export function startOpsRunner(): () => void {
  // Each loop skips a beat rather than stacking a second run on a slow one.
  const guarded = (busy: () => boolean, set: (value: boolean) => void, work: () => Promise<unknown>, label: string) => () => {
    if (busy()) return;
    set(true);
    void work()
      .catch((error) => console.error(`[ops] ${label} failed`, error))
      .finally(() => set(false));
  };
  const lease = () => void renewLease().catch((error) => console.error('[ops] lease renewal failed', error));
  const main = guarded(() => ticking, (value) => (ticking = value), async () => isLeader() && runMain(), 'tick');
  const pager = guarded(() => pagerTicking, (value) => (pagerTicking = value), async () => isLeader() && runPager(), 'pager tick');

  const initial = setTimeout(() => {
    void renewLease()
      .catch((error) => console.error('[ops] lease renewal failed', error))
      .finally(() => {
        main();
        pager();
      });
  }, 3000);
  const timers = [setInterval(lease, TICK_MS), setInterval(main, TICK_MS), setInterval(pager, PAGER_TICK_MS)];
  initial.unref();
  for (const timer of timers) timer.unref();
  return () => {
    clearTimeout(initial);
    for (const timer of timers) clearInterval(timer);
  };
}
