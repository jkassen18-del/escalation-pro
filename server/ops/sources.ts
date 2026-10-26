import crypto from 'node:crypto';
import { db, parseJson, toBool } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import { getSettings } from '../repositories/settings.ts';
import {
  ALERT_SOURCE_KINDS,
  SEVERITIES,
  HTTP_METHODS,
  type AlertFieldMapping,
  type AlertSource,
  type AlertSourcePoll,
  type HttpMethod,
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
  poll?: string | null;
  poll_state?: string | null;
  last_polled_at?: string | null;
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
    poll: parseJson<AlertSourcePoll | null>(row.poll, null),
    lastPolledAt: row.last_polled_at ?? null,
    lastPollError: parseJson<{ error?: string | null }>(row.poll_state, {}).error ?? null,
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
    poll: validatePoll(body.poll),
  };
}

function validatePoll(value: unknown): AlertSourcePoll | null {
  if (!value || typeof value !== 'object') return null;
  const poll = value as Record<string, unknown>;
  if (typeof poll.connectionId !== 'string' || !poll.connectionId) {
    if (poll.enabled) throw badRequest('Choose the API connection to poll.');
    return null;
  }
  const path = typeof poll.path === 'string' ? poll.path.trim().slice(0, 1000) : '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) throw badRequest('Give a path on the connection, like /api/json, not a full URL.');
  return {
    enabled: poll.enabled !== false,
    connectionId: poll.connectionId,
    method: HTTP_METHODS.includes(poll.method as HttpMethod) ? (poll.method as HttpMethod) : 'GET',
    path,
    body: typeof poll.body === 'string' && poll.body ? poll.body.slice(0, 20_000) : undefined,
    intervalSecs: Math.min(86_400, Math.max(60, Math.round(Number(poll.intervalSecs) || 300))),
    itemsPath: typeof poll.itemsPath === 'string' ? poll.itemsPath.trim().slice(0, 200) : '',
    resolveMissing: poll.resolveMissing !== false,
  };
}

export async function saveSource(
  id: string | null,
  input: Omit<ReturnType<typeof validateSource>, 'mapping'> & { mapping: AlertFieldMapping },
): Promise<AlertSource> {
  const now = new Date().toISOString();
  if (id) {
    await db.run(
      `UPDATE alert_sources SET name = ?, kind = ?, team_id = ?, escalation_policy_id = ?, default_severity = ?, mapping = ?, enabled = ?, poll = ?, updated_at = ? WHERE id = ?`,
      [input.name, input.kind, input.teamId, input.escalationPolicyId, input.defaultSeverity, JSON.stringify(input.mapping), input.enabled ? 1 : 0, input.poll ? JSON.stringify(input.poll) : null, now, id],
    );
    return (await getSource(id))!;
  }
  const sourceId = randomId();
  await db.run(
    `INSERT INTO alert_sources (id, name, kind, token, team_id, escalation_policy_id, default_severity, mapping, enabled, poll, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sourceId, input.name, input.kind, crypto.randomBytes(24).toString('base64url'), input.teamId, input.escalationPolicyId, input.defaultSeverity, JSON.stringify(input.mapping), input.enabled ? 1 : 0, input.poll ? JSON.stringify(input.poll) : null, now, now],
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

export type Normalised = Omit<AlertSignal, 'sourceType' | 'sourceId' | 'sourceName' | 'teamId' | 'escalationPolicyId'>;

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

function awsMessage(payload: Record<string, unknown>, source: AlertSource): Normalised | null {
  // SNS wraps the real event in a JSON string; EventBridge sends it bare.
  const inner = typeof payload.Message === 'string' ? parseJson<Record<string, unknown>>(payload.Message, { text: payload.Message }) : payload;
  // INSUFFICIENT_DATA means CloudWatch cannot tell, not that anything broke:
  // it neither raises an alert nor clears one.
  const alarmStatus = (state: string): Normalised['status'] | null =>
    state === 'OK' ? 'resolved' : state === 'ALARM' ? 'firing' : null;
  if (inner.AlarmName) {
    const status = alarmStatus(String(inner.NewStateValue ?? ''));
    if (!status) return null;
    return {
      title: `CloudWatch: ${inner.AlarmName}`,
      summary: [inner.NewStateReason, inner.AlarmDescription, inner.Region].filter(Boolean).map(String).join('\n'),
      severity: source.defaultSeverity,
      status,
      dedupKey: `cloudwatch:${inner.AWSAccountId ?? ''}:${inner.AlarmName}`,
      payload: inner,
    };
  }
  if (inner['detail-type'] === 'CloudWatch Alarm State Change') {
    const detail = (inner.detail ?? {}) as Record<string, unknown>;
    const state = (detail.state ?? {}) as Record<string, unknown>;
    const status = alarmStatus(String(state.value ?? ''));
    if (!status) return null;
    return {
      title: `CloudWatch: ${detail.alarmName ?? 'alarm'}`,
      summary: [state.reason, inner.region].filter(Boolean).map(String).join('\n'),
      severity: source.defaultSeverity,
      status,
      dedupKey: `cloudwatch:${inner.account ?? ''}:${detail.alarmName ?? inner.id}`,
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

function jenkins(payload: Record<string, unknown>, source: AlertSource): Normalised | null {
  const polled = jenkinsFromApi(payload, source);
  if (polled !== undefined) return polled;
  const build = (payload.build ?? {}) as Record<string, unknown>;
  const job = String(payload.name ?? payload.job ?? payload.job_name ?? 'Jenkins job');
  const status = String(build.status ?? payload.status ?? payload.result ?? '').toUpperCase();
  const phase = String(build.phase ?? 'COMPLETED').toUpperCase();
  // A build starting says nothing about health; only finished builds count.
  if (phase === 'STARTED' || phase === 'QUEUED') return null;
  return {
    title: `Jenkins: ${job} ${status === 'SUCCESS' ? 'recovered' : status ? status.toLowerCase() : 'failed'}`,
    summary: [build.full_url ?? payload.url, build.number ? `Build #${build.number}` : '', build.log].filter(Boolean).map(String).join('\n'),
    severity: status === 'UNSTABLE' ? 'sev3' : source.defaultSeverity,
    status: status === 'SUCCESS' ? 'resolved' : 'firing',
    dedupKey: `jenkins:${job}`,
    payload,
  };
}

