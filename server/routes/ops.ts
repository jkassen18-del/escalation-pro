import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { db } from '../db/index.ts';
import { clientIp, recordAudit, type AuditInput } from '../lib/audit.ts';
import { asyncRoute, badRequest, forbidden, notFound, optionalString, requireString } from '../lib/http.ts';
import { randomId } from '../lib/crypto.ts';
import { requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
import { getSettings } from '../repositories/settings.ts';
import { findTicket } from '../repositories/tickets.ts';
import { findTeamById } from '../repositories/teams.ts';
import { TERMINAL_STATUSES } from '../../shared/types.ts';
import { SEVERITIES, STATUS_UPDATE_STATES, type Severity, type StatusUpdateState } from '../../shared/ops.ts';
import { ingestSignal, listAlerts } from '../ops/alerts.ts';
import {
  activeOccurrences,
  cancelMaintenance,
  endMaintenanceNow,
  extendMaintenance,
  getMaintenanceRow,
  listMaintenanceWindows,
  mapWindow,
  occurrencesBetween,
  saveMaintenance,
  validateMaintenance,
} from '../ops/maintenance.ts';
import { deleteJob, getJob, jobConnection, listJobs, listRuns, openDecryptedBackup, runBackup, saveJob, validateJob } from '../ops/backups.ts';
import { canActOnPage, canManageAnyOnCall, canManageOnCallFor, filterToVisibleTickets, redactMonitor, redactSource } from '../ops/access.ts';
import { checkDatabaseHealth } from '../ops/db-health.ts';
import { checkMonitorNow, deleteMonitor, getMonitor, listMonitors, monitorChecks, monitorDays, saveMonitor, validateMonitor } from '../ops/monitors.ts';
import {
  addOverride,
  getPolicy,
  getSchedule,
  listPolicies,
  listSchedules,
  parseLayers,
  parseLevels,
  rulesFor,
  savePolicy,
  saveRules,
  saveSchedule,
  scheduleShifts,
  scheduleToIcs,
  validateRules,
  validateTimeZone,
} from '../ops/oncall.ts';
import { acknowledgePage, escalateNow, getPage, listPages, sendTestPage, triggerPage } from '../ops/pager.ts';
import { getSource, listSources, rotateSourceToken, saveSource, validateSource } from '../ops/sources.ts';
import { addStatusUpdate, getStatusPage, listStatusPages, renderStatusPage, saveStatusPage, validateStatusPage } from '../ops/status-pages.ts';
import { publicTelephony, saveTelephony } from '../ops/telephony.ts';
import { evaluateRules, getRule, listRules, reorderRules, saveRule, validateRule } from '../ops/routing.ts';

/**
 * The operations API: monitors, alerts, on-call, status pages and backups.
 *
 * Reading is open to everyone signed in - a responder needs to see what is
 * down and who is on call. Changing anything needs the module's permission.
 */
export const opsRouter: Router = Router();
opsRouter.use(requireAuth);

const userOf = (req: Request) => (req as AuthedRequest).user;

async function audit(req: Request, input: Omit<AuditInput, 'actorId' | 'actorName' | 'ip'>) {
  const user = userOf(req);
  await recordAudit({ ...input, actorId: user.id, actorName: user.name, ip: clientIp(req) });
}

/* -------------------------------- Overview -------------------------------- */

opsRouter.get(
  '/overview',
  requirePermission('ops.view'),
  asyncRoute(async (req, res) => {
    const [monitors, alerts, pages, schedules, jobs] = await Promise.all([
      listMonitors(),
      listAlerts({ status: 'open', limit: 50 }),
      listPages({ status: 'active' }),
      listSchedules(),
      listJobs(),
    ]);
    res.json({
      monitors: { total: monitors.length, down: monitors.filter((m) => m.state === 'down').length, up: monitors.filter((m) => m.state === 'up').length },
      inMaintenance: monitors
        .filter((m) => m.maintenance)
        .map((m) => ({ monitorId: m.id, name: m.name, state: m.state, ...m.maintenance! })),
      openAlerts: await filterToVisibleTickets(alerts, userOf(req)),
      activePages: await filterToVisibleTickets(pages, userOf(req)),
      myPages: pages.filter((p) => p.currentTargetIds.includes(userOf(req).id)),
      onCall: schedules.map((s) => ({ scheduleId: s.id, scheduleName: s.name, teamName: s.teamName, ...s.onCallNow })),
      backups: { total: jobs.length, failing: jobs.filter((j) => j.lastStatus === 'failed').length },
    });
  }),
);

/* -------------------------------- Monitors -------------------------------- */

opsRouter.get('/monitors', requirePermission('ops.view'), asyncRoute(async (req, res) => res.json({ monitors: (await listMonitors()).map((m) => redactMonitor(m, userOf(req))) })));

opsRouter.get(
  '/monitors/:id',
  requirePermission('ops.view'),
  asyncRoute(async (req, res) => {
    const monitor = await getMonitor(req.params.id);
    if (!monitor) throw notFound('That monitor does not exist.');
    res.json({ monitor: redactMonitor(monitor, userOf(req)), checks: await monitorChecks(monitor.id), days: await monitorDays(monitor.id) });
  }),
);

opsRouter.post(
  '/monitors',
  requirePermission('monitors.manage'),
  asyncRoute(async (req, res) => {
    const monitor = await saveMonitor(null, validateMonitor(req.body ?? {}));
    await audit(req, { entityType: 'monitor', entityId: monitor.id, action: 'monitor_created', summary: `Created ${monitor.kind} monitor "${monitor.name}"` });
    res.status(201).json({ monitor });
  }),
);

opsRouter.put(
  '/monitors/:id',
  requirePermission('monitors.manage'),
  asyncRoute(async (req, res) => {
    if (!(await getMonitor(req.params.id))) throw notFound('That monitor does not exist.');
    const monitor = await saveMonitor(req.params.id, validateMonitor(req.body ?? {}));
    await audit(req, { entityType: 'monitor', entityId: monitor.id, action: 'monitor_updated', summary: `Updated monitor "${monitor.name}"` });
    res.json({ monitor });
  }),
);

opsRouter.delete(
  '/monitors/:id',
  requirePermission('monitors.manage'),
  asyncRoute(async (req, res) => {
    const monitor = await getMonitor(req.params.id);
    if (!monitor) throw notFound('That monitor does not exist.');
    await deleteMonitor(monitor.id);
    await audit(req, { entityType: 'monitor', entityId: monitor.id, action: 'monitor_deleted', summary: `Deleted monitor "${monitor.name}"` });
    res.status(204).end();
  }),
);

opsRouter.post(
  '/monitors/:id/check',
  requirePermission('monitors.manage'),
  asyncRoute(async (req, res) => {
    const monitor = await checkMonitorNow(req.params.id);
    if (!monitor) throw notFound('That monitor does not exist.');
    res.json({ monitor, checks: await monitorChecks(monitor.id, 20) });
  }),
);

/* --------------------------------- Alerts --------------------------------- */

opsRouter.get(
  '/alerts',
  requirePermission('ops.view'),
  asyncRoute(async (req, res) => {
    const alerts = await listAlerts({ status: optionalString(req.query.status, 20) ?? undefined, ticketId: optionalString(req.query.ticketId, 60) ?? undefined });
    res.json({ alerts: await filterToVisibleTickets(alerts, userOf(req)) });
  }),
);

opsRouter.get('/alert-sources', requirePermission('ops.view'), asyncRoute(async (req, res) => res.json({ sources: (await listSources()).map((s) => redactSource(s, userOf(req))) })));

opsRouter.post(
  '/alert-sources',
  requirePermission('monitors.manage'),
  asyncRoute(async (req, res) => {
    const source = await saveSource(null, validateSource(req.body ?? {}));
    await audit(req, { entityType: 'alert', entityId: source.id, action: 'alert_source_created', summary: `Created alert source "${source.name}" (${source.kind})` });
    res.status(201).json({ source });
  }),
);

opsRouter.put(
  '/alert-sources/:id',
  requirePermission('monitors.manage'),
  asyncRoute(async (req, res) => {
    if (!(await getSource(req.params.id))) throw notFound('That alert source does not exist.');
    const source = await saveSource(req.params.id, validateSource(req.body ?? {}));
    await audit(req, { entityType: 'alert', entityId: source.id, action: 'alert_source_updated', summary: `Updated alert source "${source.name}"` });
    res.json({ source });
  }),
);

opsRouter.delete(
  '/alert-sources/:id',
  requirePermission('monitors.manage'),
  asyncRoute(async (req, res) => {
    const source = await getSource(req.params.id);
    if (!source) throw notFound('That alert source does not exist.');
    await db.run(`DELETE FROM alert_sources WHERE id = ?`, [source.id]);
    await audit(req, { entityType: 'alert', entityId: source.id, action: 'alert_source_deleted', summary: `Deleted alert source "${source.name}"` });
    res.status(204).end();
  }),
);

opsRouter.post(
  '/alert-sources/:id/rotate',
  requirePermission('monitors.manage'),
  asyncRoute(async (req, res) => {
    const source = await rotateSourceToken(req.params.id);
    if (!source) throw notFound('That alert source does not exist.');
    await audit(req, { entityType: 'alert', entityId: source.id, action: 'alert_source_rotated', summary: `Issued a new webhook URL for "${source.name}"` });
    res.json({ source });
  }),
);

/** Sends a sample alert through the real pipeline, so the routing can be seen end to end. */
opsRouter.post(
  '/alert-sources/:id/test',
  requirePermission('monitors.manage'),
  asyncRoute(async (req, res) => {
    const source = await getSource(req.params.id);
    if (!source) throw notFound('That alert source does not exist.');
    const result = await ingestSignal({
      sourceType: 'webhook',
      sourceKind: source.kind,
      sourceId: source.id,
      sourceName: source.name,
      dedupKey: `test:${randomId()}`,
      title: `Test alert from ${source.name}`,
      summary: `Sent by ${userOf(req).name} from the alert source settings. Resolve this ticket when you are done.`,
      severity: source.defaultSeverity,
      status: 'firing',
      teamId: source.teamId,
      escalationPolicyId: source.escalationPolicyId,
      payload: { test: true },
    });
    res.json({ result });
  }),
);

/* ------------------------------ Maintenance ------------------------------ */

async function maintenanceListing() {
  const now = Date.now();
  const occurrences = (await occurrencesBetween(now, now + 30 * 86_400_000)).map(({ occurrence }) => occurrence);
  return { windows: await listMaintenanceWindows(), occurrences };
}

opsRouter.get('/maintenance', requirePermission('ops.view'), asyncRoute(async (_req, res) => res.json(await maintenanceListing())));

/** What is in maintenance right now, for the banner every page shows. */
opsRouter.get(
  '/maintenance/active',
  requirePermission('ops.view'),
  asyncRoute(async (_req, res) => {
    const active = await activeOccurrences();
    res.json({
      active: await Promise.all(
        active.map(async ({ row, occurrence }) => ({ ...occurrence, scopeSummary: (await mapWindow(row)).scopeSummary })),
      ),
    });
  }),
);

async function loadWindow(id: string) {
  const row = await getMaintenanceRow(id);
  if (!row) throw notFound('That maintenance window does not exist.');
  return row;
}

opsRouter.post(
  '/maintenance',
  requirePermission('maintenance.manage'),
  asyncRoute(async (req, res) => {
    const window = await saveMaintenance(null, validateMaintenance(req.body ?? {}), userOf(req).id);
    await audit(req, {
      entityType: 'monitor',
      entityId: window.id,
      action: 'maintenance_scheduled',
      summary: `Scheduled maintenance "${window.title}" (${window.scopeSummary}, ${window.effect.replace('_', ' ')})`,
    });
    res.status(201).json({ window, ...(await maintenanceListing()) });
  }),
);

opsRouter.put(
  '/maintenance/:id',
  requirePermission('maintenance.manage'),
  asyncRoute(async (req, res) => {
    await loadWindow(req.params.id);
    const window = await saveMaintenance(req.params.id, validateMaintenance(req.body ?? {}), userOf(req).id);
    await audit(req, { entityType: 'monitor', entityId: window.id, action: 'maintenance_updated', summary: `Updated maintenance "${window.title}"` });
    res.json({ window });
  }),
);

/** Cancels the window, or with `occurrence` skips one occurrence of a recurring window. */
opsRouter.post(
  '/maintenance/:id/cancel',
  requirePermission('maintenance.manage'),
  asyncRoute(async (req, res) => {
    const row = await loadWindow(req.params.id);
    const occurrence = optionalString(req.body?.occurrence, 40) ?? undefined;
    await cancelMaintenance(row, occurrence);
    await audit(req, {
      entityType: 'monitor',
      entityId: row.id,
      action: occurrence ? 'maintenance_occurrence_skipped' : 'maintenance_cancelled',
      summary: occurrence ? `Skipped the ${occurrence} occurrence of maintenance "${row.title}"` : `Cancelled maintenance "${row.title}"`,
    });
    res.json({ window: await mapWindow((await getMaintenanceRow(row.id))!) });
  }),
);

opsRouter.post(
  '/maintenance/:id/end',
  requirePermission('maintenance.manage'),
  asyncRoute(async (req, res) => {
    const row = await loadWindow(req.params.id);
    if (!(await endMaintenanceNow(row))) throw badRequest('This maintenance is not in progress.');
    await audit(req, { entityType: 'monitor', entityId: row.id, action: 'maintenance_ended_early', summary: `Ended maintenance "${row.title}" early` });
    res.json({ window: await mapWindow((await getMaintenanceRow(row.id))!) });
  }),
);

opsRouter.post(
  '/maintenance/:id/extend',
  requirePermission('maintenance.manage'),
  asyncRoute(async (req, res) => {
    const row = await loadWindow(req.params.id);
    const until = optionalString(req.body?.until, 40) ?? undefined;
    const minutes = req.body?.minutes === undefined ? undefined : Number(req.body.minutes);
    if (!until && !(minutes && minutes > 0 && minutes <= 7 * 24 * 60)) throw badRequest('Extend by a number of minutes, or to a time.');
    const occurrence = await extendMaintenance(row, { minutes, until });
    await audit(req, {
      entityType: 'monitor',
      entityId: row.id,
      action: 'maintenance_extended',
      summary: `Extended maintenance "${row.title}" to ${occurrence.endsAt}`,
    });
    res.json({ window: await mapWindow((await getMaintenanceRow(row.id))!) });
  }),
);

/** Removes a window from the history entirely. Cancel is the usual way to stop one. */
opsRouter.delete(
  '/maintenance/:id',
  requirePermission('maintenance.manage'),
  asyncRoute(async (req, res) => {
    const row = await loadWindow(req.params.id);
    await db.run(`DELETE FROM maintenance_windows WHERE id = ?`, [row.id]);
    await audit(req, { entityType: 'monitor', entityId: row.id, action: 'maintenance_deleted', summary: `Deleted maintenance "${row.title}"` });
    res.status(204).end();
  }),
);

/* ------------------------------ Alert routing ----------------------------- */

opsRouter.get('/alert-rules', requirePermission('ops.view'), asyncRoute(async (_req, res) => res.json({ rules: await listRules() })));

opsRouter.post(
  '/alert-rules',
  requirePermission('alerts.routing'),
  asyncRoute(async (req, res) => {
    const rule = await saveRule(null, validateRule(req.body ?? {}));
    await audit(req, { entityType: 'alert', entityId: rule.id, action: 'alert_rule_created', summary: `Created routing rule "${rule.name}"` });
    res.status(201).json({ rule });
  }),
);

opsRouter.put(
  '/alert-rules/order',
  requirePermission('alerts.routing'),
  asyncRoute(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 500) : [];
    const rules = await reorderRules(ids);
    await audit(req, { entityType: 'alert', action: 'alert_rules_reordered', summary: `Reordered routing rules: ${rules.map((r) => r.name).join(', ')}` });
    res.json({ rules });
  }),
);

