import { Router } from 'express';
import { asyncRoute, optionalString, parseIntOr, requireEnum, requireString } from '../lib/http.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
import { getSettings, updateSettings } from '../repositories/settings.ts';
import { TICKET_PRIORITIES } from '../../shared/types.ts';

export const settingsRouter: Router = Router();

settingsRouter.use(requireAuth);

/** Readable by any signed-in user; the UI needs the prefix and defaults. */
settingsRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    res.json({ settings: await getSettings() });
  }),
);

settingsRouter.patch(
  '/',
  requirePermission('settings.manage'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const current = await getSettings();
    const patch: Record<string, unknown> = {};

    if (req.body?.organizationName !== undefined) {
      patch.organizationName = requireString(req.body.organizationName, 'Organisation name', { max: 120 });
    }
    if (req.body?.supportEmail !== undefined) patch.supportEmail = optionalString(req.body.supportEmail, 160) ?? '';
    if (req.body?.appUrl !== undefined) {
      patch.appUrl = (optionalString(req.body.appUrl, 300) ?? '').replace(/\/+$/, '');
    }
    if (req.body?.defaultTeamId !== undefined) patch.defaultTeamId = optionalString(req.body.defaultTeamId, 60);
    if (req.body?.timezone !== undefined) patch.timezone = optionalString(req.body.timezone, 60) ?? 'UTC';
    if (req.body?.defaultPriority !== undefined) {
      patch.defaultPriority = requireEnum(req.body.defaultPriority, TICKET_PRIORITIES, 'Default priority');
    }
    if (req.body?.slaResponseMins !== undefined) {
      patch.slaResponseMins = parseIntOr(req.body.slaResponseMins, current.slaResponseMins, { min: 5, max: 100_000 });
    }
    if (req.body?.slaResolveMins !== undefined) {
      patch.slaResolveMins = parseIntOr(req.body.slaResolveMins, current.slaResolveMins, { min: 15, max: 500_000 });
    }
    if (req.body?.ticketPrefix !== undefined) {
      // The prefix is part of every ticket reference, so keep it short and safe.
      patch.ticketPrefix =
        requireString(req.body.ticketPrefix, 'Ticket prefix', { max: 8 })
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '') || 'ESC';
    }

    const settings = await updateSettings(patch);
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'settings',
      action: 'settings_updated',
      summary: `Updated system settings (${Object.keys(patch).join(', ') || 'no change'})`,
      meta: patch,
      ip: clientIp(req),
    });

    res.json({ settings });
  }),
);
