import crypto from 'node:crypto';
import { db, parseJson } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import { assertOutboundUrl } from '../integrations/url-guard.ts';
import { findUserById } from '../repositories/users.ts';
import type { PublicUser } from '../../shared/types.ts';
import type { ApiToken, ConfidentialClient, ConnectedApp, ConnectorScope, OAuthConsentRequest } from '../../shared/connector.ts';

/**
 * Credentials for the Claude connector.
 *
 * Two ways in, one identity: a personal access token (for Claude Code or
 * Claude Desktop on the company network) or an OAuth 2.1 grant (for
 * claude.ai, which registers itself and asks the person to approve it).
 * Either way every request runs as that person, with their permissions.
 *
 * Nothing secret is stored in the clear: tokens, codes and refresh tokens are
 * kept as SHA-256 hashes, so a database dump hands out no working credential.
 */

export const OAUTH_SCOPES = { read: 'infraticket:read', write: 'infraticket:write' } as const;
const ACCESS_TTL_SECS = 60 * 60;
const REFRESH_TTL_SECS = 30 * 24 * 60 * 60;
const CODE_TTL_SECS = 60;
const REQUEST_TTL_SECS = 10 * 60;

export function hashSecret(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function newSecret(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

function iso(offsetSecs = 0): string {
  return new Date(Date.now() + offsetSecs * 1000).toISOString();
}

/**
 * Scope names a client may ask for. The short `read` / `read_write` forms are
 * for clients configured by hand (Copilot Studio's "Manual" OAuth), and
 * `offline_access` is accepted and ignored: refresh tokens are always issued.
 */
const WRITE_SCOPES = new Set<string>([OAUTH_SCOPES.write, 'read_write']);
const KNOWN_SCOPES = new Set<string>([OAUTH_SCOPES.read, OAUTH_SCOPES.write, 'read', 'read_write', 'offline_access']);

function scopeParts(scope: string | null | undefined): string[] {
  return String(scope ?? '').split(/\s+/).filter((part) => part && part !== 'offline_access');
}

/** OAuth scope strings to the connector's two levels. Write includes read. */
export function scopeFromOAuth(scope: string | null | undefined): ConnectorScope {
  const parts = scopeParts(scope);
  if (!parts.length) return 'read_write';
  return parts.some((part) => WRITE_SCOPES.has(part)) ? 'read_write' : 'read';
}

export function oauthScopeString(scope: ConnectorScope): string {
  return scope === 'read_write' ? `${OAUTH_SCOPES.read} ${OAUTH_SCOPES.write}` : OAUTH_SCOPES.read;
}

/* ------------------------- Personal access tokens ------------------------- */

interface ApiTokenRow {
  id: string;
  user_id: string;
  user_name?: string | null;
  name: string;
  token_prefix: string;
  scope: ConnectorScope;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

function mapApiToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name ?? null,
    name: row.name,
    prefix: row.token_prefix,
    scope: row.scope === 'read_write' ? 'read_write' : 'read',
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

export async function createApiToken(
  userId: string,
  input: { name: string; scope: ConnectorScope; expiresInDays: number | null },
): Promise<{ token: string; record: ApiToken }> {
  const token = newSecret('itk');
  const id = randomId();
  await db.run(
    `INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      userId,
      input.name,
      hashSecret(token),
      `${token.slice(0, 8)}…`,
      input.scope,
      input.expiresInDays ? iso(input.expiresInDays * 86_400) : null,
      iso(),
    ],
  );
  const row = await db.get<ApiTokenRow>(`SELECT * FROM api_tokens WHERE id = ?`, [id]);
  return { token, record: mapApiToken(row!) };
}

/** Active tokens; every user's when `userId` is null (the admin view). */
export async function listApiTokens(userId: string | null): Promise<ApiToken[]> {
  const rows = await db.all<ApiTokenRow>(
    `SELECT t.*, u.name AS user_name FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.revoked_at IS NULL ${userId ? 'AND t.user_id = ?' : ''} ORDER BY t.created_at DESC`,
    userId ? [userId] : [],
  );
  return rows.map(mapApiToken);
}

export async function findApiToken(id: string): Promise<ApiToken | null> {
  const row = await db.get<ApiTokenRow>(`SELECT * FROM api_tokens WHERE id = ? AND revoked_at IS NULL`, [id]);
  return row ? mapApiToken(row) : null;
}

export async function revokeApiToken(id: string): Promise<void> {
  await db.run(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, [iso(), id]);
}

/* --------------------------------- Clients -------------------------------- */

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  /** dcr/cimd are public (PKCE, no secret); confidential ones an admin created, with a secret. */
  kind: 'dcr' | 'cimd' | 'confidential';
}

interface ClientRow {
  id: string;
  client_name: string;
  redirect_uris: string;
  kind: string;
  secret_hash: string | null;
  created_by: string | null;
  fetched_at: string | null;
  created_at: string;
}

function mapClient(row: ClientRow): OAuthClient {
  return {
    id: row.id,
    name: row.client_name,
    redirectUris: parseJson<string[]>(row.redirect_uris, []),
    kind: row.kind === 'cimd' ? 'cimd' : row.kind === 'confidential' ? 'confidential' : 'dcr',
  };
}

/** https anywhere, or http only back to this machine - the rule OAuth 2.1 and MCP set. */
export function validRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return false;
}

const REGISTRATIONS_PER_HOUR = 20;

/** Dynamic client registration (RFC 7591). Public clients only: no secrets are issued. */
export async function registerClient(body: Record<string, unknown>, ip: string | null): Promise<Record<string, unknown>> {
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String).slice(0, 10) : [];
  if (!redirectUris.length) throw new OAuthError('invalid_redirect_uri', 'At least one redirect_uris entry is required.');
  for (const uri of redirectUris) {
    if (!validRedirectUri(uri)) throw new OAuthError('invalid_redirect_uri', `Redirect URI must be https, or http to localhost: ${uri}`);
  }
  const method = body.token_endpoint_auth_method ?? 'none';
  if (method !== 'none') throw new OAuthError('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") can register.');
  const grantTypes = Array.isArray(body.grant_types) ? body.grant_types.map(String) : ['authorization_code', 'refresh_token'];
  if (grantTypes.some((grant) => grant !== 'authorization_code' && grant !== 'refresh_token')) {
    throw new OAuthError('invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported.');
  }

  const since = iso(-3600);
  const recent = await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM oauth_clients WHERE created_ip = ? AND created_at >= ?`, [ip ?? '', since]);
  if (Number(recent?.n ?? 0) >= REGISTRATIONS_PER_HOUR) throw new OAuthError('too_many_requests', 'Too many client registrations from this address. Try again later.', 429);

  const name = String(body.client_name ?? 'Unnamed client').trim().slice(0, 120) || 'Unnamed client';
  const id = `itc_${crypto.randomBytes(16).toString('base64url')}`;
  const now = iso();
  await db.run(`INSERT INTO oauth_clients (id, client_name, redirect_uris, kind, created_ip, created_at) VALUES (?, ?, ?, 'dcr', ?, ?)`, [
    id,
    name,
    JSON.stringify(redirectUris),
    ip ?? '',
    now,
  ]);
  return {
    client_id: id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

const CIMD_TTL_MS = 60 * 60 * 1000;

/**
 * A client known by registration, or by a Client ID Metadata Document: an
 * https URL that is both the client's id and where its metadata lives.
 */
export async function getClient(clientId: string): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 2000) return null;
  const row = await db.get<ClientRow>(`SELECT * FROM oauth_clients WHERE id = ?`, [clientId]);
  const fresh = row && (row.kind !== 'cimd' || (row.fetched_at && Date.now() - new Date(row.fetched_at).getTime() < CIMD_TTL_MS));
  if (row && fresh) return mapClient(row);
  if (!/^https:\/\//i.test(clientId)) return null;
  return fetchClientMetadata(clientId);
}

async function fetchClientMetadata(clientId: string): Promise<OAuthClient | null> {
  try {
    const url = new URL(clientId);
    if (url.pathname === '/' || url.hash) return null;
    // The same refusal of private and metadata addresses as outbound webhooks.
    assertOutboundUrl(clientId, 'client_id');
    const response = await fetch(clientId, { signal: AbortSignal.timeout(5000), redirect: 'error', headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 20_000) return null;
    const doc = JSON.parse(text) as Record<string, unknown>;
    if (doc.client_id !== clientId) return null;
    const redirectUris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.map(String).filter(validRedirectUri).slice(0, 10) : [];
    if (!redirectUris.length) return null;
    const name = String(doc.client_name ?? url.hostname).slice(0, 120);
    const now = iso();
    await db.run(
      `INSERT INTO oauth_clients (id, client_name, redirect_uris, kind, fetched_at, created_at) VALUES (?, ?, ?, 'cimd', ?, ?)
       ON CONFLICT (id) DO UPDATE SET client_name = excluded.client_name, redirect_uris = excluded.redirect_uris, fetched_at = excluded.fetched_at`,
      [clientId, name, JSON.stringify(redirectUris), now, now],
    );
    return { id: clientId, name, redirectUris, kind: 'cimd' };
  } catch {
    return null;
  }
}

/* -------------------------- Confidential clients -------------------------- */

/**
 * Clients an administrator registers by hand, for tools that cannot register
 * themselves and expect a client id and secret - Microsoft Copilot Studio's
 * "Manual" OAuth, for one. The secret is shown once and stored hashed.
 */
function toConfidential(row: ClientRow): ConfidentialClient {
  return { clientId: row.id, name: row.client_name, redirectUris: parseJson<string[]>(row.redirect_uris, []), createdAt: row.created_at };
}

function checkRedirects(uris: unknown): string[] {
  const list = (Array.isArray(uris) ? uris : String(uris ?? '').split(/[\s,]+/))
    .map((uri) => String(uri).trim())
    .filter(Boolean)
    .slice(0, 10);
  for (const uri of list) {
    if (!validRedirectUri(uri)) throw badRequest(`Redirect URLs must be https (or http to localhost): ${uri}`, { redirectUris: 'Invalid URL' });
  }
  return list;
}

export async function listConfidentialClients(): Promise<ConfidentialClient[]> {
  const rows = await db.all<ClientRow>(`SELECT * FROM oauth_clients WHERE kind = 'confidential' ORDER BY created_at DESC`);
  return rows.map(toConfidential);
}

export async function createConfidentialClient(
  input: { name: string; redirectUris: unknown },
  createdBy: string,
): Promise<{ client: ConfidentialClient; clientSecret: string }> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw badRequest('Give the client a name, such as "Copilot Studio - IT helpdesk agent"', { name: 'Required' });
  // Copilot Studio shows its callback URL only after the client exists, so an
  // empty list is allowed now and filled in afterwards.
  const redirectUris = checkRedirects(input.redirectUris);
  const id = `itc_${crypto.randomBytes(16).toString('base64url')}`;
  const secret = newSecret('its');
  await db.run(
    `INSERT INTO oauth_clients (id, client_name, redirect_uris, kind, secret_hash, created_by, created_at) VALUES (?, ?, ?, 'confidential', ?, ?, ?)`,
    [id, name, JSON.stringify(redirectUris), hashSecret(secret), createdBy, iso()],
  );
  const row = await db.get<ClientRow>(`SELECT * FROM oauth_clients WHERE id = ?`, [id]);
  return { client: toConfidential(row!), clientSecret: secret };
}

export async function updateConfidentialClient(id: string, input: { name?: string; redirectUris?: unknown }): Promise<ConfidentialClient | null> {
  const row = await db.get<ClientRow>(`SELECT * FROM oauth_clients WHERE id = ? AND kind = 'confidential'`, [id]);
  if (!row) return null;
  const name = input.name !== undefined ? input.name.trim().slice(0, 120) || row.client_name : row.client_name;
  const redirectUris = input.redirectUris !== undefined ? checkRedirects(input.redirectUris) : parseJson<string[]>(row.redirect_uris, []);
  await db.run(`UPDATE oauth_clients SET client_name = ?, redirect_uris = ? WHERE id = ?`, [name, JSON.stringify(redirectUris), id]);
  return toConfidential({ ...row, client_name: name, redirect_uris: JSON.stringify(redirectUris) });
}

/** Deleting a client disconnects everyone who used it. */
export async function deleteConfidentialClient(id: string): Promise<boolean> {
  const row = await db.get<ClientRow>(`SELECT * FROM oauth_clients WHERE id = ? AND kind = 'confidential'`, [id]);
  if (!row) return false;
  const grants = await db.all<{ id: string }>(`SELECT id FROM oauth_grants WHERE client_id = ?`, [id]);
  for (const grant of grants) await revokeGrant(grant.id);
  await db.run(`DELETE FROM oauth_clients WHERE id = ?`, [id]);
  return true;
}

/** client_secret_basic (RFC 6749 2.3.1: both parts form-encoded) or client_secret_post. */
function clientCredentials(body: Record<string, unknown>, authorization: string | undefined): { id: string; secret: string | null } {
  const basic = /^Basic\s+(.+)$/i.exec(authorization ?? '')?.[1];
  if (basic) {
    const decoded = Buffer.from(basic, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) throw new OAuthError('invalid_client', 'Malformed Basic credentials.', 401);
    const decode = (value: string) => {
      try {
        return decodeURIComponent(value.replace(/\+/g, ' '));
      } catch {
        return value;
      }
    };
    const id = decode(decoded.slice(0, colon));
    if (body.client_id && String(body.client_id) !== id) throw new OAuthError('invalid_request', 'client_id does not match the Basic credentials.');
    return { id, secret: decode(decoded.slice(colon + 1)) };
  }
  return { id: String(body.client_id ?? ''), secret: body.client_secret ? String(body.client_secret) : null };
}

async function authenticateClient(body: Record<string, unknown>, authorization: string | undefined): Promise<OAuthClient> {
  const { id, secret } = clientCredentials(body, authorization);
  if (!id) throw new OAuthError('invalid_client', 'client_id is required.', 401);
  const client = await getClient(id);
  if (!client) throw new OAuthError('invalid_client', 'Unknown client.', 401);
  if (client.kind === 'confidential') {
    const row = await db.get<ClientRow>(`SELECT * FROM oauth_clients WHERE id = ?`, [id]);
    const expected = Buffer.from(row?.secret_hash ?? '', 'hex');
    const given = Buffer.from(hashSecret(secret ?? ''), 'hex');
    if (!secret || expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
    }
  } else if (secret) {
    throw new OAuthError('invalid_client', 'This client is public and has no secret.', 401);
  }
  return client;
}

/* --------------------------- Authorization flow --------------------------- */

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

export interface AuthorizeParams {
  responseType: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  state: string | null;
  scope: string | null;
  resource: string | null;
}

/**
 * Checks an authorization request and parks it for the consent screen.
 *
 * Errors about the client or redirect URI are thrown (shown to the person,
 * never redirected - sending someone to an unverified URL is the attack).
 * Everything else comes back as a redirect carrying the OAuth error.
 */
export async function startAuthorization(
  params: AuthorizeParams,
  expectedResource: string,
): Promise<{ requestId: string } | { redirect: string }> {
  const client = await getClient(params.clientId);
  if (!client) throw new OAuthError('invalid_client', 'This application is not registered with InfraTicket.');
  if (!params.redirectUri || !client.redirectUris.includes(params.redirectUri)) {
    throw new OAuthError('invalid_request', 'The redirect address does not match what the application registered.');
  }
  const back = (error: string, description: string) => {
    const url = new URL(params.redirectUri);
    url.searchParams.set('error', error);
    url.searchParams.set('error_description', description);
    if (params.state) url.searchParams.set('state', params.state);
    return { redirect: url.toString() };
  };
  if (params.responseType !== 'code') return back('unsupported_response_type', 'Only the authorization code flow is supported.');
  // PKCE is required of every public client. A confidential client proves
  // itself with its secret at the token endpoint, so PKCE is optional for it -
  // but if it sends a challenge, the challenge is checked like anyone's.
  if (params.codeChallenge || client.kind !== 'confidential') {
    if (params.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge ?? '')) {
      return back('invalid_request', 'PKCE with S256 is required.');
    }
  }
  const resource = params.resource ?? expectedResource;
  if (normaliseResource(resource) !== normaliseResource(expectedResource)) {
    return back('invalid_target', `This server only issues tokens for ${expectedResource}.`);
  }
  const requested = String(params.scope ?? '').split(/\s+/).filter(Boolean);
  if (requested.some((scope) => !KNOWN_SCOPES.has(scope))) {
    return back('invalid_scope', `Supported scopes: ${OAUTH_SCOPES.read} ${OAUTH_SCOPES.write} (or read / read_write).`);
  }
  const id = crypto.randomBytes(18).toString('base64url');
  await db.run(
    `INSERT INTO oauth_requests (id, client_id, redirect_uri, scope, state, code_challenge, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, client.id, params.redirectUri, scopeFromOAuth(params.scope), params.state, params.codeChallenge || null, normaliseResource(resource), iso(REQUEST_TTL_SECS), iso()],
  );
  return { requestId: id };
}

export function normaliseResource(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return value;
  }
}

interface RequestRow {
  id: string;
  client_id: string;
  redirect_uri: string;
  scope: ConnectorScope;
  state: string | null;
  code_challenge: string | null;
  resource: string;
  expires_at: string;
}

async function loadRequest(id: string): Promise<RequestRow | null> {
  const row = await db.get<RequestRow>(`SELECT * FROM oauth_requests WHERE id = ?`, [id]);
  if (!row || row.expires_at < iso()) return null;
  return row;
}

export async function describeRequest(id: string, orgMode: 'read_write' | 'read_only'): Promise<OAuthConsentRequest | null> {
  const row = await loadRequest(id);
  if (!row) return null;
  const client = await getClient(row.client_id);
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: client?.name ?? 'Unknown application',
    redirectHost: new URL(row.redirect_uri).host,
    scope: row.scope,
    effectiveScope: orgMode === 'read_only' ? 'read' : row.scope,
    expiresAt: row.expires_at,
  };
}

/** The person said yes: issue a single-use, 60-second code and send them back. */
export async function approveRequest(id: string, user: PublicUser, chosenScope: ConnectorScope): Promise<string> {
  const row = await loadRequest(id);
  if (!row) throw badRequest('This sign-in request has expired. Start again from Claude.');
  await db.run(`DELETE FROM oauth_requests WHERE id = ?`, [id]);
  // The person can grant less than was asked for, never more.
  const scope: ConnectorScope = row.scope === 'read' ? 'read' : chosenScope;
  const grantId = randomId();
  const now = iso();
  await db.run(`INSERT INTO oauth_grants (id, client_id, user_id, scope, resource, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
    grantId,
    row.client_id,
    user.id,
    scope,
    row.resource,
    now,
  ]);
  const code = crypto.randomBytes(32).toString('base64url');
  await db.run(
    `INSERT INTO oauth_tokens (id, grant_id, kind, token_hash, redirect_uri, code_challenge, expires_at, created_at) VALUES (?, ?, 'code', ?, ?, ?, ?, ?)`,
    [randomId(), grantId, hashSecret(code), row.redirect_uri, row.code_challenge, iso(CODE_TTL_SECS), now],
  );
  const url = new URL(row.redirect_uri);
  url.searchParams.set('code', code);
  if (row.state) url.searchParams.set('state', row.state);
  return url.toString();
}

export async function denyRequest(id: string): Promise<string> {
  const row = await loadRequest(id);
  if (!row) throw badRequest('This sign-in request has expired.');
  await db.run(`DELETE FROM oauth_requests WHERE id = ?`, [id]);
  const url = new URL(row.redirect_uri);
  url.searchParams.set('error', 'access_denied');
  url.searchParams.set('error_description', 'The person declined to connect.');
  if (row.state) url.searchParams.set('state', row.state);
  return url.toString();
}

/* ---------------------------------- Tokens -------------------------------- */

interface TokenRow {
  id: string;
  grant_id: string;
  kind: 'code' | 'access' | 'refresh';
  redirect_uri: string | null;
  code_challenge: string | null;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

interface GrantRow {
  id: string;
  client_id: string;
  user_id: string;
  scope: ConnectorScope;
  resource: string;
  revoked_at: string | null;
}

async function issueTokens(grant: GrantRow): Promise<Record<string, unknown>> {
  const access = newSecret('ita');
  const refresh = newSecret('itr');
  const now = iso();
  await db.run(`INSERT INTO oauth_tokens (id, grant_id, kind, token_hash, expires_at, created_at) VALUES (?, ?, 'access', ?, ?, ?)`, [
    randomId(),
    grant.id,
    hashSecret(access),
    iso(ACCESS_TTL_SECS),
    now,
  ]);
  await db.run(`INSERT INTO oauth_tokens (id, grant_id, kind, token_hash, expires_at, created_at) VALUES (?, ?, 'refresh', ?, ?, ?)`, [
    randomId(),
    grant.id,
    hashSecret(refresh),
    iso(REFRESH_TTL_SECS),
    now,
  ]);
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECS,
    refresh_token: refresh,
    scope: oauthScopeString(grant.scope),
  };
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  return computed.length === challenge.length && crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
}

async function revokeGrant(grantId: string): Promise<void> {
  const now = iso();
  await db.run(`UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`, [now, grantId]);
  await db.run(`UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE grant_id = ?`, [now, grantId]);
}

/** The token endpoint: authorization_code and refresh_token grants. */
export async function exchangeToken(
  body: Record<string, unknown>,
  expectedResource: string,
  authorization?: string,
): Promise<Record<string, unknown>> {
  const grantType = String(body.grant_type ?? '');
  const client = await authenticateClient(body, authorization);

  const checkResource = (grant: GrantRow) => {
    const asked = body.resource ? normaliseResource(String(body.resource)) : grant.resource;
    if (asked !== grant.resource || grant.resource !== normaliseResource(expectedResource)) {
      throw new OAuthError('invalid_target', 'The resource does not match the one this grant was issued for.');
    }
  };

  if (grantType === 'authorization_code') {
    const code = String(body.code ?? '');
    const row = await db.get<TokenRow>(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'code'`, [hashSecret(code)]);
    if (!row) throw new OAuthError('invalid_grant', 'The authorization code is not valid.');
    const grant = await db.get<GrantRow>(`SELECT * FROM oauth_grants WHERE id = ?`, [row.grant_id]);
    if (!grant || grant.client_id !== client.id) throw new OAuthError('invalid_grant', 'The authorization code was issued to another client.');
    if (row.used_at) {
      // A replayed code means it leaked: everything issued from it goes.
      await revokeGrant(grant.id);
      throw new OAuthError('invalid_grant', 'The authorization code has already been used.');
    }
    await db.run(`UPDATE oauth_tokens SET used_at = ? WHERE id = ?`, [iso(), row.id]);
    if (row.revoked_at || row.expires_at < iso() || grant.revoked_at) throw new OAuthError('invalid_grant', 'The authorization code has expired.');
    if (String(body.redirect_uri ?? '') !== row.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request.');
    // No challenge is only possible for a confidential client, authenticated above.
    if (row.code_challenge ? !pkceMatches(String(body.code_verifier ?? ''), row.code_challenge) : client.kind !== 'confidential') {
      throw new OAuthError('invalid_grant', 'The PKCE code_verifier does not match.');
    }
    checkResource(grant);
    return issueTokens(grant);
  }

  if (grantType === 'refresh_token') {
    const refresh = String(body.refresh_token ?? '');
    const row = await db.get<TokenRow>(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'`, [hashSecret(refresh)]);
    if (!row) throw new OAuthError('invalid_grant', 'The refresh token is not valid.');
    const grant = await db.get<GrantRow>(`SELECT * FROM oauth_grants WHERE id = ?`, [row.grant_id]);
    if (!grant || grant.client_id !== client.id) throw new OAuthError('invalid_grant', 'The refresh token was issued to another client.');
    if (row.used_at || row.revoked_at) {
      // Rotation: a refresh token works once. Seeing one again means a copy
      // exists somewhere it shouldn't, so the whole grant is withdrawn.
      await revokeGrant(grant.id);
      throw new OAuthError('invalid_grant', 'The refresh token has already been used.');
    }
    if (row.expires_at < iso() || grant.revoked_at) throw new OAuthError('invalid_grant', 'The refresh token has expired.');
    checkResource(grant);
    await db.run(`UPDATE oauth_tokens SET used_at = ? WHERE id = ?`, [iso(), row.id]);
    // The access tokens issued alongside the old refresh token stay valid until they expire.
    return issueTokens(grant);
  }

  throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

/** RFC 7009: always succeeds from the caller's point of view. */
export async function revokeToken(token: string): Promise<void> {
  const row = await db.get<TokenRow>(`SELECT * FROM oauth_tokens WHERE token_hash = ?`, [hashSecret(token)]);
  if (!row) return;
  if (row.kind === 'refresh') await revokeGrant(row.grant_id);
  else await db.run(`UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`, [iso(), row.id]);
}

export async function listConnectedApps(userId: string): Promise<ConnectedApp[]> {
  const rows = await db.all<GrantRow & { client_name: string | null; last_used_at: string | null; created_at: string }>(
    `SELECT g.*, c.client_name FROM oauth_grants g LEFT JOIN oauth_clients c ON c.id = g.client_id
     WHERE g.user_id = ? AND g.revoked_at IS NULL AND EXISTS (
       SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id AND t.kind = 'refresh' AND t.revoked_at IS NULL AND t.used_at IS NULL AND t.expires_at > ?)
     ORDER BY g.created_at DESC`,
    [userId, iso()],
  );
  return rows.map((row) => ({
    grantId: row.id,
    clientId: row.client_id,
    clientName: row.client_name ?? 'Unknown application',
    scope: row.scope,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  }));
}

export async function revokeConnectedApp(userId: string, grantId: string): Promise<boolean> {
  const grant = await db.get<GrantRow>(`SELECT * FROM oauth_grants WHERE id = ? AND user_id = ?`, [grantId, userId]);
  if (!grant) return false;
  await revokeGrant(grant.id);
  return true;
}

/* ---------------------------- Resolving a caller -------------------------- */

export interface Caller {
  user: PublicUser;
  scope: ConnectorScope;
  /** A stable key for rate limiting and the audit trail. */
  credentialId: string;
  /** "Claude Code token 'laptop'" or the OAuth client's name. */
  clientName: string;
}

export type ResolveFailure = { error: 'invalid_token'; description: string };

/**
 * Who is calling, from the bearer token. The user is loaded fresh on every
 * request, so suspending someone cuts their assistant off at once.
 */
export async function resolveBearer(token: string, expectedResource: string): Promise<Caller | ResolveFailure> {
  const fail = (description: string): ResolveFailure => ({ error: 'invalid_token', description });
  if (!token) return fail('No token.');
  const hash = hashSecret(token);
  const now = iso();

  if (token.startsWith('itk_')) {
    const row = await db.get<ApiTokenRow & { token_hash: string }>(`SELECT * FROM api_tokens WHERE token_hash = ?`, [hash]);
    if (!row || row.revoked_at) return fail('The token is not valid or has been revoked.');
    if (row.expires_at && row.expires_at < now) return fail('The token has expired.');
    const user = await findUserById(row.user_id);
    if (!user || user.status !== 'active') return fail('The account behind this token is not active.');
    if (!user.permissions.includes('connector.use')) return fail('The account behind this token may not use the AI connector.');
    // Written at most once a minute: this runs on every tool call.
    if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
      await db.run(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, [now, row.id]);
    }
    return { user, scope: row.scope === 'read_write' ? 'read_write' : 'read', credentialId: `pat:${row.id}`, clientName: `token "${row.name}"` };
  }

  const row = await db.get<TokenRow>(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'`, [hash]);
  if (!row || row.revoked_at) return fail('The access token is not valid or has been revoked.');
  if (row.expires_at < now) return fail('The access token has expired.');
  const grant = await db.get<GrantRow & { last_used_at: string | null }>(`SELECT * FROM oauth_grants WHERE id = ?`, [row.grant_id]);
  if (!grant || grant.revoked_at) return fail('This connection has been revoked.');
  // Audience: a token issued for another resource is not accepted here.
  if (grant.resource !== normaliseResource(expectedResource)) return fail('The token was not issued for this server.');
  const user = await findUserById(grant.user_id);
  if (!user || user.status !== 'active') return fail('The account behind this token is not active.');
  if (!user.permissions.includes('connector.use')) return fail('The account behind this token may not use the AI connector.');
  if (!grant.last_used_at || Date.now() - new Date(grant.last_used_at).getTime() > 60_000) {
    await db.run(`UPDATE oauth_grants SET last_used_at = ? WHERE id = ?`, [now, grant.id]);
  }
  const client = await getClient(grant.client_id);
  return { user, scope: grant.scope, credentialId: `oauth:${grant.id}`, clientName: client?.name ?? 'an OAuth client' };
}

/** Old, unusable rows: expired requests, codes and tokens. Called by the ops runner hourly. */
export async function pruneOAuth(): Promise<void> {
  const cutoff = iso(-7 * 86_400);
  await db.run(`DELETE FROM oauth_requests WHERE expires_at < ?`, [iso()]);
  await db.run(`DELETE FROM oauth_tokens WHERE expires_at < ?`, [cutoff]);
}
