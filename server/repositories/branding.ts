import { db } from '../db/index.ts';

/**
 * Company branding: the organisation's own logo, shown in the app shell, on
 * the sign-in screen and as the browser tab icon.
 *
 * Stored base64 in the database rather than on disk so it survives on a
 * serverless deployment, which has no persistent filesystem. Kept out of the
 * `settings` blob because that is read on nearly every request.
 */
export const LOGO_ID = 'logo';

/** Comfortably larger than any sensible logo, small enough to stay cheap to serve. */
export const MAX_LOGO_BYTES = 512 * 1024;

export interface BrandingAsset {
  mimeType: string;
  byteSize: number;
  content: Buffer;
  updatedAt: string;
}

/**
 * Raster formats only.
 *
 * SVG is deliberately excluded: it is a document that can carry script, and
 * this file is served from the app's own origin, so accepting one would let
 * anyone who can manage settings plant stored XSS for every visitor.
 */
const SIGNATURES: Array<{ mime: string; matches: (bytes: Buffer) => boolean }> = [
  { mime: 'image/png', matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', matches: (b) => b.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/) !== null },
  {
    mime: 'image/webp',
    matches: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/**
 * Identifies the image from its own bytes.
 *
 * The declared Content-Type is whatever the uploader chose to send, so it is
 * not evidence of anything; the magic number is. Returning the detected type
 * also means the file is later served as what it actually is.
 */
export function detectImageType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  return SIGNATURES.find((signature) => signature.matches(bytes))?.mime ?? null;
}

export async function getBrandingAsset(id: string = LOGO_ID): Promise<BrandingAsset | null> {
  const row = await db.get<{ mime_type: string; byte_size: number | string; content: string; updated_at: string }>(
    `SELECT mime_type, byte_size, content, updated_at FROM branding_assets WHERE id = ?`,
    [id],
  );
  if (!row) return null;
  return {
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    content: Buffer.from(row.content, 'base64'),
    updatedAt: row.updated_at,
  };
}

/** Just the metadata, for callers that only need to know whether a logo exists. */
export async function getBrandingMeta(id: string = LOGO_ID): Promise<{ updatedAt: string } | null> {
  const row = await db.get<{ updated_at: string }>(`SELECT updated_at FROM branding_assets WHERE id = ?`, [id]);
  return row ? { updatedAt: row.updated_at } : null;
}

export async function putBrandingAsset(bytes: Buffer, mimeType: string, id: string = LOGO_ID): Promise<string> {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO branding_assets (id, mime_type, byte_size, content, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET mime_type = excluded.mime_type, byte_size = excluded.byte_size,
       content = excluded.content, updated_at = excluded.updated_at`,
    [id, mimeType, bytes.length, bytes.toString('base64'), now],
  );
  return now;
}

export async function removeBrandingAsset(id: string = LOGO_ID): Promise<void> {
  await db.run(`DELETE FROM branding_assets WHERE id = ?`, [id]);
}
