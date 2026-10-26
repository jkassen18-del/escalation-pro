import { db, parseJson, placeholders } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/http.ts';
import { notifyUsers } from '../lib/notifications.ts';
import { getSettings } from '../repositories/settings.ts';
import { findTicket, recordEvent } from '../repositories/tickets.ts';
import { loadIntegration } from '../integrations/store.ts';
import { sendPlainEmail } from '../integrations/email.ts';
import { postToDepartmentSlack, postToDepartmentTeams } from '../integrations/channel-post.ts';
import { buildTicketUrl } from '../integrations/dispatcher.ts';
import { getDepartmentSchedule } from '../ops/shifts.ts';
import {
  APPROVAL_FIELD_OPS,
  GATED_STATUSES,
  outcome,
  ruleMatches,
  type ApprovalConditions,
  type ApprovalDecision,
  type ApprovalFieldOp,
  type ApprovalMode,
  type ApprovalRule,
  type ApproverSpec,
  type TicketApproval,
} from '../../shared/approvals.ts';
import { shiftStatus } from '../../shared/shifts.ts';
import type { PublicUser, Ticket } from '../../shared/types.ts';

/** Encoded into the Slack buttons and Teams card actions. */
export const APPROVAL_ACTIONS = { approve: 'approval_approve', reject: 'approval_reject', teams: 'approval_decide' } as const;

/* --------------------------------- Rules --------------------------------- */

type RuleRow = Record<string, string | number | null>;

function mapRule(row: RuleRow): ApprovalRule {
  return {
    id: String(row.id),
    teamId: (row.team_id as string | null) ?? null,
    name: String(row.name),
    enabled: Number(row.enabled) === 1,
    conditions: parseJson<ApprovalConditions>(row.conditions, {}),
    approvers: parseJson<ApproverSpec[]>(row.approvers, []),
    mode: row.mode === 'all' ? 'all' : 'any',
    onReject: row.on_reject === 'keep_open' ? 'keep_open' : 'close',
    position: Number(row.position ?? 0),
  };
}

export async function listRules(teamId?: string | null): Promise<ApprovalRule[]> {
  const rows =
    teamId === undefined
      ? await db.all<RuleRow>(`SELECT * FROM approval_rules ORDER BY position, name`)
      : await db.all<RuleRow>(`SELECT * FROM approval_rules WHERE team_id = ? OR team_id IS NULL ORDER BY position, name`, [teamId]);
  return rows.map(mapRule);
}

export async function findRule(id: string): Promise<ApprovalRule | null> {
  const row = await db.get<RuleRow>(`SELECT * FROM approval_rules WHERE id = ?`, [id]);
  return row ? mapRule(row) : null;
}

const strings = (value: unknown, max = 30) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim().slice(0, 100)).slice(0, max) : [];

function validateApprovers(value: unknown): ApproverSpec[] {
  if (!Array.isArray(value) || value.length === 0) throw badRequest('Choose who approves.');
  const out: ApproverSpec[] = [];
  for (const raw of value.slice(0, 20) as Array<Record<string, unknown>>) {
    if (raw?.kind === 'user' && typeof raw.userId === 'string') out.push({ kind: 'user', userId: raw.userId });
    else if (raw?.kind === 'role' && typeof raw.roleId === 'string') out.push({ kind: 'role', roleId: raw.roleId });
    else if (raw?.kind === 'department_managers' || raw?.kind === 'shift_leader') out.push({ kind: raw.kind });
    else throw badRequest('One of the approvers is not something that can approve.');
  }
  return out;
}

export function validateRule(body: Record<string, unknown>): Omit<ApprovalRule, 'id' | 'position'> {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  if (!name) throw badRequest('Give the rule a name.');
  const raw = (body.conditions ?? {}) as Record<string, unknown>;
  const field = raw.field as Record<string, unknown> | null | undefined;
  const conditions: ApprovalConditions = {
    types: strings(raw.types),
    priorities: strings(raw.priorities),
    tags: strings(raw.tags),
    keywords: strings(raw.keywords),
    templateIds: strings(raw.templateIds),
    field:
      field && typeof field.key === 'string' && field.key.trim()
        ? {
            key: field.key.trim().slice(0, 60),
            op: APPROVAL_FIELD_OPS.includes(field.op as ApprovalFieldOp) ? (field.op as ApprovalFieldOp) : 'eq',
            value: String(field.value ?? '').slice(0, 200),
          }
        : null,
  };
  return {
    teamId: typeof body.teamId === 'string' && body.teamId ? body.teamId : null,
    name,
    enabled: body.enabled !== false,
    conditions,
    approvers: validateApprovers(body.approvers),
    mode: body.mode === 'all' ? 'all' : 'any',
    onReject: body.onReject === 'keep_open' ? 'keep_open' : 'close',
  };
}

