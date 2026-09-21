import { Router } from 'express';
import { asyncRoute, notFound } from '../lib/http.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { can, requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
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
 * Lists the connections.
 *
 * Everyone signed in needs to know which lookups exist, because a form field
 * names one. Almost nothing else here is theirs to see: the host, port,
 * database name, database user, the SQL, and the text of a failed connection
 * are a map of internal infrastructure, and a reader with no administrative
 * rights has no reason to hold it. So they get the id and the name, and the
 * full record is reserved for whoever manages integrations.
 */
dataSourcesRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const sources = await listDataSources();
    if (can(user, 'integrations.manage')) {
      res.json({ dataSources: sources });
      return;
    }
    res.json({ dataSources: sources.map(({ id, name }) => ({ id, name })) });
  }),
);

/**
 * Runs a source's lookup query for a typed search term.
 *
 * Gated on tickets.create, which is the only reason the endpoint exists: the
 * person is filling in a field an administrator put on an intake form. A
 * read-only account has no ticket to raise, and this would otherwise hand it
 * a search box over the company's customer database.
 *
 * They still choose only the term, never the query, and the term is bound as
 * a parameter.
 */
dataSourcesRouter.get(
  '/:id/lookup',
  requirePermission('tickets.create'),
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
