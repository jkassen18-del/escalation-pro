import type { Request } from 'express';
import { db } from '../db/index.ts';
import { randomId } from './crypto.ts';
import type { AuditEntry } from '../../shared/types.ts';

export interface AuditInput {
  actorId?: string | null;
  actorName?: string;
  entityType: 'ticket' | 'user' | 'team' | 'settings' | 'integration' | 'auth' | 'system';
  entityId?: string | null;
  action: string;
  summary: string;
  meta?: Record<string, unknown> | null;
  ip?: string | null;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  await db.run(
    `INSERT INTO audit_log (id, actor_id, actor_name, entity_type, entity_id, action, summary, meta, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomId(),
      input.actorId ?? null,
      input.actorName ?? 'system',
      input.entityType,
      input.entityId ?? null,
      input.action,
      input.summary,
      input.meta ? JSON.stringify(input.meta) : null,
      input.ip ?? null,
      new Date().toISOString(),
    ],
  );
}

/** Honours X-Forwarded-For when running behind a proxy (`trust proxy` is set). */
export function clientIp(req: Request): string | null {
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

export function mapAuditRow(row: Record<string, unknown>): AuditEntry {
  return {
    id: String(row.id),
    actorId: (row.actor_id as string | null) ?? null,
    actorName: String(row.actor_name ?? 'system'),
    entityType: String(row.entity_type),
    entityId: (row.entity_id as string | null) ?? null,
    action: String(row.action),
    summary: String(row.summary),
    meta: row.meta ? (JSON.parse(String(row.meta)) as Record<string, unknown>) : null,
    ip: (row.ip as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}
