import { Router, type Request } from 'express';
import { db } from '../db/index.ts';
import { clientIp, recordAudit, type AuditInput } from '../lib/audit.ts';
import { asyncRoute, badRequest, notFound, optionalString, requireString } from '../lib/http.ts';
import { randomId } from '../lib/crypto.ts';
import { requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
import { getSettings } from '../repositories/settings.ts';
import { findTicket } from '../repositories/tickets.ts';
import { findTeamById } from '../repositories/teams.ts';
import { TERMINAL_STATUSES } from '../../shared/types.ts';
import { SEVERITIES, STATUS_UPDATE_STATES, type Severity, type StatusUpdateState } from '../../shared/ops.ts';
import { ingestSignal, listAlerts, listMaintenanceWindows } from '../ops/alerts.ts';
import { deleteJob, getJob, jobConnection, listJobs, listRuns, openDecryptedBackup, runBackup, saveJob, validateJob } from '../ops/backups.ts';
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
      openAlerts: alerts,
      activePages: pages,
      myPages: pages.filter((p) => p.currentTargetIds.includes(userOf(req).id)),
      onCall: schedules.map((s) => ({ scheduleId: s.id, scheduleName: s.name, teamName: s.teamName, ...s.onCallNow })),
      backups: { total: jobs.length, failing: jobs.filter((j) => j.lastStatus === 'failed').length },
    });
  }),
);

/* -------------------------------- Monitors -------------------------------- */

opsRouter.get('/monitors', asyncRoute(async (_req, res) => res.json({ monitors: await listMonitors() })));

