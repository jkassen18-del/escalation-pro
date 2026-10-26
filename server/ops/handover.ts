import { db, parseJson } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { getSettings } from '../repositories/settings.ts';
import { referenceOf } from '../repositories/tickets.ts';
import { loadIntegration } from '../integrations/store.ts';
import { sendPlainEmail } from '../integrations/email.ts';
import { postToDepartmentSlack, postToDepartmentTeams } from '../integrations/channel-post.ts';
import { appBaseUrl } from '../integrations/slack-install.ts';
import { departmentShifts, getDepartmentSchedule, type StaffedShift } from './shifts.ts';

/**
 * The shift handover: at a department's shift change, what the incoming
 * shift needs to know - what is open, what is paging, and what happened on
 * the shift that is ending - posted to the department's Teams and Slack
 * channels and emailed to the incoming team leader.
 */

export interface HandoverTicket {
  id: string;
  reference: string;
  subject: string;
  priority: string;
  status: string;
  assignee: string | null;
  breached: boolean;
  url: string;
}

export interface HandoverReport {
  teamId: string;
  teamName: string;
  generatedAt: string;
  since: string;
  outgoing: StaffedShift | null;
  incoming: StaffedShift | null;
  open: { total: number; urgent: number; high: number; unassigned: number; breached: number; top: HandoverTicket[] };
  paging: Array<{ reference: string; subject: string; startedAt: string; acknowledged: boolean; url: string }>;
  changes: { created: number; resolved: number; escalated: number; createdTop: HandoverTicket[] };
  monitorsDown: Array<{ name: string; since: string | null }>;
}