opsRouter.put(
  '/alert-rules/:id',
  requirePermission('alerts.routing'),
  asyncRoute(async (req, res) => {
    if (!(await getRule(req.params.id))) throw notFound('That rule does not exist.');
    const rule = await saveRule(req.params.id, validateRule(req.body ?? {}));
    await audit(req, { entityType: 'alert', entityId: rule.id, action: 'alert_rule_updated', summary: `Updated routing rule "${rule.name}"` });
    res.json({ rule });
  }),
);

opsRouter.delete(
  '/alert-rules/:id',
  requirePermission('alerts.routing'),
  asyncRoute(async (req, res) => {
    const rule = await getRule(req.params.id);
    if (!rule) throw notFound('That rule does not exist.');
    await db.run(`DELETE FROM alert_rules WHERE id = ?`, [rule.id]);
    await audit(req, { entityType: 'alert', entityId: rule.id, action: 'alert_rule_deleted', summary: `Deleted routing rule "${rule.name}"` });
    res.status(204).end();
  }),
);

/**
 * Dry run: which rule a sample alert would match and what would happen to it.
 * Nothing is recorded. An unsaved rule can be tried by sending it as `rule`.
 */
opsRouter.post(
  '/alert-rules/test',
  requirePermission('ops.view'),
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const severity = (SEVERITIES as readonly string[]).includes(String(body.severity)) ? (body.severity as Severity) : 'sev2';
    const sourceId = optionalString(body.sourceId, 60) ?? '';
    // Default routing comes from the chosen source, as it would for a real alert.
    const monitor = sourceId ? await getMonitor(sourceId) : null;
    const source = sourceId && !monitor ? await getSource(sourceId) : null;
    let payload: unknown = body.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        throw badRequest('The sample payload is not valid JSON.');
      }
    }
    const signal = {
      sourceType: (monitor ? 'monitor' : 'webhook') as 'monitor' | 'webhook',
      sourceId,
      sourceKind: optionalString(body.sourceKind, 40) ?? monitor?.kind ?? source?.kind ?? undefined,
      title: optionalString(body.title, 300) ?? 'Sample alert',
      summary: optionalString(body.summary, 4000) ?? '',
      severity,
      payload,
      teamId: monitor?.teamId ?? source?.teamId ?? null,
      escalationPolicyId: monitor?.escalationPolicyId ?? source?.escalationPolicyId ?? null,
    };
    const at = body.at ? new Date(String(body.at)) : new Date();
    if (Number.isNaN(at.getTime())) throw badRequest('That time is not valid.');
    const rules = body.rule ? [{ ...validateRule(body.rule as Record<string, unknown>), id: 'draft', position: -1, createdAt: '', updatedAt: '' }] : await listRules();
    res.json({ outcome: evaluateRules(rules, signal, at) });
  }),
);

