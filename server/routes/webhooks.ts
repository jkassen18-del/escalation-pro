import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { db } from '../db/index.ts';
import { asyncRoute } from '../lib/http.ts';
import { recordAudit } from '../lib/audit.ts';
import { notifyUsers } from '../lib/notifications.ts';
import { loadIntegration } from '../integrations/store.ts';
import { mapLinearStateToStatus, type LinearConfig } from '../integrations/linear.ts';
import { recordEvent } from '../repositories/tickets.ts';

export const webhooksRouter: Router = Router();

/**
 * Linear signs each delivery with an HMAC-SHA256 of the raw body using the
 * webhook secret. We compare against the raw buffer captured by the JSON
 * parser's `verify` hook, because re-serialising would change the bytes.
 */
function verifyLinearSignature(req: Request, secret: string): boolean {
  const signature = req.header('linear-signature');
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!signature || !raw) return false;

  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Inbound Linear events. Keeps a mirrored ticket's status in step when the
 * issue is moved on the Linear side.
 */
webhooksRouter.post(
  '/linear',
  asyncRoute(async (req, res) => {
    const record = await loadIntegration('linear');
    const config = record.config as LinearConfig;

    if (!record.enabled) return res.status(503).json({ error: 'Linear integration is disabled' });
    if (!config.webhookSecret) return res.status(400).json({ error: 'No webhook secret configured' });
    if (!verifyLinearSignature(req, config.webhookSecret)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = req.body as {
      action?: string;
      type?: string;
      data?: { id?: string; identifier?: string; state?: { type?: string; name?: string } };
    };

    if (payload.type !== 'Issue' || !payload.data?.id) return res.json({ ok: true, ignored: true });

    const link = await db.get<{ ticket_id: string }>(
      `SELECT ticket_id FROM ticket_links WHERE provider = 'linear' AND external_id = ?`,
      [payload.data.id],
    );
    if (!link) return res.json({ ok: true, ignored: true });

    const nextStatus = payload.data.state?.type ? mapLinearStateToStatus(payload.data.state.type) : null;
    if (!nextStatus) return res.json({ ok: true, ignored: true });

    const ticket = await db.get<{ status: string; number: number }>(
      `SELECT status, number FROM tickets WHERE id = ?`,
      [link.ticket_id],
    );
    if (!ticket || ticket.status === nextStatus) return res.json({ ok: true, ignored: true });

    const now = new Date().toISOString();
    await db.run(
      `UPDATE tickets SET status = ?, updated_at = ?,
        resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END,
        closed_at = CASE WHEN ? = 'closed' THEN ? ELSE closed_at END
       WHERE id = ?`,
      [nextStatus, now, nextStatus, now, nextStatus, now, link.ticket_id],
    );
    await recordEvent(link.ticket_id, null, 'synced', 'status', ticket.status, nextStatus);

    const watchers = await db.all<{ user_id: string }>(
      `SELECT user_id FROM ticket_watchers WHERE ticket_id = ?`,
      [link.ticket_id],
    );
    await notifyUsers(
      watchers.map((row) => row.user_id),
      {
        ticketId: link.ticket_id,
        type: 'status',
        title: `Linear moved this ticket to ${nextStatus.replace('_', ' ')}`,
        body: payload.data.identifier ? `Synced from ${payload.data.identifier}` : null,
      },
    );

    await recordAudit({
      actorName: 'Linear',
      entityType: 'ticket',
      entityId: link.ticket_id,
      action: 'status_synced',
      summary: `Linear moved the ticket to ${nextStatus}`,
      meta: { identifier: payload.data.identifier },
    });

    res.json({ ok: true, status: nextStatus });
  }),
);
