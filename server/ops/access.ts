import { db } from '../db/index.ts';
import type { AlertSource, Monitor, MonitorConfig } from '../../shared/ops.ts';
import type { PublicUser } from '../../shared/types.ts';

/**
 * Who may see an ops object's secrets, and who may act on a page.
 *
 * Everyone signed in can see what is up, what is down and who is on call, but
 * the things that let someone impersonate a monitor or an alert source (ingest
 * tokens, heartbeat URLs, request headers and bodies, credentials in a target
 * URL) are only shown to people who manage monitoring.
 */
export const MASK = '••••••';

const canManageMonitoring = (user: Pick<PublicUser, 'permissions'>) => user.permissions.includes('monitors.manage');

/** Drops `user:password@` from a URL-shaped target; anything else is returned as is. */
export function redactTarget(target: string): string {
  return target.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, `$1${MASK}@`);
}

export function redactMonitor(monitor: Monitor, user: Pick<PublicUser, 'permissions'>): Monitor {
  if (canManageMonitoring(user)) return monitor;
  const config: MonitorConfig = { ...monitor.config };
  if (config.headers) config.headers = Object.fromEntries(Object.keys(config.headers).map((name) => [name, MASK]));
  if (config.body) config.body = MASK;
  return { ...monitor, target: redactTarget(monitor.target), config, heartbeatUrl: monitor.heartbeatUrl ? MASK : null };
}

export function redactSource(source: AlertSource, user: Pick<PublicUser, 'permissions'>): AlertSource {
  if (canManageMonitoring(user)) return source;
  return { ...source, webhookUrl: source.webhookUrl.replace(/\/api\/ingest\/[^/?#]+/, `/api/ingest/${MASK}`) };
}

/**
 * A page may be acknowledged or escalated by someone it reached (or is
 * waiting on), or by anyone who manages on-call. Anyone else seeing an id must
 * not be able to silence someone else's page.
 */
export async function canActOnPage(user: Pick<PublicUser, 'id' | 'permissions'> & { teamIds?: string[] }, pageId: string, currentTargetIds: string[] = []): Promise<boolean> {
  if (user.permissions.includes('oncall.manage')) return true;
  // A department's on-call manager may act on pages about that department's tickets.
  if (user.permissions.includes('oncall.manage_own_department') && user.teamIds?.length) {
    const row = await db.get<{ team_id: string | null }>(`SELECT t.team_id FROM pages p JOIN tickets t ON t.id = p.ticket_id WHERE p.id = ?`, [pageId]);
    if (row?.team_id && user.teamIds.includes(row.team_id)) return true;
  }
  if (!user.permissions.includes('pages.respond')) return false;
  if (currentTargetIds.includes(user.id)) return true;
  const row = await db.get<{ id: string }>(`SELECT id FROM notification_attempts WHERE page_id = ? AND user_id = ? LIMIT 1`, [pageId, user.id]);
  return Boolean(row);
}

/**
 * Departmental access for things tied to a ticket (alerts, pages): someone
 * without tickets.view_all only sees those whose ticket they could open -
 * their departments', or ones they raised or are assigned. Items with no
 * ticket are operational and stay visible. A page that is ringing someone is
 * always visible to them, whatever the department.
 */
export async function filterToVisibleTickets<T extends { ticketId: string | null; currentTargetIds?: string[] }>(
  items: T[],
  user: Pick<PublicUser, 'id' | 'permissions' | 'teamIds'>,
): Promise<T[]> {
  if (user.permissions.includes('tickets.view_all')) return items;
  const ids = [...new Set(items.map((item) => item.ticketId).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return items;
  const rows = await db.all<{ id: string; team_id: string | null; assignee_id: string | null; requester_id: string | null; created_by: string | null }>(
    `SELECT id, team_id, assignee_id, requester_id, created_by FROM tickets WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ids,
  );
  const visible = new Set(
    rows
      .filter(
        (row) =>
          row.assignee_id === user.id ||
          row.requester_id === user.id ||
          row.created_by === user.id ||
          Boolean(row.team_id && user.teamIds.includes(row.team_id)),
      )
      .map((row) => row.id),
  );
  return items.filter((item) => !item.ticketId || visible.has(item.ticketId) || Boolean(item.currentTargetIds?.includes(user.id)));
}

/**
 * Whether someone may edit a department's on-call: everyone's with
 * oncall.manage, only their own departments' with oncall.manage_own_department.
 * A schedule that belongs to no department needs oncall.manage.
 */
export function canManageOnCallFor(user: Pick<PublicUser, 'permissions' | 'teamIds'>, teamId: string | null | undefined): boolean {
  if (user.permissions.includes('oncall.manage')) return true;
  if (!user.permissions.includes('oncall.manage_own_department')) return false;
  return Boolean(teamId && user.teamIds.includes(teamId));
}
