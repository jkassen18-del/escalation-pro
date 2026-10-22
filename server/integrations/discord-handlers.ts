import fs from 'node:fs';
import path from 'node:path';
import { config as appConfig, paths } from '../config.ts';
import { db } from '../db/index.ts';
import { recordAudit } from '../lib/audit.ts';
import { DATABASE_STORE_MAX_BYTES, putAttachment, storeMode } from '../lib/attachment-store.ts';
import { randomId } from '../lib/crypto.ts';
import { HttpError } from '../lib/http.ts';
import { notifyUsers } from '../lib/notifications.ts';
import { can } from '../middleware/auth.ts';
import { listTeamFields } from '../repositories/form-fields.ts';
import { getSettings } from '../repositories/settings.ts';
import { listTeams } from '../repositories/teams.ts';
import { asFormFields, canUseTemplate, findTemplate, listTemplates, renderSubject } from '../repositories/ticket-templates.ts';
import { addLink, addWatcher, findTicket, recordEvent } from '../repositories/tickets.ts';
import { findUserById } from '../repositories/users.ts';
import { createTicket, escalateTicketToTeam } from '../services/tickets.ts';
import { acknowledgePage, escalateNow } from '../ops/pager.ts';
import { TERMINAL_STATUSES, TICKET_PRIORITIES, type Permission, type PublicUser, type TeamFormField, type Ticket, type TicketPriority } from '../../shared/types.ts';
import { buildTicketUrl, dispatch } from './dispatcher.ts';
import {
  BUTTON,
  createLinkCode,
  CUSTOM_IDS,
  discordApi,
  editOriginalResponse,
  ensureTicketThread,
  EPHEMERAL,
  findTicketByDiscordThread,
  readDiscordConfig,
  respondToInteraction,
  unlinkDiscord,
  userIdForDiscord,
  type DiscordConfig,
} from './discord.ts';
import type { DiscordGateway } from './discord-gateway.ts';
import { applyStatus } from './slack-actions.ts';
import { loadIntegration } from './store.ts';

/**
 * What InfraTicket does with Discord events: slash commands, buttons, modal
 * submissions and replies in ticket threads.
 *
 * Discord proves nothing about who someone is here. Every action is tied
 * back to an account through the link made with /link, and that account's
 * permissions are checked on every click - anyone in the server can press a
 * button.
 */

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface Interaction {
  id: string;
  token: string;
  type: number;
  application_id: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user: DiscordUser };
  user?: DiscordUser;
  data?: {
    name?: string;
    custom_id?: string;
    values?: string[];
    options?: Array<{ name: string; value?: string; focused?: boolean }>;
    components?: Array<{ components: Array<{ custom_id: string; value?: string }> }>;
  };
}

export interface DiscordMessageEvent {
  id: string;
  channel_id: string;
  guild_id?: string;
  type: number;
  content: string;
  author: DiscordUser;
  webhook_id?: string;
  attachments?: Array<{ id: string; filename: string; content_type?: string; size: number; url: string }>;
}

const INTERACTION = { command: 2, component: 3, autocomplete: 4, modal: 5 } as const;
const RESPONSE = { message: 4, deferredMessage: 5, deferredUpdate: 6, updateMessage: 7, autocomplete: 8, modal: 9 } as const;

/* ------------------------------ Commands ---------------------------------- */

export const DISCORD_COMMANDS = [
  {
    name: 'ticket',
    description: 'Raise a ticket with a department',
    type: 1,
    contexts: [0, 1],
    options: [
      { type: 3, name: 'department', description: 'Which department should handle it', required: false, autocomplete: true },
      {
        type: 3,
        name: 'priority',
        description: 'How urgent it is',
        required: false,
        choices: TICKET_PRIORITIES.map((priority) => ({ name: priority, value: priority })),
      },
      { type: 3, name: 'template', description: 'Start from a quick ticket, e.g. Site issue', required: false, autocomplete: true },
    ],
  },
  { name: 'link', description: 'Link your Discord account to InfraTicket', type: 1, contexts: [0, 1] },
  { name: 'unlink', description: 'Unlink your Discord account from InfraTicket', type: 1, contexts: [0, 1] },
];