export async function saveRule(id: string | null, rule: Omit<ApprovalRule, 'id' | 'position'>): Promise<ApprovalRule> {
  const now = new Date().toISOString();
  const values = [rule.teamId, rule.name, rule.enabled ? 1 : 0, JSON.stringify(rule.conditions), JSON.stringify(rule.approvers), rule.mode, rule.onReject];
  if (id) {
    if (!(await findRule(id))) throw notFound('That rule does not exist.');
    await db.run(
      `UPDATE approval_rules SET team_id = ?, name = ?, enabled = ?, conditions = ?, approvers = ?, mode = ?, on_reject = ?, updated_at = ? WHERE id = ?`,
      [...values, now, id],
    );
  } else {
    id = randomId();
    const last = await db.get<{ n: number | string | null }>(`SELECT MAX(position) AS n FROM approval_rules`);
    await db.run(
      `INSERT INTO approval_rules (id, team_id, name, enabled, conditions, approvers, mode, on_reject, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ...values, Number(last?.n ?? 0) + 1, now, now],
    );
  }
  return (await findRule(id))!;
}

export async function deleteRule(id: string): Promise<void> {
  await db.run(`DELETE FROM approval_rules WHERE id = ?`, [id]);
}

/* ------------------------------- Approvers ------------------------------- */

/** Turns "Finance managers" and "the shift leader" into people, as they stand now. */
export async function resolveApprovers(specs: ApproverSpec[], teamId: string | null): Promise<string[]> {
  const ids = new Set<string>();
  for (const spec of specs) {
    if (spec.kind === 'user') ids.add(spec.userId);
    if (spec.kind === 'role') {
      for (const row of await db.all<{ id: string }>(`SELECT id FROM users WHERE role_id = ? AND status = 'active'`, [spec.roleId])) ids.add(row.id);
    }
    if (spec.kind === 'department_managers' && teamId) {
      for (const row of await db.all<{ user_id: string }>(`SELECT user_id FROM team_members WHERE team_id = ? AND is_lead = 1`, [teamId])) ids.add(row.user_id);
    }
    if (spec.kind === 'shift_leader' && teamId) {
      const schedule = await getDepartmentSchedule(teamId);
      const { current } = shiftStatus(schedule.patterns, schedule.exceptions, schedule.timeZone, Date.now());
      if (current?.leaderId) ids.add(current.leaderId);
    }
  }
  if (!ids.size) return [];
  const active = await db.all<{ id: string }>(`SELECT id FROM users WHERE status = 'active' AND id IN (${placeholders(ids.size)})`, [...ids]);
  return active.map((row) => row.id);
}

/* -------------------------------- Requests -------------------------------- */

type ApprovalRow = Record<string, string | null>;

async function names(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db.all<{ id: string; name: string }>(`SELECT id, name FROM users WHERE id IN (${placeholders(ids.length)})`, ids);
  return new Map(rows.map((row) => [row.id, row.name]));
}

async function mapApprovals(rows: ApprovalRow[]): Promise<TicketApproval[]> {
  const parsed = rows.map((row) => ({ row, approverIds: parseJson<string[]>(row.approver_ids, []) }));
  const people = await names([...new Set(parsed.flatMap(({ row, approverIds }) => [...approverIds, row.requested_by ?? ''].filter(Boolean)))]);
  return parsed.map(({ row, approverIds }) => ({
    id: String(row.id),
    ticketId: String(row.ticket_id),
    ruleId: row.rule_id,
    title: String(row.title),
    note: row.note,
    approverIds,
    approverNames: approverIds.map((id) => people.get(id) ?? 'Former user'),
    mode: (row.mode === 'all' ? 'all' : 'any') as ApprovalMode,
    onReject: row.on_reject === 'keep_open' ? 'keep_open' : 'close',
    status: (row.status ?? 'pending') as TicketApproval['status'],
    requestedById: row.requested_by,
    requestedByName: row.requested_by ? (people.get(row.requested_by) ?? null) : null,
    decisions: parseJson<ApprovalDecision[]>(row.decisions, []),
    createdAt: String(row.created_at),
    decidedAt: row.decided_at,
  }));
}

export async function listApprovals(ticketId: string): Promise<TicketApproval[]> {
  return mapApprovals(await db.all<ApprovalRow>(`SELECT * FROM ticket_approvals WHERE ticket_id = ? ORDER BY created_at`, [ticketId]));
}

export async function findApproval(id: string): Promise<TicketApproval | null> {
  const row = await db.get<ApprovalRow>(`SELECT * FROM ticket_approvals WHERE id = ?`, [id]);
  return row ? (await mapApprovals([row]))[0] : null;
}

/** What is waiting on this person, newest first. */
export async function approvalsWaitingOn(userId: string): Promise<Array<TicketApproval & { reference: string; subject: string; teamName: string | null }>> {
  // The approver list is JSON, so the match is a LIKE on the quoted id, then checked exactly.
  const rows = await db.all<ApprovalRow & { number: number | string; subject: string; team_name: string | null }>(
    `SELECT a.*, t.number, t.subject, tm.name AS team_name FROM ticket_approvals a JOIN tickets t ON t.id = a.ticket_id LEFT JOIN teams tm ON tm.id = t.team_id
     WHERE a.status = 'pending' AND a.approver_ids LIKE ? ORDER BY a.created_at DESC LIMIT 100`,
    [`%"${userId.replace(/[%_"]/g, '')}"%`],
  );
  const settings = await getSettings();
  const mapped = await mapApprovals(rows);
  return mapped
    .map((approval, index) => ({
      ...approval,
      reference: `${settings.ticketPrefix}-${rows[index].number}`,
      subject: rows[index].subject,
      teamName: rows[index].team_name,
    }))
    .filter((approval) => approval.approverIds.includes(userId) && !approval.decisions.some((decision) => decision.userId === userId));
}

