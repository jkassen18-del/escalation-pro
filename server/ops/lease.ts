import os from 'node:os';
import { db } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';

/**
 * Leader election through the database.
 *
 * Every instance runs the same timers, but only the holder of a lease does
 * the work behind them - so three API nodes do not each run the same check,
 * page the same person, or take the same backup. A holder that dies simply
 * stops renewing, and another instance takes over once the lease expires.
 */
const HOLDER = `${os.hostname()}:${process.pid}:${randomId().slice(0, 8)}`;

export async function acquireLease(name: string, ttlMs: number): Promise<boolean> {
  const now = new Date();
  const expires = new Date(now.getTime() + ttlMs).toISOString();
  await db.run(`INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING`, [
    name,
    HOLDER,
    expires,
  ]);
  // Take it over if it is ours or has lapsed; a single UPDATE is atomic on every engine.
  await db.run(`UPDATE leases SET holder = ?, expires_at = ? WHERE name = ? AND (holder = ? OR expires_at < ?)`, [
    HOLDER,
    expires,
    name,
    HOLDER,
    now.toISOString(),
  ]);
  const row = await db.get<{ holder: string }>(`SELECT holder FROM leases WHERE name = ?`, [name]);
  return row?.holder === HOLDER;
}
