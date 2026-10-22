import { createZip } from '../lib/zip.ts';
import { colorIcon, outlineIcon } from '../lib/png.ts';
import type { Team } from '../../shared/types.ts';

/**
 * The Teams app package.
 *
 * Teams installs an app from a zip of a manifest and two icons. Building it
 * here rather than leaving a template to edit by hand means the values that
 * are easy to get wrong - the app id in two places, the host in three, and
 * the command list - come from what the deployment is actually configured
 * with, and the department list is whatever exists right now.
 *
 * The bot answers any department whether or not it is in the manifest; the
 * command list is only the menu Teams shows when the bot is mentioned.
 */

/** Teams rejects a manifest whose id is not a GUID. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ManifestOptions {
  /** The Azure app registration's client id, which is also the bot id. */
  appId: string;
  /** Where this deployment lives, e.g. https://tickets.example.internal. */
  appUrl: string;
  /** Shown in the app catalogue. */
  botName?: string;
  organizationName?: string;
  teams?: Team[];
  accentColor?: string;
  /** Lets the bot place calls: on when Teams calls are turned on for paging. */
  supportsCalling?: boolean;
  /** Teams only accepts an update whose version is higher than the installed one. */
  version?: string;
  shortDescription?: string;
  fullDescription?: string;
  /**
   * The bot's command menu, in order. Left out, it is the built-in commands
   * followed by one per department.
   */
  commands?: Array<{ title: string; description: string }>;
  /** A replacement 192x192 colour icon; the generated one otherwise. */
  colorIconPng?: Buffer;
}

/** Teams' own limits, checked before Microsoft gets to reject the upload. */
export const TEAMS_LIMITS = {
  commands: 10,
  commandTitle: 32,
  commandDescription: 128,
  shortName: 30,
  fullName: 100,
  shortDescription: 80,
  fullDescription: 4000,
} as const;

/** The commands every package lists, ahead of the departments. */
export const BUILTIN_COMMANDS = [
  { name: 'help', description: 'What I can do, and the commands I answer' },
  { name: 'new', description: 'Raise a ticket: pick a department or quick ticket, then fill in its form' },
  { name: 'status', description: 'status ESC-1042: where a ticket is up to' },
  { name: 'mine', description: 'Your open tickets' },
  { name: 'oncall', description: 'Who is on call right now, per department' },
] as const;

export type BuiltinCommand = (typeof BUILTIN_COMMANDS)[number]['name'];

/** The messaging-extension actions: forms opened from the compose box or a message. */
export const COMPOSE_COMMANDS = {
  raise: 'raiseTicket',
  fromMessage: 'ticketFromMessage',
} as const;

export function defaultCommands(teams: Team[]): Array<{ title: string; description: string }> {
  return [
    ...BUILTIN_COMMANDS.map((command) => ({ title: command.name, description: command.description })),
    ...teams.map((team) => ({ title: team.key.toLowerCase(), description: `Raise a ticket on the ${team.name} form` })),
  ];
}

export class ManifestError extends Error {}

/** The host of `appUrl`, which the manifest needs on its own. */
function hostOf(appUrl: string): string {
  try {
    const url = new URL(appUrl);
    if (url.protocol !== 'https:') {
      throw new ManifestError(
        `The app URL must be https, not "${url.protocol}//". Microsoft will not send activities to a plain HTTP endpoint.`,
      );
    }
    return url.host;
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    throw new ManifestError(`"${appUrl}" is not a valid URL. Set the app URL in Settings first.`);
  }
}

export function buildTeamsManifest(options: ManifestOptions): Record<string, unknown> {
  const appId = options.appId?.trim() ?? '';
  if (!GUID.test(appId)) {
    throw new ManifestError(
      'The Microsoft app id must be a GUID, as shown in the Azure portal. Save it under Integrations → Microsoft Teams → Bot first.',
    );
  }

  const host = hostOf(options.appUrl);
  const botName = (options.botName || 'InfraBot').slice(0, 30);
  const organizationName = options.organizationName || 'Service Desk';
  const teams = options.teams ?? [];

  /*
   * Teams caps a command list at ten. Beyond that the menu is a wall of text
   * nobody reads anyway, and the rest still work - they are just not listed.
   */
  const commands = (options.commands ?? defaultCommands(teams)).slice(0, TEAMS_LIMITS.commands).map((command) => ({
    title: command.title.slice(0, TEAMS_LIMITS.commandTitle),
    description: command.description.slice(0, TEAMS_LIMITS.commandDescription),
  }));

  return {
    $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json',
    manifestVersion: '1.16',
    version: options.version || '1.0.0',
    // Teams keys the installed app on this, so it is the bot's own id.
    id: appId,
    packageName: `com.${host.replace(/[^a-z0-9]+/gi, '')}.infrabot`,
    developer: {
      name: organizationName.slice(0, 32),
      websiteUrl: options.appUrl,
      privacyUrl: `${options.appUrl.replace(/\/+$/, '')}/privacy`,
      termsOfUseUrl: `${options.appUrl.replace(/\/+$/, '')}/terms`,
    },
    name: { short: botName, full: `${botName} — ${organizationName}`.slice(0, 100) },
    description: {
      short: (options.shortDescription?.trim() || 'Raise and answer tickets without leaving Teams.').slice(0, TEAMS_LIMITS.shortDescription),
      full: (
        options.fullDescription?.trim() ||
        `Mention ${botName} with a department to raise a ticket on that department's own form, or use "Raise a ticket" ` +
          'from the compose box or any message’s … menu. ' +
          'Ticket updates arrive in the channel, and replying in a ticket’s thread adds a comment to it. ' +
          'A request is only accepted when the Teams account matches an active user with permission to raise tickets.'
      ).slice(0, TEAMS_LIMITS.fullDescription),
    },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: options.accentColor?.trim() || '#1F2937',
    bots: [
      {
        botId: appId,
        scopes: ['team', 'personal', 'groupChat'],
        supportsFiles: false,
        isNotificationOnly: false,
        // Without it Teams refuses calls from the bot, even with the Graph permissions.
        ...(options.supportsCalling ? { supportsCalling: true } : {}),
        ...(commands.length > 0
          ? { commandLists: [{ scopes: ['team', 'personal', 'groupChat'], commands }] }
          : {}),
      },
    ],
    /*
     * Forms that open from the compose box, the command box, or a message's
     * … menu. They are answered by the same bot endpoint as the commands.
     */
    composeExtensions: [
      {
        botId: appId,
        commands: [
          {
            id: COMPOSE_COMMANDS.raise,
            type: 'action',
            title: 'Raise a ticket',
            description: 'Pick a department or quick ticket and fill in its form',
            context: ['compose', 'commandBox'],
            fetchTask: true,
          },
          {
            id: COMPOSE_COMMANDS.fromMessage,
            type: 'action',
            title: 'Create ticket from message',
            description: 'Raise a ticket with this message as its details',
            context: ['message'],
            fetchTask: true,
          },
        ],
      },
    ],
    permissions: ['identity', 'messageTeamMembers'],
    validDomains: [host],
  };
}

