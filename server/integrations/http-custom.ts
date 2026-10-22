import crypto from 'node:crypto';
import { db, fromBool, parseJson, toBool } from '../db/index.ts';
import { decryptSecret, encryptSecret, maskSecret, randomId } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import { DEFAULT_EVENTS } from './store.ts';
import { assertOutboundUrl } from './url-guard.ts';
import type { NotificationContext } from './types.ts';
import {
  HTTP_METHODS,
  type HttpIntegration,
  type HttpIntegrationInput,
  type HttpMethod,
  type IntegrationEventToggles,
  type Ticket,
} from '../../shared/types.ts';

/**
 * Custom HTTP integrations: an administrator's own endpoint, called on ticket
 * events. For the system that has no built-in connector - an internal
 * dashboard, a CMDB, an automation platform.
 *
 * Each request can be signed: `X-InfraTicket-Signature: sha256=<hex>` is the
 * HMAC-SHA256 of `<X-InfraTicket-Timestamp>.<body>` keyed with the signing
 * secret, so the receiver can check both origin and freshness.
 */

const TIMEOUT_MS = 10_000;
const MAX_HEADERS = 20;
const MAX_TEMPLATE = 20_000;
/** Headers the sender owns; letting a template set them would break signing or framing. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'x-infraticket-signature', 'x-infraticket-timestamp', 'transfer-encoding', 'connection']);

interface HttpIntegrationRow {
  id: string;
  name: string;
  url: string;
  method: string;
  headers_encrypted: string | null;
  body_template: string | null;
  signing_secret_encrypted: string | null;
  allow_private: number | string;
  events: string;
  team_ids: string;
  enabled: number | string;
  created_at: string;
  updated_at: string;
}

/** The stored integration with its secrets decrypted, for server-side use only. */
export interface HttpIntegrationRecord extends Omit<HttpIntegration, 'headers' | 'hasSigningSecret'> {
  headers: Array<{ name: string; value: string }>;
  signingSecret: string | null;
}

function decryptHeaders(value: string | null): Array<{ name: string; value: string }> {
  if (!value) return [];
  return parseJson<Array<{ name: string; value: string }>>(decryptSecret(value), []);
}

