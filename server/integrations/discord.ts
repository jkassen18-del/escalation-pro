import crypto from 'node:crypto';
import { db } from '../db/index.ts';
import { getSettings } from '../repositories/settings.ts';
import { findTeamRoute } from '../repositories/team-routing.ts';
import { addLink } from '../repositories/tickets.ts';
import { TERMINAL_STATUSES, type Ticket } from '../../shared/types.ts';
import { loadIntegration, type IntegrationRecord } from './store.ts';
import type { DeliveryResult, NotificationContext, TestResult } from './types.ts';
import { PRIORITY_HEX } from './types.ts';

/**
 * Discord: tickets raised with /ticket, a thread per ticket that stays in step
 * with the web, and pages delivered as direct messages.
 *
 * Everything here talks *to* Discord. Nothing listens for Discord: events and
 * button clicks arrive over the Gateway websocket this server opens itself
 * (see discord-gateway.ts), so the integration works from a server with no
 * public address at all.
 */

export const DISCORD_API = 'https://discord.com/api/v10';

export interface DiscordConfig {
  /** The application's ID, from the Developer Portal's General Information page. */
  applicationId?: string;
  botToken?: string;
  /** Default channel for new tickets, for departments without their own. */
  channel?: string;
  /** Optional: register commands here only, for a single-server install. */
  guildId?: string;
}

export function readDiscordConfig(record: IntegrationRecord): DiscordConfig {
  return record.config as DiscordConfig;
}

export function isDiscordConfigured(config: DiscordConfig): boolean {
  return Boolean(config.applicationId && config.botToken);
}

/* ------------------------------- REST client ------------------------------ */

export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'DiscordApiError';
  }
}

/** When each rate-limit bucket (method + route) may be used again. */
const bucketResetAt = new Map<string, number>();

/** "/channels/123/messages/456" -> "/channels/123/messages/:id": Discord buckets by major parameter. */
function bucketKey(method: string, path: string): string {
  const parts = path.split('?')[0].split('/');
  const major = ['channels', 'guilds', 'webhooks'].includes(parts[1] ?? '') ? 2 : -1;
  return `${method} ${parts.map((part, i) => (i !== major && /^\d{15,}$/.test(part) ? ':id' : part)).join('/')}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One REST call. Honours 429s (waiting `retry_after` and trying again, up to
 * three times) and waits out a bucket Discord has said is empty.
 */
export async function discordApi<T = unknown>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  { auth = true }: { auth?: boolean } = {},
): Promise<T> {
  const key = bucketKey(method, path);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wait = (bucketResetAt.get(key) ?? 0) - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 10_000));

    const response = await fetch(`${DISCORD_API}${path}`, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bot ${token}` } : {}),
        'User-Agent': 'DiscordBot (https://github.com/jkassen18-del/escalation-pro, 2.0)',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    const remaining = response.headers.get('x-ratelimit-remaining');
    const resetAfter = Number(response.headers.get('x-ratelimit-reset-after'));
    if (remaining === '0' && Number.isFinite(resetAfter)) bucketResetAt.set(key, Date.now() + resetAfter * 1000);

    if (response.status === 429) {
      const payload = (await response.json().catch(() => ({}))) as { retry_after?: number };
      const retryAfter = Number(payload.retry_after ?? response.headers.get('retry-after') ?? 1);
      await sleep(Math.min(Math.max(retryAfter, 0.1), 30) * 1000);
      continue;
    }
    if (response.status === 204) return undefined as T;

    const payload = (await response.json().catch(() => null)) as (T & { message?: string; code?: number }) | null;
    if (!response.ok) {
      throw new DiscordApiError(response.status, payload?.code ?? null, payload?.message ?? `Discord answered HTTP ${response.status}`);
    }
    return payload as T;
  }
  throw new DiscordApiError(429, null, 'Discord kept rate-limiting this request');
}

/** Interaction replies are authorised by the interaction token in the URL, not the bot token. */
export async function respondToInteraction(interaction: { id: string; token: string }, response: unknown): Promise<void> {
  await discordApi('', 'POST', `/interactions/${interaction.id}/${interaction.token}/callback`, response, { auth: false });
}

