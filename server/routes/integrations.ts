import { Router } from 'express';
import { asyncRoute, badRequest, notFound, optionalString, requireEnum } from '../lib/http.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
import {
  DEFAULT_EVENTS,
  loadIntegration,
  redactConfig,
  saveIntegration,
  resetIntegrationStatus,
  setIntegrationStatus,
} from '../integrations/store.ts';
import { listDeliveries, logHttpTestDelivery } from '../integrations/dispatcher.ts';
import {
  deleteHttpIntegration,
  findHttpIntegration,
  listHttpIntegrations,
  saveHttpIntegration,
  sendHttpIntegration,
  toPublic,
  validateHttpIntegration,
} from '../integrations/http-custom.ts';
import { listLinearTeamMap, saveLinearTeamMap, validateLinearTeamMap } from '../integrations/linear-map.ts';
import { assertSafeWebhookUrl, assertSlackWebhookUrl } from '../integrations/url-guard.ts';
import { testSlack } from '../integrations/slack.ts';
import { detectFormat, testMsTeams } from '../integrations/msteams.ts';
import { listLinearTeams, testLinear } from '../integrations/linear.ts';
import { testEmail } from '../integrations/email.ts';
import { discordInviteUrl, listDiscordChannels, testDiscord, type DiscordConfig } from '../integrations/discord.ts';
import { discordGatewayStatus, refreshDiscordGateway } from '../integrations/discord-gateway.ts';
import { setTeamRoute } from '../repositories/team-routing.ts';
import { db } from '../db/index.ts';
import {
  INTEGRATION_PROVIDERS,
  type IntegrationProvider,
  type IntegrationSummary,
  type Ticket,
} from '../../shared/types.ts';
import { buildTeamsAppPackage, ManifestError } from '../integrations/teams-manifest.ts';
import { packageForDownload, saveTeamsApp, teamsAppState } from '../integrations/teams-app.ts';
import { catalogueStatus } from '../integrations/catalogue.ts';
import { integrationSetupRouter } from './integration-setup.ts';
import { integrationRoutingRouter } from './integration-routing.ts';
import { getSettings } from '../repositories/settings.ts';

export const integrationsRouter: Router = Router();

integrationsRouter.use(requireAuth, requirePermission('integrations.manage'));

// Guided one-click setup (Slack app manifest + OAuth, Microsoft admin consent).
integrationsRouter.use(integrationSetupRouter);
integrationsRouter.use(integrationRoutingRouter);

/** True once the provider has the minimum fields it needs to send anything. */
function isConfigured(provider: IntegrationProvider, config: Record<string, unknown>): boolean {
  switch (provider) {
    case 'slack':
      // Bot mode no longer needs one channel: each department picks its own.
      return config.mode === 'bot' ? Boolean(config.botToken) : Boolean(config.webhookUrl);
    case 'msteams':
      return config.mode === 'bot'
        ? Boolean(config.appId && config.appPassword)
        : Boolean(config.webhookUrl);
    case 'linear':
      return Boolean(config.apiKey);
    case 'email':
      return Boolean(config.host && (config.fromEmail || config.username));
    case 'discord':
      return Boolean(config.applicationId && config.botToken);
    default:
      return false;
  }
}

async function summarise(provider: IntegrationProvider): Promise<IntegrationSummary> {
  const record = await loadIntegration(provider);
  return {
    provider,
    enabled: record.enabled,
    configured: isConfigured(provider, record.config),
    status: record.status,
    lastCheckedAt: record.lastCheckedAt,
    lastError: record.lastError,
    config: redactConfig(provider, record.config),
    events: record.events,
  };
}

integrationsRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    const integrations = await Promise.all(INTEGRATION_PROVIDERS.map(summarise));
    res.json({ integrations, defaultEvents: DEFAULT_EVENTS });
  }),
);

/** Status of every tile on the Integrations catalogue. */
integrationsRouter.get(
  '/catalogue',
  asyncRoute(async (_req, res) => {
    const summaries = await Promise.all(INTEGRATION_PROVIDERS.map(summarise));
    res.json({ status: await catalogueStatus(summaries) });
  }),
);

integrationsRouter.get(
  '/deliveries',
  asyncRoute(async (_req, res) => {
    const rows = await listDeliveries(60);
    res.json({
      deliveries: rows.map((row) => ({
        id: String(row.id),
        provider: String(row.provider),
        event: String(row.event),
        ticketId: (row.ticket_id as string | null) ?? null,
        ok: Number(row.ok) === 1,
        statusCode: row.status_code === null ? null : Number(row.status_code),
        error: (row.error as string | null) ?? null,
        createdAt: String(row.created_at),
      })),
    });
  }),
);