const registered = new Set<string>();

/** Per-server commands appear instantly, unlike global ones; registered once per server per connection. */
export async function registerCommands(config: DiscordConfig, guildIds: string[]): Promise<void> {
  if (!config.botToken || !config.applicationId) return;
  const targets = config.guildId ? [config.guildId] : guildIds;
  for (const guildId of targets) {
    const key = `${config.applicationId}:${guildId}`;
    if (registered.has(key)) continue;
    try {
      await discordApi(config.botToken, 'PUT', `/applications/${config.applicationId}/guilds/${guildId}/commands`, DISCORD_COMMANDS);
      registered.add(key);
    } catch (error) {
      console.warn(`[discord] could not register commands in server ${guildId}: ${(error as Error).message}`);
    }
  }
}

/* ------------------------------- Helpers ---------------------------------- */

function personOf(interaction: Interaction): DiscordUser {
  return (interaction.member?.user ?? interaction.user)!;
}

const reply = (interaction: Interaction, content: string, extra: Record<string, unknown> = {}) =>
  respondToInteraction(interaction, { type: RESPONSE.message, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] }, ...extra } });

type Actor = { ok: true; user: PublicUser } | { ok: false; message: string };

async function actorFor(discordUserId: string, permission?: Permission): Promise<Actor> {
  const userId = await userIdForDiscord(discordUserId);
  if (!userId) {
    return { ok: false, message: 'Your Discord account is not linked to InfraTicket yet. Type `/link` to connect it, then try again.' };
  }
  const user = await findUserById(userId);
  if (!user || user.status !== 'active') return { ok: false, message: 'That InfraTicket account is not active any more.' };
  if (permission && !can(user, permission)) return { ok: false, message: 'Your InfraTicket account does not have permission to do that.' };
  return { ok: true, user };
}

function canSee(user: PublicUser, ticket: Ticket): boolean {
  if (can(user, 'tickets.view_all')) return true;
  if (ticket.assigneeId === user.id || ticket.requesterId === user.id || ticket.createdById === user.id) return true;
  return Boolean(ticket.teamId && user.teamIds.includes(ticket.teamId));
}