export async function editOriginalResponse(applicationId: string, interactionToken: string, body: unknown): Promise<void> {
  await discordApi('', 'PATCH', `/webhooks/${applicationId}/${interactionToken}/messages/@original`, body, { auth: false });
}

/* ------------------------------- Constants -------------------------------- */

/** Gateway intents: servers, their messages and the text of them, and DMs. */
export const GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

/** What the bot needs in a server, as the invite link asks for it. */
const INVITE_PERMISSIONS =
  (1n << 10n) | // View Channels
  (1n << 11n) | // Send Messages
  (1n << 38n) | // Send Messages in Threads
  (1n << 35n) | // Create Public Threads
  (1n << 14n) | // Embed Links
  (1n << 16n) | // Read Message History
  (1n << 31n); // Use Application Commands

export function discordInviteUrl(applicationId: string): string {
  const params = new URLSearchParams({ client_id: applicationId, scope: 'bot applications.commands', permissions: INVITE_PERMISSIONS.toString() });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/** Message flag that shows a reply only to the person who triggered it. */
export const EPHEMERAL = 64;

export const BUTTON = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 } as const;

/** custom_id prefixes for components; ids after the colon. */
export const CUSTOM_IDS = {
  take: 't:take',
  resolve: 't:resolve',
  escalate: 't:esc',
  escalateTo: 't:escto',
  escalateReason: 't:escreason',
  ticketModal: 'ticket:create',
  pageAck: 'p:ack',
  pageEscalate: 'p:esc',
} as const;

/* -------------------------------- Messages -------------------------------- */

const STATUS_LABEL = (status: string) => status.replace('_', ' ');

function colourOf(ticket: Ticket): number {
  const hex = PRIORITY_HEX[ticket.priority] ?? '#667085';
  return Number.parseInt(hex.replace('#', ''), 16);
}

/** A link button needs a full http(s) URL; without one it is left off. */
function linkButton(url: string, label = 'Open ticket') {
  return /^https?:\/\//.test(url) ? [{ type: 2, style: BUTTON.link, label, url }] : [];
}

export function ticketEmbed(ticket: Ticket, ticketUrl: string, headline?: string) {
  return {
    title: `${ticket.reference} · ${ticket.subject}`.slice(0, 256),
    url: /^https?:\/\//.test(ticketUrl) ? ticketUrl : undefined,
    description: (headline ? `**${headline}**\n\n` : '') + (ticket.descriptionFormat === 'text' ? ticket.description.slice(0, 1500) : ''),
    color: colourOf(ticket),
    fields: [
      { name: 'Status', value: STATUS_LABEL(ticket.status), inline: true },
      { name: 'Priority', value: ticket.priority, inline: true },
      { name: 'Department', value: ticket.teamName ?? 'Unassigned', inline: true },
      { name: 'Assignee', value: ticket.assigneeName ?? 'Nobody yet', inline: true },
      ...(ticket.severity ? [{ name: 'Severity', value: ticket.severity.toUpperCase(), inline: true }] : []),
    ],
    footer: { text: `Raised ${ticket.requesterName ? `by ${ticket.requesterName} ` : ''}via ${ticket.source}` },
    timestamp: ticket.createdAt,
  };
}

/** Take / Resolve / Escalate under a ticket, or Open alone once it is finished. */
export function ticketButtons(ticket: Ticket, ticketUrl: string) {
  const open = !TERMINAL_STATUSES.includes(ticket.status);
  const buttons = open
    ? [
        { type: 2, style: BUTTON.primary, label: 'Take', custom_id: `${CUSTOM_IDS.take}:${ticket.id}` },
        { type: 2, style: BUTTON.success, label: 'Resolve', custom_id: `${CUSTOM_IDS.resolve}:${ticket.id}` },
        { type: 2, style: BUTTON.secondary, label: 'Escalate', custom_id: `${CUSTOM_IDS.escalate}:${ticket.id}` },
        ...linkButton(ticketUrl),
      ]
    : linkButton(ticketUrl);
  return buttons.length ? [{ type: 1, components: buttons }] : [];
}

/* ----------------------------- Ticket threads ----------------------------- */

interface DiscordMessage {
  id: string;
  channel_id: string;
}
interface DiscordChannel {
  id: string;
  guild_id?: string;
  name?: string;
  type?: number;
}

