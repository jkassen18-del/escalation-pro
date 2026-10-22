import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { paths } from '../config.ts';
import { db, parseJson, toBool } from '../db/index.ts';
import { decryptSecret, encryptSecret, randomId } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import {
  BACKUP_ENGINES,
  type BackupDestination,
  type BackupEngine,
  type BackupJob,
  type BackupRetention,
  type BackupRun,
} from '../../shared/ops.ts';
import { cronPeriodSecs, nextCronTime, parseCron } from './cron.ts';
import { maskConnection, runTool, sqlcmdArgs, toolPath } from './db-health.ts';
import { recordHeartbeat, saveMonitor } from './monitors.ts';
import { deleteObject, getObject, putObject, type S3Target } from './s3.ts';

/**
 * Scheduled, encrypted backups of customer databases.
 *
 * dump -> gzip -> AES-256-GCM with a fresh key per backup -> local disk or
 * S3-compatible storage -> SHA-256 recorded. The per-backup key is wrapped
 * with the instance key, so a stolen bucket is useless without this server's
 * SECRET_KEY, and one leaked backup key opens one backup.
 *
 * Every job owns a heartbeat monitor. A successful run pings it; a run that
 * fails reports failure; and a job that silently stops running misses its
 * pings - all three page the job's team like any other monitor.
 */

const MAGIC = Buffer.from('ITBK1');
const DEFAULT_RETENTION: BackupRetention = { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 };
const DUMP_TIMEOUT_MS = Number(process.env.BACKUP_TIMEOUT_MINS || 120) * 60_000;

interface JobRow {
  id: string;
  name: string;
  engine: BackupEngine;
  connection_encrypted: string;
  connection_hint: string;
  schedule: string;
  retention: string;
  destination: string;
  enabled: number | string;
  team_id: string | null;
  heartbeat_monitor_id: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  last_run_at?: string | null;
  last_status?: BackupJob['lastStatus'];
}

interface StoredDestination extends Omit<BackupDestination, 'secretAccessKey' | 'hasSecret'> {
  secretEncrypted?: string;
}

function publicDestination(stored: StoredDestination): BackupDestination {
  const { secretEncrypted, ...rest } = stored;
  return { ...rest, hasSecret: Boolean(secretEncrypted) };
}

