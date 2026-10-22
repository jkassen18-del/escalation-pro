import crypto from 'node:crypto';
import { db, parseJson, toBool } from '../db/index.ts';
import { decryptSecret, randomId } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import { getSettings } from '../repositories/settings.ts';
import { MONITOR_KINDS, SEVERITIES, type BackupEngine, type Monitor, type MonitorCheck, type MonitorConfig, type MonitorDay, type MonitorKind, type MonitorState, type Severity } from '../../shared/ops.ts';
import { ingestSignal } from './alerts.ts';
import { checkDatabaseHealth } from './db-health.ts';
import { runProbe, type ProbeResult } from './probes.ts';

/**
 * Built-in monitors and the loop that runs them.
 *
 * A monitor goes down only after `failure_threshold` consecutive failures, so
 * one dropped packet does not wake anyone; it comes back up on the first
 * success. Each transition is a signal into the alert pipeline, which opens
 * (or resolves) the incident and drives paging.
 */

interface MonitorRow {
  id: string;
  name: string;
  kind: MonitorKind;
  target: string;
  config: string;
  interval_secs: number | string;
  grace_secs: number | string;
  failure_threshold: number | string;
  team_id: string | null;
  team_name?: string | null;
  severity: Severity;
  escalation_policy_id: string | null;
  enabled: number | string;
  state: MonitorState;
  heartbeat_token: string | null;
  last_ping_at: string | null;
  last_checked_at: string | null;
  last_change_at: string | null;
  last_latency_ms: number | string | null;
  last_message: string | null;
  consecutive_failures: number | string;
  next_check_at: string | null;
  created_at: string;
  updated_at: string;
  checks_24h?: number | string | null;
  failures_24h?: number | string | null;
}

