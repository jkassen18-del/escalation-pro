import { Router } from 'express';
import multer from 'multer';
import { asyncRoute, badRequest, notFound } from '../lib/http.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { attachUser, requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
import { getSettings } from '../repositories/settings.ts';
import {
  MAX_LOGO_BYTES,
  detectImageType,
  getBrandingAsset,
  getBrandingMeta,
  putBrandingAsset,
  removeBrandingAsset,
} from '../repositories/branding.ts';

export const brandingRouter: Router = Router();

/**
 * Branding is readable without signing in: the login screen shows the
 * company's name and logo, which is the whole point of setting them.
 *
 * Nothing here is sensitive - the organisation name is already on the sign-in
 * page and the logo is a public-facing mark.
 */
brandingRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    const [settings, logo] = await Promise.all([getSettings(), getBrandingMeta()]);
    res.json({
      organizationName: settings.organizationName,
      // Cache-busted by the upload time so a replaced logo appears immediately.
      logoUrl: logo ? `/api/branding/logo?v=${encodeURIComponent(logo.updatedAt)}` : null,
    });
  }),
);

brandingRouter.get(
  '/logo',
  asyncRoute(async (req, res) => {
    const logo = await getBrandingAsset();
    if (!logo) throw notFound('No logo has been uploaded.');

    // Served from the app's own origin, so it is pinned to exactly what it is
    // and stopped from being sniffed into something executable.
    res.setHeader('Content-Type', logo.mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline; filename="logo"');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    // The URL carries the upload time, so a given URL's bytes never change.
    res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.send(logo.content);
  }),
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_BYTES, files: 1 },
});

brandingRouter.put(
  '/logo',
  // Mounted ahead of the global attachUser so the GETs above stay public, so
  // the writes resolve the session themselves.
  attachUser,
  requireAuth,
  requirePermission('settings.manage'),
  upload.single('logo'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const file = (req as AuthedRequest & { file?: Express.Multer.File }).file;
    if (!file?.buffer?.length) throw badRequest('Choose an image file to upload.');

    // The browser's declared type is not evidence; the bytes are.
    const mimeType = detectImageType(file.buffer);
    if (!mimeType) {
      throw badRequest('That file is not a PNG, JPEG, GIF or WebP image. SVG logos are not accepted.');
    }

    const updatedAt = await putBrandingAsset(file.buffer, mimeType);
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'settings',
      action: 'logo_updated',
      summary: `${actor.name} updated the company logo`,
      meta: { mimeType, byteSize: file.buffer.length },
      ip: clientIp(req),
    });

    res.json({ logoUrl: `/api/branding/logo?v=${encodeURIComponent(updatedAt)}` });
  }),
);

brandingRouter.delete(
  '/logo',
  attachUser,
  requireAuth,
  requirePermission('settings.manage'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    await removeBrandingAsset();
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'settings',
      action: 'logo_removed',
      summary: `${actor.name} removed the company logo`,
      ip: clientIp(req),
    });
    res.json({ logoUrl: null });
  }),
);
