import { Router, type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { asyncRoute, badRequest, forbidden, notFound } from '../lib/http.ts';
import { recordAudit } from '../lib/audit.ts';
import { can, requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
import {
  approveRequest,
  createApiToken,
  createConfidentialClient,
  deleteConfidentialClient,
  listConfidentialClients,
  updateConfidentialClient,
  denyRequest,
  describeRequest,
  exchangeToken,
  findApiToken,
  listApiTokens,
  listConnectedApps,
  OAUTH_SCOPES,
  OAuthError,
  registerClient,
  resolveBearer,
  revokeApiToken,
  revokeConnectedApp,
  revokeToken,
  startAuthorization,
} from '../mcp/auth.ts';
import { buildMcpServer } from '../mcp/server.ts';
import { getSettings } from '../repositories/settings.ts';
import { connectorBaseUrl, loadConnectorSettings, resourceUri, saveConnectorSettings } from '../mcp/settings.ts';
import type { ConnectorInfo, ConnectorScope } from '../../shared/connector.ts';

/**
 * The Claude connector over HTTP:
 *
 *   /mcp                       the MCP endpoint (Streamable HTTP, stateless)
 *   /.well-known/oauth-*       discovery for MCP clients (RFC 9728, RFC 8414)
 *   /oauth/*                   OAuth 2.1 for claude.ai: register, authorize, token, revoke
 *   /api/connector/*           what the web app uses: settings, tokens, consent
 */

/* ------------------------------- Rate limit ------------------------------- */

/**
 * Per credential, in memory. It protects the database from a runaway agent
 * loop, not from an attacker (who would need a token first), so a per-process
 * window is enough.
 */
const RATE_LIMIT = Number(process.env.MCP_RATE_LIMIT_PER_MIN || 120);
const windows = new Map<string, { start: number; count: number }>();

function overLimit(key: string): number {
  const now = Date.now();
  const entry = windows.get(key);
  if (!entry || now - entry.start >= 60_000) {
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 5000) for (const [k, v] of windows) if (now - v.start >= 60_000) windows.delete(k);
    return 0;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT ? Math.ceil((entry.start + 60_000 - now) / 1000) : 0;
}

/* ---------------------------------- CORS ---------------------------------- */

/**
 * Browser-based MCP clients discover and fetch tokens cross-origin, so the
 * OAuth and metadata endpoints allow any origin - without credentials, since
 * none of them read cookies. /mcp itself gets no CORS at all.
 */
function openCors(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** For errors that must not be redirected (unknown client, unregistered redirect URI). */
function htmlError(res: Response, status: number, title: string, message: string) {
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
        `<body style="font:15px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222">` +
        `<h1 style="font-size:1.2rem">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>` +
        `<p style="color:#666">Close this window and try connecting again from Claude.</p></body>`,
    );
}

function oauthFailure(res: Response, error: unknown) {
  if (error instanceof OAuthError) {
    return res.status(error.status).set('Cache-Control', 'no-store').json({ error: error.code, error_description: error.message });
  }
  console.error('[oauth]', error);
  return res.status(500).json({ error: 'server_error', error_description: 'Something went wrong.' });
}

/* ------------------------------ Public routes ----------------------------- */

export const mcpPublicRouter = Router();

async function protectedResourceMetadata(req: Request) {
  const base = await connectorBaseUrl(req);
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [OAUTH_SCOPES.read, OAUTH_SCOPES.write],
    bearer_methods_supported: ['header'],
    resource_name: 'InfraTicket',
    resource_documentation: `${base}/profile`,
  };
}

/** Discovery documents vanish with the connector, so Claude sees it as gone, not broken. */
const whenEnabled = asyncRoute(async (_req, res, next) => {
  if (!(await loadConnectorSettings()).enabled) return res.status(404).json({ error: 'The Claude connector is turned off.' });
  next();
});

mcpPublicRouter.use(['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/oauth'], openCors);

// RFC 9728 puts the resource's path after the well-known name, so both forms resolve.
mcpPublicRouter.get(
  ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
  whenEnabled,
  asyncRoute(async (req, res) => {
    res.json(await protectedResourceMetadata(req));
  }),
);

mcpPublicRouter.get(
  '/.well-known/oauth-authorization-server',
  whenEnabled,
  asyncRoute(async (req, res) => {
    const base = await connectorBaseUrl(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      // Public clients (claude.ai, Claude Code) use PKCE and no secret; clients
      // an admin created for tools like Copilot Studio authenticate with one.
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [OAUTH_SCOPES.read, OAUTH_SCOPES.write],
      client_id_metadata_document_supported: true,
      service_documentation: `${base}/profile`,
    });
  }),
);