function mapJob(row: JobRow): BackupJob {
  return {
    id: row.id,
    name: row.name,
    engine: row.engine,
    connectionHint: row.connection_hint,
    schedule: row.schedule,
    retention: { ...DEFAULT_RETENTION, ...parseJson<Partial<BackupRetention>>(row.retention, {}) },
    destination: publicDestination(parseJson<StoredDestination>(row.destination, { type: 'local' })),
    enabled: toBool(row.enabled),
    teamId: row.team_id,
    heartbeatMonitorId: row.heartbeat_monitor_id,
    lastRunAt: row.last_run_at ?? null,
    lastStatus: row.last_status ?? null,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_JOB = `
  SELECT j.*,
    (SELECT r.started_at FROM backup_runs r WHERE r.job_id = j.id AND r.status <> 'pruned' ORDER BY r.started_at DESC LIMIT 1) AS last_run_at,
    (SELECT r.status FROM backup_runs r WHERE r.job_id = j.id AND r.status <> 'pruned' ORDER BY r.started_at DESC LIMIT 1) AS last_status
  FROM backup_jobs j`;

export async function listJobs(): Promise<BackupJob[]> {
  return (await db.all<JobRow>(`${SELECT_JOB} ORDER BY j.name`)).map(mapJob);
}

export async function getJob(id: string): Promise<BackupJob | null> {
  const row = await db.get<JobRow>(`${SELECT_JOB} WHERE j.id = ?`, [id]);
  return row ? mapJob(row) : null;
}

async function loadJobRow(id: string): Promise<JobRow | undefined> {
  return db.get<JobRow>(`SELECT * FROM backup_jobs WHERE id = ?`, [id]);
}

export async function jobConnection(id: string): Promise<{ engine: BackupEngine; connection: string } | null> {
  const row = await loadJobRow(id);
  return row ? { engine: row.engine, connection: decryptSecret(row.connection_encrypted) } : null;
}

export function connectionHint(engine: BackupEngine, connection: string): string {
  return engine === 'sqlite' ? connection : maskConnection(connection);
}

export async function listRuns(jobId: string, limit = 50): Promise<BackupRun[]> {
  const rows = await db.all<Record<string, string | number | null>>(
    `SELECT * FROM backup_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?`,
    [jobId, limit],
  );
  return rows.map(mapRun);
}

function mapRun(row: Record<string, string | number | null>): BackupRun {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    status: row.status as BackupRun['status'],
    trigger: row.run_trigger as BackupRun['trigger'],
    startedAt: String(row.started_at),
    finishedAt: (row.finished_at as string | null) ?? null,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    sha256: (row.sha256 as string | null) ?? null,
    location: (row.location as string | null) ?? null,
    error: (row.error as string | null) ?? null,
  };
}

/* --------------------------------- Writes -------------------------------- */

export interface JobInput {
  name: string;
  engine: BackupEngine;
  connection: string | null;
  schedule: string;
  retention: BackupRetention;
  destination: BackupDestination;
  enabled: boolean;
  teamId: string | null;
}

export function validateJob(body: Record<string, unknown>, existing: boolean): JobInput {
  const name = String(body.name ?? '').trim().slice(0, 120);
  if (!name) throw badRequest('Give the database a name.', { name: 'Required' });
  const engine = body.engine as BackupEngine;
  if (!BACKUP_ENGINES.includes(engine)) throw badRequest('Unknown database engine.');
  const connection = typeof body.connection === 'string' && body.connection.trim() ? body.connection.trim().slice(0, 2000) : null;
  if (!connection && !existing) throw badRequest('Give the connection string or file path.', { connection: 'Required' });
  if (connection && engine === 'supabase' && /:6543\b|pooler\.supabase/.test(connection)) {
    throw badRequest('pg_dump needs the direct connection (port 5432), not the Supabase pooler.', { connection: 'Use the direct connection' });
  }
  const schedule = String(body.schedule ?? '0 1 * * *').trim();
  try {
    parseCron(schedule);
  } catch (error) {
    throw badRequest((error as Error).message, { schedule: 'Invalid schedule' });
  }
  const r = (body.retention ?? {}) as Partial<BackupRetention>;
  const keep = (value: unknown, fallback: number) => Math.min(365, Math.max(0, Math.round(Number(value ?? fallback))));
  const retention = { keepDaily: keep(r.keepDaily, 7), keepWeekly: keep(r.keepWeekly, 4), keepMonthly: keep(r.keepMonthly, 12) };
  if (retention.keepDaily + retention.keepWeekly + retention.keepMonthly === 0) throw badRequest('Keep at least one backup.');
  const d = (body.destination ?? { type: 'local' }) as BackupDestination;
  const destination: BackupDestination =
    d.type === 's3'
      ? {
          type: 's3',
          endpoint: d.endpoint?.trim() || undefined,
          region: d.region?.trim() || 'us-east-1',
          bucket: String(d.bucket ?? '').trim(),
          prefix: (d.prefix ?? 'infraticket-backups').replace(/^\/+|\/+$/g, ''),
          accessKeyId: d.accessKeyId?.trim(),
          secretAccessKey: d.secretAccessKey?.trim() || undefined,
        }
      : { type: 'local', path: d.path?.trim() || undefined };
  if (destination.type === 's3' && (!destination.bucket || !destination.accessKeyId)) {
    throw badRequest('S3 storage needs a bucket and an access key.', { bucket: 'Required' });
  }
  if (destination.endpoint && !/^https?:\/\//.test(destination.endpoint)) throw badRequest('The storage endpoint must be a URL.');
  return { name, engine, connection, schedule, retention, destination, enabled: body.enabled !== false, teamId: typeof body.teamId === 'string' && body.teamId ? body.teamId : null };
}

export async function saveJob(id: string | null, input: JobInput): Promise<BackupJob> {
  const previous = id ? await loadJobRow(id) : undefined;
  if (id && !previous) throw badRequest('That database no longer exists.');
  if (!input.connection && !previous) throw badRequest('Give the connection string or file path.', { connection: 'Required' });
  const now = new Date().toISOString();
  const prevDest = previous ? parseJson<StoredDestination>(previous.destination, { type: 'local' }) : undefined;
  const { secretAccessKey, hasSecret: _ignored, ...dest } = input.destination;
  const stored: StoredDestination = {
    ...dest,
    secretEncrypted: secretAccessKey ? encryptSecret(secretAccessKey) : dest.type === 's3' ? prevDest?.secretEncrypted : undefined,
  };
  if (stored.type === 's3' && !stored.secretEncrypted) throw badRequest('Give the secret access key for the bucket.', { secretAccessKey: 'Required' });

  const nextRun = nextCronTime(input.schedule).toISOString();
  const periodSecs = cronPeriodSecs(input.schedule);
  const jobId = id ?? randomId();
  const connectionEncrypted = input.connection ? encryptSecret(input.connection) : previous!.connection_encrypted;
  const hint = input.connection ? connectionHint(input.engine, input.connection) : previous!.connection_hint;

  // The job's dead-man's switch: due once per schedule period, with an hour's grace for a long dump.
  const heartbeat = await saveMonitor(previous?.heartbeat_monitor_id ?? null, {
    name: `Backup: ${input.name}`,
    kind: 'heartbeat',
    target: '',
    config: {},
    intervalSecs: Math.max(60, periodSecs),
    graceSecs: Math.min(86_400, Math.max(3600, Math.round(periodSecs / 4))),
    failureThreshold: 1,
    teamId: input.teamId,
    severity: 'sev3',
    escalationPolicyId: null,
    enabled: input.enabled,
  });

  if (id) {
    await db.run(
      `UPDATE backup_jobs SET name = ?, engine = ?, connection_encrypted = ?, connection_hint = ?, schedule = ?, retention = ?, destination = ?,
         enabled = ?, team_id = ?, heartbeat_monitor_id = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
      [input.name, input.engine, connectionEncrypted, hint, input.schedule, JSON.stringify(input.retention), JSON.stringify(stored), input.enabled ? 1 : 0, input.teamId, heartbeat.id, nextRun, now, id],
    );
  } else {
    await db.run(
      `INSERT INTO backup_jobs (id, name, engine, connection_encrypted, connection_hint, schedule, retention, destination, enabled, team_id,
         heartbeat_monitor_id, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [jobId, input.name, input.engine, connectionEncrypted, hint, input.schedule, JSON.stringify(input.retention), JSON.stringify(stored), input.enabled ? 1 : 0, input.teamId, heartbeat.id, nextRun, now, now],
    );
  }
  return (await getJob(jobId))!;
}

export async function deleteJob(id: string): Promise<void> {
  const row = await loadJobRow(id);
  if (!row) return;
  await db.run(`DELETE FROM backup_jobs WHERE id = ?`, [id]);
  if (row.heartbeat_monitor_id) await db.run(`DELETE FROM monitors WHERE id = ?`, [row.heartbeat_monitor_id]);
}

/* ------------------------------- Dumping --------------------------------- */

function backupsDir(destination: StoredDestination): string {
  const dir = path.resolve(destination.path || path.join(paths.data, 'backups'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

interface DumpStream {
  stream: Readable;
  /** Resolves when the dump tool exits successfully, rejects with its stderr otherwise. */
  done: Promise<void>;
  extension: string;
}

function spawnDump(tool: string, args: string[], env: NodeJS.ProcessEnv = {}): DumpStream & { extension: string } {
  const child = spawn(toolPath(tool), args, { env: { ...process.env, ...env }, windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), DUMP_TIMEOUT_MS);
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error(`${tool} is not installed on this server. Install the database's client tools or set BACKUP_TOOLS_DIR.`)
          : error,
      );
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(signal === 'SIGKILL' ? `${tool} ran longer than ${DUMP_TIMEOUT_MS / 60_000} minutes` : stderr.trim().split('\n').slice(-3).join(' ') || `${tool} exited with ${code}`));
    });
  });
  return { stream: child.stdout, done, extension: '' };
}

