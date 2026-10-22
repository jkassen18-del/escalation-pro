/**
 * Building a weekly on-call roster in a time zone.
 *
 * Handovers are written in the schedule's own zone ("Monday 08:00 SAST") and
 * stored as UTC instants, so the conversion has to know that zone's offset on
 * that particular date - which changes across daylight saving in most of the
 * world, even though South Africa has none. Shared by the roster builder in
 * the browser and the tests.
 */
import type { RosterEntry } from './ops.ts';

/** Milliseconds the zone is ahead of UTC at `at`. */
export function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant at which a wall clock in `timeZone` shows this date and time. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let result = guess - zoneOffsetMs(new Date(guess), timeZone);
  // Re-check once: the offset at the answer can differ from the offset at the guess near a DST change.
  const corrected = guess - zoneOffsetMs(new Date(result), timeZone);
  if (corrected !== result) result = corrected;
  return new Date(result);
}

/** "2026-11-03" -> [2026, 11, 3]. */
function parseDay(day: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new Error(`"${day}" is not a date (YYYY-MM-DD)`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export interface WeeklyRosterInput {
  /** Any date in the first week, YYYY-MM-DD. */
  firstWeek: string;
  /** Handover weekday, 0 = Sunday ... 1 = Monday. */
  weekday: number;
  /** Handover time on the wall clock, HH:MM. */
  time: string;
  timeZone: string;
  /** One person per week, in order. Null leaves that week empty. */
  people: Array<string | null>;
}

/** Calendar date (UTC-based arithmetic, no time zone involved) of week `i`'s handover. */
export function handoverDate(firstWeek: string, weekday: number, weekIndex: number): [number, number, number] {
  const [y, m, d] = parseDay(firstWeek);
  const base = new Date(Date.UTC(y, m - 1, d));
  const back = (base.getUTCDay() - weekday + 7) % 7;
  const date = new Date(Date.UTC(y, m - 1, d - back + 7 * weekIndex));
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
}

/** One entry per person, week by week, each running from one handover to the next. */
export function buildWeeklyRoster(input: WeeklyRosterInput): RosterEntry[] {
  const [hour, minute] = input.time.split(':').map(Number);
  const at = (index: number) => {
    const [y, m, d] = handoverDate(input.firstWeek, input.weekday, index);
    return zonedTimeToUtc(y, m, d, hour || 0, minute || 0, input.timeZone).toISOString();
  };
  const entries: RosterEntry[] = [];
  input.people.forEach((userId, index) => {
    if (userId) entries.push({ userId, startsAt: at(index), endsAt: at(index + 1) });
  });
  return entries;
}
