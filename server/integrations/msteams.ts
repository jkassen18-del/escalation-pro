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

function facts(ctx: NotificationContext) {
  return [
    { title: 'Reference', value: ctx.ticket.reference },
    { title: 'Status', value: ctx.ticket.status.replace('_', ' ') },
    { title: 'Priority', value: ctx.ticket.priority },
    { title: 'Team', value: ctx.ticket.teamName ?? 'Unassigned' },
    { title: 'Assignee', value: ctx.ticket.assigneeName ?? 'Unassigned' },
    { title: 'Updated by', value: ctx.actorName },
  ];
}

/**
 * Routing metadata, alongside the card rather than inside it.
 *
 * A Power Automate Switch has to branch on something, and the only place the
 * department appeared was a fact inside the card body - reachable only as
 * body[2].facts[3].value, which silently points at the wrong field the moment
 * a block or a fact is added. These are flat, named, and stable.
 *
 * `teamKey` rather than the display name on purpose: renaming a department in
 * the admin UI would otherwise send its tickets down the default branch of
 * every flow that switched on it.
 */
function routingFields(ctx: NotificationContext, teamKey: string | null) {
  return {
    ticket: {
      reference: ctx.ticket.reference,
      subject: ctx.ticket.subject,
      url: ctx.ticketUrl,
      teamKey,
      teamName: ctx.ticket.teamName ?? null,
      teamId: ctx.ticket.teamId ?? null,
      status: ctx.ticket.status,
      priority: ctx.ticket.priority,
      type: ctx.ticket.type,
      assignee: ctx.ticket.assigneeName ?? null,
      event: ctx.event,
    },
  };
}

function buildAdaptiveCard(ctx: NotificationContext, teamKey: string | null = null) {
  const body: unknown[] = [
    {
      type: 'TextBlock',
      text: ctx.headline,
      weight: 'Bolder',
      size: 'Medium',
      wrap: true,
      color: ctx.ticket.priority === 'urgent' ? 'Attention' : 'Default',
    },
    { type: 'TextBlock', text: ctx.ticket.subject, wrap: true, spacing: 'None' },
    {
      type: 'FactSet',
      facts: facts(ctx).map((fact) => ({ title: fact.title, value: fact.value })),
    },
  ];

  if (ctx.detail) {
    body.push({ type: 'TextBlock', text: ctx.detail.slice(0, 2000), wrap: true, isSubtle: true, spacing: 'Medium' });
  }

  return {
    type: 'message',
    // Ours, not Microsoft's: ignored by the card renderer, available to a
    // flow as triggerBody()?['ticket']?['teamKey'].
    ...routingFields(ctx, teamKey),
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body,
          actions: [{ type: 'Action.OpenUrl', title: 'Open ticket', url: ctx.ticketUrl }],
        },
      },
    ],
  };
}

function buildMessageCard(ctx: NotificationContext) {
  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: `${ctx.ticket.reference}: ${ctx.ticket.subject}`,
    themeColor: (PRIORITY_HEX[ctx.ticket.priority] ?? '#667085').replace('#', ''),
    title: ctx.headline,
    sections: [
      {
        activityTitle: ctx.ticket.subject,
        facts: facts(ctx),
        text: ctx.detail ? ctx.detail.slice(0, 2000) : undefined,
        markdown: true,
      },
    ],
    potentialAction: [
      {
        '@type': 'OpenUri',
        name: 'Open ticket',
        targets: [{ os: 'default', uri: ctx.ticketUrl }],
      },
    ],
  };
}

function buildPayload(config: MsTeamsConfig, ctx: NotificationContext, teamKey: string | null = null) {
  /*
   * Only the adaptive payload carries the routing fields. A legacy Office 365
   * connector validates MessageCard strictly and rejects properties it does
   * not know, and those connectors cannot drive a flow anyway.
   */
  return resolveFormat(config) === 'messagecard' ? buildMessageCard(ctx) : buildAdaptiveCard(ctx, teamKey);
}

/** The department's stable key, which the ticket itself does not carry. */
async function teamKeyFor(ctx: NotificationContext): Promise<string | null> {
  if (!ctx.ticket.teamId) return null;
  try {
    const { findTeamById } = await import('../repositories/teams.ts');
    return (await findTeamById(ctx.ticket.teamId))?.key ?? null;
  } catch {
    // Routing metadata is a convenience; losing it must not lose the message.
    return null;
  }
}

