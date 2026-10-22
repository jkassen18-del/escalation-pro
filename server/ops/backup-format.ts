import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

/**
 * The on-disk format of an encrypted backup, kept free of the database and
 * app config so the standalone decrypt tool can use it.
 *
 * ITBK2 (current): "ITBK2" | uint16 BE header length | header JSON | 12-byte IV
 *   | AES-256-GCM ciphertext of gzip(dump) | 16-byte tag.
 *   The header carries the per-backup key wrapped with the backup key, so the
 *   file plus BACKUP_KEY (or SECRET_KEY) is enough to restore it, even when
 *   the InfraTicket database that ran the backup is gone.
 *
 * ITBK1 (older): "ITBK1" | IV | ciphertext | tag. The wrapped key lives only
 *   in backup_runs.wrapped_key, so these restore through the app.
 */

export const MAGIC_V1 = Buffer.from('ITBK1');
export const MAGIC_V2 = Buffer.from('ITBK2');
const IV_BYTES = 12;
const TAG_BYTES = 16;

interface HeaderV2 {
  v: 2;
  /** Fingerprint of the key that wraps `wrap`, to name the right key on failure. */
  kid: string;
  /** base64(iv | tag | ciphertext) of the 32-byte per-backup key. */
  wrap: string;
}

/** Keys are configured as text and used as their SHA-256, like SECRET_KEY. */
export function deriveKey(material: string): Buffer {
  return crypto.createHash('sha256').update(material).digest();
}

/** A short public identifier for a key; reveals nothing usable about it. */
export function keyFingerprint(key: Buffer): string {
  return crypto.createHash('sha256').update('infraticket-key-id:').update(key).digest('hex').slice(0, 16);
}

export function wrapKey(master: Buffer, key: Buffer): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', master, iv);
  const encrypted = Buffer.concat([cipher.update(key), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

/** Null when `master` is the wrong key. */
export function unwrapKey(master: Buffer, wrapped: string): Buffer | null {
  try {
    const raw = Buffer.from(wrapped, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', master, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch {
    return null;
  }
}

/** Everything written before the ciphertext. */
export function encodeHeaderV2(master: Buffer, key: Buffer, iv: Buffer): Buffer {
  const header: HeaderV2 = { v: 2, kid: keyFingerprint(master), wrap: wrapKey(master, key) };
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(json.length);
  return Buffer.concat([MAGIC_V2, length, json, iv]);
}

export interface BackupFileInfo {
  version: 1 | 2;
  /** Byte offset where the ciphertext starts. */
  dataStart: number;
  iv: Buffer;
  tag: Buffer;
  size: number;
  header: HeaderV2 | null;
}

export function readBackupFile(file: string): BackupFileInfo {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(size, 4096));
    fs.readSync(fd, head, 0, head.length, 0);
    const tag = Buffer.alloc(TAG_BYTES);
    if (size >= TAG_BYTES) fs.readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
    const magic = head.subarray(0, MAGIC_V1.length);
    if (magic.equals(MAGIC_V1)) {
      const dataStart = MAGIC_V1.length + IV_BYTES;
      if (size < dataStart + TAG_BYTES) throw new Error('That backup file is truncated.');
      return { version: 1, dataStart, iv: head.subarray(MAGIC_V1.length, dataStart), tag, size, header: null };
    }
    if (magic.equals(MAGIC_V2)) {
      const jsonLength = head.readUInt16BE(MAGIC_V2.length);
      const jsonStart = MAGIC_V2.length + 2;
      const ivStart = jsonStart + jsonLength;
      const dataStart = ivStart + IV_BYTES;
      if (dataStart > head.length || size < dataStart + TAG_BYTES) throw new Error('That backup file is truncated.');
      const header = JSON.parse(head.subarray(jsonStart, ivStart).toString('utf8')) as HeaderV2;
      return { version: 2, dataStart, iv: head.subarray(ivStart, dataStart), tag, size, header };
    }
    throw new Error('That file is not an InfraTicket backup.');
  } finally {
    fs.closeSync(fd);
  }
}

/** Tries each candidate key against the header; null when none of them fit. */
export function keyFromHeader(info: BackupFileInfo, candidates: Buffer[]): Buffer | null {
  if (!info.header) return null;
  for (const master of candidates) {
    const key = unwrapKey(master, info.header.wrap);
    if (key) return key;
  }
  return null;
}

/**
 * The decompressed dump as a stream. Authenticated: a tampered file, or the
 * wrong key, errors the stream at the end instead of yielding silent garbage.
 */
export function decryptBackupStream(file: string, info: BackupFileInfo, key: Buffer): Readable {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, info.iv);
  decipher.setAuthTag(info.tag);
  const gunzip = zlib.createGunzip();
  const source = fs.createReadStream(file, { start: info.dataStart, end: info.size - TAG_BYTES - 1 });
  source.on('error', (error) => gunzip.destroy(error));
  decipher.on('error', (error) => gunzip.destroy(error));
  return source.pipe(decipher).pipe(gunzip);
}

