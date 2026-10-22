import { db, parseJson, placeholders } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import {
  ESCALATION_TARGET_TYPES,
  NOTIFY_CHANNELS,
  ROTATION_KINDS,
  type EscalationLevel,
  type EscalationPolicy,
  type EscalationTarget,
  type NotificationRule,
  type NotifyChannel,
  type RotationKind,
  type Schedule,
  type ScheduleLayer,
  type ScheduleOverride,
  type Shift,
  type Urgency,
} from '../../shared/ops.ts';

/* ------------------------------- Schedules ------------------------------- */

const HOUR_MS = 3_600_000;

interface LayerRow {
  id: string;
  schedule_id: string;
  name: string;
  position: number | string;
  rotation: string;
  shift_hours: number | string;
  starts_at: string;
  member_ids: string;
}

function mapLayer(row: LayerRow): ScheduleLayer {
  return {
    id: row.id,
    name: row.name,
    position: Number(row.position),
    rotation: row.rotation as RotationKind,
    shiftHours: Number(row.shift_hours),
    startsAt: row.starts_at,
    memberIds: parseJson<string[]>(row.member_ids, []),
  };
}

async function userNames(ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!unique.length) return new Map();
  const rows = await db.all<{ id: string; name: string }>(
    `SELECT id, name FROM users WHERE id IN (${placeholders(unique.length)})`,
    unique,
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Who a single layer has on call at `t`, and when that shift ends. */
export function layerOnCallAt(layer: ScheduleLayer, t: number): { userId: string; endsAt: number } | null {
  const start = new Date(layer.startsAt).getTime();
  const length = layer.shiftHours * HOUR_MS;
  if (!layer.memberIds.length || !(length > 0) || t < start) return null;
  const index = Math.floor((t - start) / length);
  return { userId: layer.memberIds[index % layer.memberIds.length], endsAt: start + (index + 1) * length };
}

/**
 * The final schedule at `t`: an override beats every layer, and a higher
 * layer beats a lower one whenever it has someone on call.
 */
export function onCallAt(layers: ScheduleLayer[], overrides: ScheduleOverride[], t: number): { userId: string; source: Shift['source']; layerId: string | null } | null {
  const override = overrides
    .filter((o) => new Date(o.startsAt).getTime() <= t && new Date(o.endsAt).getTime() > t)
    .sort((a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime())[0];
  if (override) return { userId: override.userId, source: 'override', layerId: null };
  for (const layer of [...layers].sort((a, b) => b.position - a.position)) {
    const hit = layerOnCallAt(layer, t);
    if (hit) return { userId: hit.userId, source: 'layer', layerId: layer.id };
  }
  return null;
}

/** Every shift in [from, to), merged where the same person carries on. */
export function renderShifts(layers: ScheduleLayer[], overrides: ScheduleOverride[], from: number, to: number): Array<Omit<Shift, 'userName'>> {
  const points = new Set<number>([from]);
  for (const layer of layers) {
    const start = new Date(layer.startsAt).getTime();
    const length = layer.shiftHours * HOUR_MS;
    if (!(length > 0)) continue;
    if (start > from && start < to) points.add(start);
    const first = Math.max(0, Math.ceil((from - start) / length));
    for (let k = first; start + k * length < to && k < first + 2000; k += 1) {
      const boundary = start + k * length;
      if (boundary > from) points.add(boundary);
    }
  }
  for (const override of overrides) {
    for (const edge of [new Date(override.startsAt).getTime(), new Date(override.endsAt).getTime()]) {
      if (edge > from && edge < to) points.add(edge);
    }
  }
  const sorted = [...points].sort((a, b) => a - b);
  const shifts: Array<Omit<Shift, 'userName'>> = [];
  sorted.forEach((point, i) => {
    const end = sorted[i + 1] ?? to;
    const who = onCallAt(layers, overrides, point);
    if (!who) return;
    const last = shifts[shifts.length - 1];
    if (last && last.userId === who.userId && last.source === who.source && new Date(last.endsAt).getTime() === point) {
      last.endsAt = new Date(end).toISOString();
      return;
    }
    shifts.push({ userId: who.userId, startsAt: new Date(point).toISOString(), endsAt: new Date(end).toISOString(), source: who.source, layerId: who.layerId });
  });
  return shifts;
}

async function loadScheduleParts(scheduleId: string): Promise<{ layers: ScheduleLayer[]; overrides: ScheduleOverride[] }> {
  const layers = (await db.all<LayerRow>(`SELECT * FROM oncall_layers WHERE schedule_id = ? ORDER BY position`, [scheduleId])).map(mapLayer);
  const horizon = new Date(Date.now() - 7 * 24 * HOUR_MS).toISOString();
  const overrideRows = await db.all<Record<string, string | null>>(
    `SELECT o.*, u.name AS user_name FROM oncall_overrides o LEFT JOIN users u ON u.id = o.user_id
     WHERE o.schedule_id = ? AND o.ends_at > ? ORDER BY o.starts_at`,
    [scheduleId, horizon],
  );
  const overrides = overrideRows.map((row) => ({
    id: row.id!,
    userId: row.user_id!,
    userName: row.user_name ?? null,
    startsAt: row.starts_at!,
    endsAt: row.ends_at!,
    note: row.note ?? null,
  }));
  return { layers, overrides };
}

export async function whoIsOnCall(scheduleId: string, at = Date.now()): Promise<string | null> {
  const { layers, overrides } = await loadScheduleParts(scheduleId);
  return onCallAt(layers, overrides, at)?.userId ?? null;
}

export async function getSchedule(id: string): Promise<Schedule | null> {
  const row = await db.get<Record<string, string | null>>(
    `SELECT s.*, t.name AS team_name FROM oncall_schedules s LEFT JOIN teams t ON t.id = s.team_id WHERE s.id = ?`,
    [id],
  );
  if (!row) return null;
  const { layers, overrides } = await loadScheduleParts(id);
  const now = Date.now();
  const current = onCallAt(layers, overrides, now);
  let onCallNow: Schedule['onCallNow'] = null;
  if (current) {
    const names = await userNames([current.userId]);
    const upcoming = renderShifts(layers, overrides, now, now + 60 * 24 * HOUR_MS);
    onCallNow = { userId: current.userId, userName: names.get(current.userId) ?? 'Unknown', until: upcoming[0]?.endsAt ?? null };
  }
  return {
    id: row.id!,
    name: row.name!,
    description: row.description ?? null,
    teamId: row.team_id ?? null,
    teamName: row.team_name ?? null,
    timeZone: row.time_zone!,
    layers,
    overrides,
    onCallNow,
    createdAt: row.created_at!,
    updatedAt: row.updated_at!,
  };
}

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await db.all<{ id: string }>(`SELECT id FROM oncall_schedules ORDER BY name`);
  const schedules = await Promise.all(rows.map((row) => getSchedule(row.id)));
  return schedules.filter((s): s is Schedule => Boolean(s));
}

export async function scheduleShifts(id: string, from: number, to: number): Promise<Shift[]> {
  const { layers, overrides } = await loadScheduleParts(id);
  const shifts = renderShifts(layers, overrides, from, to);
  const names = await userNames(shifts.map((s) => s.userId));
  return shifts.map((shift) => ({ ...shift, userName: names.get(shift.userId) ?? 'Unknown' }));
}

export interface ScheduleInput {
  name: string;
  description: string | null;
  teamId: string | null;
  timeZone: string;
  layers: Array<Omit<ScheduleLayer, 'id'>>;
}

async function assertUsersExist(ids: string[]): Promise<void> {
  const known = await userNames(ids);
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) throw badRequest('Some people in this rotation no longer exist.');
}

