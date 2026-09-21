import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.ts';
import { db } from '../db/index.ts';
import { randomId } from './crypto.ts';
import { badRequest } from './http.ts';
import { DATABASE_STORE_MAX_BYTES, storeMode } from './attachment-store.ts';

/**
 * Turns pasted screenshots into real attachments.
 *
 * The editor inserts an image as a data: URI, because at paste time there may
 * not be a ticket to attach it to yet. Left alone those base64 blobs would sit
 * inside the description column - megabytes re-read on every list query, never
 * cached by the browser, and invisible to the attachments panel.
 *
 * So on save each one is written to the attachment store and its src is
 * rewritten to point at the file. One code path covers a new ticket, an edited
 * description and a comment alike.
 */

const DATA_URI = /<img\b[^>]*?\bsrc\s*=\s*"(data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+))"[^>]*>/gi;

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Per image, and across one submission, so a paste cannot exhaust storage. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export interface InlineImageContext {
  ticketId: string;
  commentId?: string | null;
  uploadedBy: string | null;
}

async function storeBytes(attachmentId: string, storedName: string, bytes: Buffer): Promise<void> {
  if (storeMode() === 'database') {
    await db.run(`UPDATE ticket_attachments SET content = ? WHERE id = ?`, [bytes.toString('base64'), attachmentId]);
    return;
  }
  await fs.promises.writeFile(path.join(paths.uploads, storedName), bytes);
}

/**
 * Replaces every inline data: image with a stored attachment reference.
 *
 * Returns the rewritten HTML. Markup with no inline images is returned
 * untouched, so the common case costs one regex scan.
 */
export async function extractInlineImages(html: string, context: InlineImageContext): Promise<string> {
  const matches = [...html.matchAll(DATA_URI)];
  if (matches.length === 0) return html;

  let total = 0;
  const replacements = new Map<string, string>();

  for (const match of matches) {
    const [, dataUri, mimeSuffix, base64] = match;
    if (replacements.has(dataUri)) continue; // the same image pasted twice

    const mimeType = `image/${mimeSuffix.toLowerCase()}`;
    const bytes = Buffer.from(base64, 'base64');

    if (bytes.length === 0) throw badRequest('One of the pasted images could not be read.');
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw badRequest(`Pasted images must be ${MAX_IMAGE_BYTES / 1024 / 1024}MB or smaller.`);
    }
    if (storeMode() === 'database' && bytes.length > DATABASE_STORE_MAX_BYTES) {
      throw badRequest(`Pasted images must be ${DATABASE_STORE_MAX_BYTES / 1024 / 1024}MB or smaller here.`);
    }

    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) {
      throw badRequest(`That is more than ${MAX_TOTAL_BYTES / 1024 / 1024}MB of pasted images in one go.`);
    }

    const attachmentId = randomId();
    const extension = EXTENSIONS[mimeType];
    const storedName = `${attachmentId}.${extension}`;

    await db.run(
      `INSERT INTO ticket_attachments
         (id, ticket_id, comment_id, stored_name, original_name, mime_type, size, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        attachmentId,
        context.ticketId,
        context.commentId ?? null,
        storedName,
        `pasted-image.${extension}`,
        mimeType,
        bytes.length,
        context.uploadedBy,
        new Date().toISOString(),
      ],
    );
    await storeBytes(attachmentId, storedName, bytes);

    replacements.set(dataUri, `/api/tickets/${context.ticketId}/attachments/${attachmentId}`);
  }

  // Replace by exact data: URI, so an image is swapped wherever it appears
  // without re-parsing the markup.
  let rewritten = html;
  for (const [dataUri, url] of replacements) {
    rewritten = rewritten.split(`"${dataUri}"`).join(`"${url}"`);
  }
  return rewritten;
}

/** True when the markup still carries inline image data. */
export function hasInlineImages(html: string): boolean {
  DATA_URI.lastIndex = 0;
  return DATA_URI.test(html);
}
