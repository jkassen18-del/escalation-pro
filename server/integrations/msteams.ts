import { postJson, type DeliveryResult, type NotificationContext, type TestResult, PRIORITY_HEX } from './types.ts';
import type { IntegrationRecord } from './store.ts';

export interface MsTeamsConfig {
  /** Workflows (Power Automate) URL, or a legacy Office 365 connector URL. */
  webhookUrl?: string;
  /** `auto` picks the payload shape from the URL host. */
  format?: 'auto' | 'adaptive' | 'messagecard';
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

function buildAdaptiveCard(ctx: NotificationContext) {
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

function buildPayload(config: MsTeamsConfig, ctx: NotificationContext) {
  return resolveFormat(config) === 'messagecard' ? buildMessageCard(ctx) : buildAdaptiveCard(ctx);
}

/** Workflows returns 202 with an empty body; legacy connectors return 200 "1". */
function isSuccess(status: number, text: string): boolean {
  if (status === 200) return text.trim() === '1' || text.trim() === '' || text.trim().toLowerCase() === 'ok';
  return status === 202;
}

export async function testMsTeams(record: IntegrationRecord): Promise<TestResult> {
  const config = readConfig(record);
  if (!config.webhookUrl) return { ok: false, message: 'A Microsoft Teams webhook URL is required.' };

  const format = resolveFormat(config);
  const testContext = {
    headline: 'Escalation Pro is connected',
    detail: 'This channel will receive ticket notifications from Escalation Pro.',
    actorName: 'Escalation Pro',
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
    return { ok: false, message: `Microsoft Teams returned ${status}: ${text.slice(0, 250)}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function sendMsTeams(record: IntegrationRecord, ctx: NotificationContext): Promise<DeliveryResult> {
  const config = readConfig(record);
  if (!config.webhookUrl) return { ok: false, statusCode: null, error: 'Webhook URL is not configured' };

  try {
    const { status, text } = await postJson(config.webhookUrl, buildPayload(config, ctx));
    return {
      ok: isSuccess(status, text),
      statusCode: status,
      error: isSuccess(status, text) ? null : text.slice(0, 300),
    };
  } catch (error) {
    return { ok: false, statusCode: null, error: error instanceof Error ? error.message : String(error) };
  }
}
