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
import { ALERT_SEVERITIES, ALERT_SOURCE_KINDS, PROBE_AUTH_KINDS } from '../../shared/types.ts';
import {
  createProbe,
  deleteProbe,
  findProbe,
  listProbes,
  probeSource,
  runProbe,
  updateProbe,
} from '../infragrid/probes.ts';
import { randomId } from '../lib/crypto.ts';

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

/* --------------------------- API health probes ---------------------------- */

infragridRouter.get(
  '/probes',
  asyncRoute(async (_req, res) => {
    res.json({ probes: await listProbes() });
  }),
);

infragridRouter.post(
  '/probes',
  requirePermission('integrations.manage'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const probe = await createProbe({
      name: requireString(req.body?.name, 'Name', { max: 120 }),
      url: requireString(req.body?.url, 'URL', { max: 2000 }),
      method: optionalString(req.body?.method, 10) ?? 'GET',
      authKind: requireEnum(req.body?.authKind ?? 'none', PROBE_AUTH_KINDS, 'Authentication'),
      authName: optionalString(req.body?.authName, 120),
      authSecret: optionalString(req.body?.authSecret, 4000),
      expectStatus: optionalString(req.body?.expectStatus, 10) ?? '2xx',
      expectBody: optionalString(req.body?.expectBody, 200),
      intervalSeconds: parseIntOr(req.body?.intervalSeconds, 300),
      timeoutMs: parseIntOr(req.body?.timeoutMs, 10_000),
      failureThreshold: parseIntOr(req.body?.failureThreshold, 2),
      severity: requireEnum(req.body?.severity ?? 'critical', ALERT_SEVERITIES, 'Severity'),
      teamId: optionalString(req.body?.teamId, 60),
    });

    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'system',
      entityId: probe.id,
      action: 'probe_created',
      summary: `Added the health check "${probe.name}"`,
      ip: clientIp(req),
    });

    res.status(201).json({ probe });
  }),
);

infragridRouter.patch(
  '/probes/:id',
  requirePermission('integrations.manage'),
  asyncRoute(async (req, res) => {
    const probe = await updateProbe(req.params.id, {
      name: optionalString(req.body?.name, 120) ?? undefined,
      url: optionalString(req.body?.url, 2000) ?? undefined,
      authKind: req.body?.authKind ? requireEnum(req.body.authKind, PROBE_AUTH_KINDS, 'Authentication') : undefined,
      authName: req.body?.authName === undefined ? undefined : optionalString(req.body.authName, 120),
      authSecret: optionalString(req.body?.authSecret, 4000),
      expectStatus: optionalString(req.body?.expectStatus, 10) ?? undefined,
      expectBody: req.body?.expectBody === undefined ? undefined : optionalString(req.body.expectBody, 200),
      intervalSeconds: req.body?.intervalSeconds === undefined ? undefined : parseIntOr(req.body.intervalSeconds, 300),
      failureThreshold:
        req.body?.failureThreshold === undefined ? undefined : parseIntOr(req.body.failureThreshold, 2),
      teamId: req.body?.teamId === undefined ? undefined : optionalString(req.body.teamId, 60),
      enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
    });
    if (!probe) throw notFound('No such health check.');
    res.json({ probe });
  }),
);

infragridRouter.delete(
  '/probes/:id',
  requirePermission('integrations.manage'),
  asyncRoute(async (req, res) => {
    if (!(await deleteProbe(req.params.id))) throw notFound('No such health check.');
    res.json({ ok: true });
  }),
);

/**
 * Runs one probe now and reports what came back.
 *
 * Without this, setting up a check is guesswork until the next sweep - and a
 * typo in a URL or a wrong credential is invisible for five minutes. This
 * deliberately does not raise or clear alerts: it answers "does this work",
 * not "is the service down".
 */
infragridRouter.post(
  '/probes/:id/run',
  requirePermission('integrations.manage'),
  asyncRoute(async (req, res) => {
    const probe = await findProbe(req.params.id);
    if (!probe) throw notFound('No such health check.');
    res.json({ result: await runProbe(probe) });
  }),
);

/**
 * Pushes a synthetic alert through the real pipeline.
 *
 * The point is to see it arrive. Every integration has a connection test of
 * its own, but those prove the credential works, not that an alert actually
 * reaches a person - which depends on the routing, the events each
 * integration subscribes to, and the ticket being created at all. This runs
 * the whole path, so whatever lands in email, Slack, Teams and Linear is
 * exactly what a real alert would produce.
 */
infragridRouter.post(
  '/test-alert',
  requirePermission('integrations.manage'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const severity = requireEnum(req.body?.severity ?? 'critical', ALERT_SEVERITIES, 'Severity');
    const teamId = optionalString(req.body?.teamId, 60);

    const source = await probeSource();
    const outcome = await ingestAlert(
      { ...source, teamId: teamId ?? source.teamId, ticketThreshold: 'info' },
      {
        // Unique per test, so it is never folded into a previous one and is
        // obviously disposable afterwards.
        dedupeKey: `test:${randomId()}`,
        title: `Test alert from ${actor.name}`,
        body:
          'This is a test raised from InfraGrid. It went through the same path a real alert does, ' +
          'so wherever this arrived is where a genuine alert would arrive. Close the ticket when you are done.',
        severity,
        status: 'firing',
        resource: 'infragrid-test',
      },
    );

    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'system',
      action: 'test_alert_sent',
      summary: `Sent a ${severity} test alert`,
      ip: clientIp(req),
    });

    res.status(201).json({ ...outcome, severity });
  }),
);
