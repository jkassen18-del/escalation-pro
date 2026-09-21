import { postJson, type DeliveryResult, type NotificationContext, type TestResult, PRIORITY_HEX } from './types.ts';
import type { IntegrationRecord } from './store.ts';

export interface SlackConfig {
  /** Incoming webhook URL (https://hooks.slack.com/services/...). */
  webhookUrl?: string;
  /** Bot user OAuth token (xoxb-...), used for chat.postMessage. */
  botToken?: string;
  /** Channel id or name used when posting with a bot token. */
  channel?: string;
  /** Prefer the bot token over the webhook when both are present. */
  mode?: 'webhook' | 'bot';
}

function readConfig(record: IntegrationRecord): SlackConfig {
  return record.config as SlackConfig;
}

/**
 * Block Kit payload. Slack renders `blocks`; `text` is the notification
 * fallback shown in the sidebar and on mobile push.
 */
function buildMessage(ctx: NotificationContext) {
  const { ticket } = ctx;
  const fields = [
    `*Status*\n${ticket.status.replace('_', ' ')}`,
    `*Priority*\n${ticket.priority}`,
    `*Team*\n${ticket.teamName ?? 'Unassigned'}`,
    `*Assignee*\n${ticket.assigneeName ?? 'Unassigned'}`,
  ];

  const blocks: unknown[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${ctx.headline}*\n<${ctx.ticketUrl}|${ticket.reference}> · ${ticket.subject}` },
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

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Open ticket' },
        url: ctx.ticketUrl,
        style: ticket.priority === 'urgent' ? 'danger' : undefined,
      },
    ],
  });

  return {
    text: `${ctx.headline}: ${ticket.reference} ${ticket.subject}`,
    blocks,
    attachments: [{ color: PRIORITY_HEX[ticket.priority] ?? '#667085', blocks: [] }],
  };
}

export async function testSlack(record: IntegrationRecord): Promise<TestResult> {
  const config = readConfig(record);
  const useBot = config.mode === 'bot';

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
    return {
      ok: true,
      message: `Connected to Slack workspace "${body.team}" as ${body.user}. Messages will post to ${config.channel}.`,
      details: { team: body.team, user: body.user },
    };
  }

  if (!config.webhookUrl) return { ok: false, message: 'An incoming webhook URL is required.' };
  if (!config.webhookUrl.startsWith('https://hooks.slack.com/')) {
    return { ok: false, message: 'That does not look like a Slack incoming webhook URL.' };
  }

  const { status, text } = await postJson(config.webhookUrl, {
    text: 'Escalation Pro connection test',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Escalation Pro is connected.*\nThis channel will receive ticket notifications.',
        },
      },
    ],
  });

  if (status === 200 && text.trim() === 'ok') {
    return { ok: true, message: 'Test message delivered to Slack.' };
  }
  return { ok: false, message: `Slack returned ${status}: ${text.slice(0, 200)}` };
}

export async function sendSlack(record: IntegrationRecord, ctx: NotificationContext): Promise<DeliveryResult> {
  const config = readConfig(record);
  const message = buildMessage(ctx);

  try {
    if (config.mode === 'bot') {
      if (!config.botToken || !config.channel) {
        return { ok: false, statusCode: null, error: 'Bot token or channel is not configured' };
      }
      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.botToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel: config.channel, ...message }),
      });
      const body = (await response.json()) as { ok: boolean; error?: string };
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