export async function pendingApproval(ticketId: string): Promise<TicketApproval | null> {
  const row = await db.get<ApprovalRow>(`SELECT * FROM ticket_approvals WHERE ticket_id = ? AND status = 'pending' ORDER BY created_at LIMIT 1`, [ticketId]);
  return row ? (await mapApprovals([row]))[0] : null;
}

/** Refuses starting or resolving a ticket that is still waiting for sign-off. */
export async function assertNotAwaitingApproval(ticketId: string, nextStatus: string): Promise<void> {
  if (!(GATED_STATUSES as readonly string[]).includes(nextStatus)) return;
  const waiting = await pendingApproval(ticketId);
  if (waiting) {
    throw conflict(`This ticket is waiting for approval (${waiting.title}) from ${waiting.approverNames.join(', ') || 'its approvers'} before work starts.`);
  }
}

interface RequestInput {
  title: string;
  note?: string | null;
  approverIds: string[];
  mode: ApprovalMode;
  onReject: 'close' | 'keep_open';
  ruleId?: string | null;
}

export async function requestApproval(ticket: Ticket, input: RequestInput, requestedBy: PublicUser | null, origin?: string): Promise<TicketApproval> {
  const approverIds = [...new Set(input.approverIds)].filter((id) => id !== requestedBy?.id || input.ruleId);
  if (!approverIds.length) throw badRequest('Nobody could be found to approve this. Choose the approvers, or check the rule.');
  const id = randomId();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO ticket_approvals (id, ticket_id, rule_id, title, note, approver_ids, mode, on_reject, status, requested_by, decisions, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, '[]', ?)`,
    [id, ticket.id, input.ruleId ?? null, input.title.slice(0, 160), input.note ?? null, JSON.stringify(approverIds), input.mode, input.onReject, requestedBy?.id || null, now],
  );
  await recordEvent(ticket.id, requestedBy?.id || null, 'approval_requested', 'approval', null, input.title);
  const approval = (await findApproval(id))!;
  await announceRequest(ticket, approval, origin).catch((error) => console.error('[approvals] announce', error));
  return approval;
}

/** Applies the department's and the organisation's rules to a new ticket. */
export async function applyApprovalRules(ticket: Ticket, answers: Record<string, unknown>, origin?: string): Promise<TicketApproval[]> {
  const rules = (await listRules(ticket.teamId)).filter((rule) => rule.enabled);
  const created: TicketApproval[] = [];
  for (const rule of rules) {
    const subject = { type: ticket.type, priority: ticket.priority, tags: ticket.tags, subject: ticket.subject, description: ticket.description, templateId: ticket.templateId, answers };
    if (!ruleMatches(rule.conditions, subject)) continue;
    const approverIds = await resolveApprovers(rule.approvers, ticket.teamId);
    if (!approverIds.length) {
      console.warn(`[approvals] rule "${rule.name}" matched ${ticket.reference} but resolved to nobody`);
      continue;
    }
    created.push(await requestApproval(ticket, { title: rule.name, approverIds, mode: rule.mode, onReject: rule.onReject, ruleId: rule.id }, null, origin));
  }
  return created;
}

export async function decide(
  approvalId: string,
  user: PublicUser,
  decision: 'approved' | 'rejected',
  options: { comment?: string | null; via: string; origin?: string },
): Promise<{ approval: TicketApproval; ticket: Ticket; changed: boolean }> {
  const approval = await findApproval(approvalId);
  if (!approval) throw notFound('That approval no longer exists.');
  const settings = await getSettings();
  const ticket = await findTicket(approval.ticketId, settings.ticketPrefix);
  if (!ticket) throw notFound('That ticket no longer exists.');
  if (approval.status !== 'pending') return { approval, ticket, changed: false };
  if (!approval.approverIds.includes(user.id)) throw forbidden(`You are not one of the approvers for ${ticket.reference}.`);
  if (approval.decisions.some((existing) => existing.userId === user.id)) return { approval, ticket, changed: false };

  const comment = options.comment?.trim().slice(0, 1000) || null;
  const decisions = [...approval.decisions, { userId: user.id, name: user.name, decision, comment, at: new Date().toISOString(), via: options.via }];
  const status = outcome(approval.mode, approval.approverIds, decisions);
  const now = new Date().toISOString();
  // Compare-and-set on the decisions as read: two approvers clicking at once
  // cannot overwrite each other or settle it twice.
  const written = JSON.stringify(decisions);
  await db.run(`UPDATE ticket_approvals SET decisions = ?, status = ?, decided_at = ? WHERE id = ? AND status = 'pending' AND decisions = ?`, [
    written,
    status,
    status === 'pending' ? null : now,
    approval.id,
    // Always written by JSON.stringify, so the round trip is exact.
    JSON.stringify(approval.decisions),
  ]);
  const after = await db.get<{ decisions: string }>(`SELECT decisions FROM ticket_approvals WHERE id = ?`, [approval.id]);
  if (after?.decisions !== written) return { approval: (await findApproval(approval.id))!, ticket, changed: false };

  await recordEvent(ticket.id, user.id, decision === 'approved' ? 'approval_approved' : 'approval_rejected', 'approval', approval.title, comment);
  await addSystemNote(ticket.id, `${user.name} ${decision} "${approval.title}"${options.via !== 'web' ? ` from ${viaName(options.via)}` : ''}${comment ? `: ${comment}` : '.'}`);

  if (status !== 'pending') {
    const watchers = [approval.requestedById, ticket.requesterId, ticket.assigneeId].filter((id): id is string => Boolean(id) && id !== user.id);
    await notifyUsers(watchers, {
      ticketId: ticket.id,
      type: 'approval',
      title: `${ticket.reference} ${status === 'approved' ? 'approved' : 'rejected'}: ${approval.title}`,
      body: comment ?? ticket.subject,
    });
    if (status === 'rejected' && approval.onReject === 'close') {
      const { applyStatus } = await import('../integrations/slack-actions.ts');
      await applyStatus(ticket.id, 'closed', user.id);
    }
  }
  return { approval: (await findApproval(approval.id))!, ticket: (await findTicket(ticket.id, settings.ticketPrefix))!, changed: true };
}

export async function cancelApproval(approvalId: string, user: PublicUser): Promise<TicketApproval> {
  const approval = await findApproval(approvalId);
  if (!approval) throw notFound('That approval no longer exists.');
  if (approval.status !== 'pending') throw conflict('That approval has already been decided.');
  await db.run(`UPDATE ticket_approvals SET status = 'cancelled', decided_at = ? WHERE id = ?`, [new Date().toISOString(), approval.id]);
  await recordEvent(approval.ticketId, user.id, 'approval_cancelled', 'approval', approval.title, null);
  await addSystemNote(approval.ticketId, `${user.name} withdrew the approval request "${approval.title}".`);
  return (await findApproval(approval.id))!;
}

const viaName = (via: string) => ({ slack: 'Slack', teams: 'Teams', email: 'email' })[via] ?? via;

async function addSystemNote(ticketId: string, body: string): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO ticket_comments (id, ticket_id, author_id, body, body_format, is_internal, is_system, created_at, updated_at) VALUES (?, ?, NULL, ?, 'text', 1, 1, ?, ?)`,
    [randomId(), ticketId, body, now, now],
  );
}

