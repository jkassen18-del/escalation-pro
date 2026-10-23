import { Router, type Request } from 'express';
import { db } from '../db/index.ts';
import {
  HttpError,
  asyncRoute,
  badRequest,
  conflict,
  forbidden,
  isValidEmail,
  notFound,
  optionalString,
  parseIntOr,
  requireString,
  toStringArray,
} from '../lib/http.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { notifyUsers } from '../lib/notifications.ts';
import { checkLimit, recordFailure, type LimitRule } from '../lib/rate-limit.ts';
import { requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
import { ungrantablePermissions } from '../permissions.ts';
import {
  claimInviteUse,
  completeInviteUse,
  createInvite,
  findInviteByToken,
  getInvite,
  listInvites,
  releaseInviteUse,
  revokeInvite,
} from '../repositories/invites.ts';
import { getRole } from '../repositories/roles.ts';
import { getSettings } from '../repositories/settings.ts';
import { listTeams } from '../repositories/teams.ts';
import { createUser, emailInUse, findUserById, listUsers, usernameInUse } from '../repositories/users.ts';
import { passwordLoginBlocked } from './sso.ts';
import type { Invite, InvitePreview, PublicUser, Role } from '../../shared/types.ts';

/**
 * Invite links: an admin makes one, shares it, and people sign themselves up
 * into a department with the role the invite carries. Being made a
 * department manager comes afterwards, from an admin.
 */
export const invitesRouter: Router = Router();
invitesRouter.use(requireAuth);

const DAY_MS = 86_400_000;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Everyone who could be told about sign-ups: active people who manage users. */
async function inviteAdmins(): Promise<PublicUser[]> {
  return (await listUsers({ activeOnly: true })).filter(
    (user) => user.permissions.includes('users.update') || user.permissions.includes('teams.manage'),
  );
}

function readDomains(value: unknown): string[] {
  const domains = toStringArray(value, 20)
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  const bad = domains.find((domain) => !DOMAIN.test(domain));
  if (bad) throw badRequest(`"${bad}" is not an email domain, e.g. goldmedialab.com.`, { allowedDomains: 'Invalid' });
  return Array.from(new Set(domains));
}

function inviteUrl(req: Request, base: string, token: string): string {
  const origin = base || `${req.protocol}://${req.get('host')}`;
  return `${origin.replace(/\/+$/, '')}/invite/${token}`;
}

/** Handing out a role is granting its permissions, so the usual rule applies. */
function assertRoleGrantable(actor: PublicUser, role: Role): void {
  if (role.systemKey === 'admin' && actor.role !== 'admin') {
    throw forbidden('Only an administrator can invite administrators.');
  }
  const refused = ungrantablePermissions(actor, role.permissions);
  if (refused.length) {
    throw forbidden(`The "${role.name}" role includes permissions you do not hold, so you cannot invite people into it.`);
  }
}

invitesRouter.get(
  '/',
  requirePermission('users.invite'),
  asyncRoute(async (_req, res) => {
    res.json({ invites: await listInvites() });
  }),
);

invitesRouter.post(
  '/',
  requirePermission('users.invite'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const body = req.body ?? {};

    const role = await getRole(requireString(body.roleId, 'Role', { max: 60 }));
    if (!role) throw badRequest('That role does not exist.', { roleId: 'Unknown role' });
    assertRoleGrantable(actor, role);

    const email = optionalString(body.email, 160)?.toLowerCase() ?? null;
    if (email && !isValidEmail(email)) throw badRequest('Enter a valid email address.', { email: 'Invalid' });
    const allowedDomains = readDomains(body.allowedDomains);
    if (email && allowedDomains.length && !allowedDomains.includes(email.split('@')[1])) {
      throw badRequest('That email address is not on one of the allowed domains.', { email: 'Domain' });
    }
    if (email && (await emailInUse(email))) throw conflict('Someone already has an account with that email.');

    const teams = await listTeams();
    const teamIds = Array.from(new Set(toStringArray(body.teamIds, 200)));
    const unknown = teamIds.find((id) => !teams.some((team) => team.id === id));
    if (unknown) throw badRequest('One of those departments does not exist.', { teamIds: 'Unknown' });
    if (!teams.length) throw badRequest('Create a department first: people pick theirs when they accept.');

    const days = parseIntOr(body.expiresInDays, 7, { min: 1, max: 90 });
    // A link for one person is single-use; a shareable one is unlimited unless capped.
    const maxUses = email ? 1 : body.maxUses === null || body.maxUses === undefined || body.maxUses === '' ? null : parseIntOr(body.maxUses, 1, { min: 1, max: 10_000 });

    const { invite, token } = await createInvite({
      label: optionalString(body.label, 120),
      roleId: role.id,
      email,
      allowedDomains,
      teamIds,
      maxUses,
      expiresAt: new Date(Date.now() + days * DAY_MS).toISOString(),
      createdBy: actor.id,
    });

    const settings = await getSettings();
    const url = inviteUrl(req, settings.appUrl || process.env.APP_URL || '', token);

    let emailed: { ok: boolean; error: string | null } | null = null;
    if (email && body.sendEmail !== false) {
      const { loadIntegration } = await import('../integrations/store.ts');
      const { sendPlainEmail } = await import('../integrations/email.ts');
      const organization = settings.organizationName || 'InfraTicket';
      emailed = await sendPlainEmail(await loadIntegration('email'), email, {
        subject: `You're invited to ${organization}'s service desk`,
        text:
          `${actor.name} has invited you to ${organization}'s service desk.\n\n` +
          `Open this link to set up your account (it expires ${new Date(invite.expiresAt).toUTCString()}):\n${url}\n`,
      });
    }

    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'invite',
      entityId: invite.id,
      action: 'invite_created',
      summary: `Created an invite${invite.label ? ` "${invite.label}"` : ''}${email ? ` for ${email}` : ''} as ${role.name}`,
      meta: { roleId: role.id, allowedDomains, teamIds, maxUses, expiresAt: invite.expiresAt },
      ip: clientIp(req),
    });

    // The token leaves the server here and nowhere else.
    res.status(201).json({ invite, token, url, emailed });
  }),
);

