import { db } from '../db/index.ts';
import type { AppSettings, TicketPriority } from '../../shared/types.ts';

const DEFAULTS: AppSettings = {
  organizationName: 'Escalation Pro',
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