const PRIORITY_ORDER = `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;

interface TicketRow {
  id: string;
  number: number | string;
  subject: string;
  priority: string;
  status: string;
  due_at: string | null;
  assignee_name: string | null;
}

/** Builds the report for a department at `at`, covering what happened since `since`. */
export async function buildHandover(teamId: string, at = Date.now(), since?: number): Promise<HandoverReport> {
  const settings = await getSettings();
  const team = await db.get<{ name: string }>(`SELECT name FROM teams WHERE id = ?`, [teamId]);
  const base = await appBaseUrl().catch(() => '');
  const now = new Date(at).toISOString();

  // The shift ending and the one starting, by the department's schedule.
  const shifts = await departmentShifts(teamId, at - 2 * 86_400_000, at + 2 * 86_400_000);
  const incoming = shifts.find((shift) => Date.parse(shift.startsAt) <= at + 60 * 60_000 && Date.parse(shift.endsAt) > at) ?? shifts.find((shift) => Date.parse(shift.startsAt) > at) ?? null;
  const outgoing = [...shifts].reverse().find((shift) => shift !== incoming && Date.parse(shift.startsAt) < (incoming ? Date.parse(incoming.startsAt) : at)) ?? null;
  const from = new Date(since ?? (outgoing ? Date.parse(outgoing.startsAt) : at - 12 * 3_600_000)).toISOString();

  const toTicket = (row: TicketRow): HandoverTicket => ({
    id: row.id,
    reference: referenceOf(settings.ticketPrefix, Number(row.number)),
    subject: row.subject,
    priority: row.priority,
    status: row.status,
    assignee: row.assignee_name,
    breached: Boolean(row.due_at && row.due_at < now),
    url: `${base}/tickets/${row.id}`,
  });
  const select = `SELECT t.id, t.number, t.subject, t.priority, t.status, t.due_at, u.name AS assignee_name FROM tickets t LEFT JOIN users u ON u.id = t.assignee_id`;

  const open = await db.all<TicketRow>(`${select} WHERE t.team_id = ? AND t.status IN ('open', 'in_progress', 'pending') ORDER BY ${PRIORITY_ORDER}, t.created_at`, [teamId]);
  const created = await db.all<TicketRow>(`${select} WHERE t.team_id = ? AND t.created_at >= ? ORDER BY ${PRIORITY_ORDER}, t.created_at DESC`, [teamId, from]);
  const resolved = await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM tickets WHERE team_id = ? AND resolved_at >= ?`, [teamId, from]);
  const escalated = await db.get<{ n: number | string }>(
    `SELECT COUNT(DISTINCT e.ticket_id) AS n FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id WHERE t.team_id = ? AND e.action = 'escalated' AND e.created_at >= ?`,
    [teamId, from],
  );
  const pages = await db.all<{ number: number | string; subject: string; ticket_id: string; created_at: string; status: string }>(
    `SELECT t.number, t.subject, p.ticket_id, p.created_at, p.status FROM pages p JOIN tickets t ON t.id = p.ticket_id
     WHERE t.team_id = ? AND (p.status = 'triggered' OR (p.status = 'acknowledged' AND t.status NOT IN ('resolved', 'closed')))
     ORDER BY p.created_at`,
    [teamId],
  );
  const monitors = await db.all<{ name: string; last_change_at: string | null }>(`SELECT name, last_change_at FROM monitors WHERE team_id = ? AND enabled = 1 AND state = 'down' ORDER BY name`, [teamId]);

  const openTickets = open.map(toTicket);
  // The tickets worth reading out: urgent and high first, then anything past its SLA.
  const top = [...openTickets.filter((ticket) => ticket.priority === 'urgent' || ticket.priority === 'high'), ...openTickets.filter((ticket) => ticket.breached && ticket.priority !== 'urgent' && ticket.priority !== 'high')].slice(0, 8);

  return {
    teamId,
    teamName: team?.name ?? 'Department',
    generatedAt: now,
    since: from,
    outgoing,
    incoming,
    open: {
      total: openTickets.length,
      urgent: openTickets.filter((ticket) => ticket.priority === 'urgent').length,
      high: openTickets.filter((ticket) => ticket.priority === 'high').length,
      unassigned: open.filter((row) => !row.assignee_name).length,
      breached: openTickets.filter((ticket) => ticket.breached).length,
      top,
    },
    paging: pages.map((page) => ({
      reference: referenceOf(settings.ticketPrefix, Number(page.number)),
      subject: page.subject,
      startedAt: page.created_at,
      acknowledged: page.status === 'acknowledged',
      url: `${base}/tickets/${page.ticket_id}`,
    })),
    changes: { created: created.length, resolved: Number(resolved?.n ?? 0), escalated: Number(escalated?.n ?? 0), createdTop: created.slice(0, 5).map(toTicket) },
    monitorsDown: monitors.map((monitor) => ({ name: monitor.name, since: monitor.last_change_at })),
  };
}

/* -------------------------------- Rendering -------------------------------- */

