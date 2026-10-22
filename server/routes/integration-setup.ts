import { Router, type Request } from 'express';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { asyncRoute, badRequest, optionalString } from '../lib/http.ts';
import type { AuthedRequest } from '../middleware/auth.ts';
import { getOpsSetting, setOpsSetting } from '../repositories/settings.ts';
import { loadIntegration, saveIntegration } from '../integrations/store.ts';
import { testSlack } from '../integrations/slack.ts';
import { setIntegrationStatus } from '../integrations/store.ts';
import { consumeOAuthState, createOAuthState, STATE_MESSAGES } from '../integrations/oauth-state.ts';
import type { TeamsConsentRecord } from '../integrations/catalogue.ts';
import {
  appBaseUrl,
  authorizeUrl,
  buildSlackManifest,
  completeInstall,
  isPublicHttps,
  listSlackChannels,
  manifestCreateUrl,
  publicSlackApp,
  saveSlackApp,
  SLACK_BOT_SCOPES,
} from '../integrations/slack-install.ts';

/**
 * Guided, one-click setup for the Integrations catalogue. Mounted inside the
 * integrations router, so everything here already needs integrations.manage.
 *
 * The two OAuth callbacks are reached by the browser coming back from Slack
 * or Microsoft. They carry the admin's session cookie (a top-level GET is
 * allowed by SameSite=Lax), and they only act on a state value this server
 * issued to that same session.
 */
export const integrationSetupRouter: Router = Router();

const originOf = (req: Request) => `${req.protocol}://${req.get('host')}`;
const userOf = (req: Request) => (req as AuthedRequest).user;

async function audit(req: Request, action: string, summary: string, meta?: Record<string, unknown>) {
  const user = userOf(req);
  await recordAudit({ actorId: user.id, actorName: user.name, entityType: 'integration', action, summary, meta: meta ?? null, ip: clientIp(req) });
}

function backToCatalogue(setup: string, params: Record<string, string>): string {
  return `/integrations?${new URLSearchParams({ setup, ...params })}`;
}

/* --------------------------------- Slack ---------------------------------- */

integrationSetupRouter.get(
  '/slack/setup',
  asyncRoute(async (req, res) => {
    const base = await appBaseUrl(originOf(req));
    const app = await publicSlackApp();
    const manifest = buildSlackManifest(base, { appName: app.appName, command: app.command });
    res.json({
      app,
      base,
      publicUrl: isPublicHttps(base),
      manifest,
      createUrl: manifestCreateUrl(manifest),
      scopes: SLACK_BOT_SCOPES,
      redirectUrl: `${base}/api/integrations/slack/oauth/callback`,
    });
  }),
);

integrationSetupRouter.put(
  '/slack/app',
  asyncRoute(async (req, res) => {
    const app = await saveSlackApp(req.body ?? {});
    await audit(req, 'slack_app_saved', 'Saved the Slack app credentials');
    res.json({ app });
  }),
);

integrationSetupRouter.post(
  '/slack/oauth/start',
  asyncRoute(async (req, res) => {
    const base = await appBaseUrl(originOf(req));
    const state = await createOAuthState('slack-install', userOf(req).id, req.sessionID);
    const url = await authorizeUrl(state, base);
    await audit(req, 'slack_install_started', 'Started adding the app to Slack');
    res.json({ url });
  }),
);

integrationSetupRouter.get(
  '/slack/oauth/callback',
  asyncRoute(async (req, res) => {
    const state = String(req.query.state ?? '');
    const check = await consumeOAuthState(state, 'slack-install', userOf(req).id, req.sessionID);
    if (check !== 'ok') {
      await audit(req, 'slack_install_refused', `Refused a Slack install callback (${check})`);
      return res.redirect(backToCatalogue('slack', { slack: 'error', reason: STATE_MESSAGES[check] }));
    }
    if (req.query.error) {
      const reason = req.query.error === 'access_denied' ? 'The install was cancelled in Slack.' : `Slack said: ${String(req.query.error).slice(0, 100)}`;
      return res.redirect(backToCatalogue('slack', { slack: 'error', reason }));
    }
    const code = optionalString(req.query.code, 500);
    if (!code) return res.redirect(backToCatalogue('slack', { slack: 'error', reason: 'Slack did not send an authorisation code.' }));
    try {
      const { team } = await completeInstall(code, await appBaseUrl(originOf(req)));
      await audit(req, 'slack_installed', `Added the app to the Slack workspace "${team}"`);
      res.redirect(backToCatalogue('slack', { slack: 'installed', team }));
    } catch (error) {
      const reason = (error as Error).message.slice(0, 200);
      await audit(req, 'slack_install_failed', `Adding the app to Slack failed: ${reason}`);
      res.redirect(backToCatalogue('slack', { slack: 'error', reason }));
    }
  }),
);

