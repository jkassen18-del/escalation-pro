import { db, parseJson, toBool } from '../db/index.ts';
import { decryptSecret, encryptSecret, maskSecret, randomId } from '../lib/crypto.ts';
import { badRequest, forbidden, notFound } from '../lib/http.ts';
import { can } from '../middleware/auth.ts';
import { assertOutboundUrl } from '../integrations/url-guard.ts';
import { DEFAULT_EVENTS } from '../integrations/store.ts';
import { callApi, maskAuth, sealAuth } from './api-probe.ts';
import {
  CONNECTION_KINDS,
  joinUrl,
  type ApiConnectionConfig,
  type Connection,
  type ConnectionKind,
  type ConnectionRequest,
  type MailboxConfig,
  type WebhookConnectionConfig,
} from '../../shared/connections.ts';
import { HTTP_METHODS, type ApiTryResult, type MonitorConfig } from '../../shared/ops.ts';
import type { IntegrationEventToggles, PublicUser } from '../../shared/types.ts';

/**
 * Connections a department owns: its APIs, its own Slack and Teams channels,
 * and webhooks to its own tools. Only the department's people see them (and
 * administrators who manage integrations); a connection with no department
 * is shared. Secrets are encrypted at rest and never go back to the browser.
 */

interface ConnectionRow {
  id: string;
  team_id: string | null;
  team_name?: string | null;
  kind: ConnectionKind;
  name: string;
  description: string | null;
  config: string;
  events: string;
  enabled: number | string;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Server-side: secrets readable. */
export interface ConnectionRecord extends Omit<Connection, 'config' | 'canEdit'> {
  config: ApiConnectionConfig | WebhookConnectionConfig | MailboxConfig;
}

const reveal = (value: string | undefined) => {
  if (!value) return '';
  try {
    return decryptSecret(value);
  } catch {
    return '';
  }
};

function toRecord(row: ConnectionRow): ConnectionRecord {
  const stored = parseJson<Record<string, unknown>>(row.config, {});
  const config =
    row.kind === 'api'
      ? (stored as unknown as ApiConnectionConfig)
      : row.kind === 'mailbox'
        ? ({ ...(stored as unknown as MailboxConfig), clientSecret: reveal(stored.clientSecret as string | undefined) } as MailboxConfig)
        : { url: reveal(stored.url as string | undefined), signingSecret: reveal(stored.signingSecret as string | undefined) || undefined };
  return {
    id: row.id,
    teamId: row.team_id,
    teamName: row.team_name ?? null,
    kind: row.kind,
    name: row.name,
    description: row.description,
    config,
    events: { ...DEFAULT_EVENTS, ...parseJson<Partial<IntegrationEventToggles>>(row.events, {}) },
    enabled: toBool(row.enabled),
    lastUsedAt: row.last_used_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* --------------------------------- Access --------------------------------- */

export function canUseConnection(user: PublicUser, connection: Pick<ConnectionRecord, 'teamId'>): boolean {
  if (!connection.teamId) return true;
  return can(user, 'integrations.manage') || user.teamIds.includes(connection.teamId);
}

export function canManageConnection(user: PublicUser, teamId: string | null): boolean {
  if (can(user, 'integrations.manage')) return true;
  return Boolean(teamId && (user.managedTeamIds.includes(teamId) || (can(user, 'connector.manage') && user.teamIds.includes(teamId))));
}

export function toPublic(record: ConnectionRecord, user: PublicUser): Connection {
  const mailbox = record.config as MailboxConfig;
  const config =
    record.kind === 'api'
      ? { ...(record.config as ApiConnectionConfig), auth: maskAuth((record.config as ApiConnectionConfig).auth), headers: maskHeaders((record.config as ApiConnectionConfig).headers) }
      : record.kind === 'mailbox'
        ? { ...mailbox, clientSecret: undefined, hasSecret: Boolean(mailbox.clientSecret) }
        : { url: maskUrl((record.config as WebhookConnectionConfig).url), hasSigningSecret: Boolean((record.config as WebhookConnectionConfig).signingSecret) };
  return { ...record, config, canEdit: canManageConnection(user, record.teamId) };
}

/** Header values can carry keys; the browser sees the names and a mask. */
function maskHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return headers;
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, /auth|key|token|secret|cookie/i.test(name) ? maskSecret(value) : value]));
}

