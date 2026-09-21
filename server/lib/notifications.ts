import { db } from '../db/index.ts';
import { randomId } from './crypto.ts';
import type { Notification } from '../../shared/types.ts';

export interface NotificationInput {
  ticketId?: string | null;
  type: string;
  title: string;
  body?: string | null;
}

/** Writes an in-app notification for each recipient, skipping duplicates. */
export async function notifyUsers(userIds: string[], input: NotificationInput): Promise<void> {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  const now = new Date().toISOString();

  for (const userId of unique) {
    await db.run(
      `INSERT INTO notifications (id, user_id, ticket_id, type, title, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomId(), userId, input.ticketId ?? null, input.type, input.title, input.body ?? null, now],
    );
  }
}

export async function listNotifications(userId: string, limit = 30): Promise<Notification[]> {
  const rows = await db.all<Record<string, string | null>>(
    `SELECT n.*, t.number AS ticket_number FROM notifications n
     LEFT JOIN tickets t ON t.id = n.ticket_id
     WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT ?`,
    [userId, limit],
  );

  return rows.map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    ticketId: row.ticket_id ?? null,
    ticketReference: row.ticket_number ? String(row.ticket_number) : null,
    type: String(row.type),
    title: String(row.title),
    body: row.body ?? null,
    readAt: row.read_at ?? null,
    createdAt: String(row.created_at),
  }));
}

export async function markNotificationsRead(userId: string, ids?: string[]): Promise<void> {
  const now = new Date().toISOString();
  if (ids?.length) {
    await db.run(
      `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL
       AND id IN (${ids.map(() => '?').join(', ')})`,
      [now, userId, ...ids],
    );
    return;
  }
  await db.run(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`, [now, userId]);
}

export async function unreadCount(userId: string): Promise<number> {
  const row = await db.get<{ count: number | string }>(
    `SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL`,
    [userId],
  );
  return Number(row?.count ?? 0);
}
