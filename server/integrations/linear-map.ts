import { db, fromBool, toBool } from '../db/index.ts';
import { badRequest } from '../lib/http.ts';
import { setTeamRoute } from '../repositories/team-routing.ts';
import type { LinearTeamMapping } from '../../shared/types.ts';

/**
 * Which department each Linear team belongs to.
 *
 * Inbound, any number of Linear teams may feed one department. Outbound a
 * department's tickets need exactly one Linear team, so each department's
 * primary mapping is also written to team_routing - the per-department
 * override the mirror already reads - keeping the two views of the same
 * decision from disagreeing.
 */

interface MapRow {
  linear_team_id: string;
  linear_team_key: string | null;
  linear_team_name: string | null;
  team_id: string;
  is_primary: number | string;
}

function toMapping(row: MapRow): LinearTeamMapping {
  return {
    linearTeamId: row.linear_team_id,
    linearTeamKey: row.linear_team_key,
    linearTeamName: row.linear_team_name,
    teamId: row.team_id,
    isPrimary: toBool(row.is_primary),
  };
}

export async function listLinearTeamMap(): Promise<LinearTeamMapping[]> {
  const rows = await db.all<MapRow>(`SELECT * FROM linear_team_map ORDER BY linear_team_name`);
  return rows.map(toMapping);
}

export function validateLinearTeamMap(value: unknown): LinearTeamMapping[] {
  if (!Array.isArray(value)) throw badRequest('Send the list of Linear teams and the department each belongs to.');
  const seen = new Set<string>();
  return value.slice(0, 500).flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const linearTeamId = String(row.linearTeamId ?? '').trim();
    const teamId = typeof row.teamId === 'string' ? row.teamId.trim() : '';
    if (!linearTeamId || !teamId || seen.has(linearTeamId)) return [];
    seen.add(linearTeamId);
    return [
      {
        linearTeamId: linearTeamId.slice(0, 100),
        linearTeamKey: row.linearTeamKey ? String(row.linearTeamKey).slice(0, 40) : null,
        linearTeamName: row.linearTeamName ? String(row.linearTeamName).slice(0, 200) : null,
        teamId,
        isPrimary: row.isPrimary === true,
      },
    ];
  });
}

export async function saveLinearTeamMap(mappings: LinearTeamMapping[]): Promise<LinearTeamMapping[]> {
  const teams = await db.all<{ id: string }>(`SELECT id FROM teams`);
  const known = new Set(teams.map((team) => team.id));
  const unknown = mappings.find((mapping) => !known.has(mapping.teamId));
  if (unknown) throw badRequest(`The department for ${unknown.linearTeamName ?? unknown.linearTeamId} no longer exists.`);

  // One primary per department: the one flagged, else the first listed.
  const primaryFor = new Map<string, string>();
  for (const mapping of mappings) if (mapping.isPrimary && !primaryFor.has(mapping.teamId)) primaryFor.set(mapping.teamId, mapping.linearTeamId);
  for (const mapping of mappings) if (!primaryFor.has(mapping.teamId)) primaryFor.set(mapping.teamId, mapping.linearTeamId);

  const previous = await listLinearTeamMap();
  const now = new Date().toISOString();
  await db.transaction(async () => {
    await db.run(`DELETE FROM linear_team_map`);
    for (const mapping of mappings) {
      await db.run(
        `INSERT INTO linear_team_map (linear_team_id, linear_team_key, linear_team_name, team_id, is_primary, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [mapping.linearTeamId, mapping.linearTeamKey, mapping.linearTeamName, mapping.teamId, fromBool(primaryFor.get(mapping.teamId) === mapping.linearTeamId), now],
      );
    }
    for (const [teamId, linearTeamId] of primaryFor) await setTeamRoute(teamId, 'linear', linearTeamId);

    // A department unlinked here stops mirroring to the Linear team it was
    // linked to - but a route someone set by hand to another team is theirs.
    const previouslyMapped = new Set(previous.map((mapping) => mapping.linearTeamId));
    for (const teamId of new Set(previous.map((mapping) => mapping.teamId))) {
      if (primaryFor.has(teamId)) continue;
      const route = await db.get<{ target: string }>(`SELECT target FROM team_routing WHERE team_id = ? AND provider = 'linear'`, [teamId]);
      if (route && previouslyMapped.has(route.target)) await setTeamRoute(teamId, 'linear', '');
    }
  });
  return listLinearTeamMap();
}

/** The department a Linear team's issues belong to: the mapping first, then a per-department route. */
export async function mappedDepartment(linearTeamId: string): Promise<string | null> {
  const row = await db.get<{ team_id: string }>(`SELECT team_id FROM linear_team_map WHERE linear_team_id = ?`, [linearTeamId]);
  return row?.team_id ?? null;
}
