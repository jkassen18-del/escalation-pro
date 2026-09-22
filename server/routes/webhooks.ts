import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { db } from '../db/index.ts';
import { asyncRoute } from '../lib/http.ts';
import { recordAudit } from '../lib/audit.ts';
import { notifyUsers } from '../lib/notifications.ts';
import { loadIntegration } from '../integrations/store.ts';
import { mapLinearStateToStatus, type LinearConfig } from '../integrations/linear.ts';
import { findTicketBySlackThread, type SlackConfig } from '../integrations/slack.ts';
import {
  isThreadReply,
  resolveSlackAuthor,
  slackTextToPlain,
  verifySlackSignature,
  type SlackEventEnvelope,
} from '../integrations/slack-events.ts';
import {
  applyStatus,
  parseInteractivePayload,
  resolveActor,
  respondEphemeral,
  statusForAction,
} from '../integrations/slack-actions.ts';
import { dispatch, buildTicketUrl } from '../integrations/dispatcher.ts';
import { findTicket, recordEvent } from '../repositories/tickets.ts';
import { getSettings } from '../repositories/settings.ts';
import { randomId } from '../lib/crypto.ts';

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

/* --------------------------- Slack replies -------------------------------- */

/**
 * Inbound Slack events.
 *
 * Every ticket gets one thread in the channel, and a reply typed there becomes
 * a comment on that ticket - so the people who work in Slack do not have to
 * open the app to answer, and the requester still gets told.
 */
webhooksRouter.post(
  '/slack',
  asyncRoute(async (req, res) => {
    const envelope = req.body as SlackEventEnvelope;

    const record = await loadIntegration('slack');
    const config = record.config as SlackConfig;

    /*
     * Slack verifies the URL by posting a challenge when it is first saved.
     * This is answered before the enabled/secret checks, because otherwise the
     * endpoint cannot be registered until the integration is already working -
     * and the secret it would be verified with is the one being set up.
     */
    if (envelope.type === 'url_verification') {
      if (!envelope.challenge) return res.status(400).json({ error: 'No challenge supplied' });
      return res.json({ challenge: envelope.challenge });
    }

    if (!record.enabled) return res.status(503).json({ error: 'Slack integration is disabled' });
    if (!config.signingSecret) return res.status(400).json({ error: 'No Slack signing secret configured' });

    const verified = verifySlackSignature(req, config.signingSecret);
    if (!verified.ok) return res.status(401).json({ error: verified.reason });

    // Everything past here is accepted with 200 whatever happens: Slack retries
    // anything else, and a retry would post the same comment a second time.
    if (envelope.type !== 'event_callback' || !isThreadReply(envelope.event)) {
      return res.json({ ok: true, ignored: true });
    }

    const event = envelope.event!;
    const ticketId = await findTicketBySlackThread(event.thread_ts!);
    if (!ticketId) return res.json({ ok: true, ignored: true });

    const settings = await getSettings();
    const ticket = await findTicket(ticketId, settings.ticketPrefix);
    if (!ticket) return res.json({ ok: true, ignored: true });

    /*
     * Slack redelivers on any non-2xx and on its own timeouts, so the message
     * timestamp - unique per message - is what stops a retry becoming a second
     * comment. Checked before writing rather than after.
     */
    const seen = await db.get<{ id: string }>(
      `SELECT id FROM ticket_links WHERE provider = 'slack_reply' AND external_id = ?`,
      [event.ts!],
    );
    if (seen) return res.json({ ok: true, duplicate: true });

    const author = await resolveSlackAuthor(config.botToken ?? '', event.user!);
    const body = slackTextToPlain(event.text ?? '');
    if (!body) return res.json({ ok: true, ignored: true });

    const now = new Date().toISOString();
    const commentId = randomId();

    await db.run(
      `INSERT INTO ticket_comments (id, ticket_id, author_id, body, body_format, is_internal, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'text', 0, ?, ?)`,
      [
        commentId,
        ticket.id,
        author.userId,
        // Named in the body when the writer is not a user here, so the comment
        // is never silently anonymous.
        author.userId ? body : `${author.displayName} replied in Slack:\n\n${body}`,
        now,
        now,
      ],
    );

    await db.run(`INSERT INTO ticket_links (id, ticket_id, provider, external_id, external_key, url, created_at)
       VALUES (?, ?, 'slack_reply', ?, ?, ?, ?)`,
      [randomId(), ticket.id, event.ts!, commentId, '', now]);

    await recordEvent(ticket.id, author.userId, 'commented', 'source', null, 'slack');

    /*
     * Tell the people who are waiting on this ticket. The author is left out:
     * they just wrote it.
     */
    const recipients = [ticket.requesterId, ticket.assigneeId, ...ticket.watcherIds].filter(
      (id): id is string => Boolean(id) && id !== author.userId,
    );
    await notifyUsers(recipients, {
      ticketId: ticket.id,
      type: 'comment',
      title: `${author.displayName} replied to ${ticket.reference} in Slack`,
      body: body.slice(0, 280),
    });

    await recordAudit({
      actorId: author.userId,
      actorName: author.displayName,
      entityType: 'ticket',
      entityId: ticket.id,
      action: 'comment_from_slack',
      summary: `${author.displayName} replied to ${ticket.reference} from Slack`,
    });

    // Out to the other channels, but not back to Slack - that is where it came
    // from, and the thread already shows it.
    await dispatch(
      {
        event: 'ticketCommented',
        ticket,
        actorName: author.displayName,
        headline: `${author.displayName} replied in Slack`,
        detail: body,
        ticketUrl: await buildTicketUrl(ticket),
      },
      { exclude: ['slack'] },
    );

    res.json({ ok: true, ticket: ticket.reference });
  }),
);

