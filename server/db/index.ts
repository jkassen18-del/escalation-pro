import { createDriver, type DbDriver, type SqlParam } from './driver.ts';
import { migrate } from './schema.ts';

let driver: DbDriver | null = null;

export async function initDatabase(): Promise<DbDriver> {
  if (driver) return driver;
  driver = await createDriver();
  await migrate(driver);
  console.log(`[db] connected to ${driver.describe()}`);
  return driver;
}

export function getDriver(): DbDriver {
  if (!driver) throw new Error('Database has not been initialised. Call initDatabase() first.');
  return driver;
}

export const db = {
  get dialect() {
    return getDriver().dialect;
  },
  all<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []) {
    return getDriver().all<T>(sql, params);
  },
  get<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []) {
    return getDriver().get<T>(sql, params);
  },
  run(sql: string, params: SqlParam[] = []) {
    return getDriver().run(sql, params);
  },
  transaction<T>(fn: () => Promise<T>) {
    return getDriver().transaction(fn);
  },
  close() {
    const current = driver;
    driver = null;
    return current ? current.close() : Promise.resolve();
  },
};

/** 0/1 integers are how booleans are stored; some drivers hand them back as strings. */
export function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1' || value === 't' || value === 'true';
}

export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

/**
 * Reserves the next ticket number. Runs inside the caller's transaction so two
 * concurrent creates can never be handed the same number.
 */
export async function nextTicketNumber(): Promise<number> {
  await db.run(`UPDATE counters SET value = value + 1 WHERE name = 'ticket_number'`);
  const row = await db.get<{ value: number }>(`SELECT value FROM counters WHERE name = 'ticket_number'`);
  return Number(row?.value ?? 1001);
}

/** Builds `IN (?, ?, ?)` fragments without hand-rolling placeholder strings. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}