/* ------------------------- Custom HTTP integrations ------------------------ */

integrationsRouter.get(
  '/http',
  asyncRoute(async (_req, res) => {
    res.json({ integrations: (await listHttpIntegrations()).map(toPublic) });
  }),
);

integrationsRouter.post(
  '/http',
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const record = await saveHttpIntegration(null, validateHttpIntegration(req.body ?? {}));
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'integration',
      entityId: record.id,
      action: 'http_integration_created',
      summary: `Added custom HTTP integration "${record.name}" (${record.method} ${new URL(record.url).host})`,
      ip: clientIp(req),
    });
    res.status(201).json({ integration: toPublic(record) });
  }),
);

integrationsRouter.put(
  '/http/:id',
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    if (!(await findHttpIntegration(req.params.id))) throw notFound('That integration does not exist.');
    const record = await saveHttpIntegration(req.params.id, validateHttpIntegration(req.body ?? {}));
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'integration',
      entityId: record.id,
      action: 'http_integration_updated',
      summary: `Updated custom HTTP integration "${record.name}"`,
      ip: clientIp(req),
    });
    res.json({ integration: toPublic(record) });
  }),
);

integrationsRouter.delete(
  '/http/:id',
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const record = await findHttpIntegration(req.params.id);
    if (!record) throw notFound('That integration does not exist.');
    await deleteHttpIntegration(record.id);
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'integration',
      entityId: record.id,
      action: 'http_integration_deleted',
      summary: `Deleted custom HTTP integration "${record.name}"`,
      ip: clientIp(req),
    });
    res.status(204).end();
  }),
);

/** Sends a sample event, whatever the event toggles say, and shows what came back. */
integrationsRouter.post(
  '/http/:id/test',
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const record = await findHttpIntegration(req.params.id);
    if (!record) throw notFound('That integration does not exist.');
    const settings = await getSettings();
    const ticket = sampleTicket(settings.ticketPrefix);
    const result = await sendHttpIntegration(record, {
      event: 'ticketCreated',
      ticket,
      actorName: actor.name,
      headline: `Test from InfraTicket: ${ticket.reference}`,
      detail: 'A sample event sent from the integration settings. No ticket was created.',
      ticketUrl: `${(settings.appUrl || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '')}/tickets/${ticket.id}`,
    });
    await logHttpTestDelivery(record.id, null, result);
    res.json({ result });
  }),
);

/* ---------------------------- Linear team mapping --------------------------- */

integrationsRouter.get(
  '/linear/team-map',
  asyncRoute(async (_req, res) => {
    res.json({ mappings: await listLinearTeamMap() });
  }),
);

integrationsRouter.put(
  '/linear/team-map',
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const mappings = await saveLinearTeamMap(validateLinearTeamMap(req.body?.mappings));
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'integration',
      entityId: 'linear',
      action: 'linear_team_map_saved',
      summary: `Linked ${mappings.length} Linear team(s) to departments`,
      meta: { mappings: mappings.map((m) => ({ linear: m.linearTeamKey ?? m.linearTeamId, teamId: m.teamId, primary: m.isPrimary })) },
      ip: clientIp(req),
    });
    res.json({ mappings });
  }),
);

