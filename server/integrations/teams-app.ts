import crypto from 'node:crypto';
import { randomId } from '../lib/crypto.ts';
import { badRequest, HttpError } from '../lib/http.ts';
import { getOpsSetting, getSettings, setOpsSetting } from '../repositories/settings.ts';
import { listTeams } from '../repositories/teams.ts';
import { listTeamFields } from '../repositories/form-fields.ts';
import { findTicket, listTickets } from '../repositories/tickets.ts';
import { asFormFields, canUseTemplate, findTemplate, listTemplates, renderSubject } from '../repositories/ticket-templates.ts';
import { createTicket } from '../services/tickets.ts';
import { canSeeTicket } from '../services/ticket-actions.ts';
import { buildTicketUrl } from './dispatcher.ts';
import { loadIntegration } from './store.ts';
import { sendActivity, stripMention, type TeamsActivity } from './teams-bot.ts';
import { asAttachment, buildConfirmationCard, buildTicketCard, readCardSubmission, TICKET_CARD_ACTION } from './teams-cards.ts';
import { resolveTeamsActor, teamsTextToPlain } from './teams-events.ts';
import {
  BUILTIN_COMMANDS,
  buildTeamsManifest,
  COMPOSE_COMMANDS,
  pngSize,
  TEAMS_LIMITS,
  validateTeamsPackage,
  type BuiltinCommand,
  type ManifestOptions,
} from './teams-manifest.ts';
import type { MsTeamsConfig } from './msteams.ts';
import type { PublicUser, Team, TeamFormField, Ticket, TicketPriority } from '../../shared/types.ts';
import type { TicketTemplate } from '../../shared/templates.ts';

/**
 * The InfraBot Teams app as something an admin looks after: its name, icon
 * and command menu, the version Teams needs bumped on every update, and the
 * commands and forms the bot answers.
 *
 * Teams installs a zip and only accepts a replacement whose version is
 * higher, so the version here follows the package itself: unchanged since the
 * last download keeps its number, anything that changes the package bumps
 * the patch number once. Nobody has to remember to.
 */

/* --------------------------------- Settings -------------------------------- */

export type CustomCommandAction =
  | { type: 'department'; teamId: string }
  | { type: 'template'; templateId: string }
  | { type: 'reply'; text: string; url?: string | null };

interface StoredCommand {
  id: string;
  kind: 'builtin' | 'department' | 'custom';
  /** The built-in's name, or the department's id. */
  ref?: string;
  title?: string;
  description?: string;
  enabled: boolean;
  action?: CustomCommandAction;
}

/** What the last downloaded package said, so the UI can show what changed since. */
interface PackageSnapshot {
  appId: string;
  appUrl: string;
  name: string;
  shortDescription: string;
  fullDescription: string;
  accentColor: string;
  icon: string;
  calling: boolean;
  commands: string[];
}

interface TeamsAppSettings {
  name: string;
  shortDescription: string;
  fullDescription: string;
  accentColor: string;
  /** Base64 PNG, 192x192. Null uses the generated icon. */
  iconPng: string | null;
  /** Null until an admin edits the menu: the defaults until then. */
  commands: StoredCommand[] | null;
  /** Set when the app was already uploaded at a higher version elsewhere. */
  minimumVersion: string;
  lastDownload: { version: string; fingerprint: string; snapshot: PackageSnapshot; at: string } | null;
}

/*
 * Packages built before versioning all said 1.0.0, and Teams would refuse to
 * update an installed 1.0.0 with another 1.0.0. Starting above it means the
 * first package from here is always accepted as an update.
 */
const FIRST_VERSION = '1.1.0';

const DEFAULTS: TeamsAppSettings = {
  name: '',
  shortDescription: '',
  fullDescription: '',
  accentColor: '',
  iconPng: null,
  commands: null,
  minimumVersion: '',
  lastDownload: null,
};

async function loadAppSettings(): Promise<TeamsAppSettings> {
  return getOpsSetting<TeamsAppSettings>('teams_app', DEFAULTS);
}

/* --------------------------------- Commands -------------------------------- */

export interface TeamsCommand {
  id: string;
  kind: StoredCommand['kind'];
  title: string;
  description: string;
  enabled: boolean;
  builtin?: BuiltinCommand;
  teamId?: string;
  action?: CustomCommandAction;
  /** Within the ten Teams shows in its menu. Commands beyond still work. */
  listed: boolean;
}

/**
 * The command menu: what the admin arranged, with any department created
 * since added at the end and any deleted one dropped, so the menu never
 * offers a department that is gone or hides one that is new.
 */