/* ------------------------------- Schedules -------------------------------- */

function scheduleInput(body: Record<string, unknown>) {
  return {
    name: requireString(body.name, 'Name', { max: 120 }),
    description: optionalString(body.description, 1000),
    teamId: optionalString(body.teamId, 60),
    timeZone: validateTimeZone(String(body.timeZone || 'Africa/Johannesburg')),
    layers: parseLayers(body.layers),
  };
}

opsRouter.get('/schedules', requirePermission('ops.view'), asyncRoute(async (_req, res) => res.json({ schedules: await listSchedules() })));

opsRouter.get(
  '/schedules/:id',
  requirePermission('ops.view'),
  asyncRoute(async (req, res) => {
    const schedule = await getSchedule(req.params.id);
    if (!schedule) throw notFound('That schedule does not exist.');
    const from = req.query.from ? new Date(String(req.query.from)).getTime() : Date.now() - 86_400_000;
    const to = req.query.to ? new Date(String(req.query.to)).getTime() : from + 15 * 86_400_000;
    if (!(to > from) || to - from > 92 * 86_400_000) throw badRequest('Ask for at most 92 days at a time.');
    res.json({ schedule, shifts: await scheduleShifts(schedule.id, from, to) });
  }),
);

/** iCalendar feed of the next 90 days, for Outlook or Google Calendar. Needs a signed-in session. */
opsRouter.get(
  '/schedules/:id/calendar.ics',
  requirePermission('ops.view'),
  asyncRoute(async (req, res) => {
    const schedule = await getSchedule(req.params.id);
    if (!schedule) throw notFound('That schedule does not exist.');
    const from = Date.now() - 7 * 86_400_000;
    const shifts = await scheduleShifts(schedule.id, from, from + 97 * 86_400_000);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${schedule.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.ics"`);
    res.send(scheduleToIcs(schedule.name, shifts));
  }),
);

opsRouter.post(
  '/schedules',
  requireOnCallEditor,
  asyncRoute(async (req, res) => {
    const input = scheduleInput(req.body ?? {});
    assertCanManageOnCall(req, input.teamId);
    const schedule = await saveSchedule(null, input);
    await audit(req, { entityType: 'oncall', entityId: schedule.id, action: 'schedule_created', summary: `Created on-call schedule "${schedule.name}"` });
    res.status(201).json({ schedule });
  }),
);

opsRouter.put(
  '/schedules/:id',
  requireOnCallEditor,
  asyncRoute(async (req, res) => {
    const existing = await getSchedule(req.params.id);
    if (!existing) throw notFound('That schedule does not exist.');
    const input = scheduleInput(req.body ?? {});
    // Both ends: you cannot take another department's schedule, nor give yours away.
    assertCanManageOnCall(req, existing.teamId);
    assertCanManageOnCall(req, input.teamId);
    const schedule = await saveSchedule(req.params.id, input);
    await audit(req, { entityType: 'oncall', entityId: schedule.id, action: 'schedule_updated', summary: `Updated on-call schedule "${schedule.name}"` });
    res.json({ schedule });
  }),
);

opsRouter.delete(
  '/schedules/:id',
  requireOnCallEditor,
  asyncRoute(async (req, res) => {
    const schedule = await getSchedule(req.params.id);
    if (!schedule) throw notFound('That schedule does not exist.');
    assertCanManageOnCall(req, schedule.teamId);
    await db.run(`DELETE FROM oncall_schedules WHERE id = ?`, [schedule.id]);
    await audit(req, { entityType: 'oncall', entityId: schedule.id, action: 'schedule_deleted', summary: `Deleted on-call schedule "${schedule.name}"` });
    res.status(204).end();
  }),
);

/** Lets through anyone who can edit some department's on-call; the route then checks which. */
function requireOnCallEditor(req: Request, _res: Response, next: NextFunction): void {
  if (!canManageAnyOnCall(userOf(req))) return next(forbidden('You do not have permission to do that.'));
  next();
}

function assertCanManageOnCall(req: Request, teamId: string | null | undefined): void {
  if (!canManageOnCallFor(userOf(req), teamId)) {
    throw forbidden(teamId ? 'You can only change on-call for your own departments.' : 'Only an on-call manager can change a schedule that belongs to no department.');
  }
}

/**
 * Overrides: an on-call manager can put anyone in; anyone else can only cover
 * a shift themselves ("cover me Friday" is the person covering, not the
 * person being covered).
 */
opsRouter.post(
  '/schedules/:id/overrides',
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const schedule = await getSchedule(req.params.id);
    if (!schedule) throw notFound('That schedule does not exist.');
    const userId = requireString(req.body?.userId ?? user.id, 'Person', { max: 60 });
    const manages = canManageOnCallFor(user, schedule.teamId);
    if (userId !== user.id && !manages) throw badRequest('You can only add yourself as cover.');
    if (!manages && !user.permissions.includes('oncall.cover')) throw forbidden('You cannot cover on-call shifts.');
    const startsAt = new Date(String(req.body?.startsAt ?? ''));
    const endsAt = new Date(String(req.body?.endsAt ?? ''));
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw badRequest('Give a start and an end.');
    await addOverride(schedule.id, { userId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), note: optionalString(req.body?.note, 300) }, user.id);
    await audit(req, { entityType: 'oncall', entityId: schedule.id, action: 'override_added', summary: `Added an override to "${schedule.name}" from ${startsAt.toISOString()} to ${endsAt.toISOString()}` });
    res.status(201).json({ schedule: await getSchedule(schedule.id) });
  }),
);

