import crypto from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';
import { db } from '../db/index.ts';
import { getOpsSetting, getSettings, setOpsSetting } from '../repositories/settings.ts';
import { badRequest } from './http.ts';
import { assertSafeWebhookUrl } from '../integrations/url-guard.ts';
import { USER_ROLES, type UserRole } from '../../shared/types.ts';
import { ENTRA_CLAIMS, SSO_PROVIDERS, type SamlServiceProvider, type SamlSettings, type SsoProvider } from '../../shared/sso.ts';

/**
 * SAML 2.0 single sign-on, built for Microsoft Entra ID and usable with any
 * SAML identity provider.
 *
 * The protocol work - signature verification, audience, conditions, clock
 * skew - is @node-saml/node-saml's. What is decided here:
 *
 *  - Assertions must be signed by the configured certificate. A signed
 *    response alone is not enough, because the assertion is what is trusted.
 *  - Every response must answer a request this app made (InResponseTo), and
 *    those request ids live in the database so any instance can finish a
 *    login another one started. IdP-initiated sign-in is therefore refused:
 *    it has no request to answer, and is the easiest path to a login CSRF.
 *  - An assertion id is accepted once. Replaying a captured response fails.
 */

const SETTING = 'sso.saml';
const REQUEST_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 2 * 60_000;
/** Assertions older than this are refused even if the IdP said they were valid for longer. */
const MAX_ASSERTION_AGE_MS = 10 * 60_000;

export const DEFAULT_SAML: SamlSettings = {
  enabled: false,
  provider: 'entra',
  buttonLabel: 'Sign in with Microsoft',
  idpEntityId: '',
  idpLoginUrl: '',
  idpCertificate: '',
  emailAttribute: ENTRA_CLAIMS.email,
  nameAttribute: ENTRA_CLAIMS.name,
  groupsAttribute: ENTRA_CLAIMS.groups,
  jitEnabled: false,
  jitRole: 'agent',
  jitTeamId: null,
  groupRoles: [],
  requireSso: false,
};

export async function loadSaml(): Promise<SamlSettings> {
  return getOpsSetting<SamlSettings>(SETTING, DEFAULT_SAML);
}

/** Usable for sign-in: switched on and given everything the protocol needs. */
export function samlReady(settings: SamlSettings): boolean {
  return settings.enabled && Boolean(settings.idpEntityId && settings.idpLoginUrl && certificatesOf(settings.idpCertificate).length);
}

/** One or more certificates, as PEM, from whatever was pasted: PEM blocks or bare base64. */
export function certificatesOf(text: string): string[] {
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  const bodies = blocks
    ? blocks.map((block) => block.replace(/-----(BEGIN|END) CERTIFICATE-----/g, ''))
    : text.split(/\n\s*\n/);
  return bodies
    .map((body) => body.replace(/\s+/g, ''))
    .filter((body) => /^[A-Za-z0-9+/=]{100,}$/.test(body))
    .map((body) => `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`);
}

function validCertificate(pem: string): boolean {
  try {
    new crypto.X509Certificate(pem);
    return true;
  } catch {
    return false;
  }
}

