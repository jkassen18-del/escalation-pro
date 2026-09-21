import { db } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import type { AutoAssignMode, Team, TicketPriority } from '../../shared/types.ts';

interface TeamRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  color: string;
  auto_assign: AutoAssignMode;
  default_priority: TicketPriority;
  sla_response_mins: number;
  sla_resolve_mins: number;
  last_assigned_user_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapTeam(row: TeamRow, memberIds: string[], openTicketCount: number): Team {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    color: row.color,
    autoAssign: row.auto_assign,
    defaultPriority: row.default_priority,
    slaResponseMins: Number(row.sla_response_mins),
    slaResolveMins: Number(row.sla_resolve_mins),
    memberIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    openTicketCount,
  };
}

async function memberMap(): Promise<Map<string, string[]>> {
  const rows = await db.all<{ team_id: string; user_id: string }>(
    `SELECT tm.team_id, tm.user_id FROM team_members tm JOIN users u ON u.id = tm.user_id ORDER BY u.name`,
  );
  const map = new Map<string, string[]>();
  for (const row of rows) {
    if (!map.has(row.team_id)) map.set(row.team_id, []);
    map.get(row.team_id)!.push(row.user_id);
  }
  return map;
}

async function openCountMap(): Promise<Map<string, number>> {
  const rows = await db.all<{ team_id: string | null; count: number | string }>(
    `SELECT team_id, COUNT(*) AS count FROM tickets
     WHERE status NOT IN ('resolved', 'closed') GROUP BY team_id`,
  );
  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.team_id) map.set(row.team_id, Number(row.count));
  }
  return map;
}

export async function listTeams(): Promise<Team[]> {
  const rows = await db.all<TeamRow>(`SELECT * FROM teams ORDER BY name`);
  const members = await memberMap();
  const counts = await openCountMap();
  return rows.map((row) => mapTeam(row, members.get(row.id) ?? [], counts.get(row.id) ?? 0));
}

export async function findTeamById(id: string): Promise<Team | null> {
  const row = await db.get<TeamRow>(`SELECT * FROM teams WHERE id = ?`, [id]);
  if (!row) return null;
  const members = await memberMap();
  const counts = await openCountMap();
  return mapTeam(row, members.get(id) ?? [], counts.get(id) ?? 0);
}

export async function keyInUse(key: string, excludeId?: string): Promise<boolean> {
  const row = await db.get<{ id: string }>(
    `SELECT id FROM teams WHERE LOWER(key) = ?${excludeId ? ' AND id <> ?' : ''}`,
    excludeId ? [key.toLowerCase(), excludeId] : [key.toLowerCase()],
  );
  return Boolean(row);
}

export interface CreateTeamInput {
  key: string;
  name: string;
  description?: string | null;
  color?: string;
  autoAssign?: AutoAssignMode;
  defaultPriority?: TicketPriority;
  slaResponseMins?: number;
  slaResolveMins?: number;
  memberIds?: string[];
}

export async function createTeam(input: CreateTeamInput): Promise<string> {
  const id = randomId();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO teams (id, key, name, description, color, auto_assign, default_priority,
       sla_response_mins, sla_resolve_mins, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.key.toUpperCase(),
      input.name,
      input.description ?? null,
      input.color ?? '#6b7280',
      input.autoAssign ?? 'none',
      input.defaultPriority ?? 'normal',
      input.slaResponseMins ?? 240,
      input.slaResolveMins ?? 2880,
      now,
      now,
    ],
  );
  await setTeamMembers(id, input.memberIds ?? []);
  return id;
}

export async function setTeamMembers(teamId: string, userIds: string[]): Promise<void> {
  await db.run(`DELETE FROM team_members WHERE team_id = ?`, [teamId]);
  for (const userId of Array.from(new Set(userIds))) {
    await db.run(
      `INSERT INTO team_members (team_id, user_id, is_lead) VALUES (?, ?, 0)
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [teamId, userId],
    );
  }
}

/**
 * Picks the next assignee for a team according to its routing mode.
 * Only active agents/managers/admins are eligible - viewers cannot own work.
 */
export async function pickAssignee(teamId: string, mode: AutoAssignMode): Promise<string | null> {
  if (mode === 'none') return null;

  const candidates = await db.all<{ id: string }>(
    `SELECT u.id FROM users u
     JOIN team_members tm ON tm.user_id = u.id
     WHERE tm.team_id = ? AND u.status = 'active' AND u.role IN ('admin', 'manager', 'agent')
     ORDER BY u.name`,
    [teamId],
  );
  if (!candidates.length) return null;

  if (mode === 'least_busy') {
    const loads = await db.all<{ assignee_id: string; count: number | string }>(
      `SELECT assignee_id, COUNT(*) AS count FROM tickets
       WHERE status NOT IN ('resolved', 'closed') AND assignee_id IS NOT NULL
       GROUP BY assignee_id`,
    );
    const load = new Map(loads.map((row) => [row.assignee_id, Number(row.count)]));
    return candidates.reduce((best, current) =>
      (load.get(current.id) ?? 0) < (load.get(best.id) ?? 0) ? current : best,
    ).id;
  }

  // round_robin: continue from whoever was assigned last.
  const team = await db.get<{ last_assigned_user_id: string | null }>(
    `SELECT last_assigned_user_id FROM teams WHERE id = ?`,
    [teamId],
  );
  const lastIndex = candidates.findIndex((c) => c.id === team?.last_assigned_user_id);
  const next = candidates[(lastIndex + 1) % candidates.length];
  await db.run(`UPDATE teams SET last_assigned_user_id = ? WHERE id = ?`, [next.id, teamId]);
  return next.id;
}
