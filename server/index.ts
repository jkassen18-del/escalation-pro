import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import { MulterError } from 'multer';
import { config, dbConfig, IS_PRODUCTION, IS_SERVERLESS, SESSION_COOKIE_NAME, paths } from './config.ts';
import { db, initDatabase } from './db/index.ts';
import { bootstrapFromEnvironment } from './bootstrap.ts';
import { asyncRoute, HttpError } from './lib/http.ts';
import { sessionStore } from './lib/session-store.ts';
import { attachUser } from './middleware/auth.ts';
import { authRouter } from './routes/auth.ts';
import { usersRouter } from './routes/users.ts';
import { teamsRouter } from './routes/teams.ts';
import { ticketsRouter } from './routes/tickets.ts';
import { attachmentsRouter } from './routes/attachments.ts';
import { notificationsRouter } from './routes/notifications.ts';
import { settingsRouter } from './routes/settings.ts';
import { integrationsRouter } from './routes/integrations.ts';
import { reportsRouter } from './routes/reports.ts';
import { auditRouter } from './routes/audit.ts';
import { webhooksRouter } from './routes/webhooks.ts';
import { cronRouter } from './routes/cron.ts';
import { startSlaMonitor } from './jobs/sla-monitor.ts';
import { pruneAttempts } from './lib/rate-limit.ts';

export async function createApp() {
  const app = express();

  // Required for correct req.ip and secure cookies behind a reverse proxy.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    express.json({
      limit: '2mb',
      // Keep the raw bytes so webhook HMAC signatures can be verified.
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser());

  /**
   * express-session reads its store on every request that carries a session
   * cookie, and that store is the database - so the connection has to be open
   * before the session middleware runs, not after it.
   *
   * Mounting the readiness check only on /api was not enough: on a cold
   * serverless instance a returning visitor's very first request went through
   * express-session first, db.get() threw "Database has not been initialised",
   * and the generic handler answered an opaque 500. Sign-in failed on the
   * first attempt and worked on the retry, which is exactly what it looked
   * like from the browser.
   *
   * Static assets are deliberately left ungated so a database outage degrades
   * the app rather than blanking it, and /health stays reachable so it can
   * still report the cause.
   */
  app.use(
    asyncRoute(async (req, _res, next) => {
      const needsDatabase =
        req.path.startsWith('/api') || req.headers.cookie?.includes(`${SESSION_COOKIE_NAME}=`);
      if (req.path === '/health' || !needsDatabase) return next();

      try {
        await ensureDatabaseReady();
      } catch (error) {
        throw new HttpError(
          503,
          `The database is unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
      next();
    }),
  );

  sessionStore.startSweeper();
  app.use(
    session({
      name: SESSION_COOKIE_NAME,
      secret: config.sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure,
        maxAge: config.sessionMaxAgeMs,
      },
    }),
  );

  app.get('/health', async (_req, res) => {
    try {
      await ensureDatabaseReady();
      await db.get('SELECT 1 AS ok');
      res.json({ status: 'ok', database: db.dialect, uptime: Math.round(process.uptime()) });
    } catch (error) {
      // Deliberately still a JSON body: an unreachable database is the most
      // common deployment fault, and this is where its reason gets reported.
      res.status(503).json({
        status: 'degraded',
        database: dbConfig.driver,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  });

  app.use('/api/auth', authRouter);
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api/cron', cronRouter);

  // Everything below needs a resolved session user.
  app.use('/api', attachUser);
  app.use('/api/users', usersRouter);
  app.use('/api/teams', teamsRouter);
  app.use('/api/tickets/:id/attachments', attachmentsRouter);
  app.use('/api/tickets', ticketsRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/integrations', integrationsRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/audit', auditRouter);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));

  if (IS_SERVERLESS) {
    // The platform serves dist/client directly; this function only answers /api.
    app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  } else if (IS_PRODUCTION) {
    if (!fs.existsSync(paths.clientDist)) {
      throw new Error(
        `Client bundle not found at ${paths.clientDist}. Run "npm run build" before starting in production.`,
      );
    }
    app.use(express.static(paths.clientDist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(paths.clientDist, 'index.html')));
  } else {
    // Vite in middleware mode gives HMR without a second port or a proxy.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  }

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: error.message, details: error.details });
    }
    // body-parser raises a SyntaxError with a `body` property on unparseable JSON.
    if (error instanceof SyntaxError && 'body' in error) {
      return res.status(400).json({ error: 'The request body is not valid JSON.' });
    }
    if (error instanceof MulterError) {
      const message =
        error.code === 'LIMIT_FILE_SIZE'
          ? `Files must be ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB or smaller.`
          : error.message;
      return res.status(400).json({ error: message });
    }
    if (error.message?.includes('are not allowed')) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[error]', error);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return app;
}

/**
 * Connects to the database on first use and reuses that connection for the
 * life of the instance.
 *
 * A failed attempt is not cached: caching a rejected promise would leave the
 * instance permanently broken after one transient blip, and every later
 * request would report a stale error.
 */
let databaseReady: Promise<void> | null = null;

export function ensureDatabaseReady(): Promise<void> {
  if (!databaseReady) {
    databaseReady = (async () => {
      await initDatabase();
      await bootstrapFromEnvironment();
    })().catch((error) => {
      databaseReady = null;
      throw error;
    });
  }
  return databaseReady;
}

/**
 * Builds the app once per serverless instance.
 *
 * Deliberately does NOT open the database first. If it did, an unreachable
 * database would reject here and the platform would return an opaque
 * invocation failure - with no way for /health to say what went wrong.
 */
let serverlessApp: Promise<express.Express> | null = null;

export function getServerlessApp(): Promise<express.Express> {
  if (!serverlessApp) {
    serverlessApp = createApp().catch((error) => {
      serverlessApp = null;
      throw error;
    });
  }
  return serverlessApp;
}

async function main() {
  await initDatabase();
  await bootstrapFromEnvironment();

  const app = await createApp();
  const server = app.listen(config.port, config.host, () => {
    console.log('');
    console.log(`  Escalation Pro`);
    console.log(`  → http://localhost:${config.port}`);
    console.log(`  → database: ${db.dialect}`);
    console.log(`  → mode: ${IS_PRODUCTION ? 'production' : 'development'}`);
    console.log('');
  });

  const stopSla = startSlaMonitor();

  // Failed-login rows are only needed for the length of the limiter window.
  const pruneTimer = setInterval(
    () => void pruneAttempts().catch((error) => console.error('[rate-limit] prune failed', error)),
    60 * 60 * 1000,
  );
  pruneTimer.unref();

  const shutdown = (signal: string) => {
    console.log(`\n[server] ${signal} received, shutting down.`);
    stopSla();
    clearInterval(pruneTimer);
    sessionStore.stopSweeper();
    server.close(() => {
      void db.close().then(() => process.exit(0));
    });
    // Do not hang forever if a connection refuses to drain.
    setTimeout(() => process.exit(1), 8000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (!IS_SERVERLESS) {
  main().catch((error) => {
    console.error('\n[fatal] Escalation Pro failed to start:\n');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