/* ------------------------------ Announcing ------------------------------ */

export function approvalSlackBlocks(ticket: Ticket, approval: TicketApproval, url: string): unknown[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:raised_hand: *Approval needed:* ${approval.title}\n<${url}|${ticket.reference}> ${ticket.subject}${approval.note ? `\n>${approval.note}` : ''}`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${approval.mode === 'all' ? 'Everyone' : 'Any one'} of: ${approval.approverNames.join(', ')}` }],
    },
    {
      type: 'actions',
      elements: [
        { type: 'button', action_id: APPROVAL_ACTIONS.approve, text: { type: 'plain_text', text: 'Approve' }, style: 'primary', value: approval.id },
        {
          type: 'button',
          action_id: APPROVAL_ACTIONS.reject,
          text: { type: 'plain_text', text: 'Reject' },
          style: 'danger',
          value: approval.id,
          confirm: {
            title: { type: 'plain_text', text: 'Reject this?' },
            text: { type: 'mrkdwn', text: approval.onReject === 'close' ? 'The ticket will be closed.' : 'The ticket stays open, marked rejected.' },
            confirm: { type: 'plain_text', text: 'Reject' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
        { type: 'button', text: { type: 'plain_text', text: 'Open ticket' }, url },
      ],
    },
  ];
}

export function approvalCard(ticket: Ticket, approval: TicketApproval, url: string): Record<string, unknown> {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      {
        type: 'Container',
        style: 'warning',
        bleed: true,
        items: [{ type: 'TextBlock', text: `Approval needed: ${approval.title}`, weight: 'Bolder', size: 'Medium', wrap: true }],
      },
      { type: 'TextBlock', text: `[${ticket.reference}](${url}) ${ticket.subject}`, wrap: true },
      ...(approval.note ? [{ type: 'TextBlock', text: approval.note, wrap: true, isSubtle: true }] : []),
      { type: 'TextBlock', text: `${approval.mode === 'all' ? 'Everyone' : 'Any one'} of: ${approval.approverNames.join(', ')}`, wrap: true, isSubtle: true, size: 'Small' },
      { type: 'Input.Text', id: 'comment', placeholder: 'Comment (optional)', isMultiline: true },
    ],
    actions: [
      { type: 'Action.Submit', title: 'Approve', style: 'positive', data: { action: APPROVAL_ACTIONS.teams, approvalId: approval.id, decision: 'approved' } },
      { type: 'Action.Submit', title: 'Reject', style: 'destructive', data: { action: APPROVAL_ACTIONS.teams, approvalId: approval.id, decision: 'rejected' } },
      { type: 'Action.OpenUrl', title: 'Open ticket', url },
    ],
  };
}

