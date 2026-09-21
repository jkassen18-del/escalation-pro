import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Serverless function entry.
 *
 * Deliberately tiny and dependency-free. The platform compiles this file but
 * leaves the rest of the TypeScript sources alone, so importing another .ts
 * module here would fail to resolve at runtime. Instead the whole server is
 * bundled to dist/function/index.mjs during the build (see `build:function`)
 * and shipped alongside via `includeFiles` in vercel.json.
 *
 * The import is inside the handler so a startup fault is catchable and can be
 * reported, rather than making the module unloadable.
 */
type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

const BUNDLE = '../dist/function/index.mjs';

let bundled: Promise<Handler> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    if (!bundled) {
      // The specifier is a variable so type-checking does not depend on a
      // build artifact existing. Node still resolves it relative to this
      // module at runtime, and includeFiles guarantees it ships.
      bundled = (import(BUNDLE) as Promise<{ default: Handler }>)
        .then((mod) => mod.default)
        .catch((error) => {
          bundled = null;
          throw error;
        });
    }
    return (await bundled)(req, res);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error('[serverless] failed to load the application bundle', error);
    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
    }
    res.end(JSON.stringify({ status: 'degraded', error: message }));
  }
}