export function validateTimeZone(zone: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    throw badRequest(`"${zone}" is not a time zone`, { timeZone: 'Unknown time zone' });
  }
}

export function parseLayers(value: unknown): ScheduleInput['layers'] {
  if (!Array.isArray(value)) throw badRequest('A schedule needs at least one layer.');
  return value.slice(0, 10).map((raw, index) => {
    const layer = raw as Record<string, unknown>;
    const rotation = ROTATION_KINDS.includes(layer.rotation as RotationKind) ? (layer.rotation as RotationKind) : 'weekly';
    const shiftHours = rotation === 'daily' ? 24 : rotation === 'weekly' ? 168 : Math.round(Number(layer.shiftHours));
    if (!(shiftHours >= 1 && shiftHours <= 24 * 28)) throw badRequest('Shifts must be between 1 hour and 4 weeks long.');
    const startsAt = new Date(String(layer.startsAt ?? ''));
    if (Number.isNaN(startsAt.getTime())) throw badRequest('Each layer needs a start date and time.');
    const memberIds = Array.isArray(layer.memberIds) ? layer.memberIds.map(String).slice(0, 100) : [];
    return {
      name: String(layer.name || `Layer ${index + 1}`).slice(0, 80),
      position: index,
      rotation,
      shiftHours,
      startsAt: startsAt.toISOString(),
      memberIds,
    };
  });
}

