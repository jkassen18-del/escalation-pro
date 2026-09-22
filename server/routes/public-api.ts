import { Router, type Request, type Response, type NextFunction } from 'express';
import { db } from '../db/index.ts';
import { asyncRoute, badRequest, forbidden, notFound, requireString, optionalString, unauthorized, HttpError } from '../lib/http.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { checkLimit, recordFailure } from '../lib/rate-limit.ts';
import { touchApiKey, verifyApiKey, type ApiKey } from '../repositories/api-keys.ts';
import { findUserById } from '../repositories/users.ts';
import { findTeamById, listTeams } from '../repositories/teams.ts';
import { getSettings } from '../repositories/settings.ts';
import { addLink, findTicket, loadTicketDetail, recordEvent } from '../repositories/tickets.ts';
import { createTicket } from '../services/tickets.ts';
import { randomId } from '../lib/crypto.ts';
import { notifyUsers } from '../lib/notifications.ts';
import {
  TICKET_PRIORITIES,
  TICKET_TYPES,
  type Permission,
  type PublicUser,
  type TicketPriority,
  type TicketType,
} from '../../shared/types.ts';

/**
 * The HTTPS API.
 *
 * Anything that can make an HTTPS request can raise a ticket: a monitoring
 * tool, a cron job, a form on an intranet page, a script on somebody's
 * laptop. That is a different trust model from the rest of the app - there is
 * no session, no browser, and no person present to be asked anything - so it
 * is a separate router with its own authentication rather than a flag on the
 * existing one.
 *
 * Versioned in the path from the first release. The callers are other
 * people's systems and cannot be changed in step with this one, so there has
 * to be somewhere for a v2 to go that does not break them.
 */
export const publicApiRouter: Router = Router();

interface ApiRequest extends Request {
  apiKey: ApiKey;
  /** The account the key acts as: whoever created it. */
  actor: PublicUser;
}

/**
 * A key is allowed at most what its creator held.
 *
 * Checked at call time rather than only at creation, because the creator's
 * own permissions can be reduced afterwards - and a key that outlives its
 * owner's authority is how a revoked admin keeps administering.
 */
function keyCan(request: ApiRequest, permission: Permission): boolean {
  return request.apiKey.scopes.includes(permission) && request.actor.permissions.includes(permission);
}

function requireScope(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!keyCan(req as ApiRequest, permission)) {
      return next(forbidden(`This API key does not have the "${permission}" scope.`));
    }
    next();
  };
}

/** Bearer-token authentication, with a limit on how fast keys can be guessed. */
const authenticate = asyncRoute(async (req: Request, res: Response, next: NextFunction) => {
  const header = req.header('authorization') ?? '';
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? req.header('x-api-key') ?? '';

  if (!token) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="api"');
    throw unauthorized('Send an API key as "Authorization: Bearer itk_...".');
  }

  /*
   * Rate limited by address before the key is looked at, so the endpoint
   * cannot be used to enumerate valid prefixes at speed.
   */
  const ip = clientIp(req);
  const limitKey = `apikey:${ip}`;
  const limit = await checkLimit(limitKey, { max: 20, windowMs: 15 * 60 * 1000 });
  if (limit.blocked) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    throw new HttpError(429, 'Too many rejected API keys from this address. Try again shortly.');
  }

  const verified = await verifyApiKey(token);
  if (!verified.ok) {
    await recordFailure([limitKey]);
    res.setHeader('WWW-Authenticate', 'Bearer realm="api"');
    // Named causes for the two a caller can act on; a wrong key stays vague.
    const message =
      verified.reason === 'expired'
        ? 'That API key has expired.'
        : verified.reason === 'revoked'
          ? 'That API key has been revoked.'
          : 'That API key is not valid.';
    throw unauthorized(message);
  }

  const actor = verified.key.createdBy ? await findUserById(verified.key.createdBy) : null;
  if (!actor || actor.status !== 'active') {
    throw unauthorized('The account this API key belongs to is no longer active.');
  }

  (req as ApiRequest).apiKey = verified.key;
  (req as ApiRequest).actor = actor;
  void touchApiKey(verified.key.id);
  next();
});

