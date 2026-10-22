import { db, parseJson, placeholders } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import {
  MAINTENANCE_EFFECTS,
  MAINTENANCE_RECURRENCE_KINDS,
  type MaintenanceEffect,
  type MaintenanceInput,
  type MaintenanceOccurrence,
  type MaintenanceRecurrence,
  type MaintenanceScope,
  type MaintenanceState,
  type MaintenanceWindow,
} from '../../shared/ops.ts';
import { zoneOffsetMs, zonedTimeToUtc } from '../../shared/roster.ts';

/**
 * Maintenance windows: planned work during which alerts should not wake
 * anyone.
 *
 * A window is one-off (a start and an end) or recurring (daily, weekly or
 * monthly at a wall-clock time in its own time zone). Recurring windows are
 * never written out as rows: occurrences are worked out on the fly, so
 * editing the series edits every future occurrence. Per-occurrence changes -
 * ending early, extending, skipping one - live in `overrides`, keyed by the
 * occurrence's originally scheduled start.
 */

const DAY_MS = 86_400_000;
/** Recurring series without an end are stored with this as `ends_at`. */
const OPEN_ENDED = '9999-12-31T00:00:00.000Z';

export interface WindowRow {
  id: string;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  monitor_ids: string;
  scope: string | null;
  effect: string | null;
  recurrence: string | null;
  time_zone: string | null;
  notify_before_mins: number | string | null;
  publish: number | string | null;
  overrides: string | null;
  announced: string | null;
  cancelled_at: string | null;
  created_by: string | null;
  created_by_name?: string | null;
  created_at: string;
  updated_at: string | null;
}

type Overrides = Record<string, { endsAt?: string; skipped?: boolean }>;

/* --------------------------------- Shape --------------------------------- */

/**
 * The scope, with rows from before scopes existed read the old way: a list of
 * ids matched against any monitor or alert source, and no list meaning
 * everything.
 */
export function scopeOf(row: Pick<WindowRow, 'scope' | 'monitor_ids'>): MaintenanceScope {
  const scope = parseJson<MaintenanceScope>(row.scope, {});
  if (Object.keys(scope).length) return scope;
  const legacy = parseJson<string[]>(row.monitor_ids, []);
  return legacy.length ? { monitorIds: legacy, sourceIds: legacy } : { everything: true };
}

export function recurrenceOf(row: Pick<WindowRow, 'recurrence'>): MaintenanceRecurrence {
  const recurrence = parseJson<Partial<MaintenanceRecurrence>>(row.recurrence, {});
  return { ...recurrence, kind: recurrence.kind && MAINTENANCE_RECURRENCE_KINDS.includes(recurrence.kind) ? recurrence.kind : 'none' };
}

function effectOf(row: Pick<WindowRow, 'effect'>): MaintenanceEffect {
  return row.effect === 'pause_alerting' ? 'pause_alerting' : 'pause_paging';
}

/* ------------------------------ Occurrences ------------------------------ */

