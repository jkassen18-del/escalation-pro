import { Router, type Request } from 'express';
import { db, placeholders } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { asyncRoute, badRequest, notFound, optionalString, requireString } from '../lib/http.ts';
import { can, requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
import { findTeamById } from '../repositories/teams.ts';
import { TEAM_LINK_ICONS, type TeamLink, type TeamLinkIcon } from '../../shared/sso.ts';

/**
 * Links from a team to the other systems it works in - the AWS access
 * portal, the Azure portal, the Entra admin centre - so a responder has them
 * one click away. Managed with teams.manage; read by the team's members.
 */
export const teamLinksRouter: Router = Router();
teamLinksRouter.use(requireAuth);

interface LinkRow {
  id: string;
  team_id: string;
  team_name: string | null;
  name: string;
  url: string;
  icon: string;
  description: string | null;
  position: number | string;
}

function mapLink(row: LinkRow): TeamLink {
  return {
    id: row.id,
    teamId: row.team_id,
    teamName: row.team_name,
    name: row.name,
    url: row.url,
    icon: (TEAM_LINK_ICONS as readonly string[]).includes(row.icon) ? (row.icon as TeamLinkIcon) : 'generic',
    description: row.description,
    position: Number(row.position),
  };
}

const SELECT = `SELECT l.*, t.name AS team_name FROM team_links l LEFT JOIN teams t ON t.id = l.team_id`;

function validate(body: Record<string, unknown>) {
  const name = requireString(body.name, 'Name', { max: 80 });
  const raw = requireString(body.url, 'URL', { max: 2000 });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('That is not a URL.', { url: 'Invalid URL' });
  }
  // https only: a link here is clicked by people who trust it, and javascript:
  // or data: URLs would run in this app's origin.
  if (url.protocol !== 'https:') throw badRequest('Links must start with https://', { url: 'Must be https' });
  if (/[<>]/.test(raw)) throw badRequest('Replace the <placeholder> in the address with your own value.', { url: 'Placeholder left in' });
  const icon = (TEAM_LINK_ICONS as readonly string[]).includes(String(body.icon)) ? (body.icon as TeamLinkIcon) : 'generic';
  return { name, url: url.toString(), icon, description: optionalString(body.description, 300) };
}

/** Links for the teams this person belongs to; everything for those who manage teams. */
teamLinksRouter.get(
  '/mine',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    if (can(user, 'teams.manage')) {
      res.json({ links: (await db.all<LinkRow>(`${SELECT} ORDER BY t.name, l.position, l.name`)).map(mapLink) });
      return;
    }
    if (!user.teamIds.length) {
      res.json({ links: [] });
      return;
    }
    const rows = await db.all<LinkRow>(
      `${SELECT} WHERE l.team_id IN (${placeholders(user.teamIds.length)}) ORDER BY t.name, l.position, l.name`,
      user.teamIds,
    );
    res.json({ links: rows.map(mapLink) });
  }),
);

teamLinksRouter.get(
  '/',
  requirePermission('teams.manage'),
  asyncRoute(async (req, res) => {
    const teamId = requireString(req.query.teamId, 'Team', { max: 60 });
    const rows = await db.all<LinkRow>(`${SELECT} WHERE l.team_id = ? ORDER BY l.position, l.name`, [teamId]);
    res.json({ links: rows.map(mapLink) });
  }),
);

async function audit(req: Request, action: string, summary: string, teamId: string) {
  const user = (req as AuthedRequest).user;
  await recordAudit({ actorId: user.id, actorName: user.name, entityType: 'team', entityId: teamId, action, summary, ip: clientIp(req) });
}

teamLinksRouter.post(
  '/',
  requirePermission('teams.manage'),
  asyncRoute(async (req, res) => {
    const team = await findTeamById(requireString(req.body?.teamId, 'Team', { max: 60 }));
    if (!team) throw notFound('That team does not exist.');
    const input = validate(req.body ?? {});
    const count = await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM team_links WHERE team_id = ?`, [team.id]);
    if (Number(count?.n ?? 0) >= 30) throw badRequest('A team can have up to 30 links.');
    const id = randomId();
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO team_links (id, team_id, name, url, icon, description, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, team.id, input.name, input.url, input.icon, input.description, Number(count?.n ?? 0), now, now],
    );
    await audit(req, 'team_link_added', `Added the link "${input.name}" to ${team.name}`, team.id);
    res.status(201).json({ link: mapLink((await db.get<LinkRow>(`${SELECT} WHERE l.id = ?`, [id]))!) });
  }),
);

teamLinksRouter.put(
  '/:id',
  requirePermission('teams.manage'),
  asyncRoute(async (req, res) => {
    const existing = await db.get<LinkRow>(`${SELECT} WHERE l.id = ?`, [req.params.id]);
    if (!existing) throw notFound('That link does not exist.');
    const input = validate(req.body ?? {});
    const position = Number.isInteger(req.body?.position) ? Number(req.body.position) : Number(existing.position);
    await db.run(`UPDATE team_links SET name = ?, url = ?, icon = ?, description = ?, position = ?, updated_at = ? WHERE id = ?`, [
      input.name,
      input.url,
      input.icon,
      input.description,
      position,
      new Date().toISOString(),
      existing.id,
    ]);
    await audit(req, 'team_link_updated', `Updated the link "${input.name}" on ${existing.team_name}`, existing.team_id);
    res.json({ link: mapLink((await db.get<LinkRow>(`${SELECT} WHERE l.id = ?`, [existing.id]))!) });
  }),
);

teamLinksRouter.delete(
  '/:id',
  requirePermission('teams.manage'),
  asyncRoute(async (req, res) => {
    const existing = await db.get<LinkRow>(`${SELECT} WHERE l.id = ?`, [req.params.id]);
    if (!existing) throw notFound('That link does not exist.');
    await db.run(`DELETE FROM team_links WHERE id = ?`, [existing.id]);
    await audit(req, 'team_link_removed', `Removed the link "${existing.name}" from ${existing.team_name}`, existing.team_id);
    res.status(204).end();
  }),
);