mcpPublicRouter.post(
  '/oauth/register',
  whenEnabled,
  asyncRoute(async (req, res) => {
    try {
      const body = typeof req.body === 'object' && req.body ? (req.body as Record<string, unknown>) : {};
      res.status(201).set('Cache-Control', 'no-store').json(await registerClient(body, req.ip ?? null));
    } catch (error) {
      oauthFailure(res, error);
    }
  }),
);

mcpPublicRouter.get(
  '/oauth/authorize',
  asyncRoute(async (req, res) => {
    if (!(await loadConnectorSettings()).enabled) {
      return htmlError(res, 403, 'Claude connector is turned off', 'An administrator has turned off connecting Claude to InfraTicket.');
    }
    const q = req.query as Record<string, string | undefined>;
    try {
      const outcome = await startAuthorization(
        {
          responseType: String(q.response_type ?? ''),
          clientId: String(q.client_id ?? ''),
          redirectUri: String(q.redirect_uri ?? ''),
          codeChallenge: String(q.code_challenge ?? ''),
          codeChallengeMethod: String(q.code_challenge_method ?? ''),
          state: q.state ? String(q.state) : null,
          scope: q.scope ? String(q.scope) : null,
          resource: q.resource ? String(q.resource) : null,
        },
        await resourceUri(req),
      );
      if ('redirect' in outcome) return res.redirect(302, outcome.redirect);
      // Consent happens in the app itself, at the App URL when one is set: a
      // tunnel may expose only /mcp, /oauth and discovery to the internet, and
      // the person approving signs in on the internal address (office or VPN).
      // Without one, the same host the browser is on. The app shows sign-in
      // first if needed, then the consent screen.
      const settings = await getSettings();
      const appUrl = (settings.appUrl || process.env.APP_URL || '').replace(/\/+$/, '');
      res.redirect(302, `${appUrl}/connect/authorize?request=${encodeURIComponent(outcome.requestId)}`);
    } catch (error) {
      if (error instanceof OAuthError) return htmlError(res, 400, 'Cannot connect this application', error.message);
      throw error;
    }
  }),
);

mcpPublicRouter.post(
  '/oauth/token',
  asyncRoute(async (req, res) => {
    try {
      if (!(await loadConnectorSettings()).enabled) throw new OAuthError('access_denied', 'The Claude connector is turned off.', 403);
      const body = typeof req.body === 'object' && req.body ? (req.body as Record<string, unknown>) : {};
      const tokens = await exchangeToken(body, await resourceUri(req), req.get('authorization'));
      res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).json(tokens);
    } catch (error) {
      oauthFailure(res, error);
    }
  }),
);

// RFC 7009: always 200, whether or not the token existed.
mcpPublicRouter.post(
  '/oauth/revoke',
  asyncRoute(async (req, res) => {
    const token = String((req.body as Record<string, unknown> | undefined)?.token ?? '');
    if (token) await revokeToken(token);
    res.status(200).end();
  }),
);

/* ------------------------------- The endpoint ------------------------------ */

