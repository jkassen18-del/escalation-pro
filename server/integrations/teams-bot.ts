import { getTeamsAccessToken } from './teams-auth.ts';
import type { MsTeamsConfig } from './msteams.ts';

/**
 * Talking back to Teams.
 *
 * Replies are posted to the `serviceUrl` that sent the activity rather than a
 * fixed host: it differs per tenant and per sovereign cloud, and hard-coding
 * the commercial one is how an integration works everywhere except the
 * customer who needed it.
 */

export interface TeamsActivity {
  type?: string;
  id?: string;
  text?: string;
  value?: Record<string, unknown>;
  serviceUrl?: string;
  replyToId?: string;
  channelData?: {
    tenant?: { id?: string };
    team?: { id?: string; name?: string };
    channel?: { id?: string; name?: string };
  };
  conversation?: { id?: string; conversationType?: string; name?: string };
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string };
  membersAdded?: Array<{ id?: string }>;
}

export interface SendResult {
  ok: boolean;
  /** The posted activity's id, which later replies thread onto. */
  activityId?: string;
  error?: string;
}

/**
 * Posts an activity into a conversation.
 *
 * `replyToId` is what makes a message a reply in a Teams channel rather than
 * a new thread - the same role Slack's `thread_ts` plays, so a ticket's
 * updates stay together instead of scattering down the channel.
 */
export async function sendActivity(
  config: MsTeamsConfig,
  target: { serviceUrl: string; conversationId: string; replyToId?: string | null },
  activity: Record<string, unknown>,
): Promise<SendResult> {
  if (!config.appId || !config.appPassword) {
    return { ok: false, error: 'The Teams bot has no app id or password configured' };
  }

  let token: string;
  try {
    token = await getTeamsAccessToken(config.appId, config.appPassword);
  } catch (error) {
    return { ok: false, error: `Microsoft refused the bot credentials: ${(error as Error).message}` };
  }

  const base = target.serviceUrl.replace(/\/+$/, '');
  const url = `${base}/v3/conversations/${encodeURIComponent(target.conversationId)}/activities${
    target.replyToId ? `/${encodeURIComponent(target.replyToId)}` : ''
  }`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'message', ...activity }),
    });

    const text = await response.text();
    if (!response.ok) {
      return { ok: false, error: `Teams returned ${response.status}: ${text.slice(0, 300)}` };
    }

    let activityId: string | undefined;
    try {
      activityId = (JSON.parse(text) as { id?: string }).id;
    } catch {
      // A 200 with no body still means it was delivered.
    }
    return { ok: true, activityId };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * The text of a message with the bot's own @mention taken out.
 *
 * Teams includes the mention in `text`, so `@InfraTicket finance` arrives as
 * "<at>InfraTicket</at> finance" and the department would never match.
 */
export function stripMention(text: string | undefined, botName?: string): string {
  let out = (text ?? '').replace(/<at>[\s\S]*?<\/at>/gi, ' ');
  if (botName) {
    out = out.replace(new RegExp(`^\\s*@?${botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), ' ');
  }
  return out.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * True when the activity is a person talking, not the bot hearing itself.
 *
 * A bot's own posts come back as activities, and treating one as a reply
 * would have it comment on the ticket that produced it - the same loop the
 * Slack integration has to avoid.
 */
export function isFromPerson(activity: TeamsActivity): boolean {
  if (activity.type !== 'message') return false;
  if (!activity.from?.id) return false;
  // Teams gives bots ids of the form "28:<app id>"; people are "29:...".
  return !activity.from.id.startsWith('28:');
}