async function appUrl(): Promise<string> {
  const settings = await getSettings();
  return (settings.appUrl || process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
}

function linkRow(url: string, label: string) {
  return /^https?:\/\//.test(url) ? [{ type: 1, components: [{ type: 2, style: BUTTON.link, label, url }] }] : [];
}

/** Questions Discord's modal can ask: one line or a paragraph of text. */
const TEXT_TYPES = new Set(['text', 'textarea', 'number', 'email', 'url']);
const MAX_MODAL_QUESTIONS = 3;

/**
 * The questions a ticket must answer, and whether a Discord modal can ask
 * them. A modal holds five text inputs: subject, details, and up to three of
 * these. Anything else - a choice, a date, a lookup - belongs on the web form.
 */
async function questionsFor(teamId: string | null, templateId: string | null): Promise<{ ask: TeamFormField[]; blocked: TeamFormField[] }> {
  const template = templateId ? await findTemplate(templateId) : null;
  const fromTemplate = template ? asFormFields(template) : [];
  const fromTeam = teamId ? (await listTeamFields(teamId)).filter((field) => !fromTemplate.some((t) => t.key === field.key)) : [];
  const required = [...fromTemplate, ...fromTeam].filter((field) => field.required);
  const askable = required.filter((field) => TEXT_TYPES.has(field.type));
  return { ask: askable.slice(0, MAX_MODAL_QUESTIONS), blocked: [...required.filter((field) => !TEXT_TYPES.has(field.type)), ...askable.slice(MAX_MODAL_QUESTIONS)] };
}

/* ------------------------------ /ticket flow ------------------------------ */

async function handleTicketCommand(interaction: Interaction): Promise<void> {
  const actor = await actorFor(personOf(interaction).id, 'tickets.create');
  if (!actor.ok) return reply(interaction, actor.message);

  const option = (name: string) => interaction.data?.options?.find((o) => o.name === name)?.value?.trim() || '';
  const teams = await listTeams();
  const templateId = option('template');
  let template = null;
  if (templateId) {
    template = await findTemplate(templateId);
    if (!template || !template.enabled || !canUseTemplate(template, actor.user)) {
      return reply(interaction, 'That quick ticket does not exist or is not available to you. Pick one from the list as you type.');
    }
  }
  const wanted = option('department').toLowerCase();
  const team = template
    ? teams.find((t) => t.id === template!.teamId) ?? null
    : teams.find((t) => t.id === option('department') || t.name.toLowerCase() === wanted || t.key.toLowerCase() === wanted) ?? null;
  if (!template && !team) {
    return reply(interaction, wanted ? `There is no department called "${option('department')}".` : 'Pick a department (or a quick ticket) as you type `/ticket`.');
  }
  const priorityText = option('priority');
  const priority = (TICKET_PRIORITIES as readonly string[]).includes(priorityText) ? priorityText : '';

  const { ask, blocked } = await questionsFor(team?.id ?? null, template?.id ?? null);
  if (blocked.length) {
    const url = `${await appUrl()}${template ? `/tickets/quick/${template.id}` : '/tickets/new'}`;
    return reply(
      interaction,
      `${template ? template.name : team!.name} asks questions Discord cannot show (${blocked.map((f) => f.label).join(', ')}). Raise it on the web form instead.`,
      { components: linkRow(url, 'Open the form') },
    );
  }

  const title = (template ? template.name : `Ticket for ${team!.name}`).slice(0, 45);
  const components = [
    { type: 1, components: [{ type: 4, custom_id: 'subject', label: template ? 'Summary' : 'Subject', style: 1, max_length: 200, required: true, placeholder: (template?.guidance ?? 'What is wrong, in a line').slice(0, 100) }] },
    { type: 1, components: [{ type: 4, custom_id: 'details', label: 'Details', style: 2, max_length: 4000, required: false, placeholder: 'What happened, what you tried, who is affected' }] },
    ...ask.map((field) => ({
      type: 1,
      components: [{ type: 4, custom_id: `f:${field.key}`.slice(0, 100), label: field.label.slice(0, 45), style: field.type === 'textarea' ? 2 : 1, required: true, max_length: 1000, placeholder: (field.placeholder ?? field.helpText ?? '').slice(0, 100) || undefined }],
    })),
  ];
  await respondToInteraction(interaction, {
    type: RESPONSE.modal,
    data: { custom_id: `${CUSTOM_IDS.ticketModal}:${team?.id ?? ''}:${priority}:${template?.id ?? ''}`, title, components },
  });
}

function modalValues(interaction: Interaction): Record<string, string> {
  const values: Record<string, string> = {};
  for (const row of interaction.data?.components ?? []) {
    for (const input of row.components) values[input.custom_id] = input.value ?? '';
  }
  return values;
}

async function handleTicketModal(interaction: Interaction, parts: string[]): Promise<void> {
  const [teamIdRaw, priorityRaw, templateIdRaw] = parts;
  const actor = await actorFor(personOf(interaction).id, 'tickets.create');
  if (!actor.ok) return reply(interaction, actor.message);

  // Creating the ticket and its thread can take longer than Discord's 3 seconds.
  await respondToInteraction(interaction, { type: RESPONSE.deferredMessage, data: { flags: EPHEMERAL } });
  const discord = readDiscordConfig(await loadIntegration('discord'));
  const finish = (content: string, components: unknown[] = []) =>
    editOriginalResponse(interaction.application_id || discord.applicationId || '', interaction.token, { content, components, allowed_mentions: { parse: [] } });

  try {
    const values = modalValues(interaction);
    const answers = Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('f:')).map(([key, value]) => [key.slice(2), value]));
    const subject = (values.subject ?? '').trim();
    if (!subject) return finish('A subject is needed.');
    const details = (values.details ?? '').trim();
    const template = templateIdRaw ? await findTemplate(templateIdRaw) : null;
    if (templateIdRaw && (!template || !canUseTemplate(template, actor.user))) return finish('That quick ticket is no longer available to you.');
    const teamId = template?.teamId ?? (teamIdRaw || null);
    const priority = ((TICKET_PRIORITIES as readonly string[]).includes(priorityRaw) ? priorityRaw : template?.priority) as TicketPriority | undefined;
    const teamQuestions = teamId ? await listTeamFields(teamId) : [];
    const templateFields = template ? asFormFields(template) : [];

    const ticket = await createTicket(
      {
        subject: template ? renderSubject(template, answers, { summary: subject, requester: actor.user.name }) : subject.slice(0, 200),
        description: details,
        descriptionFormat: 'text',
        teamId,
        requesterId: actor.user.id,
        priority,
        type: template?.ticketType ?? 'request',
        severity: template?.severity ?? undefined,
        source: 'discord',
        tags: template?.tags ?? [],
        customFields: Object.fromEntries(Object.entries(answers).filter(([key]) => teamQuestions.some((field) => field.key === key))),
        ...(template ? { templateId: template.id, extraFields: templateFields, extraAnswers: answers } : {}),
      },
      { actor: actor.user },
    );

    await recordAudit({
      actorId: actor.user.id,
      actorName: actor.user.name,
      entityType: 'ticket',
      entityId: ticket.id,
      action: 'ticket_created_from_discord',
      summary: `${actor.user.name} raised ${ticket.reference} from Discord`,
    });

    const ticketUrl = await buildTicketUrl(ticket);
    const thread = await ensureTicketThread(await loadIntegration('discord'), ticket, ticketUrl).catch(() => null);
    await finish(
      `Raised **${ticket.reference}** for ${ticket.teamName ?? 'the service desk'}.${thread ? ` Follow it in <#${thread}>.` : ''}`,
      linkRow(ticketUrl, 'Open ticket'),
    );
  } catch (error) {
    const message = error instanceof HttpError ? error.message : 'The ticket could not be raised. Try the web form.';
    if (!(error instanceof HttpError)) console.error('[discord] /ticket failed', error);
    await finish(message);
  }
}

