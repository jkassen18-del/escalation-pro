import crypto from 'node:crypto';
import { db, fromBool, toBool } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import type { Alert, AlertSeverity, AlertSource, AlertSourceKind, Heartbeat } from '../../shared/types.ts';

/**
 * InfraGrid's storage.
 *
 * Sources carry their own ingest credential, handled the way API keys are:
 * shown once, stored as a SHA-256, compared in constant time. A separate
 * credential per system means a compromised Jenkins cannot post as
 * CrowdStrike, and one can be rotated without touching the rest.
 */

const TOKEN_PREFIX = 'ing';
const TOKEN_PATTERN = new RegExp(`^${TOKEN_PREFIX}_([0-9a-f]{8})_([A-Za-z0-9_-]+)$`);

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

interface SourceRow {
  id: string;
  name: string;
  kind: string;
  token_prefix: string;
  token_hash: string;
  team_id: string | null;
  team_name?: string | null;
  ticket_threshold: string;
  enabled: number | string;
  last_event_at: string | null;
  created_at: string;
  firing_count?: number | string;
}

function mapSource(row: SourceRow): AlertSource {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as AlertSourceKind,
    tokenPrefix: row.token_prefix,
    teamId: row.team_id,
    teamName: row.team_name ?? null,
    ticketThreshold: row.ticket_threshold as AlertSeverity,
    enabled: toBool(row.enabled),
    lastEventAt: row.last_event_at,
    firingCount: row.firing_count === undefined ? undefined : Number(row.firing_count),
    createdAt: row.created_at,
  };
}

export interface CreateSourceInput {
  name: string;
  kind: AlertSourceKind;
  teamId?: string | null;
  ticketThreshold?: AlertSeverity;
}

export async function createSource(input: CreateSourceInput): Promise<{ source: AlertSource; token: string }> {
  const prefix = `${TOKEN_PREFIX}_${crypto.randomBytes(4).toString('hex')}`;
  const token = `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
  const now = new Date().toISOString();
  const id = randomId();

  await db.run(
    `INSERT INTO alert_sources (id, name, kind, token_prefix, token_hash, team_id, ticket_threshold, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      input.name,
      input.kind,
      prefix,
      hashToken(token),
      input.teamId ?? null,
      input.ticketThreshold ?? 'warning',
      now,
      now,
    ],
  );

  const row = await db.get<SourceRow>(`SELECT * FROM alert_sources WHERE id = ?`, [id]);
  return { source: mapSource(row!), token };
}

/** Sources with the department name and how many alerts are firing right now. */
export async function listSources(): Promise<AlertSource[]> {
  const rows = await db.all<SourceRow>(
    `SELECT s.*, t.name AS team_name,
            (SELECT COUNT(*) FROM alerts a WHERE a.source_id = s.id AND a.status = 'firing') AS firing_count
     FROM alert_sources s LEFT JOIN teams t ON t.id = s.team_id
     ORDER BY s.name`,
  );
  return rows.map(mapSource);
}

export async function updateSource(
  id: string,
  patch: { name?: string; teamId?: string | null; ticketThreshold?: AlertSeverity; enabled?: boolean },
): Promise<AlertSource | null> {
  const updates: string[] = [];
  const params: Array<string | number | null> = [];

  if (patch.name !== undefined) (updates.push('name = ?'), params.push(patch.name));
  if (patch.teamId !== undefined) (updates.push('team_id = ?'), params.push(patch.teamId));
  if (patch.ticketThreshold !== undefined) (updates.push('ticket_threshold = ?'), params.push(patch.ticketThreshold));
  if (patch.enabled !== undefined) (updates.push('enabled = ?'), params.push(fromBool(patch.enabled)));
  if (updates.length === 0) return findSource(id);

  updates.push('updated_at = ?');
  params.push(new Date().toISOString(), id);
  await db.run(`UPDATE alert_sources SET ${updates.join(', ')} WHERE id = ?`, params);
  return findSource(id);
}

export async function findSource(id: string): Promise<AlertSource | null> {
  const row = await db.get<SourceRow>(`SELECT * FROM alert_sources WHERE id = ?`, [id]);
  return row ? mapSource(row) : null;
}

