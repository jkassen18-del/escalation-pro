import { Router } from 'express';
import { asyncRoute, badRequest, optionalString, requireEnum } from '../lib/http.ts';
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
import { listDeliveries } from '../integrations/dispatcher.ts';
import { assertSafeWebhookUrl, assertSlackWebhookUrl } from '../integrations/url-guard.ts';
import { testSlack } from '../integrations/slack.ts';
import { detectFormat, testMsTeams } from '../integrations/msteams.ts';
import { listLinearTeams, testLinear } from '../integrations/linear.ts';
import { testEmail } from '../integrations/email.ts';
import {
  INTEGRATION_PROVIDERS,
  type IntegrationProvider,
  type IntegrationSummary,
} from '../../shared/types.ts';
import { buildTeamsAppPackage, ManifestError } from '../integrations/teams-manifest.ts';
import { listTeams } from '../repositories/teams.ts';
import { getSettings } from '../repositories/settings.ts';
import type { MsTeamsConfig } from '../integrations/msteams.ts';

export const integrationsRouter: Router = Router();

integrationsRouter.use(requireAuth, requirePermission('integrations.manage'));

/** True once the provider has the minimum fields it needs to send anything. */
function isConfigured(provider: IntegrationProvider, config: Record<string, unknown>): boolean {
  switch (provider) {
    case 'slack':
      return config.mode === 'bot' ? Boolean(config.botToken && config.channel) : Boolean(config.webhookUrl);
    case 'msteams':
      return config.mode === 'bot'
        ? Boolean(config.appId && config.appPassword)
        : Boolean(config.webhookUrl);
    case 'linear':
      return Boolean(config.apiKey && config.teamId);
    case 'email':
      return Boolean(config.host && (config.fromEmail || config.username));
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
  asyncRoute(async (_req, res) => {
    const record = await loadIntegration('msteams');
    const config = record.config as MsTeamsConfig;
    const settings = await getSettings();

    const appUrl = settings.appUrl || process.env.APP_URL || '';
    if (!appUrl) {
      throw badRequest(
        'Set the app URL in Settings first. Teams needs to know where this deployment lives, and Microsoft has to be able to reach it.',
      );
    }

    try {
      const { filename, zip } = buildTeamsAppPackage({
        appId: config.appId ?? '',
        appUrl,
        botName: config.botName,
        organizationName: settings.organizationName,
        teams: await listTeams(),
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