function fmt(iso: string | undefined, timeZone: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function headline(report: HandoverReport, timeZone: string): string {
  const to = report.incoming ? `${report.incoming.name} (${fmt(report.incoming.startsAt, timeZone)})` : 'the next shift';
  return `Shift handover: ${report.teamName} → ${to}`;
}

function leaders(report: HandoverReport): string {
  const out = report.outgoing?.leader?.name;
  const inn = report.incoming?.leader?.name;
  if (out && inn) return `${out} hands over to ${inn}`;
  if (inn) return `Incoming team leader: ${inn}`;
  return out ? `Outgoing team leader: ${out}` : 'No team leader set';
}

const line = (ticket: HandoverTicket) =>
  `${ticket.reference} · ${ticket.priority}${ticket.breached ? ' · SLA breached' : ''} · ${ticket.subject}${ticket.assignee ? ` (${ticket.assignee})` : ' (unassigned)'}`;

export function handoverText(report: HandoverReport, timeZone: string): string {
  const parts = [
    headline(report, timeZone),
    leaders(report),
    '',
    `Open: ${report.open.total} (${report.open.urgent} urgent, ${report.open.high} high, ${report.open.unassigned} unassigned, ${report.open.breached} past SLA)`,
    ...report.open.top.map((ticket) => `  • ${line(ticket)}`),
    '',
    report.paging.length ? `Paging now: ${report.paging.map((page) => `${page.reference}${page.acknowledged ? ' (acknowledged)' : ''}`).join(', ')}` : 'Nothing is paging.',
    report.monitorsDown.length ? `Monitors down: ${report.monitorsDown.map((monitor) => monitor.name).join(', ')}` : 'All monitors up.',
    '',
    `This shift: ${report.changes.created} raised, ${report.changes.resolved} resolved, ${report.changes.escalated} escalated.`,
    ...report.changes.createdTop.map((ticket) => `  • New: ${line(ticket)}`),
  ];
  return parts.join('\n');
}

export function handoverCard(report: HandoverReport, timeZone: string): Record<string, unknown> {
  const facts = [
    { title: 'Open', value: `${report.open.total} (${report.open.urgent} urgent, ${report.open.high} high)` },
    { title: 'Unassigned', value: String(report.open.unassigned) },
    { title: 'Past SLA', value: String(report.open.breached) },
    { title: 'Paging', value: report.paging.length ? report.paging.map((page) => page.reference).join(', ') : 'Nothing' },
    { title: 'Monitors down', value: report.monitorsDown.length ? report.monitorsDown.map((monitor) => monitor.name).join(', ') : 'None' },
    { title: 'This shift', value: `${report.changes.created} raised · ${report.changes.resolved} resolved · ${report.changes.escalated} escalated` },
  ];
  const urgent = report.open.top.length || report.paging.length;
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      {
        type: 'Container',
        style: urgent ? 'warning' : 'accent',
        bleed: true,
        items: [
          { type: 'TextBlock', text: headline(report, timeZone), weight: 'Bolder', size: 'Medium', wrap: true },
          { type: 'TextBlock', text: leaders(report), spacing: 'None', wrap: true },
        ],
      },
      { type: 'FactSet', facts },
      ...(report.open.top.length
        ? [
            { type: 'TextBlock', text: 'Needs attention', weight: 'Bolder', spacing: 'Medium' },
            ...report.open.top.map((ticket) => ({ type: 'TextBlock', text: `[${ticket.reference}](${ticket.url}) ${line(ticket).slice(ticket.reference.length + 3)}`, wrap: true, spacing: 'Small' })),
          ]
        : []),
    ],
  };
}

export function handoverSlackBlocks(report: HandoverReport, timeZone: string): unknown[] {
  const tickets = report.open.top.map((ticket) => `• <${ticket.url}|${ticket.reference}> ${line(ticket).slice(ticket.reference.length + 3)}`).join('\n');
  return [
    { type: 'header', text: { type: 'plain_text', text: headline(report, timeZone).slice(0, 150) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: leaders(report) }] },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Open*\n${report.open.total} (${report.open.urgent} urgent, ${report.open.high} high)` },
        { type: 'mrkdwn', text: `*Unassigned / past SLA*\n${report.open.unassigned} / ${report.open.breached}` },
        { type: 'mrkdwn', text: `*Paging*\n${report.paging.length ? report.paging.map((page) => `<${page.url}|${page.reference}>`).join(', ') : 'Nothing'}` },
        { type: 'mrkdwn', text: `*Monitors down*\n${report.monitorsDown.length ? report.monitorsDown.map((monitor) => monitor.name).join(', ') : 'None'}` },
      ],
    },
    ...(tickets ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Needs attention*\n${tickets}`.slice(0, 2900) } }] : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `This shift: ${report.changes.created} raised · ${report.changes.resolved} resolved · ${report.changes.escalated} escalated` }] },
  ];
}

/* -------------------------------- Delivery -------------------------------- */

