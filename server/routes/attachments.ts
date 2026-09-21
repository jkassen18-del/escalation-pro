import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { config, paths } from '../config.ts';
import { db } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { asyncRoute, badRequest, forbidden, notFound } from '../lib/http.ts';
import { can, requireAuth, type AuthedRequest } from '../middleware/auth.ts';
import { findTicket, recordEvent } from '../repositories/tickets.ts';
import { getSettings } from '../repositories/settings.ts';

export const attachmentsRouter: Router = Router({ mergeParams: true });

/** Allow-list rather than deny-list: anything not named here is rejected. */
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, paths.uploads),
    // Stored under a random name so a hostile filename cannot escape the directory.
    filename: (_req, file, cb) => cb(null, `${randomId()}${path.extname(file.originalname).slice(0, 12)}`),
  }),
  limits: { fileSize: config.maxUploadBytes, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new Error(`Files of type "${file.mimetype}" are not allowed.`));
      return;
    }
    cb(null, true);
  },
});

attachmentsRouter.use(requireAuth);

attachmentsRouter.post(
  '/',
  upload.array('files', 5),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const ticket = await findTicket(req.params.id, settings.ticketPrefix);
    if (!ticket) throw notFound('That ticket does not exist.');

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw badRequest('No files were uploaded.');

    const now = new Date().toISOString();
    const commentId = typeof req.body?.commentId === 'string' ? req.body.commentId : null;

    for (const file of files) {
      await db.run(
        `INSERT INTO ticket_attachments (id, ticket_id, comment_id, stored_name, original_name, mime_type, size, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomId(), ticket.id, commentId, file.filename, file.originalname, file.mimetype, file.size, user.id, now],
      );
      await recordEvent(ticket.id, user.id, 'attached', 'attachment', null, file.originalname);
    }

    await db.run(`UPDATE tickets SET updated_at = ? WHERE id = ?`, [now, ticket.id]);
    res.status(201).json({ ok: true, count: files.length });
  }),
);

attachmentsRouter.get(
  '/:attachmentId',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await getSettings();
    const ticket = await findTicket(req.params.id, settings.ticketPrefix);
    if (!ticket) throw notFound('That ticket does not exist.');

    const visible =
      can(user, 'tickets.view_all') ||
      ticket.assigneeId === user.id ||
      ticket.requesterId === user.id ||
      ticket.createdById === user.id ||
      Boolean(ticket.teamId && user.teamIds.includes(ticket.teamId));
    if (!visible) throw forbidden('You do not have access to this ticket.');

    const row = await db.get<{ stored_name: string; original_name: string; mime_type: string }>(
      `SELECT stored_name, original_name, mime_type FROM ticket_attachments WHERE id = ? AND ticket_id = ?`,
      [req.params.attachmentId, ticket.id],
    );
    if (!row) throw notFound('That attachment does not exist.');

    const filePath = path.join(paths.uploads, row.stored_name);
    // Belt and braces: confirm the resolved path is still inside the uploads dir.
    if (!filePath.startsWith(paths.uploads) || !fs.existsSync(filePath)) {
      throw notFound('That file is no longer available.');
    }

    // SVGs can carry script, so never render them inline in the app's origin.
    const inline = req.query.download !== '1' && row.mime_type !== 'image/svg+xml';
    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(row.original_name)}"`,
    );
    fs.createReadStream(filePath).pipe(res);
  }),
);

attachmentsRouter.delete(
  '/:attachmentId',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const row = await db.get<{ stored_name: string; uploaded_by: string | null }>(
      `SELECT stored_name, uploaded_by FROM ticket_attachments WHERE id = ? AND ticket_id = ?`,
      [req.params.attachmentId, req.params.id],
    );
    if (!row) throw notFound('That attachment does not exist.');
    if (row.uploaded_by !== user.id && !can(user, 'tickets.delete')) {
      throw forbidden('You can only remove attachments you uploaded.');
    }

    await db.run(`DELETE FROM ticket_attachments WHERE id = ?`, [req.params.attachmentId]);
    fs.rm(path.join(paths.uploads, row.stored_name), { force: true }, () => undefined);
    res.json({ ok: true });
  }),
);
