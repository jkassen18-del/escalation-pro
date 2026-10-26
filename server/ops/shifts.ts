import { db, parseJson, placeholders } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import { getSettings } from '../repositories/settings.ts';
import { validateTimeZone } from './oncall.ts';
import {
  SHIFT_EXCEPTION_KINDS,
  isTime,
  shiftOccurrences,
  shiftStatus,
  type ShiftException,
  type ShiftExceptionKind,
  type ShiftOccurrence,
  type ShiftPattern,
} from '../../shared/shifts.ts';

/** How a department's shift handover is sent; filled in by the handover feature. */
export interface HandoverSettings {
  enabled?: boolean;
  /** Minutes before the shift change the report goes out. */
  leadMins?: number;
  /** Where: the department's routed Slack/Teams channels. */
  channels?: Array<'slack' | 'msteams' | 'email'>;
}

export interface DepartmentSchedule {
  teamId: string;
  timeZone: string;
  handover: HandoverSettings;
  patterns: ShiftPattern[];
  exceptions: ShiftException[];
}

export interface PersonRef {
  id: string;
  name: string;
  phone: string | null;
  email: string;
  jobTitle: string | null;
}

export interface StaffedShift extends Omit<ShiftOccurrence, 'leaderId' | 'memberIds'> {
  leader: PersonRef | null;
  members: PersonRef[];
}

export interface DepartmentShiftStatus {
  teamId: string;
  teamName: string;
  color: string;
  timeZone: string;
  configured: boolean;
  current: StaffedShift | null;
  next: StaffedShift | null;
}

async function orgTimeZone(): Promise<string> {
  const settings = await getSettings().catch(() => null);
  return settings?.timezone && settings.timezone !== 'UTC' ? settings.timezone : 'Africa/Johannesburg';
}

export async function getDepartmentSchedule(teamId: string): Promise<DepartmentSchedule> {
  const settings = await db.get<{ time_zone: string; handover: string }>(`SELECT time_zone, handover FROM dept_shift_settings WHERE team_id = ?`, [teamId]);
  const patterns = await db.all<Record<string, string | number | null>>(`SELECT * FROM dept_shift_patterns WHERE team_id = ? ORDER BY position, name`, [teamId]);
  const exceptions = await db.all<Record<string, string | null>>(
    `SELECT * FROM dept_shift_exceptions WHERE team_id = ? AND shift_date >= ? ORDER BY shift_date`,
    [teamId, new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)],
  );
  return {
    teamId,
    timeZone: settings?.time_zone ?? (await orgTimeZone()),
    handover: parseJson<HandoverSettings>(settings?.handover, {}),
    patterns: patterns.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      days: parseJson<number[]>(row.days as string, []),
      start: String(row.start_time),
      end: String(row.end_time),
      leaderId: (row.leader_id as string | null) ?? null,
      memberIds: parseJson<string[]>(row.member_ids as string, []),
    })),
    exceptions: exceptions.map((row) => ({
      id: row.id!,
      date: row.shift_date!,
      patternId: row.pattern_id ?? null,
      kind: row.kind as ShiftExceptionKind,
      leaderId: row.leader_id ?? null,
      start: row.start_time ?? null,
      end: row.end_time ?? null,
      note: row.note ?? null,
    })),
  };
}

async function people(ids: string[]): Promise<Map<string, PersonRef>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!unique.length) return new Map();
  const rows = await db.all<{ id: string; name: string; phone: string | null; email: string; job_title: string | null }>(
    `SELECT id, name, phone, email, job_title FROM users WHERE status = 'active' AND id IN (${placeholders(unique.length)})`,
    unique,
  );
  return new Map(rows.map((row) => [row.id, { id: row.id, name: row.name, phone: row.phone, email: row.email, jobTitle: row.job_title }]));
}

async function staff(shifts: ShiftOccurrence[]): Promise<StaffedShift[]> {
  const directory = await people(shifts.flatMap((shift) => [shift.leaderId ?? '', ...shift.memberIds]));
  return shifts.map(({ leaderId, memberIds, ...shift }) => ({
    ...shift,
    leader: leaderId ? (directory.get(leaderId) ?? null) : null,
    members: memberIds.map((id) => directory.get(id)).filter((person): person is PersonRef => Boolean(person)),
  }));
}

/** Who is in right now in each department, and who takes over next. */
export async function shiftBoard(at = Date.now()): Promise<DepartmentShiftStatus[]> {
  const teams = await db.all<{ id: string; name: string; color: string }>(`SELECT id, name, color FROM teams ORDER BY name`);
  return Promise.all(
    teams.map(async (team) => {
      const schedule = await getDepartmentSchedule(team.id);
      const { current, next } = shiftStatus(schedule.patterns, schedule.exceptions, schedule.timeZone, at);
      const [staffedCurrent, staffedNext] = await staff([current, next].filter((shift): shift is ShiftOccurrence => Boolean(shift)));
      return {
        teamId: team.id,
        teamName: team.name,
        color: team.color,
        timeZone: schedule.timeZone,
        configured: schedule.patterns.length > 0,
        current: current ? staffedCurrent : null,
        next: next ? (current ? staffedNext : staffedCurrent) ?? null : null,
      };
    }),
  );
}

