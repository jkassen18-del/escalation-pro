import crypto from 'node:crypto';
import { db, parseJson, toBool } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import { getSettings } from '../repositories/settings.ts';
import {
  ALERT_SOURCE_KINDS,
  SEVERITIES,
  type AlertFieldMapping,
  type AlertSource,
  type AlertSourceKind,
  type Severity,
} from '../../shared/ops.ts';
import type { AlertSignal } from './alerts.ts';

/**
 * Alert sources: anything that can POST to a URL.
 *
 * Each source gets its own URL with a secret token in it, which is how a
 * request proves it came from the source (most providers cannot sign a
 * webhook). AWS SNS can, and its signature is verified on top of the token.
 * Each provider's payload is normalised into the same signal shape before it
 * reaches the pipeline.
 */

interface SourceRow {
  id: string;
  name: string;
  kind: AlertSourceKind;
  token: string;
  team_id: string | null;
  team_name?: string | null;
  escalation_policy_id: string | null;
  default_severity: Severity;
  mapping: string;
  enabled: number | string;
  last_event_at: string | null;
  event_count: number | string;
  created_at: string;
}

async function ingestBase(): Promise<string> {
  const settings = await getSettings();
  return (settings.appUrl || process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
}

function mapSource(row: SourceRow, base: string): AlertSource {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    teamId: row.team_id,
    teamName: row.team_name ?? null,
    escalationPolicyId: row.escalation_policy_id,
    defaultSeverity: row.default_severity,
    mapping: parseJson<AlertFieldMapping>(row.mapping, {}),
    enabled: toBool(row.enabled),
    webhookUrl: `${base}/api/ingest/${row.token}`,
    lastEventAt: row.last_event_at,
    eventCount: Number(row.event_count),
    createdAt: row.created_at,
  };
}

export async function listSources(): Promise<AlertSource[]> {
  const base = await ingestBase();
  const rows = await db.all<SourceRow>(`SELECT s.*, t.name AS team_name FROM alert_sources s LEFT JOIN teams t ON t.id = s.team_id ORDER BY s.name`);
  return rows.map((row) => mapSource(row, base));
}

export async function getSource(id: string): Promise<AlertSource | null> {
  const row = await db.get<SourceRow>(`SELECT s.*, t.name AS team_name FROM alert_sources s LEFT JOIN teams t ON t.id = s.team_id WHERE s.id = ?`, [id]);
  return row ? mapSource(row, await ingestBase()) : null;
}

export async function sourceByToken(token: string): Promise<(AlertSource & { token: string }) | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const row = await db.get<SourceRow>(`SELECT * FROM alert_sources WHERE token = ?`, [token]);
  return row ? { ...mapSource(row, await ingestBase()), token: row.token } : null;
}

export function validateSource(body: Record<string, unknown>) {
  const name = String(body.name ?? '').trim().slice(0, 120);
  if (!name) throw badRequest('Give the source a name.', { name: 'Required' });
  const kind = body.kind as AlertSourceKind;
  if (!ALERT_SOURCE_KINDS.includes(kind)) throw badRequest('Unknown source type.');
  const mapping = (body.mapping && typeof body.mapping === 'object' ? body.mapping : {}) as AlertFieldMapping;
  return {
    name,
    kind,
    teamId: typeof body.teamId === 'string' && body.teamId ? body.teamId : null,
    escalationPolicyId: typeof body.escalationPolicyId === 'string' && body.escalationPolicyId ? body.escalationPolicyId : null,
    defaultSeverity: SEVERITIES.includes(body.defaultSeverity as Severity) ? (body.defaultSeverity as Severity) : 'sev3',
    mapping: {
      title: mapping.title?.slice(0, 200),
      summary: mapping.summary?.slice(0, 200),
      severity: mapping.severity?.slice(0, 200),
      dedupKey: mapping.dedupKey?.slice(0, 200),
      status: mapping.status?.slice(0, 200),
      resolvedValues: Array.isArray(mapping.resolvedValues) ? mapping.resolvedValues.map(String).slice(0, 10) : undefined,
    },
    enabled: body.enabled !== false,
  };
}

