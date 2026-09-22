import { Router } from 'express';
import { config } from '../config.ts';
import { timingSafeCompare } from '../lib/crypto.ts';
import { asyncRoute } from '../lib/http.ts';
import { checkBreaches } from '../jobs/sla-monitor.ts';
import { sweepHeartbeats } from '../infragrid/sweep.ts';
import { sweepProbes } from '../infragrid/probes.ts';
import { pruneAttempts } from '../lib/rate-limit.ts';

export const cronRouter: Router = Router();

/**
 * Scheduled maintenance for deployments with no long-running process.
 *
 * Authorised either by the platform's own cron header (Vercel signs these with
 * CRON_SECRET) or by the same secret as a bearer token, so it can be triggered
 * manually while testing.
 */
function authorised(header: string | undefined): boolean {
  if (!config.cronSecret) return false;
  const supplied = (header ?? '').replace(/^Bearer\s+/i, '');
  return timingSafeCompare(supplied, config.cronSecret);
}

cronRouter.all(
  '/sla',
  asyncRoute(async (req, res) => {
    if (!authorised(req.header('authorization'))) {
      return res.status(401).json({ error: 'Unauthorised' });
    }

    const notified = await checkBreaches();
    const heartbeats = await sweepHeartbeats();
    const probes = await sweepProbes();
    await pruneAttempts();
    res.json({
      ok: true,
      breachesNotified: notified,
      heartbeats,
      probes,
      ranAt: new Date().toISOString(),
    });
  }),
);