/** A webhook URL is its own secret: show the host and the end of it. */
function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/…${url.slice(-6)}`;
  } catch {
    return '…';
  }
}

/* --------------------------------- Reads --------------------------------- */

const SELECT = `SELECT c.*, t.name AS team_name FROM connections c LEFT JOIN teams t ON t.id = c.team_id`;

export async function listConnections(user: PublicUser, filter: { teamId?: string; kind?: ConnectionKind } = {}): Promise<ConnectionRecord[]> {
  const rows = await db.all<ConnectionRow>(`${SELECT} ORDER BY c.name`);
  return rows
    .map(toRecord)
    .filter((record) => canUseConnection(user, record))
    .filter((record) => !filter.kind || record.kind === filter.kind)
    .filter((record) => !filter.teamId || record.teamId === filter.teamId || record.teamId === null);
}

export async function findConnection(id: string): Promise<ConnectionRecord | null> {
  const row = await db.get<ConnectionRow>(`${SELECT} WHERE c.id = ?`, [id]);
  return row ? toRecord(row) : null;
}

/** Every enabled connection of a kind, whichever department owns it. Server-side only. */
export async function departmentConnectionsOfKind(kind: ConnectionKind): Promise<ConnectionRecord[]> {
  const rows = await db.all<ConnectionRow>(`${SELECT} WHERE c.kind = ? AND c.enabled = 1`, [kind]);
  return rows.map(toRecord);
}

/** The department's own channels and webhooks that want this event. */
export async function departmentConnections(teamId: string | null, kinds: ConnectionKind[]): Promise<ConnectionRecord[]> {
  if (!teamId) return [];
  const rows = await db.all<ConnectionRow>(`${SELECT} WHERE c.team_id = ? AND c.enabled = 1`, [teamId]);
  return rows.map(toRecord).filter((record) => kinds.includes(record.kind));
}

/* --------------------------------- Writes -------------------------------- */

const record = (value: unknown, max = 30): Record<string, string> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, item]) => key.trim() && typeof item === 'string')
    .slice(0, max)
    .map(([key, item]) => [key.trim().slice(0, 100), String(item).slice(0, 2000)]);
  return entries.length ? Object.fromEntries(entries) : undefined;
};

export async function saveConnection(id: string | null, body: Record<string, unknown>, user: PublicUser): Promise<ConnectionRecord> {
  const existing = id ? await findConnection(id) : null;
  if (id && !existing) throw notFound('That connection does not exist.');
  const kind = (existing?.kind ?? body.kind) as ConnectionKind;
  if (!CONNECTION_KINDS.includes(kind)) throw badRequest('Choose what kind of connection this is.');
  const teamId = typeof body.teamId === 'string' && body.teamId ? body.teamId : null;
  if (!canManageConnection(user, teamId) || (existing && !canManageConnection(user, existing.teamId))) {
    throw forbidden(teamId ? 'You cannot change this department’s connections.' : 'Only integration administrators can add shared connections.');
  }
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  if (!name) throw badRequest('Give the connection a name.');
  const raw = (body.config ?? {}) as Record<string, unknown>;

  let config: Record<string, unknown>;
  if (kind === 'mailbox') {
    const previous = existing?.kind === 'mailbox' ? (existing.config as MailboxConfig) : undefined;
    const text = (value: unknown, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
    const mailbox = text(raw.mailbox);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mailbox)) throw badRequest('Give the mailbox address, e.g. finance@company.co.za.');
    const tenantId = text(raw.tenantId);
    const clientId = text(raw.clientId);
    if (!tenantId || !clientId) throw badRequest('Give the tenant and the app registration (client) id.');
    const secret = text(raw.clientSecret, 500) || previous?.clientSecret;
    if (!secret) throw badRequest('Give the app registration’s client secret.');
    const routes = Array.isArray(raw.routes)
      ? (raw.routes as Array<Record<string, unknown>>)
          .filter((route) => typeof route?.contains === 'string' && route.contains.trim() && typeof route.teamId === 'string' && route.teamId)
          .slice(0, 30)
          .map((route) => ({ field: route.field === 'from' ? ('from' as const) : ('subject' as const), contains: String(route.contains).trim().slice(0, 200), teamId: String(route.teamId) }))
      : [];
    config = {
      tenantId,
      clientId,
      clientSecret: encryptSecret(secret),
      mailbox,
      folder: text(raw.folder, 100) || undefined,
      acknowledge: raw.acknowledge === true,
      markRead: raw.markRead !== false,
      priority: ['urgent', 'high', 'normal', 'low'].includes(raw.priority as string) ? raw.priority : undefined,
      type: ['incident', 'request', 'question', 'problem', 'escalation'].includes(raw.type as string) ? raw.type : undefined,
      routes,
    };
  } else if (kind === 'api') {
    const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
    if (!/^https?:\/\//i.test(baseUrl)) throw badRequest('The base URL must start with http:// or https://.');
    // Internal APIs are allowed; metadata and link-local addresses are not.
    assertOutboundUrl(baseUrl, 'Base URL', { allowPrivate: true });
    const previous = existing?.kind === 'api' ? (existing.config as ApiConnectionConfig) : undefined;
    // Masked header values come back as they were shown: keep the stored ones.
    const headers = record(raw.headers);
    if (headers && previous?.headers) {
      for (const [header, value] of Object.entries(headers)) if (value.includes('•') && previous.headers[header]) headers[header] = previous.headers[header];
    }
    config = {
      baseUrl,
      auth: sealAuth(raw.auth as ApiConnectionConfig['auth'], previous?.auth),
      headers,
      query: record(raw.query),
      timeoutMs: Math.min(60_000, Math.max(1000, Number(raw.timeoutMs) || 10_000)),
    };
  } else {
    const previous = existing && existing.kind !== 'api' ? (existing.config as WebhookConnectionConfig) : undefined;
    const url = typeof raw.url === 'string' && raw.url.trim() && !raw.url.includes('…') ? raw.url.trim() : (previous?.url ?? '');
    if (!url) throw badRequest('Paste the webhook URL.');
    assertOutboundUrl(url, 'Webhook URL', { allowPrivate: kind === 'webhook' });
    // A new secret replaces the stored one, null removes it, blank keeps it.
    const signingSecret = raw.signingSecret === null ? undefined : typeof raw.signingSecret === 'string' && raw.signingSecret ? raw.signingSecret : previous?.signingSecret;
    config = { url: encryptSecret(url), ...(signingSecret ? { signingSecret: encryptSecret(signingSecret) } : {}) };
  }

  const events = (body.events && typeof body.events === 'object' ? body.events : {}) as Partial<IntegrationEventToggles>;
  const now = new Date().toISOString();
  const values = [
    teamId,
    name,
    typeof body.description === 'string' ? body.description.slice(0, 500) || null : null,
    JSON.stringify(config),
    JSON.stringify(Object.fromEntries(Object.keys(DEFAULT_EVENTS).map((key) => [key, Boolean(events[key as keyof IntegrationEventToggles] ?? DEFAULT_EVENTS[key as keyof IntegrationEventToggles])]))),
    body.enabled === false ? 0 : 1,
  ];
  if (existing) {
    await db.run(`UPDATE connections SET team_id = ?, name = ?, description = ?, config = ?, events = ?, enabled = ?, updated_at = ? WHERE id = ?`, [...values, now, existing.id]);
    return (await findConnection(existing.id))!;
  }
  const newId = randomId();
  await db.run(
    `INSERT INTO connections (id, kind, team_id, name, description, config, events, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId, kind, ...values, user.id || null, now, now],
  );
  return (await findConnection(newId))!;
}