function toRecord(row: HttpIntegrationRow): HttpIntegrationRecord {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    method: (HTTP_METHODS as readonly string[]).includes(row.method) ? (row.method as HttpMethod) : 'POST',
    headers: decryptHeaders(row.headers_encrypted),
    bodyTemplate: row.body_template,
    signingSecret: row.signing_secret_encrypted ? decryptSecret(row.signing_secret_encrypted) : null,
    allowPrivate: toBool(row.allow_private),
    events: { ...DEFAULT_EVENTS, ...parseJson<Partial<IntegrationEventToggles>>(row.events, {}) },
    teamIds: parseJson<string[]>(row.team_ids, []),
    enabled: toBool(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** What the browser may see: header names with a masked value, never the value. */
export function toPublic(record: HttpIntegrationRecord): HttpIntegration {
  const { signingSecret, headers, ...rest } = record;
  return {
    ...rest,
    headers: headers.map((header) => ({ name: header.name, preview: maskSecret(header.value) })),
    hasSigningSecret: Boolean(signingSecret),
  };
}

export async function listHttpIntegrations(): Promise<HttpIntegrationRecord[]> {
  const rows = await db.all<HttpIntegrationRow>(`SELECT * FROM http_integrations ORDER BY name`);
  return rows.map(toRecord);
}

export async function findHttpIntegration(id: string): Promise<HttpIntegrationRecord | null> {
  const row = await db.get<HttpIntegrationRow>(`SELECT * FROM http_integrations WHERE id = ?`, [id]);
  return row ? toRecord(row) : null;
}

/* --------------------------------- Writes -------------------------------- */

export function validateHttpIntegration(body: Record<string, unknown>): HttpIntegrationInput {
  const name = String(body.name ?? '').trim().slice(0, 120);
  if (!name) throw badRequest('Give the integration a name.', { name: 'Required' });
  const allowPrivate = body.allowPrivate === true;
  const url = assertOutboundUrl(String(body.url ?? '').trim(), 'URL', { allowPrivate });
  const method = String(body.method ?? 'POST').toUpperCase() as HttpMethod;
  if (!HTTP_METHODS.includes(method)) throw badRequest('The method must be POST, PUT or PATCH.', { method: 'Invalid' });

  const rawHeaders = Array.isArray(body.headers) ? body.headers : [];
  if (rawHeaders.length > MAX_HEADERS) throw badRequest(`At most ${MAX_HEADERS} headers.`);
  const headers = rawHeaders.map((raw) => {
    const header = raw as Record<string, unknown>;
    const headerName = String(header.name ?? '').trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(headerName)) {
      throw badRequest(`"${headerName}" is not a valid header name.`, { headers: 'Invalid name' });
    }
    if (RESERVED_HEADERS.has(headerName.toLowerCase())) {
      throw badRequest(`${headerName} is set by InfraTicket and cannot be overridden.`, { headers: 'Reserved' });
    }
    const value = String(header.value ?? '');
    if (/[\r\n]/.test(value) || value.length > 4000) throw badRequest(`The value of ${headerName} is not allowed.`, { headers: 'Invalid value' });
    return { name: headerName, value };
  });

  const bodyTemplate = typeof body.bodyTemplate === 'string' && body.bodyTemplate.trim() ? body.bodyTemplate : null;
  if (bodyTemplate && bodyTemplate.length > MAX_TEMPLATE) throw badRequest('The body template is too long.');

  const events = (body.events && typeof body.events === 'object' ? body.events : {}) as Partial<IntegrationEventToggles>;
  const cleanEvents: Partial<IntegrationEventToggles> = {};
  for (const key of Object.keys(DEFAULT_EVENTS) as Array<keyof IntegrationEventToggles>) {
    if (typeof events[key] === 'boolean') cleanEvents[key] = events[key];
  }

  return {
    name,
    url,
    method,
    headers,
    bodyTemplate,
    signingSecret: body.signingSecret === null ? null : typeof body.signingSecret === 'string' ? body.signingSecret.trim() : undefined,
    allowPrivate,
    events: cleanEvents,
    teamIds: Array.isArray(body.teamIds) ? body.teamIds.map(String).slice(0, 100) : [],
    enabled: body.enabled !== false,
  };
}

export async function saveHttpIntegration(id: string | null, input: HttpIntegrationInput): Promise<HttpIntegrationRecord> {
  const existing = id ? await findHttpIntegration(id) : null;
  if (id && !existing) throw badRequest('That integration no longer exists.');

  // A header sent back with an empty value is one the form showed masked and
  // the person left alone: keep what is stored.
  const headers = input.headers.map((header) => {
    if (header.value) return header;
    const kept = existing?.headers.find((stored) => stored.name.toLowerCase() === header.name.toLowerCase());
    return { name: header.name, value: kept?.value ?? '' };
  });
  const signingSecret = input.signingSecret === undefined || input.signingSecret === '' ? existing?.signingSecret ?? null : input.signingSecret;

  const now = new Date().toISOString();
  const values = [
    input.name,
    input.url,
    input.method,
    headers.length ? encryptSecret(JSON.stringify(headers)) : null,
    input.bodyTemplate,
    signingSecret ? encryptSecret(signingSecret) : null,
    fromBool(input.allowPrivate),
    JSON.stringify({ ...DEFAULT_EVENTS, ...(existing?.events ?? {}), ...input.events }),
    JSON.stringify(input.teamIds),
    fromBool(input.enabled),
  ];
  if (existing) {
    await db.run(
      `UPDATE http_integrations SET name = ?, url = ?, method = ?, headers_encrypted = ?, body_template = ?,
         signing_secret_encrypted = ?, allow_private = ?, events = ?, team_ids = ?, enabled = ?, updated_at = ? WHERE id = ?`,
      [...values, now, existing.id],
    );
    return (await findHttpIntegration(existing.id))!;
  }
  const newId = randomId();
  await db.run(
    `INSERT INTO http_integrations (name, url, method, headers_encrypted, body_template, signing_secret_encrypted,
       allow_private, events, team_ids, enabled, id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [...values, newId, now, now],
  );
  return (await findHttpIntegration(newId))!;
}

export async function deleteHttpIntegration(id: string): Promise<void> {
  await db.run(`DELETE FROM http_integrations WHERE id = ?`, [id]);
}

/* -------------------------------- Rendering ------------------------------ */

function ticketVariables(ticket: Ticket, url: string): Record<string, unknown> {
  return {
    id: ticket.id,
    reference: ticket.reference,
    subject: ticket.subject,
    description: ticket.description,
    status: ticket.status,
    priority: ticket.priority,
    type: ticket.type,
    severity: ticket.severity,
    source: ticket.source,
    teamId: ticket.teamId,
    teamName: ticket.teamName,
    assigneeName: ticket.assigneeName,
    requesterName: ticket.requesterName,
    tags: ticket.tags,
    dueAt: ticket.dueAt,
    createdAt: ticket.createdAt,
    url,
  };
}

export function templateVariables(ctx: NotificationContext): Record<string, unknown> {
  return {
    event: ctx.event,
    headline: ctx.headline,
    detail: ctx.detail ?? '',
    actor: ctx.actorName,
    ticket: ticketVariables(ctx.ticket, ctx.ticketUrl),
    sentAt: new Date().toISOString(),
  };
}

function lookup(variables: Record<string, unknown>, path: string): unknown {
  let current: unknown = variables;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function isJsonTemplate(template: string): boolean {
  return /^[[{]/.test(template.trim());
}

/**
 * Replaces `{{path}}` placeholders. Inside a JSON template each value is
 * escaped as JSON string content, so a subject with quotes or a newline
 * cannot break the document - or inject keys into it. Unknown paths are empty.
 */
export function renderTemplate(template: string, variables: Record<string, unknown>): string {
  const json = isJsonTemplate(template);
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const value = lookup(variables, path);
    const text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return json ? JSON.stringify(text).slice(1, -1) : text;
  });
}

export function renderBody(record: Pick<HttpIntegrationRecord, 'bodyTemplate'>, ctx: NotificationContext): { body: string; contentType: string } {
  const variables = templateVariables(ctx);
  if (!record.bodyTemplate) return { body: JSON.stringify(variables), contentType: 'application/json' };
  const body = renderTemplate(record.bodyTemplate, variables);
  return { body, contentType: isJsonTemplate(record.bodyTemplate) ? 'application/json' : 'text/plain; charset=utf-8' };
}

export function signBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/* --------------------------------- Sending ------------------------------- */

export interface HttpSendResult {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  /** The first 500 characters of the response, for the Test button. */
  responseExcerpt: string | null;
}

export async function sendHttpIntegration(record: HttpIntegrationRecord, ctx: NotificationContext): Promise<HttpSendResult> {
  try {
    // Re-checked at send time: the guard may have tightened since it was saved.
    const url = assertOutboundUrl(record.url, 'URL', { allowPrivate: record.allowPrivate });
    const { body, contentType } = renderBody(record, ctx);
    const headers: Record<string, string> = { 'Content-Type': contentType, 'User-Agent': 'InfraTicket-Webhook/2.0' };
    for (const header of record.headers) headers[header.name] = header.value;
    if (record.signingSecret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      headers['X-InfraTicket-Timestamp'] = timestamp;
      headers['X-InfraTicket-Signature'] = signBody(record.signingSecret, timestamp, body);
    }
    const response = await fetch(url, {
      method: record.method,
      headers,
      body,
      // A redirect could point anywhere, including where the guard said no.
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text().catch(() => '');
    const excerpt = text.slice(0, 500);
    if (!response.ok) {
      return { ok: false, statusCode: response.status, error: `HTTP ${response.status}${excerpt ? `: ${excerpt.slice(0, 200)}` : ''}`, responseExcerpt: excerpt };
    }
    return { ok: true, statusCode: response.status, error: null, responseExcerpt: excerpt };
  } catch (error) {
    const message = (error as Error).name === 'TimeoutError' ? `No response within ${TIMEOUT_MS / 1000}s` : error instanceof Error ? error.message : String(error);
    return { ok: false, statusCode: null, error: message, responseExcerpt: null };
  }
}

/** Whether this integration wants this event for this ticket. */
export function wants(record: HttpIntegrationRecord, ctx: NotificationContext): boolean {
  if (!record.enabled || !record.events[ctx.event]) return false;
  if (record.teamIds.length && !(ctx.ticket.teamId && record.teamIds.includes(ctx.ticket.teamId))) return false;
  return true;
}
