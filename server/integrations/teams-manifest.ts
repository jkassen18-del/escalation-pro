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
  const commands = teams.slice(0, 10).map((team) => ({
    title: team.key.toLowerCase(),
    description: `Raise a ticket on the ${team.name} form`,
  }));

  return {
    $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json',
    manifestVersion: '1.16',
    version: '1.0.0',
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
      short: 'Raise and answer tickets without leaving Teams.',
      full:
        `Mention ${botName} with a department to raise a ticket on that department's own form. ` +
        'Ticket updates arrive in the channel, and replying in a ticket’s thread adds a comment to it. ' +
        'A request is only accepted when the Teams account matches an active user with permission to raise tickets.',
    },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: options.accentColor?.trim() || '#1F2937',
    bots: [
      {
        botId: appId,
        scopes: ['team', 'personal', 'groupChat'],
        supportsFiles: false,
        isNotificationOnly: false,
        ...(commands.length > 0
          ? { commandLists: [{ scopes: ['team', 'personal', 'groupChat'], commands }] }
          : {}),
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
      { name: 'color.png', data: colorIcon(options.accentColor) },
      { name: 'outline.png', data: outlineIcon() },
    ],
    // Fixed, so re-downloading an unchanged configuration gives identical
    // bytes and Teams does not think it is a different package.
    { modified: new Date('2024-01-01T00:00:00Z') },
  );

  return { filename: `${botName.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'infrabot'}-teams.zip`, zip };
}