export async function deleteSource(id: string): Promise<boolean> {
  const existing = await db.get<{ id: string }>(`SELECT id FROM alert_sources WHERE id = ?`, [id]);
  if (!existing) return false;
  await db.run(`DELETE FROM alert_sources WHERE id = ?`, [id]);
  return true;
}

export type SourceAuth =
  | { ok: true; source: AlertSource }
  | { ok: false; reason: 'malformed' | 'unknown' | 'disabled' };

/** Authenticates an ingest credential and returns the source it belongs to. */
export async function authenticateSource(token: string): Promise<SourceAuth> {
  const match = TOKEN_PATTERN.exec((token ?? '').trim());
  if (!match) return { ok: false, reason: 'malformed' };

  const row = await db.get<SourceRow>(`SELECT * FROM alert_sources WHERE token_prefix = ?`, [
    `${TOKEN_PREFIX}_${match[1]}`,
  ]);
  if (!row) return { ok: false, reason: 'unknown' };

  const expected = Buffer.from(row.token_hash, 'hex');
  const actual = Buffer.from(hashToken(token.trim()), 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'unknown' };
  }
  if (!toBool(row.enabled)) return { ok: false, reason: 'disabled' };

  return { ok: true, source: mapSource(row) };
}

/* -------------------------------- Alerts ---------------------------------- */

interface AlertRow {
  id: string;
  source_id: string;
  source_name?: string;
  source_kind?: string;
  dedupe_key: string;
  title: string;
  body: string | null;
  severity: string;
  status: string;
  resource: string | null;
  external_url: string | null;
  ticket_id: string | null;
  ticket_number?: number | string | null;
  occurrences: number | string;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

function mapAlert(row: AlertRow, ticketPrefix = 'ESC'): Alert {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceName: row.source_name ?? undefined,
    sourceKind: (row.source_kind as AlertSourceKind) ?? undefined,
    dedupeKey: row.dedupe_key,
    title: row.title,
    body: row.body,
    severity: row.severity as AlertSeverity,
    status: row.status as 'firing' | 'resolved',
    resource: row.resource,
    externalUrl: row.external_url,
    ticketId: row.ticket_id,
    ticketReference: row.ticket_number ? `${ticketPrefix}-${row.ticket_number}` : null,
    occurrences: Number(row.occurrences),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
  };
}

/** The alert already firing for this condition, if there is one. */
export async function findFiringAlert(sourceId: string, dedupeKey: string): Promise<Alert | null> {
  const row = await db.get<AlertRow>(
    `SELECT * FROM alerts WHERE source_id = ? AND dedupe_key = ? AND status = 'firing' ORDER BY last_seen_at DESC`,
    [sourceId, dedupeKey],
  );
  return row ? mapAlert(row) : null;
}

