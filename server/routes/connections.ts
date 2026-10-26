import { Router, type Request } from 'express';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { asyncRoute, forbidden, notFound } from '../lib/http.ts';
import { requireAuth, type AuthedRequest } from '../middleware/auth.ts';
import {
  callThrough,
  canManageConnection,
  canUseConnection,
  deleteConnection,
  findConnection,
  listConnections,
  saveConnection,
  toPublic,
} from '../ops/connections.ts';
import { CONNECTION_KINDS, type ConnectionKind, type ConnectionRequest } from '../../shared/connections.ts';

/**
 * A department's connections. Its members see them; its managers (and
 * integration administrators) change them. Other departments never see them.
 */
export const connectionsRouter: Router = Router();
connectionsRouter.use(requireAuth);

const userOf = (req: Request) => (req as AuthedRequest).user;

async function audit(req: Request, id: string, action: string, summary: string) {
  const user = userOf(req);
  await recordAudit({ actorId: user.id, actorName: user.name, entityType: 'integration', entityId: id, action, summary, ip: clientIp(req) });
}

async function usable(req: Request) {
  const connection = await findConnection(req.params.id);
  if (!connection || !canUseConnection(userOf(req), connection)) throw notFound('That connection does not exist.');
  return connection;
}

connectionsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const kind = CONNECTION_KINDS.includes(req.query.kind as ConnectionKind) ? (req.query.kind as ConnectionKind) : undefined;
    const teamId = typeof req.query.teamId === 'string' && req.query.teamId ? req.query.teamId : undefined;
    const connections = await listConnections(user, { kind, teamId });
    res.json({ connections: connections.map((connection) => toPublic(connection, user)), canAddShared: canManageConnection(user, null) });
  }),
);

connectionsRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const connection = await saveConnection(null, req.body ?? {}, userOf(req));
    await audit(req, connection.id, 'connection_created', `Added ${connection.kind} connection "${connection.name}"${connection.teamName ? ` for ${connection.teamName}` : ''}`);
    res.status(201).json({ connection: toPublic(connection, userOf(req)) });
  }),
);

connectionsRouter.put(
  '/:id',
  asyncRoute(async (req, res) => {
    await usable(req);
    const connection = await saveConnection(req.params.id, req.body ?? {}, userOf(req));
    await audit(req, connection.id, 'connection_updated', `Updated connection "${connection.name}"`);
    res.json({ connection: toPublic(connection, userOf(req)) });
  }),
);

connectionsRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const connection = await usable(req);
    if (!canManageConnection(userOf(req), connection.teamId)) throw forbidden('You cannot remove this connection.');
    await deleteConnection(connection.id);
    await audit(req, connection.id, 'connection_deleted', `Removed connection "${connection.name}"`);
    res.status(204).end();
  }),
);

/** Makes a call through an API connection and shows what came back, for building monitors and sources. */
connectionsRouter.post(
  '/:id/try',
  asyncRoute(async (req, res) => {
    const connection = await usable(req);
    const body = (req.body ?? {}) as ConnectionRequest;
    res.json({ result: await callThrough(connection, body) });
  }),
);

/** Mailboxes: check the credentials can read the mailbox. */
connectionsRouter.post(
  '/:id/test',
  asyncRoute(async (req, res) => {
    const connection = await usable(req);
    if (connection.kind !== 'mailbox') return res.json({ ok: true, message: 'Nothing to test: it is used when there is something to send.' });
    const { testMailbox } = await import('../integrations/mailbox.ts');
    res.json(await testMailbox(connection));
  }),
);

/** Mailboxes: read new mail now rather than at the next minute. */
connectionsRouter.post(
  '/:id/check-mail',
  asyncRoute(async (req, res) => {
    const connection = await usable(req);
    if (connection.kind !== 'mailbox') throw notFound('That is not a mailbox.');
    if (!canManageConnection(userOf(req), connection.teamId)) throw forbidden('Only whoever manages this mailbox can check it by hand.');
    const { pollMailbox } = await import('../integrations/mailbox.ts');
    const { noteConnectionUse } = await import('../ops/connections.ts');
    const result = await pollMailbox(connection);
    await noteConnectionUse(connection.id, result.error);
    res.json(result);
  }),
);
