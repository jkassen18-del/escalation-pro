import { findTeamRoute } from '../repositories/team-routing.ts';
import { loadIntegration } from './store.ts';
import { postJson, type DeliveryResult } from './types.ts';
import type { MsTeamsConfig } from './msteams.ts';
import type { SlackConfig } from './slack.ts';

/**
 * Posts a message that is not about one ticket - a shift handover, a flow's
 * "post to channel" step - into a department's own Slack and Teams channels,
 * resolved the same way ticket notifications are: the department's route,
 * else the "everything else" destination.
 */

export async function postToDepartmentSlack(teamId: string | null, message: { text: string; blocks?: unknown[] }): Promise<DeliveryResult> {
  return combine(await Promise.all([postToOrgSlack(teamId, message), ...(await ownChannels(teamId, 'slack_webhook')).map((url) => postWebhook(url, message, [200]))]));
}

/** `card` is an Adaptive Card's content (type: 'AdaptiveCard'). */
export async function postToDepartmentTeams(teamId: string | null, card: Record<string, unknown>): Promise<DeliveryResult> {
  const wrapped = { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] };
  return combine(await Promise.all([postToOrgTeams(teamId, card), ...(await ownChannels(teamId, 'teams_webhook')).map((url) => postWebhook(url, wrapped, [200, 202]))]));
}

/** The department's own channels, from its Connections. */
async function ownChannels(teamId: string | null, kind: 'slack_webhook' | 'teams_webhook'): Promise<string[]> {
  const { departmentConnections } = await import('../ops/connections.ts');
  return (await departmentConnections(teamId, [kind]).catch(() => [])).map((connection) => (connection.config as { url: string }).url).filter(Boolean);
}

async function postWebhook(url: string, body: unknown, okStatuses: number[]): Promise<DeliveryResult> {
  try {
    const { status, text } = await postJson(url, body);
    const ok = okStatuses.includes(status);
    return { ok, statusCode: status, error: ok ? null : text.slice(0, 200) };
  } catch (error) {
    return { ok: false, statusCode: null, error: (error as Error).message };
  }
}

/** Delivered if it reached any of the department's channels; otherwise every reason it did not. */
function combine(results: DeliveryResult[]): DeliveryResult {
  const delivered = results.find((result) => result.ok);
  if (delivered) return delivered;
  // "Not connected" from the organisation-wide side is noise when the department's own channel failed for a real reason.
  const reasons = results.map((result) => result.error).filter(Boolean);
  return { ok: false, statusCode: results.at(-1)?.statusCode ?? null, error: reasons.join('; ') || 'Nowhere to post' };
}

async function postToOrgSlack(teamId: string | null, message: { text: string; blocks?: unknown[] }): Promise<DeliveryResult> {
  const record = await loadIntegration('slack');
  if (!record.enabled) return { ok: false, statusCode: null, error: 'Slack is not connected' };
  const config = record.config as SlackConfig;
  const route = await findTeamRoute(teamId, 'slack');
  try {
    if (config.mode === 'bot' && config.botToken) {
      const channel = route?.target || config.channel;
      if (!channel) return { ok: false, statusCode: null, error: 'No Slack channel for this department' };
      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, ...message, ...(route?.mention ? { text: `${route.mention} ${message.text}` } : {}) }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json()) as { ok: boolean; error?: string };
      return { ok: body.ok, statusCode: response.status, error: body.ok ? null : (body.error ?? 'Slack refused the message') };
    }
    if (!config.webhookUrl) return { ok: false, statusCode: null, error: 'Slack has no webhook or bot token' };
    const { status, text } = await postJson(config.webhookUrl, message);
    return { ok: status === 200, statusCode: status, error: status === 200 ? null : text.slice(0, 200) };
  } catch (error) {
    return { ok: false, statusCode: null, error: (error as Error).message };
  }
}

async function postToOrgTeams(teamId: string | null, card: Record<string, unknown>): Promise<DeliveryResult> {
  const record = await loadIntegration('msteams');
  if (!record.enabled) return { ok: false, statusCode: null, error: 'Microsoft Teams is not connected' };
  const config = record.config as MsTeamsConfig;
  const route = await findTeamRoute(teamId, 'msteams');
  try {
    if (config.mode === 'bot') {
      const { findConversation, defaultConversation } = await import('../repositories/teams-conversations.ts');
      const { sendActivity } = await import('./teams-bot.ts');
      const target =
        (route?.target ? await findConversation(route.target) : null) ??
        (config.defaultConversationId && config.defaultConversationId !== 'none' ? await findConversation(config.defaultConversationId) : null) ??
        (config.defaultConversationId === 'none' ? null : await defaultConversation());
      if (!target) return { ok: false, statusCode: null, error: 'No Teams channel for this department' };
      const sent = await sendActivity(
        config,
        { serviceUrl: target.serviceUrl, conversationId: target.conversationId },
        { attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] },
      );
      return { ok: sent.ok, statusCode: sent.ok ? 200 : null, error: sent.error ?? null };
    }
    const url = route?.target || config.webhookUrl;
    if (!url) return { ok: false, statusCode: null, error: 'No Teams webhook for this department' };
    const { status, text } = await postJson(url, {
      type: 'message',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }],
    });
    const ok = status === 200 || status === 202;
    return { ok, statusCode: status, error: ok ? null : text.slice(0, 200) };
  } catch (error) {
    return { ok: false, statusCode: null, error: (error as Error).message };
  }
}