export function validateSaml(body: Record<string, unknown>, current: SamlSettings): SamlSettings {
  const text = (value: unknown, max = 2000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
  const provider = SSO_PROVIDERS.includes(body.provider as SsoProvider) ? (body.provider as SsoProvider) : current.provider;
  const role = (value: unknown, fallback: UserRole) => (USER_ROLES.includes(value as UserRole) ? (value as UserRole) : fallback);

  const next: SamlSettings = {
    enabled: body.enabled === true,
    provider,
    buttonLabel: text(body.buttonLabel, 60) || (provider === 'entra' ? 'Sign in with Microsoft' : 'Sign in with SSO'),
    idpEntityId: text(body.idpEntityId, 500),
    idpLoginUrl: text(body.idpLoginUrl, 1000),
    idpCertificate: text(body.idpCertificate, 20_000),
    emailAttribute: text(body.emailAttribute, 300) || DEFAULT_SAML.emailAttribute,
    nameAttribute: text(body.nameAttribute, 300) || DEFAULT_SAML.nameAttribute,
    groupsAttribute: text(body.groupsAttribute, 300) || DEFAULT_SAML.groupsAttribute,
    jitEnabled: body.jitEnabled === true,
    jitRole: role(body.jitRole, 'agent'),
    jitTeamId: text(body.jitTeamId, 60) || null,
    groupRoles: (Array.isArray(body.groupRoles) ? body.groupRoles : [])
      .map((entry) => entry as Record<string, unknown>)
      .map((entry) => ({ group: text(entry.group, 200), role: role(entry.role, 'agent') }))
      .filter((entry) => entry.group)
      .slice(0, 50),
    requireSso: body.requireSso === true,
  };

  if (next.idpLoginUrl) {
    let url: URL;
    try {
      url = new URL(next.idpLoginUrl);
    } catch {
      throw badRequest('The login URL is not a URL.', { idpLoginUrl: 'Invalid URL' });
    }
    if (url.protocol !== 'https:') throw badRequest('The login URL must use https.', { idpLoginUrl: 'Must be https' });
  }
  if (next.idpCertificate) {
    const certs = certificatesOf(next.idpCertificate);
    if (!certs.length || !certs.every(validCertificate)) {
      throw badRequest('The signing certificate could not be read. Paste the Base64 certificate from Entra ID.', { idpCertificate: 'Invalid certificate' });
    }
  }
  if (next.enabled && !samlReady(next)) {
    throw badRequest('Fill in the identifier, the login URL and the signing certificate before turning single sign-on on.');
  }
  // Requiring SSO while it cannot work would lock every non-administrator out.
  if (next.requireSso && !next.enabled) next.requireSso = false;
  return next;
}

export async function saveSaml(settings: SamlSettings): Promise<void> {
  await setOpsSetting(SETTING, settings);
}

/* ------------------------------ Endpoints -------------------------------- */

export async function serviceProvider(fallbackOrigin: string): Promise<SamlServiceProvider> {
  const settings = await getSettings();
  const configured = (settings.appUrl || process.env.APP_URL || '').replace(/\/+$/, '');
  const base = configured || fallbackOrigin.replace(/\/+$/, '');
  return {
    entityId: `${base}/api/auth/saml/metadata`,
    acsUrl: `${base}/api/auth/saml/acs`,
    signOnUrl: `${base}/api/auth/saml/login`,
    metadataUrl: `${base}/api/auth/saml/metadata`,
    fromAppUrl: Boolean(configured),
  };
}

/** node-saml's request cache, in the database so it is shared by every instance. */
const requestCache: CacheProvider = {
  async saveAsync(key, value) {
    const now = Date.now();
    await db.run(`DELETE FROM saml_requests WHERE expires_at < ?`, [new Date(now).toISOString()]);
    await db.run(`INSERT INTO saml_requests (id, created_at, expires_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING`, [
      key,
      value,
      new Date(now + REQUEST_TTL_MS).toISOString(),
    ]);
    return { value, createdAt: now };
  },
  async getAsync(key) {
    const row = await db.get<{ created_at: string }>(`SELECT created_at FROM saml_requests WHERE id = ? AND expires_at >= ?`, [
      key,
      new Date().toISOString(),
    ]);
    return row?.created_at ?? null;
  },
  async removeAsync(key) {
    if (!key) return null;
    const row = await db.get<{ created_at: string }>(`SELECT created_at FROM saml_requests WHERE id = ?`, [key]);
    await db.run(`DELETE FROM saml_requests WHERE id = ?`, [key]);
    return row?.created_at ?? null;
  },
};

function client(settings: SamlSettings, sp: SamlServiceProvider): SAML {
  return new SAML({
    entryPoint: settings.idpLoginUrl,
    issuer: sp.entityId,
    callbackUrl: sp.acsUrl,
    audience: sp.entityId,
    idpIssuer: settings.idpEntityId,
    idpCert: certificatesOf(settings.idpCertificate),
    wantAssertionsSigned: true,
    // Entra signs the assertion by default and not the response around it.
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: CLOCK_SKEW_MS,
    maxAssertionAgeMs: MAX_ASSERTION_AGE_MS,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: REQUEST_TTL_MS,
    cacheProvider: requestCache,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    // Entra rejects a RequestedAuthnContext it does not expect (passwordless, MFA).
    disableRequestedAuthnContext: true,
    signatureAlgorithm: 'sha256',
  });
}

export async function loginUrl(settings: SamlSettings, sp: SamlServiceProvider, relayState: string): Promise<string> {
  return client(settings, sp).getAuthorizeUrlAsync(relayState, undefined, {});
}

export function spMetadata(settings: SamlSettings, sp: SamlServiceProvider): string {
  // The metadata needs no IdP details; a placeholder lets it be downloaded before they are known.
  return new SAML({
    issuer: sp.entityId,
    callbackUrl: sp.acsUrl,
    idpCert: certificatesOf(settings.idpCertificate)[0] ?? 'unset',
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    wantAssertionsSigned: true,
  }).generateServiceProviderMetadata(null, null);
}

export interface SamlIdentity {
  email: string;
  name: string;
  groups: string[];
  assertionId: string | null;
}

function attribute(profile: Profile, name: string): string[] {
  const value = profile[name];
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null || value === '') return [];
  return [String(value)];
}

