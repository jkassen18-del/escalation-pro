import crypto from 'node:crypto';
import { db, parseJson } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { isPermission } from '../permissions.ts';
import type { Permission } from '../../shared/types.ts';

/**
 * Keys for the HTTPS API.
 *
 * A key is a bearer credential: whoever holds it can act with its scopes, and
 * there is no second factor and no session to revoke. So it is treated like a
 * password rather than an identifier - shown once at creation, stored only as
 * a hash, and comparable in constant time.
 *
 * SHA-256 rather than the scrypt used for passwords, deliberately. A key is
 * 32 bytes of CSPRNG output with no guessable structure, so there is nothing
 * for an offline attacker to brute-force and nothing for a work factor to
 * buy - while an API call has to verify on every request, where scrypt's
 * cost would be a denial-of-service lever pointed at ourselves.
 */

/** Recognisable in a log or a leaked config file, and greppable. */
const TOKEN_PREFIX = 'itk';

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: Permission[];
  defaultTeamId: string | null;
  createdBy: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  name: string;
  prefix: string;
  token_hash: string;
  scopes: string;
  default_team_id: string | null;
  created_by: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

function map(row: Row): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: parseJson<string[]>(row.scopes, []).filter(isPermission),
    defaultTeamId: row.default_team_id,
    createdBy: row.created_by,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Splits a presented token into the half used to find the row and the half
 * that proves it.
 *
 * Looking the row up by prefix rather than scanning every key and comparing
 * keeps verification to one indexed read however many keys exist.
 */
/**
 * Matched rather than split on underscores.
 *
 * The secret is base64url, whose alphabet includes `_`, so splitting on that
 * character tears a perfectly good token into four pieces roughly half the
 * time - and the key is then rejected as malformed. The prefix is always
 * eight hex characters, which a pattern can pin down exactly.
 */
const TOKEN_PATTERN = new RegExp(`^${TOKEN_PREFIX}_([0-9a-f]{8})_([A-Za-z0-9_-]+)$`);

function splitToken(token: string): { prefix: string; secret: string } | null {
  const trimmed = token.trim();
  const match = TOKEN_PATTERN.exec(trimmed);
  if (!match) return null;
  return { prefix: `${TOKEN_PREFIX}_${match[1]}`, secret: trimmed };
}

export interface CreateApiKeyInput {
  name: string;
  scopes: Permission[];
  defaultTeamId?: string | null;
  expiresAt?: string | null;
  createdBy: string;
}

export interface CreatedApiKey {
  key: ApiKey;
  /** The only time the full token exists outside the caller's hands. */
  token: string;
}

export async function createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
  const prefix = `${TOKEN_PREFIX}_${crypto.randomBytes(4).toString('hex')}`;
  const token = `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
  const now = new Date().toISOString();
  const id = randomId();

  await db.run(
    `INSERT INTO api_keys (id, name, prefix, token_hash, scopes, default_team_id, created_by, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      prefix,
      hashToken(token),
      JSON.stringify(input.scopes),
      input.defaultTeamId ?? null,
      input.createdBy,
      input.expiresAt ?? null,
      now,
      now,
    ],
  );

  const row = await db.get<Row>(`SELECT * FROM api_keys WHERE id = ?`, [id]);
  return { key: map(row!), token };
}

export async function listApiKeys(): Promise<ApiKey[]> {
  const rows = await db.all<Row>(`SELECT * FROM api_keys ORDER BY created_at DESC`);
  return rows.map(map);
}

export async function revokeApiKey(id: string): Promise<boolean> {
  const now = new Date().toISOString();
  const existing = await db.get<Row>(`SELECT * FROM api_keys WHERE id = ? AND revoked_at IS NULL`, [id]);
  if (!existing) return false;
  await db.run(`UPDATE api_keys SET revoked_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
  return true;
}

export type VerifyResult =
  | { ok: true; key: ApiKey }
  | { ok: false; reason: 'malformed' | 'unknown' | 'revoked' | 'expired' };

/**
 * Checks a presented token.
 *
 * The comparison is constant-time even though both sides are hashes: an early
 * byte-wise return is a timing oracle for the hash, and from the hash for the
 * token, and there is no reason to hand that out.
 */
export async function verifyApiKey(token: string, now = new Date()): Promise<VerifyResult> {
  const split = splitToken(token);
  if (!split) return { ok: false, reason: 'malformed' };

  const row = await db.get<Row>(`SELECT * FROM api_keys WHERE prefix = ?`, [split.prefix]);
  if (!row) return { ok: false, reason: 'unknown' };

  const expected = Buffer.from(row.token_hash, 'hex');
  const actual = Buffer.from(hashToken(split.secret), 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'unknown' };
  }

  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (row.expires_at && new Date(row.expires_at) <= now) return { ok: false, reason: 'expired' };

  return { ok: true, key: map(row) };
}

/**
 * Records that a key was used.
 *
 * Deliberately not awaited by the request path and deliberately coarse: an
 * unused key is the one worth revoking, and knowing it was used today is
 * enough to tell. Writing an exact timestamp on every call would make this a
 * write on every read.
 */
export async function touchApiKey(id: string, now = new Date()): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  await db.run(
    `UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
    [now.toISOString(), id, day],
  );
}
