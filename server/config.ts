import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const ROOT = process.cwd();

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Serverless platforms give you a read-only filesystem (except /tmp) and a
 * container that is discarded between requests. Detecting this decides where
 * the database lives, whether uploads can touch disk, and whether the
 * in-process SLA timer is worth starting.
 */
export const IS_SERVERLESS = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY,
);

/**
 * Creating the directory is best-effort: on a read-only filesystem the path is
 * still returned so imports do not throw at cold start. Anything that actually
 * writes there checks `hasWritableDisk` first.
 */
function dirOf(envVar: string, fallback: string) {
  const dir = path.resolve(ROOT, process.env[envVar] || fallback);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Read-only filesystem; the caller decides how to degrade.
  }
  return dir;
}

export const paths = {
  root: ROOT,
  data: dirOf('DATA_DIR', 'data'),
  uploads: dirOf('UPLOADS_DIR', 'data/uploads'),
  exports: dirOf('EXPORTS_DIR', 'data/exports'),
  clientDist: path.resolve(ROOT, 'dist/client'),
};

/**
 * Postgres is used when DATABASE_URL (or the discrete PG* vars) are present.
 * Otherwise the app falls back to an embedded SQLite file so that a plain
 * `npm install && npm run dev` works with nothing else installed.
 */
function resolveDriver(): 'postgres' | 'sqlite' {
  const explicit = (process.env.DB_DRIVER || '').toLowerCase();
  if (explicit === 'postgres' || explicit === 'sqlite') return explicit;
  if (process.env.DATABASE_URL || process.env.PGHOST || process.env.PGDATABASE) return 'postgres';
  return 'sqlite';
}

/**
 * A SQLite file under /tmp would vanish between invocations, so a serverless
 * deployment without DATABASE_URL is a misconfiguration worth refusing.
 *
 * Checked when the connection is opened, never at module load: throwing while
 * this module is being imported makes the whole function unloadable, and the
 * platform reports that as an opaque invocation failure with no way for
 * /health to explain what is actually wrong.
 */
export function assertDatabaseConfigured(): void {
  if (IS_SERVERLESS && dbConfig.driver === 'sqlite') {
    throw new Error(
      'DATABASE_URL is not set. A serverless deployment needs an external database: ' +
        'the embedded SQLite file requires a persistent filesystem, which this platform ' +
        'does not provide. Set DATABASE_URL to a pooled Postgres connection string.',
    );
  }
}

/** True when uploads can be written beside the app and read back later. */
export function hasWritableDisk(): boolean {
  if (IS_SERVERLESS) return false;
  try {
    fs.accessSync(paths.uploads, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Works out the TLS settings for Postgres.
 *
 * Managed providers (Supabase, Render, Heroku) terminate TLS with their own
 * private CA, which the system trust store does not know about. Leaving
 * `sslmode=require` in the connection string makes node-postgres verify
 * against that store and fail with "self-signed certificate in certificate
 * chain", so the mode is parsed out here and turned into an explicit setting.
 *
 * `rejectUnauthorized: false` still encrypts the connection, it just does not
 * authenticate the server. To verify properly, point PGSSLROOTCERT at the
 * provider's CA certificate (a file path or the PEM itself) and the
 * certificate chain is checked against it.
 */
function resolveSslConfig(url: string): false | { rejectUnauthorized: boolean; ca?: string } {
  const mode = (
    url.match(/[?&]sslmode=([^&]+)/)?.[1] ??
    process.env.PGSSLMODE ??
    ''
  ).toLowerCase();

  if (mode === 'disable') return false;

  const rootCert = process.env.PGSSLROOTCERT;
  if (rootCert) {
    const ca = rootCert.includes('BEGIN CERTIFICATE')
      ? rootCert
      : fs.readFileSync(path.resolve(ROOT, rootCert), 'utf8');
    return { rejectUnauthorized: true, ca };
  }

  // No mode and no TLS hint at all: a local Postgres usually has no TLS.
  if (!mode && !url) return false;
  if (!mode && /localhost|127\.0\.0\.1/.test(url)) return false;

  return { rejectUnauthorized: false };
}

/** node-postgres reads sslmode from the string itself, so it is stripped. */
function stripSslMode(url: string): string {
  return url.replace(/([?&])sslmode=[^&]*&?/, (_match, sep) => (sep === '?' ? '?' : '&')).replace(/[?&]$/, '');
}

export const dbConfig = {
  driver: resolveDriver(),
  connectionString: stripSslMode(process.env.DATABASE_URL || ''),
  sqlitePath: path.join(paths.data, process.env.SQLITE_FILE || 'escalation-pro.db'),
  ssl: resolveSslConfig(process.env.DATABASE_URL || ''),
};

const SESSION_SECRET_FILE = path.join(paths.data, '.session-secret');

/**
 * A stable secret keeps sessions alive across restarts. If the operator did not
 * supply one we generate it once and keep it beside the database, rather than
 * regenerating per boot (which would silently log everyone out).
 */
function resolveSessionSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (IS_PRODUCTION) {
    console.warn(
      '[config] SESSION_SECRET is not set. Generating a persisted local secret. ' +
        'Set SESSION_SECRET explicitly for multi-instance deployments.',
    );
  }
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) {
      const existing = fs.readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SESSION_SECRET_FILE, generated, { mode: 0o600 });
    return generated;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
}

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  sessionSecret: resolveSessionSecret(),
  /** Secure cookies require HTTPS; enabling them on plain HTTP breaks login. */
  cookieSecure: (process.env.SESSION_COOKIE_SECURE || '').toLowerCase() === 'true',
  sessionMaxAgeMs: Number(process.env.SESSION_MAX_AGE_HOURS || 12) * 60 * 60 * 1000,
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 15) * 1024 * 1024,
  appUrl: process.env.APP_URL || '',
  /** Encrypts integration secrets at rest in the database. */
  secretKey: crypto
    .createHash('sha256')
    .update(process.env.SECRET_KEY || resolveSessionSecret())
    .digest(),
  /**
   * Optional shared secret required to complete first-run setup.
   *
   * Setup is open by default, which is right for a laptop or an internal
   * network. On a public URL that is a land grab: whoever loads the page first
   * claims the administrator account. Setting this means only someone holding
   * the token can claim it.
   */
  setupToken: process.env.SETUP_TOKEN || '',
  /**
   * Where attachment bytes live. `disk` keeps them beside the app; `database`
   * stores them in Postgres, which is what a serverless deployment needs.
   * Defaults to whichever the platform can actually support.
   */
  attachmentStore: (process.env.ATTACHMENT_STORE ||
    (IS_SERVERLESS ? 'database' : 'disk')) as 'disk' | 'database',
  /** Shared secret that lets a scheduler invoke the SLA sweep over HTTP. */
  cronSecret: process.env.CRON_SECRET || '',
  bootstrapAdmin: {
    email: process.env.BOOTSTRAP_ADMIN_EMAIL || '',
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD || '',
    name: process.env.BOOTSTRAP_ADMIN_NAME || 'Administrator',
  },
};
