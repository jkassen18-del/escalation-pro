import { findTeamRoute } from '../repositories/team-routing.ts';
import {
  postJson,
  senderName,
  type DeliveryResult,
  type NotificationContext,
  type TestResult,
  PRIORITY_HEX,
} from './types.ts';
import type { IntegrationRecord } from './store.ts';
import { templateFor, valuesFor } from './message-format.ts';
import { PRIORITY_COLORS } from './types.ts';
import { SAMPLE_VALUES, fieldPairs, fill, type MessageTemplate, type TemplateValues } from '../../shared/message-template.ts';

export interface MsTeamsConfig {
  /**
   * How Teams is connected.
   *
   * `webhook` posts to an incoming webhook and is one-way: Microsoft provides
   * no callback on one, so nothing can come back. `bot` registers a real bot
   * with a messaging endpoint, which is the only way Teams can carry replies
   * or a ticket form.
   */
  mode?: 'webhook' | 'bot';
  /** Workflows (Power Automate) URL, or a legacy Office 365 connector URL. */
  webhookUrl?: string;
  /** `auto` picks the payload shape from the URL host. */
  format?: 'auto' | 'adaptive' | 'messagecard';
  /** Bot mode: the Azure app registration's client id. */
  appId?: string;
  /** Bot mode: the client secret. Encrypted at rest like every other secret. */
  appPassword?: string;
  /** Bot mode: restricts inbound activities to one tenant when set. */
  tenantId?: string;
  /** Bot mode: what the app is called in Teams. */
  botName?: string;
  /**
   * Bot mode: where tickets go when their department has no channel of its
   * own. A conversation id, 'none' to post nothing, or unset for the channel
   * the bot was most recently active in.
   */
  defaultConversationId?: string;
}

function readConfig(record: IntegrationRecord): MsTeamsConfig {
  return record.config as MsTeamsConfig;
}

/**
 * Microsoft is retiring Office 365 connectors in favour of Power Automate
 * "Workflows", and the two accept different payloads. Legacy connector URLs
 * live on *.webhook.office.com and take a MessageCard; Workflows URLs are on
 * Azure Logic Apps hosts and take an Adaptive Card wrapped in an attachment.
 */
export function detectFormat(url: string): 'adaptive' | 'messagecard' {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('webhook.office.com') || host.endsWith('office.com')) return 'messagecard';
    return 'adaptive';
  } catch {
    return 'adaptive';
  }
}

function resolveFormat(config: MsTeamsConfig): 'adaptive' | 'messagecard' {
  if (config.format === 'adaptive' || config.format === 'messagecard') return config.format;
  return detectFormat(config.webhookUrl ?? '');
}

/** The Adaptive Card itself, laid out by the saved message design. */
function cardContent(template: MessageTemplate, values: TemplateValues, priority: string, url: string) {
  const title = fill(template.title, values, 'msteams');
  const subtitle = fill(template.subtitle, values, 'msteams');
  const bodyText = fill(template.body, values, 'msteams');
  const footer = fill(template.footer, values, 'msteams');
  const facts = fieldPairs(template, values, 'msteams').map((pair) => ({ title: pair.label, value: pair.value }));

  const header: unknown[] = [
    {
      type: 'TextBlock',
      text: title,
      weight: 'Bolder',
      size: 'Medium',
      wrap: true,
      color: priority === 'urgent' ? 'Attention' : 'Default',
    },
  ];
  if (subtitle) header.push({ type: 'TextBlock', text: subtitle, wrap: true, spacing: 'None' });

  const body: unknown[] = template.priorityColour
    ? [{ type: 'Container', style: PRIORITY_COLORS[priority] ?? 'default', bleed: true, items: header }]
    : header;
  if (facts.length) body.push({ type: 'FactSet', facts });
  if (bodyText) body.push({ type: 'TextBlock', text: bodyText.slice(0, 2000), wrap: true, spacing: 'Medium' });
  if (footer) body.push({ type: 'TextBlock', text: footer, wrap: true, isSubtle: true, size: 'Small', spacing: 'Medium' });

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body,
    ...(template.buttons ? { actions: [{ type: 'Action.OpenUrl', title: 'Open ticket', url }] } : {}),
  };
}

/** Workflows wants the card wrapped in a message; the bot sends `cardContent` as an attachment itself. */
function buildAdaptiveCard(template: MessageTemplate, values: TemplateValues, priority: string, url: string) {
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: cardContent(template, values, priority, url) }],
  };
}