publicApiRouter.use(authenticate);

/** Who the key is, which is the cheapest way to check one works. */
publicApiRouter.get(
  '/whoami',
  asyncRoute(async (req, res) => {
    const request = req as ApiRequest;
    res.json({
      key: { name: request.apiKey.name, prefix: request.apiKey.prefix, scopes: request.apiKey.scopes },
      actor: { id: request.actor.id, name: request.actor.name, email: request.actor.email },
    });
  }),
);

/** The departments a ticket can be raised against, so a caller need not guess. */
publicApiRouter.get(
  '/teams',
  requireScope('tickets.create'),
  asyncRoute(async (_req, res) => {
    const teams = await listTeams();
    res.json({ teams: teams.map((team) => ({ id: team.id, key: team.key, name: team.name })) });
  }),
);

/**
 * Finds a department by id, key or name.
 *
 * A script written by somebody else should not have to know internal ids, and
 * "finance" is what they will send. Matching the key and the name too makes
 * the obvious thing work.
 */
async function resolveTeam(value: string | null | undefined): Promise<string | null> {
  const wanted = (value ?? '').trim();
  if (!wanted) return null;

  const byId = await findTeamById(wanted);
  if (byId) return byId.id;

  const normalise = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const teams = await listTeams();
  const match =
    teams.find((team) => normalise(team.key) === normalise(wanted)) ??
    teams.find((team) => normalise(team.name) === normalise(wanted));
  return match?.id ?? null;
}

/**
 * The ticket an earlier call with this deduplication key produced, if it is
 * still open.
 *
 * This is what makes the endpoint safe for a monitoring tool. Those retry on
 * timeouts and re-fire while a condition persists, so without it one flapping
 * disk fills the queue with hundreds of identical tickets. A closed ticket is
 * deliberately not matched: the condition returning after it was dealt with
 * is a new incident, not a continuation of the old one.
 */
async function findByDedupeKey(dedupeKey: string): Promise<string | null> {
  const row = await db.get<{ ticket_id: string; status: string }>(
    `SELECT l.ticket_id AS ticket_id, t.status AS status
     FROM ticket_links l JOIN tickets t ON t.id = l.ticket_id
     WHERE l.provider = 'api_dedupe' AND l.external_id = ?
     ORDER BY l.created_at DESC`,
    [dedupeKey],
  );
  if (!row) return null;
  return row.status === 'closed' || row.status === 'resolved' ? null : row.ticket_id;
}