export async function saveSchedule(id: string | null, input: ScheduleInput): Promise<Schedule> {
  await assertUsersExist(input.layers.flatMap((layer) => layer.memberIds));
  const now = new Date().toISOString();
  const scheduleId = id ?? randomId();
  await db.transaction(async () => {
    if (id) {
      await db.run(`UPDATE oncall_schedules SET name = ?, description = ?, team_id = ?, time_zone = ?, updated_at = ? WHERE id = ?`, [
        input.name,
        input.description,
        input.teamId,
        input.timeZone,
        now,
        id,
      ]);
      await db.run(`DELETE FROM oncall_layers WHERE schedule_id = ?`, [id]);
    } else {
      await db.run(
        `INSERT INTO oncall_schedules (id, name, description, team_id, time_zone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [scheduleId, input.name, input.description, input.teamId, input.timeZone, now, now],
      );
    }
    for (const layer of input.layers) {
      await db.run(
        `INSERT INTO oncall_layers (id, schedule_id, name, position, rotation, shift_hours, starts_at, member_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomId(), scheduleId, layer.name, layer.position, layer.rotation, layer.shiftHours, layer.startsAt, JSON.stringify(layer.memberIds)],
      );
    }
  });
  return (await getSchedule(scheduleId))!;
}

export async function addOverride(
  scheduleId: string,
  input: { userId: string; startsAt: string; endsAt: string; note: string | null },
  createdBy: string | null,
): Promise<void> {
  await assertUsersExist([input.userId]);
  if (new Date(input.endsAt).getTime() <= new Date(input.startsAt).getTime()) throw badRequest('An override must end after it starts.');
  await db.run(
    `INSERT INTO oncall_overrides (id, schedule_id, user_id, starts_at, ends_at, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomId(), scheduleId, input.userId, input.startsAt, input.endsAt, input.note, createdBy, new Date().toISOString()],
  );
}

/* -------------------------- Escalation policies -------------------------- */

export async function getPolicy(id: string): Promise<EscalationPolicy | null> {
  const row = await db.get<Record<string, string | number | null>>(
    `SELECT p.*, t.name AS team_name FROM escalation_policies p LEFT JOIN teams t ON t.id = p.team_id WHERE p.id = ?`,
    [id],
  );
  if (!row) return null;
  const levelRows = await db.all<Record<string, string | number>>(`SELECT * FROM escalation_levels WHERE policy_id = ? ORDER BY position`, [id]);
  const levels: EscalationLevel[] = levelRows.map((level) => ({
    id: String(level.id),
    position: Number(level.position),
    delayMins: Number(level.delay_mins),
    targets: parseJson<EscalationTarget[]>(level.targets, []),
  }));
  await nameTargets(levels.flatMap((level) => level.targets));
  return {
    id: String(row.id),
    name: String(row.name),
    description: (row.description as string | null) ?? null,
    teamId: (row.team_id as string | null) ?? null,
    teamName: (row.team_name as string | null) ?? null,
    repeatCount: Number(row.repeat_count),
    levels,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function nameTargets(targets: EscalationTarget[]): Promise<void> {
  const tables: Record<EscalationTarget['type'], string> = { user: 'users', schedule: 'oncall_schedules', team: 'teams' };
  for (const type of ESCALATION_TARGET_TYPES) {
    const ids = targets.filter((t) => t.type === type).map((t) => t.id);
    if (!ids.length) continue;
    const rows = await db.all<{ id: string; name: string }>(`SELECT id, name FROM ${tables[type]} WHERE id IN (${placeholders(ids.length)})`, ids);
    const names = new Map(rows.map((r) => [r.id, r.name]));
    for (const target of targets) if (target.type === type) target.name = names.get(target.id) ?? '(deleted)';
  }
}

export async function listPolicies(): Promise<EscalationPolicy[]> {
  const rows = await db.all<{ id: string }>(`SELECT id FROM escalation_policies ORDER BY name`);
  const policies = await Promise.all(rows.map((row) => getPolicy(row.id)));
  return policies.filter((p): p is EscalationPolicy => Boolean(p));
}

export function parseLevels(value: unknown): Array<Omit<EscalationLevel, 'id'>> {
  if (!Array.isArray(value) || !value.length) throw badRequest('A policy needs at least one level.');
  return value.slice(0, 10).map((raw, index) => {
    const level = raw as Record<string, unknown>;
    const delayMins = Math.round(Number(level.delayMins ?? 10));
    if (!(delayMins >= 1 && delayMins <= 24 * 60)) throw badRequest('Each level waits between 1 minute and 24 hours.');
    const targets = (Array.isArray(level.targets) ? level.targets : [])
      .map((t) => t as Record<string, unknown>)
      .filter((t) => ESCALATION_TARGET_TYPES.includes(t.type as EscalationTarget['type']) && typeof t.id === 'string')
      .map((t) => ({ type: t.type as EscalationTarget['type'], id: String(t.id) }))
      .slice(0, 20);
    if (!targets.length) throw badRequest(`Level ${index + 1} has nobody to notify.`);
    return { position: index, delayMins, targets };
  });
}

export async function savePolicy(
  id: string | null,
  input: { name: string; description: string | null; teamId: string | null; repeatCount: number; levels: Array<Omit<EscalationLevel, 'id'>> },
): Promise<EscalationPolicy> {
  const now = new Date().toISOString();
  const policyId = id ?? randomId();
  await db.transaction(async () => {
    if (id) {
      await db.run(`UPDATE escalation_policies SET name = ?, description = ?, team_id = ?, repeat_count = ?, updated_at = ? WHERE id = ?`, [
        input.name,
        input.description,
        input.teamId,
        input.repeatCount,
        now,
        id,
      ]);
      await db.run(`DELETE FROM escalation_levels WHERE policy_id = ?`, [id]);
    } else {
      await db.run(
        `INSERT INTO escalation_policies (id, name, description, team_id, repeat_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [policyId, input.name, input.description, input.teamId, input.repeatCount, now, now],
      );
    }
    for (const level of input.levels) {
      await db.run(`INSERT INTO escalation_levels (id, policy_id, position, delay_mins, targets) VALUES (?, ?, ?, ?, ?)`, [
        randomId(),
        policyId,
        level.position,
        level.delayMins,
        JSON.stringify(level.targets),
      ]);
    }
  });
  return (await getPolicy(policyId))!;
}

