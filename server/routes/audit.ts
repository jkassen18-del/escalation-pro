import { Router } from 'express';
import { db, placeholders } from '../db/index.ts';
import { asyncRoute, optionalString, parseIntOr } from '../lib/http.ts';
import { mapAuditRow } from '../lib/audit.ts';
import { requireAuth, requirePermission } from '../middleware/auth.ts';

export const auditRouter: Router = Router();

auditRouter.use(requireAuth, requirePermission('audit.view'));

auditRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const q = req.query as Record<string, string>;
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    const entityTypes = (q.entityType ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (entityTypes.length) {
      conditions.push(`entity_type IN (${placeholders(entityTypes.length)})`);
      params.push(...entityTypes);
    }

    const actorId = optionalString(q.actorId, 60);
    if (actorId) {
      conditions.push(`actor_id = ?`);
      params.push(actorId);
    }

    const search = optionalString(q.search, 200);
    if (search) {
      conditions.push(`(LOWER(summary) LIKE ? OR LOWER(actor_name) LIKE ? OR LOWER(action) LIKE ?)`);
      const needle = `%${search.toLowerCase()}%`;
      params.push(needle, needle, needle);
    }

    if (q.from) {
      conditions.push(`created_at >= ?`);
      params.push(q.from);
    }
    if (q.to) {
      conditions.push(`created_at <= ?`);
      params.push(q.to);
    }

    const clause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = parseIntOr(q.limit, 100, { min: 1, max: 500 });
    const offset = parseIntOr(q.offset, 0, { min: 0 });

    const rows = await db.all<Record<string, unknown>>(
      `SELECT * FROM audit_log ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const countRow = await db.get<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM audit_log ${clause}`,
      params,
    );

    res.json({ entries: rows.map(mapAuditRow), total: Number(countRow?.count ?? 0), limit, offset });
  }),
);