async function announceRequest(ticket: Ticket, approval: TicketApproval, origin?: string): Promise<void> {
  const url = await buildTicketUrl(ticket, origin);
  await notifyUsers(approval.approverIds, {
    ticketId: ticket.id,
    type: 'approval',
    title: `Approval needed: ${ticket.reference}`,
    body: `${approval.title} · ${ticket.subject}`,
  });
  const slack = await loadIntegration('slack');
  if (slack.enabled) await postToDepartmentSlack(ticket.teamId, { text: `Approval needed: ${approval.title} (${ticket.reference})`, blocks: approvalSlackBlocks(ticket, approval, url) });
  const teams = await loadIntegration('msteams');
  if (teams.enabled) await postToDepartmentTeams(ticket.teamId, approvalCard(ticket, approval, url));
  const email = await loadIntegration('email');
  if (email.enabled) {
    const people = await db.all<{ email: string | null }>(`SELECT email FROM users WHERE id IN (${placeholders(approval.approverIds.length)})`, approval.approverIds);
    for (const person of people) {
      if (!person.email) continue;
      await sendPlainEmail(email, person.email, {
        subject: `Approval needed: ${ticket.reference} ${approval.title}`,
        text: `${approval.title}\n\n${ticket.reference}: ${ticket.subject}\n${approval.note ? `\n${approval.note}\n` : ''}\nApprove or reject it here: ${url}`,
      });
    }
  }
}