export async function deleteConnection(id: string): Promise<void> {
  await db.run(`DELETE FROM connections WHERE id = ?`, [id]);
}

export async function noteConnectionUse(id: string, error: string | null): Promise<void> {
  await db.run(`UPDATE connections SET last_used_at = ?, last_error = ? WHERE id = ?`, [new Date().toISOString(), error, id]);
}

/* -------------------------------- Calling -------------------------------- */

/**
 * The URL and request settings for a call through an API connection: the
 * connection's auth, headers and query, with the call's own on top.
 */
export function requestThrough(connection: ConnectionRecord, request: ConnectionRequest, extra: Partial<MonitorConfig> = {}): { url: string; config: MonitorConfig } {
  if (connection.kind !== 'api') throw badRequest(`${connection.name} is not an API connection.`);
  const api = connection.config as ApiConnectionConfig;
  const method = request.method && (HTTP_METHODS as readonly string[]).includes(request.method) ? request.method : 'GET';
  const path = typeof request.path === 'string' ? request.path.trim() : '';
  // A path may not swap the host: the connection is what was approved.
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) throw badRequest('Give a path on the connection, like /api/status, not a full URL.');
  return {
    url: joinUrl(api.baseUrl, path),
    config: {
      ...extra,
      method,
      headers: { ...(api.headers ?? {}), ...(request.headers ?? {}) },
      query: { ...(api.query ?? {}), ...(request.query ?? {}) },
      auth: api.auth,
      body: request.body,
      bodyType: request.bodyType,
      timeoutMs: api.timeoutMs,
      // Judged by the caller, not by status: any response is a response.
      expectedStatus: extra.expectedStatus ?? '100-599',
    },
  };
}

export async function callThrough(connection: ConnectionRecord, request: ConnectionRequest, extra: Partial<MonitorConfig> = {}): Promise<ApiTryResult> {
  const { url, config } = requestThrough(connection, request, extra);
  const result = await callApi(url, config);
  await noteConnectionUse(connection.id, result.status === null ? result.message : result.status >= 400 ? `HTTP ${result.status}` : null).catch(() => undefined);
  return result;
}

/**
 * A monitor (or source) set to call through a connection: the URL and
 * settings to use, the connection's auth replacing any of the monitor's own.
 */
export async function resolveMonitorTarget(target: string, config: MonitorConfig): Promise<{ url: string; config: MonitorConfig } | { error: string }> {
  if (!config.connectionId) return { url: target, config };
  const connection = await findConnection(config.connectionId);
  if (!connection || !connection.enabled) return { error: 'Its API connection was removed or turned off' };
  const resolved = requestThrough(
    connection,
    { method: config.method, path: config.connectionPath, headers: config.headers, query: config.query, body: config.body, bodyType: config.bodyType },
    { ...config, expectedStatus: config.expectedStatus ?? '200-399' },
  );
  return resolved;
}

/** Refuses a monitor or source that names a connection its author cannot use. */
export async function assertConnectionUsable(user: PublicUser, connectionId: string | undefined | null): Promise<void> {
  if (!connectionId) return;
  const connection = await findConnection(connectionId);
  if (!connection || !canUseConnection(user, connection)) throw badRequest('That API connection does not exist, or belongs to another department.');
  if (connection.kind !== 'api') throw badRequest(`${connection.name} is not an API connection.`);
}
