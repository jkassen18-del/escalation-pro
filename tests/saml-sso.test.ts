/**
 * SAML single sign-on, against a throwaway identity provider whose key is
 * made here. What matters most is what is refused: anything unsigned,
 * tampered with, addressed to someone else, stale, or replayed.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import zlib from 'node:zlib';
import { SignedXml } from 'xml-crypto';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'saml-sso.db';
process.env.SESSION_SECRET = 's'.repeat(48);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;
delete process.env.APP_URL;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const wipe = () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `saml-sso.db${suffix}`), { force: true });
};

const IDP_ENTITY = 'https://sts.windows.net/00000000-test-tenant/';
const IDP_LOGIN = 'https://login.microsoftonline.com/00000000-test-tenant/saml2';

let server: http.Server;
let base: string;
let adminCookie: string;
let teamId: string;
let db: typeof import('../server/db/index.ts').db;
let idpKey: string;
let idpCert: string;
let otherKey: string;
let otherCert: string;

function makeKeyPair(dir: string, name: string): { key: string; cert: string } {
  const keyFile = path.join(dir, `${name}.key`);
  const certFile = path.join(dir, `${name}.crt`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`, '-days', '2', '-keyout', keyFile, '-out', certFile], {
    stdio: 'ignore',
  });
  return { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8') };
}

async function call(method: string, url: string, body?: unknown, cookie = adminCookie) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json().catch(() => null)) as any };
}

async function addUser(id: string, email: string, role: string, password = 'Some-Password-123') {
  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { hash, salt } = hashPassword(password);
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, email, id, `Person ${id}`, hash, salt, role, 'active', '#9a7b2f', 0, now, now],
  );
}

async function passwordLogin(login: string, password: string) {
  return fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password }) });
}

before(async () => {
  wipe();
  const dist = path.resolve(import.meta.dirname, '../dist/client');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'saml-'));
  ({ key: idpKey, cert: idpCert } = makeKeyPair(scratch, 'idp'));
  ({ key: otherKey, cert: otherCert } = makeKeyPair(scratch, 'attacker'));
  fs.rmSync(scratch, { recursive: true, force: true });

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();
  await addUser('u-admin', 'admin@acme.test', 'admin', 'Admin-Password-1');
  await addUser('u-agent', 'agent@acme.test', 'agent', 'Agent-Password-1');

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = await passwordLogin('admin@acme.test', 'Admin-Password-1');
  adminCookie = login.headers.get('set-cookie')!.split(';')[0];
  teamId = (await call('POST', '/api/teams', { name: 'Platform', key: 'PLT' })).payload.team.id;
});

after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db.close();
  wipe();
});

/* --------------------------------- the IdP -------------------------------- */

const SP_ENTITY = () => `${base}/api/auth/saml/metadata`;
const ACS = () => `${base}/api/auth/saml/acs`;