async function handleAutocomplete(interaction: Interaction): Promise<void> {
  const focused = interaction.data?.options?.find((o) => o.focused);
  const typed = (focused?.value ?? '').toLowerCase();
  let choices: Array<{ name: string; value: string }> = [];
  if (focused?.name === 'department') {
    choices = (await listTeams())
      .filter((team) => !typed || team.name.toLowerCase().includes(typed) || team.key.toLowerCase().includes(typed))
      .map((team) => ({ name: team.name.slice(0, 100), value: team.id }));
  }
  if (focused?.name === 'template') {
    const actor = await actorFor(personOf(interaction).id);
    if (actor.ok) {
      choices = (await listTemplates())
        .filter((t) => t.enabled && canUseTemplate(t, actor.user) && (!typed || t.name.toLowerCase().includes(typed)))
        .map((t) => ({ name: `${t.name}${t.teamName ? ` → ${t.teamName}` : ''}`.slice(0, 100), value: t.id }));
    }
  }
  await respondToInteraction(interaction, { type: RESPONSE.autocomplete, data: { choices: choices.slice(0, 25) } });
}

/* ------------------------------ /link /unlink ----------------------------- */

async function handleLink(interaction: Interaction): Promise<void> {
  const person = personOf(interaction);
  const code = await createLinkCode(person.id, person.global_name || person.username);
  const url = `${await appUrl()}/profile`;
  await reply(
    interaction,
    `Your link code is **${code}**. Open your InfraTicket profile, find **Discord**, and enter it within 10 minutes.\nOnly you can see this message.`,
    { components: linkRow(url, 'Open my profile') },
  );
}

async function handleUnlink(interaction: Interaction): Promise<void> {
  const removed = await unlinkDiscord({ discordUserId: personOf(interaction).id });
  await reply(interaction, removed ? 'Your Discord account is no longer linked to InfraTicket.' : 'Your Discord account was not linked.');
}

/* ------------------------------- Buttons ---------------------------------- */

async function loadTicket(ticketId: string): Promise<Ticket | null> {
  const settings = await getSettings();
  return findTicket(ticketId, settings.ticketPrefix);
}

