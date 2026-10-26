import { Router, type Request } from 'express';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { asyncRoute, badRequest, forbidden, notFound } from '../lib/http.ts';
import { requireAuth, type AuthedRequest } from '../middleware/auth.ts';
import { getSettings } from '../repositories/settings.ts';
import { findTicket } from '../repositories/tickets.ts';
import { canSeeTicket } from '../services/ticket-actions.ts';
import { canManageFlow, canSeeFlow, deleteFlow, findFlow, listFlows, listRuns, saveFlow, startRun, validateFlow, type FlowRecord } from '../ops/flows.ts';
import type { PublicUser } from '../../shared/types.ts';

/**
 * Flows. A department's people see its flows; its managers (and anyone with
 * flows.manage) build them. Organisation-wide flows are for flows.manage.
 */
export const flowsRouter: Router = Router();
flowsRouter.use(requireAuth);

const userOf = (req: Request) => (req as AuthedRequest).user;
const toPublic = (flow: FlowRecord, user: PublicUser) => ({ ...flow, canEdit: canManageFlow(user, flow.teamId) });

async function audit(req: Request, id: string, action: string, summary: string) {
  const user = userOf(req);
  await recordAudit({ actorId: user.id, actorName: user.name, entityType: 'alert', entityId: id, action, summary, ip: clientIp(req) });
}

async function visible(req: Request) {
  const flow = await findFlow(req.params.id);
  if (!flow || !canSeeFlow(userOf(req), flow.teamId)) throw notFound('That flow does not exist.');
  return flow;
}

flowsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const teamId = typeof req.query.teamId === 'string' && req.query.teamId ? req.query.teamId : undefined;
    const flows = (await listFlows()).filter((flow) => canSeeFlow(user, flow.teamId) && (!teamId || flow.teamId === teamId || flow.teamId === null));
    res.json({ flows: flows.map((flow) => toPublic(flow, user)), canAddShared: canManageFlow(user, null) });
  }),
);

flowsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const flow = await visible(req);
    res.json({ flow: toPublic(flow, userOf(req)), runs: await listRuns(flow.id) });
  }),
);

flowsRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const input = validateFlow(req.body ?? {});
    if (!canManageFlow(user, input.teamId)) throw forbidden(input.teamId ? 'You cannot build flows for this department.' : 'Only flow administrators can build flows for every department.');
    const flow = await saveFlow(null, input, user);
    await audit(req, flow.id, 'flow_created', `Created flow "${flow.name}"`);
    res.status(201).json({ flow: toPublic(flow, user) });
  }),
);

flowsRouter.put(
  '/:id',
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const existing = await visible(req);
    const input = validateFlow(req.body ?? {});
    if (!canManageFlow(user, existing.teamId) || !canManageFlow(user, input.teamId)) throw forbidden('You cannot change this flow.');
    const flow = await saveFlow(existing.id, input, user);
    await audit(req, flow.id, 'flow_updated', `Updated flow "${flow.name}"${flow.enabled ? '' : ' (off)'}`);
    res.json({ flow: toPublic(flow, user) });
  }),
);

flowsRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const flow = await visible(req);
    if (!canManageFlow(userOf(req), flow.teamId)) throw forbidden('You cannot remove this flow.');
    await deleteFlow(flow.id);
    await audit(req, flow.id, 'flow_deleted', `Removed flow "${flow.name}"`);
    res.status(204).end();
  }),
);

/** Runs the flow now against a ticket, whatever its trigger says: for trying it out. */
flowsRouter.post(
  '/:id/run',
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const flow = await visible(req);
    if (!canManageFlow(user, flow.teamId)) throw forbidden('You cannot run this flow.');
    const settings = await getSettings();
    const ticket = typeof req.body?.ticket === 'string' ? await findTicket(req.body.ticket.trim(), settings.ticketPrefix) : null;
    if (!ticket) throw badRequest('Give a ticket to run it on, e.g. its reference.');
    if (!canSeeTicket(user, ticket)) throw forbidden('You do not have access to that ticket.');
    if (flow.teamId && ticket.teamId !== flow.teamId) throw badRequest(`${ticket.reference} is not one of ${flow.teamName}'s tickets.`);
    const runId = await startRun(flow, ticket, 'manual', user.name);
    await audit(req, flow.id, 'flow_run', `Ran flow "${flow.name}" on ${ticket.reference}`);
    res.json({ runId, runs: await listRuns(flow.id, 5) });
  }),
);