function jsonRpcError(res: Response, status: number, code: number, message: string) {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

mcpPublicRouter.all(
  '/mcp',
  asyncRoute(async (req, res) => {
    const connector = await loadConnectorSettings();
    if (!connector.enabled) return jsonRpcError(res, 403, -32000, 'The Claude connector is turned off in InfraTicket settings.');

    const base = await connectorBaseUrl(req);
    // DNS rebinding guard from the spec: a browser page on another origin must
    // not be able to drive this endpoint. Native clients send no Origin.
    const origin = req.get('origin');
    if (origin) {
      const allowed = new Set([new URL(base).origin, `${req.protocol}://${req.get('host')}`]);
      if (!allowed.has(origin)) return jsonRpcError(res, 403, -32000, 'Requests from this origin are not allowed.');
    }

    const metadataUrl = `${base}/.well-known/oauth-protected-resource`;
    const scopes = `${OAUTH_SCOPES.read} ${OAUTH_SCOPES.write}`;
    const header = req.get('authorization') ?? '';
    // A raw header for clients that send an API key as-is rather than as a
    // Bearer token (Copilot Studio's "API key" option). Personal access tokens
    // only, and never from the query string, where keys end up in logs.
    const rawKey = req.get('x-infraticket-token')?.trim() ?? '';
    if (rawKey && !rawKey.startsWith('itk_')) {
      return jsonRpcError(res, 401, -32001, 'X-InfraTicket-Token only accepts a personal access token (itk_...).');
    }
    const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || rawKey;
    if (!token) {
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}", scope="${scopes}"`);
      return jsonRpcError(res, 401, -32001, 'Authentication required: connect with an InfraTicket access token.');
    }
    const caller = await resolveBearer(token, `${base}/mcp`);
    if ('error' in caller) {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer error="invalid_token", error_description="${caller.description.replace(/"/g, "'")}", resource_metadata="${metadataUrl}"`,
      );
      return jsonRpcError(res, 401, -32001, caller.description);
    }

    // Stateless: no sessions to resume, no server-initiated stream.
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return jsonRpcError(res, 405, -32000, 'Method not allowed: this server is stateless, POST JSON-RPC messages.');
    }

    const retryAfter = overLimit(caller.credentialId);
    if (retryAfter) {
      res.setHeader('Retry-After', String(retryAfter));
      return jsonRpcError(res, 429, -32000, `Too many requests: the limit is ${RATE_LIMIT} a minute per connection.`);
    }

    const server = buildMcpServer({ caller, baseUrl: base, orgMode: connector.mode, ip: req.ip ?? null });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }),
);

/* ---------------------------- App-facing API ------------------------------ */

export const connectorRouter = Router();
connectorRouter.use(requireAuth);

const SCOPES: ConnectorScope[] = ['read', 'read_write'];
const EXPIRY_DAYS = [30, 90, 365];

connectorRouter.get(
  '/info',
  asyncRoute(async (req, res) => {
    const settings = await loadConnectorSettings();
    const base = await connectorBaseUrl(req);
    let publicHttps = false;
    try {
      const url = new URL(base);
      publicHttps = url.protocol === 'https:' && !/^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0)/.test(url.hostname);
    } catch {
      publicHttps = false;
    }
    const info: ConnectorInfo = { settings, mcpUrl: `${base}/mcp`, publicHttps };
    res.json(info);
  }),
);

connectorRouter.put(
  '/settings',
  requirePermission('connector.manage'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const body = (req.body ?? {}) as Record<string, unknown>;
    let next;
    try {
      next = await saveConnectorSettings({
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        mode: body.mode === 'read_only' || body.mode === 'read_write' ? body.mode : undefined,
        publicUrl: typeof body.publicUrl === 'string' ? body.publicUrl : undefined,
      });
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : 'Invalid settings', { publicUrl: 'Invalid address' });
    }
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'settings',
      action: 'connector_settings_updated',
      summary: `${user.name} updated the Claude connector (${next.enabled ? next.mode.replace('_', '-') : 'off'})`,
      meta: { ...next },
      ip: req.ip,
    });
    res.json(next);
  }),
);

connectorRouter.get(
  '/tokens',
  asyncRoute(async (req, res) => {
    res.json(await listApiTokens((req as AuthedRequest).user.id));
  }),
);

connectorRouter.get(
  '/tokens/all',
  requirePermission('connector.manage'),
  asyncRoute(async (_req, res) => {
    res.json(await listApiTokens(null));
  }),
);

connectorRouter.post(
  '/tokens',
  requirePermission('connector.use'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!(await loadConnectorSettings()).enabled) throw forbidden('An administrator has turned off the Claude connector.');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? '').trim().slice(0, 80);
    if (!name) throw badRequest('Give the token a name, such as "Laptop - Claude Code"', { name: 'Required' });
    const scope = SCOPES.includes(body.scope as ConnectorScope) ? (body.scope as ConnectorScope) : 'read';
    const expiresInDays = body.expiresInDays === null || body.expiresInDays === 'never' ? null : Number(body.expiresInDays);
    if (expiresInDays !== null && !EXPIRY_DAYS.includes(expiresInDays)) throw badRequest('Choose 30, 90 or 365 days, or never.');
    const { token, record } = await createApiToken(user.id, { name, scope, expiresInDays });
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'auth',
      entityId: record.id,
      action: 'api_token_created',
      summary: `${user.name} created a Claude access token "${name}" (${scope === 'read' ? 'read only' : 'read and write'})`,
      meta: { scope, expiresAt: record.expiresAt },
      ip: req.ip,
    });
    res.status(201).json({ token, record });
  }),
);

