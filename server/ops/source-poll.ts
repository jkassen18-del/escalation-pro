import { db, parseJson } from '../db/index.ts';
import { callThrough, findConnection } from './connections.ts';
import { ingestSignal, type IngestResult } from './alerts.ts';
import { getSource, listSources, normalise, readPath, type Normalised } from './sources.ts';
import type { AlertSource, AlertSourcePoll, ApiTryResult } from '../../shared/ops.ts';

/**
 * Alert sources that fetch instead of waiting: on each source's interval,
 * call its API connection, read the alerts out of the response with the
 * source's own normaliser (Jenkins, Grafana, or the generic field mapping),
 * and send them down the same pipeline a webhook would. What fired last time
 * and is gone now is resolved, so "the job is green again" closes the ticket.
 */

interface PollState {
  firing?: string[];
  error?: string | null;
}

export interface PollOutcome {
  response: Pick<ApiTryResult, 'ok' | 'status' | 'message' | 'latencyMs' | 'url'> & { body?: string };
  signals: Normalised[];
  error: string | null;
}

/** Makes the call and reads the alerts, without sending them anywhere. */
export async function previewPoll(source: Pick<AlertSource, 'kind' | 'mapping' | 'defaultSeverity' | 'name'>, poll: AlertSourcePoll): Promise<PollOutcome> {
  const connection = await findConnection(poll.connectionId);
  if (!connection || !connection.enabled) return { response: { ok: false, status: null, message: 'No connection', latencyMs: null, url: '' }, signals: [], error: 'Its API connection was removed or turned off.' };
  const result = await callThrough(connection, { method: poll.method, path: poll.path, body: poll.body, bodyType: poll.body ? 'json' : undefined });
  const response = { ok: result.ok, status: result.status, message: result.message, latencyMs: result.latencyMs, url: result.url, body: result.body.slice(0, 4000) };
  if (result.status === null) return { response, signals: [], error: result.message };
  if (result.status >= 400) return { response, signals: [], error: `The API answered HTTP ${result.status}.` };
  if (result.json === undefined) return { response, signals: [], error: 'The response was not JSON.' };

  const container = poll.itemsPath ? readPath(result.json, poll.itemsPath) : result.json;
  if (poll.itemsPath && container === undefined) return { response, signals: [], error: `Nothing at "${poll.itemsPath}" in the response.` };
  // Alertmanager's API answers with the bare list its webhook wraps in { alerts }.
  const items = source.kind === 'grafana' && Array.isArray(container) ? [{ alerts: container }] : Array.isArray(container) ? container : [container];
  const asSource = { ...source, id: '', teamId: null, teamName: null, escalationPolicyId: null, enabled: true, webhookUrl: '', poll, lastPolledAt: null, lastPollError: null, lastEventAt: null, eventCount: 0, createdAt: '' } as AlertSource;
  const signals = items
    .slice(0, 500)
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .flatMap((item) => normalise(asSource, item));
  return { response, signals, error: null };
}

export async function pollSource(source: AlertSource, now = Date.now()): Promise<{ results: IngestResult[]; error: string | null }> {
  const poll = source.poll!;
  const row = await db.get<{ poll_state: string | null }>(`SELECT poll_state FROM alert_sources WHERE id = ?`, [source.id]);
  const state = parseJson<PollState>(row?.poll_state, {});
  const outcome = await previewPoll(source, poll);
  const stamp = new Date(now).toISOString();

  if (outcome.error) {
    // A failed poll changes nothing: the alerts stay as they were until the API answers again.
    await db.run(`UPDATE alert_sources SET last_polled_at = ?, poll_state = ? WHERE id = ?`, [stamp, JSON.stringify({ ...state, error: outcome.error }), source.id]);
    return { results: [], error: outcome.error };
  }

  const base = {
    sourceType: 'webhook' as const,
    sourceKind: source.kind,
    sourceId: source.id,
    sourceName: source.name,
    teamId: source.teamId,
    escalationPolicyId: source.escalationPolicyId,
  };
  const results: IngestResult[] = [];
  const firing = new Set<string>();
  const previously = new Set(state.firing ?? []);
  for (const signal of outcome.signals) {
    if (signal.status === 'firing') firing.add(signal.dedupKey);
    // A resolved item is only worth sending if it was firing: polling sees every green job every time.
    if (signal.status === 'resolved' && !previously.has(signal.dedupKey)) continue;
    // Still firing since last time: the alert is open already; a repeat would only count up.
    if (signal.status === 'firing' && previously.has(signal.dedupKey)) continue;
    results.push(await ingestSignal({ ...signal, ...base }));
  }
  if (poll.resolveMissing !== false) {
    const seen = new Set(outcome.signals.map((signal) => signal.dedupKey));
    for (const key of previously) {
      if (seen.has(key) || firing.has(key)) continue;
      results.push(await ingestSignal({ ...base, dedupKey: key, title: `${source.name}: cleared`, severity: source.defaultSeverity, status: 'resolved', summary: 'No longer reported by the API.' }));
    }
  }
  if (results.length) await db.run(`UPDATE alert_sources SET last_event_at = ?, event_count = event_count + ? WHERE id = ?`, [stamp, results.length, source.id]);
  await db.run(`UPDATE alert_sources SET last_polled_at = ?, poll_state = ? WHERE id = ?`, [stamp, JSON.stringify({ firing: [...firing], error: null }), source.id]);
  return { results, error: null };
}

/** Called by the ops runner: every polling source whose interval has passed. */
export async function pollDueSources(now = Date.now()): Promise<number> {
  const due = (await listSources()).filter(
    (source) => source.enabled && source.poll?.enabled && source.poll.connectionId && (!source.lastPolledAt || now - Date.parse(source.lastPolledAt) >= source.poll.intervalSecs * 1000 - 5_000),
  );
  let polled = 0;
  for (const source of due) {
    try {
      await pollSource(source, now);
      polled += 1;
    } catch (error) {
      console.error(`[ops] poll ${source.name}`, error);
    }
  }
  return polled;
}

export async function pollNow(id: string) {
  const source = await getSource(id);
  if (!source?.poll) return null;
  return pollSource(source);
}
