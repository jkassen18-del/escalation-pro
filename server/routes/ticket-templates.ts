import { Router } from 'express';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { asyncRoute, badRequest, forbidden, notFound, optionalString } from '../lib/http.ts';
import { lengthWithoutInlineImages } from '../lib/inline-images.ts';
import { can, requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.ts';
import {
  asFormFields,
  canUseTemplate,
  deleteTemplate,
  findTemplate,
  listTemplates,
  renderSubject,
  saveTemplate,
  validateTemplate,
} from '../repositories/ticket-templates.ts';
import { createTicket } from '../services/tickets.ts';

/**
 * Quick-ticket templates: managed by whoever manages teams, used by anyone
 * who can raise a ticket.
 */
export const ticketTemplatesRouter: Router = Router();
ticketTemplatesRouter.use(requireAuth);

/**
 * The templates this person can use. Team managers can ask for all of them
 * (`?all=1`), including disabled ones and ones meant for other teams.
 */
ticketTemplatesRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const templates = await listTemplates();
    if (req.query.all === '1' && can(user, 'teams.manage')) {
      res.json({ templates });
      return;
    }
    res.json({ templates: can(user, 'tickets.create') ? templates.filter((template) => canUseTemplate(template, user)) : [] });
  }),
);

ticketTemplatesRouter.post(
  '/',
  requirePermission('teams.manage'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const template = await saveTemplate(null, validateTemplate(req.body ?? {}), user.id);
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'team',
      entityId: template.teamId,
      action: 'template_created',
      summary: `Created quick ticket "${template.name}" for ${template.teamName ?? 'a team'}`,
      ip: clientIp(req),
    });
    res.status(201).json({ template });
  }),
);

ticketTemplatesRouter.put(
  '/:id',
  requirePermission('teams.manage'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const previous = await findTemplate(req.params.id);
    if (!previous) throw notFound('That quick ticket no longer exists.');
    const template = await saveTemplate(previous.id, validateTemplate(req.body ?? {}, previous), user.id);
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'team',
      entityId: template.teamId,
      action: 'template_updated',
      summary: `Updated quick ticket "${template.name}"`,
      ip: clientIp(req),
    });
    res.json({ template });
  }),
);

ticketTemplatesRouter.delete(
  '/:id',
  requirePermission('teams.manage'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const template = await findTemplate(req.params.id);
    if (!template) throw notFound('That quick ticket no longer exists.');
    await deleteTemplate(template.id);
    await recordAudit({
      actorId: user.id,
      actorName: user.name,
      entityType: 'team',
      entityId: template.teamId,
      action: 'template_deleted',
      summary: `Deleted quick ticket "${template.name}"`,
      ip: clientIp(req),
    });
    res.status(204).end();
  }),
);

/**
 * Raises a ticket from a template.
 *
 * Everything the template decides is taken from the template, never from the
 * request: a client cannot send a quick ticket to a different department or
 * at a different priority by editing the payload.
 */
ticketTemplatesRouter.post(
  '/:id/tickets',
  requirePermission('tickets.create'),
  asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const template = await findTemplate(req.params.id);
    if (!template) throw notFound('That quick ticket no longer exists.');
    if (!template.teamId) throw badRequest('This quick ticket has no department any more. Ask an administrator to fix it.');
    if (!canUseTemplate(template, user)) throw forbidden('This quick ticket is not available to you.');

    const description = typeof req.body?.description === 'string' ? req.body.description : '';
    if (lengthWithoutInlineImages(description) > 400_000) throw badRequest('The details are too long.', { description: 'Too long' });
    const summary = optionalString(req.body?.summary, 150) ?? '';
    const answers = (req.body?.answers ?? {}) as Record<string, unknown>;

    /*
     * "Required" is checked here for screenshots pasted into the details. One
     * added with the file picker is uploaded straight after the ticket is
     * created, so the client says how many are on their way; that half is a
     * prompt for a person, not a control, and is documented as such.
     */
    const pending = Number(req.body?.screenshotsToFollow ?? 0);
    if (template.screenshot === 'required' && !/<img\b/i.test(description) && !(pending > 0)) {
      throw badRequest(`"${template.name}" needs a screenshot. Paste one into the details or add one.`, { screenshot: 'Required' });
    }

    const ticket = await createTicket(
      {
        subject: renderSubject(template, answers, { summary, requester: user.name }),
        description,
        descriptionFormat: 'html',
        teamId: template.teamId,
        requesterId: user.id,
        priority: template.priority,
        type: template.ticketType,
        severity: template.severity,
        source: 'web',
        tags: template.tags,
        customFields: (req.body?.customFields ?? {}) as Record<string, unknown>,
        extraFields: asFormFields(template),
        extraAnswers: answers,
        templateId: template.id,
      },
      { actor: user, ip: clientIp(req), origin: `${req.protocol}://${req.get('host')}` },
    );
    res.status(201).json({ ticket });
  }),
);
