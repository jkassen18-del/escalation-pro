import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServerlessApp } from '../server/index.ts';

/**
 * Serverless entry point.
 *
 * The Express app is built once per instance and reused. Any failure building
 * it is answered as JSON rather than being allowed to escape, because an
 * uncaught rejection here surfaces as an opaque platform error with nothing
 * to diagnose from.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const app = await getServerlessApp();
    return app(req as never, res as never);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[serverless] failed to start the application', error);
    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
    }
    res.end(JSON.stringify({ status: 'degraded', error: message }));
  }
}