export interface PackageResult {
  filename: string;
  zip: Buffer;
}

export function buildTeamsAppPackage(options: ManifestOptions): PackageResult {
  const manifest = buildTeamsManifest(options);
  const botName = (options.botName || 'InfraBot').trim();

  const zip = createZip(
    [
      { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
      { name: 'color.png', data: options.colorIconPng ?? colorIcon(options.accentColor) },
      { name: 'outline.png', data: outlineIcon() },
    ],
    // Fixed, so re-downloading an unchanged configuration gives identical
    // bytes and Teams does not think it is a different package.
    { modified: new Date('2024-01-01T00:00:00Z') },
  );

  return { filename: `${botName.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'infrabot'}-teams.zip`, zip };
}

/* ------------------------------- Validation ------------------------------- */

/** Width and height from a PNG's header, or null when it is not a PNG. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 24 || !png.subarray(0, 8).equals(signature) || png.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Everything wrong with the package these options would produce, in words an
 * admin can act on. Empty means Teams' structural rules are met; Microsoft's
 * own review can still have opinions, but not about these.
 */
export function validateTeamsPackage(options: ManifestOptions): string[] {
  const problems: string[] = [];
  let manifest: Record<string, any>;
  try {
    manifest = buildTeamsManifest(options);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  const name = (options.botName || 'InfraBot').trim();
  if (name.length > TEAMS_LIMITS.shortName) problems.push(`The app name is ${name.length} characters; Teams allows ${TEAMS_LIMITS.shortName}.`);
  if (options.shortDescription && options.shortDescription.trim().length > TEAMS_LIMITS.shortDescription) {
    problems.push(`The short description is over ${TEAMS_LIMITS.shortDescription} characters.`);
  }
  if (options.fullDescription && options.fullDescription.trim().length > TEAMS_LIMITS.fullDescription) {
    problems.push(`The full description is over ${TEAMS_LIMITS.fullDescription} characters.`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version))) problems.push(`The version "${manifest.version}" is not of the form 1.2.3.`);
  if (options.accentColor && !/^#[0-9a-f]{6}$/i.test(options.accentColor.trim())) problems.push('The accent colour must be a hex colour such as #1F2937.');

  const requested = options.commands ?? defaultCommands(options.teams ?? []);
  if (requested.length > TEAMS_LIMITS.commands) {
    problems.push(
      `${requested.length} commands are switched on but Teams lists only ${TEAMS_LIMITS.commands}; the last ${requested.length - TEAMS_LIMITS.commands} still work but will not appear in the menu.`,
    );
  }
  const seen = new Set<string>();
  for (const command of requested) {
    const title = command.title.trim();
    if (!title) problems.push('A command has no name.');
    if (title.length > TEAMS_LIMITS.commandTitle) problems.push(`The command "${title}" is longer than ${TEAMS_LIMITS.commandTitle} characters.`);
    if (command.description.length > TEAMS_LIMITS.commandDescription) {
      problems.push(`The description of "${title}" is longer than ${TEAMS_LIMITS.commandDescription} characters.`);
    }
    if (!command.description.trim()) problems.push(`The command "${title}" has no description.`);
    if (seen.has(title.toLowerCase())) problems.push(`Two commands are called "${title}".`);
    seen.add(title.toLowerCase());
  }

  if (options.colorIconPng) {
    const size = pngSize(options.colorIconPng);
    if (!size) problems.push('The uploaded icon is not a PNG.');
    else if (size.width !== 192 || size.height !== 192) problems.push(`The colour icon must be 192x192 pixels; the uploaded one is ${size.width}x${size.height}.`);
  }
  const outline = pngSize(outlineIcon());
  if (!outline || outline.width !== 32 || outline.height !== 32) problems.push('The outline icon must be 32x32 pixels.');

  return problems;
}