integrationsRouter.patch(
  '/:provider',
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const provider = requireEnum(req.params.provider, INTEGRATION_PROVIDERS, 'Provider');

    const incoming =
      typeof req.body?.config === 'object' && req.body.config
        ? ({ ...req.body.config } as Record<string, unknown>)
        : undefined;

    /*
     * Slack posts either through an incoming webhook or a bot token, and only
     * the selected mode's credential is ever read.
     *
     * So the webhook URL is validated only when that is the mode in use.
     * Checking it regardless rejected a perfectly good bot-token setup because
     * of a leftover value in a field the mode never looks at - and the error
     * named a field the person was not filling in.
     */
    const modal = provider === 'slack' || provider === 'msteams';
    const mode = modal
      ? (((incoming?.mode as string) ?? (await loadIntegration(provider)).config.mode ?? 'webhook') as string)
      : null;

    if (incoming && mode === 'bot') {
      // Not the credential being configured, so this request does not carry
      // it. Anything already stored is left alone, so switching back works.
      delete incoming.webhookUrl;
    }

    // Reject URLs that would let an outbound webhook reach internal services.
    if (incoming && typeof incoming.webhookUrl === 'string' && incoming.webhookUrl) {
      incoming.webhookUrl =
        provider === 'slack'
          ? assertSlackWebhookUrl(incoming.webhookUrl)
          : assertSafeWebhookUrl(incoming.webhookUrl, 'Webhook URL');
    }

    const record = await saveIntegration(provider, {
      enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
      config: incoming,
      events: typeof req.body?.events === 'object' && req.body.events ? req.body.events : undefined,
    });

    // Config changed, so the previous test result no longer means anything.
    await resetIntegrationStatus(provider, isConfigured(provider, record.config));

    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'integration',
      entityId: provider,
      action: 'integration_updated',
      // Never log the credential values themselves.
      summary: `Updated the ${provider} integration`,
      meta: { enabled: record.enabled, fields: Object.keys(req.body?.config ?? {}) },
      ip: clientIp(req),
    });

    // A new token or a switch on/off takes effect now, not at the next supervisor pass.
    if (provider === 'discord') void refreshDiscordGateway();

    res.json({ integration: await summarise(provider) });
  }),
);

/** Runs a live connection test against the real provider API. */
integrationsRouter.post(
  '/:provider/test',
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const provider = requireEnum(req.params.provider, INTEGRATION_PROVIDERS, 'Provider');
    const record = await loadIntegration(provider);

    if (!isConfigured(provider, record.config)) {
      throw badRequest('Fill in and save the required fields before testing the connection.');
    }

    let result;
    switch (provider) {
      case 'slack':
        result = await testSlack(record);
        break;
      case 'msteams':
        result = await testMsTeams(record);
        break;
      case 'linear':
        result = await testLinear(record);
        break;
      case 'email':
        result = await testEmail(record, optionalString(req.body?.recipient, 160) ?? undefined);
        break;
      case 'discord':
        result = await testDiscord(record);
        break;
    }

    await setIntegrationStatus(provider, result.ok ? 'ok' : 'error', result.ok ? null : result.message, {
      stampCheckedAt: true,
    });
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'integration',
      entityId: provider,
      action: 'integration_tested',
      summary: `Tested ${provider}: ${result.ok ? 'success' : 'failed'}`,
      ip: clientIp(req),
    });

    res.json({ ...result, integration: await summarise(provider) });
  }),
);

/* --------------------------------- Discord -------------------------------- */

/** Connection state, the invite link, and which department posts to which channel. */
integrationsRouter.get(
  '/discord/overview',
  asyncRoute(async (_req, res) => {
    const config = (await loadIntegration('discord')).config as DiscordConfig;
    const routes = await db.all<{ team_id: string; target: string }>(`SELECT team_id, target FROM team_routing WHERE provider = 'discord'`);
    res.json({
      gateway: discordGatewayStatus(),
      inviteUrl: config.applicationId ? discordInviteUrl(config.applicationId) : null,
      routes: routes.map((row) => ({ teamId: row.team_id, channelId: row.target })),
    });
  }),
);

/** The text channels the bot can see, for the channel pickers. */
integrationsRouter.get(
  '/discord/channels',
  asyncRoute(async (_req, res) => {
    const config = (await loadIntegration('discord')).config as DiscordConfig;
    if (!config.botToken) throw badRequest('Save the bot token first.');
    try {
      res.json({ channels: await listDiscordChannels(config.botToken) });
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : 'Could not reach Discord.');
    }
  }),
);

/** Department channels: each department's tickets go to its own channel instead of the default. */
integrationsRouter.put(
  '/discord/routes',
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const routes = Array.isArray(req.body?.routes) ? (req.body.routes as Array<Record<string, unknown>>) : [];
    for (const route of routes.slice(0, 200)) {
      const teamId = optionalString(route.teamId, 60);
      const channelId = optionalString(route.channelId, 30) ?? '';
      if (!teamId) continue;
      if (channelId && !/^\d{15,25}$/.test(channelId)) throw badRequest('Channel IDs are long numbers, e.g. 1234567890123456789.');
      await setTeamRoute(teamId, 'discord', channelId);
    }
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'integration',
      entityId: 'discord',
      action: 'discord_routes_updated',
      summary: 'Updated which Discord channel each department posts to',
      ip: clientIp(req),
    });
    const rows = await db.all<{ team_id: string; target: string }>(`SELECT team_id, target FROM team_routing WHERE provider = 'discord'`);
    res.json({ routes: rows.map((row) => ({ teamId: row.team_id, channelId: row.target })) });
  }),
);