export interface HandoverDelivery {
  channel: 'msteams' | 'slack' | 'email';
  ok: boolean;
  detail: string;
}

export async function sendHandover(teamId: string, options: { at?: number; shiftKey?: string; since?: number } = {}) {
  const schedule = await getDepartmentSchedule(teamId);
  const report = await buildHandover(teamId, options.at, options.since);
  const channels = schedule.handover.channels?.length ? schedule.handover.channels : (['msteams', 'slack', 'email'] as const);
  const deliveries: HandoverDelivery[] = [];
  const text = handoverText(report, schedule.timeZone);

  if (channels.includes('msteams')) {
    const result = await postToDepartmentTeams(teamId, handoverCard(report, schedule.timeZone));
    deliveries.push({ channel: 'msteams', ok: result.ok, detail: result.error ?? 'Posted to the Teams channel' });
  }
  if (channels.includes('slack')) {
    const result = await postToDepartmentSlack(teamId, { text: text.split('\n')[0], blocks: handoverSlackBlocks(report, schedule.timeZone) });
    deliveries.push({ channel: 'slack', ok: result.ok, detail: result.error ?? 'Posted to the Slack channel' });
  }
  if (channels.includes('email') && report.incoming?.leader?.email) {
    const result = await sendPlainEmail(await loadIntegration('email'), report.incoming.leader.email, { subject: text.split('\n')[0], text });
    deliveries.push({ channel: 'email', ok: result.ok, detail: result.error ?? `Emailed ${report.incoming.leader.name}` });
  }

  await db.run(`INSERT INTO handover_reports (id, team_id, shift_key, report, deliveries, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
    randomId(),
    teamId,
    options.shiftKey ?? `manual:${report.generatedAt}`,
    JSON.stringify(report),
    JSON.stringify(deliveries),
    report.generatedAt,
  ]);
  return { report, deliveries };
}

export async function listHandovers(teamId: string, limit = 20) {
  const rows = await db.all<{ id: string; shift_key: string; report: string; deliveries: string; created_at: string }>(
    `SELECT id, shift_key, report, deliveries, created_at FROM handover_reports WHERE team_id = ? ORDER BY created_at DESC LIMIT ?`,
    [teamId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    automatic: !row.shift_key.startsWith('manual:'),
    createdAt: row.created_at,
    report: parseJson<HandoverReport | null>(row.report, null),
    deliveries: parseJson<HandoverDelivery[]>(row.deliveries, []),
  }));
}

/**
 * Called by the ops runner every minute: sends each department's handover
 * once per shift change, `leadMins` before the incoming shift starts.
 */
export async function handoverTick(now = Date.now()): Promise<number> {
  const teams = await db.all<{ team_id: string; handover: string }>(`SELECT team_id, handover FROM dept_shift_settings`);
  let sent = 0;
  for (const row of teams) {
    const settings = parseJson<{ enabled?: boolean; leadMins?: number }>(row.handover, {});
    if (!settings.enabled) continue;
    const lead = Math.min(120, Math.max(0, Number(settings.leadMins ?? 0))) * 60_000;
    const shifts = await departmentShifts(row.team_id, now - 10 * 60_000, now + lead + 10 * 60_000);
    for (const shift of shifts) {
      const due = Date.parse(shift.startsAt) - lead;
      // Due in the last ten minutes: a runner that was briefly down still sends it, but never a stale one.
      if (due > now || now - due > 10 * 60_000) continue;
      const shiftKey = `${shift.patternId}:${shift.startsAt}`;
      const done = await db.get(`SELECT id FROM handover_reports WHERE team_id = ? AND shift_key = ?`, [row.team_id, shiftKey]);
      if (done) continue;
      try {
        await sendHandover(row.team_id, { at: Date.parse(shift.startsAt), shiftKey });
        sent += 1;
      } catch (error) {
        console.error(`[handover] ${row.team_id}`, error);
      }
    }
  }
  return sent;
}