/**
 * What Jenkins's own JSON API returns, for a source that polls it:
 * - a job from /api/json?tree=jobs[name,url,color]: red is failing, yellow
 *   unstable, blue (or green) passing; anything else (not built, disabled,
 *   aborted) says nothing. "_anime" means building: judged on the last result.
 * - a build from /job/X/lastBuild/api/json: its result, unless still building.
 * Undefined when the payload is neither, so the webhook shapes are tried.
 */
function jenkinsFromApi(payload: Record<string, unknown>, source: AlertSource): Normalised | null | undefined {
  if (typeof payload.color === 'string' && typeof payload.name === 'string') {
    const color = payload.color.replace(/_anime$/, '');
    const status = color === 'red' ? 'FAILURE' : color === 'yellow' ? 'UNSTABLE' : color === 'blue' || color === 'green' ? 'SUCCESS' : null;
    if (!status) return null;
    const job = String(payload.fullName ?? payload.name);
    return {
      title: `Jenkins: ${job} ${status === 'SUCCESS' ? 'recovered' : status.toLowerCase()}`,
      summary: String(payload.url ?? ''),
      severity: status === 'UNSTABLE' ? 'sev3' : source.defaultSeverity,
      status: status === 'SUCCESS' ? 'resolved' : 'firing',
      dedupKey: `jenkins:${job}`,
      payload,
    };
  }
  if (typeof payload.fullDisplayName === 'string' && ('result' in payload || 'building' in payload)) {
    if (payload.building === true || payload.result === null) return null;
    const status = String(payload.result ?? '').toUpperCase();
    // An aborted or skipped build says nothing about the job's health.
    if (status === 'ABORTED' || status === 'NOT_BUILT') return null;
    // "deploy-prod #42" is a build of the job "deploy-prod".
    const job = payload.fullDisplayName.replace(/\s+#\d+$/, '');
    return {
      title: `Jenkins: ${job} ${status === 'SUCCESS' ? 'recovered' : status.toLowerCase() || 'failed'}`,
      summary: [payload.url, payload.number ? `Build #${payload.number}` : ''].filter(Boolean).map(String).join('\n'),
      severity: status === 'UNSTABLE' ? 'sev3' : source.defaultSeverity,
      status: status === 'SUCCESS' ? 'resolved' : 'firing',
      dedupKey: `jenkins:${job}`,
      payload,
    };
  }
  return undefined;
}

/**
 * GitHub webhooks, recognised by their shape (the event name is in a header
 * the normaliser never sees):
 * - workflow_run: a failed Actions run on the default branch fires; the next
 *   successful run of the same workflow resolves it. Branches and pull
 *   requests are ignored - a red PR is the author's business, not an incident.
 * - deployment_status: a failed or errored deployment fires; a success resolves.
 * - code scanning, Dependabot and secret scanning alerts: created fires, fixed
 *   or dismissed resolves. A leaked secret is always the most severe.
 */
function githubEvent(payload: Record<string, unknown>, source: AlertSource): Normalised | null {
  const repo = String((payload.repository as { full_name?: string } | undefined)?.full_name ?? 'repository');
  const defaultBranch = (payload.repository as { default_branch?: string } | undefined)?.default_branch;
  const action = String(payload.action ?? '');

  const run = payload.workflow_run as Record<string, unknown> | undefined;
  if (run) {
    if (action !== 'completed') return null;
    const branch = String(run.head_branch ?? '');
    if (defaultBranch && branch !== defaultBranch) return null;
    const conclusion = String(run.conclusion ?? '');
    const failed = ['failure', 'timed_out', 'startup_failure'].includes(conclusion);
    if (!failed && conclusion !== 'success') return null; // cancelled, skipped, neutral say nothing about health
    const name = String(run.name ?? 'workflow');
    return {
      title: `GitHub Actions: ${name} ${failed ? `${conclusion.replace('_', ' ')}` : 'recovered'} on ${repo}@${branch}`,
      summary: [run.html_url, run.display_title ? `Commit: ${run.display_title}` : '', (run.actor as { login?: string } | undefined)?.login ? `By ${(run.actor as { login: string }).login}` : '']
        .filter(Boolean)
        .map(String)
        .join('\n'),
      severity: source.defaultSeverity,
      status: failed ? 'firing' : 'resolved',
      dedupKey: `github:${repo}:workflow:${name}:${branch}`,
      payload,
    };
  }

  const deployment = payload.deployment_status as Record<string, unknown> | undefined;
  if (deployment) {
    const state = String(deployment.state ?? '');
    if (!['failure', 'error', 'success'].includes(state)) return null;
    const environment = String(deployment.environment ?? (payload.deployment as { environment?: string } | undefined)?.environment ?? 'an environment');
    return {
      title: `GitHub: deployment to ${environment} ${state === 'success' ? 'succeeded' : 'failed'} (${repo})`,
      summary: String(deployment.description ?? deployment.target_url ?? deployment.log_url ?? ''),
      severity: source.defaultSeverity,
      status: state === 'success' ? 'resolved' : 'firing',
      dedupKey: `github:${repo}:deploy:${environment}`,
      payload,
    };
  }

  const alert = payload.alert as Record<string, unknown> | undefined;
  if (alert && alert.number !== undefined) {
    const kind = alert.secret_type ? 'secret' : alert.security_advisory || alert.dependency ? 'dependabot' : 'code-scanning';
    const opened = ['created', 'reopened', 'reopened_by_user', 'appeared_in_branch'].includes(action);
    const closed = ['fixed', 'dismissed', 'resolved', 'closed_by_user', 'auto_dismissed'].includes(action);
    if (!opened && !closed) return null;
    const advisory = alert.security_advisory as { summary?: string; severity?: string } | undefined;
    const rule = alert.rule as { description?: string; security_severity_level?: string; severity?: string } | undefined;
    const level = kind === 'secret' ? 'critical' : (advisory?.severity ?? rule?.security_severity_level ?? rule?.severity ?? '');
    const what =
      kind === 'secret'
        ? `secret exposed (${alert.secret_type_display_name ?? alert.secret_type})`
        : kind === 'dependabot'
          ? `vulnerable dependency: ${advisory?.summary ?? (alert.dependency as { package?: { name?: string } } | undefined)?.package?.name ?? 'a package'}`
          : `code scanning: ${rule?.description ?? 'an issue'}`;
    return {
      title: `GitHub ${what} in ${repo}`,
      summary: String(alert.html_url ?? ''),
      severity: severityFrom(level, source.defaultSeverity),
      status: closed ? 'resolved' : 'firing',
      dedupKey: `github:${repo}:${kind}:${alert.number}`,
      payload,
    };
  }

  // ping, push and everything else: nothing to page about.
  return null;
}

/** "unhealthy" and "not recovered" contain the healthy words; they are not recoveries. */
function cloudflareResolved(text: string): boolean {
  if (/\b(unhealthy|not\s+(?:healthy|recovered|resolved))\b/i.test(text)) return false;
  return /\b(resolved|recovered|healthy)\b/i.test(text);
}

function cloudflare(payload: Record<string, unknown>, source: AlertSource): Normalised {
  const data = (payload.data ?? {}) as Record<string, unknown>;
  return {
    title: `Cloudflare: ${payload.name ?? payload.alert_type ?? 'notification'}`,
    summary: str(payload.text ?? data),
    severity: severityFrom(data.severity, source.defaultSeverity),
    status: cloudflareResolved(String(payload.text ?? data.status ?? '')) ? 'resolved' : 'firing',
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
    case 'aws_sns': {
      const message = awsMessage(payload, source);
      return message ? [message] : [];
    }
    case 'azure_monitor':
      return [azure(payload, source)];
    case 'jenkins': {
      const build = jenkins(payload, source);
      return build ? [build] : [];
    }
    case 'cloudflare':
      return [cloudflare(payload, source)];
    case 'github': {
      const event = githubEvent(payload, source);
      return event ? [event] : [];
    }
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
