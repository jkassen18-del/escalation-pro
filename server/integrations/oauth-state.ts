import crypto from 'node:crypto';
import { db } from '../db/index.ts';

/**
 * The `state` parameter of an OAuth round trip (Add to Slack, Microsoft admin
 * consent).
 *
 * It is what stops someone completing an install they did not start: a
 * forged callback carries no state this server issued, and a real one only
 * works once, within ten minutes, from the same signed-in session. Only a
 * hash is stored, so reading the table does not hand out usable states.
 */
const TTL_MS = 10 * 60_000;

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export type OAuthPurpose = 'slack-install' | 'msteams-consent';

export async function createOAuthState(purpose: OAuthPurpose, userId: string, sessionId: string): Promise<string> {
  const state = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  await db.run(
    `INSERT INTO oauth_states (state_hash, purpose, user_id, session_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [hash(state), purpose, userId, hash(sessionId), now.toISOString(), new Date(now.getTime() + TTL_MS).toISOString()],
  );
  // Housekeeping: anything expired an hour ago is of no further interest.
  await db.run(`DELETE FROM oauth_states WHERE expires_at < ?`, [new Date(now.getTime() - 3_600_000).toISOString()]);
  return state;
}

export type StateCheck = 'ok' | 'unknown' | 'expired' | 'used' | 'wrong-session';

/**
 * Checks and spends a state. Marking it used is a conditional UPDATE, and the
 * row is re-read afterwards, so two callbacks racing with the same state
 * cannot both succeed.
 */
export async function consumeOAuthState(
  state: string,
  purpose: OAuthPurpose,
  userId: string,
  sessionId: string,
): Promise<StateCheck> {
  if (!state || state.length > 200) return 'unknown';
  const key = hash(state);
  const row = await db.get<{ purpose: string; user_id: string; session_hash: string; expires_at: string; used_at: string | null }>(
    `SELECT purpose, user_id, session_hash, expires_at, used_at FROM oauth_states WHERE state_hash = ?`,
    [key],
  );
  if (!row || row.purpose !== purpose) return 'unknown';
  if (row.used_at) return 'used';
  if (new Date(row.expires_at).getTime() < Date.now()) return 'expired';
  if (row.user_id !== userId || row.session_hash !== hash(sessionId)) return 'wrong-session';

  const stamp = `${new Date().toISOString()}#${crypto.randomBytes(6).toString('hex')}`;
  await db.run(`UPDATE oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL`, [stamp, key]);
  const after = await db.get<{ used_at: string | null }>(`SELECT used_at FROM oauth_states WHERE state_hash = ?`, [key]);
  return after?.used_at === stamp ? 'ok' : 'used';
}

export const STATE_MESSAGES: Record<Exclude<StateCheck, 'ok'>, string> = {
  unknown: 'That link was not issued by this server.',
  expired: 'That link expired. Start again from the Integrations page.',
  used: 'That link has already been used. Start again from the Integrations page.',
  'wrong-session': 'That link was started from a different sign-in. Start again from the Integrations page in this browser.',
};