/**
 * The keys an operator may hold, in the order the app would use them. The
 * session secret file is how a server without SECRET_KEY keeps its key.
 */
export function candidateKeys(env: NodeJS.ProcessEnv, secretFiles: string[]): Buffer[] {
  const materials = [env.BACKUP_KEY, env.SECRET_KEY, env.SESSION_SECRET];
  for (const file of secretFiles) {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text.length >= 32) materials.push(text);
    } catch {
      // Not there; try the next.
    }
  }
  return [...new Set(materials.filter((value): value is string => Boolean(value)))].map(deriveKey);
}

/**
 * The `decrypt-backup` command: an encrypted backup plus its key in, the plain
 * dump out, with no InfraTicket database involved.
 */
export async function decryptBackupFile(
  file: string,
  out: string | undefined,
  env: NodeJS.ProcessEnv,
  secretFiles: string[],
): Promise<string> {
  const info = readBackupFile(file);
  if (info.version === 1) {
    throw new Error(
      'This backup was taken by an older InfraTicket and its key is kept only in that server\'s database. ' +
        'Restore it from Operations > Backups on that server (Download decrypted).',
    );
  }
  const candidates = candidateKeys(env, secretFiles);
  const key = keyFromHeader(info, candidates);
  if (!key) {
    throw new Error(
      `None of the keys available here open this backup (it needs the key with fingerprint ${info.header?.kid}). ` +
        'Set BACKUP_KEY, SECRET_KEY or SESSION_SECRET to the value the server used, or pass --key-file.',
    );
  }
  const target = out || file.replace(/\.gz\.enc$/, '').replace(/\.enc$/, '') + (/\.(gz\.)?enc$/.test(file) ? '' : '.dump');
  const partial = `${target}.partial`;
  try {
    await pipeline(decryptBackupStream(file, info, key), fs.createWriteStream(partial, { mode: 0o600 }));
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw new Error(`The backup failed to decrypt; it is damaged or was modified (${(error as Error).message}).`);
  }
  fs.renameSync(partial, target);
  return target;
}

/** Parses `decrypt-backup <file> [out] [--key-file path]`. */
export async function decryptBackupCommand(args: string[], dataDirs: string[]): Promise<void> {
  const keyFileIndex = args.indexOf('--key-file');
  const keyFiles = keyFileIndex >= 0 ? [args[keyFileIndex + 1]] : [];
  const positional = args.filter((_arg, index) => keyFileIndex < 0 || (index !== keyFileIndex && index !== keyFileIndex + 1));
  const [file, out] = positional;
  if (!file) {
    console.error('Usage: decrypt-backup <backup.gz.enc> [output file] [--key-file path]');
    console.error('Keys are read from BACKUP_KEY, SECRET_KEY, SESSION_SECRET, --key-file, or the data folder\'s .session-secret.');
    process.exitCode = 2;
    return;
  }
  const secretFiles = [...keyFiles, ...dataDirs.map((dir) => path.join(dir, '.session-secret'))];
  const written = await decryptBackupFile(file, out, process.env, secretFiles);
  console.log(`Decrypted to ${written}`);
}
