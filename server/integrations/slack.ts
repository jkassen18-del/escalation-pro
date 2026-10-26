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
import { templateFor, valuesFor } from './message-format.ts';
import { fieldPairs, fill, type MessageTemplate, type TemplateValues } from '../../shared/message-template.ts';

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
 * Block Kit payload, laid out by the message design saved under Integrations.
 * Slack renders `blocks`; `text` is the notification fallback shown in the
 * sidebar and on mobile push.
 */
export function buildMessage(
  ctx: Pick<NotificationContext, 'ticket' | 'ticketUrl'>,
  template: MessageTemplate,
  values: TemplateValues,
  mention?: string | null,
) {
  const { ticket } = ctx;
  // Slack only notifies when the mention is in the message body, so it leads
  // the headline rather than sitting in a footer nobody is pinged by.
  const lead = mention ? `${mention} ` : '';
  const title = fill(template.title, values, 'slack');
  const subtitle = fill(template.subtitle, values, 'slack');
  const body = fill(template.body, values, 'slack');
  const footer = fill(template.footer, values, 'slack');
  const fields = fieldPairs(template, values, 'slack');

  const blocks: unknown[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${lead}*${title}*${subtitle ? `\n${subtitle}` : ''}` },
    },
  ];
  // Slack allows ten fields to a section.
  for (let i = 0; i < fields.length; i += 10) {
    blocks.push({
      type: 'section',
      fields: fields.slice(i, i + 10).map((field) => ({ type: 'mrkdwn', text: `*${field.label}*\n${field.value}` })),
    });
  }
  if (body) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: body.length > 2900 ? `${body.slice(0, 2900)}…` : body } });
  }
  if (footer) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer.slice(0, 2900) }] });

  /*
   * Resolve/Close/Reopen alongside the link. Whether a click is honoured is
   * decided when it arrives, not here: the buttons are visible to everyone
   * who can see the channel.
   */
  if (template.buttons) blocks.push(ticketActionButtons(ticket, ctx.ticketUrl));

  return {
    // Also the push-notification line, so a phone shows who is being asked.
    text: `${lead}${values.headline}: ${ticket.reference} ${ticket.subject}`,
    blocks,
    ...(template.priorityColour ? { attachments: [{ color: PRIORITY_HEX[ticket.priority] ?? '#667085', blocks: [] }] } : {}),
  };
}

export async function testSlack(record: IntegrationRecord): Promise<TestResult> {
  const config = readConfig(record);
  const useBot = config.mode === 'bot';
  const sender = await senderName();

  if (useBot) {
    if (!config.botToken) return { ok: false, message: 'A bot token is required when using bot mode.' };
    const response = await fetch('https://slack.com/api/auth.test', {
      signal: AbortSignal.timeout(10_000),
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
      // Departments have their own channels; "Send a test to every channel" under routing checks those.
      let routed: { n: number | string } | undefined;
      try {
        routed = await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM team_routing WHERE provider = 'slack' AND target <> ''`);
      } catch {
        routed = undefined;
      }
      return Number(routed?.n ?? 0) > 0
        ? { ok: true, message: `Connected to "${body.team}" as ${body.user}. Tickets go to each department's own channel.`, details: { team: body.team, user: body.user } }
        : { ok: false, message: `Token is valid for workspace "${body.team}", but no channel is picked for any department yet. Pick them under "Where each department's tickets go".` };
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
      signal: AbortSignal.timeout(10_000),
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
export async function findSlackThread(ticketId: string, channel?: string): Promise<{ ts: string; channel: string | null } | null> {
  const row = channel
    ? await db.get<{ external_id: string; external_key: string | null }>(
        `SELECT external_id, external_key FROM ticket_links
         WHERE ticket_id = ? AND provider = 'slack' AND external_key = ? ORDER BY created_at LIMIT 1`,
        [ticketId, channel],
      )
    : await db.get<{ external_id: string; external_key: string | null }>(
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
  const message = buildMessage(ctx, await templateFor('slack'), await valuesFor(ctx), route?.mention);

  try {
    if (config.mode === 'bot') {
      if (!config.botToken) return { ok: false, statusCode: null, error: 'Bot token is not configured' };

      /*
       * The department's channel, else the "everything else" channel. When
       * neither is set this department is deliberately not announced.
       * `||` not `??`: a route may exist purely to set a mention, leaving the
       * channel empty. An empty string is "no override", not "send nowhere".
       */
      const channel = route?.target || config.channel || '';
      if (!channel) return { ok: true, statusCode: null, error: 'Not posted: no Slack channel is set for this department' };

      /*
       * One thread per ticket per channel.
       *
       * The first notification starts a thread in the channel; everything
       * afterwards replies inside it. That keeps a ticket's history together
       * and gives people somewhere to reply that can be traced back to it.
       * A ticket escalated to another department starts a fresh thread in that
       * department's channel, rather than its news staying with the old team.
       */
      const existing = await findSlackThread(ctx.ticket.id, channel);

      const response = await fetch('https://slack.com/api/chat.postMessage', {
        signal: AbortSignal.timeout(10_000),
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
        // Keyed by the channel as configured, so the next lookup matches even when
        // an older setup named it (#escalations) and Slack answered with an id.
        const posted = body.channel ?? channel;
        await addLink(ctx.ticket.id, 'slack', body.ts, channel, threadPermalink(posted, body.ts)).catch(
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