opsRouter.delete(
  '/schedules/:id/overrides/:overrideId',
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const row = await db.get<{ user_id: string }>(`SELECT user_id FROM oncall_overrides WHERE id = ? AND schedule_id = ?`, [req.params.overrideId, req.params.id]);
    if (!row) throw notFound('That override does not exist.');
    const manages = canManageOnCallFor(user, (await getSchedule(req.params.id))?.teamId);
    if (row.user_id !== user.id && !manages) throw badRequest('You can only remove your own cover.');
    if (!manages && !user.permissions.includes('oncall.cover')) throw forbidden('You cannot cover on-call shifts.');
    await db.run(`DELETE FROM oncall_overrides WHERE id = ?`, [req.params.overrideId]);
    res.status(204).end();
  }),
);

/* -------------------------- Escalation policies --------------------------- */

function policyInput(body: Record<string, unknown>) {
  return {
    name: requireString(body.name, 'Name', { max: 120 }),
    description: optionalString(body.description, 1000),
    teamId: optionalString(body.teamId, 60),
    repeatCount: Math.min(5, Math.max(0, Math.round(Number(body.repeatCount ?? 0)))),
    levels: parseLevels(body.levels),
  };
}

opsRouter.get('/policies', requirePermission('ops.view'), asyncRoute(async (_req, res) => res.json({ policies: await listPolicies() })));

