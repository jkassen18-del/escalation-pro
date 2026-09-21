import { Router } from 'express';
import { asyncRoute, toStringArray } from '../lib/http.ts';
import { listNotifications, markNotificationsRead, unreadCount } from '../lib/notifications.ts';
import { requireAuth, type AuthedRequest } from '../middleware/auth.ts';

export const notificationsRouter: Router = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const [notifications, unread] = await Promise.all([listNotifications(user.id), unreadCount(user.id)]);
    res.json({ notifications, unread });
  }),
);

notificationsRouter.post(
  '/read',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const ids = toStringArray(req.body?.ids, 200);
    await markNotificationsRead(user.id, ids.length ? ids : undefined);
    res.json({ ok: true, unread: await unreadCount(user.id) });
  }),
);
