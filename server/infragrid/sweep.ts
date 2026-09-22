import { ingestAlert } from './pipeline.ts';
import { findFiringAlert, heartbeatSource, listHeartbeats, recordBeat, setHeartbeatStatus } from './store.ts';
import type { Heartbeat } from '../../shared/types.ts';

/**
 * Catching heartbeats that stopped arriving.
 *
 * The inverse of every other check in this system: silence is the failure.
 * A cron job that dies sends nothing, so the only way to notice is to come
 * looking on a schedule.
 *
 * Runs inside the existing SLA sweep rather than on a timer of its own, so a
 * serverless deployment needs no second scheduled job and a long-running one
 * needs no second interval.
 */
/**
 * Records a check-in, and clears the alert if the job had been missing.
 *
 * The check-in is itself the recovery signal, so it is acted on here rather
 * than left for the next sweep: waiting would leave the grid red for up to a
 * sweep interval after the thing had plainly come back.
 *
 * It also cannot be left to the sweep at all, because recording the beat
 * moves the heartbeat out of `missed` - so by the time the sweep looked,
 * the transition it was watching for would already have happened and the
 * alert would stay firing forever.
 */
export async function acceptBeat(heartbeat: Heartbeat): Promise<void> {
  const wasMissed = heartbeat.status === 'missed';
  await recordBeat(heartbeat.id);
  if (!wasMissed) return;

  const source = await heartbeatSource();
  const dedupeKey = `heartbeat:${heartbeat.slug}`;
  const firing = await findFiringAlert(source.id, dedupeKey);
  if (!firing) return;

  await ingestAlert(source, {
    dedupeKey,
    title: `${heartbeat.name} is checking in again`,
    severity: 'info',
    status: 'resolved',
    resource: heartbeat.name,
  });
}

export interface SweepResult {
  checked: number;
  missed: number;
  recovered: number;
}

export async function sweepHeartbeats(now = new Date()): Promise<SweepResult> {
  const heartbeats = await listHeartbeats();
  const result: SweepResult = { checked: 0, missed: 0, recovered: 0 };
  if (heartbeats.length === 0) return result;

  const source = await heartbeatSource();

  for (const heartbeat of heartbeats) {
    if (!heartbeat.enabled) continue;
    result.checked += 1;

    /*
     * A heartbeat that has never checked in is not yet late. Otherwise
     * creating one raises an alert immediately, before anybody has had the
     * chance to put the URL into the job it is meant to watch.
     */
    if (!heartbeat.lastBeatAt) continue;

    const dueBy = new Date(heartbeat.lastBeatAt).getTime() + (heartbeat.periodSeconds + heartbeat.graceSeconds) * 1000;
    const late = now.getTime() > dueBy;
    const dedupeKey = `heartbeat:${heartbeat.slug}`;

    if (late && heartbeat.status !== 'missed') {
      await setHeartbeatStatus(heartbeat.id, 'missed');
      await ingestAlert(
        { ...source, teamId: heartbeat.teamId ?? source.teamId },
        {
          dedupeKey,
          title: `${heartbeat.name} has not checked in`,
          body:
            `Expected every ${Math.round(heartbeat.periodSeconds / 60)} minutes ` +
            `(plus ${Math.round(heartbeat.graceSeconds / 60)} minutes' grace). ` +
            `Last seen ${heartbeat.lastBeatAt}.`,
          severity: heartbeat.severity,
          status: 'firing',
          resource: heartbeat.name,
        },
      );
      result.missed += 1;
      continue;
    }

    /*
     * A safety net only. A check-in clears its own alert through acceptBeat,
     * which is immediate; this catches a heartbeat left in `missed` by some
     * other route - a restore, or a status edited by hand.
     */
    if (!late && heartbeat.status === 'missed') {
      const firing = await findFiringAlert(source.id, dedupeKey);
      if (firing) {
        await ingestAlert(source, {
          dedupeKey,
          title: `${heartbeat.name} is checking in again`,
          severity: 'info',
          status: 'resolved',
          resource: heartbeat.name,
        });
      }
      await setHeartbeatStatus(heartbeat.id, 'ok');
      result.recovered += 1;
    }
  }

  return result;
}
