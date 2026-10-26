import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import { MulterError } from 'multer';
import { config, dbConfig, IS_PRODUCTION, IS_SERVERLESS, SESSION_COOKIE_NAME, paths } from './config.ts';
import { db, initDatabase } from './db/index.ts';
import { bootstrapFromEnvironment } from './bootstrap.ts';
import { checkEncryptionKey } from './lib/key-check.ts';
import { asyncRoute, HttpError } from './lib/http.ts';
import { sessionStore } from './lib/session-store.ts';
import { attachUser } from './middleware/auth.ts';
import { authRouter } from './routes/auth.ts';
import { brandingRouter } from './routes/branding.ts';
import { usersRouter } from './routes/users.ts';
import { invitePublicRouter, invitesRouter } from './routes/invites.ts';
import { rolesRouter } from './routes/roles.ts';
import { teamsRouter } from './routes/teams.ts';
import { ticketsRouter } from './routes/tickets.ts';
import { ticketTemplatesRouter } from './routes/ticket-templates.ts';
import { attachmentsRouter } from './routes/attachments.ts';
import { notificationsRouter } from './routes/notifications.ts';
import { settingsRouter } from './routes/settings.ts';
import { integrationsRouter } from './routes/integrations.ts';
import { dataSourcesRouter } from './routes/data-sources.ts';
import { reportsRouter } from './routes/reports.ts';
import { auditRouter } from './routes/audit.ts';
import { samlRouter, ssoAdminRouter } from './routes/sso.ts';
import { teamLinksRouter } from './routes/team-links.ts';
import { labelsRouter } from './routes/labels.ts';
import { shiftsRouter } from './routes/shifts.ts';
import { approvalsRouter } from './routes/approvals.ts';
import { connectionsRouter } from './routes/connections.ts';
import { webhooksRouter } from './routes/webhooks.ts';
import { cronRouter } from './routes/cron.ts';
import { opsRouter } from './routes/ops.ts';
import { opsPublicRouter } from './routes/ops-public.ts';
import { opsHealth, startOpsRunner } from './ops/runner.ts';
import { discordRouter } from './routes/discord.ts';
import { connectorRouter, mcpPublicRouter } from './routes/mcp.ts';
import { startDiscordGateway } from './integrations/discord-gateway.ts';
import { handleDiscordEvent } from './integrations/discord-handlers.ts';
import { startSlaMonitor } from './jobs/sla-monitor.ts';
import { APP_VERSION } from '../shared/version.ts';
import { pruneAttempts } from './lib/rate-limit.ts';

/** Routes whose JSON bodies may carry pasted screenshots. */
const SCREENSHOT_ROUTES = ['/api/tickets', '/api/ticket-templates'];
const carriesScreenshots = (url: string) => SCREENSHOT_ROUTES.some((route) => url === route || url.startsWith(`${route}/`) || url.startsWith(`${route}?`));

