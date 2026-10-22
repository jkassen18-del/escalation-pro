import { db, parseJson, placeholders } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { notifyUsers } from '../lib/notifications.ts';
import { getSettings } from '../repositories/settings.ts';
import { findTicket, recordEvent, addWatcher } from '../repositories/tickets.ts';
import { findUserById } from '../repositories/users.ts';
import { buildTicketUrl, dispatchAsync } from '../integrations/dispatcher.ts';
import { loadIntegration } from '../integrations/store.ts';
import { sendEmail } from '../integrations/email.ts';
import { TERMINAL_STATUSES, type PublicUser, type Ticket } from '../../shared/types.ts';
import { CALL_CHANNELS, type NotificationAttempt, type NotifyChannel, type Page, type PageStatus, type Severity, type Urgency } from '../../shared/ops.ts';
import { getPolicy, resolveTargets, rulesFor } from './oncall.ts';
import { sendDiscordPage } from '../integrations/discord.ts';
import { loadTelephony, normalisePhone, placeCall, sendSms } from './telephony.ts';
import { sendPush } from './push.ts';
import { hangUpCallsForPage, placeTeamsCall } from './teams-calls.ts';

/**
 * The pager: walks an escalation policy until a person acknowledges.
 *
 * Everything here is driven from what is stored - the level, when it started,
 * and every attempt already made - rather than from timers held in memory.
 * A restart, or a different instance taking over the scheduler lease, picks
 * up exactly where the last one left off and never repeats an attempt.
 */

interface PageRow {
  id: string;
  ticket_id: string;
  policy_id: string | null;
  severity: Severity;
  urgency: Urgency;
  status: PageStatus;
  current_level: number | string;
  cycle: number | string;
  level_started_at: string;
  current_targets: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  reason: string;
  created_at: string;
  updated_at: string;
}

export function urgencyOf(severity: Severity): Urgency {
  return severity === 'sev1' || severity === 'sev2' ? 'high' : 'low';
}

