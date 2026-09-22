import { db } from '../db/index.ts';
import type { IntegrationProvider } from '../../shared/types.ts';

/**
 * Where a department's tickets are announced.
 *
 * Each team may override the integration's default destination: HR tickets to
 * the HR channel, IT tickets to IT. A team with no row uses the default, so
 * nothing has to be configured for a deployment that wants one channel for
 * everything.
 *
 * Kept in its own table rather than as columns on `teams`: the app may not be
 * the owner of that table, and in PostgreSQL only an owner may alter one.
 */
export interface TeamRoute {
  provider: IntegrationProvider;
  /** Slack channel id, Teams webhook URL, or Linear team id. */
  target: string;
  /** Slack only: who to mention, already in Slack's own mention syntax. */
  mention: string | null;
}

/**
 * Turns what someone types into what Slack understands.
 *
 * People write `@here` or paste a group handle; Slack only pings for its own
 * escape forms. A raw `@hr-team` cannot be resolved to an id here, so it is
 * left alone - it still reads as intent in the message even though it will not
 * notify, which is better than silently dropping it.
 */
export function normaliseMention(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (value === '@here' || value === 'here') return '<!here>';
  if (value === '@channel' || value === 'channel') return '<!channel>';
  // Already an escape sequence: <!subteam^S123>, <@U123>, <!here>.
  if (/^<[!@#]/.test(value)) return value;
  // A bare user group or user id.
  if (/^S[A-Z0-9]{6,}$/.test(value)) return `<!subteam^${value}>`;
  if (/^U[A-Z0-9]{6,}$/.test(value)) return `<@${value}>`;
  return value.slice(0, 120);
}

export async function listTeamRoutes(teamId: string): Promise<TeamRoute[]> {
  const rows = await db.all<{ provider: string; target: string; mention: string | null }>(
    `SELECT provider, target, mention FROM team_routing WHERE team_id = ?`,
    [teamId],
  );
  return rows.map((row) => ({
    provider: row.provider as IntegrationProvider,
    target: row.target,
    mention: row.mention,
  }));
}

/** The override for one team and provider, or null to use the default. */
export async function findTeamRoute(
  teamId: string | null | undefined,
  provider: IntegrationProvider,
): Promise<TeamRoute | null> {
  if (!teamId) return null;
  const row = await db.get<{ target: string; mention: string | null }>(
    `SELECT target, mention FROM team_routing WHERE team_id = ? AND provider = ?`,
    [teamId, provider],
  );
  if (!row) return null;
  // An empty target means "no override", not "send nowhere".
  return { provider, target: row.target, mention: row.mention };
}

export async function setTeamRoute(
  teamId: string,
  provider: IntegrationProvider,
  target: string,
  mention?: string | null,
): Promise<void> {
  const cleanTarget = String(target ?? '').trim();
  const cleanMention = normaliseMention(mention);

  // Nothing to route to and nobody to ping: drop the row rather than keep an
  // empty override that reads as configuration.
  if (!cleanTarget && !cleanMention) {
    await db.run(`DELETE FROM team_routing WHERE team_id = ? AND provider = ?`, [teamId, provider]);
    return;
  }

  await db.run(
    `INSERT INTO team_routing (team_id, provider, target, mention, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (team_id, provider) DO UPDATE SET target = excluded.target, mention = excluded.mention,
       updated_at = excluded.updated_at`,
    [teamId, provider, cleanTarget.slice(0, 500), cleanMention, new Date().toISOString()],
  );
}