export async function insertAlert(input: {
  sourceId: string;
  dedupeKey: string;
  title: string;
  body?: string | null;
  severity: AlertSeverity;
  resource?: string | null;
  externalUrl?: string | null;
}): Promise<string> {
  const id = randomId();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO alerts (id, source_id, dedupe_key, title, body, severity, status, resource, external_url, occurrences, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, 'firing', ?, ?, 1, ?, ?)`,
    [
      id,
      input.sourceId,
      input.dedupeKey,
      input.title,
      input.body ?? null,
      input.severity,
      input.resource ?? null,
      input.externalUrl ?? null,
      now,
      now,
    ],
  );
  return id;
}

/** A repeat while the condition holds: count it, do not duplicate it. */
export async function touchAlert(id: string, severity?: AlertSeverity): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    `UPDATE alerts SET occurrences = occurrences + 1, last_seen_at = ?${severity ? ', severity = ?' : ''} WHERE id = ?`,
    severity ? [now, severity, id] : [now, id],
  );
}

export async function resolveAlert(id: string): Promise<void> {
  const now = new Date().toISOString();
  await db.run(`UPDATE alerts SET status = 'resolved', resolved_at = ?, last_seen_at = ? WHERE id = ?`, [
    now,
    now,
    id,
  ]);
}

export async function linkAlertToTicket(alertId: string, ticketId: string): Promise<void> {
  await db.run(`UPDATE alerts SET ticket_id = ? WHERE id = ?`, [ticketId, alertId]);
}

export interface AlertQuery {
  status?: 'firing' | 'resolved';
  sourceId?: string;
  limit?: number;
}

export async function listAlerts(query: AlertQuery = {}, ticketPrefix = 'ESC'): Promise<Alert[]> {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (query.status) (where.push('a.status = ?'), params.push(query.status));
  if (query.sourceId) (where.push('a.source_id = ?'), params.push(query.sourceId));

  const rows = await db.all<AlertRow>(
    `SELECT a.*, s.name AS source_name, s.kind AS source_kind, t.number AS ticket_number
     FROM alerts a
     JOIN alert_sources s ON s.id = a.source_id
     LEFT JOIN tickets t ON t.id = a.ticket_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.last_seen_at DESC
     LIMIT ?`,
    [...params, Math.min(query.limit ?? 100, 500)],
  );
  return rows.map((row) => mapAlert(row, ticketPrefix));
}

/* ------------------------------ Heartbeats -------------------------------- */

interface HeartbeatRow {
  id: string;
  name: string;
  slug: string;
  period_seconds: number | string;
  grace_seconds: number | string;
  severity: string;
  team_id: string | null;
  enabled: number | string;
  last_beat_at: string | null;
  status: string;
  created_at: string;
}

function mapHeartbeat(row: HeartbeatRow): Heartbeat {
  const period = Number(row.period_seconds);
  const grace = Number(row.grace_seconds);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    periodSeconds: period,
    graceSeconds: grace,
    severity: row.severity as AlertSeverity,
    teamId: row.team_id,
    enabled: toBool(row.enabled),
    lastBeatAt: row.last_beat_at,
    status: row.status as Heartbeat['status'],
    dueAt: row.last_beat_at
      ? new Date(new Date(row.last_beat_at).getTime() + (period + grace) * 1000).toISOString()
      : null,
    createdAt: row.created_at,
  };
}

export async function createHeartbeat(input: {
  name: string;
  periodSeconds: number;
  graceSeconds: number;
  severity?: AlertSeverity;
  teamId?: string | null;
}): Promise<Heartbeat> {
  const id = randomId();
  const now = new Date().toISOString();
  // Long enough not to be guessable: the slug is the whole credential.
  const slug = crypto.randomBytes(16).toString('base64url');

  await db.run(
    `INSERT INTO heartbeats (id, name, slug, period_seconds, grace_seconds, severity, team_id, enabled, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'new', ?, ?)`,
    [
      id,
      input.name,
      slug,
      input.periodSeconds,
      input.graceSeconds,
      input.severity ?? 'warning',
      input.teamId ?? null,
      now,
      now,
    ],
  );

  const row = await db.get<HeartbeatRow>(`SELECT * FROM heartbeats WHERE id = ?`, [id]);
  return mapHeartbeat(row!);
}

export async function listHeartbeats(): Promise<Heartbeat[]> {
  const rows = await db.all<HeartbeatRow>(`SELECT * FROM heartbeats ORDER BY name`);
  return rows.map(mapHeartbeat);
}

export async function findHeartbeatBySlug(slug: string): Promise<Heartbeat | null> {
  const row = await db.get<HeartbeatRow>(`SELECT * FROM heartbeats WHERE slug = ?`, [slug]);
  return row ? mapHeartbeat(row) : null;
}

export async function recordBeat(id: string): Promise<void> {
  const now = new Date().toISOString();
  await db.run(`UPDATE heartbeats SET last_beat_at = ?, status = 'ok', updated_at = ? WHERE id = ?`, [now, now, id]);
}

export async function setHeartbeatStatus(id: string, status: Heartbeat['status']): Promise<void> {
  await db.run(`UPDATE heartbeats SET status = ?, updated_at = ? WHERE id = ?`, [
    status,
    new Date().toISOString(),
    id,
  ]);
}

export async function deleteHeartbeat(id: string): Promise<boolean> {
  const existing = await db.get<{ id: string }>(`SELECT id FROM heartbeats WHERE id = ?`, [id]);
  if (!existing) return false;
  await db.run(`DELETE FROM heartbeats WHERE id = ?`, [id]);
  return true;
}

/** The source heartbeat misses are raised against, created on first need. */
export async function heartbeatSource(): Promise<AlertSource> {
  const existing = await db.get<SourceRow>(`SELECT * FROM alert_sources WHERE kind = 'heartbeat'`);
  if (existing) return mapSource(existing);
  const { source } = await createSource({ name: 'Heartbeats', kind: 'heartbeat' });
  return source;
}
