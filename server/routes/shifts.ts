import { Router, type Request } from 'express';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { asyncRoute, forbidden, notFound } from '../lib/http.ts';
import { can, requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
import { findTeamById } from '../repositories/teams.ts';
import { canManageOnCallFor } from '../ops/access.ts';
import {
  addShiftException,
  departmentShifts,
  getDepartmentSchedule,
  removeShiftException,
  saveDepartmentSchedule,
  shiftBoard,
  validatePatterns,
  type HandoverSettings,
} from '../ops/shifts.ts';
import { buildHandover, handoverText, listHandovers, sendHandover } from '../ops/handover.ts';

/**
 * Department working schedules. Anyone who can see operations sees who is in;
 * a department's schedule is edited by its managers, whoever manages its
 * on-call, and department administrators.
 */
export const shiftsRouter: Router = Router();
shiftsRouter.use(requireAuth, requirePermission('ops.view'));

const userOf = (req: Request) => (req as AuthedRequest).user;

async function editableTeam(req: Request) {
  const team = await findTeamById(req.params.teamId);
  if (!team) throw notFound('That department does not exist.');
  const user = userOf(req);
  if (!can(user, 'teams.manage') && !canManageOnCallFor(user, team.id)) throw forbidden(`You cannot change ${team.name}'s schedule.`);
  return team;
}

async function audit(req: Request, teamId: string, summary: string) {
  const user = userOf(req);
  await recordAudit({ actorId: user.id, actorName: user.name, entityType: 'team', entityId: teamId, action: 'shifts_updated', summary, ip: clientIp(req) });
}

shiftsRouter.get(
  '/board',
  asyncRoute(async (_req, res) => {
    res.json({ departments: await shiftBoard() });
  }),
);

/** One department's shifts for a week (or the range asked for, up to 31 days). */
shiftsRouter.get(
  '/:teamId/calendar',
  asyncRoute(async (req, res) => {
    const from = req.query.from ? Date.parse(String(req.query.from)) : Date.now();
    const days = Math.min(31, Math.max(1, Number(req.query.days ?? 7) || 7));
    if (!Number.isFinite(from)) return res.status(400).json({ error: 'Unreadable date' });
    res.json({ shifts: await departmentShifts(req.params.teamId, from, from + days * 86_400_000) });
  }),
);

/** What the handover would say if it were sent now. */
shiftsRouter.get(
  '/:teamId/handover/preview',
  asyncRoute(async (req, res) => {
    const team = await findTeamById(req.params.teamId);
    if (!team) throw notFound('That department does not exist.');
    const schedule = await getDepartmentSchedule(team.id);
    const report = await buildHandover(team.id);
    res.json({ report, text: handoverText(report, schedule.timeZone) });
  }),
);

shiftsRouter.get(
  '/:teamId/handover/history',
  asyncRoute(async (req, res) => {
    const team = await findTeamById(req.params.teamId);
    if (!team) throw notFound('That department does not exist.');
    res.json({ reports: await listHandovers(team.id) });
  }),
);

shiftsRouter.post(
  '/:teamId/handover/send',
  asyncRoute(async (req, res) => {
    const team = await editableTeam(req);
    const result = await sendHandover(team.id);
    const user = userOf(req);
    await recordAudit({ actorId: user.id, actorName: user.name, entityType: 'team', entityId: team.id, action: 'handover_sent', summary: `Sent ${team.name}'s shift handover`, ip: clientIp(req) });
    res.json(result);
  }),
);

shiftsRouter.get(
  '/:teamId',
  asyncRoute(async (req, res) => {
    const team = await findTeamById(req.params.teamId);
    if (!team) throw notFound('That department does not exist.');
    const user = userOf(req);
    res.json({ schedule: await getDepartmentSchedule(team.id), canEdit: can(user, 'teams.manage') || canManageOnCallFor(user, team.id) });
  }),
);

shiftsRouter.put(
  '/:teamId',
  asyncRoute(async (req, res) => {
    const team = await editableTeam(req);
    const schedule = await saveDepartmentSchedule(team.id, {
      timeZone: typeof req.body?.timeZone === 'string' ? req.body.timeZone : undefined,
      handover: req.body?.handover && typeof req.body.handover === 'object' ? (req.body.handover as HandoverSettings) : undefined,
      patterns: req.body?.patterns !== undefined ? validatePatterns(req.body.patterns) : undefined,
    });
    await audit(req, team.id, `Updated ${team.name}'s shifts (${schedule.patterns.length})`);
    res.json({ schedule });
  }),
);

shiftsRouter.post(
  '/:teamId/exceptions',
  asyncRoute(async (req, res) => {
    const team = await editableTeam(req);
    const schedule = await addShiftException(team.id, req.body ?? {});
    await audit(req, team.id, `Added a ${String(req.body?.kind)} change for ${team.name} on ${String(req.body?.date)}`);
    res.status(201).json({ schedule });
  }),
);

shiftsRouter.delete(
  '/:teamId/exceptions/:id',
  asyncRoute(async (req, res) => {
    const team = await editableTeam(req);
    const schedule = await removeShiftException(team.id, req.params.id);
    await audit(req, team.id, `Removed a schedule change from ${team.name}`);
    res.json({ schedule });
  }),
);
