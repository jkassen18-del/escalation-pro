import { Router, type Request } from 'express';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { asyncRoute, badRequest, forbidden, notFound, optionalString, requireString, toStringArray } from '../lib/http.ts';
import { can, requireAuth, type AuthedRequest } from '../middleware/auth.ts';
import { getSettings } from '../repositories/settings.ts';
import { findTicket } from '../repositories/tickets.ts';
import { canSeeTicket } from '../services/ticket-actions.ts';
import {
  approvalsWaitingOn,
  cancelApproval,
  decide,
  deleteRule,
  findApproval,
  findRule,
  listApprovals,
  listRules,
  requestApproval,
  saveRule,
  validateRule,
} from '../services/approvals.ts';
import type { PublicUser } from '../../shared/types.ts';

/**
 * Sign-off on tickets. Approvers decide here, in Slack or in Teams; rules are
 * kept by whoever holds approvals.manage, and department managers keep their
 * own department's.
 */
export const approvalsRouter: Router = Router();
approvalsRouter.use(requireAuth);

const userOf = (req: Request) => (req as AuthedRequest).user;
const origin = (req: Request) => `${req.protocol}://${req.get('host')}`;

function canManageRules(user: PublicUser, teamId: string | null): boolean {
  if (can(user, 'approvals.manage')) return true;
  return Boolean(teamId && user.managedTeamIds.includes(teamId));
}

async function visibleTicket(req: Request, id: string) {
  const settings = await getSettings();
  const ticket = await findTicket(id, settings.ticketPrefix);
  if (!ticket) throw notFound('That ticket does not exist.');
  if (!canSeeTicket(userOf(req), ticket)) throw forbidden('You do not have access to this ticket.');
  return ticket;
}

/** What is waiting on me. */
approvalsRouter.get(
  '/mine',
  asyncRoute(async (req, res) => {
    res.json({ approvals: await approvalsWaitingOn(userOf(req).id) });
  }),
);

/* -------------------------------- Rules -------------------------------- */

approvalsRouter.get(
  '/rules',
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const teamId = typeof req.query.teamId === 'string' && req.query.teamId ? req.query.teamId : undefined;
    const rules = await listRules(teamId);
    res.json({
      rules: rules.filter((rule) => canManageRules(user, rule.teamId)),
      canManageAll: can(user, 'approvals.manage'),
    });
  }),
);

approvalsRouter.post(
  '/rules',
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const rule = validateRule(req.body ?? {});
    if (!canManageRules(user, rule.teamId)) throw forbidden(rule.teamId ? 'You cannot change this department’s approval rules.' : 'Only approval administrators can add organisation-wide rules.');
    const saved = await saveRule(null, rule);
    await recordAudit({ actorId: user.id, actorName: user.name, entityType: 'approval_rule', entityId: saved.id, action: 'approval_rule_created', summary: `Added approval rule "${saved.name}"`, ip: clientIp(req) });
    res.status(201).json({ rule: saved });
  }),
);

approvalsRouter.put(
  '/rules/:id',
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const existing = await findRule(req.params.id);
    if (!existing) throw notFound('That rule does not exist.');
    const rule = validateRule(req.body ?? {});
    if (!canManageRules(user, existing.teamId) || !canManageRules(user, rule.teamId)) throw forbidden('You cannot change this rule.');
    const saved = await saveRule(existing.id, rule);
    await recordAudit({ actorId: user.id, actorName: user.name, entityType: 'approval_rule', entityId: saved.id, action: 'approval_rule_updated', summary: `Updated approval rule "${saved.name}"`, ip: clientIp(req) });
    res.json({ rule: saved });
  }),
);

approvalsRouter.delete(
  '/rules/:id',
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const existing = await findRule(req.params.id);
    if (!existing) throw notFound('That rule does not exist.');
    if (!canManageRules(user, existing.teamId)) throw forbidden('You cannot remove this rule.');
    await deleteRule(existing.id);
    await recordAudit({ actorId: user.id, actorName: user.name, entityType: 'approval_rule', entityId: existing.id, action: 'approval_rule_deleted', summary: `Removed approval rule "${existing.name}"`, ip: clientIp(req) });
    res.status(204).end();
  }),
);

/* ------------------------------- Requests ------------------------------- */

approvalsRouter.get(
  '/ticket/:ticketId',
  asyncRoute(async (req, res) => {
    const ticket = await visibleTicket(req, req.params.ticketId);
    res.json({ approvals: await listApprovals(ticket.id), canRequest: can(userOf(req), 'tickets.request_approval') });
  }),
);

approvalsRouter.post(
  '/ticket/:ticketId',
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    if (!can(user, 'tickets.request_approval')) throw forbidden('You cannot ask for approval on tickets.');
    const ticket = await visibleTicket(req, req.params.ticketId);
    const approverIds = toStringArray(req.body?.approverIds, 20);
    if (!approverIds.length) throw badRequest('Choose who approves.');
    const approval = await requestApproval(
      ticket,
      {
        title: requireString(req.body?.title, 'What needs approving', { max: 160 }),
        note: optionalString(req.body?.note, 1000),
        approverIds,
        mode: req.body?.mode === 'all' ? 'all' : 'any',
        onReject: req.body?.onReject === 'keep_open' ? 'keep_open' : 'close',
      },
      user,
      origin(req),
    );
    res.status(201).json({ approval });
  }),
);

approvalsRouter.post(
  '/:id/decide',
  asyncRoute(async (req, res) => {
    const decision = req.body?.decision === 'approved' ? 'approved' : req.body?.decision === 'rejected' ? 'rejected' : null;
    if (!decision) throw badRequest('Approve or reject.');
    const approval = await findApproval(req.params.id);
    if (!approval) throw notFound('That approval no longer exists.');
    await visibleTicket(req, approval.ticketId).catch((error) => {
      // An approver outside the department still decides: being named is the access.
      if (!approval.approverIds.includes(userOf(req).id)) throw error;
    });
    const result = await decide(approval.id, userOf(req), decision, { comment: optionalString(req.body?.comment, 1000), via: 'web', origin: origin(req) });
    res.json(result);
  }),
);

approvalsRouter.post(
  '/:id/cancel',
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const approval = await findApproval(req.params.id);
    if (!approval) throw notFound('That approval no longer exists.');
    const ticket = await visibleTicket(req, approval.ticketId);
    const mayCancel = approval.requestedById === user.id || can(user, 'approvals.manage') || Boolean(ticket.teamId && user.managedTeamIds.includes(ticket.teamId));
    if (!mayCancel) throw forbidden('Only whoever asked, a department manager or an approvals administrator can withdraw this.');
    res.json({ approval: await cancelApproval(approval.id, user) });
  }),
);