export async function findTicketByDiscordThread(threadId: string): Promise<string | null> {
  const row = await db.get<{ ticket_id: string }>(`SELECT ticket_id FROM ticket_links WHERE provider = 'discord' AND external_id = ?`, [threadId]);
  return row?.ticket_id ?? null;
}

async function threadOf(ticketId: string): Promise<string | null> {
  const row = await db.get<{ external_id: string }>(`SELECT external_id FROM ticket_links WHERE ticket_id = ? AND provider = 'discord'`, [ticketId]);
  return row?.external_id ?? null;
}

/** In-flight thread creations, so the dispatcher and a /ticket reply never start two threads. */
const creating = new Map<string, Promise<string | null>>();

/**
 * The ticket's thread, created on first use: its card goes into the
 * department's channel (or the default one) and a thread starts from it.
 */
export async function ensureTicketThread(record: IntegrationRecord, ticket: Ticket, ticketUrl: string): Promise<string | null> {
  // Claimed before the first await: two callers checking the database at the
  // same moment would both find no thread and both start one.
  const pending = creating.get(ticket.id);
  if (pending) return pending;

  const work = (async () => {
    const existing = await threadOf(ticket.id);
    if (existing) return existing;
    const config = readDiscordConfig(record);
    const route = await findTeamRoute(ticket.teamId, 'discord');
    const channel = route?.target || config.channel;
    if (!channel || !config.botToken) return null;

    const message = await discordApi<DiscordMessage>(config.botToken, 'POST', `/channels/${channel}/messages`, {
      embeds: [ticketEmbed(ticket, ticketUrl, 'New ticket')],
      components: ticketButtons(ticket, ticketUrl),
      allowed_mentions: { parse: [] },
    });
    const thread = await discordApi<DiscordChannel>(config.botToken, 'POST', `/channels/${channel}/messages/${message.id}/threads`, {
      name: `${ticket.reference} ${ticket.subject}`.slice(0, 100),
      auto_archive_duration: 10080,
    });
    const url = thread.guild_id ? `https://discord.com/channels/${thread.guild_id}/${thread.id}` : `https://discord.com/channels/@me/${thread.id}`;
    await addLink(ticket.id, 'discord', thread.id, channel, url);
    return thread.id;
  })();
  creating.set(ticket.id, work);
  try {
    return await work;
  } finally {
    creating.delete(ticket.id);
  }
}

/**
 * The dispatcher's sender. A new ticket gets its card and thread; anything
 * after that is a short message in the thread, so the history stays together.
 */
export async function sendDiscord(record: IntegrationRecord, ctx: NotificationContext): Promise<DeliveryResult> {
  const config = readDiscordConfig(record);
  if (!config.botToken) return { ok: false, statusCode: null, error: 'No bot token configured' };
  try {
    const thread = await ensureTicketThread(record, ctx.ticket, ctx.ticketUrl);
    if (!thread) return { ok: false, statusCode: null, error: 'No Discord channel for this department and no default channel' };
    if (ctx.event === 'ticketCreated') return { ok: true, statusCode: 200, error: null };

    const body = ctx.event === 'ticketCommented'
      ? { content: `**${ctx.actorName}:** ${(ctx.detail ?? '').slice(0, 1800)}` }
      : {
          embeds: [
            {
              title: ctx.headline.slice(0, 256),
              description: (ctx.detail ?? '').slice(0, 2000) || undefined,
              color: colourOf(ctx.ticket),
              footer: { text: `${ctx.ticket.reference} · ${ctx.actorName}` },
            },
          ],
          components: ticketButtons(ctx.ticket, ctx.ticketUrl),
        };
    await discordApi(config.botToken, 'POST', `/channels/${thread}/messages`, { ...body, allowed_mentions: { parse: [] } });
    return { ok: true, statusCode: 200, error: null };
  } catch (error) {
    const status = error instanceof DiscordApiError ? error.status : null;
    return { ok: false, statusCode: status, error: (error as Error).message };
  }
}

/* --------------------------------- Testing -------------------------------- */

const MESSAGE_CONTENT_INTENT_FLAGS = (1 << 18) | (1 << 19);

