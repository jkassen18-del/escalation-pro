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
export async function canActOnPage(user: Pick<PublicUser, 'id' | 'permissions'>, pageId: string, currentTargetIds: string[] = []): Promise<boolean> {
  if (user.permissions.includes('oncall.manage')) return true;
  if (currentTargetIds.includes(user.id)) return true;
  const row = await db.get<{ id: string }>(`SELECT id FROM notification_attempts WHERE page_id = ? AND user_id = ? LIMIT 1`, [pageId, user.id]);
  return Boolean(row);
}