/** Legacy Office 365 connectors: a MessageCard, laid out by the same design. */
function buildMessageCard(template: MessageTemplate, values: TemplateValues, priority: string, url: string) {
  const subtitle = fill(template.subtitle, values, 'msteams');
  const body = fill(template.body, values, 'msteams');
  const footer = fill(template.footer, values, 'msteams');
  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: `${values.reference}: ${values.subject}`,
    ...(template.priorityColour ? { themeColor: (PRIORITY_HEX[priority] ?? '#667085').replace('#', '') } : {}),
    title: fill(template.title, values, 'msteams'),
    sections: [
      {
        activityTitle: subtitle || undefined,
        facts: fieldPairs(template, values, 'msteams').map((pair) => ({ name: pair.label, value: pair.value })),
        text: [body.slice(0, 2000), footer ? `_${footer}_` : ''].filter(Boolean).join('\n\n') || undefined,
        markdown: true,
      },
    ],
    ...(template.buttons
      ? { potentialAction: [{ '@type': 'OpenUri', name: 'Open ticket', targets: [{ os: 'default', uri: url }] }] }
      : {}),
  };
}

export async function buildPayload(config: MsTeamsConfig, ctx: NotificationContext) {
  const template = await templateFor('msteams');
  const values = await valuesFor(ctx);
  return resolveFormat(config) === 'messagecard'
    ? buildMessageCard(template, values, ctx.ticket.priority, ctx.ticketUrl)
    : buildAdaptiveCard(template, values, ctx.ticket.priority, ctx.ticketUrl);
}

/** Workflows returns 202 with an empty body; legacy connectors return 200 "1". */
function isSuccess(status: number, text: string): boolean {
  if (status === 200) return text.trim() === '1' || text.trim() === '' || text.trim().toLowerCase() === 'ok';
  return status === 202;
}

