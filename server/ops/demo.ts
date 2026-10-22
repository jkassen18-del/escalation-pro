import { db } from '../db/index.ts';
import { config } from '../config.ts';
import { createTeam } from '../repositories/teams.ts';
import { saveMonitor } from './monitors.ts';
import { savePolicy, saveSchedule } from './oncall.ts';
import { saveSource } from './sources.ts';
import { saveStatusPage } from './status-pages.ts';

/**
 * The "sample workspace" offered on the setup screen: enough to see the
 * operations side working in the first minute, around the person who just
 * created the account. Everything points at this server itself, so nothing
 * here depends on a network an air-gapped install may not have.
 */
export async function seedOpsWorkspace(ownerId: string): Promise<void> {
  // Setup already makes an Operations team; build on it rather than beside it.
  const existing = await db.get<{ id: string }>(`SELECT id FROM teams WHERE key = 'OPS'`);
  const teamId =
    existing?.id ??
    (await createTeam({
    key: 'OPS',
    name: 'Operations',
    description: 'Incidents, on-call and the platform itself.',
    color: '#b54708',
    autoAssign: 'none',
    defaultPriority: 'high',
    slaResponseMins: 30,
    slaResolveMins: 480,
    }));
  await db.run(`INSERT INTO team_members (team_id, user_id, is_lead) VALUES (?, ?, 1) ON CONFLICT (team_id, user_id) DO NOTHING`, [teamId, ownerId]);

  const monday = new Date();
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  monday.setUTCHours(7, 0, 0, 0);
  const schedule = await saveSchedule(null, {
    name: 'Operations primary',
    description: 'Weekly rotation, handing over on Mondays at 09:00 SAST.',
    teamId,
    timeZone: 'Africa/Johannesburg',
    layers: [{ name: 'Weekly', position: 0, rotation: 'weekly', shiftHours: 168, startsAt: monday.toISOString(), memberIds: [ownerId] }],
  });
  const policy = await savePolicy(null, {
    name: 'Operations SEV policy',
    description: 'Primary on-call, then the team lead, repeated once.',
    teamId,
    repeatCount: 1,
    levels: [
      { position: 0, delayMins: 10, targets: [{ type: 'schedule', id: schedule.id }] },
      { position: 1, delayMins: 10, targets: [{ type: 'team', id: teamId }] },
    ],
  });
  await db.run(`UPDATE teams SET escalation_policy_id = ? WHERE id = ?`, [policy.id, teamId]);

  const self = `http://127.0.0.1:${config.port}`;
  const web = await saveMonitor(null, {
    name: 'InfraTicket web app',
    kind: 'http',
    target: `${self}/health`,
    config: { expectedStatus: '200', keyword: '"ok"' },
    intervalSecs: 60,
    graceSecs: 0,
    failureThreshold: 2,
    teamId,
    severity: 'sev2',
    escalationPolicyId: null,
    enabled: true,
  });
  const port = await saveMonitor(null, {
    name: 'InfraTicket port',
    kind: 'tcp',
    target: `127.0.0.1:${config.port}`,
    config: {},
    intervalSecs: 120,
    graceSecs: 0,
    failureThreshold: 2,
    teamId,
    severity: 'sev3',
    escalationPolicyId: null,
    enabled: true,
  });
  await saveMonitor(null, {
    name: 'Nightly job (example heartbeat)',
    kind: 'heartbeat',
    target: '',
    config: {},
    intervalSecs: 86_400,
    graceSecs: 3600,
    failureThreshold: 1,
    teamId,
    severity: 'sev4',
    escalationPolicyId: null,
    enabled: true,
  });
  await saveSource(null, {
    name: 'Generic webhook',
    kind: 'generic',
    teamId,
    escalationPolicyId: null,
    defaultSeverity: 'sev3',
    mapping: {},
    enabled: true,
  });
  await saveStatusPage(null, {
    title: 'Service status',
    slug: 'status',
    description: 'Live status of our services.',
    isPublic: true,
    components: [
      { monitorId: web.id, label: 'Web app' },
      { monitorId: port.id, label: 'API' },
    ],
  });
}
