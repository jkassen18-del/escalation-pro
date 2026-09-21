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
import { testSlack } from '../integrations/slack.ts';
import { detectFormat, testMsTeams } from '../integrations/msteams.ts';
import { listLinearTeams, testLinear } from '../integrations/linear.ts';
import { testEmail } from '../integrations/email.ts';
import {
  INTEGRATION_PROVIDERS,
  type IntegrationProvider,
  type IntegrationSummary,
} from '../../shared/types.ts';

export const integrationsRouter: Router = Router();

integrationsRouter.use(requireAuth, requirePermission('integrations.manage'));

/** True once the provider has the minimum fields it needs to send anything. */
function isConfigured(provider: IntegrationProvider, config: Record<string, unknown>): boolean {
  switch (provider) {
    case 'slack':
      return config.mode === 'bot' ? Boolean(config.botToken && config.channel) : Boolean(config.webhookUrl);
    case 'msteams':
      return Boolean(config.webhookUrl);
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

    const record = await saveIntegration(provider, {
      enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
      config: typeof req.body?.config === 'object' && req.body.config ? req.body.config : undefined,
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

/** Populates the Linear team dropdown once an API key has been saved. */
integrationsRouter.get(
  '/linear/teams',
  asyncRoute(async (_req, res) => {
    const record = await loadIntegration('linear');
    const apiKey = record.config.apiKey as string | undefined;
    if (!apiKey) throw badRequest('Save a Linear API key first.');

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
