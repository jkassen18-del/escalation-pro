import crypto from 'node:crypto';
import { config } from '../config.ts';

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS: crypto.ScryptOptions = { N: 16384, r: 8, p: 1 };

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  if (!hash || !salt) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
  // Lengths must match before timingSafeEqual, which throws on a mismatch.
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * A real scrypt hash used when no account matched, so an unknown username costs
 * the same as a known one. Without this, the early return leaks which accounts
 * exist through response timing.
 */
const DUMMY = hashPassword(crypto.randomBytes(32).toString('hex'));

export function verifyAgainstDummy(password: string): false {
  verifyPassword(password, DUMMY.hash, DUMMY.salt);
  return false;
}

/** Readable, unambiguous temporary passwords for admin-provisioned accounts. */
export function generatePassword(length = 14): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const ENCRYPTION_PREFIX = 'enc:v1:';

/**
 * Integration credentials (bot tokens, API keys, SMTP passwords) are encrypted
 * at rest so a database dump does not leak access to Slack or Linear.
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.secretKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENCRYPTION_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptSecret(value: string): string {
  if (!value) return '';
  if (!value.startsWith(ENCRYPTION_PREFIX)) return value; // pre-encryption value
  try {
    const raw = Buffer.from(value.slice(ENCRYPTION_PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', config.secretKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // Usually means SECRET_KEY changed; treat as "not configured" rather than crashing.
    return '';
  }
}

/** Shows enough of a secret to recognise it without exposing it. */
export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export function randomId(): string {
  return crypto.randomUUID();
}

export function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