/** Workflows returns 202 with an empty body; legacy connectors return 200 "1". */
function isSuccess(status: number, text: string): boolean {
  if (status === 200) return text.trim() === '1' || text.trim() === '' || text.trim().toLowerCase() === 'ok';
  return status === 202;
}

/**
 * True when a Power Automate URL is missing its signature.
 *
 * A working "when a webhook request is received" URL is signed: it carries
 * sp, sv and a long sig. A URL with only api-version has either been
 * truncated on the way out of Power Automate - the signature is at the end,
 * so a partial copy loses exactly that - or the flow is set to require an
 * OAuth token instead, which an incoming webhook cannot provide.
 */
export function isUnsignedPowerAutomateUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (!/powerplatform\.com$|logic\.azure\.com$/i.test(url.hostname)) return false;
    return !url.searchParams.get('sig');
  } catch {
    return false;
  }
}

/**
 * Turns Microsoft's refusal into something actionable.
 *
 * A raw 401 with a JSON body names a code nobody outside Microsoft knows.
 * The two failures that actually happen here have specific, different fixes,
 * and relaying the body leaves somebody to search for the code themselves.
 */
function explainTeamsFailure(status: number, text: string, webhookUrl: string): string {
  const raw = text.slice(0, 250);

  if (/DirectApiAuthorizationRequired|OAuth authorization scheme is required/i.test(text)) {
    return (
      'Power Automate is refusing this because the flow requires an OAuth token, which an incoming ' +
      'webhook cannot provide. In Power Automate open the flow, edit the "When a Teams webhook request ' +
      'is received" trigger, and set "Who can trigger the flow?" to Anyone. Save it, then copy the URL ' +
      'again - the new one ends with a long "sig=" signature. ' +
      (isUnsignedPowerAutomateUrl(webhookUrl)
        ? 'The URL saved here has no "sig=" at all, which is consistent with that setting. '
        : '') +
      'Alternatively, switch this integration to Bot mode, which authenticates properly and is two-way.'
    );
  }

  if (status === 401 || status === 403) {
    return (
      `Microsoft Teams refused the request (${status}). The webhook URL is usually either expired or ` +
      `incomplete - copy it again from the flow, making sure you take the whole thing including the ` +
      `"sig=" signature at the end. Microsoft said: ${raw}`
    );
  }

  if (status === 404) {
    return `Microsoft Teams could not find that flow (404). It may have been deleted or turned off. ${raw}`;
  }

  return `Microsoft Teams returned ${status}: ${raw}`;
}

export async function testMsTeams(record: IntegrationRecord): Promise<TestResult> {
  const config = readConfig(record);

  if (config.mode === 'bot') return testTeamsBot(config);

  if (!config.webhookUrl) return { ok: false, message: 'A Microsoft Teams webhook URL is required.' };

  const format = resolveFormat(config);
  const sender = await senderName();
  const testContext = {
    headline: `${sender} is connected`,
    detail: `This channel will receive ticket notifications from ${sender}.`,
    actorName: sender,
    ticketUrl: config.webhookUrl.split('?')[0],
    ticket: {
      reference: 'TEST-0',
      subject: 'Connection test',
      status: 'open',
      priority: 'normal',
      teamName: '—',
      assigneeName: '—',
    },
  } as unknown as NotificationContext;

  try {
    const payload = format === 'messagecard' ? buildMessageCard(testContext) : buildAdaptiveCard(testContext);
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
    return { ok: false, message: explainTeamsFailure(status, text, config.webhookUrl) };
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

  const existing = await findTeamsThread(ctx.ticket.id);

  /*
   * A department may post into its own channel. In bot mode the route holds a
   * conversation id rather than a webhook URL, so it has to resolve to a
   * conversation the bot was actually added to - Microsoft refuses a message
   * to any other.
   */
  const route = await findTeamRoute(ctx.ticket.teamId, 'msteams');
  const conversation = existing
    ? { conversationId: existing.conversationId, serviceUrl: existing.serviceUrl }
    : (route?.target ? await findConversation(route.target) : null) ?? (await defaultConversation());

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
    { attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: buildAdaptiveCard(ctx, await teamKeyFor(ctx)).attachments[0].content }] },
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
    const teamKey = await teamKeyFor(ctx);
    const { status, text } = await postJson(webhookUrl, buildPayload({ ...config, webhookUrl }, ctx, teamKey));
    return {
      ok: isSuccess(status, text),
      statusCode: status,
      error: isSuccess(status, text) ? null : text.slice(0, 300),
    };
  } catch (error) {
    return { ok: false, statusCode: null, error: error instanceof Error ? error.message : String(error) };
  }
}