invitesRouter.delete(
  '/:id',
  requirePermission('users.invite'),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthedRequest).user;
    const invite = await getInvite(req.params.id);
    if (!invite) throw notFound('That invite does not exist.');
    await revokeInvite(invite.id);
    await recordAudit({
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'invite',
      entityId: invite.id,
      action: 'invite_revoked',
      summary: `Revoked the invite${invite.label ? ` "${invite.label}"` : ''}${invite.email ? ` for ${invite.email}` : ''}`,
      ip: clientIp(req),
    });
    res.json({ invite: await getInvite(invite.id) });
  }),
);

/* ------------------------------ Public side ------------------------------ */

/**
 * Mounted before the session user is resolved: whoever has the link is not
 * signed in yet. Every failure looks the same, so a guessed token learns
 * nothing about which invites exist, have expired or were revoked.
 */
export const invitePublicRouter: Router = Router();

const INVITE_LIMIT: LimitRule = { max: 20, windowMs: 15 * 60 * 1000 };
const GONE = 'This invite link is not valid. It may have expired or been withdrawn; ask whoever sent it for a new one.';

async function openInvite(req: Request): Promise<Invite> {
  const key = `invite-ip:${clientIp(req)}`;
  const limit = await checkLimit(key, INVITE_LIMIT);
  if (limit.blocked) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`);
  const invite = await findInviteByToken(String(req.params.token ?? ''));
  if (!invite || invite.status !== 'active') {
    await recordFailure([key]);
    throw new HttpError(404, GONE);
  }
  return invite;
}

async function departmentsFor(invite: Invite) {
  const teams = await listTeams();
  return teams
    .filter((team) => !invite.teamIds.length || invite.teamIds.includes(team.id))
    .map((team) => ({ id: team.id, name: team.name }));
}

invitePublicRouter.get(
  '/:token',
  asyncRoute(async (req, res) => {
    const invite = await openInvite(req);
    const settings = await getSettings();
    const preview: InvitePreview = {
      organizationName: settings.organizationName,
      label: invite.label,
      email: invite.email,
      allowedDomains: invite.allowedDomains,
      departments: await departmentsFor(invite),
      expiresAt: invite.expiresAt,
    };
    res.json({ invite: preview });
  }),
);

invitePublicRouter.post(
  '/:token/accept',
  asyncRoute(async (req, res) => {
    const invite = await openInvite(req);
    const body = req.body ?? {};

    const firstName = requireString(body.firstName, 'First name', { max: 60 });
    const lastName = requireString(body.lastName, 'Surname', { max: 60 });
    const email = requireString(body.email, 'Company email', { max: 160 }).toLowerCase();
    if (!isValidEmail(email)) throw badRequest('Enter a valid email address.', { email: 'Invalid' });
    if (invite.email && email !== invite.email) {
      throw badRequest('This invite is for a different email address.', { email: 'Mismatch' });
    }
    const domain = email.split('@')[1];
    if (invite.allowedDomains.length && !invite.allowedDomains.includes(domain)) {
      throw badRequest(`Use your company email address (${invite.allowedDomains.map((d) => `@${d}`).join(' or ')}).`, { email: 'Domain' });
    }
    const password = requireString(body.password, 'Password', { min: 10, max: 200 });
    const teamId = requireString(body.teamId, 'Department', { max: 60 });
    const departments = await departmentsFor(invite);
    if (!departments.some((team) => team.id === teamId)) throw badRequest('Pick one of the departments listed.', { teamId: 'Unknown' });

    const role = await getRole(invite.roleId);
    if (!role) throw new HttpError(404, GONE);

    // The one thing a sign-up form has to say: the address is taken. It says
    // nothing about the account beyond that.
    if (await emailInUse(email)) throw conflict('An account with that email already exists. Sign in instead, or reset your password.');

    let username = email.split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '') || 'user';
    for (let n = 2; await usernameInUse(username); n += 1) username = `${email.split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '')}${n}`;

    const claim = await claimInviteUse(invite.id);
    if (!claim) throw new HttpError(404, GONE);

    let userId: string;
    try {
      userId = await db.transaction(async () =>
        createUser({
          email,
          username,
          name: `${firstName} ${lastName}`,
          password,
          role: role.tier,
          roleId: role.id,
          teamIds: [teamId],
          // Department managers are chosen by an admin afterwards.
          managedTeamIds: [],
          mustChangePassword: false,
          status: 'active',
        }),
      );
    } catch (error) {
      await releaseInviteUse(invite.id, claim);
      throw error;
    }
    await completeInviteUse(invite.id, claim, userId);
    const user = (await findUserById(userId))!;
    const department = departments.find((team) => team.id === teamId)!;

    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'invite',
      entityId: invite.id,
      action: 'invite_accepted',
      summary: `${user.name} (${email}) joined ${department.name} as ${role.name} through an invite`,
      meta: { userId: user.id, teamId, roleId: role.id },
      ip: clientIp(req),
    });
    await notifyUsers(
      (await inviteAdmins()).map((admin) => admin.id),
      {
        type: 'user_joined',
        title: `${user.name} joined ${department.name}`,
        body: `${email} accepted an invite as ${role.name}. Make them a department manager from People or Teams if they should be one.`,
      },
    );

    // Where password sign-in is switched off for this role, the account is
    // made but they sign in through single sign-on, not here.
    if (await passwordLoginBlocked(role.tier)) {
      res.status(201).json({ user: null, ssoRequired: true });
      return;
    }

    await new Promise<void>((resolve, reject) => req.session.regenerate((error) => (error ? reject(error) : resolve())));
    req.session.userId = user.id;
    await db.run(`UPDATE users SET last_login_at = ? WHERE id = ?`, [new Date().toISOString(), user.id]);
    res.status(201).json({ user, ssoRequired: false });
  }),
);