export async function testMsTeams(record: IntegrationRecord): Promise<TestResult> {
  const config = readConfig(record);

  if (config.mode === 'bot') return testTeamsBot(config);

  if (!config.webhookUrl) return { ok: false, message: 'A Microsoft Teams webhook URL is required.' };

  const format = resolveFormat(config);
  const sender = await senderName();
  const url = config.webhookUrl.split('?')[0];
  const values: TemplateValues = {
    ...SAMPLE_VALUES,
    headline: `${sender} is connected`,
    detail: `This channel will receive ticket notifications from ${sender}.`,
    reference: 'TEST-0',
    subject: 'Connection test',
    actor: sender,
    org: sender,
    url,
  };
  const template = await templateFor('msteams');

  try {
    const payload =
      format === 'messagecard' ? buildMessageCard(template, values, 'normal', url) : buildAdaptiveCard(template, values, 'normal', url);
    const { status, text } = await postJson(config.webhookUrl, payload);
    if (isSuccess(status, text)) {
      return {
        ok: true,
        message: `Test card delivered to Microsoft Teams using the ${
          format === 'messagecard' ? 'legacy connector' : 'Workflows adaptive card'
        } format.`,
        details: { format },
      };
    }
    return { ok: false, message: `Microsoft Teams returned ${status}: ${text.slice(0, 250)}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Bot mode: prove the credentials work and that there is somewhere to post.
 *
 * Two separate things can be wrong and they need opposite fixes: Azure can
 * refuse the app id and secret, or the credentials can be perfect and nobody
 * has added the app to a channel yet - in which case every notification will
 * be accepted by this app and delivered nowhere.
 */
async function testTeamsBot(config: MsTeamsConfig): Promise<TestResult> {
  if (!config.appId) return { ok: false, message: 'A Microsoft app id is required in bot mode.' };
  if (!config.appPassword) return { ok: false, message: 'A client secret is required in bot mode.' };

  const { getTeamsAccessToken } = await import('./teams-auth.ts');
  const { defaultConversation } = await import('../repositories/teams-conversations.ts');
  const { sendActivity } = await import('./teams-bot.ts');

  try {
    await getTeamsAccessToken(config.appId, config.appPassword);
  } catch (error) {
    return { ok: false, message: `Microsoft refused the bot credentials: ${(error as Error).message}` };
  }

  const conversation = await defaultConversation();
  if (!conversation) {
    return {
      ok: false,
      message:
        'The credentials are valid, but the app has not been added to a Teams channel yet, so notifications ' +
        'would go nowhere. In Teams: the channel → Apps → add this app, then run this test again.',
    };
  }

  const sender = await senderName();
  const posted = await sendActivity(
    config,
    { serviceUrl: conversation.serviceUrl, conversationId: conversation.conversationId },
    { text: `**${sender} is connected.** This channel will receive ticket notifications.` },
  );

  if (!posted.ok) return { ok: false, message: `Teams refused the message: ${posted.error}` };

  const where = conversation.teamName
    ? `${conversation.teamName} / ${conversation.channelName ?? 'a channel'}`
    : (conversation.channelName ?? 'the connected channel');
  return { ok: true, message: `Connected, and a test message was posted to ${where}.` };
}

/**
 * Bot mode: post into a conversation the bot has been added to.
 *
 * Each ticket gets one thread, as in Slack, so its updates stay together
 * instead of scattering down the channel - and so a reply to any of them can
 * be traced back to the ticket it belongs to.
 */
async function sendViaBot(config: MsTeamsConfig, ctx: NotificationContext): Promise<DeliveryResult> {
  const { findTeamsThread } = await import('./teams-events.ts');
  const { sendActivity } = await import('./teams-bot.ts');
  const { defaultConversation, findConversation } = await import('../repositories/teams-conversations.ts');
  const { addLink } = await import('../repositories/tickets.ts');

  /*
   * A department posts into its own channel. In bot mode the route holds a
   * conversation id rather than a webhook URL, so it has to resolve to a
   * conversation the bot was actually added to - Microsoft refuses a message
   * to any other. With no route, the "everything else" channel if one was
   * picked, else the channel the bot was most recently active in.
   */
  const route = await findTeamRoute(ctx.ticket.teamId, 'msteams');
  const fallback = config.defaultConversationId ? await findConversation(config.defaultConversationId) : null;
  const target = (route?.target ? await findConversation(route.target) : null) ?? fallback ?? (config.defaultConversationId === 'none' ? null : await defaultConversation());
  if (!target && config.defaultConversationId === 'none') {
    return { ok: true, statusCode: null, error: 'Not posted: no Teams channel is set for this department' };
  }
  // One thread per ticket per channel; an escalation to another department starts one there.
  const existing = target ? await findTeamsThread(ctx.ticket.id, target.conversationId) : null;
  const conversation = existing ? { conversationId: existing.conversationId, serviceUrl: existing.serviceUrl } : target;

  if (!conversation) {
    return {
      ok: false,
      statusCode: null,
      error: 'The bot has not been added to any Teams channel yet, so there is nowhere to post.',
    };
  }

  const result = await sendActivity(
    config,
    {
      serviceUrl: conversation.serviceUrl,
      conversationId: conversation.conversationId,
      replyToId: existing?.activityId ?? null,
    },
    {
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: cardContent(await templateFor('msteams'), await valuesFor(ctx), ctx.ticket.priority, ctx.ticketUrl),
        },
      ],
    },
  );

  // The first message for a ticket becomes its thread; later ones reply to it.
  if (result.ok && !existing && result.activityId) {
    await addLink(ctx.ticket.id, 'msteams', result.activityId, conversation.conversationId, conversation.serviceUrl);
  }

  return { ok: result.ok, statusCode: result.ok ? 200 : null, error: result.error ?? null };
}

export async function sendMsTeams(record: IntegrationRecord, ctx: NotificationContext): Promise<DeliveryResult> {
  const config = readConfig(record);

  if (config.mode === 'bot') return sendViaBot(config, ctx);

  // A department may post into its own Teams channel, via its own workflow URL.
  const route = await findTeamRoute(ctx.ticket.teamId, 'msteams');
  const webhookUrl = route?.target || config.webhookUrl;
  if (!webhookUrl) return { ok: false, statusCode: null, error: 'Webhook URL is not configured' };

  try {
    const { status, text } = await postJson(
      webhookUrl,
      // A department's own URL picks its format from the URL: the global setting describes the default webhook.
      await buildPayload({ ...config, webhookUrl, format: route?.target ? 'auto' : config.format }, ctx),
    );
    return {
      ok: isSuccess(status, text),
      statusCode: status,
      error: isSuccess(status, text) ? null : text.slice(0, 300),
    };
  } catch (error) {
    return { ok: false, statusCode: null, error: error instanceof Error ? error.message : String(error) };
  }
}
