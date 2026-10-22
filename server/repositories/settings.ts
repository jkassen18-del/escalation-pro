import { db } from '../db/index.ts';
import type { AppSettings, TicketPriority } from '../../shared/types.ts';

const DEFAULTS: AppSettings = {
  organizationName: 'Service Desk',
  supportEmail: '',
  appUrl: '',
  defaultTeamId: null,
  defaultPriority: 'normal',
  slaResponseMins: 240,
  slaResolveMins: 2880,
  ticketPrefix: 'ESC',
  timezone: 'UTC',
};

export async function getSettings(): Promise<AppSettings> {
  const rows = await db.all<{ key: string; value: string }>(`SELECT key, value FROM settings`);
  const stored: Record<string, unknown> = {};
  for (const row of rows) {
    // Module-owned rows (telephony credentials and the like) are read through
    // their own helpers and must never reach the settings API.
    if (row.key.startsWith('ops.')) continue;
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      stored[row.key] = row.value;
    }
  }
  return { ...DEFAULTS, ...(stored as Partial<AppSettings>) };
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    await db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), now],
    );
  }
  return getSettings();
}

export function defaultPriorityOf(settings: AppSettings): TicketPriority {
  return settings.defaultPriority;
}

/** A module's own settings row, kept out of AppSettings (see getSettings). */
export async function getOpsSetting<T>(name: string, fallback: T): Promise<T> {
  const row = await db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, [`ops.${name}`]);
  if (!row) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(row.value) as T) };
  } catch {
    return fallback;
  }
}

export async function setOpsSetting(name: string, value: unknown): Promise<void> {
  await db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [`ops.${name}`, JSON.stringify(value), new Date().toISOString()],
  );
}