integrationSetupRouter.get(
  '/slack/channels',
  asyncRoute(async (_req, res) => {
    res.json({ channels: await listSlackChannels() });
  }),
);

/** Picks the channel, switches Slack on, and runs the real connection test. */
integrationSetupRouter.put(
  '/slack/channel',
  asyncRoute(async (req, res) => {
    const channel = optionalString(req.body?.channel, 40);
    if (!channel || !/^[CG][A-Z0-9]+$/.test(channel)) throw badRequest('Pick a channel.');
    await saveIntegration('slack', { enabled: true, config: { mode: 'bot', channel } });
    const result = await testSlack(await loadIntegration('slack'));
    await setIntegrationStatus('slack', result.ok ? 'ok' : 'error', result.ok ? null : result.message);
    await audit(req, 'slack_channel_set', `Set the Slack channel to ${channel}`, { ok: result.ok });
    res.json({ result });
  }),
);

/* ---------------------------- Microsoft Teams ----------------------------- */

integrationSetupRouter.get(
  '/msteams/consent',
  asyncRoute(async (req, res) => {
    const base = await appBaseUrl(originOf(req));
    const record = await loadIntegration('msteams');
    res.json({
      consent: await getOpsSetting<TeamsConsentRecord>('msteams-consent', {}),
      appId: (record.config.appId as string | undefined) || null,
      tenantId: (record.config.tenantId as string | undefined) || null,
      redirectUrl: `${base}/api/integrations/msteams/consent/callback`,
    });
  }),
);

/**
 * Microsoft's admin consent: a Global or Cloud Application Administrator
 * approves every application permission the bot's app registration asks for
 * (messaging, and Calls.Initiate.All / User.Read.All for Teams calls) in one go.
 */
integrationSetupRouter.post(
  '/msteams/consent/start',
  asyncRoute(async (req, res) => {
    const record = await loadIntegration('msteams');
    const appId = record.config.appId as string | undefined;
    if (!appId) throw badRequest('Save the bot\'s Microsoft App ID under Microsoft Teams first.');
    const tenant = (record.config.tenantId as string | undefined) || 'organizations';
    const base = await appBaseUrl(originOf(req));
    const state = await createOAuthState('msteams-consent', userOf(req).id, req.sessionID);
    const params = new URLSearchParams({ client_id: appId, redirect_uri: `${base}/api/integrations/msteams/consent/callback`, state });
    await audit(req, 'msteams_consent_started', 'Started Microsoft admin consent for the Teams bot');
    res.json({ url: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/adminconsent?${params}` });
  }),
);

integrationSetupRouter.get(
  '/msteams/consent/callback',
  asyncRoute(async (req, res) => {
    const state = String(req.query.state ?? '');
    const check = await consumeOAuthState(state, 'msteams-consent', userOf(req).id, req.sessionID);
    if (check !== 'ok') {
      await audit(req, 'msteams_consent_refused', `Refused a Microsoft consent callback (${check})`);
      return res.redirect(backToCatalogue('msteams', { consent: 'failed', reason: STATE_MESSAGES[check] }));
    }
    const now = new Date().toISOString();
    if (req.query.error || String(req.query.admin_consent ?? '').toLowerCase() !== 'true') {
      const reason = String(req.query.error_description ?? req.query.error ?? 'Consent was not granted.').slice(0, 300);
      await setOpsSetting('msteams-consent', { error: reason, failedAt: now } satisfies TeamsConsentRecord);
      await audit(req, 'msteams_consent_failed', `Microsoft admin consent was not granted: ${reason}`);
      return res.redirect(backToCatalogue('msteams', { consent: 'failed', reason }));
    }
    const tenant = optionalString(req.query.tenant, 100) ?? undefined;
    await setOpsSetting('msteams-consent', { grantedAt: now, tenant } satisfies TeamsConsentRecord);
    await audit(req, 'msteams_consent_granted', `Microsoft admin consent granted${tenant ? ` for tenant ${tenant}` : ''}`);
    res.redirect(backToCatalogue('msteams', { consent: 'granted' }));
  }),
);
