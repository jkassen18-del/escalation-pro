import { Router } from 'express';
import {
  asyncRoute,
  badRequest,
  forbidden,
  notFound,
  optionalDate,
  optionalString,
  parseIntOr,
  requireEnum,
  requireString,
  toStringArray,
} from '../lib/http.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
import { getSettings, updateSettings } from '../repositories/settings.ts';
import { createApiKey, listApiKeys, revokeApiKey } from '../repositories/api-keys.ts';
import { isPermission } from '../permissions.ts';
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

/* ------------------------------- API keys --------------------------------- */

/**
 * Managing the keys for the HTTPS API.
 *
 * Under settings rather than a page of its own: a key is a deployment-level
 * credential, and the people who should be creating one are the same people
 * who configure integrations.
 */
settingsRouter.get(
  '/api-keys',
  requirePermission('settings.manage'),
  asyncRoute(async (_req, res) => {
    res.json({ keys: await listApiKeys() });
  }),
);

settingsRouter.post(
  '/api-keys',
  requirePermission('settings.manage'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const name = requireString(req.body?.name, 'Name', { max: 120 });

    const requested = toStringArray(req.body?.scopes, 20).filter(isPermission);
    if (requested.length === 0) throw badRequest('Choose at least one scope for the key.');

    /*
     * A key can never exceed its creator. Without this an admin could mint a
     * key with permissions they do not hold, and the key would outlive any
     * later reduction of their own access.
     */
    const granted = requested.filter((scope) => actor.permissions.includes(scope));
    if (granted.length !== requested.length) {
      const refused = requested.filter((scope) => !granted.includes(scope));
      throw forbidden(`You cannot grant a key permissions you do not hold: ${refused.join(', ')}.`);
    }

    const expiresAt = optionalDate(req.body?.expiresAt, 'Expiry');
    const { key, token } = await createApiKey({
      name,
      scopes: granted,
      defaultTeamId: optionalString(req.body?.defaultTeamId, 60),
      expiresAt,
      createdBy: actor.id,
    });

    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'system',
      entityId: key.id,
      action: 'api_key_created',
      summary: `Created API key "${key.name}" (${key.prefix}) with ${granted.join(', ')}`,
      ip: clientIp(req),
    });

    // The only time the token leaves the server. It is not recoverable after
    // this response, which is said plainly in the UI.
    res.status(201).json({ key, token });
  }),
);

settingsRouter.delete(
  '/api-keys/:id',
  requirePermission('settings.manage'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const revoked = await revokeApiKey(req.params.id);
    if (!revoked) throw notFound('No such API key, or it is already revoked.');

    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'system',
      entityId: req.params.id,
      action: 'api_key_revoked',
      summary: `Revoked API key ${req.params.id}`,
      ip: clientIp(req),
    });

    res.json({ ok: true });
  }),
);