/* ------------------------ Slack button clicks ----------------------------- */

/**
 * Inbound Slack interactions: the Resolve/Close/Reopen buttons.
 *
 * Slack gives three seconds before it shows the person an error, so the work
 * is done first and kept short, and anything slow - telling the other
 * integrations - is left to run after the reply has gone.
 *
 * Every non-signature failure still answers 200 with an explanation: a
 * non-2xx makes Slack retry, and a retry of a button click is another attempt
 * at the same change.
 */
webhooksRouter.post(
  '/slack/interactive',
  asyncRoute(async (req, res) => {
    const record = await loadIntegration('slack');
    const config = record.config as SlackConfig;

    if (!record.enabled) return res.status(503).json({ error: 'Slack integration is disabled' });
    if (!config.signingSecret) return res.status(400).json({ error: 'No Slack signing secret configured' });

    const verified = verifySlackSignature(req, config.signingSecret);
    if (!verified.ok) return res.status(401).json({ error: verified.reason });

    const payload = parseInteractivePayload(req);
    const action = payload?.actions?.[0];
    const next = action?.action_id ? statusForAction(action.action_id) : null;
    const ticketId = action?.value;
    const responseUrl = payload?.response_url;

    // Something else in the app was clicked, or Slack sent a shape we do not
    // handle. Acknowledged and dropped.
    if (!payload || !next || !ticketId || !payload.user?.id) return res.json({ ok: true, ignored: true });

    const actor = await resolveActor(config.botToken ?? '', payload.user.id, 'tickets.update');
    if (!actor.ok) {
      if (responseUrl) await respondEphemeral(responseUrl, actor.message);
      return res.json({ ok: true, refused: true });
    }

    const settings = await getSettings();
    const ticket = await findTicket(ticketId, settings.ticketPrefix);
    if (!ticket) {
      if (responseUrl) await respondEphemeral(responseUrl, 'That ticket no longer exists.');
      return res.json({ ok: true, ignored: true });
    }

    const change = await applyStatus(ticket.id, next, actor.user.id);
    if (!change) return res.json({ ok: true, ignored: true });

    if (!change.changed) {
      if (responseUrl) {
        await respondEphemeral(responseUrl, `${ticket.reference} was already ${next.replace('_', ' ')}.`);
      }
      return res.json({ ok: true, unchanged: true });
    }

    await recordAudit({
      actorId: actor.user.id,
      actorName: actor.user.name,
      entityType: 'ticket',
      entityId: ticket.id,
      action: 'status_changed_from_slack',
      summary: `${actor.user.name} moved ${ticket.reference} to ${next} from Slack`,
      meta: { from: change.from, to: next },
    });

    const watchers = [ticket.requesterId, ticket.assigneeId, ...ticket.watcherIds].filter(
      (id): id is string => Boolean(id) && id !== actor.user.id,
    );
    await notifyUsers(watchers, {
      ticketId: ticket.id,
      type: 'status',
      title: `${actor.user.name} marked ${ticket.reference} ${next.replace('_', ' ')}`,
      body: `Changed from ${change.from.replace('_', ' ')} in Slack.`,
    });

    // Answer the click before fanning out: the ephemeral reply is what the
    // person is waiting on, and Teams, Linear and email are not.
    if (responseUrl) {
      await respondEphemeral(
        responseUrl,
        `${ticket.reference} is now *${next.replace('_', ' ')}*. Everyone watching it has been told.`,
      );
    }
    res.json({ ok: true, ticket: ticket.reference, status: next });

    const updated = await findTicket(ticket.id, settings.ticketPrefix);
    if (updated) {
      void dispatch({
        event: 'ticketStatusChanged',
        ticket: updated,
        actorName: actor.user.name,
        headline: `${updated.reference} moved to ${next.replace('_', ' ')}`,
        detail: `${change.from.replace('_', ' ')} → ${next.replace('_', ' ')} (from Slack)`,
        ticketUrl: await buildTicketUrl(updated),
      });
    }
  }),
);
