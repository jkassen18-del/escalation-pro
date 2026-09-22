import crypto from 'node:crypto';
import type { Request } from 'express';
import { db } from '../db/index.ts';

/**
 * Inbound Slack events: replies people type in a ticket's thread.
 *
 * Slack signs every delivery, and the signature is the only thing standing
 * between this endpoint and anyone on the internet posting comments onto
 * tickets. It is verified against the raw request bytes, because
 * re-serialising the parsed body would change them.
 */

/** Slack rejects its own deliveries older than this, and so does this. */
const MAX_SKEW_SECONDS = 60 * 5;

export interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
  event?: {
    type?: string;
    subtype?: string;
    text?: string;
    user?: string;
    bot_id?: string;
    app_id?: string;
    ts?: string;
    thread_ts?: string;
    channel?: string;
  };
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Checks Slack's v0 signature.
 *
 * The timestamp is part of the signed string and is also checked for
 * freshness: without that, a captured request stays valid forever and can be
 * replayed to post the same comment repeatedly.
 */
export function verifySlackSignature(req: Request, signingSecret: string, now = Date.now()): VerifyResult {
  const signature = req.header('x-slack-signature');
  const timestamp = req.header('x-slack-request-timestamp');
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;

  if (!signature || !timestamp || !raw) return { ok: false, reason: 'Missing signature headers' };

  const age = Math.abs(Math.floor(now / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > MAX_SKEW_SECONDS) return { ok: false, reason: 'Stale timestamp' };

  const expected =
    'v0=' + crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${raw.toString('utf8')}`).digest('hex');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false, reason: 'Invalid signature' };
  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'Invalid signature' };
}

/**
 * True when the event is a human reply inside a thread.
 *
 * Bot messages are excluded first and foremost to stop a loop: this app's own
 * notifications land in the same thread, and treating one as a reply would
 * have it comment on the ticket that produced it. Edits, joins and deletions
 * arrive as subtypes and are not replies either.
 */
export function isThreadReply(event: SlackEventEnvelope['event']): boolean {
  if (!event || event.type !== 'message') return false;
  if (event.bot_id || event.app_id) return false;
  if (event.subtype) return false;
  if (!event.thread_ts || !event.user) return false;
  // The thread's own root message is not a reply to itself.
  if (event.thread_ts === event.ts) return false;
  return Boolean(event.text?.trim());
}

export interface SlackAuthor {
  userId: string | null;
  displayName: string;
}

/**
 * Works out who wrote the reply.
 *
 * Slack identifies people by an opaque id, so their email is fetched and
 * matched against a user here. Without a match the comment is still recorded,
 * attributed by name - losing the reply because the author is not a user of
 * this system would be worse than an unattributed comment.
 */
export async function resolveSlackAuthor(botToken: string, slackUserId: string): Promise<SlackAuthor> {
  let displayName = 'Someone in Slack';

  try {
    const response = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const body = (await response.json()) as {
      ok: boolean;
      user?: { real_name?: string; name?: string; profile?: { email?: string; real_name?: string } };
    };

    if (!body.ok || !body.user) return { userId: null, displayName };

    displayName = body.user.profile?.real_name || body.user.real_name || body.user.name || displayName;

    const email = body.user.profile?.email?.trim().toLowerCase();
    if (!email) return { userId: null, displayName };

    const row = await db.get<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE LOWER(email) = ? AND status = 'active'`,
      [email],
    );
    return row ? { userId: row.id, displayName: row.name } : { userId: null, displayName };
  } catch {
    // users.info needs users:read and users:read.email. Without them the
    // reply is still worth keeping, just unattributed.
    return { userId: null, displayName };
  }
}

/**
 * Slack's mrkdwn rendered as plain text.
 *
 * Stored as plain text rather than HTML: it is written by people outside this
 * system, and the less of it that is ever interpreted as markup, the better.
 * Only the link and mention forms are unwrapped, because raw they are unreadable.
 */
export function slackTextToPlain(text: string): string {
  return text
    // <https://example.com|label> and <https://example.com>
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    // <@U123|name> and <#C123|channel>
    .replace(/<[@#]([A-Z0-9]+)\|([^>]+)>/g, '@$2')
    .replace(/<!([a-z]+)>/g, '@$1')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .trim();
}