async function handleTake(interaction: Interaction, ticketId: string): Promise<void> {
  const actor = await actorFor(personOf(interaction).id, 'tickets.assign');
  if (!actor.ok) return reply(interaction, actor.message);
  const ticket = await loadTicket(ticketId);
  if (!ticket || !canSee(actor.user, ticket)) return reply(interaction, 'That ticket does not exist, or you cannot see it.');
  if (TERMINAL_STATUSES.includes(ticket.status)) return reply(interaction, `${ticket.reference} is already ${ticket.status}.`);
  if (ticket.assigneeId === actor.user.id) return reply(interaction, `${ticket.reference} is already yours.`);

  const now = new Date().toISOString();
  await db.run(`UPDATE tickets SET assignee_id = ?, status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END, updated_at = ? WHERE id = ?`, [
    actor.user.id,
    now,
    ticket.id,
  ]);
  await recordEvent(ticket.id, actor.user.id, 'updated', 'assignee', ticket.assigneeName, actor.user.id);
  if (ticket.status === 'open') await recordEvent(ticket.id, actor.user.id, 'updated', 'status', 'open', 'in_progress');
  await addWatcher(ticket.id, actor.user.id);
  await recordAudit({
    actorId: actor.user.id,
    actorName: actor.user.name,
    entityType: 'ticket',
    entityId: ticket.id,
    action: 'ticket_taken_from_discord',
    summary: `${actor.user.name} took ${ticket.reference} from Discord`,
  });
  await reply(interaction, `${ticket.reference} is yours now.`);

  const after = await loadTicket(ticket.id);
  if (after) {
    if (ticket.assigneeId) {
      await notifyUsers([ticket.assigneeId], { ticketId: after.id, type: 'assigned', title: `${actor.user.name} took ${after.reference}`, body: after.subject });
    }
    await dispatch({ event: 'ticketAssigned', ticket: after, actorName: actor.user.name, headline: `${actor.user.name} took ${after.reference}`, ticketUrl: await buildTicketUrl(after) });
  }
}

async function handleResolve(interaction: Interaction, ticketId: string): Promise<void> {
  const actor = await actorFor(personOf(interaction).id, 'tickets.update');
  if (!actor.ok) return reply(interaction, actor.message);
  const ticket = await loadTicket(ticketId);
  if (!ticket || !canSee(actor.user, ticket)) return reply(interaction, 'That ticket does not exist, or you cannot see it.');
  if (TERMINAL_STATUSES.includes(ticket.status)) return reply(interaction, `${ticket.reference} is already ${ticket.status}.`);

  const change = await applyStatus(ticket.id, 'resolved', actor.user.id);
  if (!change?.changed) return reply(interaction, `${ticket.reference} is already resolved.`);
  await recordAudit({
    actorId: actor.user.id,
    actorName: actor.user.name,
    entityType: 'ticket',
    entityId: ticket.id,
    action: 'status_changed_from_discord',
    summary: `${actor.user.name} resolved ${ticket.reference} from Discord`,
    meta: { from: change.from, to: 'resolved' },
  });
  await reply(interaction, `${ticket.reference} is resolved.`);

  const watchers = [ticket.requesterId, ticket.assigneeId, ...ticket.watcherIds].filter((id): id is string => Boolean(id) && id !== actor.user.id);
  await notifyUsers(watchers, { ticketId: ticket.id, type: 'status', title: `${actor.user.name} marked ${ticket.reference} resolved`, body: 'Changed in Discord.' });
  const after = await loadTicket(ticket.id);
  if (after) {
    await dispatch({
      event: 'ticketStatusChanged',
      ticket: after,
      actorName: actor.user.name,
      headline: `${after.reference} moved to resolved`,
      detail: `${change.from.replace('_', ' ')} → resolved (from Discord)`,
      ticketUrl: await buildTicketUrl(after),
    });
  }
}

