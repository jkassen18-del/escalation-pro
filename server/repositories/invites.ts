import crypto from 'node:crypto';
import { db } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import type { Invite, InviteStatus } from '../../shared/types.ts';

/**
 * Invite links. The token is shown once, when the invite is made, and only
 * its SHA-256 is kept: a database leak gives nobody a working link.
 */
interface InviteRow {
  id: string;
  token_hash: string;
  label: string | null;
  role_id: string;
  email: string | null;
  allowed_domains: string;
  team_ids: string;
  max_uses: number | string | null;
  uses: number | string;
  expires_at: string;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
  role_name?: string | null;
  created_by_name?: string | null;
}

const TOKEN_PREFIX = 'inv_';

export function hashInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function list(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function inviteStatus(row: Pick<InviteRow, 'revoked_at' | 'expires_at' | 'max_uses' | 'uses'>, now = Date.now()): InviteStatus {
  if (row.revoked_at) return 'revoked';
  if (new Date(row.expires_at).getTime() <= now) return 'expired';
  if (row.max_uses !== null && row.max_uses !== undefined && Number(row.uses) >= Number(row.max_uses)) return 'used_up';
  return 'active';
}

function mapInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    label: row.label,
    roleId: row.role_id,
    roleName: row.role_name ?? 'Unknown role',
    email: row.email,
    allowedDomains: list(row.allowed_domains),
    teamIds: list(row.team_ids),
    maxUses: row.max_uses === null || row.max_uses === undefined ? null : Number(row.max_uses),
    uses: Number(row.uses),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdById: row.created_by,
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at,
    status: inviteStatus(row),
  };
}

const SELECT = `SELECT i.*, r.name AS role_name, u.name AS created_by_name
  FROM invites i
  LEFT JOIN roles r ON r.id = i.role_id
  LEFT JOIN users u ON u.id = i.created_by`;

export async function listInvites(): Promise<Invite[]> {
  const rows = await db.all<InviteRow>(`${SELECT} ORDER BY i.created_at DESC`);
  return rows.map(mapInvite);
}

export async function getInvite(id: string): Promise<Invite | null> {
  const row = await db.get<InviteRow>(`${SELECT} WHERE i.id = ?`, [id]);
  return row ? mapInvite(row) : null;
}

/**
 * The invite a token opens, or null. The lookup is by hash, so comparing the
 * stored hash afterwards in constant time costs nothing and keeps the check
 * honest even if the index were ever swapped for a scan.
 */
export async function findInviteByToken(token: string): Promise<Invite | null> {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
  const hash = hashInviteToken(token);
  const row = await db.get<InviteRow>(`${SELECT} WHERE i.token_hash = ?`, [hash]);
  if (!row) return null;
  const a = Buffer.from(row.token_hash, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return mapInvite(row);
}

export interface CreateInviteInput {
  label: string | null;
  roleId: string;
  email: string | null;
  allowedDomains: string[];
  teamIds: string[];
  maxUses: number | null;
  expiresAt: string;
  createdBy: string;
}

export async function createInvite(input: CreateInviteInput): Promise<{ invite: Invite; token: string }> {
  const id = randomId();
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
  await db.run(
    `INSERT INTO invites (id, token_hash, label, role_id, email, allowed_domains, team_ids, max_uses, uses, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [
      id,
      hashInviteToken(token),
      input.label,
      input.roleId,
      input.email,
      JSON.stringify(input.allowedDomains),
      JSON.stringify(input.teamIds),
      input.maxUses,
      input.expiresAt,
      input.createdBy,
      new Date().toISOString(),
    ],
  );
  return { invite: (await getInvite(id))!, token };
}

export async function revokeInvite(id: string): Promise<void> {
  await db.run(`UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, [new Date().toISOString(), id]);
}

/**
 * Takes one use of an invite, or null when it has none left. Each use is a
 * numbered row; inserting number n+1 succeeds for exactly one of any people
 * racing for it, so a single-use link cannot be used twice. Portable: no
 * row counts or RETURNING, which the three databases spell differently.
 */
export async function claimInviteUse(id: string): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await db.get<InviteRow>(`SELECT * FROM invites WHERE id = ?`, [id]);
    if (!row || inviteStatus(row) !== 'active') return null;
    const counted = await db.get<{ seq: number | string | null; used: number | string }>(
      `SELECT MAX(seq) AS seq, COUNT(*) AS used FROM invite_uses WHERE invite_id = ?`,
      [id],
    );
    // Numbered past the highest so a released use never reuses a number; limited by how many are held.
    const seq = Number(counted?.seq ?? 0) + 1;
    if (row.max_uses !== null && row.max_uses !== undefined && Number(counted?.used ?? 0) >= Number(row.max_uses)) return null;
    const claim = randomId();
    await db.run(
      `INSERT INTO invite_uses (invite_id, seq, claim_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (invite_id, seq) DO NOTHING`,
      [id, seq, claim, new Date().toISOString()],
    );
    const won = await db.get<{ claim_id: string }>(`SELECT claim_id FROM invite_uses WHERE invite_id = ? AND seq = ?`, [id, seq]);
    if (won?.claim_id === claim) {
      await syncUses(id);
      return claim;
    }
  }
  return null;
}

/** Records who a use signed up, once their account exists. */
export async function completeInviteUse(id: string, claim: string, userId: string): Promise<void> {
  await db.run(`UPDATE invite_uses SET user_id = ? WHERE invite_id = ? AND claim_id = ?`, [userId, id, claim]);
}

/** Gives a use back when the sign-up it was taken for failed. */
export async function releaseInviteUse(id: string, claim: string): Promise<void> {
  await db.run(`DELETE FROM invite_uses WHERE invite_id = ? AND claim_id = ?`, [id, claim]);
  await syncUses(id);
}

async function syncUses(id: string): Promise<void> {
  const row = await db.get<{ count: number | string }>(`SELECT COUNT(*) AS count FROM invite_uses WHERE invite_id = ?`, [id]);
  await db.run(`UPDATE invites SET uses = ? WHERE id = ?`, [Number(row?.count ?? 0), id]);
}
