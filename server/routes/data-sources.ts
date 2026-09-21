import { Router } from 'express';
import { asyncRoute, notFound } from '../lib/http.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
import {
  findDataSource,
  listDataSources,
  removeDataSource,
  runLookup,
  saveDataSource,
  testDataSource,
  validateInput,
} from '../lib/data-sources.ts';

export const dataSourcesRouter: Router = Router();

dataSourcesRouter.use(requireAuth);

/**
 * Readable by anyone who can raise a ticket, because the new-ticket form needs
 * to know which lookups exist. The response never includes a credential.
 */
dataSourcesRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    res.json({ dataSources: await listDataSources() });
  }),
);

/**
 * Runs a source's lookup query for a typed search term.
 *
 * Open to any signed-in user: they are filling in a form that an administrator
 * chose to put this field on. They cannot choose the query, only the term,
 * and the term is bound as a parameter.
 */
dataSourcesRouter.get(
  '/:id/lookup',
  asyncRoute(async (req, res) => {
    const source = await findDataSource(req.params.id);
    if (!source) throw notFound('That data source does not exist.');
    const rows = await runLookup(source, String(req.query.q ?? ''));
    res.json({ rows });
  }),
);

dataSourcesRouter.post(
  '/',
  requirePermission('integrations.manage'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const source = await saveDataSource(null, validateInput(req.body));
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'integration',
      entityId: source.id,
      action: 'data_source_created',
      summary: `${actor.name} connected the database "${source.name}"`,
      // Host and database only - never the credential.
      meta: { engine: source.engine, host: source.host, database: source.database },
      ip: clientIp(req),
    });
    res.status(201).json({ dataSource: source });
  }),
);

dataSourcesRouter.patch(
  '/:id',
  requirePermission('integrations.manage'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const existing = await findDataSource(req.params.id);
    if (!existing) throw notFound('That data source does not exist.');

    const source = await saveDataSource(existing.id, validateInput({ ...existing, ...req.body }));
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'integration',
      entityId: source.id,
      action: 'data_source_updated',
      summary: `${actor.name} updated the database connection "${source.name}"`,
      ip: clientIp(req),
    });
    res.json({ dataSource: source });
  }),
);

dataSourcesRouter.post(
  '/:id/test',
  requirePermission('integrations.manage'),
  asyncRoute(async (req, res) => {
    const source = await findDataSource(req.params.id);
    if (!source) throw notFound('That data source does not exist.');
    const result = await testDataSource(source);
    res.json({ ...result, dataSource: await findDataSource(source.id) });
  }),
);

dataSourcesRouter.delete(
  '/:id',
  requirePermission('integrations.manage'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const source = await findDataSource(req.params.id);
    if (!source) throw notFound('That data source does not exist.');

    await removeDataSource(source.id);
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'integration',
      entityId: source.id,
      action: 'data_source_removed',
      summary: `${actor.name} removed the database connection "${source.name}"`,
      ip: clientIp(req),
    });
    res.json({ ok: true });
  }),
);