export async function testDiscord(record: IntegrationRecord): Promise<TestResult> {
  const config = readDiscordConfig(record);
  if (!config.botToken || !config.applicationId) return { ok: false, message: 'Enter the Application ID and bot token, then save.' };
  try {
    const me = await discordApi<{ id: string; username: string }>(config.botToken, 'GET', '/users/@me');
    const app = await discordApi<{ id: string; flags?: number }>(config.botToken, 'GET', '/applications/@me');
    if (app.id !== config.applicationId) {
      return { ok: false, message: `That token belongs to application ${app.id}, not ${config.applicationId}. Check the Application ID.` };
    }
    const guilds = await discordApi<Array<{ id: string; name: string }>>(config.botToken, 'GET', '/users/@me/guilds');
    const problems: string[] = [];
    if (!((app.flags ?? 0) & MESSAGE_CONTENT_INTENT_FLAGS)) {
      problems.push('Turn on "Message Content Intent" under Bot → Privileged Gateway Intents, or replies in ticket threads cannot be read.');
    }
    if (!guilds.length) problems.push('The bot is not in any server yet. Use "Add to server" first.');
    if (config.channel && guilds.length) {
      await discordApi(config.botToken, 'POST', `/channels/${config.channel}/messages`, {
        content: `${me.username} is connected to ${(await getSettings()).organizationName}. New tickets will appear here.`,
        allowed_mentions: { parse: [] },
      });
    } else if (!config.channel) {
      problems.push('Pick a default channel for new tickets.');
    }
    const servers = guilds.map((guild) => guild.name).join(', ');
    if (problems.length) return { ok: false, message: problems.join(' '), details: { bot: me.username, servers: guilds } };
    return { ok: true, message: `Connected as ${me.username} in ${servers}. A test message was posted in the default channel.`, details: { bot: me.username, servers: guilds } };
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 401) return { ok: false, message: 'Discord rejected the bot token. Reset it in the Developer Portal and paste the new one.' };
    if (error instanceof DiscordApiError && error.status === 403) {
      return { ok: false, message: 'The bot cannot post in that channel. Give it View Channel and Send Messages there, or pick another channel.' };
    }
    if (error instanceof DiscordApiError && error.status === 404) return { ok: false, message: 'That channel does not exist, or the bot cannot see it.' };
    return { ok: false, message: (error as Error).message };
  }
}

/** Text and announcement channels in every server the bot is in, for the channel pickers. */
export async function listDiscordChannels(token: string): Promise<Array<{ id: string; name: string; guildId: string; guildName: string }>> {
  const guilds = await discordApi<Array<{ id: string; name: string }>>(token, 'GET', '/users/@me/guilds');
  const out: Array<{ id: string; name: string; guildId: string; guildName: string }> = [];
  for (const guild of guilds.slice(0, 20)) {
    const channels = await discordApi<Array<DiscordChannel & { position?: number }>>(token, 'GET', `/guilds/${guild.id}/channels`);
    for (const channel of channels.filter((c) => c.type === 0 || c.type === 5).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
      out.push({ id: channel.id, name: channel.name ?? channel.id, guildId: guild.id, guildName: guild.name });
    }
  }
  return out;
}

/* ----------------------------- Account linking ---------------------------- */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_MS = 10 * 60_000;

/** A short code someone types into their profile to prove they own this Discord account. */
export async function createLinkCode(discordUserId: string, discordUsername: string): Promise<string> {
  const bytes = crypto.randomBytes(8);
  const raw = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  const now = Date.now();
  await db.run(`DELETE FROM discord_link_codes WHERE expires_at < ? OR discord_user_id = ?`, [new Date(now).toISOString(), discordUserId]);
  await db.run(`INSERT INTO discord_link_codes (code, discord_user_id, discord_username, expires_at) VALUES (?, ?, ?, ?)`, [
    code,
    discordUserId,
    discordUsername.slice(0, 100),
    new Date(now + CODE_TTL_MS).toISOString(),
  ]);
  return code;
}

/**
 * Links the signed-in person to the Discord account that asked for the code.
 * A Discord account belongs to one person here: linking it moves it.
 */