/** The people a level reaches right now. A team means its leads, or everyone when it has none. */
export async function resolveTargets(targets: EscalationTarget[]): Promise<string[]> {
  const users: string[] = [];
  for (const target of targets) {
    if (target.type === 'user') users.push(target.id);
    if (target.type === 'schedule') {
      const who = await whoIsOnCall(target.id);
      if (who) users.push(who);
    }
    if (target.type === 'team') {
      const members = await db.all<{ user_id: string; is_lead: number | string }>(
        `SELECT tm.user_id, tm.is_lead FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? AND u.status = 'active'`,
        [target.id],
      );
      const leads = members.filter((m) => Number(m.is_lead) === 1);
      users.push(...(leads.length ? leads : members).map((m) => m.user_id));
    }
  }
  const unique = Array.from(new Set(users));
  if (!unique.length) return [];
  const active = await db.all<{ id: string }>(`SELECT id FROM users WHERE status = 'active' AND id IN (${placeholders(unique.length)})`, unique);
  const activeIds = new Set(active.map((row) => row.id));
  return unique.filter((id) => activeIds.has(id));
}

/* ---------------------- Personal notification rules ---------------------- */

/** What applies to anyone who has not written their own. */
export const DEFAULT_RULES: Array<Omit<NotificationRule, 'id'>> = [
  { urgency: 'high', channel: 'in_app', delayMins: 0 },
  { urgency: 'high', channel: 'email', delayMins: 0 },
  { urgency: 'high', channel: 'chat', delayMins: 0 },
  { urgency: 'high', channel: 'sms', delayMins: 1 },
  { urgency: 'high', channel: 'voice', delayMins: 3 },
  { urgency: 'low', channel: 'in_app', delayMins: 0 },
  { urgency: 'low', channel: 'email', delayMins: 0 },
];