publicApiRouter.post(
  '/tickets',
  requireScope('tickets.create'),
  asyncRoute(async (req, res) => {
    const request = req as ApiRequest;
    const settings = await getSettings();

    const subject = requireString(req.body?.subject, 'subject', { max: 200 });
    const dedupeKey = optionalString(req.body?.dedupeKey ?? req.header('idempotency-key'), 200);

    /*
     * A repeat of an alert that is still open becomes a comment on the ticket
     * it already made, and the response says which - so a caller that cannot
     * tell the difference still ends up pointing at the right ticket.
     */
    if (dedupeKey) {
      const existingId = await findByDedupeKey(dedupeKey);
      if (existingId) {
        const existing = await findTicket(existingId, settings.ticketPrefix);
        if (existing) {
          const body = optionalString(req.body?.description, 20_000);
          if (body) {
            const now = new Date().toISOString();
            await db.run(
              `INSERT INTO ticket_comments (id, ticket_id, author_id, body, body_format, is_internal, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'text', 0, ?, ?)`,
              [randomId(), existing.id, request.actor.id, `Repeat from ${request.apiKey.name}:\n\n${body}`, now, now],
            );
          }
          res.setHeader('Location', `/api/v1/tickets/${existing.reference}`);
          return res.status(200).json({ ticket: publicTicket(existing), deduplicated: true });
        }
      }
    }

    const teamId =
      (await resolveTeam(optionalString(req.body?.team, 120))) ??
      request.apiKey.defaultTeamId ??
      settings.defaultTeamId;

    if (req.body?.team && !teamId) {
      throw badRequest(`No department matches "${String(req.body.team)}". GET /api/v1/teams lists them.`);
    }

    const priority = (optionalString(req.body?.priority, 20) ?? settings.defaultPriority) as TicketPriority;
    if (!TICKET_PRIORITIES.includes(priority)) {
      throw badRequest(`priority must be one of: ${TICKET_PRIORITIES.join(', ')}.`);
    }
    const type = (optionalString(req.body?.type, 20) ?? 'incident') as TicketType;
    if (!TICKET_TYPES.includes(type)) {
      throw badRequest(`type must be one of: ${TICKET_TYPES.join(', ')}.`);
    }

    const ticket = await createTicket(
      {
        subject,
        description: optionalString(req.body?.description, 20_000) ?? '',
        descriptionFormat: 'text',
        teamId,
        priority,
        type,
        source: 'api',
        tags: Array.isArray(req.body?.tags)
          ? req.body.tags.filter((tag: unknown) => typeof tag === 'string').slice(0, 20)
          : [],
        customFields: (req.body?.fields ?? {}) as Record<string, unknown>,
      },
      { actor: request.actor, ip: clientIp(req) },
    );

    // Recorded after the ticket exists, so a failed create leaves no key
    // behind that would suppress the next attempt.
    if (dedupeKey) await addLink(ticket.id, 'api_dedupe', dedupeKey, request.apiKey.id, '');

    await recordAudit({
      actorId: request.actor.id,
      actorName: `${request.apiKey.name} (API key)`,
      entityType: 'ticket',
      entityId: ticket.id,
      action: 'ticket_created_via_api',
      summary: `${request.apiKey.name} raised ${ticket.reference} over the API`,
      ip: clientIp(req),
    });

    res.setHeader('Location', `/api/v1/tickets/${ticket.reference}`);
    res.status(201).json({ ticket: publicTicket(ticket) });
  }),
);

/** The shape the API promises, which is not the internal one. */
function publicTicket(ticket: Awaited<ReturnType<typeof findTicket>> extends infer T ? NonNullable<T> : never) {
  return {
    id: ticket.id,
    reference: ticket.reference,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    type: ticket.type,
    team: ticket.teamName,
    assignee: ticket.assigneeName,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    dueAt: ticket.dueAt,
  };
}

publicApiRouter.get(
  '/tickets/:reference',
  requireScope('tickets.create'),
  asyncRoute(async (req, res) => {
    const settings = await getSettings();
    const ticket = await findTicket(req.params.reference, settings.ticketPrefix);
    if (!ticket) throw notFound('No such ticket.');
    res.json({ ticket: publicTicket(ticket) });
  }),
);

publicApiRouter.post(
  '/tickets/:reference/comments',
  requireScope('tickets.create'),
  asyncRoute(async (req, res) => {
    const request = req as ApiRequest;
    const settings = await getSettings();
    const ticket = await findTicket(req.params.reference, settings.ticketPrefix);
    if (!ticket) throw notFound('No such ticket.');

    const body = requireString(req.body?.body, 'body', { max: 20_000 });
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO ticket_comments (id, ticket_id, author_id, body, body_format, is_internal, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'text', 0, ?, ?)`,
      [randomId(), ticket.id, request.actor.id, body, now, now],
    );
    await recordEvent(ticket.id, request.actor.id, 'commented', 'source', null, 'api');

    const recipients = [ticket.requesterId, ticket.assigneeId, ...ticket.watcherIds].filter(
      (id): id is string => Boolean(id) && id !== request.actor.id,
    );
    await notifyUsers(recipients, {
      ticketId: ticket.id,
      type: 'comment',
      title: `${request.apiKey.name} commented on ${ticket.reference}`,
      body: body.slice(0, 280),
    });

    const detail = await loadTicketDetail(ticket, { includeInternal: false });
    res.status(201).json({ ticket: publicTicket(ticket), comments: detail.comments.length });
  }),
);