async function addTimelineComment(ticketId: string, body: string): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO ticket_comments (id, ticket_id, author_id, body, body_format, is_internal, is_system, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'text', 1, 1, ?, ?)`,
    [randomId(), ticketId, body, now, now],
  );
}

export async function triggerPage(
  ticketId: string,
  { policyId, severity, reason }: { policyId: string; severity: Severity; reason: string },
): Promise<string | null> {
  const active = await db.get<{ id: string }>(`SELECT id FROM pages WHERE ticket_id = ? AND status = 'triggered'`, [ticketId]);
  if (active) return active.id;
  const policy = await getPolicy(policyId);
  if (!policy || !policy.levels.length) {
    await addTimelineComment(ticketId, `Could not page: escalation policy ${policy ? `"${policy.name}" has no levels` : 'no longer exists'}.`);
    return null;
  }

  const now = new Date().toISOString();
  const targets = await resolveTargets(policy.levels[0].targets);
  const id = randomId();
  await db.run(
    `INSERT INTO pages (id, ticket_id, policy_id, severity, urgency, status, current_level, cycle, level_started_at,
       current_targets, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'triggered', 0, 0, ?, ?, ?, ?, ?)`,
    [id, ticketId, policy.id, severity, urgencyOf(severity), now, JSON.stringify(targets), reason, now, now],
  );
  await recordEvent(ticketId, null, 'paged', 'policy', null, policy.name);
  for (const userId of targets) await addWatcher(ticketId, userId);
  if (!targets.length) await addTimelineComment(ticketId, `Level 1 of "${policy.name}" has nobody on call right now; escalating will move on after ${policy.levels[0].delayMins} min.`);
  await processPage(id);
  return id;
}

async function loadPageRow(id: string): Promise<PageRow | undefined> {
  return db.get<PageRow>(`SELECT * FROM pages WHERE id = ?`, [id]);
}

async function setStatus(id: string, status: PageStatus, extra: { by?: string | null } = {}): Promise<void> {
  const now = new Date().toISOString();
  if (status === 'acknowledged') {
    await db.run(`UPDATE pages SET status = ?, acknowledged_by = ?, acknowledged_at = ?, updated_at = ? WHERE id = ?`, [status, extra.by ?? null, now, now, id]);
  } else {
    await db.run(`UPDATE pages SET status = ?, updated_at = ? WHERE id = ?`, [status, now, id]);
  }
}

export async function resolvePagesForTicket(ticketId: string, why: string): Promise<void> {
  const open = await db.all<{ id: string }>(`SELECT id FROM pages WHERE ticket_id = ? AND status = 'triggered'`, [ticketId]);
  for (const page of open) {
    await setStatus(page.id, 'resolved');
    await addTimelineComment(ticketId, `Paging stopped: ${why}`);
  }
}

export type AckChannel = 'web' | 'sms' | 'voice' | 'slack' | 'msteams' | 'api' | 'discord' | 'claude';

/** Acknowledging stops the escalation and makes the acknowledger the owner if nobody is. */
export async function acknowledgePage(pageId: string, user: Pick<PublicUser, 'id' | 'name'>, via: AckChannel): Promise<'acknowledged' | 'already' | 'closed'> {
  const page = await loadPageRow(pageId);
  if (!page) return 'closed';
  if (page.status === 'acknowledged') return 'already';
  if (page.status !== 'triggered' && page.status !== 'exhausted') return 'closed';

  await setStatus(pageId, 'acknowledged', { by: user.id });
  const now = new Date().toISOString();
  const ticket = await db.get<{ status: string; assignee_id: string | null; first_response_at: string | null }>(
    `SELECT status, assignee_id, first_response_at FROM tickets WHERE id = ?`,
    [page.ticket_id],
  );
  if (ticket) {
    const updates: string[] = ['updated_at = ?'];
    const params: Array<string | null> = [now];
    if (!ticket.assignee_id) {
      updates.push('assignee_id = ?');
      params.push(user.id);
      await recordEvent(page.ticket_id, user.id, 'updated', 'assignee', null, user.id);
    }
    if (ticket.status === 'open') {
      updates.push(`status = 'in_progress'`);
      await recordEvent(page.ticket_id, user.id, 'updated', 'status', 'open', 'in_progress');
    }
    if (!ticket.first_response_at) {
      updates.push('first_response_at = ?');
      params.push(now);
    }
    await db.run(`UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`, [...params, page.ticket_id]);
  }
  await recordEvent(page.ticket_id, user.id, 'acknowledged', 'page', null, via);
  await addTimelineComment(page.ticket_id, `${user.name} acknowledged the page via ${via}. Escalation stopped.`);
  await db.run(
    `UPDATE notification_attempts SET status = 'acknowledged' WHERE id = (
       SELECT id FROM (SELECT id FROM notification_attempts WHERE page_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1) latest)`,
    [pageId, user.id],
  );
  // Stop any Teams call still ringing for this page. Best effort, and not waited on.
  void hangUpCallsForPage(pageId).catch(() => undefined);
  return 'acknowledged';
}

/** Skip the wait: move to the next level now. */
export async function escalateNow(pageId: string, actorName: string): Promise<boolean> {
  const page = await loadPageRow(pageId);
  if (!page || page.status !== 'triggered') return false;
  await addTimelineComment(page.ticket_id, `${actorName} escalated to the next level.`);
  await advanceLevel(page);
  await processPage(pageId);
  return true;
}

async function advanceLevel(page: PageRow): Promise<void> {
  const policy = page.policy_id ? await getPolicy(page.policy_id) : null;
  const now = new Date().toISOString();
  if (!policy || !policy.levels.length) {
    await setStatus(page.id, 'exhausted');
    return;
  }
  let level = Number(page.current_level) + 1;
  let cycle = Number(page.cycle);
  if (level >= policy.levels.length) {
    if (cycle >= policy.repeatCount) {
      await setStatus(page.id, 'exhausted');
      await addTimelineComment(
        page.ticket_id,
        `Nobody acknowledged after ${cycle + 1} pass${cycle ? 'es' : ''} through "${policy.name}". Paging has stopped; the incident is still open.`,
      );
      const settings = await getSettings();
      const ticket = await findTicket(page.ticket_id, settings.ticketPrefix);
      if (ticket) {
        dispatchAsync({
          event: 'ticketEscalated',
          ticket,
          actorName: 'Pager',
          headline: `UNACKNOWLEDGED: ${ticket.reference} exhausted its escalation policy`,
          detail: 'Every level was paged and nobody acknowledged. Someone needs to pick this up.',
          ticketUrl: await buildTicketUrl(ticket),
        });
      }
      return;
    }
    level = 0;
    cycle += 1;
  }
  const targets = await resolveTargets(policy.levels[level].targets);
  await db.run(`UPDATE pages SET current_level = ?, cycle = ?, level_started_at = ?, current_targets = ?, updated_at = ? WHERE id = ?`, [
    level,
    cycle,
    now,
    JSON.stringify(targets),
    now,
    page.id,
  ]);
  for (const userId of targets) await addWatcher(page.ticket_id, userId);
  await recordEvent(page.ticket_id, null, 'escalated', 'pageLevel', String(Number(page.current_level) + 1), String(level + 1));
}

function pageMessage(ticket: Ticket, severity: Severity): string {
  return `[${severity.toUpperCase()}] ${ticket.reference}: ${ticket.subject.replace(/^\[SEV\d\]\s*/, '')}`;
}

async function attemptExists(pageId: string, cycle: number, level: number, userId: string, channel: NotifyChannel, seq: number): Promise<boolean> {
  const row = await db.get<{ id: string }>(
    `SELECT id FROM notification_attempts WHERE page_id = ? AND cycle = ? AND level = ? AND user_id = ? AND channel = ? AND seq = ?`,
    [pageId, cycle, level, userId, channel, seq],
  );
  return Boolean(row);
}

async function recordAttempt(input: {
  id?: string;
  pageId: string | null;
  userId: string;
  channel: NotifyChannel;
  level: number;
  cycle: number;
  seq: number;
  result: { status: NotificationAttempt['status']; provider: string; detail: string; externalId?: string };
}): Promise<string> {
  const id = input.id ?? randomId();
  await db.run(
    `INSERT INTO notification_attempts (id, page_id, user_id, channel, provider, status, level, cycle, seq, external_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.pageId,
      input.userId,
      input.channel,
      input.result.provider,
      input.result.status,
      input.level,
      input.cycle,
      input.seq,
      input.result.externalId ?? null,
      input.result.detail.slice(0, 1000),
      new Date().toISOString(),
    ],
  );
  return id;
}

