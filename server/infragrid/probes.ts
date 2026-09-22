import { db, fromBool, toBool } from '../db/index.ts';
import { randomId, encryptSecret, decryptSecret } from '../lib/crypto.ts';
import { assertProbeUrl } from './probe-url.ts';
import { createSource } from './store.ts';
import { ingestAlert } from './pipeline.ts';
import type { AlertSeverity, AlertSource, Probe, ProbeAuthKind } from '../../shared/types.ts';

/**
 * Calling out to APIs and checking they answer.
 *
 * Webhooks are push: a system only tells you about a problem while it is
 * well enough to send. A probe is pull, and is the only thing that notices a
 * service which has stopped answering altogether - the failure mode that
 * matters most and the one an inbound-only design cannot see.
 *
 * Authentication is per probe because not every endpoint needs one. A public
 * status page needs nothing; DigitalOcean wants a bearer token; Jenkins wants
 * basic auth with an API token; some internal services want a bespoke header.
 * Making it selectable is the difference between covering four systems and
 * covering all of them.
 */

interface Row {
  id: string;
  name: string;
  url: string;
  method: string;
  auth_kind: string;
  auth_name: string | null;
  auth_secret: string | null;
  expect_status: string;
  expect_body: string | null;
  interval_seconds: number | string;
  timeout_ms: number | string;
  failure_threshold: number | string;
  severity: string;
  team_id: string | null;
  enabled: number | string;
  status: string;
  consecutive_failures: number | string;
  last_checked_at: string | null;
  last_status_code: number | string | null;
  last_latency_ms: number | string | null;
  last_error: string | null;
  created_at: string;
}

