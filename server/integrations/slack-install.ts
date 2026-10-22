import { decryptSecret, encryptSecret } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import { getOpsSetting, getSettings, setOpsSetting } from '../repositories/settings.ts';
import { loadIntegration, saveIntegration } from './store.ts';

/**
 * One-click Slack: generate the app from a manifest, then install it with
 * OAuth ("Add to Slack") instead of copying a bot token by hand.
 *
 * Slack has no API for creating an app without a configuration token, so the
 * admin clicks one link that opens Slack's "create app from manifest" screen
 * with everything filled in, then pastes the app's Client ID, Client Secret
 * and Signing Secret back here once. From then on "Add to Slack" does the rest.
 */

/** Exactly what the existing integration calls, and nothing more. */
export const SLACK_BOT_SCOPES = [
  'chat:write', // notifications and thread replies
  'chat:write.public', // post to a public channel without being invited first
  'commands', // the slash command
  'users:read', // who replied, for attribution
  'users:read.email', // ...matched to an account here by email
  'channels:history', // replies in ticket threads (public channels)
  'groups:history', // ...and private channels
  'channels:read', // the channel picker
  'groups:read',
  'reactions:read', // a :white_check_mark: reaction resolves a ticket
] as const;

export const SLACK_BOT_EVENTS = ['message.channels', 'message.groups', 'reaction_added'] as const;

export async function appBaseUrl(fallbackOrigin?: string): Promise<string> {
  const settings = await getSettings();
  return (settings.appUrl || process.env.APP_URL || fallbackOrigin || 'http://localhost:3000').replace(/\/+$/, '');
}

/**
 * Whether Slack can call this address. Slack verifies the event and
 * interactivity URLs when the app is created, so an address only the office
 * can reach would make the manifest fail; those features are left out then.
 */