function mysqlArgs(connection: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const url = new URL(connection);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error('The MySQL connection string must name a database: mysql://user:pass@host:3306/dbname');
  const args = ['--single-transaction', '--quick', '--routines', '--triggers', '--events', '-h', url.hostname, '-P', url.port || '3306'];
  if (url.username) args.push('-u', decodeURIComponent(url.username));
  args.push(database);
  return { args, env: url.password ? { MYSQL_PWD: decodeURIComponent(url.password) } : {} };
}

async function startDump(engine: BackupEngine, connection: string, scratch: string): Promise<DumpStream> {
  switch (engine) {
    case 'postgres':
    case 'supabase': {
      const dump = spawnDump('pg_dump', ['--format=custom', '--compress=0', '--no-owner', '--no-privileges', `--dbname=${connection}`]);
      return { ...dump, extension: 'pgdump' };
    }
    case 'mysql': {
      const { args, env } = mysqlArgs(connection);
      const dump = spawnDump('mysqldump', args, env);
      return { ...dump, extension: 'sql' };
    }
    case 'mongodb': {
      const dump = spawnDump('mongodump', [`--uri=${connection}`, '--archive']);
      return { ...dump, extension: 'archive' };
    }
    case 'sqlite': {
      // The online backup, safe while the database is in use.
      const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
        DatabaseSync: new (p: string) => { prepare(sql: string): { run(...a: unknown[]): unknown }; close(): void };
      };
      if (!fs.existsSync(connection)) throw new Error(`${connection} does not exist`);
      const copy = path.join(scratch, 'copy.sqlite');
      const source = new DatabaseSync(connection);
      try {
        source.prepare('VACUUM INTO ?').run(copy);
      } finally {
        source.close();
      }
      return { stream: fs.createReadStream(copy), done: Promise.resolve(), extension: 'sqlite' };
    }
    case 'sqlserver': {
      // BACKUP DATABASE writes on the SQL Server host, so this path must be one it can write
      // and this server can read: the same machine, or a share both can reach.
      const dir = process.env.SQLSERVER_BACKUP_DIR || scratch;
      const file = path.join(dir, `infraticket-${Date.now()}.bak`);
      const database = /(?:database|initial catalog)=([^;]+)/i.exec(connection)?.[1];
      if (!database) throw new Error('The SQL Server connection must include Database=...');
      await runTool('sqlcmd', [...sqlcmdArgs(connection), '-Q', `BACKUP DATABASE [${database.replace(/]/g, ']]')}] TO DISK = N'${file.replace(/'/g, "''")}' WITH COPY_ONLY, INIT`], {
        timeoutMs: DUMP_TIMEOUT_MS,
      });
      const stream = fs.createReadStream(file);
      stream.once('close', () => fs.rm(file, { force: true }, () => undefined));
      return { stream, done: Promise.resolve(), extension: 'bak' };
    }
  }
}

