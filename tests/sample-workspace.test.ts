/**
 * "Start with a sample workspace" on the setup screen: one request should
 * leave a new install with a working rota, policy, monitors and status page.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = 'sample-workspace.db';
process.env.SESSION_SECRET = 'y'.repeat(48);
delete process.env.DATABASE_URL;
delete process.env.SETUP_TOKEN;

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const wipe = () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA_DIR, `sample-workspace.db${suffix}`), { force: true });
};

let server: http.Server;
let base: string;
let db: typeof import('../server/db/index.ts').db;

before(async () => {
  wipe();
  const dist = path.resolve(import.meta.dirname, '../dist/client');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }
  const dbModule = await import('../server/db/index.ts');
  db = dbModule.db;
  await dbModule.initDatabase();
  const { createApp } = await import('../server/index.ts');
  server = http.createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db.close();
  wipe();
});

test('setup can start from a sample operations workspace', async () => {
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Owner', email: 'owner@acme.test', password: 'Owner-Password-1', organizationName: 'Acme', sampleWorkspace: true }),
  });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get('set-cookie')!.split(';')[0];
  const get = async (url: string) => (await fetch(`${base}${url}`, { headers: { cookie } })).json() as Promise<any>;

  const { schedules } = await get('/api/ops/schedules');
  assert.equal(schedules[0].onCallNow.userName, 'Owner', 'the owner is on call');
  const { policies } = await get('/api/ops/policies');
  assert.equal(policies[0].levels.length, 2);
  const { teams } = await get('/api/ops/team-policies');
  assert.equal(teams.find((t: any) => t.policyId)?.teamId, policies[0].teamId, 'the policy is its team\'s default');
  const { monitors } = await get('/api/ops/monitors');
  assert.deepEqual(monitors.map((m: any) => m.kind).sort(), ['heartbeat', 'http', 'tcp']);
  const status = await fetch(`${base}/status/status`);
  assert.equal(status.status, 200);
});
