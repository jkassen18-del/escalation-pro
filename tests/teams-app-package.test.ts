/**
 * The InfraBot app package.
 *
 * Teams installs an app from a zip of a manifest and two icons, and rejects
 * the whole package if any of the three is wrong - usually with a message
 * that does not say which. Both the zip and the PNGs are written by hand here
 * rather than by a library, so what is checked is that they really are a zip
 * and really are PNGs, decoded independently of the code that produced them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'teamspkg.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.SECRET_KEY = 'b'.repeat(64);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;
delete process.env.APP_URL;

const APP_ID = '11111111-2222-3333-4444-555555555555';
const DATA_DIR = path.resolve(import.meta.dirname, '../data');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, `teamspkg.db${suffix}`));
    } catch {
      // Absent on the first run.
    }
  }
}

function ensureClientDist() {
  const dist = path.resolve(import.meta.dirname, '../dist/client');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }
}

/* ------------------------- Independent decoders --------------------------- */

/**
 * Reads a zip from its central directory, the way a real reader does.
 *
 * Deliberately not reusing anything from the writer: walking the local
 * headers in order would pass even if the central directory - the part every
 * extractor actually reads - were wrong.
 */
function readZip(buffer: Buffer): Map<string, Buffer> {
  const eocdSignature = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === eocdSignature) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'no end-of-central-directory record: this is not a zip');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();

  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'bad central directory header');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `bad local header for ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    const data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    assert.equal(data.length, uncompressedSize, `${name} did not decompress to its declared size`);
    files.set(name, data);

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** Enough of a PNG reader to confirm the header is honest. */
function readPngHeader(buffer: Buffer) {
  assert.deepEqual(
    Array.from(buffer.subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'not a PNG',
  );
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR', 'IHDR is not the first chunk');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colourType: buffer[25],
  };
}

/* ------------------------------ The package ------------------------------- */

const DEPARTMENTS = [
  { id: 't1', key: 'FINANCE', name: 'Finance' },
  { id: 't2', key: 'HR', name: 'People Team' },
] as any;

let buildTeamsAppPackage: typeof import('../server/integrations/teams-manifest.ts').buildTeamsAppPackage;
let ManifestError: typeof import('../server/integrations/teams-manifest.ts').ManifestError;

let server: http.Server;
let base: string;
let cookie: string;
let db: typeof import('../server/db/index.ts').db;

before(async () => {
  wipe();
  ensureClientDist();

  const manifestModule = await import('../server/integrations/teams-manifest.ts');
  buildTeamsAppPackage = manifestModule.buildTeamsAppPackage;
  ManifestError = manifestModule.ManifestError;

  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();

  const { hashPassword } = await import('../server/lib/crypto.ts');
  const { ALL_PERMISSIONS } = await import('../server/permissions.ts');
  const { hash, salt } = hashPassword('Adm1n-Password!');
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['u-1', 'admin@acme.test', 'admin', 'Admin', hash, salt, 'admin', 'active', '#9a7b2f', 0, now, now],
  );
  for (const permission of ALL_PERMISSIONS) {
    await db.run('INSERT INTO user_permissions (user_id,permission) VALUES (?,?)', ['u-1', permission]);
  }
  // A viewer, to confirm the package is not downloadable by just anyone.
  await db.run(
    'INSERT INTO users (id,email,username,name,password_hash,password_salt,role,status,avatar_color,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['u-2', 'viewer@acme.test', 'viewer', 'Viewer', hash, salt, 'viewer', 'active', '#9a7b2f', 0, now, now],
  );

  const { createTeam } = await import('../server/repositories/teams.ts');
  await createTeam({ key: 'finance', name: 'Finance' });
  await createTeam({ key: 'hr', name: 'People Team' });

  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'admin@acme.test', password: 'Adm1n-Password!' }),
  });
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await db.close();
  wipe();
});

const build = () =>
  buildTeamsAppPackage({
    appId: APP_ID,
    appUrl: 'https://tickets.example.internal',
    botName: 'InfraBot',
    organizationName: 'Gold Media Lab',
    teams: DEPARTMENTS,
  });

test('the package is a readable zip with exactly what Teams requires', () => {
  const files = readZip(build().zip);

  // Teams looks for these three names, at the root, and nothing else is needed.
  assert.deepEqual([...files.keys()].sort(), ['color.png', 'manifest.json', 'outline.png']);
});

test('the icons are PNGs at the sizes Teams insists on', () => {
  const files = readZip(build().zip);

  const colour = readPngHeader(files.get('color.png')!);
  assert.equal(colour.width, 192, 'the colour icon must be 192x192');
  assert.equal(colour.height, 192);
  assert.equal(colour.bitDepth, 8);
  assert.equal(colour.colourType, 6, 'RGBA, so the rounded corners are not black squares');

  const outline = readPngHeader(files.get('outline.png')!);
  assert.equal(outline.width, 32, 'the outline icon must be 32x32');
  assert.equal(outline.height, 32);
});

test('the outline icon is transparent, because Teams tints it', () => {
  const files = readZip(build().zip);
  const png = files.get('outline.png')!;

  // Decode the pixels: a fully opaque outline icon comes out as a solid block
  // in the client, which is the classic way this file is got wrong.
  let idat = Buffer.alloc(0);
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') idat = Buffer.concat([idat, png.subarray(offset + 8, offset + 8 + length)]);
    offset += 12 + length;
  }

  const raw = zlib.inflateSync(idat);
  const stride = 32 * 4;
  let opaque = 0;
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      if (raw[y * (stride + 1) + 1 + x * 4 + 3] > 128) opaque += 1;
    }
  }

  assert.ok(opaque > 50, 'the outline icon is blank');
  assert.ok(opaque < 32 * 32 * 0.6, 'the outline icon is a solid block rather than a glyph');
});

test('the manifest carries the app id in both places it is read from', () => {
  const files = readZip(build().zip);
  const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));

  // Teams keys the installed app on `id` and routes activities by `botId`.
  // A mismatch installs an app that never receives anything.
  assert.equal(manifest.id, APP_ID);
  assert.equal(manifest.bots[0].botId, APP_ID);
});

test('the manifest names the host, which Teams checks links against', () => {
  const files = readZip(build().zip);
  const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));

  assert.deepEqual(manifest.validDomains, ['tickets.example.internal']);
  assert.equal(manifest.developer.websiteUrl, 'https://tickets.example.internal');
});

test('the command menu lists the departments that actually exist', () => {
  const files = readZip(build().zip);
  const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));

  const titles = manifest.bots[0].commandLists[0].commands.map((c: any) => c.title);
  assert.deepEqual(titles, ['finance', 'hr']);
});

test('a department list longer than Teams allows is trimmed, not rejected', () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ id: `t${i}`, key: `D${i}`, name: `Dept ${i}` })) as any;
  const files = readZip(
    buildTeamsAppPackage({ appId: APP_ID, appUrl: 'https://tickets.example.internal', teams: many }).zip,
  );
  const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));

  // The bot answers any department; the list is only the menu.
  assert.equal(manifest.bots[0].commandLists[0].commands.length, 10);
});

test('an app id that is not a GUID is refused with a usable message', () => {
  assert.throws(
    () => buildTeamsAppPackage({ appId: 'not-a-guid', appUrl: 'https://tickets.example.internal' }),
    (error: unknown) => error instanceof ManifestError && /GUID/i.test((error as Error).message),
  );
});

test('a plain HTTP app URL is refused, because Microsoft will not call one', () => {
  assert.throws(
    () => buildTeamsAppPackage({ appId: APP_ID, appUrl: 'http://tickets.example.internal' }),
    (error: unknown) => error instanceof ManifestError && /https/i.test((error as Error).message),
  );
});

test('the same configuration produces byte-identical packages', () => {
  // Teams treats a changed package as a new version to review, so a download
  // that differs every time for no reason is a nuisance to an admin.
  assert.deepEqual(build().zip, build().zip);
});

test('the filename is named after the bot', () => {
  assert.equal(build().filename, 'infrabot-teams.zip');
});

/* ------------------------------ The endpoint ------------------------------ */

test('the endpoint refuses an anonymous request', async () => {
  const response = await fetch(`${base}/api/integrations/msteams/app-package`);
  assert.equal(response.status, 401);
});

test('a viewer cannot download it', async () => {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'viewer@acme.test', password: 'Adm1n-Password!' }),
  });
  const viewerCookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';

  const response = await fetch(`${base}/api/integrations/msteams/app-package`, {
    headers: { cookie: viewerCookie },
  });
  // The package names the host and the bot id; it is not for everyone.
  assert.equal(response.status, 403);
});

test('without an app URL it says so rather than producing a broken package', async () => {
  const response = await fetch(`${base}/api/integrations/msteams/app-package`, { headers: { cookie } });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /app URL/i);
});

test('without an app id it says so rather than producing a broken package', async () => {
  await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ appUrl: 'https://tickets.example.internal' }),
  });

  const response = await fetch(`${base}/api/integrations/msteams/app-package`, { headers: { cookie } });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /app id/i);
});

test('once configured it serves a real zip as a download', async () => {
  await fetch(`${base}/api/integrations/msteams`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ config: { mode: 'bot', appId: APP_ID, appPassword: 'secret', botName: 'InfraBot' } }),
  });

  const response = await fetch(`${base}/api/integrations/msteams/app-package`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="infrabot-teams\.zip"/);

  const files = readZip(Buffer.from(await response.arrayBuffer()));
  const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));

  assert.equal(manifest.id, APP_ID);
  assert.equal(manifest.name.short, 'InfraBot');
  assert.deepEqual(manifest.validDomains, ['tickets.example.internal']);
  // The departments come from the database, not from a template.
  assert.deepEqual(
    manifest.bots[0].commandLists[0].commands.map((c: any) => c.title).sort(),
    ['finance', 'hr'],
  );
});
