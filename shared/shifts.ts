import { zonedTimeToUtc } from './roster.ts';

/**
 * Department working schedules: when a department is in, who leads each
 * shift, and who works it. Not on-call standby - a department that only works
 * office hours has shifts and no standby at all.
 */

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export interface ShiftPattern {
  id: string;
  name: string;
  /** 0 = Sunday ... 6 = Saturday, in the department's time zone. */
  days: number[];
  /** "HH:MM" local. An end at or before the start runs past midnight. */
  start: string;
  end: string;
  leaderId: string | null;
  memberIds: string[];
}

export const SHIFT_EXCEPTION_KINDS = ['closed', 'leader', 'hours'] as const;
export type ShiftExceptionKind = (typeof SHIFT_EXCEPTION_KINDS)[number];

/** A change for one date: closed (a public holiday), a different leader, or other hours. */
export interface ShiftException {
  id: string;
  /** "YYYY-MM-DD" in the department's time zone. */
  date: string;
  /** One shift, or null for every shift that day. */
  patternId: string | null;
  kind: ShiftExceptionKind;
  leaderId: string | null;
  start: string | null;
  end: string | null;
  note: string | null;
}

export interface ShiftOccurrence {
  patternId: string;
  name: string;
  /** The local date the shift starts on. */
  date: string;
  startsAt: string;
  endsAt: string;
  leaderId: string | null;
  memberIds: string[];
  note: string | null;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isTime = (value: unknown): value is string => typeof value === 'string' && TIME.test(value);

function parseTime(value: string): [number, number] {
  const [h, m] = value.split(':').map(Number);
  return [h, m];
}

/** The calendar date at `at` in `timeZone`, as [year, month, day]. */
export function localDate(at: Date, timeZone: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return [get('year'), get('month'), get('day')];
}

const dayKey = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Every shift that overlaps [from, to), with that day's exceptions applied. */
export function shiftOccurrences(patterns: ShiftPattern[], exceptions: ShiftException[], timeZone: string, from: number, to: number): ShiftOccurrence[] {
  const out: ShiftOccurrence[] = [];
  // Start a day early: last night's overnight shift may still be running.
  const [fy, fm, fd] = localDate(new Date(from), timeZone);
  const first = Date.UTC(fy, fm - 1, fd) - 86_400_000;
  const days = Math.ceil((to - from) / 86_400_000) + 2;
  for (let i = 0; i < days && i < 400; i += 1) {
    const day = new Date(first + i * 86_400_000);
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    const date = dayKey(y, m, d);
    const weekday = day.getUTCDay();
    const todays = exceptions.filter((exception) => exception.date === date);
    for (const pattern of patterns) {
      if (!pattern.days.includes(weekday)) continue;
      const applies = todays.filter((exception) => !exception.patternId || exception.patternId === pattern.id);
      if (applies.some((exception) => exception.kind === 'closed')) continue;
      const hours = applies.find((exception) => exception.kind === 'hours' && isTime(exception.start) && isTime(exception.end));
      const leader = applies.find((exception) => exception.kind === 'leader');
      const start = hours?.start ?? pattern.start;
      const end = hours?.end ?? pattern.end;
      const [sh, sm] = parseTime(start);
      const [eh, em] = parseTime(end);
      const startsAt = zonedTimeToUtc(y, m, d, sh, sm, timeZone).getTime();
      let endsAt = zonedTimeToUtc(y, m, d, eh, em, timeZone).getTime();
      if (endsAt <= startsAt) {
        const next = new Date(Date.UTC(y, m - 1, d + 1));
        endsAt = zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), eh, em, timeZone).getTime();
      }
      if (endsAt <= from || startsAt >= to) continue;
      out.push({
        patternId: pattern.id,
        name: pattern.name,
        date,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        leaderId: leader ? leader.leaderId : pattern.leaderId,
        memberIds: pattern.memberIds,
        note: applies.map((exception) => exception.note).filter(Boolean).join('; ') || null,
      });
    }
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** The shift running at `at` (the latest-started, if two overlap) and the next one to start. */
export function shiftStatus(patterns: ShiftPattern[], exceptions: ShiftException[], timeZone: string, at: number) {
  const window = shiftOccurrences(patterns, exceptions, timeZone, at - 2 * 86_400_000, at + 14 * 86_400_000);
  const running = window.filter((shift) => Date.parse(shift.startsAt) <= at && Date.parse(shift.endsAt) > at);
  const current = running.sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0] ?? null;
  const next = window.find((shift) => Date.parse(shift.startsAt) > at) ?? null;
  return { current, next };
}