export async function createApp() {
  const app = express();

  // Required for correct req.ip and secure cookies behind a reverse proxy.
  // The portable exe trusts only a proxy on the same machine ('loopback'): it
  // listens on 127.0.0.1, so the only proxy that can reach it is a local one -
  // a Cloudflare Tunnel connector - and a browser connecting directly sends no
  // forwarded headers to be fooled by. Trusting nothing there meant the
  // tunnel's HTTPS went unseen and the secure sign-in cookie was never set.
  const trustProxy = process.env.TRUST_PROXY ?? (process.env.INFRATICKET_PORTABLE ? 'loopback' : '1');
  app.set(
    'trust proxy',
    /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true' ? true : trustProxy === 'false' ? false : trustProxy,
  );
  app.disable('x-powered-by');

  app.use(
    express.json({
      limit: '2mb',
      // Ticket bodies carry pasted screenshots and are parsed further down,
      // with a larger limit, once the request is known to be signed in.
      type: (req) => /^application\/json\b/i.test(String(req.headers['content-type'] ?? '')) && !carriesScreenshots(req.url ?? ''),
      // Keep the raw bytes so webhook HMAC signatures can be verified.
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(
    express.urlencoded({
      extended: true,
      limit: '2mb',
      // Slack posts button clicks form-encoded, and signs the raw bytes.
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
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
        req.path.startsWith('/api') ||
        req.path.startsWith('/status/') ||
        req.path === '/mcp' ||
        req.path.startsWith('/oauth/') ||
        req.path.startsWith('/.well-known/oauth-') ||
        req.headers.cookie?.includes(`${SESSION_COOKIE_NAME}=`);
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
        // 'auto': Secure whenever the request arrived over HTTPS (directly or via
        // a trusted proxy), and still usable at http://localhost on the machine
        // itself. A plain `true` silently dropped the cookie on any request it
        // could not see as HTTPS, so signing in "worked" and then did not.
        secure: config.cookieSecure ? 'auto' : false,
        maxAge: config.sessionMaxAgeMs,
      },
    }),
  );

  app.get('/health', async (_req, res) => {
    try {
      await ensureDatabaseReady();
      await db.get('SELECT 1 AS ok');
      // When the background loops last ran: a stale lastPagerTickAt means
      // escalations have stopped, which no other check here would show.
      const ops = await opsHealth().catch(() => null);
      res.json({ status: 'ok', database: db.dialect, uptime: Math.round(process.uptime()), ops });
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

  // SAML first: the identity provider posts here, before any session exists.
  app.use('/api/auth/saml', samlRouter);
  app.use('/api/auth', authRouter);
  // Invite links are opened before anyone is signed in.
  app.use('/api/invite', invitePublicRouter);
  // Before attachUser: the sign-in screen needs the company name and logo.
  app.use('/api/branding', brandingRouter);
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api/cron', cronRouter);
  // Alert intake, heartbeats, telephony callbacks and status pages: each
  // authenticates itself, and status pages must render for the public.
  app.use(opsPublicRouter);
  // The MCP endpoint and its OAuth: bearer tokens, never the session cookie.
  app.use(mcpPublicRouter);

  // Everything below needs a resolved session user.
  app.use('/api', attachUser);
  // Screenshots pasted into a description or comment arrive as base64 in the
  // JSON body. 2MB cut a full-screen capture off; this is sized for the
  // inline-image caps (5MB each, 20MB per submission), and only parsed for
  // someone signed in - anyone else gets the route's 401 without it.
  const screenshotJson = express.json({ limit: '30mb' });
  app.use(SCREENSHOT_ROUTES, (req, res, next) => ((req as Request & { user?: unknown }).user ? screenshotJson(req, res, next) : next()));
  app.use('/api/users', usersRouter);
  app.use('/api/roles', rolesRouter);
  app.use('/api/invites', invitesRouter);
  app.use('/api/teams', teamsRouter);
  app.use('/api/tickets/:id/attachments', attachmentsRouter);
  app.use('/api/tickets', ticketsRouter);
  app.use('/api/ticket-templates', ticketTemplatesRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/integrations', integrationsRouter);
  app.use('/api/data-sources', dataSourcesRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/sso', ssoAdminRouter);
  app.use('/api/team-links', teamLinksRouter);
  app.use('/api/labels', labelsRouter);
  app.use('/api/shifts', shiftsRouter);
  app.use('/api/approvals', approvalsRouter);
  app.use('/api/connections', connectionsRouter);
  app.use('/api/ops', opsRouter);
  app.use('/api/discord', discordRouter);
  app.use('/api/connector', connectorRouter);

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
    // Hashed bundles never change, so they cache for good. index.html names the
    // current bundles and must be revalidated every load, or a browser that
    // remembers an older one asks for files an upgrade has removed.
    app.use('/assets', express.static(path.join(paths.clientDist, 'assets'), { index: false, immutable: true, maxAge: '1y', fallthrough: false }));
    app.use(express.static(paths.clientDist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(paths.clientDist, 'index.html'));
    });
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
      await checkEncryptionKey();
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

export async function startServer() {
  await initDatabase();
  await checkEncryptionKey();
  await bootstrapFromEnvironment();

  const app = await createApp();
  const server = app.listen(config.port, config.host);
  // Resolve once listening, so a caller (the portable launcher) can report a
  // port that is already taken instead of the process dying unexplained.
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  console.log('');
  console.log(`  InfraTicket ${APP_VERSION}`);
  console.log(`  → http://localhost:${config.port}`);
  console.log(`  → database: ${db.dialect}`);
  console.log(`  → mode: ${IS_PRODUCTION ? 'production' : 'development'}`);
  console.log('');

  const stopSla = startSlaMonitor();
  const stopOps = startOpsRunner();
  // Discord connects out to its Gateway; nothing listens for it.
  const stopDiscord = startDiscordGateway(handleDiscordEvent);

  // Failed-login rows are only needed for the length of the limiter window.
  const pruneTimer = setInterval(
    () => void pruneAttempts().catch((error) => console.error('[rate-limit] prune failed', error)),
    60 * 60 * 1000,
  );
  pruneTimer.unref();

  const shutdown = (signal: string) => {
    console.log(`\n[server] ${signal} received, shutting down.`);
    stopSla();
    stopOps();
    stopDiscord();
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

/**
 * Start a server only when this file is what was run.
 *
 * Importing it must not have side effects: tests and tooling import
 * `createApp` and `getServerlessApp` from here, and booting a listener behind
 * their backs binds a port they never asked for and keeps the process alive
 * after their work is done.
 */
function isEntryModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (!IS_SERVERLESS && isEntryModule()) {
  startServer().catch((error) => {
    console.error('\n[fatal] InfraTicket failed to start:\n');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
