import { Router } from 'express';
import { asyncRoute, badRequest, notFound, optionalString, parseIntOr, requireEnum, requireString } from '../lib/http.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
import { getSettings } from '../repositories/settings.ts';
import { parseAlert } from '../infragrid/adapters.ts';
import { ingestAlert } from '../infragrid/pipeline.ts';
import { acceptBeat } from '../infragrid/sweep.ts';
import {
  authenticateSource,
  createHeartbeat,
  createSource,
  deleteHeartbeat,
  deleteSource,
  findHeartbeatBySlug,
  listAlerts,
  listHeartbeats,
  listSources,
  updateSource,
} from '../infragrid/store.ts';
import { db } from '../db/index.ts';
import { ALERT_SEVERITIES, ALERT_SOURCE_KINDS } from '../../shared/types.ts';

/**
 * InfraGrid.
 *
 * Two audiences with opposite needs, so two routers. The ingest endpoints are
 * reached by other people's software and authenticate with a per-source
 * token; the management endpoints are reached by an administrator in a
 * browser and authenticate with a session.
 */

/* ------------------------------- Ingest ----------------------------------- */

export const ingestRouter: Router = Router();

/**
 * Where monitoring systems post.
 *
 * The credential may arrive in the path as well as in a header, which is not
 * the nicer option but is the only one many of these tools support: a
 * CloudWatch SNS subscription or a DigitalOcean alert policy takes a URL and
 * nothing else. A token in a URL lands in access logs, so it is scoped to one
 * source, revocable on its own, and can do nothing but raise alerts for that
 * source.
 */
ingestRouter.post(
  '/:token',
  asyncRoute(async (req, res) => {
    const token =
      req.params.token ||
      /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '')?.[1] ||
      req.header('x-ingest-token') ||
      '';

    const auth = await authenticateSource(token);
    if (!auth.ok) {
      // Disabled is worth saying: somebody turned it off and the sender should
      // not keep retrying forever wondering why.
      const message =
        auth.reason === 'disabled' ? 'That alert source is disabled.' : 'That ingest token is not valid.';
      return res.status(401).json({ error: message });
    }

    const source = auth.source;
    const parsed = parseAlert(source.kind, req.body);

    /*
     * AWS will not deliver anything until the subscription is confirmed, and
     * the confirmation arrives at this same URL as a different message type.
     * Fetching it here saves somebody going to find the link in a payload.
     */
    if (parsed.kind === 'confirm') {
      try {
        await fetch(parsed.url, { method: 'GET' });
        await recordAudit({
          actorName: source.name,
          entityType: 'system',
          entityId: source.id,
          action: 'infragrid_subscription_confirmed',
          summary: `Confirmed an SNS subscription for "${source.name}"`,
        });
        return res.json({ ok: true, confirmed: true });
      } catch (error) {
        return res.status(502).json({ error: `Could not confirm the subscription: ${(error as Error).message}` });
      }
    }

    await db.run(`UPDATE alert_sources SET last_event_at = ? WHERE id = ?`, [
      new Date().toISOString(),
      source.id,
    ]);

    if (parsed.kind === 'ignored') return res.json({ ok: true, ignored: parsed.reason });

    const outcomes = [];
    for (const alert of parsed.alerts) {
      outcomes.push(await ingestAlert(source, alert));
    }

    res.status(202).json({ ok: true, alerts: outcomes });
  }),
);

/**
 * A heartbeat check-in.
 *
 * GET as well as POST, because the things that call this are `curl` in a cron
 * line and a scheduled task, and both are easier to write as a plain fetch.
 */
const beat = asyncRoute(async (req, res) => {
  const heartbeat = await findHeartbeatBySlug(req.params.slug);
  if (!heartbeat) return res.status(404).json({ error: 'No such heartbeat.' });
  if (!heartbeat.enabled) return res.json({ ok: true, ignored: 'disabled' });

  // Clears its own alert if it had been missing; see acceptBeat.
  await acceptBeat(heartbeat);
  res.json({ ok: true, name: heartbeat.name });
});