export function resolveCommands(stored: StoredCommand[] | null, teams: Team[]): TeamsCommand[] {
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const builtinByName = new Map(BUILTIN_COMMANDS.map((command) => [command.name as string, command]));
  const out: TeamsCommand[] = [];
  const seen = new Set<string>();

  const push = (entry: StoredCommand) => {
    if (seen.has(entry.id)) return;
    if (entry.kind === 'builtin') {
      const builtin = builtinByName.get(entry.ref ?? '');
      if (!builtin) return;
      out.push({ id: entry.id, kind: 'builtin', builtin: builtin.name, title: builtin.name, description: entry.description || builtin.description, enabled: entry.enabled, listed: false });
    } else if (entry.kind === 'department') {
      const team = teamById.get(entry.ref ?? '');
      if (!team) return;
      out.push({
        id: entry.id,
        kind: 'department',
        teamId: team.id,
        title: team.key.toLowerCase(),
        description: entry.description || `Raise a ticket on the ${team.name} form`,
        enabled: entry.enabled,
        listed: false,
      });
    } else if (entry.kind === 'custom' && entry.title && entry.action) {
      out.push({ id: entry.id, kind: 'custom', title: entry.title, description: entry.description ?? '', enabled: entry.enabled, action: entry.action, listed: false });
    } else {
      return;
    }
    seen.add(entry.id);
  };

  for (const entry of stored ?? []) push(entry);
  for (const builtin of BUILTIN_COMMANDS) push({ id: `builtin:${builtin.name}`, kind: 'builtin', ref: builtin.name, enabled: true });
  for (const team of teams) push({ id: `team:${team.id}`, kind: 'department', ref: team.id, enabled: true });

  let listed = 0;
  for (const command of out) {
    if (command.enabled && listed < TEAMS_LIMITS.commands) {
      command.listed = true;
      listed += 1;
    }
  }
  return out;
}

const CUSTOM_TITLE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/* ------------------------------ Package state ------------------------------ */

