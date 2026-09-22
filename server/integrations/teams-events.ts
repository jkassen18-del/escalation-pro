import { db } from '../db/index.ts';
import { can } from '../middleware/auth.ts';
import { findUserById } from '../repositories/users.ts';
import { getTeamsAccessToken } from './teams-auth.ts';
import type { TeamsActivity } from './teams-bot.ts';
import type { MsTeamsConfig } from './msteams.ts';
import type { Permission, PublicUser } from '../../shared/types.ts';

/**
 * Working out who sent an activity, and whether they may do what they asked.
 *
 * Teams identifies people by an opaque id, so the roster is asked for their
 * email and that is matched against a user here. This is the whole of the
 * authorisation for anything done from Teams: a card submission is an HTTP
 * request that names its own sender, and the signed token proves only that
 * Microsoft relayed it, not that the sender is allowed to raise or close
 * anything.
 */

export interface TeamsAuthor {
  userId: string | null;
  displayName: string;
}

/**
 * The sender's email, via the Teams roster.
 *
 * `from.aadObjectId` is a directory id, not an address, so the conversation
 * member has to be fetched. Needs the bot to be installed in the team, which
 * it is by definition if it received the activity.
 */
export async function resolveTeamsAuthor(
  config: MsTeamsConfig,
  activity: TeamsActivity,
  options: { includeSuspended?: boolean } = {},
): Promise<TeamsAuthor> {
  const displayName = activity.from?.name || 'Someone in Teams';
  const userId = activity.from?.id;
  const conversationId = activity.conversation?.id;
  const serviceUrl = activity.serviceUrl;

  if (!userId || !conversationId || !serviceUrl || !config.appId || !config.appPassword) {
    return { userId: null, displayName };
  }

  try {
    const token = await getTeamsAccessToken(config.appId, config.appPassword);
    const base = serviceUrl.replace(/\/+$/, '');
    const response = await fetch(
      `${base}/v3/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) return { userId: null, displayName };

    const member = (await response.json()) as {
      email?: string;
      userPrincipalName?: string;
      name?: string;
    };

    const email = (member.email || member.userPrincipalName || '').trim().toLowerCase();
    if (!email) return { userId: null, displayName: member.name || displayName };

    const row = await db.get<{ id: string; name: string }>(
      options.includeSuspended
        ? `SELECT id, name FROM users WHERE LOWER(email) = ?`
        : `SELECT id, name FROM users WHERE LOWER(email) = ? AND status = 'active'`,
      [email],
    );
    return row ? { userId: row.id, displayName: row.name } : { userId: null, displayName: member.name || displayName };
  } catch {
    // The roster call needs the bot to still be installed. Losing the
    // attribution is better than losing the message.
    return { userId: null, displayName };
  }
}

export type TeamsActorResult = { ok: true; user: PublicUser } | { ok: false; message: string };

export async function resolveTeamsActor(
  config: MsTeamsConfig,
  activity: TeamsActivity,
  permission: Permission,
): Promise<TeamsActorResult> {
  const author = await resolveTeamsAuthor(config, activity, { includeSuspended: true });

  if (!author.userId) {
    return {
      ok: false,
      message:
        'Your Teams account is not linked to a user here, so nothing was done. ' +
        'Ask an administrator to add you with the same email address as your Teams profile.',
    };
  }

  const user = await findUserById(author.userId);
  if (!user || user.status !== 'active') {
    return { ok: false, message: 'That account is no longer active here, so nothing was done.' };
  }
  if (!can(user, permission)) {
    return { ok: false, message: 'You do not have permission to do that.' };
  }

  return { ok: true, user };
}

/** The Teams message that started this ticket's thread, if there is one. */
export async function findTeamsThread(
  ticketId: string,
): Promise<{ conversationId: string; activityId: string; serviceUrl: string } | null> {
  const row = await db.get<{ external_id: string; external_key: string; url: string }>(
    `SELECT external_id, external_key, url FROM ticket_links WHERE provider = 'msteams' AND ticket_id = ?`,
    [ticketId],
  );
  if (!row) return null;
  return { activityId: row.external_id, conversationId: row.external_key, serviceUrl: row.url };
}

/** The ticket whose Teams thread an activity is a reply in. */
export async function findTicketByTeamsThread(rootActivityId: string): Promise<string | null> {
  const row = await db.get<{ ticket_id: string }>(
    `SELECT ticket_id FROM ticket_links WHERE provider = 'msteams' AND external_id = ?`,
    [rootActivityId],
  );
  return row?.ticket_id ?? null;
}

/**
 * Teams message HTML rendered as plain text.
 *
 * Stored as text rather than markup for the same reason Slack replies are:
 * it is written outside this system, and the less of it that is ever
 * interpreted as HTML, the better.
 */
export function teamsTextToPlain(text: string): string {
  return text
    .replace(/<at>[\s\S]*?<\/at>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
