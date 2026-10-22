/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week),
 * evaluated in UTC. Supports `*`, lists, ranges and steps, which covers every
 * schedule a backup job needs without pulling in a dependency.
 */

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const FIELDS: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(text: string, [min, max]: [number, number], name: string): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in ${name}: "${part}"`);
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      [lo, hi] = range.split('-').map(Number);
    } else {
      lo = Number(range);
      hi = stepText === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`Bad ${name}: "${part}" (allowed ${min}-${max})`);
    }
    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string): CronSpec {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('A schedule needs five fields: minute hour day month weekday');
  const names = ['minute', 'hour', 'day of month', 'month', 'day of week'];
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((part, i) => parseField(part, FIELDS[i], names[i]));
  // 7 is Sunday too.
  if (dayOfWeek.has(7)) dayOfWeek.add(0);
  return { minute, hour, dayOfMonth, month, dayOfWeek, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

/** The first matching minute strictly after `from`. */
export function nextCronTime(expression: string, from: Date = new Date()): Date {
  const spec = parseCron(expression);
  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  // Four years of minutes is more than any valid expression needs (29 Feb).
  for (let i = 0; i < 4 * 366 * 24 * 60; i += 1) {
    if (!spec.month.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0);
      continue;
    }
    const domMatch = spec.dayOfMonth.has(t.getUTCDate());
    const dowMatch = spec.dayOfWeek.has(t.getUTCDay());
    // Classic cron: when both day fields are restricted, either may match.
    const dayMatch = spec.domAny && spec.dowAny ? true : spec.domAny ? dowMatch : spec.dowAny ? domMatch : domMatch || dowMatch;
    if (!dayMatch) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0);
      continue;
    }
    if (!spec.hour.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0);
      continue;
    }
    if (!spec.minute.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1);
      continue;
    }
    return t;
  }
  throw new Error(`"${expression}" never matches`);
}

/** Roughly how often a schedule fires, for sizing its heartbeat monitor. */
export function cronPeriodSecs(expression: string, from: Date = new Date()): number {
  const first = nextCronTime(expression, from);
  const second = nextCronTime(expression, first);
  return Math.round((second.getTime() - first.getTime()) / 1000);
}