function bumpPatch(version: string): string {
  const [major, minor, patch] = version.split('.').map((part) => Number(part) || 0);
  return `${major}.${minor}.${patch + 1}`;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number(part) || 0);
  const pb = b.split('.').map((part) => Number(part) || 0);
  for (let i = 0; i < 3; i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

interface PackageInputs {
  options: ManifestOptions;
  commands: TeamsCommand[];
  settings: TeamsAppSettings;
  snapshot: PackageSnapshot;
  /** Null when the package cannot be built yet (no app id or URL). */
  fingerprint: string | null;
}

async function packageInputs(): Promise<PackageInputs> {
  const [record, settings, appSettings, teams] = await Promise.all([loadIntegration('msteams'), getSettings(), loadAppSettings(), listTeams()]);
  const config = record.config as MsTeamsConfig;
  const commands = resolveCommands(appSettings.commands, teams);
  const calling = (await (await import('../ops/teams-calls.ts')).teamsCallSettings()).enabled;
  const icon = appSettings.iconPng ? Buffer.from(appSettings.iconPng, 'base64') : undefined;
  const name = appSettings.name.trim() || config.botName?.trim() || 'InfraBot';

  const options: ManifestOptions = {
    appId: config.appId ?? '',
    appUrl: settings.appUrl || process.env.APP_URL || '',
    botName: name,
    organizationName: settings.organizationName,
    teams,
    supportsCalling: calling,
    accentColor: appSettings.accentColor || undefined,
    shortDescription: appSettings.shortDescription || undefined,
    fullDescription: appSettings.fullDescription || undefined,
    commands: commands.filter((command) => command.enabled).map((command) => ({ title: command.title, description: command.description })),
    colorIconPng: icon,
  };

  const snapshot: PackageSnapshot = {
    appId: options.appId,
    appUrl: options.appUrl,
    name,
    shortDescription: appSettings.shortDescription,
    fullDescription: appSettings.fullDescription,
    accentColor: appSettings.accentColor,
    icon: icon ? crypto.createHash('sha256').update(icon).digest('hex').slice(0, 16) : 'generated',
    calling,
    commands: commands.filter((command) => command.listed).map((command) => `${command.title}: ${command.description}`),
  };

  let fingerprint: string | null = null;
  try {
    const manifest = buildTeamsManifest({ ...options, version: '0.0.0' });
    fingerprint = crypto.createHash('sha256').update(JSON.stringify(manifest)).update(snapshot.icon).digest('hex');
  } catch {
    fingerprint = null;
  }
  return { options, commands, settings: appSettings, snapshot, fingerprint };
}

function currentVersion(settings: TeamsAppSettings, fingerprint: string | null): string {
  const last = settings.lastDownload;
  let version = !last ? FIRST_VERSION : fingerprint && fingerprint === last.fingerprint ? last.version : bumpPatch(last.version);
  if (settings.minimumVersion && compareVersions(settings.minimumVersion, version) > 0) version = settings.minimumVersion;
  return version;
}

/** What differs between the last downloaded package and the one a download would give now. */
function describeChanges(before: PackageSnapshot | undefined, after: PackageSnapshot): string[] {
  if (!before) return ['First package: install it as a new app.'];
  const changes: string[] = [];
  if (before.appId !== after.appId) changes.push('The bot (Microsoft app id) changed.');
  if (before.appUrl !== after.appUrl) changes.push(`The app URL changed to ${after.appUrl}.`);
  if (before.name !== after.name) changes.push(`Renamed from "${before.name}" to "${after.name}".`);
  if (before.shortDescription !== after.shortDescription || before.fullDescription !== after.fullDescription) changes.push('The description changed.');
  if (before.accentColor !== after.accentColor) changes.push('The accent colour changed.');
  if (before.icon !== after.icon) changes.push('The icon changed.');
  if (before.calling !== after.calling) changes.push(after.calling ? 'The bot can now place calls.' : 'The bot no longer places calls.');
  const added = after.commands.filter((command) => !before.commands.includes(command));
  const removed = before.commands.filter((command) => !after.commands.includes(command));
  for (const command of added) changes.push(`Menu: added or changed "${command.split(':')[0]}".`);
  for (const command of removed) {
    const title = command.split(':')[0];
    if (!added.some((entry) => entry.split(':')[0] === title)) changes.push(`Menu: removed "${title}".`);
  }
  if (changes.length === 0 && before.commands.join('|') !== after.commands.join('|')) changes.push('The menu was reordered.');
  return changes;
}

export interface TeamsAppState {
  version: string;
  lastDownload: { version: string; at: string } | null;
  /** True when a download now would be an update over the last one. */
  updateAvailable: boolean;
  changes: string[];
  problems: string[];
  settings: { name: string; defaultName: string; shortDescription: string; fullDescription: string; accentColor: string; hasCustomIcon: boolean; minimumVersion: string };
  commands: TeamsCommand[];
  limits: typeof TEAMS_LIMITS;
}

export async function teamsAppState(): Promise<TeamsAppState> {
  const inputs = await packageInputs();
  const { settings, snapshot, fingerprint } = inputs;
  const version = currentVersion(settings, fingerprint);
  const last = settings.lastDownload;
  const record = await loadIntegration('msteams');
  const config = record.config as MsTeamsConfig;
  const problems = validateTeamsPackage({ ...inputs.options, version });
  if (!inputs.options.appUrl) problems.unshift('Set the app URL in Settings first. Teams needs to know where this deployment lives.');

  return {
    version,
    lastDownload: last ? { version: last.version, at: last.at } : null,
    updateAvailable: Boolean(last && version !== last.version),
    changes: last && fingerprint === last.fingerprint ? [] : describeChanges(last?.snapshot, snapshot),
    problems,
    settings: {
      name: settings.name,
      defaultName: config.botName?.trim() || 'InfraBot',
      shortDescription: settings.shortDescription,
      fullDescription: settings.fullDescription,
      accentColor: settings.accentColor,
      hasCustomIcon: Boolean(settings.iconPng),
      minimumVersion: settings.minimumVersion,
    },
    commands: inputs.commands,
    limits: TEAMS_LIMITS,
  };
}

/**
 * The options for the package a download gives right now, and a callback that
 * records it as downloaded once it has been built. The route and the CLI both
 * use this, so they produce the same bytes.
 */
export async function packageForDownload(): Promise<{ options: ManifestOptions; record: () => Promise<void> }> {
  const inputs = await packageInputs();
  if (!inputs.options.appUrl) {
    throw badRequest('Set the app URL in Settings first. Teams needs to know where this deployment lives, and Microsoft has to be able to reach it.');
  }
  const version = currentVersion(inputs.settings, inputs.fingerprint);
  return {
    options: { ...inputs.options, version },
    record: async () => {
      if (!inputs.fingerprint) return;
      const fresh = await loadAppSettings();
      await setOpsSetting('teams_app', {
        ...fresh,
        lastDownload: { version, fingerprint: inputs.fingerprint, snapshot: inputs.snapshot, at: new Date().toISOString() },
      });
    },
  };
}

export interface TeamsAppInput {
  name?: unknown;
  shortDescription?: unknown;
  fullDescription?: unknown;
  accentColor?: unknown;
  /** A data URL or base64 PNG; null removes it; undefined keeps it. */
  icon?: unknown;
  minimumVersion?: unknown;
  commands?: unknown;
}

const text = (value: unknown, max: number, label: string): string => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw badRequest(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw badRequest(`${label} can be at most ${max} characters.`, { [label]: 'Too long' });
  return trimmed;
};

export async function saveTeamsApp(input: TeamsAppInput): Promise<TeamsAppState> {
  const current = await loadAppSettings();
  const teams = await listTeams();
  const next: TeamsAppSettings = { ...current };

  if (input.name !== undefined) next.name = text(input.name, TEAMS_LIMITS.shortName, 'App name');
  if (input.shortDescription !== undefined) next.shortDescription = text(input.shortDescription, TEAMS_LIMITS.shortDescription, 'Short description');
  if (input.fullDescription !== undefined) next.fullDescription = text(input.fullDescription, TEAMS_LIMITS.fullDescription, 'Full description');
  if (input.accentColor !== undefined) {
    const colour = text(input.accentColor, 7, 'Accent colour');
    if (colour && !/^#[0-9a-f]{6}$/i.test(colour)) throw badRequest('The accent colour must be a hex colour such as #1F2937.');
    next.accentColor = colour.toUpperCase();
  }
  if (input.minimumVersion !== undefined) {
    const version = text(input.minimumVersion, 20, 'Minimum version');
    if (version && !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version)) throw badRequest('The version must look like 1.4.2.');
    next.minimumVersion = version;
  }
  if (input.icon === null) next.iconPng = null;
  else if (input.icon !== undefined) {
    if (typeof input.icon !== 'string') throw badRequest('The icon must be a PNG.');
    const raw = Buffer.from(input.icon.replace(/^data:image\/png;base64,/, ''), 'base64');
    if (raw.length > 512 * 1024) throw badRequest('The icon must be under 512 KB.');
    const size = pngSize(raw);
    if (!size) throw badRequest('The icon must be a PNG file.');
    if (size.width !== 192 || size.height !== 192) throw badRequest(`Teams needs a 192x192 icon; this one is ${size.width}x${size.height}.`);
    next.iconPng = raw.toString('base64');
  }

  if (input.commands !== undefined) {
    if (!Array.isArray(input.commands)) throw badRequest('Commands must be a list.');
    const templates = await listTemplates();
    const stored: StoredCommand[] = [];
    const titles = new Set<string>();
    const reserved = new Set([...BUILTIN_COMMANDS.map((command) => command.name as string), ...teams.map((team) => team.key.toLowerCase())]);

    for (const raw of input.commands as Array<Record<string, unknown>>) {
      const kind = raw?.kind;
      const enabled = raw?.enabled !== false;
      const description = text(raw?.description, TEAMS_LIMITS.commandDescription, 'Command description');
      if (kind === 'builtin' || kind === 'department') {
        const ref = String(raw.ref ?? raw.builtin ?? raw.teamId ?? '');
        stored.push({ id: kind === 'builtin' ? `builtin:${ref}` : `team:${ref}`, kind, ref, description: description || undefined, enabled });
        continue;
      }
      if (kind !== 'custom') throw badRequest('Unknown command type.');
      const title = text(raw.title, TEAMS_LIMITS.commandTitle, 'Command name').toLowerCase();
      if (!CUSTOM_TITLE.test(title)) throw badRequest(`"${title}" is not a usable command: one word of letters, digits, - or _, up to 32 characters.`);
      if (reserved.has(title)) throw badRequest(`"${title}" is already a built-in or department command.`);
      if (titles.has(title)) throw badRequest(`Two commands are called "${title}".`);
      if (!description) throw badRequest(`Give "${title}" a description; Teams shows it in the menu.`);
      titles.add(title);

      const action = raw.action as Record<string, unknown> | undefined;
      let parsed: CustomCommandAction;
      if (action?.type === 'department') {
        const teamId = String(action.teamId ?? '');
        if (!teams.some((team) => team.id === teamId)) throw badRequest(`"${title}" opens a department that does not exist.`);
        parsed = { type: 'department', teamId };
      } else if (action?.type === 'template') {
        const templateId = String(action.templateId ?? '');
        if (!templates.some((template) => template.id === templateId)) throw badRequest(`"${title}" opens a quick ticket that does not exist.`);
        parsed = { type: 'template', templateId };
      } else if (action?.type === 'reply') {
        const replyText = text(action.text, 2000, 'Reply');
        const url = text(action.url, 500, 'Link');
        if (!replyText && !url) throw badRequest(`"${title}" needs something to reply with.`);
        if (url && !/^https?:\/\//i.test(url)) throw badRequest('The link must start with http:// or https://.');
        parsed = { type: 'reply', text: replyText, url: url || null };
      } else {
        throw badRequest(`Choose what "${title}" does.`);
      }
      stored.push({ id: typeof raw.id === 'string' && raw.id.startsWith('custom:') ? raw.id : `custom:${randomId()}`, kind: 'custom', title, description, enabled, action: parsed });
    }
    next.commands = stored;
  }

  await setOpsSetting('teams_app', next);
  return teamsAppState();
}

/* ---------------------------------- Cards ---------------------------------- */

const card = (body: unknown[], actions: unknown[] = []) => ({
  type: 'AdaptiveCard',
  $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
  version: '1.4',
  body,
  ...(actions.length ? { actions } : {}),
});

/** Marks a pick from the "new ticket" chooser. */
export const PICK_ACTION = 'infraticket_pick';
/** Marks a submitted quick-ticket form. */
export const TEMPLATE_CARD_ACTION = 'infraticket_template';

const TEMPLATE_FIELD_PREFIX = 'tfield:';

function helpCard(commands: TeamsCommand[], botName: string) {
  const usable = commands.filter((command) => command.enabled);
  return card([
    { type: 'TextBlock', text: `What ${botName} can do`, weight: 'Bolder', size: 'Medium', wrap: true },
    {
      type: 'TextBlock',
      wrap: true,
      size: 'Small',
      text: 'Type a command here (in a channel, mention me first). "Raise a ticket" in the compose box, or on any message’s … menu, opens the same forms.',
    },
    { type: 'FactSet', facts: usable.map((command) => ({ title: command.title, value: command.description })) },
  ]);
}

function choices(teams: Team[], templates: TicketTemplate[]) {
  return [
    ...templates.map((template) => ({ title: `Quick ticket: ${template.name}`, value: `template:${template.id}` })),
    ...teams.map((team) => ({ title: `${team.name} (${team.key.toLowerCase()})`, value: `team:${team.id}` })),
  ];
}

/** "Which form?": departments and the quick tickets this person may use. */
function chooserCard(teams: Team[], templates: TicketTemplate[], extraData: Record<string, unknown>, withPopup: boolean) {
  const options = choices(teams, templates);
  return card(
    [
      { type: 'TextBlock', text: 'Raise a ticket', weight: 'Bolder', size: 'Medium' },
      { type: 'TextBlock', text: 'Which department or quick ticket is it for?', wrap: true, size: 'Small' },
      { type: 'Input.ChoiceSet', id: 'choice', style: 'compact', isRequired: true, errorMessage: 'Pick one', value: options[0]?.value, choices: options },
    ],
    [
      { type: 'Action.Submit', title: 'Next', data: { ...extraData, action: PICK_ACTION } },
      ...(withPopup ? [{ type: 'Action.Submit', title: 'Open as a pop-up form', data: { ...extraData, action: PICK_ACTION, msteams: { type: 'task/fetch' } } }] : []),
    ],
  );
}

function fieldBlocks(fields: TeamFormField[], prefix: string): unknown[] {
  // The department card already knows how to render every field type.
  const rendered = buildTicketCard({ team: { id: '', name: '', key: '' } as Team, fields }).body as Array<Record<string, unknown>>;
  const start = rendered.findIndex((block) => block.id === 'priority') + 1;
  return rendered.slice(start).map((block) => (typeof block.id === 'string' && block.id.startsWith('field:') ? { ...block, id: `${prefix}${block.id.slice(6)}` } : block));
}

function templateCard(template: TicketTemplate, departmentFields: TeamFormField[], prefill: { description?: string }, extraData: Record<string, unknown>) {
  const own = new Set(template.fields.map((field) => field.key));
  return card(
    [
      { type: 'TextBlock', text: template.name, weight: 'Bolder', size: 'Medium', wrap: true },
      ...(template.teamName ? [{ type: 'TextBlock', text: `Goes to ${template.teamName}`, isSubtle: true, size: 'Small', wrap: true }] : []),
      ...(template.guidance ? [{ type: 'TextBlock', text: template.guidance, wrap: true, size: 'Small' }] : []),
      { type: 'TextBlock', text: 'Summary', weight: 'Bolder', size: 'Small', spacing: 'Medium' },
      { type: 'Input.Text', id: 'summary', maxLength: 150, placeholder: 'One line, optional' },
      { type: 'TextBlock', text: 'Details', weight: 'Bolder', size: 'Small', spacing: 'Medium' },
      { type: 'Input.Text', id: 'description', isMultiline: true, ...(prefill.description ? { value: prefill.description } : {}) },
      ...fieldBlocks(asFormFields(template), TEMPLATE_FIELD_PREFIX),
      // The department's own questions, except those the template asks instead.
      ...fieldBlocks(departmentFields.filter((field) => !own.has(field.key)), 'field:'),
    ],
    [{ type: 'Action.Submit', title: 'Raise it', data: { ...extraData, action: TEMPLATE_CARD_ACTION, templateId: template.id } }],
  );
}

function ticketCard(ticket: Ticket, url: string) {
  return card(
    [
      { type: 'TextBlock', text: `${ticket.reference}: ${ticket.subject}`, weight: 'Bolder', wrap: true },
      {
        type: 'FactSet',
        facts: [
          { title: 'Status', value: ticket.status.replace('_', ' ') },
          { title: 'Priority', value: ticket.priority },
          { title: 'Department', value: ticket.teamName ?? 'None' },
          { title: 'Assignee', value: ticket.assigneeName ?? 'Unassigned' },
          { title: 'Updated', value: ticket.updatedAt.slice(0, 16).replace('T', ' ') },
        ],
      },
    ],
    [{ type: 'Action.OpenUrl', title: 'Open ticket', url }],
  );
}

/* ----------------------------- Raising tickets ----------------------------- */

type RaiseResult = { ok: true; ticket: Ticket; url: string } | { ok: false; message: string };

/** A submitted department or quick-ticket form, validated and raised. */
async function raiseFromSubmission(user: PublicUser, value: Record<string, unknown>): Promise<RaiseResult> {
  try {
    if (value.action === TEMPLATE_CARD_ACTION) {
      const template = await findTemplate(String(value.templateId ?? ''));
      if (!template || !template.teamId) return { ok: false, message: 'That quick ticket no longer exists.' };
      if (!canUseTemplate(template, user)) return { ok: false, message: 'That quick ticket is not available to you.' };
      if (template.screenshot === 'required') {
        return { ok: false, message: `"${template.name}" needs a screenshot, which Teams forms cannot carry. Raise it in the browser instead.` };
      }
      const answers: Record<string, unknown> = {};
      const remapped: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(value)) {
        if (key.startsWith(TEMPLATE_FIELD_PREFIX)) remapped[`field:${key.slice(TEMPLATE_FIELD_PREFIX.length)}`] = raw;
      }
      Object.assign(answers, readCardSubmission(remapped).customFields);
      const submitted = readCardSubmission(value);
      const summary = String(value.summary ?? '').trim().slice(0, 150);
      const ticket = await createTicket(
        {
          subject: renderSubject(template, answers, { summary, requester: user.name }),
          description: submitted.description.slice(0, 20_000),
          descriptionFormat: 'text',
          teamId: template.teamId,
          requesterId: user.id,
          priority: template.priority,
          type: template.ticketType,
          severity: template.severity,
          source: 'msteams',
          tags: template.tags,
          customFields: submitted.customFields,
          extraFields: asFormFields(template),
          extraAnswers: answers,
          templateId: template.id,
        },
        { actor: user },
      );
      return { ok: true, ticket, url: await buildTicketUrl(ticket) };
    }

    const submitted = readCardSubmission(value);
    if (!submitted.teamId || !submitted.subject) return { ok: false, message: 'That needs a department and a one-line summary.' };
    const ticket = await createTicket(
      {
        subject: submitted.subject.slice(0, 200),
        description: submitted.description.slice(0, 20_000),
        descriptionFormat: 'text',
        teamId: submitted.teamId,
        priority: submitted.priority as TicketPriority,
        source: 'msteams',
        customFields: submitted.customFields,
      },
      { actor: user },
    );
    return { ok: true, ticket, url: await buildTicketUrl(ticket) };
  } catch (error) {
    return { ok: false, message: error instanceof HttpError ? error.message : 'That could not be saved.' };
  }
}

/** The form for a pick from the chooser, or null when the pick is not one this person may use. */
async function formForChoice(
  user: PublicUser,
  choice: string,
  prefill: { description?: string },
  extraData: Record<string, unknown>,
): Promise<{ title: string; card: unknown } | null> {
  const [kind, id] = choice.split(':');
  const settings = await getSettings();
  if (kind === 'team') {
    const team = (await listTeams()).find((entry) => entry.id === id);
    if (!team) return null;
    const fields = await listTeamFields(team.id);
    return { title: `New ticket for ${team.name}`, card: buildTicketCard({ team, fields, organizationName: settings.organizationName, prefill, submitData: extraData }) };
  }
  if (kind === 'template') {
    const template = await findTemplate(id ?? '');
    if (!template || !template.teamId || !canUseTemplate(template, user)) return null;
    return { title: template.name, card: templateCard(template, await listTeamFields(template.teamId), prefill, extraData) };
  }
  return null;
}

async function usableTemplates(user: PublicUser): Promise<TicketTemplate[]> {
  return (await listTemplates()).filter((template) => canUseTemplate(template, user));
}

/* --------------------------------- Messages -------------------------------- */

/**
 * The commands and chooser picks the app adds. Returns false when the
 * message is not one of them, so the department mention handled by the
 * webhook (and its "which department?" reply) still applies.
 */
export async function handleTeamsAppMessage(activity: TeamsActivity, config: MsTeamsConfig): Promise<boolean> {
  const target = { serviceUrl: activity.serviceUrl!, conversationId: activity.conversation!.id!, replyToId: activity.id };
  const reply = (body: Record<string, unknown>) => sendActivity(config, target, body);
  const replyCard = (content: unknown) => reply({ attachments: [asAttachment(content)] });

  // A pick from the "new ticket" chooser: answer with that form.
  if (activity.value?.action === PICK_ACTION) {
    const actor = await resolveTeamsActor(config, activity, 'tickets.create');
    if (!actor.ok) return (await reply({ text: actor.message }), true);
    const form = await formForChoice(actor.user, String(activity.value.choice ?? ''), {}, {});
    await (form ? replyCard(form.card) : reply({ text: 'That form is not available to you any more.' }));
    return true;
  }

  // A submitted quick-ticket form. Department forms are the webhook's.
  if (activity.value?.action === TEMPLATE_CARD_ACTION) {
    const actor = await resolveTeamsActor(config, activity, 'tickets.create');
    if (!actor.ok) return (await reply({ text: actor.message }), true);
    const result = await raiseFromSubmission(actor.user, activity.value);
    await (result.ok ? replyCard(buildConfirmationCard(result.ticket.reference, result.ticket.subject, result.url)) : reply({ text: result.message }));
    return true;
  }

  const said = stripMention(activity.text, config.botName || activity.recipient?.name);
  const [word = '', ...rest] = said.split(' ');
  const wanted = word.toLowerCase().replace(/^\//, '');
  if (!wanted) return false;

  const appSettings = await loadAppSettings();
  const teams = await listTeams();
  const commands = resolveCommands(appSettings.commands, teams);
  const command = commands.find((entry) => entry.enabled && entry.title === wanted);
  // Departments stay with the webhook's own handler, listed or not.
  if (!command || command.kind === 'department') return false;

  const botName = appSettings.name || config.botName || activity.recipient?.name || 'InfraBot';

  if (command.kind === 'builtin') {
    switch (command.builtin) {
      case 'help':
        await replyCard(helpCard(commands, botName));
        return true;
      case 'new': {
        const actor = await resolveTeamsActor(config, activity, 'tickets.create');
        if (!actor.ok) return (await reply({ text: actor.message }), true);
        if (teams.length === 0) return (await reply({ text: 'No departments have been set up yet.' }), true);
        await replyCard(chooserCard(teams, await usableTemplates(actor.user), {}, true));
        return true;
      }
      case 'status': {
        const actor = await resolveTeamsActor(config, activity, null);
        if (!actor.ok) return (await reply({ text: actor.message }), true);
        const reference = rest.join(' ').trim();
        if (!reference) return (await reply({ text: 'Which ticket? For example: **status ESC-1042**.' }), true);
        const settings = await getSettings();
        const ticket = await findTicket(reference.replace(/^#/, ''), settings.ticketPrefix);
        // Not found and not allowed read the same, so a reference cannot be probed.
        if (!ticket || !canSeeTicket(actor.user, ticket)) return (await reply({ text: `I can't find ${reference}, or it is not one you can see.` }), true);
        await replyCard(ticketCard(ticket, await buildTicketUrl(ticket)));
        return true;
      }
      case 'mine': {
        const actor = await resolveTeamsActor(config, activity, null);
        if (!actor.ok) return (await reply({ text: actor.message }), true);
        const settings = await getSettings();
        const open = ['open', 'in_progress', 'pending'] as Ticket['status'][];
        const [assigned, raised] = await Promise.all([
          listTickets({ status: open, assigneeIds: [actor.user.id], sort: 'updated', limit: 10 }, settings.ticketPrefix),
          listTickets({ status: open, requesterIds: [actor.user.id], sort: 'updated', limit: 10 }, settings.ticketPrefix),
        ]);
        const byId = new Map<string, Ticket>();
        for (const ticket of [...assigned.tickets, ...raised.tickets]) byId.set(ticket.id, ticket);
        const tickets = [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10);
        if (tickets.length === 0) return (await reply({ text: 'You have no open tickets.' }), true);
        await replyCard(
          card([
            { type: 'TextBlock', text: 'Your open tickets', weight: 'Bolder', size: 'Medium' },
            ...(await Promise.all(
              tickets.map(async (ticket) => ({
                type: 'TextBlock',
                wrap: true,
                text: `[${ticket.reference}](${await buildTicketUrl(ticket)}) · ${ticket.status.replace('_', ' ')} · ${ticket.subject}`,
              })),
            )),
          ]),
        );
        return true;
      }
      case 'oncall': {
        const actor = await resolveTeamsActor(config, activity, null);
        if (!actor.ok) return (await reply({ text: actor.message }), true);
        const { listSchedules } = await import('../ops/oncall.ts');
        const schedules = await listSchedules();
        if (schedules.length === 0) return (await reply({ text: 'No on-call schedules have been set up yet.' }), true);
        await replyCard(
          card([
            { type: 'TextBlock', text: 'On call now', weight: 'Bolder', size: 'Medium' },
            {
              type: 'FactSet',
              facts: schedules.map((schedule) => ({
                title: schedule.teamName ?? schedule.name,
                value: schedule.onCallNow
                  ? `${schedule.onCallNow.userName}${schedule.onCallNow.until ? ` until ${schedule.onCallNow.until.slice(0, 16).replace('T', ' ')} UTC` : ''}`
                  : 'Nobody',
              })),
            },
          ]),
        );
        return true;
      }
    }
  }

  // A custom command.
  const action = command.action!;
  if (action.type === 'reply') {
    await reply({ text: [action.text, action.url].filter(Boolean).join('\n\n') });
    return true;
  }
  const actor = await resolveTeamsActor(config, activity, 'tickets.create');
  if (!actor.ok) return (await reply({ text: actor.message }), true);
  const form = await formForChoice(actor.user, action.type === 'department' ? `team:${action.teamId}` : `template:${action.templateId}`, {}, {});
  await (form ? replyCard(form.card) : reply({ text: 'That form is not available to you.' }));
  return true;
}

/* ---------------------------------- Invokes -------------------------------- */

interface InvokeValue {
  commandId?: string;
  commandContext?: string;
  data?: Record<string, unknown>;
  messagePayload?: { body?: { content?: string; contentType?: string }; linkToMessage?: string; from?: { user?: { displayName?: string } } };
}

const taskMessage = (value: string) => ({ task: { type: 'message', value } });
const taskCard = (title: string, content: unknown) => ({
  task: { type: 'continue', value: { title, height: 'large', width: 'medium', card: asAttachment(content) } },
});

/** The details a ticket raised from a message starts with: what was said, who said it, and a link back. */
function messagePrefill(payload: InvokeValue['messagePayload']): string {
  if (!payload) return '';
  const said = teamsTextToPlain(payload.body?.content ?? '');
  const who = payload.from?.user?.displayName;
  return [who ? `${who} wrote:` : '', said, payload.linkToMessage ? `\nFrom Teams: ${payload.linkToMessage}` : ''].filter(Boolean).join('\n').trim().slice(0, 20_000);
}

/**
 * Answers an invoke: the forms that open from the compose box, a message's
 * … menu, or a card's "Open as a pop-up form" button. Teams waits for the
 * body of the HTTP response itself, so this returns it rather than posting.
 */
export async function handleTeamsInvoke(activity: TeamsActivity & { name?: string }, config: MsTeamsConfig): Promise<unknown> {
  const name = activity.name ?? '';
  const value = (activity.value ?? {}) as InvokeValue;
  const data = (value.data ?? {}) as Record<string, unknown>;
  const fromCompose = name.startsWith('composeExtension/');

  if (!['composeExtension/fetchTask', 'composeExtension/submitAction', 'task/fetch', 'task/submit'].includes(name)) return {};

  const actor = await resolveTeamsActor(config, activity, 'tickets.create');
  if (!actor.ok) return taskMessage(actor.message);
  const user = actor.user;

  // Opening: the chooser, or straight to a form when the card already picked one.
  if (name === 'composeExtension/fetchTask' || (name === 'task/fetch' && !data.choice)) {
    const teams = await listTeams();
    if (teams.length === 0) return taskMessage('No departments have been set up yet.');
    const prefill = value.commandId === COMPOSE_COMMANDS.fromMessage ? messagePrefill(value.messagePayload) : '';
    return taskCard('Raise a ticket', chooserCard(teams, await usableTemplates(user), prefill ? { prefill } : {}, false));
  }

  // A form came back: raise it.
  if (data.action === TICKET_CARD_ACTION || data.action === TEMPLATE_CARD_ACTION) {
    const result = await raiseFromSubmission(user, data);
    if (!result.ok) return taskMessage(result.message);
    const confirmation = buildConfirmationCard(result.ticket.reference, result.ticket.subject, result.url);
    if (fromCompose) {
      // Dropped into the compose box, for the person to send to the conversation.
      return { composeExtension: { type: 'result', attachmentLayout: 'list', attachments: [asAttachment(confirmation)] } };
    }
    if (activity.serviceUrl && activity.conversation?.id) {
      await sendActivity(config, { serviceUrl: activity.serviceUrl, conversationId: activity.conversation.id }, { attachments: [asAttachment(confirmation)] });
    }
    return taskMessage(`Raised ${result.ticket.reference}: ${result.ticket.subject}`);
  }

  // A pick from the chooser: the form for it, carrying any prefilled text.
  if (typeof data.choice === 'string') {
    const prefill = typeof data.prefill === 'string' ? data.prefill : '';
    const form = await formForChoice(user, data.choice, { description: prefill }, {});
    if (!form) return taskMessage('That form is not available to you.');
    return taskCard(form.title, form.card);
  }

  return taskMessage('That form has expired. Open it again.');
}
