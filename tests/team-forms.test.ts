/**
 * Per-department intake forms, through the real API.
 *
 * The form is data, so the browser's rendering of it is not a control: a
 * request can omit a required answer, send a choice that is not on the list,
 * or answer a question belonging to a different team. The server is what has
 * to say no.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'teamforms.db';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.ATTACHMENT_STORE = 'database';
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, `teamforms.db${suffix}`));
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

let server: http.Server;
let base: string;
let cookie: string;
let teamId: string;
let db: typeof import('../server/db/index.ts').db;

async function call(method: string, url: string, body?: unknown) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json().catch(() => null)) as any };
}

before(async () => {
  wipe();
  ensureClientDist();

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

  const team = await call('POST', '/api/teams', { name: 'Billing', key: 'BIL' });
  teamId = team.payload.team.id;

  const form = await call('PUT', `/api/teams/${teamId}/form`, {
    fields: [
      { label: 'Order reference', type: 'text', required: true },
      { label: 'Refund reason', type: 'select', required: true, options: ['Duplicate', 'Faulty', 'Late'] },
      { label: 'Affected regions', type: 'multiselect', options: ['EU', 'US', 'APAC'] },
      { label: 'Contact email', type: 'email' },
      { label: 'Evidence link', type: 'url' },
      { label: 'Seen before', type: 'checkbox' },
      { label: 'Amount', type: 'number' },
    ],
  });
  assert.equal(form.status, 200, JSON.stringify(form.payload));
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await db.close();
  wipe();
});

test('the form is stored with stable keys derived from the labels', async () => {
  const { payload } = await call('GET', `/api/teams/${teamId}/form`);
  const keys = payload.fields.map((field: any) => field.key);
  assert.deepEqual(keys, [
    'order_reference',
    'refund_reason',
    'affected_regions',
    'contact_email',
    'evidence_link',
    'seen_before',
    'amount',
  ]);
  assert.equal(payload.fields[0].required, true);
  assert.deepEqual(payload.fields[1].options, ['Duplicate', 'Faulty', 'Late']);
});

test('a complete submission is stored against the ticket', async () => {
  const { status, payload } = await call('POST', '/api/tickets', {
    subject: 'Refund not received',
    teamId,
    customFields: {
      order_reference: 'ORD-4471',
      refund_reason: 'Duplicate',
      affected_regions: ['EU', 'APAC'],
      contact_email: 'buyer@example.com',
      evidence_link: 'https://example.com/receipt',
      seen_before: true,
      amount: '42.50',
    },
  });
  assert.equal(status, 201, JSON.stringify(payload));

  const detail = await call('GET', `/api/tickets/${payload.ticket.id}`);
  const byKey = Object.fromEntries(detail.payload.ticket.fieldValues.map((v: any) => [v.key, v.value]));
  assert.equal(byKey.order_reference, 'ORD-4471');
  assert.equal(byKey.refund_reason, 'Duplicate');
  assert.deepEqual(byKey.affected_regions, ['EU', 'APAC']);
  assert.equal(byKey.seen_before, true);
  assert.equal(byKey.amount, 42.5, 'numbers are stored as numbers, not strings');

  // The question is stored alongside the answer.
  const first = detail.payload.ticket.fieldValues[0];
  assert.equal(first.label, 'Order reference');
  assert.equal(first.type, 'text');
});

test('a missing required answer is refused', async () => {
  const { status, payload } = await call('POST', '/api/tickets', {
    subject: 'Missing details',
    teamId,
    customFields: { refund_reason: 'Faulty' },
  });
  assert.equal(status, 400);
  assert.match(payload.error, /Order reference/);
});

test('a choice that is not on the list is refused', async () => {
  const { status, payload } = await call('POST', '/api/tickets', {
    subject: 'Bad choice',
    teamId,
    customFields: { order_reference: 'ORD-1', refund_reason: 'Something else entirely' },
  });
  assert.equal(status, 400);
  assert.match(payload.error, /not an option/i);
});

test('malformed values are refused per type', async () => {
  const base = { order_reference: 'ORD-1', refund_reason: 'Late' };
  for (const [field, value, pattern] of [
    ['contact_email', 'not-an-email', /email/i],
    ['evidence_link', 'javascript:alert(1)', /http/i],
    ['amount', 'twelve', /number/i],
  ] as const) {
    const { status, payload } = await call('POST', '/api/tickets', {
      subject: 'Bad value',
      teamId,
      customFields: { ...base, [field]: value },
    });
    assert.equal(status, 400, `${field} should have been refused`);
    assert.match(payload.error, pattern);
  }
});

test('answers for fields belonging to no form are ignored, not stored', async () => {
  const { status, payload } = await call('POST', '/api/tickets', {
    subject: 'Extra keys',
    teamId,
    customFields: { order_reference: 'ORD-9', refund_reason: 'Late', smuggled: 'value', is_admin: true },
  });
  assert.equal(status, 201);

  const detail = await call('GET', `/api/tickets/${payload.ticket.id}`);
  const keys = detail.payload.ticket.fieldValues.map((v: any) => v.key);
  assert.ok(!keys.includes('smuggled'), 'unknown keys must not be stored');
  assert.ok(!keys.includes('is_admin'));
});

test('a ticket with no team is not held to any form', async () => {
  const { status } = await call('POST', '/api/tickets', { subject: 'No team', teamId: null });
  assert.equal(status, 201);
});

test('editing the form keeps existing answers readable', async () => {
  const created = await call('POST', '/api/tickets', {
    subject: 'Before the rename',
    teamId,
    customFields: { order_reference: 'ORD-77', refund_reason: 'Faulty' },
  });

  const current = await call('GET', `/api/teams/${teamId}/form`);
  const fields = current.payload.fields.map((field: any) => ({
    id: field.id,
    label: field.key === 'order_reference' ? 'Order number' : field.label,
    type: field.type,
    required: field.required,
    options: field.options,
  }));
  assert.equal((await call('PUT', `/api/teams/${teamId}/form`, { fields })).status, 200);

  // The answer was recorded under the question as it was asked at the time.
  const detail = await call('GET', `/api/tickets/${created.payload.ticket.id}`);
  const answer = detail.payload.ticket.fieldValues.find((v: any) => v.key === 'order_reference');
  assert.equal(answer.value, 'ORD-77');
  assert.equal(answer.label, 'Order reference', 'the original wording is preserved on the ticket');

  // And the key survived the rename, so new tickets still use it.
  const after = await call('GET', `/api/teams/${teamId}/form`);
  assert.equal(after.payload.fields[0].key, 'order_reference');
  assert.equal(after.payload.fields[0].label, 'Order number');
});

test('removing a field leaves past answers intact', async () => {
  const created = await call('POST', '/api/tickets', {
    subject: 'Before the removal',
    teamId,
    customFields: { order_reference: 'ORD-88', refund_reason: 'Late' },
  });

  const current = await call('GET', `/api/teams/${teamId}/form`);
  const kept = current.payload.fields
    .filter((field: any) => field.key !== 'refund_reason')
    .map((field: any) => ({ id: field.id, label: field.label, type: field.type, required: field.required, options: field.options }));
  assert.equal((await call('PUT', `/api/teams/${teamId}/form`, { fields: kept })).status, 200);

  const detail = await call('GET', `/api/tickets/${created.payload.ticket.id}`);
  const answer = detail.payload.ticket.fieldValues.find((v: any) => v.key === 'refund_reason');
  assert.ok(answer, 'the answer should outlive the question');
  assert.equal(answer.value, 'Late');
});

test('a choice field with no options is refused', async () => {
  const { status, payload } = await call('PUT', `/api/teams/${teamId}/form`, {
    fields: [{ label: 'Pick one', type: 'select', options: [] }],
  });
  assert.equal(status, 400);
  assert.match(payload.error, /at least one option/i);
});
