import crypto from 'node:crypto';

/**
 * Bot Framework authentication, both directions.
 *
 * A Teams bot is not a webhook. Microsoft POSTs activities to a public URL
 * with a signed JWT, and the app calls back out with its own token, so both
 * halves have to be done properly:
 *
 *  - Inbound, the only thing between this endpoint and the internet is that
 *    JWT. It is verified against Microsoft's published keys, and the audience
 *    is checked against this bot's own app id - a signature alone proves the
 *    token came from Microsoft, not that it was meant for us.
 *  - Outbound, a client-credentials token is fetched and reused until it is
 *    nearly expired, because one is needed for every reply and Microsoft rate
 *    limits the token endpoint.
 *
 * Implemented on node:crypto rather than a JWT library: Node imports a JWK
 * directly, so the whole of what is needed is a JWKS fetch and one RS256
 * verification, and this avoids a dependency in the request path of an
 * internet-facing endpoint.
 */

const OPENID_CONFIG = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token';
const TOKEN_SCOPE = 'https://api.botframework.com/.default';

/** Microsoft rotates signing keys; the documented guidance is to cache for a day. */
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;
/** Renew a little early so a reply never races the expiry. */
const TOKEN_SKEW_MS = 5 * 60 * 1000;

interface Jwk {
  kid?: string;
  kty?: string;
  use?: string;
  n?: string;
  e?: string;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
let tokenCache: { token: string; expiresAt: number; appId: string } | null = null;

/** Exposed so tests can start from a known state. */
export function resetTeamsAuthCaches(): void {
  jwksCache = null;
  tokenCache = null;
}

async function loadKeys(now: number): Promise<Jwk[]> {
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;

  const config = (await (await fetch(OPENID_CONFIG)).json()) as { jwks_uri?: string };
  if (!config.jwks_uri) throw new Error('Microsoft did not advertise a JWKS endpoint');

  const jwks = (await (await fetch(config.jwks_uri)).json()) as { keys?: Jwk[] };
  jwksCache = { keys: jwks.keys ?? [], fetchedAt: now };
  return jwksCache.keys;
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export type TeamsVerifyResult = { ok: true; claims: Record<string, unknown> } | { ok: false; reason: string };

/**
 * Checks the JWT on an inbound activity.
 *
 * `serviceUrl` is compared against the claim of the same name because that is
 * the URL replies are posted to: without the check, a validly signed token
 * from another bot could redirect this app's outbound calls, sending its
 * tokens somewhere else.
 */
export async function verifyTeamsRequest(
  authorization: string | undefined,
  appId: string,
  serviceUrl: string | undefined,
  now = Date.now(),
): Promise<TeamsVerifyResult> {
  if (!appId) return { ok: false, reason: 'No Microsoft app id configured' };

  const token = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1];
  if (!token) return { ok: false, reason: 'Missing bearer token' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'Malformed token' };

  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeSegment(parts[0]);
    claims = decodeSegment(parts[1]);
  } catch {
    return { ok: false, reason: 'Malformed token' };
  }

  if (header.alg !== 'RS256') return { ok: false, reason: 'Unexpected signing algorithm' };

  // The audience is this bot. A token minted for another bot is signed by the
  // same authority and would otherwise pass.
  if (claims.aud !== appId) return { ok: false, reason: 'Token was not issued for this bot' };

  const exp = Number(claims.exp ?? 0) * 1000;
  const nbf = Number(claims.nbf ?? 0) * 1000;
  if (!Number.isFinite(exp) || exp < now) return { ok: false, reason: 'Token has expired' };
  if (Number.isFinite(nbf) && nbf > now + 60_000) return { ok: false, reason: 'Token is not valid yet' };

  if (serviceUrl && typeof claims.serviceurl === 'string' && claims.serviceurl !== serviceUrl) {
    return { ok: false, reason: 'Token does not match the service URL of this activity' };
  }

  let keys: Jwk[];
  try {
    keys = await loadKeys(now);
  } catch (error) {
    return { ok: false, reason: `Could not load Microsoft's signing keys: ${(error as Error).message}` };
  }

  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'Token was signed with an unknown key' };

  try {
    const publicKey = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
    const verified = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      Buffer.from(parts[2], 'base64url'),
    );
    if (!verified) return { ok: false, reason: 'Invalid signature' };
  } catch {
    return { ok: false, reason: 'Invalid signature' };
  }

  return { ok: true, claims };
}

/**
 * A token for calling back into Teams, cached until it is nearly expired.
 *
 * Keyed by app id as well, so changing the credentials in the admin UI takes
 * effect immediately instead of after the old token lapses.
 */
export async function getTeamsAccessToken(
  appId: string,
  appPassword: string,
  now = Date.now(),
): Promise<string> {
  if (tokenCache && tokenCache.appId === appId && tokenCache.expiresAt - TOKEN_SKEW_MS > now) {
    return tokenCache.token;
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: appId,
      client_secret: appPassword,
      scope: TOKEN_SCOPE,
    }).toString(),
  });

  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };

  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description ?? `Microsoft refused the credentials (HTTP ${response.status})`);
  }

  tokenCache = {
    token: body.access_token,
    expiresAt: now + Number(body.expires_in ?? 3600) * 1000,
    appId,
  };
  return tokenCache.token;
}