export async function saveSource(id: string | null, input: ReturnType<typeof validateSource>): Promise<AlertSource> {
  const now = new Date().toISOString();
  if (id) {
    await db.run(
      `UPDATE alert_sources SET name = ?, kind = ?, team_id = ?, escalation_policy_id = ?, default_severity = ?, mapping = ?, enabled = ?, updated_at = ? WHERE id = ?`,
      [input.name, input.kind, input.teamId, input.escalationPolicyId, input.defaultSeverity, JSON.stringify(input.mapping), input.enabled ? 1 : 0, now, id],
    );
    return (await getSource(id))!;
  }
  const sourceId = randomId();
  await db.run(
    `INSERT INTO alert_sources (id, name, kind, token, team_id, escalation_policy_id, default_severity, mapping, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sourceId, input.name, input.kind, crypto.randomBytes(24).toString('base64url'), input.teamId, input.escalationPolicyId, input.defaultSeverity, JSON.stringify(input.mapping), input.enabled ? 1 : 0, now, now],
  );
  return (await getSource(sourceId))!;
}

export async function rotateSourceToken(id: string): Promise<AlertSource | null> {
  await db.run(`UPDATE alert_sources SET token = ?, updated_at = ? WHERE id = ?`, [crypto.randomBytes(24).toString('base64url'), new Date().toISOString(), id]);
  return getSource(id);
}

export async function noteSourceEvent(id: string): Promise<void> {
  await db.run(`UPDATE alert_sources SET last_event_at = ?, event_count = event_count + 1 WHERE id = ?`, [new Date().toISOString(), id]);
}

/* ------------------------------ Normalising ------------------------------ */

/** "alert.labels.severity" or "alerts[0].status" into a payload. */
export function readPath(payload: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let current: unknown = payload;
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function severityFrom(value: unknown, fallback: Severity): Severity {
  const text = String(value ?? '').toLowerCase().trim();
  if (!text) return fallback;
  if ((SEVERITIES as readonly string[]).includes(text)) return text as Severity;
  if (/^(critical|crit|emergency|fatal|disaster|p1|sev0|0)$/.test(text)) return 'sev1';
  if (/^(error|major|high|p2|1)$/.test(text)) return 'sev2';
  if (/^(warning|warn|minor|medium|average|p3|2)$/.test(text)) return 'sev3';
  if (/^(info|information|informational|low|notice|ok|p4|p5|3|4)$/.test(text)) return 'sev4';
  return fallback;
}

const RESOLVED_WORDS = ['resolved', 'ok', 'recovered', 'success', 'closed', 'inactive', 'normal'];

function str(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

type Normalised = Omit<AlertSignal, 'sourceType' | 'sourceId' | 'sourceName' | 'teamId' | 'escalationPolicyId'>;

function generic(payload: Record<string, unknown>, source: AlertSource): Normalised {
  const m = source.mapping;
  const pick = (path: string | undefined, ...defaults: string[]) => {
    const mapped = readPath(payload, path);
    if (mapped !== undefined) return mapped;
    for (const key of defaults) {
      const value = readPath(payload, key);
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  };
  const title = str(pick(m.title, 'title', 'summary', 'name', 'subject', 'message', 'alert', 'event'), 'Alert');
  const statusText = str(pick(m.status, 'status', 'state', 'event_type')).toLowerCase();
  const resolvedValues = (m.resolvedValues?.length ? m.resolvedValues : RESOLVED_WORDS).map((v) => v.toLowerCase());
  return {
    title: title.slice(0, 300),
    summary: str(pick(m.summary, 'description', 'details', 'message', 'text', 'body')).slice(0, 4000),
    severity: severityFrom(pick(m.severity, 'severity', 'priority', 'level'), source.defaultSeverity),
    status: resolvedValues.includes(statusText) ? 'resolved' : 'firing',
    dedupKey: str(pick(m.dedupKey, 'dedup_key', 'dedupKey', 'fingerprint', 'id', 'alert_id', 'incident_key'), title).slice(0, 300),
    payload,
  };
}

function awsMessage(payload: Record<string, unknown>, source: AlertSource): Normalised {
  // SNS wraps the real event in a JSON string; EventBridge sends it bare.
  const inner = typeof payload.Message === 'string' ? parseJson<Record<string, unknown>>(payload.Message, { text: payload.Message }) : payload;
  if (inner.AlarmName) {
    const state = String(inner.NewStateValue ?? '');
    return {
      title: `CloudWatch: ${inner.AlarmName}`,
      summary: [inner.NewStateReason, inner.AlarmDescription, inner.Region].filter(Boolean).map(String).join('\n'),
      severity: source.defaultSeverity,
      status: state === 'OK' ? 'resolved' : 'firing',
      dedupKey: `cloudwatch:${inner.AWSAccountId ?? ''}:${inner.AlarmName}`,
      payload: inner,
    };
  }
  if (inner.source === 'aws.health') {
    const detail = (inner.detail ?? {}) as Record<string, unknown>;
    const description = Array.isArray(detail.eventDescription) ? (detail.eventDescription[0] as { latestDescription?: string })?.latestDescription : '';
    return {
      title: `AWS Health: ${detail.eventTypeCode ?? 'event'} (${detail.service ?? inner.region ?? ''})`,
      summary: String(description ?? ''),
      severity: String(detail.eventTypeCategory) === 'issue' ? 'sev2' : 'sev4',
      status: String(detail.statusCode) === 'closed' ? 'resolved' : 'firing',
      dedupKey: `aws-health:${detail.eventArn ?? inner.id}`,
      payload: inner,
    };
  }
  return generic({ ...inner, title: inner.title ?? payload.Subject ?? 'AWS notification' }, source);
}

function azure(payload: Record<string, unknown>, source: AlertSource): Normalised {
  const essentials = readPath(payload, 'data.essentials') as Record<string, unknown> | undefined;
  if (!essentials) return generic(payload, source);
  const sev = String(essentials.severity ?? '').replace(/^sev/i, '');
  const severity: Severity = sev === '0' ? 'sev1' : sev === '1' ? 'sev2' : sev === '2' ? 'sev3' : sev ? 'sev4' : source.defaultSeverity;
  const targets = Array.isArray(essentials.configurationItems) ? essentials.configurationItems.join(', ') : '';
  return {
    title: `Azure: ${essentials.alertRule ?? 'alert'}${targets ? ` on ${targets}` : ''}`,
    summary: str(essentials.description ?? essentials.monitoringService),
    severity,
    status: String(essentials.monitorCondition) === 'Resolved' ? 'resolved' : 'firing',
    dedupKey: `azure:${essentials.originAlertId ?? essentials.alertId ?? essentials.alertRule}`,
    payload,
  };
}

function jenkins(payload: Record<string, unknown>, source: AlertSource): Normalised {
  const build = (payload.build ?? {}) as Record<string, unknown>;
  const job = String(payload.name ?? payload.job ?? payload.job_name ?? 'Jenkins job');
  const status = String(build.status ?? payload.status ?? payload.result ?? '').toUpperCase();
  const phase = String(build.phase ?? 'COMPLETED').toUpperCase();
  return {
    title: `Jenkins: ${job} ${status === 'SUCCESS' ? 'recovered' : status ? status.toLowerCase() : 'failed'}`,
    summary: [build.full_url ?? payload.url, build.number ? `Build #${build.number}` : '', build.log].filter(Boolean).map(String).join('\n'),
    severity: status === 'UNSTABLE' ? 'sev3' : source.defaultSeverity,
    status: status === 'SUCCESS' || (phase === 'STARTED' && !status) ? 'resolved' : 'firing',
    dedupKey: `jenkins:${job}`,
    payload,
  };
}