/** Delivers one notification. Returns what happened; never throws. */
async function deliver(
  channel: NotifyChannel,
  user: PublicUser,
  ticket: Ticket | null,
  message: string,
  attemptId: string,
  options: { postToChat?: boolean; pageId?: string | null } = {},
): Promise<{ status: NotificationAttempt['status']; provider: string; detail: string; externalId?: string }> {
  const { postToChat = true } = options;
  try {
    const ticketUrl = ticket ? await buildTicketUrl(ticket) : '';
    switch (channel) {
      case 'in_app':
        await notifyUsers([user.id], { ticketId: ticket?.id ?? null, type: 'page', title: `You are being paged: ${message}`, body: 'Acknowledge from the incident or the On-call page.' });
        return { status: 'sent', provider: 'in_app', detail: 'Shown in the notification bell' };
      case 'email': {
        const record = await loadIntegration('email');
        if (!record.enabled) return { status: 'skipped', provider: 'email', detail: 'Email is not set up under Integrations' };
        if (!ticket) {
          return { status: 'skipped', provider: 'email', detail: 'Test pages are not emailed; use the email integration\'s own test' };
        }
        const result = await sendEmail(
          record,
          { event: 'ticketEscalated', ticket, actorName: 'Pager', headline: `You are being paged (${ticket.severity?.toUpperCase() ?? 'incident'})`, detail: 'Open the incident and acknowledge to stop the escalation.', ticketUrl },
          [user.email],
          { direct: true },
        );
        return result.ok ? { status: 'sent', provider: 'smtp', detail: `Emailed ${user.email}` } : { status: 'failed', provider: 'smtp', detail: result.error ?? 'failed' };
      }
      case 'sms':
        return await sendSms(normalisePhone(user.phone), `${message}\nReply ACK to acknowledge. ${ticketUrl}`.trim());
      case 'voice':
        return await placeCall(normalisePhone(user.phone), `InfraTicket page. ${message}`, attemptId);
      case 'teams_call':
        return await placeTeamsCall(user, attemptId);
      case 'push':
        return await sendPush(user.id, {
          title: ticket ? `Paged: ${ticket.reference}` : 'InfraTicket test',
          body: message,
          pageId: options.pageId ?? null,
          ticketId: ticket?.id ?? null,
          url: ticket ? `/tickets/${ticket.id}` : '/profile',
        });
      case 'discord':
        return await sendDiscordPage(user.id, {
          pageId: options.pageId ?? null,
          title: ticket ? `Paged: ${ticket.reference}` : 'InfraTicket test page',
          body: message,
          ticketUrl,
        });
      case 'chat': {
        if (!ticket) return { status: 'skipped', provider: 'chat', detail: 'Test pages are not posted to channels' };
        if (postToChat) {
          dispatchAsync({ event: 'ticketEscalated', ticket, actorName: 'Pager', headline: `Paging ${user.name}: ${ticket.reference}`, detail: message, ticketUrl });
        }
        return { status: 'sent', provider: 'slack/teams', detail: 'Posted to the ticket\'s Slack / Teams thread where configured' };
      }
    }
  } catch (error) {
    return { status: 'failed', provider: channel, detail: (error as Error).message };
  }
}