function map(row: Row): Probe {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    method: row.method,
    authKind: row.auth_kind as ProbeAuthKind,
    authName: row.auth_name,
    // The credential itself is never published, only whether there is one.
    hasSecret: Boolean(row.auth_secret),
    expectStatus: row.expect_status,
    expectBody: row.expect_body,
    intervalSeconds: Number(row.interval_seconds),
    timeoutMs: Number(row.timeout_ms),
    failureThreshold: Number(row.failure_threshold),
    severity: row.severity as AlertSeverity,
    teamId: row.team_id,
    enabled: toBool(row.enabled),
    status: row.status as Probe['status'],
    consecutiveFailures: Number(row.consecutive_failures),
    lastCheckedAt: row.last_checked_at,
    lastStatusCode: row.last_status_code === null ? null : Number(row.last_status_code),
    lastLatencyMs: row.last_latency_ms === null ? null : Number(row.last_latency_ms),
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

export interface ProbeInput {
  name: string;
  url: string;
  method?: string;
  authKind?: ProbeAuthKind;
  authName?: string | null;
  /** Empty or absent leaves a stored credential untouched. */
  authSecret?: string | null;
  expectStatus?: string;
  expectBody?: string | null;
  intervalSeconds?: number;
  timeoutMs?: number;
  failureThreshold?: number;
  severity?: AlertSeverity;
  teamId?: string | null;
}

export async function createProbe(input: ProbeInput): Promise<Probe> {
  const id = randomId();
  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO probes (id, name, url, method, auth_kind, auth_name, auth_secret, expect_status, expect_body,
       interval_seconds, timeout_ms, failure_threshold, severity, team_id, enabled, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'unknown', ?, ?)`,
    [
      id,
      input.name,
      assertProbeUrl(input.url),
      (input.method ?? 'GET').toUpperCase(),
      input.authKind ?? 'none',
      input.authName ?? null,
      input.authSecret ? encryptSecret(input.authSecret) : null,
      input.expectStatus ?? '2xx',
      input.expectBody ?? null,
      Math.max(30, input.intervalSeconds ?? 300),
      Math.min(30_000, Math.max(1000, input.timeoutMs ?? 10_000)),
      Math.max(1, input.failureThreshold ?? 2),
      input.severity ?? 'critical',
      input.teamId ?? null,
      now,
      now,
    ],
  );

  return (await findProbe(id))!;
}

export async function findProbe(id: string): Promise<Probe | null> {
  const row = await db.get<Row>(`SELECT * FROM probes WHERE id = ?`, [id]);
  return row ? map(row) : null;
}

export async function listProbes(): Promise<Probe[]> {
  const rows = await db.all<Row>(`SELECT * FROM probes ORDER BY name`);
  return rows.map(map);
}

export async function updateProbe(id: string, patch: Partial<ProbeInput> & { enabled?: boolean }): Promise<Probe | null> {
  const updates: string[] = [];
  const params: Array<string | number | null> = [];
  const set = (column: string, value: string | number | null) => {
    updates.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.name !== undefined) set('name', patch.name);
  if (patch.url !== undefined) set('url', assertProbeUrl(patch.url));
  if (patch.method !== undefined) set('method', patch.method.toUpperCase());
  if (patch.authKind !== undefined) set('auth_kind', patch.authKind);
  if (patch.authName !== undefined) set('auth_name', patch.authName);
  // An empty secret means "leave what is stored alone", so a form that does
  // not re-send the credential cannot silently erase it.
  if (patch.authSecret) set('auth_secret', encryptSecret(patch.authSecret));
  if (patch.expectStatus !== undefined) set('expect_status', patch.expectStatus);
  if (patch.expectBody !== undefined) set('expect_body', patch.expectBody);
  if (patch.intervalSeconds !== undefined) set('interval_seconds', Math.max(30, patch.intervalSeconds));
  if (patch.timeoutMs !== undefined) set('timeout_ms', Math.min(30_000, Math.max(1000, patch.timeoutMs)));
  if (patch.failureThreshold !== undefined) set('failure_threshold', Math.max(1, patch.failureThreshold));
  if (patch.severity !== undefined) set('severity', patch.severity);
  if (patch.teamId !== undefined) set('team_id', patch.teamId);
  if (patch.enabled !== undefined) set('enabled', fromBool(patch.enabled));

  if (updates.length === 0) return findProbe(id);

  set('updated_at', new Date().toISOString());
  params.push(id);
  await db.run(`UPDATE probes SET ${updates.join(', ')} WHERE id = ?`, params);
  return findProbe(id);
}

export async function deleteProbe(id: string): Promise<boolean> {
  const existing = await db.get<{ id: string }>(`SELECT id FROM probes WHERE id = ?`, [id]);
  if (!existing) return false;
  await db.run(`DELETE FROM probes WHERE id = ?`, [id]);
  return true;
}

/* -------------------------------- Running --------------------------------- */

export interface ProbeResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
}

/** Applies the probe's chosen authentication to the outgoing request. */
function applyAuth(probe: Probe, secret: string | null, url: URL, headers: Record<string, string>): void {
  if (probe.authKind === 'none' || !secret) return;

  switch (probe.authKind) {
    case 'bearer':
      headers.Authorization = `Bearer ${secret}`;
      break;
    case 'basic':
      // Stored as "user:password"; encoded here so the stored form stays readable.
      headers.Authorization = `Basic ${Buffer.from(secret, 'utf8').toString('base64')}`;
      break;
    case 'header':
      if (probe.authName) headers[probe.authName] = secret;
      break;
    case 'query':
      if (probe.authName) url.searchParams.set(probe.authName, secret);
      break;
  }
}

function statusMatches(expect: string, status: number): boolean {
  const wanted = expect.trim().toLowerCase();
  if (!wanted || wanted === '2xx') return status >= 200 && status < 300;
  if (/^\dxx$/.test(wanted)) return Math.floor(status / 100) === Number(wanted[0]);
  return String(status) === wanted;
}

/**
 * Calls the endpoint once and decides whether it is healthy.
 *
 * A timeout, a refused connection and a DNS failure are all just "down" -
 * which is right, because from the point of view of whoever depends on this
 * service they are indistinguishable.
 */
/**
 * What actually went wrong, rather than "fetch failed".
 *
 * Node reports every transport failure with that one phrase and hides the
 * reason in `cause`. An administrator looking at a check that will not pass
 * needs to know whether the name did not resolve, the port refused the
 * connection, or the certificate was rejected - those have three different
 * fixes, and "fetch failed" points at none of them.
 */
function describeFetchFailure(error: unknown): string {
  const top = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: unknown })?.cause;
  const causeMessage = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  const code = (cause as { code?: string })?.code ?? (error as { code?: string })?.code;

  const explained: Record<string, string> = {
    ECONNREFUSED: 'Nothing is listening on that host and port',
    ENOTFOUND: 'That hostname does not resolve',
    EAI_AGAIN: 'That hostname could not be resolved right now',
    ECONNRESET: 'The connection was closed before a reply arrived',
    EHOSTUNREACH: 'That host is unreachable from this server',
    ETIMEDOUT: 'The connection timed out',
    CERT_HAS_EXPIRED: 'The TLS certificate has expired',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'The TLS certificate is self-signed and not trusted here',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The TLS certificate chain could not be verified',
  };

  if (code && explained[code]) return `${explained[code]} (${code})`;
  if (causeMessage && causeMessage !== top) return causeMessage;
  return top;
}

export async function runProbe(probe: Probe): Promise<ProbeResult> {
  const row = await db.get<{ auth_secret: string | null }>(`SELECT auth_secret FROM probes WHERE id = ?`, [probe.id]);
  let secret: string | null = null;
  if (row?.auth_secret) {
    try {
      secret = decryptSecret(row.auth_secret);
    } catch {
      return { ok: false, statusCode: null, latencyMs: 0, error: 'The stored credential could not be decrypted' };
    }
  }

  const url = new URL(probe.url);
  const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*' };
  applyAuth(probe, secret, url, headers);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), probe.timeoutMs);
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: probe.method,
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    const latencyMs = Date.now() - started;

    if (!statusMatches(probe.expectStatus, response.status)) {
      return {
        ok: false,
        statusCode: response.status,
        latencyMs,
        error: `Expected ${probe.expectStatus}, got ${response.status}`,
      };
    }

    if (probe.expectBody) {
      // Bounded: a health endpoint that returns a gigabyte is its own problem,
      // and reading it all would make the probe the outage.
      const body = (await response.text()).slice(0, 100_000);
      if (!body.includes(probe.expectBody)) {
        return {
          ok: false,
          statusCode: response.status,
          latencyMs,
          error: `Response did not contain "${probe.expectBody}"`,
        };
      }
    }

    return { ok: true, statusCode: response.status, latencyMs, error: null };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      statusCode: null,
      latencyMs,
      error: aborted ? `No response within ${probe.timeoutMs}ms` : describeFetchFailure(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The source probe alerts hang off, created on first need. */
export async function probeSource(): Promise<AlertSource> {
  const existing = await db.get<Row & { kind?: string }>(`SELECT * FROM alert_sources WHERE kind = 'probe'`);
  if (existing) {
    const { findSource } = await import('./store.ts');
    return (await findSource(existing.id))!;
  }
  const { source } = await createSource({ name: 'API health checks', kind: 'probe' });
  return source;
}

/**
 * Runs a probe and records what happened, raising or clearing an alert.
 *
 * A failure only alerts once it has repeated `failureThreshold` times. One
 * timeout is a blip and waking somebody for it is how people learn to ignore
 * the alerts - which costs far more than the blip did.
 */
export async function checkProbe(probe: Probe): Promise<{ result: ProbeResult; alerted: boolean; cleared: boolean }> {
  const result = await runProbe(probe);
  const now = new Date().toISOString();
  const failures = result.ok ? 0 : probe.consecutiveFailures + 1;
  const nextStatus: Probe['status'] = result.ok
    ? 'up'
    : failures >= probe.failureThreshold
      ? 'down'
      : probe.status === 'down'
        ? 'down'
        : probe.status;

  await db.run(
    `UPDATE probes SET status = ?, consecutive_failures = ?, last_checked_at = ?, last_status_code = ?,
       last_latency_ms = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    [nextStatus, failures, now, result.statusCode, result.latencyMs, result.error, now, probe.id],
  );

  const source = await probeSource();
  const dedupeKey = `probe:${probe.id}`;
  const routed = { ...source, teamId: probe.teamId ?? source.teamId };

  if (nextStatus === 'down' && probe.status !== 'down') {
    await ingestAlert(routed, {
      dedupeKey,
      title: `${probe.name} is not healthy`,
      body: [
        result.error,
        `URL: ${probe.url}`,
        `Failed ${failures} check${failures === 1 ? '' : 's'} in a row.`,
      ]
        .filter(Boolean)
        .join('\n'),
      severity: probe.severity,
      status: 'firing',
      resource: probe.name,
      externalUrl: probe.url,
    });
    return { result, alerted: true, cleared: false };
  }

  if (result.ok && probe.status === 'down') {
    await ingestAlert(routed, {
      dedupeKey,
      title: `${probe.name} is healthy again`,
      severity: 'info',
      status: 'resolved',
      resource: probe.name,
    });
    return { result, alerted: false, cleared: true };
  }

  return { result, alerted: false, cleared: false };
}

export interface ProbeSweepResult {
  checked: number;
  alerted: number;
  cleared: number;
}

/**
 * Runs every probe that is due.
 *
 * Each probe has its own interval, so a cheap status page can be checked
 * every minute while an expensive report endpoint is checked hourly, without
 * one forcing the other's cadence.
 */
export async function sweepProbes(now = new Date()): Promise<ProbeSweepResult> {
  const probes = await listProbes();
  const result: ProbeSweepResult = { checked: 0, alerted: 0, cleared: 0 };

  const due = probes.filter((probe) => {
    if (!probe.enabled) return false;
    if (!probe.lastCheckedAt) return true;
    return now.getTime() - new Date(probe.lastCheckedAt).getTime() >= probe.intervalSeconds * 1000;
  });

  // Sequential on purpose: a deployment watching fifty endpoints should not
  // open fifty sockets at once, and none of this is latency-sensitive.
  for (const probe of due) {
    try {
      const outcome = await checkProbe(probe);
      result.checked += 1;
      if (outcome.alerted) result.alerted += 1;
      if (outcome.cleared) result.cleared += 1;
    } catch (error) {
      console.error(`[probe] ${probe.name} failed to run`, error);
    }
  }

  return result;
}
