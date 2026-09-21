import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServerlessApp } from '../server/index.ts';

/**
 * Serverless entry point.
 *
 * The Express app is built once per instance and reused, so the database
 * connection and schema check only happen on a cold start.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getServerlessApp();
  return app(req as never, res as never);
}