async function baseUrl(): Promise<string> {
  const settings = await getSettings();
  return (settings.appUrl || process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
}

function mapMonitor(row: MonitorRow, base: string): Monitor {
  const checks = Number(row.checks_24h ?? 0);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    target: row.target,
    config: parseJson<MonitorConfig>(row.config, {}),
    intervalSecs: Number(row.interval_secs),
    graceSecs: Number(row.grace_secs),
    failureThreshold: Number(row.failure_threshold),
    teamId: row.team_id,
    teamName: row.team_name ?? null,
    severity: row.severity,
    escalationPolicyId: row.escalation_policy_id,
    enabled: toBool(row.enabled),
    state: toBool(row.enabled) ? row.state : 'paused',
    lastCheckedAt: row.last_checked_at,
    lastChangeAt: row.last_change_at,
    lastLatencyMs: row.last_latency_ms === null ? null : Number(row.last_latency_ms),
    lastMessage: row.last_message,
    consecutiveFailures: Number(row.consecutive_failures),
    heartbeatUrl: row.kind === 'heartbeat' && row.heartbeat_token ? `${base}/api/heartbeat/${row.heartbeat_token}` : null,
    uptime24h: checks ? Math.round(((checks - Number(row.failures_24h ?? 0)) / checks) * 10000) / 100 : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_MONITOR = `
  SELECT m.*, t.name AS team_name,
    (SELECT COUNT(*) FROM monitor_checks c WHERE c.monitor_id = m.id AND c.created_at >= ?) AS checks_24h,
    (SELECT COUNT(*) FROM monitor_checks c WHERE c.monitor_id = m.id AND c.created_at >= ? AND c.ok = 0) AS failures_24h
  FROM monitors m LEFT JOIN teams t ON t.id = m.team_id`;

export async function listMonitors(): Promise<Monitor[]> {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const base = await baseUrl();
  const rows = await db.all<MonitorRow>(`${SELECT_MONITOR} ORDER BY m.name`, [since, since]);
  return rows.map((row) => mapMonitor(row, base));
}

export async function getMonitor(id: string): Promise<Monitor | null> {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const row = await db.get<MonitorRow>(`${SELECT_MONITOR} WHERE m.id = ?`, [since, since, id]);
  return row ? mapMonitor(row, await baseUrl()) : null;
}

export async function monitorChecks(id: string, limit = 100): Promise<MonitorCheck[]> {
  const rows = await db.all<{ id: string; ok: number; latency_ms: number | null; message: string; created_at: string }>(
    `SELECT * FROM monitor_checks WHERE monitor_id = ? ORDER BY created_at DESC LIMIT ?`,
    [id, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    ok: toBool(row.ok),
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    message: row.message,
    createdAt: row.created_at,
  }));
}

export async function monitorDays(id: string, days = 90): Promise<MonitorDay[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.all<{ day: string; total: number; failures: number }>(
    `SELECT day, total, failures FROM monitor_daily WHERE monitor_id = ? AND day >= ? ORDER BY day`,
    [id, since],
  );
  return rows.map((row) => ({ day: row.day, total: Number(row.total), failures: Number(row.failures) }));
}

/* --------------------------------- Writes -------------------------------- */

export interface MonitorInput {
  name: string;
  kind: MonitorKind;
  target: string;
  config: MonitorConfig;
  intervalSecs: number;
  graceSecs: number;
  failureThreshold: number;
  teamId: string | null;
  severity: Severity;
  escalationPolicyId: string | null;
  enabled: boolean;
}

export function validateMonitor(body: Record<string, unknown>): MonitorInput {
  const name = String(body.name ?? '').trim().slice(0, 120);
  if (!name) throw badRequest('Give the monitor a name.', { name: 'Required' });
  const kind = body.kind as MonitorKind;
  if (!MONITOR_KINDS.includes(kind)) throw badRequest('Unknown monitor type.');
  const target = String(body.target ?? '').trim().slice(0, 2000);
  const config = (body.config && typeof body.config === 'object' ? body.config : {}) as MonitorConfig;
  if (kind === 'http' && !/^https?:\/\//i.test(target)) throw badRequest('HTTP monitors need a URL starting with http:// or https://', { target: 'Must be a URL' });
  if (['tcp', 'ping', 'dns', 'ssl'].includes(kind) && !target) throw badRequest('Give the host to check.', { target: 'Required' });
  if (kind === 'database' && !config.databaseId) throw badRequest('Pick the database to check.', { databaseId: 'Required' });
  const intervalSecs = Math.round(Number(body.intervalSecs ?? 60));
  if (!(intervalSecs >= 20 && intervalSecs <= 86_400)) throw badRequest('Check between every 20 seconds and once a day.');
  const severity = SEVERITIES.includes(body.severity as Severity) ? (body.severity as Severity) : 'sev2';
  return {
    name,
    kind,
    target,
    config: {
      ...config,
      headers: config.headers && typeof config.headers === 'object' ? config.headers : undefined,
      timeoutMs: config.timeoutMs ? Math.min(60_000, Math.max(1000, Number(config.timeoutMs))) : undefined,
    },
    intervalSecs,
    graceSecs: Math.min(86_400, Math.max(0, Math.round(Number(body.graceSecs ?? 300)))),
    failureThreshold: Math.min(10, Math.max(1, Math.round(Number(body.failureThreshold ?? 2)))),
    teamId: typeof body.teamId === 'string' && body.teamId ? body.teamId : null,
    severity,
    escalationPolicyId: typeof body.escalationPolicyId === 'string' && body.escalationPolicyId ? body.escalationPolicyId : null,
    enabled: body.enabled !== false,
  };
}

export async function saveMonitor(id: string | null, input: MonitorInput): Promise<Monitor> {
  const now = new Date().toISOString();
  if (id) {
    await db.run(
      `UPDATE monitors SET name = ?, kind = ?, target = ?, config = ?, interval_secs = ?, grace_secs = ?, failure_threshold = ?,
         team_id = ?, severity = ?, escalation_policy_id = ?, enabled = ?, next_check_at = ?, updated_at = ? WHERE id = ?`,
      [
        input.name,
        input.kind,
        input.target,
        JSON.stringify(input.config),
        input.intervalSecs,
        input.graceSecs,
        input.failureThreshold,
        input.teamId,
        input.severity,
        input.escalationPolicyId,
        input.enabled ? 1 : 0,
        now,
        now,
        id,
      ],
    );
    if (input.kind === 'heartbeat') {
      await db.run(`UPDATE monitors SET heartbeat_token = COALESCE(heartbeat_token, ?) WHERE id = ?`, [newToken(), id]);
    }
    return (await getMonitor(id))!;
  }
  const monitorId = randomId();
  await db.run(
    `INSERT INTO monitors (id, name, kind, target, config, interval_secs, grace_secs, failure_threshold, team_id, severity,
       escalation_policy_id, enabled, state, heartbeat_token, last_ping_at, next_check_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [
      monitorId,
      input.name,
      input.kind,
      input.target,
      JSON.stringify(input.config),
      input.intervalSecs,
      input.graceSecs,
      input.failureThreshold,
      input.teamId,
      input.severity,
      input.escalationPolicyId,
      input.enabled ? 1 : 0,
      input.kind === 'heartbeat' ? newToken() : null,
      // A new heartbeat gets one full period before its first ping is due.
      input.kind === 'heartbeat' ? now : null,
      now,
      now,
      now,
    ],
  );
  return (await getMonitor(monitorId))!;
}

function newToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

export async function deleteMonitor(id: string): Promise<void> {
  await db.run(`DELETE FROM monitors WHERE id = ?`, [id]);
}

/* --------------------------------- Running ------------------------------- */

async function runCheck(row: MonitorRow): Promise<ProbeResult> {
  const config = parseJson<MonitorConfig>(row.config, {});
  if (row.kind === 'heartbeat') {
    const last = new Date(row.last_ping_at ?? row.created_at).getTime();
    const deadline = last + (Number(row.interval_secs) + Number(row.grace_secs)) * 1000;
    if (Date.now() <= deadline) return { ok: true, latencyMs: null, message: row.last_ping_at ? `Last ping ${row.last_ping_at}` : 'Waiting for the first ping' };
    return { ok: false, latencyMs: null, message: row.last_ping_at ? `No ping since ${row.last_ping_at}` : 'Never pinged' };
  }
  if (row.kind === 'database') {
    const job = await db.get<{ engine: BackupEngine; connection_encrypted: string }>(`SELECT engine, connection_encrypted FROM backup_jobs WHERE id = ?`, [
      config.databaseId ?? '',
    ]);
    if (!job) return { ok: false, latencyMs: null, message: 'The database connector this monitor checks was deleted' };
    const health = await checkDatabaseHealth(job.engine, decryptSecret(job.connection_encrypted));
    const extras = Object.entries(health.details)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    return { ok: health.ok, latencyMs: health.latencyMs, message: `${health.message}${extras ? ` (${extras})` : ''}`.slice(0, 500) };
  }
  return runProbe(row.kind, row.target, config);
}

async function recordResult(row: MonitorRow, result: ProbeResult): Promise<MonitorState> {
  const now = new Date();
  const nowIso = now.toISOString();
  const day = nowIso.slice(0, 10);
  const failures = result.ok ? 0 : Number(row.consecutive_failures) + 1;
  const previous = row.state;
  let state: MonitorState = previous === 'paused' ? 'pending' : previous;
  if (result.ok) state = 'up';
  else if (failures >= Number(row.failure_threshold)) state = 'down';

  await db.run(`INSERT INTO monitor_checks (id, monitor_id, ok, latency_ms, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
    randomId(),
    row.id,
    result.ok ? 1 : 0,
    result.latencyMs,
    result.message.slice(0, 500),
    nowIso,
  ]);
  await db.run(`INSERT INTO monitor_daily (monitor_id, day, total, failures) VALUES (?, ?, 0, 0) ON CONFLICT (monitor_id, day) DO NOTHING`, [row.id, day]);
  await db.run(`UPDATE monitor_daily SET total = total + 1, failures = failures + ? WHERE monitor_id = ? AND day = ?`, [result.ok ? 0 : 1, row.id, day]);
  await db.run(
    `UPDATE monitors SET state = ?, consecutive_failures = ?, last_checked_at = ?, last_latency_ms = ?, last_message = ?,
       last_change_at = ?, next_check_at = ? WHERE id = ?`,
    [
      state,
      failures,
      nowIso,
      result.latencyMs,
      result.message.slice(0, 500),
      // Computed here, not in SQL: MySQL applies SET clauses left to right, so
      // comparing against `state` there would see the value just written.
      state !== previous ? nowIso : row.last_change_at,
      new Date(now.getTime() + Number(row.interval_secs) * 1000).toISOString(),
      row.id,
    ],
  );

  const signal = {
    sourceType: 'monitor' as const,
    sourceKind: row.kind,
    sourceId: row.id,
    sourceName: row.name,
    dedupKey: `monitor:${row.id}`,
    teamId: row.team_id,
    escalationPolicyId: row.escalation_policy_id,
    severity: row.severity,
    payload: { kind: row.kind, target: row.target, message: result.message, latencyMs: result.latencyMs },
  };
  if (state === 'down' && previous !== 'down') {
    await ingestSignal({ ...signal, status: 'firing', title: `${row.name} is down`, summary: `${row.kind.toUpperCase()} check of ${row.target || row.name} failed ${failures} time(s) in a row: ${result.message}` });
  } else if (state === 'up' && previous === 'down') {
    await ingestSignal({ ...signal, status: 'resolved', title: `${row.name} is back up`, summary: result.message });
  }
  return state;
}

export async function checkMonitorNow(id: string): Promise<Monitor | null> {
  const row = await db.get<MonitorRow>(`SELECT * FROM monitors WHERE id = ?`, [id]);
  if (!row) return null;
  await recordResult(row, await runCheck(row));
  return getMonitor(id);
}

/** Runs every monitor that is due. Checks run concurrently, a handful at a time. */
export async function runDueMonitors(concurrency = 8): Promise<number> {
  const now = new Date().toISOString();
  const due = await db.all<MonitorRow>(
    `SELECT * FROM monitors WHERE enabled = 1 AND (next_check_at IS NULL OR next_check_at <= ?) ORDER BY next_check_at LIMIT 200`,
    [now],
  );
  let index = 0;
  const worker = async () => {
    while (index < due.length) {
      const row = due[index++];
      try {
        // Claim it first so a slow check is not started twice by the next tick.
        await db.run(`UPDATE monitors SET next_check_at = ? WHERE id = ?`, [new Date(Date.now() + Number(row.interval_secs) * 1000).toISOString(), row.id]);
        await recordResult(row, await runCheck(row));
      } catch (error) {
        console.error(`[monitor] ${row.name} failed to run`, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
  return due.length;
}

/** A heartbeat ping. `fail` lets a job report its own failure instead of just going quiet. */
export async function recordHeartbeat(token: string, { fail = false, message }: { fail?: boolean; message?: string } = {}): Promise<boolean> {
  const row = await db.get<MonitorRow>(`SELECT * FROM monitors WHERE heartbeat_token = ? AND kind = 'heartbeat'`, [token]);
  if (!row) return false;
  const now = new Date().toISOString();
  if (!fail) await db.run(`UPDATE monitors SET last_ping_at = ? WHERE id = ?`, [now, row.id]);
  if (!toBool(row.enabled)) return true;
  await recordResult(
    { ...row, last_ping_at: fail ? row.last_ping_at : now, failure_threshold: fail ? 1 : row.failure_threshold },
    fail ? { ok: false, latencyMs: null, message: message?.slice(0, 300) || 'The job reported a failure' } : { ok: true, latencyMs: null, message: 'Ping received' },
  );
  return true;
}

/** Raw checks are kept for a week; the daily roll-up for the status pages, for 90 days. */
export async function pruneMonitorHistory(): Promise<void> {
  await db.run(`DELETE FROM monitor_checks WHERE created_at < ?`, [new Date(Date.now() - 7 * 86_400_000).toISOString()]);
  await db.run(`DELETE FROM monitor_daily WHERE day < ?`, [new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10)]);
}