export async function processPage(pageId: string): Promise<void> {
  const page = await loadPageRow(pageId);
  if (!page || page.status !== 'triggered') return;

  const settings = await getSettings();
  const ticket = await findTicket(page.ticket_id, settings.ticketPrefix);
  if (!ticket || TERMINAL_STATUSES.includes(ticket.status)) {
    await setStatus(page.id, 'resolved');
    return;
  }

  const policy = page.policy_id ? await getPolicy(page.policy_id) : null;
  const level = policy?.levels[Number(page.current_level)];
  if (!policy || !level) {
    await setStatus(page.id, 'exhausted');
    return;
  }

  const now = Date.now();
  const levelStart = new Date(page.level_started_at).getTime();
  if (now - levelStart >= level.delayMins * 60_000) {
    await advanceLevel(page);
    // The next level starts right away.
    return processPage(pageId);
  }

  const telephony = await loadTelephony();
  const targets = parseJson<string[]>(page.current_targets, []);
  const message = pageMessage(ticket, page.severity);
  const cycle = Number(page.cycle);
  const levelIndex = Number(page.current_level);
  let chatPosted = false;

  for (const userId of targets) {
    const user = await findUserById(userId);
    if (!user || user.status !== 'active') continue;
    const { rules } = await rulesFor(userId);
    for (const rule of rules.filter((r) => r.urgency === page.urgency)) {
      const isCall = CALL_CHANNELS.includes(rule.channel);
      const repeats = isCall ? telephony.voiceMaxCalls : 1;
      for (let seq = 0; seq < repeats; seq += 1) {
        const dueAt = levelStart + (rule.delayMins + seq * (isCall ? telephony.voiceRepeatMins : 0)) * 60_000;
        if (dueAt > now) break;
        if (await attemptExists(page.id, cycle, levelIndex, userId, rule.channel, seq)) continue;
        // One page re-checks before each call: an acknowledgement may have landed mid-loop.
        const fresh = await loadPageRow(page.id);
        if (!fresh || fresh.status !== 'triggered') return;
        const attemptId = randomId();
        const result = await deliver(rule.channel, user, ticket, message, attemptId, { postToChat: !chatPosted, pageId: page.id });
        if (rule.channel === 'chat') chatPosted = true;
        await recordAttempt({ id: attemptId, pageId: page.id, userId, channel: rule.channel, level: levelIndex, cycle, seq, result });
        // Only the earliest missed call is placed, not a burst of catch-up calls.
        break;
      }
    }
  }
}

/** One pass over every page still escalating. Called by the ops runner. */
export async function pagerTick(): Promise<number> {
  const rows = await db.all<{ id: string }>(`SELECT id FROM pages WHERE status = 'triggered' ORDER BY created_at LIMIT 200`);
  for (const row of rows) {
    try {
      await processPage(row.id);
    } catch (error) {
      console.error(`[pager] page ${row.id} failed`, error);
    }
  }
  return rows.length;
}

/** "Send a test page to me": every channel in the person's high-urgency rules, now. */
export async function sendTestPage(user: PublicUser): Promise<NotificationAttempt[]> {
  const { rules } = await rulesFor(user.id);
  const channels = Array.from(new Set(rules.filter((r) => r.urgency === 'high').map((r) => r.channel)));
  const ids: string[] = [];
  for (const channel of channels) {
    const attemptId = randomId();
    const result = await deliver(channel, user, null, 'Test page from InfraTicket. No action needed.', attemptId);
    ids.push(await recordAttempt({ id: attemptId, pageId: null, userId: user.id, channel, level: 0, cycle: 0, seq: 0, result }));
  }
  return listAttempts({ ids });
}

/* ---------------------------------- Reads --------------------------------- */

export async function listAttempts(filter: { pageId?: string; ids?: string[] }): Promise<NotificationAttempt[]> {
  const where = filter.pageId ? `a.page_id = ?` : `a.id IN (${placeholders(filter.ids?.length || 1)})`;
  const params = filter.pageId ? [filter.pageId] : filter.ids?.length ? filter.ids : [''];
  const rows = await db.all<Record<string, string | number | null>>(
    `SELECT a.*, u.name AS user_name FROM notification_attempts a LEFT JOIN users u ON u.id = a.user_id WHERE ${where} ORDER BY a.created_at`,
    params,
  );
  return rows.map((row) => ({
    id: String(row.id),
    pageId: (row.page_id as string | null) ?? null,
    userId: String(row.user_id),
    userName: (row.user_name as string | null) ?? null,
    channel: row.channel as NotifyChannel,
    provider: String(row.provider),
    status: row.status as NotificationAttempt['status'],
    level: Number(row.level),
    cycle: Number(row.cycle),
    seq: Number(row.seq),
    detail: (row.detail as string | null) ?? null,
    createdAt: String(row.created_at),
  }));
}