export async function rulesFor(userId: string): Promise<{ rules: NotificationRule[]; isDefault: boolean }> {
  const rows = await db.all<Record<string, string | number>>(
    `SELECT * FROM notification_rules WHERE user_id = ? ORDER BY urgency, delay_mins`,
    [userId],
  );
  if (!rows.length) return { rules: DEFAULT_RULES.map((rule, i) => ({ id: `default-${i}`, ...rule })), isDefault: true };
  return {
    rules: rows.map((row) => ({
      id: String(row.id),
      urgency: row.urgency as Urgency,
      channel: row.channel as NotifyChannel,
      delayMins: Number(row.delay_mins),
    })),
    isDefault: false,
  };
}

/**
 * A person cannot leave high urgency with no way to wake them: push and email
 * are easy to sleep through, so SMS or a call has to be in there somewhere.
 */
export function validateRules(value: unknown, allowQuietHighUrgency = false): Array<Omit<NotificationRule, 'id'>> {
  if (!Array.isArray(value)) throw badRequest('Send a list of rules.');
  const rules = value.slice(0, 30).map((raw) => {
    const rule = raw as Record<string, unknown>;
    if (rule.urgency !== 'high' && rule.urgency !== 'low') throw badRequest('Each rule is high or low urgency.');
    if (!NOTIFY_CHANNELS.includes(rule.channel as NotifyChannel)) throw badRequest('Unknown channel in a rule.');
    const delayMins = Math.round(Number(rule.delayMins ?? 0));
    if (!(delayMins >= 0 && delayMins <= 120)) throw badRequest('A rule fires between 0 and 120 minutes into a page.');
    return { urgency: rule.urgency as Urgency, channel: rule.channel as NotifyChannel, delayMins };
  });
  const high = rules.filter((rule) => rule.urgency === 'high');
  if (!allowQuietHighUrgency && !high.some((rule) => rule.channel === 'sms' || rule.channel === 'voice')) {
    throw badRequest('High-urgency pages need an SMS or phone-call rule, so a critical alert can wake you.');
  }
  return rules;
}

export async function saveRules(userId: string, rules: Array<Omit<NotificationRule, 'id'>>): Promise<void> {
  await db.transaction(async () => {
    await db.run(`DELETE FROM notification_rules WHERE user_id = ?`, [userId]);
    for (const rule of rules) {
      await db.run(`INSERT INTO notification_rules (id, user_id, urgency, channel, delay_mins) VALUES (?, ?, ?, ?, ?)`, [
        randomId(),
        userId,
        rule.urgency,
        rule.channel,
        rule.delayMins,
      ]);
    }
  });
}