async function handleEscalateButton(interaction: Interaction, ticketId: string): Promise<void> {
  const actor = await actorFor(personOf(interaction).id, 'tickets.update');
  if (!actor.ok) return reply(interaction, actor.message);
  const ticket = await loadTicket(ticketId);
  if (!ticket || !canSee(actor.user, ticket)) return reply(interaction, 'That ticket does not exist, or you cannot see it.');
  const options = (await listTeams())
    .filter((team) => team.id !== ticket.teamId)
    .slice(0, 25)
    .map((team) => ({ label: team.name.slice(0, 100), value: team.id }));
  if (!options.length) return reply(interaction, 'There is no other department to escalate to.');
  await reply(interaction, `Escalate **${ticket.reference}** to which department?`, {
    components: [{ type: 1, components: [{ type: 3, custom_id: `${CUSTOM_IDS.escalateTo}:${ticket.id}`, placeholder: 'Pick a department', options }] }],
  });
}

async function handleEscalateTo(interaction: Interaction, ticketId: string): Promise<void> {
  const teamId = interaction.data?.values?.[0];
  if (!teamId) return reply(interaction, 'Pick a department.');
  await respondToInteraction(interaction, {
    type: RESPONSE.modal,
    data: {
      custom_id: `${CUSTOM_IDS.escalateReason}:${ticketId}:${teamId}`,
      title: 'Why escalate?',
      components: [{ type: 1, components: [{ type: 4, custom_id: 'reason', label: 'Reason', style: 2, required: true, max_length: 2000, placeholder: 'What the next department needs to know' }] }],
    },
  });
}

async function handleEscalateReason(interaction: Interaction, ticketId: string, teamId: string): Promise<void> {
  const actor = await actorFor(personOf(interaction).id, 'tickets.update');
  if (!actor.ok) return reply(interaction, actor.message);
  const ticket = await loadTicket(ticketId);
  if (!ticket || !canSee(actor.user, ticket)) return reply(interaction, 'That ticket does not exist, or you cannot see it.');
  const reason = (modalValues(interaction).reason ?? '').trim();
  if (!reason) return reply(interaction, 'A reason is needed.');
  try {
    const after = await escalateTicketToTeam(ticket, { targetTeamId: teamId, reason, actor: actor.user });
    await reply(interaction, `${after.reference} is now with ${after.teamName}.`);
  } catch (error) {
    await reply(interaction, error instanceof HttpError ? error.message : 'The escalation failed. Try it on the web.');
  }
}

/* -------------------------------- Pages ----------------------------------- */

async function handlePageButton(interaction: Interaction, action: 'ack' | 'escalate', pageId: string): Promise<void> {
  const actor = await actorFor(personOf(interaction).id);
  if (!actor.ok) return reply(interaction, actor.message);
  if (action === 'ack') {
    const outcome = await acknowledgePage(pageId, actor.user, 'discord');
    const content = outcome === 'closed' ? 'This page is already closed.' : outcome === 'already' ? 'Already acknowledged.' : `✅ Acknowledged by ${actor.user.name}. Escalation stopped.`;
    return respondToInteraction(interaction, { type: RESPONSE.updateMessage, data: { content, components: [] } });
  }
  const escalated = await escalateNow(pageId, actor.user.name);
  await respondToInteraction(interaction, {
    type: RESPONSE.updateMessage,
    data: { content: escalated ? `⏭️ ${actor.user.name} escalated to the next level.` : 'This page is not escalating any more.', components: [] },
  });
}

/* ------------------------------ Interactions ------------------------------ */