function cloudflare(payload: Record<string, unknown>, source: AlertSource): Normalised {
  const data = (payload.data ?? {}) as Record<string, unknown>;
  return {
    title: `Cloudflare: ${payload.name ?? payload.alert_type ?? 'notification'}`,
    summary: str(payload.text ?? data),
    severity: severityFrom(data.severity, source.defaultSeverity),
    status: /resolved|recovered|healthy/i.test(String(payload.text ?? data.status ?? '')) ? 'resolved' : 'firing',
    dedupKey: `cloudflare:${payload.alert_type ?? ''}:${data.zone_name ?? data.pool_name ?? data.tunnel_name ?? payload.name ?? ''}`,
    payload,
  };
}

/** Alertmanager and Grafana batch several alerts per request. */
function alertmanager(payload: Record<string, unknown>, source: AlertSource): Normalised[] {
  const alerts = Array.isArray(payload.alerts) ? (payload.alerts as Array<Record<string, unknown>>) : null;
  if (!alerts) return [generic(payload, source)];
  return alerts.map((alert) => {
    const labels = (alert.labels ?? {}) as Record<string, string>;
    const annotations = (alert.annotations ?? {}) as Record<string, string>;
    return {
      title: annotations.summary || labels.alertname || 'Alert',
      summary: annotations.description || annotations.message || '',
      severity: severityFrom(labels.severity, source.defaultSeverity),
      status: alert.status === 'resolved' ? 'resolved' : 'firing',
      dedupKey: String(alert.fingerprint ?? `${labels.alertname}:${labels.instance ?? ''}`),
      payload: alert,
    };
  });
}