/** Verifies a POSTed SAMLResponse and returns who it is for. Throws on anything doubtful. */
export async function verifyResponse(settings: SamlSettings, sp: SamlServiceProvider, samlResponse: string): Promise<SamlIdentity> {
  const { profile } = await client(settings, sp).validatePostResponseAsync({ SAMLResponse: samlResponse });
  if (!profile) throw new Error('The identity provider sent no assertion.');

  const assertionXml = profile.getAssertionXml?.() ?? '';
  const assertionId = /<(?:\w+:)?Assertion\b[^>]*?\sID="([^"]+)"/.exec(assertionXml)?.[1] ?? null;
  if (!assertionId) throw new Error('The assertion has no ID.');

  // Replay protection: remember every accepted assertion until long after it could still be valid.
  const now = new Date();
  await db.run(`DELETE FROM saml_assertions WHERE expires_at < ?`, [now.toISOString()]);
  const seen = await db.get<{ id: string }>(`SELECT id FROM saml_assertions WHERE id = ?`, [assertionId]);
  if (seen) throw new Error('This sign-in response has already been used.');
  await db.run(`INSERT INTO saml_assertions (id, expires_at) VALUES (?, ?)`, [
    assertionId,
    new Date(now.getTime() + 24 * 3_600_000).toISOString(),
  ]);

  const email = (attribute(profile, settings.emailAttribute)[0] ?? profile.email ?? profile.mail ?? (/@/.test(profile.nameID) ? profile.nameID : ''))
    .toString()
    .trim()
    .toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('The identity provider did not send an email address.');

  const given = attribute(profile, ENTRA_CLAIMS.givenName)[0];
  const surname = attribute(profile, ENTRA_CLAIMS.surname)[0];
  const name = attribute(profile, settings.nameAttribute)[0] || [given, surname].filter(Boolean).join(' ') || email.split('@')[0];
  return { email, name: name.slice(0, 120), groups: attribute(profile, settings.groupsAttribute), assertionId };
}

const ROLE_RANK: Record<UserRole, number> = { viewer: 0, agent: 1, manager: 2, admin: 3 };

/** The highest role any of the person's groups maps to, if any do. */
export function roleFromGroups(settings: SamlSettings, groups: string[]): UserRole | null {
  const matched = settings.groupRoles.filter((entry) => groups.includes(entry.group)).map((entry) => entry.role);
  if (!matched.length) return null;
  return matched.sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0];
}

/* --------------------------- Metadata import ----------------------------- */

/**
 * Reads an IdP's federation metadata - Entra's "App Federation Metadata Url" -
 * and pulls out the three things sign-in needs.
 */
export function parseIdpMetadata(xml: string): { entityId: string; loginUrl: string; certificate: string } {
  const errors: string[] = [];
  const doc = new DOMParser({
    errorHandler: { warning: () => undefined, error: (message: string) => errors.push(message), fatalError: (message: string) => errors.push(message) },
  }).parseFromString(xml, 'text/xml');
  if (errors.length || !doc?.documentElement) throw badRequest('That is not readable SAML metadata.');
  const byName = (name: string) => Array.from(doc.getElementsByTagNameNS('*', name));

  const descriptor = byName('EntityDescriptor')[0];
  const entityId = descriptor?.getAttribute('entityID') ?? '';
  const idp = byName('IDPSSODescriptor')[0];
  if (!idp) throw badRequest('The metadata does not describe an identity provider.');

  const services = Array.from(idp.getElementsByTagNameNS('*', 'SingleSignOnService'));
  const redirect = services.find((s) => s.getAttribute('Binding')?.endsWith('HTTP-Redirect')) ?? services[0];
  const loginUrl = redirect?.getAttribute('Location') ?? '';

  const keys = Array.from(idp.getElementsByTagNameNS('*', 'KeyDescriptor')).filter((k) => {
    const use = k.getAttribute('use');
    return !use || use === 'signing';
  });
  const certificates = keys
    .map((k) => k.getElementsByTagNameNS('*', 'X509Certificate')[0]?.textContent?.replace(/\s+/g, '') ?? '')
    .filter(Boolean);
  const unique = Array.from(new Set(certificates));
  if (!entityId || !loginUrl || !unique.length) throw badRequest('The metadata is missing the identifier, login URL or signing certificate.');
  return { entityId, loginUrl, certificate: unique.map((c) => certificatesOf(c)[0] ?? c).join('\n\n') };
}

export async function fetchIdpMetadata(url: string): Promise<{ entityId: string; loginUrl: string; certificate: string }> {
  const safe = assertSafeWebhookUrl(url, 'Metadata URL');
  const response = await fetch(safe, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw badRequest(`The metadata URL answered HTTP ${response.status}.`);
  const text = await response.text();
  if (text.length > 1_000_000) throw badRequest('That metadata document is too large.');
  return parseIdpMetadata(text);
}