connectorRouter.delete(
  '/tokens/:id',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const token = await findApiToken(String(req.params.id));
    if (!token) throw notFound('Token not found');
    if (token.userId !== user.id && !can(user, 'connector.manage')) throw notFound('Token not found');
    await revokeApiToken(token.id);
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'auth',
      entityId: token.id,
      action: 'api_token_revoked',
      summary:
        token.userId === user.id
          ? `${user.name} revoked their Claude access token "${token.name}"`
          : `${user.name} revoked another user's Claude access token "${token.name}"`,
      meta: { ownerId: token.userId },
      ip: req.ip,
    });
    res.status(204).end();
  }),
);

connectorRouter.get(
  '/apps',
  asyncRoute(async (req, res) => {
    res.json(await listConnectedApps((req as AuthedRequest).user.id));
  }),
);

connectorRouter.delete(
  '/apps/:grantId',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!(await revokeConnectedApp(user.id, String(req.params.grantId)))) throw notFound('Connection not found');
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'auth',
      entityId: String(req.params.grantId),
      action: 'oauth_app_revoked',
      summary: `${user.name} disconnected an app from their account`,
      ip: req.ip,
    });
    res.status(204).end();
  }),
);

/* Consent screen */

connectorRouter.get(
  '/requests/:id',
  asyncRoute(async (req, res) => {
    const settings = await loadConnectorSettings();
    const request = await describeRequest(String(req.params.id), settings.mode);
    if (!request) throw notFound('This sign-in request has expired or was already used. Start again from Claude.');
    res.json(request);
  }),
);

connectorRouter.post(
  '/requests/:id/approve',
  requirePermission('connector.use'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const settings = await loadConnectorSettings();
    if (!settings.enabled) throw forbidden('An administrator has turned off the Claude connector.');
    const request = await describeRequest(String(req.params.id), settings.mode);
    if (!request) throw notFound('This sign-in request has expired or was already used. Start again from Claude.');
    const asked = (req.body as Record<string, unknown> | undefined)?.scope;
    // The person may grant less than was asked for, never more.
    const scope: ConnectorScope = asked === 'read' || request.scope === 'read' ? 'read' : 'read_write';
    const redirectTo = await approveRequest(request.id, user, scope);
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'auth',
      action: 'oauth_app_approved',
      summary: `${user.name} connected ${request.clientName} (${scope === 'read' ? 'read only' : 'read and write'})`,
      meta: { clientId: request.clientId, redirectHost: request.redirectHost, scope },
      ip: req.ip,
    });
    res.json({ redirectTo });
  }),
);

connectorRouter.post(
  '/requests/:id/deny',
  asyncRoute(async (req, res) => {
    res.json({ redirectTo: await denyRequest(String(req.params.id)) });
  }),
);

/* Confidential OAuth clients (admin) */

connectorRouter.get(
  '/clients',
  requirePermission('connector.manage'),
  asyncRoute(async (_req, res) => {
    res.json(await listConfidentialClients());
  }),
);

connectorRouter.post(
  '/clients',
  requirePermission('connector.manage'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { client, clientSecret } = await createConfidentialClient({ name: String(body.name ?? ''), redirectUris: body.redirectUris }, user.id);
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'settings',
      entityId: client.clientId,
      action: 'oauth_client_created',
      summary: `${user.name} created the OAuth client "${client.name}"`,
      meta: { redirectUris: client.redirectUris },
      ip: req.ip,
    });
    res.status(201).json({ client, clientSecret });
  }),
);

connectorRouter.patch(
  '/clients/:id',
  requirePermission('connector.manage'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const client = await updateConfidentialClient(String(req.params.id), {
      name: typeof body.name === 'string' ? body.name : undefined,
      redirectUris: body.redirectUris,
    });
    if (!client) throw notFound('Client not found');
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'settings',
      entityId: client.clientId,
      action: 'oauth_client_updated',
      summary: `${user.name} updated the OAuth client "${client.name}"`,
      meta: { redirectUris: client.redirectUris },
      ip: req.ip,
    });
    res.json(client);
  }),
);

connectorRouter.delete(
  '/clients/:id',
  requirePermission('connector.manage'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!(await deleteConfidentialClient(String(req.params.id)))) throw notFound('Client not found');
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'settings',
      entityId: String(req.params.id),
      action: 'oauth_client_deleted',
      summary: `${user.name} deleted an OAuth client and disconnected everyone using it`,
      ip: req.ip,
    });
    res.status(204).end();
  }),
);