opsRouter.post(
  '/policies',
  requirePermission('oncall.manage'),
  asyncRoute(async (req, res) => {
    const policy = await savePolicy(null, policyInput(req.body ?? {}));
    await audit(req, { entityType: 'oncall', entityId: policy.id, action: 'policy_created', summary: `Created escalation policy "${policy.name}"` });
    res.status(201).json({ policy });
  }),
);

opsRouter.put(
  '/policies/:id',
  requirePermission('oncall.manage'),
  asyncRoute(async (req, res) => {
    if (!(await getPolicy(req.params.id))) throw notFound('That policy does not exist.');
    const policy = await savePolicy(req.params.id, policyInput(req.body ?? {}));
    await audit(req, { entityType: 'oncall', entityId: policy.id, action: 'policy_updated', summary: `Updated escalation policy "${policy.name}"` });
    res.json({ policy });
  }),
);

opsRouter.delete(
  '/policies/:id',
  requirePermission('oncall.manage'),
  asyncRoute(async (req, res) => {
    const policy = await getPolicy(req.params.id);
    if (!policy) throw notFound('That policy does not exist.');
    await db.run(`DELETE FROM escalation_policies WHERE id = ?`, [policy.id]);
    // Nothing may keep pointing at a deleted policy, or its alerts would page nobody.
    await db.run(`UPDATE teams SET escalation_policy_id = NULL WHERE escalation_policy_id = ?`, [policy.id]);
    await db.run(`UPDATE monitors SET escalation_policy_id = NULL WHERE escalation_policy_id = ?`, [policy.id]);
    await db.run(`UPDATE alert_sources SET escalation_policy_id = NULL WHERE escalation_policy_id = ?`, [policy.id]);
    const rules = await db.all<{ id: string; actions: string }>(`SELECT id, actions FROM alert_rules`);
    for (const rule of rules) {
      let actions: Record<string, unknown>;
      try {
        actions = JSON.parse(rule.actions || '{}');
      } catch {
        continue;
      }
      if (actions.escalationPolicyId !== policy.id) continue;
      delete actions.escalationPolicyId;
      await db.run(`UPDATE alert_rules SET actions = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(actions), new Date().toISOString(), rule.id]);
    }
    await audit(req, { entityType: 'oncall', entityId: policy.id, action: 'policy_deleted', summary: `Deleted escalation policy "${policy.name}"` });
    res.status(204).end();
  }),
);

/** Which policy pages for a team's alerts when the monitor or source does not name one. */
opsRouter.get(
  '/team-policies',
  requirePermission('ops.view'),
  asyncRoute(async (_req, res) => {
    const rows = await db.all<{ id: string; name: string; escalation_policy_id: string | null }>(`SELECT id, name, escalation_policy_id FROM teams ORDER BY name`);
    res.json({ teams: rows.map((row) => ({ teamId: row.id, teamName: row.name, policyId: row.escalation_policy_id })) });
  }),
);

opsRouter.put(
  '/team-policies/:teamId',
  requirePermission('oncall.manage'),
  asyncRoute(async (req, res) => {
    const team = await findTeamById(req.params.teamId);
    if (!team) throw notFound('That team does not exist.');
    const policyId = optionalString(req.body?.policyId, 60);
    if (policyId && !(await getPolicy(policyId))) throw badRequest('That policy does not exist.');
    await db.run(`UPDATE teams SET escalation_policy_id = ? WHERE id = ?`, [policyId, team.id]);
    await audit(req, { entityType: 'team', entityId: team.id, action: 'team_policy_set', summary: `Set the escalation policy for ${team.name}` });
    res.json({ ok: true });
  }),
);

/* ---------------------------------- Pages --------------------------------- */

/** Only someone the page reached, or an on-call manager, may ack or escalate it. */
async function assertCanActOnPage(req: Request): Promise<void> {
  const page = await getPage(req.params.id);
  if (!page) throw notFound('That page does not exist.');
  if (!(await canActOnPage(userOf(req), page.id, page.currentTargetIds))) {
    throw forbidden('Only the people this page reached, or an on-call manager, can acknowledge or escalate it.');
  }
}

opsRouter.get(
  '/pages',
  requirePermission('ops.view'),
  asyncRoute(async (req, res) => {
    const filter = String(req.query.filter ?? 'active');
    const pages = await listPages({
      status: filter === 'all' ? undefined : 'active',
      ticketId: optionalString(req.query.ticketId, 60) ?? undefined,
      userId: filter === 'mine' ? userOf(req).id : undefined,
    });
    res.json({ pages: await filterToVisibleTickets(pages, userOf(req)) });
  }),
);

opsRouter.get(
  '/pages/:id',
  requirePermission('ops.view'),
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    if (!page || !(await filterToVisibleTickets([page], userOf(req))).length) throw notFound('That page does not exist.');
    res.json({ page });
  }),
);

opsRouter.post(
  '/pages/:id/ack',
  asyncRoute(async (req, res) => {
    await assertCanActOnPage(req);
    const outcome = await acknowledgePage(req.params.id, userOf(req), 'web');
    if (outcome === 'closed') throw badRequest('That page has already been resolved.');
    res.json({ outcome, page: await getPage(req.params.id) });
  }),
);

opsRouter.post(
  '/pages/:id/escalate',
  asyncRoute(async (req, res) => {
    await assertCanActOnPage(req);
    if (!(await escalateNow(req.params.id, userOf(req).name))) throw badRequest('That page is not escalating any more.');
    res.json({ page: await getPage(req.params.id) });
  }),
);

/** Page someone about an existing ticket by hand ("get me the database on-call"). */
opsRouter.post(
  '/tickets/:ticketId/page',
  requirePermission('tickets.page'),
  asyncRoute(async (req, res) => {
    const settings = await getSettings();
    const ticket = await findTicket(req.params.ticketId, settings.ticketPrefix);
    if (!ticket) throw notFound('That ticket does not exist.');
    if (TERMINAL_STATUSES.includes(ticket.status)) throw badRequest('Reopen the ticket before paging anyone about it.');
    const policyId = requireString(req.body?.policyId, 'Escalation policy', { max: 60 });
    const severity = (SEVERITIES as readonly string[]).includes(req.body?.severity) ? (req.body.severity as Severity) : ticket.severity ?? 'sev2';
    const policy = await getPolicy(policyId);
    if (!policy) throw badRequest('That policy does not exist.');
    const pageId = await triggerPage(ticket.id, { policyId, severity, reason: `${userOf(req).name} paged "${policy.name}" by hand from ${ticket.reference}.` });
    res.status(201).json({ page: pageId ? await getPage(pageId) : null });
  }),
);

/* ------------------------- My notification rules -------------------------- */

opsRouter.get('/me/rules', asyncRoute(async (req, res) => res.json(await rulesFor(userOf(req).id))));

opsRouter.put(
  '/me/rules',
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    await saveRules(user.id, validateRules(req.body?.rules, user.permissions.includes('oncall.manage') && req.body?.allowQuiet === true));
    res.json(await rulesFor(user.id));
  }),
);

opsRouter.post('/me/test-page', asyncRoute(async (req, res) => res.json({ attempts: await sendTestPage(userOf(req)) })));

/* ------------------------------- Phone push ------------------------------- */

opsRouter.get(
  '/me/push',
  asyncRoute(async (req, res) => {
    const { countSubscriptions } = await import('../ops/push.ts');
    res.json({ devices: await countSubscriptions(userOf(req).id) });
  }),
);

opsRouter.post(
  '/push/subscribe',
  asyncRoute(async (req, res) => {
    const { saveSubscription, validateSubscription, countSubscriptions } = await import('../ops/push.ts');
    await saveSubscription(userOf(req).id, validateSubscription(req.body), req.header('user-agent') ?? null);
    res.status(201).json({ devices: await countSubscriptions(userOf(req).id) });
  }),
);

opsRouter.delete(
  '/push/subscribe',
  asyncRoute(async (req, res) => {
    const { removeSubscription, countSubscriptions } = await import('../ops/push.ts');
    const endpoint = requireString(req.body?.endpoint, 'Endpoint', { max: 2000 });
    if (!(await removeSubscription(userOf(req).id, endpoint))) throw notFound('That device is not subscribed.');
    res.json({ devices: await countSubscriptions(userOf(req).id) });
  }),
);

opsRouter.post(
  '/me/test-push',
  asyncRoute(async (req, res) => {
    const { sendPush } = await import('../ops/push.ts');
    const result = await sendPush(userOf(req).id, {
      title: 'InfraTicket test',
      body: 'Push notifications reach this device. A real page also has an Acknowledge button.',
      url: '/profile',
      tag: 'test-push',
    });
    res.json({ result });
  }),
);

/* ------------------------------ Teams calls ------------------------------- */

opsRouter.get(
  '/teams-calls',
  requirePermission('oncall.manage'),
  asyncRoute(async (_req, res) => {
    const { teamsCallSettings } = await import('../ops/teams-calls.ts');
    res.json({ settings: await teamsCallSettings() });
  }),
);

opsRouter.put(
  '/teams-calls',
  requirePermission('oncall.manage'),
  asyncRoute(async (req, res) => {
    const { setTeamsCallsEnabled } = await import('../ops/teams-calls.ts');
    const settings = await setTeamsCallsEnabled(req.body?.enabled === true);
    await audit(req, { entityType: 'oncall', action: 'teams_calls_updated', summary: `Turned Teams calls ${settings.enabled ? 'on' : 'off'}` });
    res.json({ settings });
  }),
);

opsRouter.put(
  '/teams-calls/prompt',
  requirePermission('oncall.manage'),
  express.raw({ type: () => true, limit: '600kb' }),
  asyncRoute(async (req, res) => {
    const { savePrompt } = await import('../ops/teams-calls.ts');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('Upload a WAV file.');
    const settings = await savePrompt(req.body);
    await audit(req, { entityType: 'oncall', action: 'teams_call_prompt_uploaded', summary: 'Uploaded the Teams call prompt' });
    res.json({ settings });
  }),
);

opsRouter.delete(
  '/teams-calls/prompt',
  requirePermission('oncall.manage'),
  asyncRoute(async (req, res) => {
    const { removePrompt } = await import('../ops/teams-calls.ts');
    const settings = await removePrompt();
    await audit(req, { entityType: 'oncall', action: 'teams_call_prompt_removed', summary: 'Removed the Teams call prompt' });
    res.json({ settings });
  }),
);

/** "Call me in Teams now": a real call to whoever clicks, with Graph's own error if it fails. */
opsRouter.post(
  '/teams-calls/test',
  requirePermission('oncall.manage'),
  asyncRoute(async (req, res) => {
    const { placeTeamsCall } = await import('../ops/teams-calls.ts');
    const user = userOf(req);
    const attemptId = randomId();
    const result = await placeTeamsCall(user, attemptId);
    await db.run(
      `INSERT INTO notification_attempts (id, page_id, user_id, channel, provider, status, level, cycle, seq, external_id, detail, created_at)
       VALUES (?, NULL, ?, 'teams_call', ?, ?, 0, 0, 0, ?, ?, ?)`,
      [attemptId, user.id, result.provider, result.status, result.externalId ?? null, result.detail.slice(0, 1000), new Date().toISOString()],
    );
    res.json({ result });
  }),
);

opsRouter.get('/telephony', requirePermission('oncall.manage'), asyncRoute(async (_req, res) => res.json({ telephony: await publicTelephony() })));

opsRouter.put(
  '/telephony',
  requirePermission('oncall.manage'),
  asyncRoute(async (req, res) => {
    const telephony = await saveTelephony(req.body ?? {});
    await audit(req, { entityType: 'oncall', action: 'telephony_updated', summary: `Set the SMS and voice provider to ${telephony.provider}` });
    res.json({ telephony });
  }),
);

/* ------------------------------ Status pages ------------------------------ */

opsRouter.get('/status-pages', requirePermission('ops.view'), asyncRoute(async (_req, res) => res.json({ pages: await listStatusPages() })));

opsRouter.get(
  '/status-pages/:id',
  requirePermission('ops.view'),
  asyncRoute(async (req, res) => {
    const page = await getStatusPage(req.params.id);
    if (!page) throw notFound('That status page does not exist.');
    res.json({ view: await renderStatusPage(page) });
  }),
);

opsRouter.post(
  '/status-pages',
  requirePermission('statuspages.manage'),
  asyncRoute(async (req, res) => {
    const page = await saveStatusPage(null, validateStatusPage(req.body ?? {}));
    await audit(req, { entityType: 'status_page', entityId: page.id, action: 'status_page_created', summary: `Created ${page.isPublic ? 'public' : 'internal'} status page "${page.title}"` });
    res.status(201).json({ page });
  }),
);

opsRouter.put(
  '/status-pages/:id',
  requirePermission('statuspages.manage'),
  asyncRoute(async (req, res) => {
    if (!(await getStatusPage(req.params.id))) throw notFound('That status page does not exist.');
    const page = await saveStatusPage(req.params.id, validateStatusPage(req.body ?? {}));
    await audit(req, { entityType: 'status_page', entityId: page.id, action: 'status_page_updated', summary: `Updated status page "${page.title}"` });
    res.json({ page });
  }),
);

opsRouter.delete(
  '/status-pages/:id',
  requirePermission('statuspages.manage'),
  asyncRoute(async (req, res) => {
    const page = await getStatusPage(req.params.id);
    if (!page) throw notFound('That status page does not exist.');
    await db.run(`DELETE FROM status_pages WHERE id = ?`, [page.id]);
    await audit(req, { entityType: 'status_page', entityId: page.id, action: 'status_page_deleted', summary: `Deleted status page "${page.title}"` });
    res.status(204).end();
  }),
);

opsRouter.post(
  '/status-pages/:id/updates',
  requirePermission('statuspages.post'),
  asyncRoute(async (req, res) => {
    const page = await getStatusPage(req.params.id);
    if (!page) throw notFound('That status page does not exist.');
    const state = String(req.body?.state ?? 'investigating') as StatusUpdateState;
    if (!STATUS_UPDATE_STATES.includes(state as (typeof STATUS_UPDATE_STATES)[number])) throw badRequest('Unknown state.');
    await addStatusUpdate(
      page.id,
      { title: requireString(req.body?.title, 'Title', { max: 200 }), state, body: optionalString(req.body?.body, 5000) ?? '', ticketId: optionalString(req.body?.ticketId, 60) },
      userOf(req).id,
    );
    await audit(req, { entityType: 'status_page', entityId: page.id, action: 'status_update_posted', summary: `Posted "${state}" to ${page.isPublic ? 'public' : 'internal'} page "${page.title}"` });
    res.status(201).json({ view: await renderStatusPage(page) });
  }),
);

/* ------------------------- Databases and backups -------------------------- */

opsRouter.get('/databases', requirePermission('databases.manage', 'backups.manage', 'backups.restore', 'monitors.manage'), asyncRoute(async (_req, res) => res.json({ databases: await listJobs() })));

opsRouter.get(
  '/databases/:id',
  requirePermission('databases.manage', 'backups.manage', 'backups.restore', 'monitors.manage'),
  asyncRoute(async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) throw notFound('That database does not exist.');
    res.json({ database: job, runs: await listRuns(job.id) });
  }),
);

opsRouter.post(
  '/databases',
  requirePermission('databases.manage'),
  asyncRoute(async (req, res) => {
    const job = await saveJob(null, validateJob(req.body ?? {}, false));
    await audit(req, { entityType: 'backup', entityId: job.id, action: 'database_added', summary: `Added ${job.engine} database "${job.name}" (${job.connectionHint})` });
    res.status(201).json({ database: job });
  }),
);

opsRouter.put(
  '/databases/:id',
  requirePermission('databases.manage'),
  asyncRoute(async (req, res) => {
    const job = await saveJob(req.params.id, validateJob(req.body ?? {}, true));
    await audit(req, { entityType: 'backup', entityId: job.id, action: 'database_updated', summary: `Updated database "${job.name}"` });
    res.json({ database: job });
  }),
);

opsRouter.delete(
  '/databases/:id',
  requirePermission('databases.manage'),
  asyncRoute(async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) throw notFound('That database does not exist.');
    await deleteJob(job.id);
    await audit(req, { entityType: 'backup', entityId: job.id, action: 'database_removed', summary: `Removed database "${job.name}" (backup files are kept)` });
    res.status(204).end();
  }),
);

/** Tests a connection before it is saved, or a saved one when no connection is sent. */
opsRouter.post(
  '/databases/test',
  requirePermission('databases.manage', 'monitors.manage'),
  asyncRoute(async (req, res) => {
    let engine = req.body?.engine;
    let connection = optionalString(req.body?.connection, 2000);
    if (!connection && req.body?.id) {
      const saved = await jobConnection(String(req.body.id));
      if (!saved) throw notFound('That database does not exist.');
      ({ engine, connection } = saved);
    }
    if (!connection) throw badRequest('Give the connection to test.');
    res.json({ health: await checkDatabaseHealth(engine, connection) });
  }),
);

opsRouter.post(
  '/databases/:id/run',
  requirePermission('backups.manage'),
  asyncRoute(async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) throw notFound('That database does not exist.');
    await audit(req, { entityType: 'backup', entityId: job.id, action: 'backup_started', summary: `Started a backup of "${job.name}"` });
    res.json({ run: await runBackup(job.id, 'manual') });
  }),
);

opsRouter.get(
  '/backup-runs/:id/download',
  requirePermission('backups.restore'),
  asyncRoute(async (req, res) => {
    const { stream, fileName } = await openDecryptedBackup(req.params.id);
    await audit(req, { entityType: 'backup', entityId: req.params.id, action: 'backup_downloaded', summary: `Downloaded decrypted backup ${fileName}` });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '')}"`);
    stream.on('error', (error) => {
      console.error('[backup] download failed', error);
      res.destroy(error);
    });
    stream.pipe(res);
  }),
);