/** Starts a sign-in the way a browser would, and returns the request id the IdP must answer. */
async function startLogin(): Promise<string> {
  const response = await fetch(`${base}/api/auth/saml/login?returnTo=/tickets`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location')!);
  assert.equal(`${location.origin}${location.pathname}`, IDP_LOGIN);
  const xml = zlib.inflateRawSync(Buffer.from(location.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
  return /\sID="([^"]+)"/.exec(xml)![1];
}

interface AssertionOptions {
  email?: string;
  name?: string;
  groups?: string[];
  inResponseTo?: string;
  audience?: string;
  notOnOrAfter?: Date;
  issueInstant?: Date;
  assertionId?: string;
  key?: string;
  cert?: string;
  sign?: boolean;
  tamper?: (signedXml: string) => string;
}

function buildResponse(o: AssertionOptions): string {
  const now = o.issueInstant ?? new Date();
  const expiry = o.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000);
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const assertionId = o.assertionId ?? `_a${crypto.randomUUID()}`;
  const email = o.email ?? 'agent@acme.test';
  const attr = (name: string, values: string[]) =>
    `<Attribute Name="${name}">${values.map((v) => `<AttributeValue>${v}</AttributeValue>`).join('')}</Attribute>`;
  const assertion =
    `<Assertion xmlns="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" IssueInstant="${iso(now)}" Version="2.0">` +
    `<Issuer>${IDP_ENTITY}</Issuer>` +
    `<Subject><NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</NameID>` +
    `<SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><SubjectConfirmationData InResponseTo="${o.inResponseTo}" NotOnOrAfter="${iso(expiry)}" Recipient="${ACS()}"/></SubjectConfirmation></Subject>` +
    `<Conditions NotBefore="${iso(new Date(now.getTime() - 60_000))}" NotOnOrAfter="${iso(expiry)}"><AudienceRestriction><Audience>${o.audience ?? SP_ENTITY()}</Audience></AudienceRestriction></Conditions>` +
    `<AttributeStatement>` +
    attr('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', [email]) +
    attr('http://schemas.microsoft.com/identity/claims/displayname', [o.name ?? 'Ada Agent']) +
    (o.groups?.length ? attr('http://schemas.microsoft.com/ws/2008/06/identity/claims/groups', o.groups) : '') +
    `</AttributeStatement>` +
    `<AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${assertionId}"><AuthnContext><AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</AuthnContextClassRef></AuthnContext></AuthnStatement>` +
    `</Assertion>`;

  let signed = assertion;
  if (o.sign !== false) {
    const sig = new SignedXml({ privateKey: o.key ?? idpKey, publicCert: o.cert ?? idpCert });
    sig.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
    sig.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    sig.computeSignature(assertion, { location: { reference: "//*[local-name(.)='Issuer']", action: 'after' } });
    signed = sig.getSignedXml();
  }
  if (o.tamper) signed = o.tamper(signed);

  const response =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r${crypto.randomUUID()}" Version="2.0" IssueInstant="${iso(now)}" Destination="${ACS()}" InResponseTo="${o.inResponseTo}">` +
    `<Issuer xmlns="urn:oasis:names:tc:SAML:2.0:assertion">${IDP_ENTITY}</Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    signed +
    `</samlp:Response>`;
  return Buffer.from(response).toString('base64');
}

async function postResponse(samlResponse: string) {
  const response = await fetch(ACS(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: '/tickets' }).toString(),
    redirect: 'manual',
  });
  const location = response.headers.get('location') ?? '';
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { status: response.status, location, cookie };
}

async function whoAmI(cookie: string) {
  if (!cookie) return null;
  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  return me.ok ? ((await me.json()) as any).user : null;
}

async function configure(patch: Record<string, unknown> = {}) {
  return call('PUT', '/api/sso/saml', {
    enabled: true,
    provider: 'entra',
    idpEntityId: IDP_ENTITY,
    idpLoginUrl: IDP_LOGIN,
    idpCertificate: idpCert,
    jitEnabled: false,
    requireSso: false,
    ...patch,
  });
}

/* ---------------------------------- tests --------------------------------- */

test('only administrators can configure SSO, and it refuses a half-filled setup', async () => {
  const agent = await passwordLogin('agent@acme.test', 'Agent-Password-1');
  const agentCookie = agent.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await call('GET', '/api/sso/saml', undefined, agentCookie)).status, 403);

  assert.equal((await call('PUT', '/api/sso/saml', { enabled: true, idpEntityId: IDP_ENTITY })).status, 400);
  assert.equal((await configure({ idpCertificate: 'not a certificate' })).status, 400);
  assert.equal((await configure({ idpLoginUrl: 'http://insecure.example/saml' })).status, 400);

  const saved = await configure();
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.serviceProvider.acsUrl, ACS());

  const bootstrap = await (await fetch(`${base}/api/auth/bootstrap`)).json();
  assert.deepEqual(bootstrap.sso, { enabled: true, label: 'Sign in with Microsoft', required: false, provider: 'entra' });
  const settings = await call('GET', '/api/settings');
  assert.ok(!JSON.stringify(settings.payload).includes('BEGIN CERTIFICATE'), 'SSO config stays out of the general settings');
});

test('the service provider publishes its metadata', async () => {
  const response = await fetch(`${base}/api/auth/saml/metadata`);
  const xml = await response.text();
  assert.equal(response.status, 200);
  assert.match(xml, new RegExp(`entityID="${SP_ENTITY().replace(/[.?/]/g, '\\$&')}"`));
  assert.match(xml, /AssertionConsumerService[^>]+Location="[^"]+\/api\/auth\/saml\/acs"/);
});

test('federation metadata is parsed into identifier, login URL and certificate', async () => {
  const { parseIdpMetadata } = await import('../server/lib/sso.ts');
  const body = idpCert.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, '');
  const metadata = parseIdpMetadata(
    `<?xml version="1.0"?><EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${IDP_ENTITY}">` +
      `<IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
      `<KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${body}</X509Certificate></X509Data></KeyInfo></KeyDescriptor>` +
      `<SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${IDP_LOGIN}/post"/>` +
      `<SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${IDP_LOGIN}"/>` +
      `</IDPSSODescriptor></EntityDescriptor>`,
  );
  assert.equal(metadata.entityId, IDP_ENTITY);
  assert.equal(metadata.loginUrl, IDP_LOGIN);
  assert.ok(metadata.certificate.includes(body.slice(0, 40)));
  assert.throws(() => parseIdpMetadata('<html>nope</html>'));
});

