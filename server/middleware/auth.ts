import type { NextFunction, Request, Response } from 'express';
import { findUserById } from '../repositories/users.ts';
import { forbidden, unauthorized } from '../lib/http.ts';
import type { Permission, PublicUser } from '../../shared/types.ts';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
  }
}

export interface AuthedRequest extends Request {
  user: PublicUser;
}

/** Loads the signed-in user onto the request, rejecting suspended accounts. */
export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.session?.userId;
    if (!userId) return next();
    const user = await findUserById(userId);
    if (user && user.status === 'active') {
      (req as AuthedRequest).user = user;
    } else if (user) {
      // The account was suspended mid-session; drop the session immediately.
      req.session.destroy(() => undefined);
    }
    next();
  } catch (error) {
    next(error);
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!(req as AuthedRequest).user) return next(unauthorized());
  next();
}

export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = (req as AuthedRequest).user;
    if (!user) return next(unauthorized());
    const granted = permissions.some((permission) => user.permissions.includes(permission));
    if (!granted) {
      return next(forbidden(`This action needs the "${permissions.join('" or "')}" permission.`));
    }
    next();
  };
}

export function can(user: PublicUser, permission: Permission): boolean {
  return user.permissions.includes(permission);
}

/**
 * Teams whose tickets this user may see. `null` means "everything" - returned
 * for users holding tickets.view_all.
 */
export function visibleTeamIds(user: PublicUser): string[] | null {
  if (can(user, 'tickets.view_all')) return null;
  return user.teamIds;
}
