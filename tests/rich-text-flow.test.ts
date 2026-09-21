/**
 * Rich text through the real API: what gets stored, and what gets neutralised.
 *
 * The sanitiser is unit-tested separately; this covers the wiring around it -
 * that the route actually calls it, that pasted images become attachments
 * instead of bloating the row, and that plain-text history still renders as
 * plain text.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'richtextflow.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.ATTACHMENT_STORE = 'database';
process.env.HARNESS_PORT = '0';
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, `richtextflow.db${suffix}`));
    } catch {
      // Not present on the first run.
    }
  }
}

/** A real 1x1 PNG, so the extractor has something valid to store. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server: http.Server;
let base: string;
let cookie: string;
let db: typeof import('../server/db/index.ts').db;

before(async () => {
  wipe();
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
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});

after(async () => {
  /*
   * server.close() only settles once every connection has gone, and fetch()
   * keeps its sockets alive between requests - so without dropping them first
   * the callback never fires and the runner hangs after the last assertion.
   */
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await db.close();
  wipe();
});

async function createTicket(body: Record<string, unknown>) {
  const response = await fetch(`${base}/api/tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ subject: 'Payment failures', ...body }),
  });
  return { status: response.status, payload: (await response.json()) as any };
}

test('a hostile description is stored inert', async () => {
  const { status, payload } = await createTicket({
    description:
      '<p>Real report</p><script>fetch("/api/users").then(r=>r.json())</script>' +
      '<img src=x onerror="alert(1)"><a href="javascript:alert(1)">click</a>',
    descriptionFormat: 'html',
  });

  assert.equal(status, 201, JSON.stringify(payload));
  const stored = payload.ticket.description as string;
  assert.match(stored, /Real report/, 'the legitimate content survived');
  assert.doesNotMatch(stored, /<script|onerror|javascript:/i, `stored: ${stored}`);
  assert.equal(payload.ticket.descriptionFormat, 'html');
});

test('formatting from a paste is preserved', async () => {
  const { payload } = await createTicket({
    description: '<p><strong>Impact:</strong> EU region</p><ul><li>502 at checkout</li></ul>',
    descriptionFormat: 'html',
  });
  const stored = payload.ticket.description as string;
  assert.match(stored, /<strong>Impact:<\/strong>/);
  assert.match(stored, /<ul><li>502 at checkout<\/li><\/ul>/);
});

test('a pasted image becomes an attachment instead of staying inline', async () => {
  const { payload } = await createTicket({
    description: `<p>See screenshot</p><p><img src="data:image/png;base64,${PNG_BASE64}" alt="shot"></p>`,
    descriptionFormat: 'html',
  });

  const detail = await fetch(`${base}/api/tickets/${payload.ticket.id}`, { headers: { cookie } }).then((r) => r.json());
  const stored = detail.ticket.description as string;

  assert.doesNotMatch(stored, /data:image/, 'the base64 blob should not remain in the row');
  assert.match(stored, /src="\/api\/tickets\/[^/]+\/attachments\/[^"]+"/, `stored: ${stored}`);
  assert.equal(detail.ticket.attachments.length, 1, 'the image is listed as an attachment');
  assert.equal(detail.ticket.attachments[0].mimeType, 'image/png');

  // And the bytes are actually retrievable at that URL.
  const url = stored.match(/src="([^"]+)"/)![1];
  const image = await fetch(`${base}${url}`, { headers: { cookie } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await image.arrayBuffer()).toString('base64'), PNG_BASE64);
});

test('an empty rich-text description is stored as empty plain text', async () => {
  // What an editor leaves behind when everything is deleted.
  const { payload } = await createTicket({ description: '<p><br></p>', descriptionFormat: 'html' });
  assert.equal(payload.ticket.description, '');
  assert.equal(payload.ticket.descriptionFormat, 'text');
});

test('plain-text descriptions still round-trip untouched', async () => {
  const { payload } = await createTicket({ description: 'A <b>literal</b> mention of markup & symbols' });
  assert.equal(payload.ticket.description, 'A <b>literal</b> mention of markup & symbols');
  assert.equal(payload.ticket.descriptionFormat, 'text');
});

test('comments are sanitised and their images attached to the comment', async () => {
  const { payload } = await createTicket({ description: 'Initial' });
  const ticketId = payload.ticket.id as string;

  const posted = await fetch(`${base}/api/tickets/${ticketId}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      body: `<p>Fixed <em>now</em></p><script>alert(1)</script><img src="data:image/png;base64,${PNG_BASE64}">`,
      bodyFormat: 'html',
      isInternal: false,
    }),
  });
  assert.equal(posted.status, 201, await posted.clone().text());

  const detail = (await posted.json()) as any;
  const comment = detail.ticket.comments.at(-1);
  assert.equal(comment.bodyFormat, 'html');
  assert.match(comment.body, /<em>now<\/em>/);
  assert.doesNotMatch(comment.body, /<script|alert\(/i);
  assert.doesNotMatch(comment.body, /data:image/);
  assert.equal(comment.attachments.length, 1, 'the image is attached to the comment, not the ticket root');
});

test('rejects a comment that renders as nothing', async () => {
  const { payload } = await createTicket({ description: 'Initial' });
  const response = await fetch(`${base}/api/tickets/${payload.ticket.id}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ body: '<p><br></p>', bodyFormat: 'html', isInternal: false }),
  });
  assert.equal(response.status, 400);
});