test('a valid signed assertion signs in the existing person', async () => {
  const requestId = await startLogin();
  const result = await postResponse(buildResponse({ inResponseTo: requestId }));
  assert.equal(result.status, 302);
  assert.equal(result.location, '/tickets');
  const user = await whoAmI(result.cookie);
  assert.equal(user?.email, 'agent@acme.test');

  const audit = await call('GET', '/api/audit?search=single sign-on');
  assert.ok(audit.payload.entries.some((e: any) => e.action === 'sso_login'));
});

test('an unsigned assertion is refused', async () => {
  const requestId = await startLogin();
  const result = await postResponse(buildResponse({ inResponseTo: requestId, sign: false }));
  assert.match(result.location, /sso_error=/);
  assert.equal(await whoAmI(result.cookie), null);
});

test('an assertion signed by the wrong key is refused', async () => {
  const requestId = await startLogin();
  const result = await postResponse(buildResponse({ inResponseTo: requestId, key: otherKey, cert: otherCert }));
  assert.match(result.location, /sso_error=/);
  assert.equal(await whoAmI(result.cookie), null);
});

test('a tampered assertion is refused', async () => {
  const requestId = await startLogin();
  const result = await postResponse(
    buildResponse({
      inResponseTo: requestId,
      // Swap the signed-in person after signing.
      tamper: (xml) => xml.replaceAll('agent@acme.test', 'admin@acme.test'),
    }),
  );
  assert.match(result.location, /sso_error=/);
  assert.equal(await whoAmI(result.cookie), null);
});

test('an assertion for another service is refused', async () => {
  const requestId = await startLogin();
  const result = await postResponse(buildResponse({ inResponseTo: requestId, audience: 'https://other-app.example/saml' }));
  assert.match(result.location, /sso_error=/);
});

test('an expired assertion is refused', async () => {
  const requestId = await startLogin();
  const past = new Date(Date.now() - 60 * 60_000);
  const result = await postResponse(buildResponse({ inResponseTo: requestId, issueInstant: past, notOnOrAfter: new Date(past.getTime() + 5 * 60_000) }));
  assert.match(result.location, /sso_error=/);
});

test('a response that answers no request of ours is refused (IdP-initiated or forged)', async () => {
  const result = await postResponse(buildResponse({ inResponseTo: '_never-issued' }));
  assert.match(result.location, /sso_error=/);
});

test('a captured response cannot be replayed', async () => {
  const requestId = await startLogin();
  const response = buildResponse({ inResponseTo: requestId });
  const first = await postResponse(response);
  assert.equal(first.location, '/tickets');
  const second = await postResponse(response);
  assert.match(second.location, /sso_error=/);
  assert.equal(await whoAmI(second.cookie), null);
});

test('an assertion id is accepted once, even inside a fresh response', async () => {
  const assertionId = `_a${crypto.randomUUID()}`;
  const first = await postResponse(buildResponse({ inResponseTo: await startLogin(), assertionId }));
  assert.equal(first.location, '/tickets');
  const second = await postResponse(buildResponse({ inResponseTo: await startLogin(), assertionId }));
  assert.match(second.location, /sso_error=/);
});

test('an unknown person is refused while just-in-time provisioning is off', async () => {
  const requestId = await startLogin();
  const result = await postResponse(buildResponse({ inResponseTo: requestId, email: 'newcomer@acme.test' }));
  assert.match(decodeURIComponent(result.location), /no account here/);
  const row = await db.get(`SELECT id FROM users WHERE email = ?`, ['newcomer@acme.test']);
  assert.equal(row, undefined);
});

test('with just-in-time provisioning on, a new person gets the default role and team', async () => {
  assert.equal((await configure({ jitEnabled: true, jitRole: 'viewer', jitTeamId: teamId })).status, 200);
  const requestId = await startLogin();
  const result = await postResponse(buildResponse({ inResponseTo: requestId, email: 'Newcomer@Acme.test', name: 'New Comer' }));
  const user = await whoAmI(result.cookie);
  assert.equal(user?.email, 'newcomer@acme.test');
  assert.equal(user?.name, 'New Comer');
  assert.equal(user?.role, 'viewer');
  assert.deepEqual(user?.teamIds, [teamId]);
});