export async function handleInteraction(interaction: Interaction): Promise<void> {
  try {
    if (interaction.type === INTERACTION.command) {
      if (interaction.data?.name === 'ticket') return await handleTicketCommand(interaction);
      if (interaction.data?.name === 'link') return await handleLink(interaction);
      if (interaction.data?.name === 'unlink') return await handleUnlink(interaction);
      return await reply(interaction, 'That command is not handled here.');
    }
    if (interaction.type === INTERACTION.autocomplete) return await handleAutocomplete(interaction);

    const [scope, verb, ...rest] = (interaction.data?.custom_id ?? '').split(':');
    const prefix = `${scope}:${verb}`;
    if (interaction.type === INTERACTION.modal) {
      if (prefix === CUSTOM_IDS.ticketModal) return await handleTicketModal(interaction, rest);
      if (prefix === CUSTOM_IDS.escalateReason) return await handleEscalateReason(interaction, rest[0], rest[1]);
    }
    if (interaction.type === INTERACTION.component) {
      if (prefix === CUSTOM_IDS.take) return await handleTake(interaction, rest[0]);
      if (prefix === CUSTOM_IDS.resolve) return await handleResolve(interaction, rest[0]);
      if (prefix === CUSTOM_IDS.escalate) return await handleEscalateButton(interaction, rest[0]);
      if (prefix === CUSTOM_IDS.escalateTo) return await handleEscalateTo(interaction, rest[0]);
      if (prefix === CUSTOM_IDS.pageAck) return await handlePageButton(interaction, 'ack', rest[0]);
      if (prefix === CUSTOM_IDS.pageEscalate) return await handlePageButton(interaction, 'escalate', rest[0]);
    }
    await reply(interaction, 'That button is from an older version and no longer does anything.');
  } catch (error) {
    console.error('[discord] interaction failed', error);
    await reply(interaction, 'Something went wrong. Try again, or use the web app.').catch(() => undefined);
  }
}

/* ----------------------------- Thread replies ----------------------------- */

const ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
const DISCORD_CDN = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//;
/** People told once per thread that their replies need a linked account. */
const remindedToLink = new Set<string>();

