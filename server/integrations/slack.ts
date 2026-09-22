import {
  postJson,
  senderName,
  type DeliveryResult,
  type NotificationContext,
  type TestResult,
  PRIORITY_HEX,
} from './types.ts';
import type { IntegrationRecord } from './store.ts';
import { db } from '../db/index.ts';
import { addLink } from '../repositories/tickets.ts';
import { findTeamRoute } from '../repositories/team-routing.ts';
import { ticketActionButtons } from './slack-actions.ts';

export interface SlackConfig {
  /** Incoming webhook URL (https://hooks.slack.com/services/...). */
  webhookUrl?: string;
  /** Bot user OAuth token (xoxb-...), used for chat.postMessage. */
  botToken?: string;
  /** Channel id or name used when posting with a bot token. */
  channel?: string;
  /** Prefer the bot token over the webhook when both are present. */
  mode?: 'webhook' | 'bot';
  /**
   * Slack's app signing secret, used to verify inbound events.
   *
   * Separate from the bot token: the token is how this app talks to Slack,
   * this is how it knows a request really came from Slack.
   */
  signingSecret?: string;
}

function readConfig(record: IntegrationRecord): SlackConfig {
  return record.config as SlackConfig;
}

/**
 * A link to the thread.
 *
 * Built rather than fetched: chat.getPermalink is another round trip, and this
 * form redirects correctly for any workspace.
 */
function threadPermalink(channel: string, ts: string): string {
  return `https://slack.com/archives/${encodeURIComponent(channel)}/p${ts.replace('.', '')}`;
}

/**
 * Block Kit payload. Slack renders `blocks`; `text` is the notification
 * fallback shown in the sidebar and on mobile push.
 */
function buildMessage(ctx: NotificationContext, mention?: string | null) {
  const { ticket } = ctx;
  // Slack only notifies when the mention is in the message body, so it leads
  // the headline rather than sitting in a footer nobody is pinged by.
  const lead = mention ? `${mention} ` : '';
  const fields = [
    `*Status*\n${ticket.status.replace('_', ' ')}`,
    `*Priority*\n${ticket.priority}`,
    `*Team*\n${ticket.teamName ?? 'Unassigned'}`,
    `*Assignee*\n${ticket.assigneeName ?? 'Unassigned'}`,
  ];

  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${lead}*${ctx.headline}*\n<${ctx.ticketUrl}|${ticket.reference}> · ${ticket.subject}`,
      },
    },
    { type: 'section', fields: fields.map((text) => ({ type: 'mrkdwn', text })) },
  ];

  if (ctx.detail) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: ctx.detail.length > 2800 ? `${ctx.detail.slice(0, 2800)}…` : ctx.detail },
    });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Updated by ${ctx.actorName} · ${new Date().toUTCString()}` }],
  });

  /*
   * Resolve/Close/Reopen alongside the link. Whether a click is honoured is
   * decided when it arrives, not here: the buttons are visible to everyone
   * who can see the channel.
   */
  blocks.push(ticketActionButtons(ticket, ctx.ticketUrl));

  return {
    // Also the push-notification line, so a phone shows who is being asked.
    text: `${lead}${ctx.headline}: ${ticket.reference} ${ticket.subject}`,
    blocks,
    attachments: [{ color: PRIORITY_HEX[ticket.priority] ?? '#667085', blocks: [] }],
  };
}

export async function testSlack(record: IntegrationRecord): Promise<TestResult> {
  const config = readConfig(record);
  const useBot = config.mode === 'bot';
  const sender = await senderName();

  if (useBot) {
    if (!config.botToken) return { ok: false, message: 'A bot token is required when using bot mode.' };
    const response = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    const body = (await response.json()) as { ok: boolean; error?: string; team?: string; user?: string };
    if (!body.ok) {
      return { ok: false, message: `Slack rejected the token: ${body.error ?? 'unknown error'}` };
    }
    if (!config.channel) {
      return { ok: false, message: `Token is valid for workspace "${body.team}", but no channel is set.` };
    }

    /*
     * Actually post, rather than stopping at auth.test.
     *
     * A valid token proves the app exists, not that it can write to this
     * channel: chat.postMessage fails with not_in_channel when the bot has
     * not been invited and lacks chat:write.public. Reporting "connection
     * verified" on auth.test alone meant the test passed while every real
     * notification was refused - which is worse than no test at all.
     */
    const posted = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel: config.channel,
        text: `${sender} connection test`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${sender} is connected.*\nThis channel will receive ticket notifications.`,
            },
          },
        ],
      }),
    });
    const postBody = (await posted.json()) as { ok: boolean; error?: string; channel?: string };

    if (!postBody.ok) {
      // Slack's error codes are terse, so the common ones get an explanation.
      const hint =
        postBody.error === 'not_in_channel'
          ? ` Invite the app to ${config.channel} in Slack, or add the chat:write.public scope and reinstall.`
          : postBody.error === 'channel_not_found'
            ? ` No channel "${config.channel}" is visible to this app. Use the channel ID, and make sure the app is installed in that workspace.`
            : postBody.error === 'missing_scope'
              ? ' The bot token is missing the chat:write scope. Add it and reinstall the app.'
              : '';
      return { ok: false, message: `Slack refused the message: ${postBody.error ?? 'unknown error'}.${hint}` };
    }

    return {
      ok: true,
      message: `Connected to "${body.team}" as ${body.user}, and a test message was posted to ${config.channel}.`,
      details: { team: body.team, user: body.user, channel: postBody.channel },
    };
  }

  if (!config.webhookUrl) return { ok: false, message: 'An incoming webhook URL is required.' };
  if (!config.webhookUrl.startsWith('https://hooks.slack.com/')) {
    return { ok: false, message: 'That does not look like a Slack incoming webhook URL.' };
  }

  const { status, text } = await postJson(config.webhookUrl, {
    text: `${sender} connection test`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${sender} is connected.*\nThis channel will receive ticket notifications.`,
        },
      },
    ],
  });

  if (status === 200 && text.trim() === 'ok') {
    return { ok: true, message: 'Test message delivered to Slack.' };
  }
  return { ok: false, message: `Slack returned ${status}: ${text.slice(0, 200)}` };
}