opsRouter.get(
  '/monitors/:id',
  asyncRoute(async (req, res) => {
    const monitor = await getMonitor(req.params.id);
    if (!monitor) throw notFound('That monitor does not exist.');
    res.json({ monitor, checks: await monitorChecks(monitor.id), days: await monitorDays(monitor.id) });
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
  asyncRoute(async (req, res) => {
    res.json({ alerts: await listAlerts({ status: optionalString(req.query.status, 20) ?? undefined, ticketId: optionalString(req.query.ticketId, 60) ?? undefined }) });
  }),
);

opsRouter.get('/alert-sources', asyncRoute(async (_req, res) => res.json({ sources: await listSources() })));

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

opsRouter.get('/maintenance', asyncRoute(async (_req, res) => res.json({ windows: await listMaintenanceWindows() })));

opsRouter.post(
  '/maintenance',
  requirePermission('monitors.manage'),
  asyncRoute(async (req, res) => {
    const title = requireString(req.body?.title, 'Title', { max: 200 });
    const startsAt = new Date(String(req.body?.startsAt ?? ''));
    const endsAt = new Date(String(req.body?.endsAt ?? ''));
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) throw badRequest('Give a start and an end after it.');
    const monitorIds = Array.isArray(req.body?.monitorIds) ? req.body.monitorIds.map(String).slice(0, 200) : [];
    const id = randomId();
    await db.run(`INSERT INTO maintenance_windows (id, title, starts_at, ends_at, monitor_ids, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
      id,
      title,
      startsAt.toISOString(),
      endsAt.toISOString(),
      JSON.stringify(monitorIds),
      userOf(req).id,
      new Date().toISOString(),
    ]);
    await audit(req, { entityType: 'monitor', entityId: id, action: 'maintenance_scheduled', summary: `Scheduled maintenance "${title}"` });
    res.status(201).json({ windows: await listMaintenanceWindows() });
  }),
);

opsRouter.delete(
  '/maintenance/:id',
  requirePermission('monitors.manage'),
  asyncRoute(async (req, res) => {
    await db.run(`DELETE FROM maintenance_windows WHERE id = ?`, [req.params.id]);
    res.status(204).end();
  }),
);

/* ------------------------------ Alert routing ----------------------------- */

opsRouter.get('/alert-rules', asyncRoute(async (_req, res) => res.json({ rules: await listRules() })));

opsRouter.post(
  '/alert-rules',
  requirePermission('monitors.manage'),
  asyncRoute(async (req, res) => {
    const rule = await saveRule(null, validateRule(req.body ?? {}));
    await audit(req, { entityType: 'alert', entityId: rule.id, action: 'alert_rule_created', summary: `Created routing rule "${rule.name}"` });
    res.status(201).json({ rule });
  }),
);

opsRouter.put(
  '/alert-rules/order',
  requirePermission('monitors.manage'),
  asyncRoute(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 500) : [];
    const rules = await reorderRules(ids);
    await audit(req, { entityType: 'alert', action: 'alert_rules_reordered', summary: `Reordered routing rules: ${rules.map((r) => r.name).join(', ')}` });
    res.json({ rules });
  }),
);

opsRouter.put(
  '/alert-rules/:id',
  requirePermission('monitors.manage'),
  asyncRoute(async (req, res) => {
    if (!(await getRule(req.params.id))) throw notFound('That rule does not exist.');
    const rule = await saveRule(req.params.id, validateRule(req.body ?? {}));
    await audit(req, { entityType: 'alert', entityId: rule.id, action: 'alert_rule_updated', summary: `Updated routing rule "${rule.name}"` });
    res.json({ rule });
  }),
);

opsRouter.delete(
  '/alert-rules/:id',
  requirePermission('monitors.manage'),
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

opsRouter.get('/schedules', asyncRoute(async (_req, res) => res.json({ schedules: await listSchedules() })));

opsRouter.get(
  '/schedules/:id',
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
  requirePermission('oncall.manage'),
  asyncRoute(async (req, res) => {
    const schedule = await saveSchedule(null, scheduleInput(req.body ?? {}));
    await audit(req, { entityType: 'oncall', entityId: schedule.id, action: 'schedule_created', summary: `Created on-call schedule "${schedule.name}"` });
    res.status(201).json({ schedule });
  }),
);

opsRouter.put(
  '/schedules/:id',
  requirePermission('oncall.manage'),
  asyncRoute(async (req, res) => {
    if (!(await getSchedule(req.params.id))) throw notFound('That schedule does not exist.');
    const schedule = await saveSchedule(req.params.id, scheduleInput(req.body ?? {}));
    await audit(req, { entityType: 'oncall', entityId: schedule.id, action: 'schedule_updated', summary: `Updated on-call schedule "${schedule.name}"` });
    res.json({ schedule });
  }),
);

opsRouter.delete(
  '/schedules/:id',
  requirePermission('oncall.manage'),
  asyncRoute(async (req, res) => {
    const schedule = await getSchedule(req.params.id);
    if (!schedule) throw notFound('That schedule does not exist.');
    await db.run(`DELETE FROM oncall_schedules WHERE id = ?`, [schedule.id]);
    await audit(req, { entityType: 'oncall', entityId: schedule.id, action: 'schedule_deleted', summary: `Deleted on-call schedule "${schedule.name}"` });
    res.status(204).end();
  }),
);

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
    if (userId !== user.id && !user.permissions.includes('oncall.manage')) throw badRequest('You can only add yourself as cover.');
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
    if (row.user_id !== user.id && !user.permissions.includes('oncall.manage')) throw badRequest('You can only remove your own cover.');
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

opsRouter.get('/policies', asyncRoute(async (_req, res) => res.json({ policies: await listPolicies() })));

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
    await db.run(`UPDATE teams SET escalation_policy_id = NULL WHERE escalation_policy_id = ?`, [policy.id]);
    await audit(req, { entityType: 'oncall', entityId: policy.id, action: 'policy_deleted', summary: `Deleted escalation policy "${policy.name}"` });
    res.status(204).end();
  }),
);

/** Which policy pages for a team's alerts when the monitor or source does not name one. */
opsRouter.get(
  '/team-policies',
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

opsRouter.get(
  '/pages',
  asyncRoute(async (req, res) => {
    const filter = String(req.query.filter ?? 'active');
    const pages = await listPages({
      status: filter === 'all' ? undefined : 'active',
      ticketId: optionalString(req.query.ticketId, 60) ?? undefined,
      userId: filter === 'mine' ? userOf(req).id : undefined,
    });
    res.json({ pages });
  }),
);

opsRouter.get(
  '/pages/:id',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    if (!page) throw notFound('That page does not exist.');
    res.json({ page });
  }),
);

opsRouter.post(
  '/pages/:id/ack',
  asyncRoute(async (req, res) => {
    const outcome = await acknowledgePage(req.params.id, userOf(req), 'web');
    if (outcome === 'closed') throw badRequest('That page has already been resolved.');
    res.json({ outcome, page: await getPage(req.params.id) });
  }),
);

opsRouter.post(
  '/pages/:id/escalate',
  asyncRoute(async (req, res) => {
    if (!(await escalateNow(req.params.id, userOf(req).name))) throw badRequest('That page is not escalating any more.');
    res.json({ page: await getPage(req.params.id) });
  }),
);

/** Page someone about an existing ticket by hand ("get me the database on-call"). */
opsRouter.post(
  '/tickets/:ticketId/page',
  requirePermission('tickets.update'),
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

opsRouter.get('/status-pages', asyncRoute(async (_req, res) => res.json({ pages: await listStatusPages() })));

opsRouter.get(
  '/status-pages/:id',
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
  requirePermission('statuspages.manage'),
  asyncRoute(async (req, res) => {
    const page = await getStatusPage(req.params.id);
    if (!page) throw notFound('That status page does not exist.');
    const state = String(req.body?.state ?? 'investigating') as StatusUpdateState;
    if (!STATUS_UPDATE_STATES.includes(state)) throw badRequest('Unknown state.');
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

opsRouter.get('/databases', requirePermission('backups.manage', 'monitors.manage'), asyncRoute(async (_req, res) => res.json({ databases: await listJobs() })));

opsRouter.get(
  '/databases/:id',
  requirePermission('backups.manage', 'monitors.manage'),
  asyncRoute(async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) throw notFound('That database does not exist.');
    res.json({ database: job, runs: await listRuns(job.id) });
  }),
);

opsRouter.post(
  '/databases',
  requirePermission('backups.manage'),
  asyncRoute(async (req, res) => {
    const job = await saveJob(null, validateJob(req.body ?? {}, false));
    await audit(req, { entityType: 'backup', entityId: job.id, action: 'database_added', summary: `Added ${job.engine} database "${job.name}" (${job.connectionHint})` });
    res.status(201).json({ database: job });
  }),
);

opsRouter.put(
  '/databases/:id',
  requirePermission('backups.manage'),
  asyncRoute(async (req, res) => {
    const job = await saveJob(req.params.id, validateJob(req.body ?? {}, true));
    await audit(req, { entityType: 'backup', entityId: job.id, action: 'database_updated', summary: `Updated database "${job.name}"` });
    res.json({ database: job });
  }),
);

opsRouter.delete(
  '/databases/:id',
  requirePermission('backups.manage'),
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
  requirePermission('backups.manage', 'monitors.manage'),
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
