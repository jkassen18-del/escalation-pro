import { db, fromBool, parseJson, toBool } from '../db/index.ts';
import { decryptSecret, encryptSecret, maskSecret } from '../lib/crypto.ts';
import type { IntegrationEventToggles, IntegrationProvider } from '../../shared/types.ts';

export const DEFAULT_EVENTS: IntegrationEventToggles = {
  ticketCreated: true,
  ticketAssigned: true,
  ticketStatusChanged: true,
  ticketEscalated: true,
  ticketCommented: false,
  slaBreached: true,
};

/**
 * Fields holding credentials. They are encrypted before being written and are
 * never returned to the browser in full - only a masked preview.
 */
export const SECRET_FIELDS: Record<IntegrationProvider, string[]> = {
  slack: ['webhookUrl', 'botToken', 'signingSecret'],
  msteams: ['webhookUrl', 'appPassword'],
  linear: ['apiKey', 'webhookSecret'],
  email: ['password'],
};

export interface IntegrationRecord {
  provider: IntegrationProvider;
  enabled: boolean;
  config: Record<string, unknown>;
  events: IntegrationEventToggles;
  status: 'unconfigured' | 'ok' | 'error' | 'untested';
  lastCheckedAt: string | null;
  lastError: string | null;
}

/** Returns the record with secrets decrypted, for server-side use only. */
export async function loadIntegration(provider: IntegrationProvider): Promise<IntegrationRecord> {
  const row = await db.get<Record<string, unknown>>(`SELECT * FROM integrations WHERE provider = ?`, [provider]);
  if (!row) {
    return {
      provider,
      enabled: false,
      config: {},
      events: { ...DEFAULT_EVENTS },
      status: 'unconfigured',
      lastCheckedAt: null,
      lastError: null,
    };
  }

  const raw = parseJson<Record<string, unknown>>(row.config, {});
  const config: Record<string, unknown> = { ...raw };
  for (const field of SECRET_FIELDS[provider]) {
    if (typeof raw[field] === 'string') config[field] = decryptSecret(raw[field] as string);
  }

  return {
    provider,
    enabled: toBool(row.enabled),
    config,
    events: { ...DEFAULT_EVENTS, ...parseJson<Partial<IntegrationEventToggles>>(row.events, {}) },
    status: (row.status as IntegrationRecord['status']) ?? 'untested',
    lastCheckedAt: (row.last_checked_at as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
  };
}

export async function saveIntegration(
  provider: IntegrationProvider,
  patch: { enabled?: boolean; config?: Record<string, unknown>; events?: Partial<IntegrationEventToggles> },
): Promise<IntegrationRecord> {
  const current = await loadIntegration(provider);

  // An empty string for a secret means "leave it alone" so the UI can render a
  // masked placeholder without the user having to re-enter the credential.
  const mergedConfig = { ...current.config };
  for (const [key, value] of Object.entries(patch.config ?? {})) {
    if (SECRET_FIELDS[provider].includes(key) && (value === '' || value === undefined)) continue;
    mergedConfig[key] = value;
  }

  const encrypted: Record<string, unknown> = { ...mergedConfig };
  for (const field of SECRET_FIELDS[provider]) {
    if (typeof mergedConfig[field] === 'string' && mergedConfig[field]) {
      encrypted[field] = encryptSecret(mergedConfig[field] as string);
    }
  }

  const events = { ...current.events, ...(patch.events ?? {}) };
  const enabled = patch.enabled ?? current.enabled;

  await db.run(
    `INSERT INTO integrations (provider, enabled, config, events, status, last_checked_at, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider) DO UPDATE SET
       enabled = excluded.enabled, config = excluded.config, events = excluded.events, updated_at = excluded.updated_at`,
    [
      provider,
      fromBool(enabled),
      JSON.stringify(encrypted),
      JSON.stringify(events),
      current.status,
      current.lastCheckedAt,
      current.lastError,
      new Date().toISOString(),
    ],
  );

  return loadIntegration(provider);
}

/**
 * Records the outcome of a connection test.
 *
 * `checkedAt` is only stamped when a test actually ran. Resetting the status
 * after a config edit must leave the old timestamp alone, otherwise the UI
 * ends up claiming "not tested yet" and "last tested a moment ago" at once.
 */
export async function setIntegrationStatus(
  provider: IntegrationProvider,
  status: IntegrationRecord['status'],
  error: string | null,
  options: { stampCheckedAt?: boolean } = {},
): Promise<void> {
  const now = new Date().toISOString();
  const checkedAt = options.stampCheckedAt ? now : null;

  await db.run(
    `INSERT INTO integrations (provider, enabled, config, events, status, last_checked_at, last_error, updated_at)
     VALUES (?, 0, '{}', '{}', ?, ?, ?, ?)
     ON CONFLICT (provider) DO UPDATE SET
       status = excluded.status,
       last_error = excluded.last_error,
       last_checked_at = COALESCE(excluded.last_checked_at, integrations.last_checked_at)`,
    [provider, status, checkedAt, error, now],
  );
}

/** Clears a stale test result after the configuration changes. */
export async function resetIntegrationStatus(
  provider: IntegrationProvider,
  configured: boolean,
): Promise<void> {
  await db.run(
    `UPDATE integrations SET status = ?, last_error = NULL, last_checked_at = NULL WHERE provider = ?`,
    [configured ? 'untested' : 'unconfigured', provider],
  );
}

/** Config safe to send to the browser: secrets replaced with a masked preview. */
export function redactConfig(provider: IntegrationProvider, config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const field of SECRET_FIELDS[provider]) {
    const value = config[field];
    if (typeof value === 'string' && value) {
      out[field] = '';
      out[`${field}Preview`] = maskSecret(value);
      out[`${field}Set`] = true;
    } else {
      out[field] = '';
      out[`${field}Set`] = false;
    }
  }
  return out;
}
