import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const ROOT = process.cwd();

function dirOf(envVar: string, fallback: string) {
  const dir = path.resolve(ROOT, process.env[envVar] || fallback);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

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

export const dbConfig = {
  driver: resolveDriver(),
  connectionString: process.env.DATABASE_URL || '',
  sqlitePath: path.join(paths.data, process.env.SQLITE_FILE || 'escalation-pro.db'),
  /** Managed Postgres (Render, Heroku, Supabase) terminates TLS with its own CA. */
  ssl:
    (process.env.PGSSLMODE || '').toLowerCase() === 'require' ||
    /[?&]sslmode=require/.test(process.env.DATABASE_URL || ''),
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
  bootstrapAdmin: {
    email: process.env.BOOTSTRAP_ADMIN_EMAIL || '',
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD || '',
    name: process.env.BOOTSTRAP_ADMIN_NAME || 'Administrator',
  },
};
