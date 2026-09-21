import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from '../config.ts';
import { db } from '../db/index.ts';

/**
 * Attachment bytes live either beside the app or inside the database.
 *
 * Disk is the default and the right answer for a normal server. Serverless
 * platforms have no persistent filesystem, so there the bytes go into Postgres
 * instead - base64 in a TEXT column, which keeps the schema dialect-neutral
 * and avoids a second service just to hold a handful of screenshots.
 */
export type StoreMode = 'disk' | 'database';

export function storeMode(): StoreMode {
  return config.attachmentStore;
}

/** Guards the database path from being used to smuggle in very large files. */
export const DATABASE_STORE_MAX_BYTES = 6 * 1024 * 1024;

export async function putAttachment(
  attachmentId: string,
  storedName: string,
  bytes: Buffer,
): Promise<void> {
  if (storeMode() === 'disk') return; // multer already wrote the file

  await db.run(`UPDATE ticket_attachments SET content = ? WHERE id = ?`, [
    bytes.toString('base64'),
    attachmentId,
  ]);
  // The temporary file multer produced is no longer needed.
  fs.rm(path.join(paths.uploads, storedName), { force: true }, () => undefined);
}

export async function getAttachment(
  attachmentId: string,
  storedName: string,
): Promise<Buffer | null> {
  if (storeMode() === 'database') {
    const row = await db.get<{ content: string | null }>(
      `SELECT content FROM ticket_attachments WHERE id = ?`,
      [attachmentId],
    );
    if (!row?.content) return null;
    return Buffer.from(row.content, 'base64');
  }

  const filePath = path.join(paths.uploads, storedName);
  // Confirm the resolved path is still inside the uploads directory.
  if (!filePath.startsWith(paths.uploads) || !fs.existsSync(filePath)) return null;
  return fs.promises.readFile(filePath);
}

export function removeAttachment(storedName: string): void {
  if (storeMode() === 'database') return; // row delete removes the bytes
  fs.rm(path.join(paths.uploads, storedName), { force: true }, () => undefined);
}

/** Serverless writes land in /tmp, the only writable path available. */
export function uploadTempDir(): string {
  return storeMode() === 'database' ? '/tmp' : paths.uploads;
}
