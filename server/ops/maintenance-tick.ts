import { db, placeholders } from '../db/index.ts';
import { notifyUsers } from '../lib/notifications.ts';
import { MAINTENANCE_EFFECT_LABELS } from '../../shared/ops.ts';
import { reraiseAfterMaintenance } from './alerts.ts';
import { activeOccurrences, affectedTeamIds, announcedOf, getMaintenanceRow, markAnnounced, occurrencesBetween, scopeOf } from './maintenance.ts';
import { postMaintenanceUpdates, zoneAbbreviation } from './status-pages.ts';

/**
 * Maintenance transitions, run by the ops scheduler:
 *
 *  - warn the affected teams `notify_before_mins` before an occurrence starts;
 *  - post "in progress" and "completed" updates to status pages for windows
 *    published there;
 *  - when a window stops covering something (it ended, was ended early, or
 *    was cancelled), raise again whatever it held back that is still firing.
 *
 * Each notice is recorded per occurrence, so a restart or a second instance
 * never sends it twice.
 */
const DAY_MS = 86_400_000;

async function teamMembers(teamIds: string[]): Promise<string[]> {
  if (!teamIds.length) return [];
  const rows = await db.all<{ user_id: string }>(
    `SELECT DISTINCT tm.user_id FROM team_members tm JOIN users u ON u.id = tm.user_id
     WHERE u.status = 'active' AND tm.team_id IN (${placeholders(teamIds.length)})`,
    teamIds,
  );
  return rows.map((row) => row.user_id);
}

function when(iso: string, timeZone: string): string {
  const at = new Date(iso);
  return `${at.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone })} ${zoneAbbreviation(at, timeZone)}`;
}

export async function maintenanceTick(now = Date.now()): Promise<{ notified: number; started: number; ended: number; reraised: number }> {
  const counts = { notified: 0, started: 0, ended: 0, reraised: 0 };
  const occurrences = await occurrencesBetween(now - 2 * DAY_MS, now + 7 * DAY_MS);

  for (const { row, occurrence } of occurrences) {
    const start = new Date(occurrence.startsAt).getTime();
    const end = new Date(occurrence.endsAt).getTime();
    const notifyBefore = Number(row.notify_before_mins ?? 0) * 60_000;
    const scope = scopeOf(row);
    const timeZone = row.time_zone || 'Africa/Johannesburg';

    if (notifyBefore > 0 && now < start && now >= start - notifyBefore && (await markAnnounced(row.id, occurrence.key, 'notified'))) {
      await notifyUsers(await teamMembers(await affectedTeamIds(scope)), {
        type: 'maintenance',
        title: `Maintenance "${row.title}" starts ${when(occurrence.startsAt, timeZone)}`,
        body: `Until ${when(occurrence.endsAt, timeZone)}. ${MAINTENANCE_EFFECT_LABELS[occurrence.effect]}.`,
      });
      counts.notified += 1;
    }

    if (now >= start && now < end && (await markAnnounced(row.id, occurrence.key, 'started'))) {
      if (Number(row.publish ?? 0) === 1) await postMaintenanceUpdates({ id: row.id, title: row.title, description: row.description, scope }, 'started');
      counts.started += 1;
    }

    if (now >= end && announcedOf(row)[occurrence.key]?.includes('started') && (await markAnnounced(row.id, occurrence.key, 'ended'))) {
      if (Number(row.publish ?? 0) === 1) await postMaintenanceUpdates({ id: row.id, title: row.title, description: row.description, scope }, 'ended');
      counts.ended += 1;
    }
  }

  // Cancelled mid-occurrence: the occurrence no longer expands, but its
  // "in progress" post needs its "completed".
  const cancelled = await db.all<{ id: string }>(`SELECT id FROM maintenance_windows WHERE cancelled_at IS NOT NULL AND cancelled_at >= ?`, [
    new Date(now - 2 * DAY_MS).toISOString(),
  ]);
  for (const { id } of cancelled) {
    const row = await getMaintenanceRow(id);
    if (!row) continue;
    for (const [key, done] of Object.entries(announcedOf(row))) {
      if (done.includes('started') && !done.includes('ended') && (await markAnnounced(id, key, 'ended'))) {
        if (Number(row.publish ?? 0) === 1) {
          await postMaintenanceUpdates({ id, title: row.title, description: row.description, scope: scopeOf(row) }, 'ended');
        }
        counts.ended += 1;
      }
    }
  }

  // Whatever a window held back, once that window no longer covers anything.
  const active = new Set((await activeOccurrences(now)).map(({ row }) => row.id));
  const holding = await db.all<{ maintenance_id: string }>(
    `SELECT DISTINCT maintenance_id FROM alerts WHERE maintenance_id IS NOT NULL AND status <> 'resolved'`,
  );
  for (const { maintenance_id: windowId } of holding) {
    if (active.has(windowId)) continue;
    counts.reraised += await reraiseAfterMaintenance(windowId);
  }
  return counts;
}
