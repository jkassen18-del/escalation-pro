import { Router } from 'express';
import { db } from '../db/index.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { asyncRoute, badRequest, requireString } from '../lib/http.ts';
import { requireAuth, type AuthedRequest } from '../middleware/auth.ts';
import { redeemLinkCode, unlinkDiscord } from '../integrations/discord.ts';
import { loadIntegration } from '../integrations/store.ts';

/**
 * Linking a person's own Discord account, from their profile.
 *
 * The code comes from /link in Discord, so typing it here proves the person
 * signed in to InfraTicket also controls that Discord account. Linking by
 * display name or email would prove nothing.
 */
export const discordRouter: Router = Router();
discordRouter.use(requireAuth);

discordRouter.get(
  '/me',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const row = await db.get<{ discord_user_id: string | null; discord_username: string | null }>(
      `SELECT discord_user_id, discord_username FROM users WHERE id = ?`,
      [user.id],
    );
    const record = await loadIntegration('discord');
    res.json({
      available: record.enabled,
      linked: Boolean(row?.discord_user_id),
      discordUsername: row?.discord_username ?? null,
    });
  }),
);

discordRouter.post(
  '/link',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const code = requireString(req.body?.code, 'Code', { max: 20 });
    const linked = await redeemLinkCode(user.id, code);
    if (!linked) throw badRequest('That code is not right or has expired. Type /link in Discord for a new one.', { code: 'Invalid' });
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'user',
      entityId: user.id,
      action: 'discord_linked',
      summary: `${user.name} linked the Discord account ${linked.discordUsername}`,
      ip: clientIp(req),
    });
    res.json({ linked: true, discordUsername: linked.discordUsername });
  }),
);

discordRouter.delete(
  '/link',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    if (await unlinkDiscord({ userId: user.id })) {
      await recordAudit({
        actorId: user.id,
        actorName: user.name,
        entityType: 'user',
        entityId: user.id,
        action: 'discord_unlinked',
        summary: `${user.name} unlinked their Discord account`,
        ip: clientIp(req),
      });
    }
    res.json({ linked: false });
  }),
);
