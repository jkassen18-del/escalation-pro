import { db } from '../db/index.ts';
import { randomId } from './crypto.ts';

/**
 * Database-backed failure counter for authentication.
 *
 * Kept in the database rather than in process memory so the limit holds across
 * restarts and across instances, matching how sessions are stored. Login is
 * low-volume, so a row per failed attempt is not a meaningful cost.
 */
export interface LimitRule {
  /** How many failures are allowed inside the window. */
  max: number;
  windowMs: number;
}

/**
 * Per-account is the tight limit: it stops credential stuffing against one
 * person. Per-IP is looser because a whole office can share one address, but
 * it still catches password spraying across many accounts.
 */
export const LOGIN_LIMITS = {
  account: { max: 5, windowMs: 15 * 60 * 1000 } satisfies LimitRule,
  ip: { max: 30, windowMs: 15 * 60 * 1000 } satisfies LimitRule,
};

export interface LimitStatus {
  blocked: boolean;
  /** Seconds until the oldest counted failure falls out of the window. */
  retryAfterSeconds: number;
}

async function countRecent(key: string, windowMs: number): Promise<{ count: number; oldest: string | null }> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = await db.get<{ count: number | string; oldest: string | null }>(
    `SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM login_attempts WHERE key = ? AND created_at >= ?`,
    [key, since],
  );
  return { count: Number(row?.count ?? 0), oldest: row?.oldest ?? null };
}

export async function checkLimit(key: string, rule: LimitRule): Promise<LimitStatus> {
  const { count, oldest } = await countRecent(key, rule.windowMs);
  if (count < rule.max) return { blocked: false, retryAfterSeconds: 0 };

  const releasesAt = oldest ? new Date(oldest).getTime() + rule.windowMs : Date.now() + rule.windowMs;
  return {
    blocked: true,
    retryAfterSeconds: Math.max(1, Math.ceil((releasesAt - Date.now()) / 1000)),
  };
}

export async function recordFailure(keys: string[]): Promise<void> {
  const now = new Date().toISOString();
  for (const key of keys) {
    await db.run(`INSERT INTO login_attempts (id, key, created_at) VALUES (?, ?, ?)`, [randomId(), key, now]);
  }
}

/** A successful sign-in clears that account's and that address's failures. */
export async function clearFailures(keys: string[]): Promise<void> {
  for (const key of keys) {
    await db.run(`DELETE FROM login_attempts WHERE key = ?`, [key]);
  }
}

/** Drops rows that are older than any window, so the table cannot grow forever. */
export async function pruneAttempts(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await db.run(`DELETE FROM login_attempts WHERE created_at < ?`, [cutoff]);
}

export const accountKey = (login: string) => `account:${login.trim().toLowerCase()}`;
export const ipKey = (ip: string | null) => `ip:${ip ?? 'unknown'}`;