export function isPublicHttps(base: string): boolean {
  try {
    const url = new URL(base);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname;
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return false;
    if (/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

export interface SlackManifestOptions {
  appName: string;
  command: string;
}

export function buildSlackManifest(base: string, { appName, command }: SlackManifestOptions): Record<string, unknown> {
  const publicUrl = isPublicHttps(base);
  const name = appName.slice(0, 35) || 'InfraTicket';
  const features: Record<string, unknown> = {
    bot_user: { display_name: name, always_online: true },
  };
  const settings: Record<string, unknown> = {
    org_deploy_enabled: false,
    socket_mode_enabled: false,
    token_rotation_enabled: false,
  };
  if (publicUrl) {
    features.slash_commands = [
      {
        command,
        url: `${base}/api/webhooks/slack/commands`,
        description: 'Raise a ticket',
        usage_hint: '[department]',
        should_escape: false,
      },
    ];
    settings.event_subscriptions = { request_url: `${base}/api/webhooks/slack`, bot_events: [...SLACK_BOT_EVENTS] };
    settings.interactivity = { is_enabled: true, request_url: `${base}/api/webhooks/slack/interactive` };
  }
  return {
    display_information: {
      name,
      description: 'Tickets, incidents and on-call from InfraTicket.',
      background_color: '#1a1815',
    },
    features,
    oauth_config: {
      redirect_urls: [`${base}/api/integrations/slack/oauth/callback`],
      scopes: { bot: [...SLACK_BOT_SCOPES] },
    },
    settings,
  };
}

export function manifestCreateUrl(manifest: Record<string, unknown>): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

/* ------------------------------ App credentials ---------------------------- */

interface StoredSlackApp {
  clientId?: string;
  clientSecretEncrypted?: string;
  command?: string;
  appName?: string;
  installedTeam?: string;
  installedAt?: string;
}

export interface SlackAppPublic {
  clientId: string | null;
  hasClientSecret: boolean;
  hasSigningSecret: boolean;
  command: string;
  appName: string;
  installedTeam: string | null;
  installedAt: string | null;
  hasBotToken: boolean;
  channel: string | null;
}

export async function loadSlackApp(): Promise<StoredSlackApp> {
  return getOpsSetting<StoredSlackApp>('slack-app', {});
}

export async function publicSlackApp(): Promise<SlackAppPublic> {
  const [app, record] = await Promise.all([loadSlackApp(), loadIntegration('slack')]);
  return {
    clientId: app.clientId ?? null,
    hasClientSecret: Boolean(app.clientSecretEncrypted),
    hasSigningSecret: Boolean(record.config.signingSecret),
    command: app.command ?? '/gml',
    appName: app.appName ?? 'InfraTicket',
    installedTeam: app.installedTeam ?? null,
    installedAt: app.installedAt ?? null,
    hasBotToken: Boolean(record.config.botToken),
    channel: (record.config.channel as string | undefined) || null,
  };
}

export async function saveSlackApp(input: Record<string, unknown>): Promise<SlackAppPublic> {
  const current = await loadSlackApp();
  const text = (key: string, max = 200) => (typeof input[key] === 'string' ? String(input[key]).trim().slice(0, max) : '');
  const clientId = text('clientId');
  if (clientId && !/^\d+\.\d+$/.test(clientId)) {
    throw badRequest('That does not look like a Slack Client ID (two numbers joined by a dot).', { clientId: 'Invalid' });
  }
  const command = text('command', 32);
  if (command && !/^\/[a-z0-9_-]{1,31}$/.test(command)) {
    throw badRequest('A slash command is "/" followed by lower-case letters, digits, "-" or "_".', { command: 'Invalid' });
  }
  const next: StoredSlackApp = {
    ...current,
    clientId: clientId || current.clientId,
    command: command || current.command,
    appName: text('appName', 35) || current.appName,
  };
  const clientSecret = text('clientSecret');
  if (clientSecret) next.clientSecretEncrypted = encryptSecret(clientSecret);
  await setOpsSetting('slack-app', next);

  // The signing secret is what the existing webhook routes verify against.
  const signingSecret = text('signingSecret');
  if (signingSecret) await saveIntegration('slack', { config: { signingSecret } });
  return publicSlackApp();
}

export async function authorizeUrl(state: string, base: string): Promise<string> {
  const app = await loadSlackApp();
  if (!app.clientId || !app.clientSecretEncrypted) {
    throw badRequest('Save the Client ID and Client Secret from the Slack app first.');
  }
  const params = new URLSearchParams({
    client_id: app.clientId,
    scope: SLACK_BOT_SCOPES.join(','),
    redirect_uri: `${base}/api/integrations/slack/oauth/callback`,
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params}`;
}

/** Trades the code Slack sent back for a bot token, and keeps the token encrypted. */
export async function completeInstall(code: string, base: string): Promise<{ team: string }> {
  const app = await loadSlackApp();
  if (!app.clientId || !app.clientSecretEncrypted) throw new Error('The Slack app credentials are missing.');
  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: decryptSecret(app.clientSecretEncrypted),
      code,
      redirect_uri: `${base}/api/integrations/slack/oauth/callback`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    access_token?: string;
    token_type?: string;
    team?: { id?: string; name?: string };
  };
  if (!body.ok || !body.access_token) throw new Error(`Slack refused the install: ${body.error ?? `HTTP ${response.status}`}`);
  if (body.token_type && body.token_type !== 'bot') throw new Error('Slack returned a user token, not a bot token.');

  await saveIntegration('slack', { config: { mode: 'bot', botToken: body.access_token } });
  const team = body.team?.name ?? 'your workspace';
  await setOpsSetting('slack-app', { ...app, installedTeam: team, installedAt: new Date().toISOString() });
  return { team };
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

/** Channels the bot can see, for the picker. Private ones appear once the bot is invited. */
export async function listSlackChannels(): Promise<SlackChannel[]> {
  const record = await loadIntegration('slack');
  const token = record.config.botToken as string | undefined;
  if (!token) throw badRequest('Add the app to Slack first.');
  const channels: SlackChannel[] = [];
  let cursor = '';
  for (let page = 0; page < 5; page += 1) {
    const params = new URLSearchParams({ types: 'public_channel,private_channel', exclude_archived: 'true', limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const response = await fetch(`https://slack.com/api/conversations.list?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      channels?: Array<{ id: string; name: string; is_private?: boolean; is_member?: boolean }>;
      response_metadata?: { next_cursor?: string };
    };
    if (!body.ok) throw badRequest(`Slack would not list channels: ${body.error ?? 'unknown error'}`);
    for (const channel of body.channels ?? []) {
      channels.push({ id: channel.id, name: channel.name, isPrivate: Boolean(channel.is_private), isMember: Boolean(channel.is_member) });
    }
    cursor = body.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }
  return channels.sort((a, b) => a.name.localeCompare(b.name));
}