export function normalise(source: AlertSource, payload: Record<string, unknown>): Normalised[] {
  switch (source.kind) {
    case 'aws_sns':
      return [awsMessage(payload, source)];
    case 'azure_monitor':
      return [azure(payload, source)];
    case 'jenkins':
      return [jenkins(payload, source)];
    case 'cloudflare':
      return [cloudflare(payload, source)];
    case 'grafana':
      return alertmanager(payload, source);
    default:
      return [generic(payload, source)];
  }
}

/* ------------------------------- AWS SNS --------------------------------- */

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

function snsStringToSign(message: Record<string, string>): string {
  const keys =
    message.Type === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.filter((key) => message[key] !== undefined).map((key) => `${key}\n${message[key]}\n`).join('');
}

const certCache = new Map<string, string>();

/**
 * Checks an SNS message really came from AWS: its signing certificate must be
 * served by an SNS host, and the signature over the canonical fields must verify.
 */
export async function verifySnsMessage(message: Record<string, string>): Promise<boolean> {
  try {
    const certUrl = new URL(message.SigningCertURL ?? '');
    if (certUrl.protocol !== 'https:' || !SNS_HOST.test(certUrl.hostname) || !certUrl.pathname.endsWith('.pem')) return false;
    let pem = certCache.get(certUrl.href);
    if (!pem) {
      const response = await fetch(certUrl, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return false;
      pem = await response.text();
      certCache.set(certUrl.href, pem);
    }
    const algorithm = message.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
    return crypto.verify(algorithm, Buffer.from(snsStringToSign(message), 'utf8'), pem, Buffer.from(message.Signature ?? '', 'base64'));
  } catch {
    return false;
  }
}

/** SNS asks before it sends: visiting SubscribeURL is how a subscription is confirmed. */
export async function confirmSnsSubscription(message: Record<string, string>): Promise<boolean> {
  try {
    const url = new URL(message.SubscribeURL ?? '');
    if (url.protocol !== 'https:' || !SNS_HOST.test(url.hostname)) return false;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return response.ok;
  } catch {
    return false;
  }
}