ingestRouter.post('/heartbeat/:slug', beat);
ingestRouter.get('/heartbeat/:slug', beat);

/* ----------------------------- Management --------------------------------- */

export const infragridRouter: Router = Router();

infragridRouter.use(requireAuth);

/** The grid itself: every source, what is firing, and the heartbeats. */
infragridRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    const settings = await getSettings();
    const [sources, alerts, heartbeats] = await Promise.all([
      listSources(),
      listAlerts({ limit: 100 }, settings.ticketPrefix),
      listHeartbeats(),
    ]);
    res.json({ sources, alerts, heartbeats });
  }),
);

infragridRouter.get(
  '/alerts',
  asyncRoute(async (req, res) => {
    const settings = await getSettings();
    const status = optionalString(req.query.status, 20);
    res.json({
      alerts: await listAlerts(
        {
          status: status === 'firing' || status === 'resolved' ? status : undefined,
          sourceId: optionalString(req.query.sourceId, 60) ?? undefined,
          limit: parseIntOr(req.query.limit, 100),
        },
        settings.ticketPrefix,
      ),
    });
  }),
);

infragridRouter.post(
  '/sources',
  requirePermission('integrations.manage'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const name = requireString(req.body?.name, 'Name', { max: 120 });
    const kind = requireEnum(req.body?.kind, ALERT_SOURCE_KINDS, 'Kind');
    const ticketThreshold = requireEnum(
      req.body?.ticketThreshold ?? 'warning',
      ALERT_SEVERITIES,
      'Ticket threshold',
    );

    const { source, token } = await createSource({
      name,
      kind,
      teamId: optionalString(req.body?.teamId, 60),
      ticketThreshold,
    });

    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'system',
      entityId: source.id,
      action: 'infragrid_source_created',
      summary: `Connected "${name}" (${kind}) to InfraGrid`,
      ip: clientIp(req),
    });

    // The token is shown once, like every other credential here.
    res.status(201).json({ source, token });
  }),
);

infragridRouter.patch(
  '/sources/:id',
  requirePermission('integrations.manage'),
  asyncRoute(async (req, res) => {
    const source = await updateSource(req.params.id, {
      name: optionalString(req.body?.name, 120) ?? undefined,
      teamId: req.body?.teamId === undefined ? undefined : optionalString(req.body.teamId, 60),
      ticketThreshold:
        req.body?.ticketThreshold === undefined
          ? undefined
          : requireEnum(req.body.ticketThreshold, ALERT_SEVERITIES, 'Ticket threshold'),
      enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
    });
    if (!source) throw notFound('No such alert source.');
    res.json({ source });
  }),
);

infragridRouter.delete(
  '/sources/:id',
  requirePermission('integrations.manage'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    if (!(await deleteSource(req.params.id))) throw notFound('No such alert source.');
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'system',
      entityId: req.params.id,
      action: 'infragrid_source_deleted',
      summary: `Removed an InfraGrid source`,
      ip: clientIp(req),
    });
    res.json({ ok: true });
  }),
);

infragridRouter.post(
  '/heartbeats',
  requirePermission('integrations.manage'),
  asyncRoute(async (req, res) => {
    const name = requireString(req.body?.name, 'Name', { max: 120 });
    const periodSeconds = parseIntOr(req.body?.periodSeconds, 3600);
    if (periodSeconds < 60) throw badRequest('A heartbeat cannot be expected more often than once a minute.');

    const heartbeat = await createHeartbeat({
      name,
      periodSeconds,
      graceSeconds: parseIntOr(req.body?.graceSeconds, Math.max(60, Math.round(periodSeconds * 0.1))),
      severity: requireEnum(req.body?.severity ?? 'warning', ALERT_SEVERITIES, 'Severity'),
      teamId: optionalString(req.body?.teamId, 60),
    });
    res.status(201).json({ heartbeat });
  }),
);

infragridRouter.delete(
  '/heartbeats/:id',
  requirePermission('integrations.manage'),
  asyncRoute(async (req, res) => {
    if (!(await deleteHeartbeat(req.params.id))) throw notFound('No such heartbeat.');
    res.json({ ok: true });
  }),
);
