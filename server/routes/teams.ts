import { Router } from 'express';
import { db } from '../db/index.ts';
import {
  asyncRoute,
  badRequest,
  conflict,
  notFound,
  optionalString,
  parseIntOr,
  requireEnum,
  requireString,
  toStringArray,
} from '../lib/http.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
import { createTeam, findTeamById, keyInUse, listTeams, setTeamMembers } from '../repositories/teams.ts';
import { AUTO_ASSIGN_MODES, TICKET_PRIORITIES } from '../../shared/types.ts';

export const teamsRouter: Router = Router();

teamsRouter.use(requireAuth);

/** Every signed-in user can read teams; they are needed to file a ticket. */
teamsRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    res.json({ teams: await listTeams() });
  }),
);

teamsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const team = await findTeamById(req.params.id);
    if (!team) throw notFound('That team does not exist.');
    res.json({ team });
  }),
);

teamsRouter.post(
  '/',
  requirePermission('teams.manage'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const name = requireString(req.body?.name, 'Name', { max: 80 });
    const key = requireString(req.body?.key ?? name.slice(0, 4), 'Key', { max: 10 })
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');

    if (!key) throw badRequest('The team key must contain letters or numbers.', { key: 'Invalid' });
    if (await keyInUse(key)) throw conflict(`A team with the key "${key}" already exists.`);

    const id = await createTeam({
      key,
      name,
      description: optionalString(req.body?.description, 400),
      color: optionalString(req.body?.color, 20) ?? '#6b7280',
      autoAssign: requireEnum(req.body?.autoAssign ?? 'none', AUTO_ASSIGN_MODES, 'Auto assign'),
      defaultPriority: requireEnum(req.body?.defaultPriority ?? 'normal', TICKET_PRIORITIES, 'Default priority'),
      slaResponseMins: parseIntOr(req.body?.slaResponseMins, 240, { min: 5, max: 100_000 }),
      slaResolveMins: parseIntOr(req.body?.slaResolveMins, 2880, { min: 15, max: 500_000 }),
      memberIds: toStringArray(req.body?.memberIds, 500),
    });

    const team = await findTeamById(id);
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'team',
      entityId: id,
      action: 'team_created',
      summary: `Created the ${name} team`,
      ip: clientIp(req),
    });

    res.status(201).json({ team });
  }),
);

teamsRouter.patch(
  '/:id',
  requirePermission('teams.manage'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const team = await findTeamById(req.params.id);
    if (!team) throw notFound('That team does not exist.');

    const updates: string[] = [];
    const params: Array<string | number | null> = [];
    const push = (column: string, value: string | number | null) => {
      updates.push(`${column} = ?`);
      params.push(value);
    };

    if (req.body?.name !== undefined) push('name', requireString(req.body.name, 'Name', { max: 80 }));
    if (req.body?.description !== undefined) push('description', optionalString(req.body.description, 400));
    if (req.body?.color !== undefined) push('color', optionalString(req.body.color, 20) ?? '#6b7280');
    if (req.body?.autoAssign !== undefined) {
      push('auto_assign', requireEnum(req.body.autoAssign, AUTO_ASSIGN_MODES, 'Auto assign'));
    }
    if (req.body?.defaultPriority !== undefined) {
      push('default_priority', requireEnum(req.body.defaultPriority, TICKET_PRIORITIES, 'Default priority'));
    }
    if (req.body?.slaResponseMins !== undefined) {
      push('sla_response_mins', parseIntOr(req.body.slaResponseMins, team.slaResponseMins, { min: 5, max: 100_000 }));
    }
    if (req.body?.slaResolveMins !== undefined) {
      push('sla_resolve_mins', parseIntOr(req.body.slaResolveMins, team.slaResolveMins, { min: 15, max: 500_000 }));
    }
    if (req.body?.key !== undefined) {
      const key = requireString(req.body.key, 'Key', { max: 10 }).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!key) throw badRequest('The team key must contain letters or numbers.', { key: 'Invalid' });
      if (await keyInUse(key, team.id)) throw conflict(`A team with the key "${key}" already exists.`);
      push('key', key);
    }

    if (updates.length) {
      push('updated_at', new Date().toISOString());
      params.push(team.id);
      await db.run(`UPDATE teams SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    if (Array.isArray(req.body?.memberIds)) {
      await setTeamMembers(team.id, toStringArray(req.body.memberIds, 500));
    }

    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'team',
      entityId: team.id,
      action: 'team_updated',
      summary: `Updated the ${team.name} team`,
      ip: clientIp(req),
    });

    res.json({ team: await findTeamById(team.id) });
  }),
);

teamsRouter.delete(
  '/:id',
  requirePermission('teams.manage'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const team = await findTeamById(req.params.id);
    if (!team) throw notFound('That team does not exist.');

    const openRow = await db.get<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM tickets WHERE team_id = ? AND status NOT IN ('resolved', 'closed')`,
      [team.id],
    );
    if (Number(openRow?.count ?? 0) > 0) {
      throw badRequest(
        `${team.name} still has ${openRow?.count} open ticket(s). Move or close them before deleting the team.`,
      );
    }

    // Resolved tickets keep their history; team_id becomes NULL.
    await db.run(`DELETE FROM teams WHERE id = ?`, [team.id]);

    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'team',
      entityId: team.id,
      action: 'team_deleted',
      summary: `Deleted the ${team.name} team`,
      ip: clientIp(req),
    });

    res.json({ ok: true });
  }),
);
