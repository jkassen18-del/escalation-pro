/**
 * Seeds a demo dataset so a fresh checkout has something to look at.
 * Safe to re-run: it does nothing when users already exist.
 *
 *   npm run seed
 */
import { db, initDatabase } from './index.ts';
import { createUser, countUsers } from '../repositories/users.ts';
import { createTeam, listTeams, pickAssignee } from '../repositories/teams.ts';
import { updateSettings } from '../repositories/settings.ts';
import { addWatcher, dueDateFrom, insertTicket, recordEvent, slaMultiplier } from '../repositories/tickets.ts';
import { randomId } from '../lib/crypto.ts';
import { ALL_PERMISSIONS } from '../permissions.ts';
import type { TicketPriority, TicketStatus, TicketType } from '../../shared/types.ts';

const DEMO_PASSWORD = process.env.SEED_PASSWORD || 'ChangeMe123!';

const TEAMS = [
  { key: 'SUP', name: 'Support', description: 'First-line customer and internal support.', color: '#4d6b8a', autoAssign: 'round_robin' as const, slaResponseMins: 120, slaResolveMins: 1440 },
  { key: 'OPS', name: 'Operations', description: 'Incidents and service disruptions.', color: '#b54708', autoAssign: 'least_busy' as const, slaResponseMins: 30, slaResolveMins: 480 },
  { key: 'ENG', name: 'Engineering', description: 'Defects and technical escalations.', color: '#6b5c8a', autoAssign: 'none' as const, slaResponseMins: 240, slaResolveMins: 4320 },
  { key: 'FIN', name: 'Billing', description: 'Invoicing, refunds, and account queries.', color: '#6b7f5c', autoAssign: 'round_robin' as const, slaResponseMins: 480, slaResolveMins: 2880 },
];

const PEOPLE = [
  { name: 'Avery Whitlock', email: 'avery@example.com', role: 'admin' as const, jobTitle: 'Head of Service Delivery', teams: ['SUP', 'OPS', 'ENG', 'FIN'] },
  { name: 'Dana Reyes', email: 'dana@example.com', role: 'manager' as const, jobTitle: 'Support Manager', teams: ['SUP', 'FIN'] },
  { name: 'Marcus Idowu', email: 'marcus@example.com', role: 'agent' as const, jobTitle: 'Operations Engineer', teams: ['OPS'] },
  { name: 'Priya Raman', email: 'priya@example.com', role: 'agent' as const, jobTitle: 'Support Specialist', teams: ['SUP'] },
  { name: 'Tomas Lindqvist', email: 'tomas@example.com', role: 'agent' as const, jobTitle: 'Platform Engineer', teams: ['ENG', 'OPS'] },
  { name: 'Nadia Karim', email: 'nadia@example.com', role: 'agent' as const, jobTitle: 'Billing Analyst', teams: ['FIN'] },
  { name: 'Joel Bennett', email: 'joel@example.com', role: 'viewer' as const, jobTitle: 'Account Director', teams: ['SUP'] },
];

const TICKETS: Array<{
  subject: string;
  description: string;
  team: string;
  priority: TicketPriority;
  type: TicketType;
  status: TicketStatus;
  tags: string[];
  ageHours: number;
}> = [
  { subject: 'Checkout returns 502 for EU customers', description: 'Customers in the EU region see a 502 at the payment step. Started around 09:40 UTC. Affects roughly 12% of checkout attempts.', team: 'OPS', priority: 'urgent', type: 'incident', status: 'in_progress', tags: ['payments', 'eu'], ageHours: 3 },
  { subject: 'Bulk invoice export times out past 5,000 rows', description: 'The finance team cannot export the quarterly ledger. The request hangs and eventually returns a gateway timeout.', team: 'FIN', priority: 'high', type: 'problem', status: 'open', tags: ['export', 'reporting'], ageHours: 26 },
  { subject: 'SSO login loop after Okta certificate rotation', description: 'Following the certificate rotation on Tuesday, users are bounced between Okta and the app without ever landing on the dashboard.', team: 'ENG', priority: 'urgent', type: 'escalation', status: 'in_progress', tags: ['sso', 'auth'], ageHours: 8 },
  { subject: 'Customer requests data export under GDPR', description: 'Formal subject access request received. We have 30 days to respond with a complete export.', team: 'SUP', priority: 'normal', type: 'request', status: 'open', tags: ['gdpr', 'compliance'], ageHours: 50 },
  { subject: 'Mobile app crashes on Android 15 cold start', description: 'Crash rate jumped to 4.1% after the Android 15 rollout. Stack trace points at the notification permission prompt.', team: 'ENG', priority: 'high', type: 'incident', status: 'open', tags: ['mobile', 'android'], ageHours: 14 },
  { subject: 'Duplicate charge on renewal for annual plans', description: 'Three customers report being charged twice on renewal. Needs reconciliation and refunds.', team: 'FIN', priority: 'high', type: 'incident', status: 'pending', tags: ['billing', 'refund'], ageHours: 72 },
  { subject: 'Add bulk reassignment to the queue view', description: 'Agents want to select multiple tickets and reassign them in one action.', team: 'SUP', priority: 'low', type: 'request', status: 'open', tags: ['feature'], ageHours: 120 },
  { subject: 'Nightly backup job failed twice this week', description: 'The 02:00 UTC backup exited non-zero on Tuesday and Thursday. No alert fired either time, which is the bigger problem.', team: 'OPS', priority: 'high', type: 'problem', status: 'in_progress', tags: ['backup', 'monitoring'], ageHours: 40 },
  { subject: 'How do I move a ticket between teams?', description: 'New starter asking for guidance on reassignment between queues.', team: 'SUP', priority: 'low', type: 'question', status: 'resolved', tags: ['how-to'], ageHours: 200 },
  { subject: 'Rate limiting blocks legitimate partner traffic', description: 'Our largest integration partner is hitting the 100 req/min ceiling during their sync window.', team: 'ENG', priority: 'normal', type: 'problem', status: 'pending', tags: ['api', 'partners'], ageHours: 96 },
  { subject: 'Stale DNS record pointing at decommissioned host', description: 'status.internal still resolves to the old bastion. Low impact but needs cleaning up.', team: 'OPS', priority: 'low', type: 'request', status: 'resolved', tags: ['dns', 'cleanup'], ageHours: 300 },
  { subject: 'Refund not reflected on customer statement', description: 'Refund processed on the 3rd but the statement still shows the original charge.', team: 'FIN', priority: 'normal', type: 'incident', status: 'closed', tags: ['billing'], ageHours: 400 },
];