/** Encrypted file layout: "ITBK1" | 12-byte IV | ciphertext of gzip(dump) | 16-byte GCM tag. */
function encryptor(key: Buffer): { iv: Buffer; cipher: crypto.CipherGCM } {
  const iv = crypto.randomBytes(12);
  return { iv, cipher: crypto.createCipheriv('aes-256-gcm', key, iv) };
}

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

function s3Target(destination: StoredDestination): S3Target {
  return {
    endpoint: destination.endpoint,
    region: destination.region,
    bucket: destination.bucket!,
    accessKeyId: destination.accessKeyId!,
    secretAccessKey: decryptSecret(destination.secretEncrypted ?? ''),
  };
}

const running = new Set<string>();

export async function runBackup(jobId: string, trigger: BackupRun['trigger'] = 'manual'): Promise<BackupRun> {
  const job = await loadJobRow(jobId);
  if (!job) throw badRequest('That backup job no longer exists.');
  if (running.has(jobId)) throw badRequest('This backup is already running.');
  running.add(jobId);

  const runId = randomId();
  const startedAt = new Date().toISOString();
  await db.run(`INSERT INTO backup_runs (id, job_id, status, run_trigger, started_at) VALUES (?, ?, 'running', ?, ?)`, [runId, jobId, trigger, startedAt]);
  const destination = parseJson<StoredDestination>(job.destination, { type: 'local' });
  const scratch = fs.mkdtempSync(path.join(paths.data, '.backup-'));
  try {
    const dump = await startDump(job.engine, decryptSecret(job.connection_encrypted), scratch);
    const key = crypto.randomBytes(32);
    const { iv, cipher } = encryptor(key);
    const stamp = startedAt.replace(/[:.]/g, '-');
    const fileName = `${job.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${stamp}.${dump.extension}.gz.enc`;
    const encrypted = path.join(scratch, fileName);
    const out = fs.createWriteStream(encrypted);
    out.write(Buffer.concat([MAGIC, iv]));
    await Promise.all([pipeline(dump.stream, zlib.createGzip({ level: 6 }), cipher, out, { end: false }).then(() => new Promise<void>((resolve) => out.end(cipher.getAuthTag(), resolve))), dump.done]);

    const size = fs.statSync(encrypted).size;
    const sha256 = await sha256File(encrypted);
    let location: string;
    if (destination.type === 's3') {
      const keyName = `${destination.prefix ? `${destination.prefix}/` : ''}${job.id}/${fileName}`;
      location = await putObject(s3Target(destination), keyName, encrypted, sha256);
    } else {
      location = path.join(backupsDir(destination), fileName);
      fs.renameSync(encrypted, location);
    }

    await db.run(
      `UPDATE backup_runs SET status = 'succeeded', finished_at = ?, size_bytes = ?, sha256 = ?, location = ?, wrapped_key = ? WHERE id = ?`,
      [new Date().toISOString(), size, sha256, location, encryptSecret(key.toString('base64')), runId],
    );
    if (job.heartbeat_monitor_id) {
      const token = await db.get<{ heartbeat_token: string }>(`SELECT heartbeat_token FROM monitors WHERE id = ?`, [job.heartbeat_monitor_id]);
      if (token) await recordHeartbeat(token.heartbeat_token);
    }
    await applyRetention(job).catch((error) => console.error(`[backup] retention for ${job.name} failed`, error));
  } catch (error) {
    const message = (error as Error).message.slice(0, 2000);
    await db.run(`UPDATE backup_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`, [new Date().toISOString(), message, runId]);
    if (job.heartbeat_monitor_id) {
      const token = await db.get<{ heartbeat_token: string }>(`SELECT heartbeat_token FROM monitors WHERE id = ?`, [job.heartbeat_monitor_id]);
      if (token) await recordHeartbeat(token.heartbeat_token, { fail: true, message: `Backup failed: ${message}` });
    }
  } finally {
    running.delete(jobId);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const row = await db.get<Record<string, string | number | null>>(`SELECT * FROM backup_runs WHERE id = ?`, [runId]);
  return mapRun(row!);
}

/* ------------------------------- Retention ------------------------------- */

function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)}`;
}

/** Grandfather-father-son: the newest backup of each of the last N days, weeks and months. */
export function selectKept(runs: Array<{ id: string; startedAt: string }>, retention: BackupRetention): Set<string> {
  const sorted = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const keep = new Set<string>();
  if (sorted[0]) keep.add(sorted[0].id);
  const buckets: Array<[number, (d: Date) => string]> = [
    [retention.keepDaily, (d) => d.toISOString().slice(0, 10)],
    [retention.keepWeekly, isoWeek],
    [retention.keepMonthly, (d) => d.toISOString().slice(0, 7)],
  ];
  for (const [count, bucketOf] of buckets) {
    const seen = new Set<string>();
    for (const run of sorted) {
      if (seen.size >= count) break;
      const bucket = bucketOf(new Date(run.startedAt));
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      keep.add(run.id);
    }
  }
  return keep;
}

async function applyRetention(job: JobRow): Promise<void> {
  const retention = { ...DEFAULT_RETENTION, ...parseJson<Partial<BackupRetention>>(job.retention, {}) };
  const runs = await db.all<{ id: string; started_at: string; location: string | null }>(
    `SELECT id, started_at, location FROM backup_runs WHERE job_id = ? AND status = 'succeeded'`,
    [job.id],
  );
  const keep = selectKept(runs.map((r) => ({ id: r.id, startedAt: r.started_at })), retention);
  const destination = parseJson<StoredDestination>(job.destination, { type: 'local' });
  for (const run of runs) {
    if (keep.has(run.id) || !run.location) continue;
    try {
      if (run.location.startsWith('s3://')) {
        const key = run.location.replace(/^s3:\/\/[^/]+\//, '');
        await deleteObject(s3Target(destination), key);
      } else {
        fs.rmSync(run.location, { force: true });
      }
      await db.run(`UPDATE backup_runs SET status = 'pruned', wrapped_key = NULL WHERE id = ?`, [run.id]);
    } catch (error) {
      // An immutable (Object Lock) copy refuses deletion until it expires; leave it for next time.
      console.warn(`[backup] could not prune ${run.location}: ${(error as Error).message}`);
    }
  }
}

/* -------------------------------- Restore -------------------------------- */

/**
 * The decrypted, decompressed dump - what pg_restore, mysql or mongorestore
 * takes. Authenticated decryption: a tampered or truncated file fails here
 * instead of restoring garbage.
 */
export async function openDecryptedBackup(runId: string): Promise<{ stream: Readable; fileName: string }> {
  const run = await db.get<{ job_id: string; location: string | null; wrapped_key: string | null; status: string }>(
    `SELECT job_id, location, wrapped_key, status FROM backup_runs WHERE id = ?`,
    [runId],
  );
  if (!run || run.status !== 'succeeded' || !run.location || !run.wrapped_key) throw badRequest('That backup is not available.');
  const job = await loadJobRow(run.job_id);
  if (!job) throw badRequest('That backup job no longer exists.');
  const destination = parseJson<StoredDestination>(job.destination, { type: 'local' });

  const encryptedFile = path.join(fs.mkdtempSync(path.join(paths.data, '.restore-')), 'backup.enc');
  if (run.location.startsWith('s3://')) {
    const response = await getObject(s3Target(destination), run.location.replace(/^s3:\/\/[^/]+\//, ''));
    await pipeline(response, fs.createWriteStream(encryptedFile));
  } else {
    fs.copyFileSync(run.location, encryptedFile);
  }
  const size = fs.statSync(encryptedFile).size;
  const fd = fs.openSync(encryptedFile, 'r');
  const header = Buffer.alloc(MAGIC.length + 12);
  const tag = Buffer.alloc(16);
  fs.readSync(fd, header, 0, header.length, 0);
  fs.readSync(fd, tag, 0, 16, size - 16);
  fs.closeSync(fd);
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw badRequest('That file is not an InfraTicket backup.');

  const key = Buffer.from(decryptSecret(run.wrapped_key), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  const output = new PassThrough();
  const cleanup = () => fs.rm(path.dirname(encryptedFile), { recursive: true, force: true }, () => undefined);
  pipeline(
    fs.createReadStream(encryptedFile, { start: header.length, end: size - 17 }),
    decipher,
    zlib.createGunzip(),
    output,
  )
    .catch((error) => output.destroy(error))
    .finally(cleanup);
  const base = path.basename(run.location).replace(/\.gz\.enc$/, '');
  return { stream: output, fileName: base };
}

/* ------------------------------- Scheduler ------------------------------- */

export async function runDueBackups(): Promise<number> {
  const now = new Date().toISOString();
  const due = await db.all<JobRow>(`SELECT * FROM backup_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`, [now]);
  for (const job of due) {
    await db.run(`UPDATE backup_jobs SET next_run_at = ? WHERE id = ?`, [nextCronTime(job.schedule).toISOString(), job.id]);
    // Backups can take a long time; they run in the background, not inside the tick.
    void runBackup(job.id, 'schedule').catch((error) => console.error(`[backup] ${job.name} failed`, error));
  }
  return due.length;
}