/**
 * Populates the Linear team dropdown.
 *
 * POST rather than GET, and the key travels in the body: a key in a query
 * string ends up in access logs and browser history.
 *
 * A key typed but not yet saved is accepted, because requiring a save first
 * made the buttons order-dependent - the person had to guess that "Save" came
 * before "Load teams", and got an empty list when they guessed wrong.
 */
integrationsRouter.post(
  '/linear/teams',
  asyncRoute(async (req, res) => {
    const typed = optionalString(req.body?.apiKey, 200);
    const stored = (await loadIntegration('linear')).config.apiKey as string | undefined;
    const apiKey = typed || stored;
    if (!apiKey) throw badRequest('Enter a Linear API key first.', { apiKey: 'Required' });

    try {
      res.json({ teams: await listLinearTeams(apiKey) });
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : 'Could not reach Linear.');
    }
  }),
);

/** Helps the operator confirm which Teams payload format their URL needs. */
integrationsRouter.post(
  '/msteams/detect-format',
  asyncRoute(async (req, res) => {
    const url = optionalString(req.body?.webhookUrl, 500);
    if (!url) throw badRequest('Provide a webhook URL.');
    res.json({ format: detectFormat(url) });
  }),
);

/**
 * The Teams app package, built from what this deployment is configured with.
 *
 * Teams installs an app from a zip of a manifest and two icons, and the
 * values in that manifest are the ones easiest to get wrong by hand: the app
 * id appears twice, the host three times, and a mismatch is rejected with a
 * message that does not say which field. Generating it means the package
 * always matches the bot it is for, and the command menu lists the
 * departments that actually exist.
 */
integrationsRouter.get(
  '/msteams/app-package',
  asyncRoute(async (req, res) => {
    const { options, record } = await packageForDownload();
    try {
      const { filename, zip } = buildTeamsAppPackage(options);
      // Recorded as downloaded, so the next change bumps the version past it.
      await record();
      await recordAudit({
        actorId: (req as AuthedRequest).user.id,
        actorName: (req as AuthedRequest).user.name,
        entityType: 'integration',
        entityId: 'msteams',
        action: 'download_teams_app',
        summary: `Downloaded the Teams app package, version ${options.version}`,
        ip: clientIp(req),
      });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // A stale package installs a bot pointing at the wrong place.
      res.setHeader('Cache-Control', 'no-store');
      res.send(zip);
    } catch (error) {
      if (error instanceof ManifestError) throw badRequest(error.message);
      throw error;
    }
  }),
);

/** The Teams app as an admin looks after it: version, what changed, problems, menu. */
integrationsRouter.get(
  '/msteams/app',
  asyncRoute(async (_req, res) => {
    res.json(await teamsAppState());
  }),
);

integrationsRouter.put(
  '/msteams/app',
  asyncRoute(async (req, res) => {
    const state = await saveTeamsApp(req.body ?? {});
    await recordAudit({
      actorId: (req as AuthedRequest).user.id,
      actorName: (req as AuthedRequest).user.name,
      entityType: 'integration',
      entityId: 'msteams',
      action: 'update_teams_app',
      summary: 'Updated the Teams app details and commands',
      ip: clientIp(req),
    });
    res.json(state);
  }),
);

/** A believable ticket for test sends, so a receiver sees every field it will get. */
function sampleTicket(prefix: string): Ticket {
  const now = new Date().toISOString();
  return {
    id: '00000000-0000-4000-8000-000000000000',
    number: 1000,
    reference: `${prefix}-1000`,
    subject: 'Test ticket: checkout returns "502" for EU customers',
    description: 'This is a sample payload sent by the Test button.',
    descriptionFormat: 'text',
    teamId: null,
    teamName: 'Operations',
    requesterId: null,
    requesterName: 'Sample Requester',
    assigneeId: null,
    assigneeName: null,
    status: 'open',
    priority: 'high',
    type: 'incident',
    source: 'web',
    tags: ['test'],
    escalationLevel: 0,
    dueAt: null,
    firstResponseAt: null,
    resolvedAt: null,
    closedAt: null,
    createdById: null,
    createdByName: null,
    createdAt: now,
    updatedAt: now,
    commentCount: 0,
    attachmentCount: 0,
    watcherIds: [],
    links: [],
    isOverdue: false,
    severity: 'sev2',
    commanderId: null,
    commanderName: null,
    templateId: null,
    templateName: null,
  };
}