const COMMENTS = [
  'Picked this up. Reproduced on staging, digging into the gateway logs now.',
  'Confirmed with the customer that this started after the Tuesday deploy.',
  'Rolled back the change on the edge config. Monitoring for the next 30 minutes.',
  'Escalating to engineering, this is outside what support can resolve.',
  'Customer has been updated and is happy to wait for the fix window.',
];

async function seed(): Promise<void> {
  await initDatabase();

  if ((await countUsers()) > 0) {
    console.log('[seed] Users already exist, nothing to do.');
    console.log('[seed] Run "npm run reset" to wipe the local database and re-seed.');
    return;
  }

  const teamIds = new Map<string, string>();
  const existing = await listTeams();
  for (const team of TEAMS) {
    const found = existing.find((t) => t.key === team.key);
    teamIds.set(team.key, found ? found.id : await createTeam(team));
  }

  const userIds = new Map<string, string>();
  for (const person of PEOPLE) {
    const id = await createUser({
      email: person.email,
      username: person.email.split('@')[0],
      name: person.name,
      password: DEMO_PASSWORD,
      role: person.role,
      jobTitle: person.jobTitle,
      teamIds: person.teams.map((key) => teamIds.get(key)!).filter(Boolean),
      extraPermissions: person.role === 'admin' ? [...ALL_PERMISSIONS] : [],
      mustChangePassword: false,
    });
    userIds.set(person.email, id);
  }

  await updateSettings({
    organizationName: 'Northwind Services',
    supportEmail: 'support@example.com',
    defaultTeamId: teamIds.get('SUP') ?? null,
    ticketPrefix: 'ESC',
  });

  const requesterPool = [...userIds.values()];

  for (const [index, spec] of TICKETS.entries()) {
    const teamId = teamIds.get(spec.team)!;
    const createdAt = new Date(Date.now() - spec.ageHours * 60 * 60 * 1000).toISOString();
    const assigneeId = await pickAssignee(teamId, 'round_robin');

    const { id } = await insertTicket({
      subject: spec.subject,
      description: spec.description,
      teamId,
      requesterId: requesterPool[index % requesterPool.length],
      assigneeId: spec.status === 'open' && index % 4 === 0 ? null : assigneeId,
      status: spec.status,
      priority: spec.priority,
      type: spec.type,
      source: 'web',
      tags: spec.tags,
      dueAt: dueDateFrom(Math.round(1440 * slaMultiplier(spec.priority)), new Date(createdAt)),
      createdBy: requesterPool[index % requesterPool.length],
    });

    // Backdate so the reports view has a realistic spread over time.
    const resolvedAt =
      spec.status === 'resolved' || spec.status === 'closed'
        ? new Date(new Date(createdAt).getTime() + 6 * 60 * 60 * 1000).toISOString()
        : null;
    await db.run(
      `UPDATE tickets SET created_at = ?, updated_at = ?, first_response_at = ?, resolved_at = ?, closed_at = ? WHERE id = ?`,
      [
        createdAt,
        createdAt,
        new Date(new Date(createdAt).getTime() + 45 * 60 * 1000).toISOString(),
        resolvedAt,
        spec.status === 'closed' ? resolvedAt : null,
        id,
      ],
    );

    await recordEvent(id, requesterPool[index % requesterPool.length], 'created', null, null, spec.subject);
    if (assigneeId) await addWatcher(id, assigneeId);

    // A couple of tickets get a short conversation thread.
    if (index % 3 === 0) {
      const now = new Date(new Date(createdAt).getTime() + 90 * 60 * 1000).toISOString();
      await db.run(
        `INSERT INTO ticket_comments (id, ticket_id, author_id, body, is_internal, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [randomId(), id, assigneeId, COMMENTS[index % COMMENTS.length], index % 2, now, now],
      );
    }
  }

  console.log('');
  console.log('  Seeded demo data.');
  console.log('');
  console.log('  Sign in with any of these accounts:');
  for (const person of PEOPLE) {
    console.log(`    ${person.email.padEnd(24)} ${person.role.padEnd(8)} password: ${DEMO_PASSWORD}`);
  }
  console.log('');
  await db.close();
}

seed().catch((error) => {
  console.error('[seed] failed:', error);
  process.exit(1);
});