/** Every shift in a department between two instants, with names filled in. */
export async function departmentShifts(teamId: string, from: number, to: number): Promise<StaffedShift[]> {
  const schedule = await getDepartmentSchedule(teamId);
  return staff(shiftOccurrences(schedule.patterns, schedule.exceptions, schedule.timeZone, from, to));
}

/* -------------------------------- Editing -------------------------------- */

const ids = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length <= 60).slice(0, 200) : []);

export function validatePatterns(value: unknown): Array<Omit<ShiftPattern, 'id'> & { id?: string }> {
  if (!Array.isArray(value)) throw badRequest('Send the list of shifts.');
  if (value.length > 20) throw badRequest('A department can have up to 20 shifts.');
  return value.map((raw, index) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const name = String(row.name ?? '').trim().slice(0, 60) || `Shift ${index + 1}`;
    if (!isTime(row.start) || !isTime(row.end)) throw badRequest(`${name}: give the start and end as HH:MM.`);
    if (row.start === row.end) throw badRequest(`${name}: the start and end are the same time.`);
    const days = Array.isArray(row.days) ? Array.from(new Set(row.days.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))).sort() : [];
    if (!days.length) throw badRequest(`${name}: pick at least one day.`);
    return {
      id: typeof row.id === 'string' && row.id ? row.id : undefined,
      name,
      days,
      start: row.start,
      end: row.end,
      leaderId: typeof row.leaderId === 'string' && row.leaderId ? row.leaderId : null,
      memberIds: ids(row.memberIds),
    };
  });
}

export async function saveDepartmentSchedule(
  teamId: string,
  input: { timeZone?: string; handover?: HandoverSettings; patterns?: ReturnType<typeof validatePatterns> },
): Promise<DepartmentSchedule> {
  const now = new Date().toISOString();
  const current = await getDepartmentSchedule(teamId);
  const timeZone = input.timeZone ? validateTimeZone(input.timeZone) : current.timeZone;
  const handover = input.handover ?? current.handover;
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO dept_shift_settings (team_id, time_zone, handover, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (team_id) DO UPDATE SET time_zone = excluded.time_zone, handover = excluded.handover, updated_at = excluded.updated_at`,
      [teamId, timeZone, JSON.stringify(handover), now],
    );
    if (input.patterns) {
      const keep = new Set(input.patterns.map((pattern) => pattern.id).filter(Boolean));
      for (const pattern of current.patterns) {
        if (!keep.has(pattern.id)) await db.run(`DELETE FROM dept_shift_patterns WHERE id = ?`, [pattern.id]);
      }
      for (const [position, pattern] of input.patterns.entries()) {
        const existing = pattern.id && current.patterns.some((item) => item.id === pattern.id);
        const values = [pattern.name, JSON.stringify(pattern.days), pattern.start, pattern.end, pattern.leaderId, JSON.stringify(pattern.memberIds), position, now];
        if (existing) {
          await db.run(
            `UPDATE dept_shift_patterns SET name = ?, days = ?, start_time = ?, end_time = ?, leader_id = ?, member_ids = ?, position = ?, updated_at = ? WHERE id = ? AND team_id = ?`,
            [...values, pattern.id!, teamId],
          );
        } else {
          await db.run(
            `INSERT INTO dept_shift_patterns (id, team_id, name, days, start_time, end_time, leader_id, member_ids, position, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [randomId(), teamId, ...values.slice(0, 7), now, now],
          );
        }
      }
    }
  });
  return getDepartmentSchedule(teamId);
}

export async function addShiftException(teamId: string, body: Record<string, unknown>): Promise<DepartmentSchedule> {
  const date = String(body.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Pick the date.');
  const kind = SHIFT_EXCEPTION_KINDS.includes(body.kind as ShiftExceptionKind) ? (body.kind as ShiftExceptionKind) : null;
  if (!kind) throw badRequest('Choose closed, a different leader, or different hours.');
  const patternId = typeof body.patternId === 'string' && body.patternId ? body.patternId : null;
  if (patternId && !(await db.get(`SELECT id FROM dept_shift_patterns WHERE id = ? AND team_id = ?`, [patternId, teamId]))) throw badRequest('That shift does not exist.');
  const leaderId = kind === 'leader' && typeof body.leaderId === 'string' && body.leaderId ? body.leaderId : null;
  if (kind === 'leader' && !leaderId) throw badRequest('Pick who leads instead.');
  if (kind === 'hours' && (!isTime(body.start) || !isTime(body.end))) throw badRequest('Give the hours as HH:MM.');
  await db.run(
    `INSERT INTO dept_shift_exceptions (id, team_id, shift_date, pattern_id, kind, leader_id, start_time, end_time, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomId(),
      teamId,
      date,
      patternId,
      kind,
      leaderId,
      kind === 'hours' ? (body.start as string) : null,
      kind === 'hours' ? (body.end as string) : null,
      typeof body.note === 'string' ? body.note.trim().slice(0, 200) || null : null,
      new Date().toISOString(),
    ],
  );
  return getDepartmentSchedule(teamId);
}

export async function removeShiftException(teamId: string, id: string): Promise<DepartmentSchedule> {
  await db.run(`DELETE FROM dept_shift_exceptions WHERE id = ? AND team_id = ?`, [id, teamId]);
  return getDepartmentSchedule(teamId);
}