export async function redeemLinkCode(userId: string, code: string): Promise<{ discordUsername: string } | null> {
  const normalised = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalised.length !== 8) return null;
  const formatted = `${normalised.slice(0, 4)}-${normalised.slice(4)}`;
  const row = await db.get<{ discord_user_id: string; discord_username: string; expires_at: string }>(
    `SELECT discord_user_id, discord_username, expires_at FROM discord_link_codes WHERE code = ?`,
    [formatted],
  );
  if (!row || row.expires_at < new Date().toISOString()) return null;
  await db.transaction(async () => {
    await db.run(`DELETE FROM discord_link_codes WHERE code = ?`, [formatted]);
    await db.run(`UPDATE users SET discord_user_id = NULL, discord_username = NULL WHERE discord_user_id = ?`, [row.discord_user_id]);
    await db.run(`UPDATE users SET discord_user_id = ?, discord_username = ?, updated_at = ? WHERE id = ?`, [
      row.discord_user_id,
      row.discord_username,
      new Date().toISOString(),
      userId,
    ]);
  });
  return { discordUsername: row.discord_username };
}

export async function unlinkDiscord(where: { userId?: string; discordUserId?: string }): Promise<boolean> {
  const row = where.userId
    ? await db.get<{ id: string }>(`SELECT id FROM users WHERE id = ? AND discord_user_id IS NOT NULL`, [where.userId])
    : await db.get<{ id: string }>(`SELECT id FROM users WHERE discord_user_id = ?`, [where.discordUserId ?? '']);
  if (!row) return false;
  await db.run(`UPDATE users SET discord_user_id = NULL, discord_username = NULL, updated_at = ? WHERE id = ?`, [new Date().toISOString(), row.id]);
  return true;
}

export async function userIdForDiscord(discordUserId: string): Promise<string | null> {
  const row = await db.get<{ id: string }>(`SELECT id FROM users WHERE discord_user_id = ?`, [discordUserId]);
  return row?.id ?? null;
}

/* ---------------------------------- Pages --------------------------------- */

/**
 * A page as a direct message, with Acknowledge and Escalate buttons that come
 * back over the Gateway. Discord only lets a bot DM someone it shares a
 * server with, and who has not turned off DMs from that server.
 */
export async function sendDiscordPage(
  userId: string,
  page: { pageId: string | null; title: string; body: string; ticketUrl: string },
): Promise<{ status: 'sent' | 'failed' | 'skipped'; provider: string; detail: string; externalId?: string }> {
  const record = await loadIntegration('discord');
  const config = readDiscordConfig(record);
  if (!record.enabled || !config.botToken) return { status: 'skipped', provider: 'discord', detail: 'Discord is not set up under Integrations' };
  const row = await db.get<{ discord_user_id: string | null }>(`SELECT discord_user_id FROM users WHERE id = ?`, [userId]);
  if (!row?.discord_user_id) return { status: 'failed', provider: 'discord', detail: 'No Discord account linked on this profile (use /link in Discord)' };
  try {
    const dm = await discordApi<DiscordChannel>(config.botToken, 'POST', '/users/@me/channels', { recipient_id: row.discord_user_id });
    const components = page.pageId
      ? [
          {
            type: 1,
            components: [
              { type: 2, style: BUTTON.danger, label: 'Acknowledge', custom_id: `${CUSTOM_IDS.pageAck}:${page.pageId}` },
              { type: 2, style: BUTTON.secondary, label: 'Escalate now', custom_id: `${CUSTOM_IDS.pageEscalate}:${page.pageId}` },
              ...linkButton(page.ticketUrl, 'Open incident'),
            ],
          },
        ]
      : [];
    const message = await discordApi<DiscordMessage>(config.botToken, 'POST', `/channels/${dm.id}/messages`, {
      content: page.pageId ? '🚨 **You are being paged**' : undefined,
      embeds: [{ title: page.title.slice(0, 256), description: page.body.slice(0, 2000), color: 0xb42318 }],
      components,
    });
    return { status: 'sent', provider: 'discord', detail: 'Sent as a Discord direct message', externalId: message.id };
  } catch (error) {
    const detail =
      error instanceof DiscordApiError && error.code === 50007
        ? 'Discord would not deliver the DM: the person must share a server with the bot and allow DMs from its members'
        : (error as Error).message;
    return { status: 'failed', provider: 'discord', detail };
  }
}
