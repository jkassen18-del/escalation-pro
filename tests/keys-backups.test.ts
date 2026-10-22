/**
 * Key management: a backup file plus its key restores with no InfraTicket
 * database, older backups still restore through the app, and a server started
 * with a different encryption key says so instead of quietly losing secrets.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import zlib from 'node:zlib';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'it-keys-'));
const BACKUP_KEY = 'backup-escrow-key-'.padEnd(48, 'b');

// Before any server module loads: config reads these once, at import.
process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = 'sqlite';
process.env.DATA_DIR = DATA_DIR;
process.env.SQLITE_FILE = 'keys.db';
process.env.SESSION_SECRET = 'k'.repeat(48);
process.env.SECRET_KEY = 's'.repeat(64);
process.env.BACKUP_KEY = BACKUP_KEY;
process.env.OPS_TICK_MS = String(24 * 3600 * 1000);
delete process.env.DATABASE_URL;
delete process.env.ALLOW_KEY_CHANGE;

const { db, initDatabase } = await import('../server/db/index.ts');
const { encryptSecret, randomId } = await import('../server/lib/crypto.ts');
const { openDecryptedBackup, runBackup, saveJob, validateJob } = await import('../server/ops/backups.ts');
const { decryptBackupFile, deriveKey } = await import('../server/ops/backup-format.ts');
const { checkEncryptionKey } = await import('../server/lib/key-check.ts');

const require = createRequire(import.meta.url);
let source: string;
let jobId: string;

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

function countCustomers(file: string): number {
  const { DatabaseSync } = require('node:sqlite') as any;
  const check = new DatabaseSync(file);
  try {
    return check.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  } finally {
    check.close();
  }
}

before(async () => {
  await initDatabase();
  source = path.join(DATA_DIR, 'app.db');
  const { DatabaseSync } = (await import('node:sqlite')) as any;
  const sqlite = new DatabaseSync(source);
  sqlite.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO customers (name) VALUES ('Ada'), ('Grace'), ('Hedy');`);
  sqlite.close();
  const job = await saveJob(
    null,
    validateJob({ name: 'App DB', engine: 'sqlite', connection: source, destination: { type: 'local', path: path.join(DATA_DIR, 'out') } }, false),
  );
  jobId = job.id;
});

after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('a backup file plus BACKUP_KEY restores without the database', async () => {
  const run = await runBackup(jobId);
  assert.equal(run.status, 'succeeded', run.error ?? '');
  const stored = fs.readFileSync(run.location!);
  assert.equal(stored.subarray(0, 5).toString(), 'ITBK2');
  assert.ok(!stored.includes(Buffer.from('Grace')), 'the file is encrypted');

  // Copied away from the server, with only the key: the disaster case.
  const offsite = path.join(DATA_DIR, 'offsite.sqlite.gz.enc');
  fs.copyFileSync(run.location!, offsite);
  const written = await decryptBackupFile(offsite, undefined, { BACKUP_KEY }, []);
  assert.equal(written, path.join(DATA_DIR, 'offsite.sqlite'));
  assert.equal(countCustomers(written), 3);

  await assert.rejects(
    decryptBackupFile(offsite, path.join(DATA_DIR, 'nope'), { SECRET_KEY: 'the wrong key'.padEnd(40, 'x') }, []),
    /None of the keys/,
  );
  assert.ok(!fs.existsSync(path.join(DATA_DIR, 'nope')), 'nothing is written with the wrong key');

  // The command-line tool does the same from the environment.
  const out = path.join(DATA_DIR, 'cli.sqlite');
  const cli = spawnSync(process.execPath, ['--import', 'tsx', path.resolve(import.meta.dirname, '../scripts/decrypt-backup.ts'), offsite, out], {
    env: { ...process.env, BACKUP_KEY, DATA_DIR: path.join(DATA_DIR, 'none') },
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(countCustomers(out), 3);

  // And the app still serves it.
  const restored = await readAll((await openDecryptedBackup(run.id)).stream);
  assert.equal(restored.subarray(0, 15).toString(), 'SQLite format 3');
});

test('a tampered backup fails instead of restoring garbage', async () => {
  const run = await runBackup(jobId);
  const bad = path.join(DATA_DIR, 'tampered.sqlite.gz.enc');
  const bytes = fs.readFileSync(run.location!);
  bytes[bytes.length - 40] ^= 0xff;
  fs.writeFileSync(bad, bytes);
  await assert.rejects(decryptBackupFile(bad, undefined, { BACKUP_KEY }, []), /damaged or was modified/);
});

test('an ITBK1 backup from before the header change still restores', async () => {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(fs.readFileSync(source))), cipher.final()]);
  const file = path.join(DATA_DIR, 'old.sqlite.gz.enc');
  fs.writeFileSync(file, Buffer.concat([Buffer.from('ITBK1'), iv, body, cipher.getAuthTag()]));
  const runId = randomId();
  await db.run(
    `INSERT INTO backup_runs (id, job_id, status, run_trigger, started_at, finished_at, location, wrapped_key) VALUES (?, ?, 'succeeded', 'manual', ?, ?, ?, ?)`,
    [runId, jobId, new Date().toISOString(), new Date().toISOString(), file, encryptSecret(key.toString('base64'))],
  );
  const restored = await readAll((await openDecryptedBackup(runId)).stream);
  assert.equal(restored.subarray(0, 15).toString(), 'SQLite format 3');
  // The standalone tool cannot open these, and says where to go instead.
  await assert.rejects(decryptBackupFile(file, undefined, { BACKUP_KEY }, []), /older InfraTicket/);
});

test('a changed encryption key is detected at startup', async () => {
  assert.equal(await checkEncryptionKey(), 'recorded');
  assert.equal(await checkEncryptionKey(), 'match');

  const other = deriveKey('a different secret key'.padEnd(48, 'z'));
  const errors: string[] = [];
  const original = console.error;
  console.error = (message: string) => errors.push(String(message));
  try {
    assert.equal(await checkEncryptionKey({ key: other, strict: false }), 'mismatch', 'a laptop copy still opens');
    assert.match(errors.join('\n'), /ENCRYPTION KEY MISMATCH/);
    await assert.rejects(checkEncryptionKey({ key: other, strict: true }), /Encryption key mismatch/, 'a server refuses to start');
  } finally {
    console.error = original;
  }
  assert.equal(await checkEncryptionKey(), 'match', 'a mismatch does not overwrite the recorded key');

  process.env.ALLOW_KEY_CHANGE = '1';
  try {
    assert.equal(await checkEncryptionKey({ key: other, strict: true }), 'mismatch-allowed');
  } finally {
    delete process.env.ALLOW_KEY_CHANGE;
  }
  assert.equal(await checkEncryptionKey({ key: other, strict: true }), 'match', 'the accepted key is now the recorded one');
});