function parseDay(day: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw badRequest(`"${day}" is not a date (YYYY-MM-DD).`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** The calendar date a wall clock in `timeZone` shows at `at`. */
function localDay(at: number, timeZone: string): string {
  return new Date(at + zoneOffsetMs(new Date(at), timeZone)).toISOString().slice(0, 10);
}

/**
 * Every occurrence of a window overlapping [from, to). Overrides are applied:
 * a skipped occurrence is left out, and an early end or extension moves its end.
 */
export function expandOccurrences(row: WindowRow, from: number, to: number): MaintenanceOccurrence[] {
  if (row.cancelled_at) return [];
  const overrides = parseJson<Overrides>(row.overrides, {});
  const recurrence = recurrenceOf(row);
  const make = (key: string, start: number, naturalEnd: number): MaintenanceOccurrence | null => {
    const override = overrides[key];
    if (override?.skipped) return null;
    const end = override?.endsAt ? new Date(override.endsAt).getTime() : naturalEnd;
    if (!(end > start) || end <= from || start >= to) return null;
    return { windowId: row.id, key, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), title: row.title, effect: effectOf(row) };
  };

  if (recurrence.kind === 'none') {
    const occurrence = make(row.starts_at, new Date(row.starts_at).getTime(), new Date(row.ends_at).getTime());
    return occurrence ? [occurrence] : [];
  }

  const timeZone = row.time_zone || 'Africa/Johannesburg';
  const [hour, minute] = (recurrence.startTime ?? '00:00').split(':').map(Number);
  const duration = Math.max(1, recurrence.durationMins ?? 60) * 60_000;
  // Start far enough back that an occurrence begun yesterday and still running is found.
  const firstDay = Math.max(
    Date.parse(`${recurrence.startDate ?? row.starts_at.slice(0, 10)}T00:00:00Z`),
    Date.parse(`${localDay(from, timeZone)}T00:00:00Z`) - Math.ceil(duration / DAY_MS + 1) * DAY_MS,
  );
  const lastDay = Math.min(
    recurrence.until ? Date.parse(`${recurrence.until}T00:00:00Z`) : Infinity,
    Date.parse(`${localDay(to, timeZone)}T00:00:00Z`) + DAY_MS,
  );

  const occurrences: MaintenanceOccurrence[] = [];
  for (let day = firstDay, guard = 0; day <= lastDay && guard < 800; day += DAY_MS, guard += 1) {
    const date = new Date(day);
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (recurrence.kind === 'weekly' && !(recurrence.daysOfWeek ?? []).includes(date.getUTCDay())) continue;
    if (recurrence.kind === 'monthly') {
      const lastOfMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      if (d !== Math.min(recurrence.dayOfMonth ?? 1, lastOfMonth)) continue;
    }
    const start = zonedTimeToUtc(y, m, d, hour || 0, minute || 0, timeZone).getTime();
    const occurrence = make(new Date(start).toISOString(), start, start + duration);
    if (occurrence) occurrences.push(occurrence);
  }
  return occurrences;
}

/* ---------------------------------- Reads -------------------------------- */

async function loadRows(where = '', params: string[] = []): Promise<WindowRow[]> {
  return db.all<WindowRow>(
    `SELECT m.*, u.name AS created_by_name FROM maintenance_windows m LEFT JOIN users u ON u.id = m.created_by ${where}`,
    params,
  );
}

/** Rows that can have an occurrence overlapping [from, to). */
async function candidateRows(from: number, to: number): Promise<WindowRow[]> {
  const rows = await loadRows(`WHERE m.cancelled_at IS NULL AND m.starts_at < ? AND m.ends_at > ?`, [
    new Date(to).toISOString(),
    // An extension can push an occurrence past the stored end, so look back a little.
    new Date(from - 7 * DAY_MS).toISOString(),
  ]);
  return rows;
}

export async function occurrencesBetween(from: number, to: number): Promise<Array<{ row: WindowRow; occurrence: MaintenanceOccurrence }>> {
  const rows = await candidateRows(from, to);
  return rows
    .flatMap((row) => expandOccurrences(row, from, to).map((occurrence) => ({ row, occurrence })))
    .sort((a, b) => a.occurrence.startsAt.localeCompare(b.occurrence.startsAt));
}

export async function activeOccurrences(at = Date.now()) {
  return occurrencesBetween(at, at + 1);
}

/** What a monitor or alert source is, for matching against a scope. */
export interface MaintenanceTarget {
  sourceId: string;
  /** The source's own team. */
  teamId?: string | null;
}

export function scopeCovers(scope: MaintenanceScope, target: MaintenanceTarget): boolean {
  if (scope.everything) return true;
  if (scope.monitorIds?.includes(target.sourceId)) return true;
  if (scope.sourceIds?.includes(target.sourceId)) return true;
  if (scope.components?.some((c) => c.monitorId === target.sourceId)) return true;
  return Boolean(target.teamId && scope.teamIds?.includes(target.teamId));
}

export interface Coverage {
  windowId: string;
  title: string;
  effect: MaintenanceEffect;
  startsAt: string;
  endsAt: string;
}

/** The maintenance covering this monitor or source at `at`; pause_alerting wins over pause_paging. */
export async function maintenanceFor(target: MaintenanceTarget, at = Date.now()): Promise<Coverage | null> {
  const matches = (await activeOccurrences(at)).filter(({ row }) => scopeCovers(scopeOf(row), target));
  if (!matches.length) return null;
  const pick = matches.find(({ occurrence }) => occurrence.effect === 'pause_alerting') ?? matches[0];
  return {
    windowId: pick.row.id,
    title: pick.row.title,
    effect: pick.occurrence.effect,
    startsAt: pick.occurrence.startsAt,
    endsAt: pick.occurrence.endsAt,
  };
}

/** Looks a source's team up when the caller only has its id. */
export async function teamOfSource(sourceId: string): Promise<string | null> {
  const row =
    (await db.get<{ team_id: string | null }>(`SELECT team_id FROM monitors WHERE id = ?`, [sourceId])) ??
    (await db.get<{ team_id: string | null }>(`SELECT team_id FROM alert_sources WHERE id = ?`, [sourceId]));
  return row?.team_id ?? null;
}

async function summariseScope(scope: MaintenanceScope): Promise<string> {
  if (scope.everything) return 'Everything';
  const parts: string[] = [];
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (scope.teamIds?.length) {
    const teams = await db.all<{ name: string }>(`SELECT name FROM teams WHERE id IN (${placeholders(scope.teamIds.length)})`, scope.teamIds);
    parts.push(teams.length <= 2 ? `team ${teams.map((t) => t.name).join(', ')}` : count(teams.length, 'team', 'teams'));
  }
  // Legacy rows put the same ids in both lists; count each id once.
  const monitorIds = new Set([...(scope.monitorIds ?? []), ...(scope.components ?? []).map((c) => c.monitorId)]);
  const sourceIds = (scope.sourceIds ?? []).filter((id) => !monitorIds.has(id));
  if (monitorIds.size) parts.push(count(monitorIds.size, 'monitor', 'monitors'));
  if (sourceIds.length) parts.push(count(sourceIds.length, 'alert source', 'alert sources'));
  return parts.join(', ') || 'Nothing selected';
}

function stateOf(row: WindowRow, now: number): { state: MaintenanceState; current: MaintenanceOccurrence | null; next: MaintenanceOccurrence | null } {
  if (row.cancelled_at) return { state: 'cancelled', current: null, next: null };
  const current = expandOccurrences(row, now, now + 1)[0] ?? null;
  const next = expandOccurrences(row, now + 1, now + 400 * DAY_MS).find((o) => new Date(o.startsAt).getTime() > now) ?? null;
  return { state: current ? 'in_progress' : next ? 'scheduled' : 'completed', current, next };
}

export async function mapWindow(row: WindowRow, now = Date.now()): Promise<MaintenanceWindow> {
  const scope = scopeOf(row);
  const { state, current, next } = stateOf(row, now);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    scope,
    scopeSummary: await summariseScope(scope),
    effect: effectOf(row),
    recurrence: recurrenceOf(row),
    timeZone: row.time_zone || 'Africa/Johannesburg',
    startsAt: row.starts_at,
    endsAt: row.ends_at === OPEN_ENDED ? '' : row.ends_at,
    notifyBeforeMins: Number(row.notify_before_mins ?? 0),
    publishToStatusPages: Number(row.publish ?? 0) === 1,
    state,
    currentOccurrence: current,
    nextOccurrence: next,
    cancelledAt: row.cancelled_at,
    monitorIds: scope.monitorIds ?? [],
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listMaintenanceWindows(): Promise<MaintenanceWindow[]> {
  const rows = await loadRows('ORDER BY m.starts_at DESC LIMIT 300');
  const now = Date.now();
  const windows = await Promise.all(rows.map((row) => mapWindow(row, now)));
  const order: Record<MaintenanceState, number> = { in_progress: 0, scheduled: 1, completed: 2, cancelled: 3 };
  return windows.sort((a, b) => order[a.state] - order[b.state]);
}

export async function getMaintenanceRow(id: string): Promise<WindowRow | undefined> {
  return (await loadRows('WHERE m.id = ?', [id]))[0];
}

/* --------------------------------- Writes -------------------------------- */

const ids = (value: unknown, max = 500) => (Array.isArray(value) ? Array.from(new Set(value.map(String))).slice(0, max) : undefined);

export function validateMaintenance(body: Record<string, unknown>): Required<Omit<MaintenanceInput, 'startsAt' | 'endsAt'>> & { startsAt: string; endsAt: string } {
  const title = String(body.title ?? '').trim().slice(0, 200);
  if (!title) throw badRequest('Give the maintenance a title.', { title: 'Required' });

  // Older clients send a bare list of monitor ids; an empty list meant everything.
  let rawScope = (body.scope && typeof body.scope === 'object' ? body.scope : null) as Record<string, unknown> | null;
  if (!rawScope && Array.isArray(body.monitorIds)) {
    const legacy = ids(body.monitorIds) ?? [];
    rawScope = legacy.length ? { monitorIds: legacy, sourceIds: legacy } : { everything: true };
  }
  rawScope ??= {};
  const components = Array.isArray(rawScope.components)
    ? rawScope.components
        .map((c) => c as Record<string, unknown>)
        .filter((c) => typeof c.statusPageId === 'string' && typeof c.monitorId === 'string')
        .map((c) => ({ statusPageId: String(c.statusPageId), monitorId: String(c.monitorId) }))
        .slice(0, 200)
    : undefined;
  const scope: MaintenanceScope = rawScope.everything
    ? { everything: true }
    : { monitorIds: ids(rawScope.monitorIds), sourceIds: ids(rawScope.sourceIds), teamIds: ids(rawScope.teamIds, 50), components };
  if (!scope.everything && !scope.monitorIds?.length && !scope.sourceIds?.length && !scope.teamIds?.length && !scope.components?.length) {
    throw badRequest('Choose what the maintenance covers, or "Everything".', { scope: 'Required' });
  }

  const effect = MAINTENANCE_EFFECTS.includes(body.effect as MaintenanceEffect) ? (body.effect as MaintenanceEffect) : 'pause_paging';
  const timeZone = String(body.timeZone || 'Africa/Johannesburg');
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    throw badRequest(`"${timeZone}" is not a time zone.`, { timeZone: 'Unknown time zone' });
  }

  const raw = (body.recurrence && typeof body.recurrence === 'object' ? body.recurrence : {}) as Record<string, unknown>;
  const kind = MAINTENANCE_RECURRENCE_KINDS.includes(raw.kind as MaintenanceRecurrence['kind']) ? (raw.kind as MaintenanceRecurrence['kind']) : 'none';
  let startsAt: string;
  let endsAt: string;
  let recurrence: MaintenanceRecurrence = { kind: 'none' };

  if (kind === 'none') {
    const start = new Date(String(body.startsAt ?? ''));
    const end = new Date(String(body.endsAt ?? ''));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw badRequest('Give a start and an end after it.', { startsAt: 'Required' });
    }
    if (end.getTime() - start.getTime() > 31 * DAY_MS) throw badRequest('A single window can last at most 31 days.');
    startsAt = start.toISOString();
    endsAt = end.toISOString();
  } else {
    const startTime = String(raw.startTime ?? '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) throw badRequest('Give the start time as HH:MM.', { startTime: 'Invalid' });
    const durationMins = Math.round(Number(raw.durationMins));
    if (!(durationMins >= 5 && durationMins <= 24 * 60)) throw badRequest('A recurring window lasts between 5 minutes and 24 hours.', { durationMins: 'Invalid' });
    const startDate = String(raw.startDate ?? new Date().toISOString().slice(0, 10));
    parseDay(startDate);
    const until = raw.until ? String(raw.until) : null;
    if (until) {
      parseDay(until);
      if (until < startDate) throw badRequest('The series must end after it starts.', { until: 'Invalid' });
    }
    recurrence = { kind, startTime, durationMins, startDate, until };
    if (kind === 'weekly') {
      const days = Array.from(new Set((Array.isArray(raw.daysOfWeek) ? raw.daysOfWeek : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))).sort();
      if (!days.length) throw badRequest('Pick at least one day of the week.', { daysOfWeek: 'Required' });
      recurrence.daysOfWeek = days;
    }
    if (kind === 'monthly') {
      const dayOfMonth = Math.round(Number(raw.dayOfMonth));
      if (!(dayOfMonth >= 1 && dayOfMonth <= 31)) throw badRequest('Pick a day of the month from 1 to 31.', { dayOfMonth: 'Invalid' });
      recurrence.dayOfMonth = dayOfMonth;
    }
    const [hh, mm] = startTime.split(':').map(Number);
    // starts_at and ends_at bound the search for occurrences: from the day
    // before the first possible date (a zone ahead of UTC starts "earlier")
    // to the last possible start plus its length.
    startsAt = new Date(Date.parse(`${startDate}T00:00:00Z`) - DAY_MS).toISOString();
    endsAt = until ? new Date(zonedTimeToUtc(...parseDay(until), hh, mm, timeZone).getTime() + durationMins * 60_000 + DAY_MS).toISOString() : OPEN_ENDED;
  }

  const notifyBeforeMins = Math.min(7 * 24 * 60, Math.max(0, Math.round(Number(body.notifyBeforeMins ?? 0)) || 0));
  return {
    title,
    description: body.description ? String(body.description).trim().slice(0, 2000) || null : null,
    scope,
    effect,
    recurrence,
    timeZone,
    startsAt,
    endsAt,
    notifyBeforeMins,
    publishToStatusPages: Boolean(body.publishToStatusPages),
  };
}

export async function saveMaintenance(id: string | null, input: ReturnType<typeof validateMaintenance>, userId: string | null): Promise<MaintenanceWindow> {
  const now = new Date().toISOString();
  const windowId = id ?? randomId();
  const legacyIds = JSON.stringify(input.scope.monitorIds ?? []);
  if (id) {
    await db.run(
      `UPDATE maintenance_windows SET title = ?, description = ?, starts_at = ?, ends_at = ?, monitor_ids = ?, scope = ?, effect = ?,
         recurrence = ?, time_zone = ?, notify_before_mins = ?, publish = ?, updated_at = ? WHERE id = ?`,
      [
        input.title,
        input.description,
        input.startsAt,
        input.endsAt,
        legacyIds,
        JSON.stringify(input.scope),
        input.effect,
        JSON.stringify(input.recurrence),
        input.timeZone,
        input.notifyBeforeMins,
        input.publishToStatusPages ? 1 : 0,
        now,
        id,
      ],
    );
  } else {
    await db.run(
      `INSERT INTO maintenance_windows (id, title, description, starts_at, ends_at, monitor_ids, scope, effect, recurrence, time_zone,
         notify_before_mins, publish, overrides, announced, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}', ?, ?, ?)`,
      [
        windowId,
        input.title,
        input.description,
        input.startsAt,
        input.endsAt,
        legacyIds,
        JSON.stringify(input.scope),
        input.effect,
        JSON.stringify(input.recurrence),
        input.timeZone,
        input.notifyBeforeMins,
        input.publishToStatusPages ? 1 : 0,
        userId,
        now,
        now,
      ],
    );
  }
  return mapWindow((await getMaintenanceRow(windowId))!);
}

async function setOverride(row: WindowRow, key: string, patch: { endsAt?: string; skipped?: boolean }): Promise<void> {
  const overrides = parseJson<Overrides>(row.overrides, {});
  overrides[key] = { ...overrides[key], ...patch };
  await db.run(`UPDATE maintenance_windows SET overrides = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(overrides), new Date().toISOString(), row.id]);
}

/** Cancels the whole window, or with `occurrenceKey` skips just that occurrence of a series. */
export async function cancelMaintenance(row: WindowRow, occurrenceKey?: string): Promise<void> {
  if (occurrenceKey && recurrenceOf(row).kind !== 'none') {
    await setOverride(row, occurrenceKey, { skipped: true });
    return;
  }
  const now = new Date().toISOString();
  await db.run(`UPDATE maintenance_windows SET cancelled_at = ?, updated_at = ? WHERE id = ?`, [now, now, row.id]);
}

/** Ends the occurrence in progress now. Returns false when nothing is running. */
export async function endMaintenanceNow(row: WindowRow, at = Date.now()): Promise<boolean> {
  const current = expandOccurrences(row, at, at + 1)[0];
  if (!current) return false;
  const now = new Date(at).toISOString();
  if (recurrenceOf(row).kind === 'none') {
    await db.run(`UPDATE maintenance_windows SET ends_at = ?, updated_at = ? WHERE id = ?`, [now, now, row.id]);
  } else {
    await setOverride(row, current.key, { endsAt: now });
  }
  return true;
}

/** Extends the running (or else the next) occurrence by minutes, or to a given time. */
export async function extendMaintenance(row: WindowRow, by: { minutes?: number; until?: string }, at = Date.now()): Promise<MaintenanceOccurrence> {
  const target =
    expandOccurrences(row, at, at + 1)[0] ?? expandOccurrences(row, at, at + 400 * DAY_MS).find((o) => new Date(o.startsAt).getTime() > at);
  if (!target) throw badRequest('This maintenance has no current or upcoming occurrence to extend.');
  const currentEnd = new Date(target.endsAt).getTime();
  const end = by.until ? new Date(by.until).getTime() : currentEnd + Math.round(Number(by.minutes ?? 30)) * 60_000;
  if (!Number.isFinite(end) || end <= at || end <= new Date(target.startsAt).getTime()) throw badRequest('The new end must be in the future.');
  if (end - new Date(target.startsAt).getTime() > 31 * DAY_MS) throw badRequest('A window can last at most 31 days.');
  const iso = new Date(end).toISOString();
  if (recurrenceOf(row).kind === 'none') {
    await db.run(`UPDATE maintenance_windows SET ends_at = ?, updated_at = ? WHERE id = ?`, [iso, new Date(at).toISOString(), row.id]);
  } else {
    await setOverride(row, target.key, { endsAt: iso });
  }
  return { ...target, endsAt: iso };
}

/* ------------------------------ Announcements ---------------------------- */

export type Announcement = 'notified' | 'started' | 'ended';

export function announcedOf(row: Pick<WindowRow, 'announced'>): Record<string, Announcement[]> {
  return parseJson<Record<string, Announcement[]>>(row.announced, {});
}

/** Records that a notice went out; false if it already had (so it is sent once). */
export async function markAnnounced(windowId: string, key: string, what: Announcement): Promise<boolean> {
  const row = await db.get<{ announced: string | null }>(`SELECT announced FROM maintenance_windows WHERE id = ?`, [windowId]);
  if (!row) return false;
  const announced = announcedOf(row);
  if (announced[key]?.includes(what)) return false;
  announced[key] = [...(announced[key] ?? []), what];
  // Old occurrences are forgotten after a few weeks so the column cannot grow without bound.
  const horizon = Date.now() - 30 * DAY_MS;
  for (const k of Object.keys(announced)) if (Date.parse(k) < horizon) delete announced[k];
  await db.run(`UPDATE maintenance_windows SET announced = ? WHERE id = ?`, [JSON.stringify(announced), windowId]);
  return true;
}

/** Everyone in the teams a window touches: its teams, and the teams owning its monitors and sources. */
export async function affectedTeamIds(scope: MaintenanceScope): Promise<string[]> {
  if (scope.everything) return (await db.all<{ id: string }>(`SELECT id FROM teams`)).map((t) => t.id);
  const teams = new Set(scope.teamIds ?? []);
  const sourceIds = Array.from(new Set([...(scope.monitorIds ?? []), ...(scope.sourceIds ?? []), ...(scope.components ?? []).map((c) => c.monitorId)]));
  if (sourceIds.length) {
    const rows = await db.all<{ team_id: string | null }>(
      `SELECT team_id FROM monitors WHERE id IN (${placeholders(sourceIds.length)})
       UNION ALL SELECT team_id FROM alert_sources WHERE id IN (${placeholders(sourceIds.length)})`,
      [...sourceIds, ...sourceIds],
    );
    for (const row of rows) if (row.team_id) teams.add(row.team_id);
  }
  return Array.from(teams);
}

/** Monitor ids a window touches on a status page, for its components. */
export async function monitorsInScope(scope: MaintenanceScope): Promise<Set<string> | 'all'> {
  if (scope.everything) return 'all';
  const ids = new Set([...(scope.monitorIds ?? []), ...(scope.components ?? []).map((c) => c.monitorId)]);
  if (scope.teamIds?.length) {
    const rows = await db.all<{ id: string }>(`SELECT id FROM monitors WHERE team_id IN (${placeholders(scope.teamIds.length)})`, scope.teamIds);
    for (const row of rows) ids.add(row.id);
  }
  return ids;
}
