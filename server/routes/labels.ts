import { Router, type Request } from 'express';
import { db } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { asyncRoute, badRequest, forbidden, notFound, optionalString, requireString } from '../lib/http.ts';
import { can, requireAuth, type AuthedRequest } from '../middleware/auth.ts';
import { findTeamById } from '../repositories/teams.ts';
import type { PublicUser, TicketLabel } from '../../shared/types.ts';

/**
 * Labels: the tags a department picks from on its tickets, instead of typing
 * free text that drifts ("vpn", "VPN ", "vpn-issue"). Anyone signed in can read
 * them; a department's managers, and whoever edits intake forms, maintain them.
 */
export const labelsRouter: Router = Router();
labelsRouter.use(requireAuth);

interface LabelRow {
  id: string;
  team_id: string | null;
  team_name: string | null;
  name: string;
  color: string;
  description: string | null;
  position: number | string;
}

function mapLabel(row: LabelRow): TicketLabel {
  return {
    id: row.id,
    teamId: row.team_id,
    teamName: row.team_name,
    name: row.name,
    color: row.color,
    description: row.description,
    position: Number(row.position),
  };
}

const SELECT = `SELECT l.*, t.name AS team_name FROM team_labels l LEFT JOIN teams t ON t.id = l.team_id`;
const MAX_PER_TEAM = 50;

/** Organisation-wide labels need teams.manage; a department's own, its managers or a form editor. */
function canManageLabels(user: PublicUser, teamId: string | null): boolean {
  if (can(user, 'teams.manage')) return true;
  if (!teamId) return false;
  return can(user, 'teams.forms') || user.managedTeamIds.includes(teamId);
}

function validate(body: Record<string, unknown>) {
  // Commas would split the label in two wherever tags are typed or exported as CSV.
  const name = requireString(body.name, 'Name', { max: 40 }).replace(/\s+/g, ' ');
  if (name.includes(',')) throw badRequest('A label cannot contain a comma.', { name: 'No commas' });
  const color = typeof body.color === 'string' && /^#[0-9a-f]{6}$/i.test(body.color) ? body.color.toLowerCase() : '#6b7280';
  return { name, color, description: optionalString(body.description, 200) };
}

async function assertUnique(teamId: string | null, name: string, exceptId: string | null): Promise<void> {
  const rows = await db.all<{ id: string; name: string }>(
    teamId ? `SELECT id, name FROM team_labels WHERE team_id = ? OR team_id IS NULL` : `SELECT id, name FROM team_labels`,
    teamId ? [teamId] : [],
  );
  const clash = rows.find((row) => row.id !== exceptId && row.name.toLowerCase() === name.toLowerCase());
  if (clash) throw badRequest(`There is already a label called "${clash.name}" here.`, { name: 'Already exists' });
}

async function audit(req: Request, action: string, summary: string, teamId: string | null) {
  const user = (req as AuthedRequest).user;
  await recordAudit({ actorId: user.id, actorName: user.name, entityType: 'team', entityId: teamId, action, summary, ip: clientIp(req) });
}

/**
 * Every label, or with ?teamId the ones offered on that department's tickets
 * (its own plus the organisation-wide ones).
 */
labelsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const teamId = optionalString(req.query.teamId, 60);
    const rows = teamId
      ? await db.all<LabelRow>(`${SELECT} WHERE l.team_id = ? OR l.team_id IS NULL ORDER BY l.position, l.name`, [teamId])
      : await db.all<LabelRow>(`${SELECT} ORDER BY t.name, l.position, l.name`);
    res.json({ labels: rows.map(mapLabel) });
  }),
);

labelsRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const teamId = optionalString(req.body?.teamId, 60);
    const team = teamId ? await findTeamById(teamId) : null;
    if (teamId && !team) throw notFound('That department does not exist.');
    if (!canManageLabels(user, teamId)) throw forbidden('You cannot manage labels for this department.');

    const input = validate(req.body ?? {});
    await assertUnique(teamId, input.name, null);
    const count = await db.get<{ n: number | string }>(
      teamId ? `SELECT COUNT(*) AS n FROM team_labels WHERE team_id = ?` : `SELECT COUNT(*) AS n FROM team_labels WHERE team_id IS NULL`,
      teamId ? [teamId] : [],
    );
    if (Number(count?.n ?? 0) >= MAX_PER_TEAM) throw badRequest(`A department can have up to ${MAX_PER_TEAM} labels.`);

    const id = randomId();
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO team_labels (id, team_id, name, color, description, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, teamId, input.name, input.color, input.description, Number(count?.n ?? 0), now, now],
    );
    await audit(req, 'team_label_added', `Added the label "${input.name}" to ${team?.name ?? 'every department'}`, teamId);
    res.status(201).json({ label: mapLabel((await db.get<LabelRow>(`${SELECT} WHERE l.id = ?`, [id]))!) });
  }),
);

labelsRouter.put(
  '/:id',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const existing = await db.get<LabelRow>(`${SELECT} WHERE l.id = ?`, [req.params.id]);
    if (!existing) throw notFound('That label does not exist.');
    if (!canManageLabels(user, existing.team_id)) throw forbidden('You cannot manage labels for this department.');

    const input = validate(req.body ?? {});
    await assertUnique(existing.team_id, input.name, existing.id);
    const position = Number.isInteger(req.body?.position) ? Number(req.body.position) : Number(existing.position);
    await db.run(`UPDATE team_labels SET name = ?, color = ?, description = ?, position = ?, updated_at = ? WHERE id = ?`, [
      input.name,
      input.color,
      input.description,
      position,
      new Date().toISOString(),
      existing.id,
    ]);
    await audit(req, 'team_label_updated', `Updated the label "${input.name}" on ${existing.team_name ?? 'every department'}`, existing.team_id);
    res.json({ label: mapLabel((await db.get<LabelRow>(`${SELECT} WHERE l.id = ?`, [existing.id]))!) });
  }),
);

/** Removing a label leaves it on tickets that already carry it, as a plain tag. */
labelsRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const existing = await db.get<LabelRow>(`${SELECT} WHERE l.id = ?`, [req.params.id]);
    if (!existing) throw notFound('That label does not exist.');
    if (!canManageLabels(user, existing.team_id)) throw forbidden('You cannot manage labels for this department.');
    await db.run(`DELETE FROM team_labels WHERE id = ?`, [existing.id]);
    await audit(req, 'team_label_removed', `Removed the label "${existing.name}" from ${existing.team_name ?? 'every department'}`, existing.team_id);
    res.status(204).end();
  }),
);
