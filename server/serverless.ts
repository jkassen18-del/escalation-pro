import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Serverless entry point, bundled to `api/index.js` during the build.
 *
 * It has to be bundled: platforms compile only the function file itself and
 * leave the rest of the TypeScript sources alone, so a relative import of
 * another .ts file cannot be resolved at runtime.
 *
 * The server module is imported lazily inside the handler rather than at the
 * top of this file. A module-level import that throws makes the whole function
 * unloadable, and the platform reports that as an opaque invocation failure
 * with nothing to diagnose from. Importing here means any startup fault -- a
 * bad dependency, missing configuration, an unreachable database -- comes back
 * as JSON naming the cause.
 */
let appPromise: Promise<(req: IncomingMessage, res: ServerResponse) => void> | null = null;

async function loadApp() {
  const { getServerlessApp } = await import('./index.ts');
  const app = await getServerlessApp();
  return app as unknown as (req: IncomingMessage, res: ServerResponse) => void;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    if (!appPromise) {
      // A failed start is not cached, so a transient fault does not leave this
      // instance permanently broken.
      appPromise = loadApp().catch((error) => {
        appPromise = null;
        throw error;
      });
    }
    const app = await appPromise;
    return app(req, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : 'Error';
    console.error('[serverless] failed to start the application', error);

    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
    }
    res.end(JSON.stringify({ status: 'degraded', error: `${name}: ${message}` }));
  }
}