export async function listPages(
  filter: { id?: string; status?: 'active' | PageStatus; ticketId?: string; userId?: string; limit?: number } = {},
): Promise<Page[]> {
  const settings = await getSettings();
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (filter.status === 'active') conditions.push(`p.status = 'triggered'`);
  else if (filter.status) {
    conditions.push(`p.status = ?`);
    params.push(filter.status);
  }
  if (filter.ticketId) {
    conditions.push(`p.ticket_id = ?`);
    params.push(filter.ticketId);
  }
  if (filter.id) {
    conditions.push(`p.id = ?`);
    params.push(filter.id);
  }
  const rows = await db.all<PageRow & { ticket_number: number | null; ticket_subject: string | null; policy_name: string | null; ack_name: string | null }>(
    `SELECT p.*, t.number AS ticket_number, t.subject AS ticket_subject, ep.name AS policy_name, u.name AS ack_name
     FROM pages p
     LEFT JOIN tickets t ON t.id = p.ticket_id
     LEFT JOIN escalation_policies ep ON ep.id = p.policy_id
     LEFT JOIN users u ON u.id = p.acknowledged_by
     ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY p.created_at DESC LIMIT ?`,
    [...params, filter.limit ?? 100],
  );
  const pages = rows.map((row) => ({
    id: row.id,
    ticketId: row.ticket_id,
    ticketReference: row.ticket_number ? `${settings.ticketPrefix}-${row.ticket_number}` : null,
    ticketSubject: row.ticket_subject,
    severity: row.severity,
    urgency: row.urgency,
    policyId: row.policy_id,
    policyName: row.policy_name,
    status: row.status,
    currentLevel: Number(row.current_level),
    cycle: Number(row.cycle),
    levelStartedAt: row.level_started_at,
    currentTargetIds: parseJson<string[]>(row.current_targets, []),
    acknowledgedById: row.acknowledged_by,
    acknowledgedByName: row.ack_name,
    acknowledgedAt: row.acknowledged_at,
    reason: row.reason,
    createdAt: row.created_at,
  }));
  return filter.userId ? pages.filter((page) => page.currentTargetIds.includes(filter.userId!)) : pages;
}

export async function getPage(id: string): Promise<Page | null> {
  const [page] = await listPages({ id });
  if (!page) return null;
  return { ...page, attempts: await listAttempts({ pageId: id }), policy: page.policyId ? await getPolicy(page.policyId) : null };
}

/** The page an SMS "ACK" from this phone number refers to: the latest one that reached them. */
export async function pageForPhone(phone: string): Promise<{ pageId: string; user: PublicUser } | null> {
  const users = await db.all<{ id: string; phone: string | null }>(`SELECT id, phone FROM users WHERE status = 'active' AND phone IS NOT NULL`);
  const match = users.find((u) => normalisePhone(u.phone) === phone);
  if (!match) return null;
  const row = await db.get<{ page_id: string }>(
    `SELECT a.page_id FROM notification_attempts a JOIN pages p ON p.id = a.page_id
     WHERE a.user_id = ? AND p.status IN ('triggered', 'exhausted') ORDER BY a.created_at DESC LIMIT 1`,
    [match.id],
  );
  const user = await findUserById(match.id);
  return row && user ? { pageId: row.page_id, user } : null;
}

export async function attemptContext(attemptId: string): Promise<{ pageId: string; user: PublicUser; ticket: Ticket | null } | null> {
  const row = await db.get<{ page_id: string | null; user_id: string; ticket_id: string | null }>(
    `SELECT a.page_id, a.user_id, p.ticket_id FROM notification_attempts a LEFT JOIN pages p ON p.id = a.page_id WHERE a.id = ?`,
    [attemptId],
  );
  if (!row?.page_id) return null;
  const user = await findUserById(row.user_id);
  if (!user) return null;
  const settings = await getSettings();
  return { pageId: row.page_id, user, ticket: row.ticket_id ? await findTicket(row.ticket_id, settings.ticketPrefix) : null };
}

export async function markAttemptAnswered(attemptId: string): Promise<void> {
  await db.run(`UPDATE notification_attempts SET status = 'answered' WHERE id = ? AND status = 'sent'`, [attemptId]);
}