test('group membership maps to a role, but never demotes an administrator', async () => {
  assert.equal((await configure({ jitEnabled: true, groupRoles: [{ group: 'grp-managers', role: 'manager' }, { group: 'grp-viewers', role: 'viewer' }] })).status, 200);
  let requestId = await startLogin();
  let result = await postResponse(buildResponse({ inResponseTo: requestId, email: 'agent@acme.test', groups: ['grp-viewers', 'grp-managers'] }));
  assert.equal((await whoAmI(result.cookie))?.role, 'manager', 'the highest matching role wins');

  requestId = await startLogin();
  result = await postResponse(buildResponse({ inResponseTo: requestId, email: 'admin@acme.test', groups: ['grp-viewers'] }));
  assert.equal((await whoAmI(result.cookie))?.role, 'admin');
});

test('"require SSO" blocks password sign-in for everyone but administrators', async () => {
  assert.equal((await configure({ requireSso: true })).status, 200);
  const agent = await passwordLogin('agent@acme.test', 'Agent-Password-1');
  assert.equal(agent.status, 403);
  const wrong = await passwordLogin('agent@acme.test', 'wrong-password');
  assert.equal(wrong.status, 401, 'a wrong password still reads as a wrong password');
  const admin = await passwordLogin('admin@acme.test', 'Admin-Password-1');
  assert.equal(admin.status, 200);

  // Turning SSO off releases the requirement with it.
  assert.equal((await configure({ enabled: false, requireSso: true })).status, 200);
  assert.equal((await passwordLogin('agent@acme.test', 'Agent-Password-1')).status, 200);
});

test('the return path cannot be used as an open redirect', async () => {
  await configure();
  const response = await fetch(`${base}/api/auth/saml/login?returnTo=//evil.example/x`, { redirect: 'manual' });
  const relay = new URL(response.headers.get('location')!).searchParams.get('RelayState');
  assert.equal(relay, '/');
});

/* -------------------------------- team links ------------------------------ */

test('team links: https only, managed by team managers, visible to members', async () => {
  const bad = await call('POST', '/api/team-links', { teamId, name: 'Evil', url: 'javascript:alert(1)' });
  assert.equal(bad.status, 400);
  const http_ = await call('POST', '/api/team-links', { teamId, name: 'Plain', url: 'http://portal.example.com' });
  assert.equal(http_.status, 400);
  const placeholder = await call('POST', '/api/team-links', { teamId, name: 'AWS', url: 'https://<your-directory>.awsapps.com/start' });
  assert.equal(placeholder.status, 400, 'an unfilled preset is caught');

  const created = await call('POST', '/api/team-links', { teamId, name: 'AWS access portal', url: 'https://acme.awsapps.com/start', icon: 'aws' });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const id = created.payload.link.id;
  const updated = await call('PUT', `/api/team-links/${id}`, { name: 'AWS', url: 'https://acme.awsapps.com/start#/', icon: 'aws', description: 'Prod and staging' });
  assert.equal(updated.payload.link.description, 'Prod and staging');

  // A member of the team sees it; a non-member does not; neither can change it.
  await db.run(`INSERT INTO team_members (team_id, user_id, is_lead) VALUES (?, 'u-agent', 0) ON CONFLICT (team_id, user_id) DO NOTHING`, [teamId]);
  await db.run(`UPDATE users SET role = 'agent' WHERE id = 'u-agent'`);
  await addUser('u-outsider', 'outsider@acme.test', 'agent', 'Outsider-Password-1');
  const memberCookie = (await passwordLogin('agent@acme.test', 'Agent-Password-1')).headers.get('set-cookie')!.split(';')[0];
  const outsiderCookie = (await passwordLogin('outsider@acme.test', 'Outsider-Password-1')).headers.get('set-cookie')!.split(';')[0];
  assert.equal((await call('GET', '/api/team-links/mine', undefined, memberCookie)).payload.links.length, 1);
  assert.equal((await call('GET', '/api/team-links/mine', undefined, outsiderCookie)).payload.links.length, 0);
  assert.equal((await call('DELETE', `/api/team-links/${id}`, undefined, memberCookie)).status, 403);

  assert.equal((await call('DELETE', `/api/team-links/${id}`)).status, 204);
  assert.equal((await call('GET', `/api/team-links?teamId=${teamId}`)).payload.links.length, 0);
});