/**
 * The Slack message that started this ticket's thread, if there is one.
 *
 * Stored as a ticket_link rather than a column on `tickets`: links already
 * exist for exactly this - tying a ticket to something in another system -
 * and a deployment whose tables were created by another database user cannot
 * add columns anyway.
 */
export async function findSlackThread(ticketId: string): Promise<{ ts: string; channel: string | null } | null> {
  const row = await db.get<{ external_id: string; external_key: string | null }>(
    `SELECT external_id, external_key FROM ticket_links
     WHERE ticket_id = ? AND provider = 'slack' ORDER BY created_at LIMIT 1`,
    [ticketId],
  );
  return row ? { ts: row.external_id, channel: row.external_key } : null;
}

/** Finds the ticket a Slack thread belongs to. */
export async function findTicketBySlackThread(threadTs: string): Promise<string | null> {
  const row = await db.get<{ ticket_id: string }>(
    `SELECT ticket_id FROM ticket_links WHERE provider = 'slack' AND external_id = ?`,
    [threadTs],
  );
  return row?.ticket_id ?? null;
}

export async function sendSlack(record: IntegrationRecord, ctx: NotificationContext): Promise<DeliveryResult> {
  const config = readConfig(record);

  /*
   * Departments announce in their own place: an HR ticket goes to the HR
   * channel and pings the HR group. A team with no override falls back to the
   * single channel configured on the integration, so this changes nothing for
   * a deployment that wants one channel for everything.
   */
  const route = await findTeamRoute(ctx.ticket.teamId, 'slack');
  const message = buildMessage(ctx, route?.mention);

  try {
    if (config.mode === 'bot') {
      if (!config.botToken || !config.channel) {
        return { ok: false, statusCode: null, error: 'Bot token or channel is not configured' };
      }

      /*
       * One thread per ticket.
       *
       * The first notification starts a thread in the channel; everything
       * afterwards replies inside it. That keeps a ticket's history together
       * instead of scattering it down the channel, and - the reason it is
       * done here - it gives people somewhere to reply that can be traced
       * back to the ticket.
       */
      const existing = await findSlackThread(ctx.ticket.id);
      // The thread wins over routing: once a ticket's conversation lives in a
      // channel, later notifications must not split off into another one.
      // `||` not `??`: a route may exist purely to set a mention, leaving the
      // channel empty. An empty string is "no override", not "send nowhere".
      const channel = existing?.channel || route?.target || config.channel;

      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.botToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel,
          ...message,
          ...(existing ? { thread_ts: existing.ts } : {}),
        }),
      });
      const body = (await response.json()) as { ok: boolean; error?: string; ts?: string; channel?: string };

      if (body.ok && body.ts && !existing) {
        // Remember the root message so replies to it can find this ticket.
        // Recorded best-effort: losing the thread must not fail the delivery.
        const posted = body.channel ?? channel;
        await addLink(ctx.ticket.id, 'slack', body.ts, posted, threadPermalink(posted, body.ts)).catch(
          () => undefined,
        );
      }

      return {
        ok: body.ok,
        statusCode: response.status,
        error: body.ok ? null : (body.error ?? 'Slack rejected the message'),
      };
    }

    if (!config.webhookUrl) return { ok: false, statusCode: null, error: 'Webhook URL is not configured' };
    const { status, text } = await postJson(config.webhookUrl, message);
    return { ok: status === 200, statusCode: status, error: status === 200 ? null : text.slice(0, 300) };
  } catch (error) {
    return { ok: false, statusCode: null, error: error instanceof Error ? error.message : String(error) };
  }
}