/** Discord's mention markup as plain text: <@123> becomes @someone. */
function plainText(content: string): string {
  return content
    .replace(/<@!?(\d+)>/g, '@someone')
    .replace(/<#(\d+)>/g, '#channel')
    .replace(/<@&(\d+)>/g, '@role')
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .trim();
}

async function saveAttachments(ticketId: string, commentId: string, userId: string, message: DiscordMessageEvent): Promise<string[]> {
  const limit = storeMode() === 'database' ? Math.min(appConfig.maxUploadBytes, DATABASE_STORE_MAX_BYTES) : appConfig.maxUploadBytes;
  const skipped: string[] = [];
  for (const file of (message.attachments ?? []).slice(0, 5)) {
    const type = (file.content_type ?? '').split(';')[0];
    if (!ATTACHMENT_TYPES.has(type) || file.size > limit || !DISCORD_CDN.test(file.url)) {
      skipped.push(file.filename);
      continue;
    }
    try {
      const response = await fetch(file.url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > limit) throw new Error('too large');
      const attachmentId = randomId();
      const storedName = `${attachmentId}${path.extname(file.filename).slice(0, 10) || ''}`;
      if (storeMode() === 'disk') await fs.promises.writeFile(path.join(paths.uploads, storedName), bytes);
      await db.run(
        `INSERT INTO ticket_attachments (id, ticket_id, comment_id, stored_name, original_name, mime_type, size, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [attachmentId, ticketId, commentId, storedName, file.filename.slice(0, 200), type, bytes.length, userId, new Date().toISOString()],
      );
      await putAttachment(attachmentId, storedName, bytes);
      await recordEvent(ticketId, userId, 'attached', 'attachment', null, file.filename);
    } catch (error) {
      console.warn(`[discord] could not copy attachment ${file.filename}: ${(error as Error).message}`);
      skipped.push(file.filename);
    }
  }
  return skipped;
}

/**
 * A message in a ticket's thread becomes a comment on the ticket, when its
 * author has linked their account. The bot's own posts are ignored first and
 * foremost: they are this app's notifications, and reading them back would
 * comment on the ticket that produced them.
 */
export async function handleThreadMessage(message: DiscordMessageEvent, gateway: Pick<DiscordGateway, 'botUserId'> | null): Promise<'comment' | 'ignored' | 'duplicate' | 'unlinked'> {
  if (message.author.bot || message.webhook_id || message.author.id === gateway?.botUserId) return 'ignored';
  if (message.type !== 0 && message.type !== 19) return 'ignored';
  const ticketId = await findTicketByDiscordThread(message.channel_id);
  if (!ticketId) return 'ignored';

  const seen = await db.get<{ id: string }>(`SELECT id FROM ticket_links WHERE provider = 'discord_reply' AND external_id = ?`, [message.id]);
  if (seen) return 'duplicate';

  const record = await loadIntegration('discord');
  const config = readDiscordConfig(record);
  const userId = await userIdForDiscord(message.author.id);
  const user = userId ? await findUserById(userId) : null;
  if (!user || user.status !== 'active') {
    const key = `${message.channel_id}:${message.author.id}`;
    if (!remindedToLink.has(key) && config.botToken) {
      remindedToLink.add(key);
      await discordApi(config.botToken, 'POST', `/channels/${message.channel_id}/messages`, {
        content: 'Replies here reach the ticket once your Discord account is linked. Type `/link` to connect it.',
        message_reference: { message_id: message.id, fail_if_not_exists: false },
        allowed_mentions: { parse: [] },
      }).catch(() => undefined);
    }
    return 'unlinked';
  }

  const ticket = await loadTicket(ticketId);
  if (!ticket) return 'ignored';
  const body = plainText(message.content ?? '');
  if (!body && !(message.attachments ?? []).length) return 'ignored';

  const now = new Date().toISOString();
  const commentId = randomId();
  await db.run(
    `INSERT INTO ticket_comments (id, ticket_id, author_id, body, body_format, is_internal, created_at, updated_at) VALUES (?, ?, ?, ?, 'text', 0, ?, ?)`,
    [commentId, ticket.id, user.id, body || '(attachment)', now, now],
  );
  await addLink(ticket.id, 'discord_reply', message.id, commentId, '');
  await recordEvent(ticket.id, user.id, 'commented', 'source', null, 'discord');
  const skipped = await saveAttachments(ticket.id, commentId, user.id, message);
  await db.run(`UPDATE tickets SET updated_at = ? WHERE id = ?`, [now, ticket.id]);

  if (skipped.length && config.botToken) {
    await discordApi(config.botToken, 'POST', `/channels/${message.channel_id}/messages`, {
      content: `Not copied to the ticket (only images and PDFs within the upload limit are): ${skipped.join(', ')}`.slice(0, 1900),
      message_reference: { message_id: message.id, fail_if_not_exists: false },
      allowed_mentions: { parse: [] },
    }).catch(() => undefined);
  }

  const recipients = [ticket.requesterId, ticket.assigneeId, ...ticket.watcherIds].filter((id): id is string => Boolean(id) && id !== user.id);
  await notifyUsers(recipients, { ticketId: ticket.id, type: 'comment', title: `${user.name} replied to ${ticket.reference} in Discord`, body: body.slice(0, 280) });
  await recordAudit({
    actorId: user.id,
    actorName: user.name,
    entityType: 'ticket',
    entityId: ticket.id,
    action: 'comment_from_discord',
    summary: `${user.name} replied to ${ticket.reference} from Discord`,
  });
  // Out to the other channels, not back into the thread it came from.
  await dispatch(
    { event: 'ticketCommented', ticket, actorName: user.name, headline: `${user.name} replied in Discord`, detail: body, ticketUrl: await buildTicketUrl(ticket) },
    { exclude: ['discord'] },
  );
  return 'comment';
}

/* -------------------------------- Dispatch -------------------------------- */

/** Every Gateway event the integration acts on. */
export async function handleDiscordEvent(event: string, data: unknown, gateway: DiscordGateway): Promise<void> {
  switch (event) {
    case 'READY': {
      const ready = data as { guilds?: Array<{ id: string }> };
      const config = readDiscordConfig(await loadIntegration('discord'));
      await registerCommands(config, (ready.guilds ?? []).map((g) => g.id));
      return;
    }
    case 'GUILD_CREATE': {
      const config = readDiscordConfig(await loadIntegration('discord'));
      await registerCommands(config, [(data as { id: string }).id]);
      return;
    }
    case 'INTERACTION_CREATE':
      await handleInteraction(data as Interaction);
      return;
    case 'MESSAGE_CREATE':
      await handleThreadMessage(data as DiscordMessageEvent, gateway);
      return;
  }
}
