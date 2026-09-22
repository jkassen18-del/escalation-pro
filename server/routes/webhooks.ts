import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { db } from '../db/index.ts';
import { asyncRoute, HttpError } from '../lib/http.ts';
import { recordAudit } from '../lib/audit.ts';
import { notifyUsers } from '../lib/notifications.ts';
import { loadIntegration } from '../integrations/store.ts';
import {
  departmentForLinearTeam,
  findUserForLinearActor,
  mapLinearStateToStatus,
  priorityFromLinear,
  type LinearConfig,
} from '../integrations/linear.ts';
import { findUserById } from '../repositories/users.ts';
import { findTicketBySlackThread, type SlackConfig } from '../integrations/slack.ts';
import {
  isThreadReply,
  resolveSlackAuthor,
  slackTextToPlain,
  verifySlackSignature,
  type SlackEventEnvelope,
} from '../integrations/slack-events.ts';
import {
  applyStatus,
  parseInteractivePayload,
  type SlackInteractivePayload,
  resolveActor,
  respondEphemeral,
  statusForAction,
} from '../integrations/slack-actions.ts';
import { matchTeam, parseSlashCommand, slackApi } from '../integrations/slack-commands.ts';
import { verifyTeamsRequest } from '../integrations/teams-auth.ts';
import { isFromPerson, sendActivity, stripMention, type TeamsActivity } from '../integrations/teams-bot.ts';
import {
  findTicketByTeamsThread,
  resolveTeamsActor,
  resolveTeamsAuthor,
  teamsTextToPlain,
} from '../integrations/teams-events.ts';
import {
  asAttachment,
  buildConfirmationCard,
  buildTicketCard,
  readCardSubmission,
  TICKET_CARD_ACTION,
} from '../integrations/teams-cards.ts';
import { rememberConversation } from '../repositories/teams-conversations.ts';
import type { MsTeamsConfig } from '../integrations/msteams.ts';
import { buildTicketModal, readSubmission, TEAM_ACTION, TICKET_MODAL_CALLBACK } from '../integrations/slack-modal.ts';
import { listTeams } from '../repositories/teams.ts';
import { listTeamFields } from '../repositories/form-fields.ts';
import { createTicket } from '../services/tickets.ts';
import { dispatch, buildTicketUrl } from '../integrations/dispatcher.ts';
import { addLink, findTicket, recordEvent } from '../repositories/tickets.ts';
import type { TicketPriority } from '../../shared/types.ts';
import { getSettings } from '../repositories/settings.ts';
import { randomId } from '../lib/crypto.ts';

export const webhooksRouter: Router = Router();

/**
 * Linear signs each delivery with an HMAC-SHA256 of the raw body using the
 * webhook secret. We compare against the raw buffer captured by the JSON
 * parser's `verify` hook, because re-serialising would change the bytes.
 */
function verifyLinearSignature(req: Request, secret: string): boolean {
  const signature = req.header('linear-signature');
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!signature || !raw) return false;

  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Inbound Linear events. Keeps a mirrored ticket's status in step when the
 * issue is moved on the Linear side.
 */
webhooksRouter.post(
  '/linear',
  asyncRoute(async (req, res) => {
    const record = await loadIntegration('linear');
    const config = record.config as LinearConfig;

    if (!record.enabled) return res.status(503).json({ error: 'Linear integration is disabled' });
    if (!config.webhookSecret) return res.status(400).json({ error: 'No webhook secret configured' });
    if (!verifyLinearSignature(req, config.webhookSecret)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = req.body as {
      action?: string;
      type?: string;
      data?: {
        id?: string;
        identifier?: string;
        title?: string;
        description?: string;
        priority?: number;
        teamId?: string;
        creatorId?: string;
        state?: { type?: string; name?: string };
      };
    };

    if (payload.type !== 'Issue' || !payload.data?.id) return res.json({ ok: true, ignored: true });

    const link = await db.get<{ ticket_id: string }>(
      `SELECT ticket_id FROM ticket_links WHERE provider = 'linear' AND external_id = ?`,
      [payload.data.id],
    );

    /*
     * An issue raised in Linear, in a team mapped to a department, becomes a
     * ticket here. Linear has no slash commands for third-party apps, so
     * raising an issue the normal way is how somebody working in Linear opens
     * a ticket - and the mapping is the same per-department routing that
     * decides where a ticket's issues are mirrored to.
     *
     * Only when there is no link: an issue this app created is already a
     * ticket, and turning it into a second one is the loop that makes a
     * two-way sync eat itself.
     */
    if (!link && payload.action === 'create') {
      return createTicketFromLinearIssue(payload.data, config, res);
    }

    if (!link) return res.json({ ok: true, ignored: true });

    const nextStatus = payload.data.state?.type ? mapLinearStateToStatus(payload.data.state.type) : null;
    if (!nextStatus) return res.json({ ok: true, ignored: true });

    const ticket = await db.get<{ status: string; number: number }>(
      `SELECT status, number FROM tickets WHERE id = ?`,
      [link.ticket_id],
    );
    if (!ticket || ticket.status === nextStatus) return res.json({ ok: true, ignored: true });

    const now = new Date().toISOString();
    await db.run(
      `UPDATE tickets SET status = ?, updated_at = ?,
        resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END,
        closed_at = CASE WHEN ? = 'closed' THEN ? ELSE closed_at END
       WHERE id = ?`,
      [nextStatus, now, nextStatus, now, nextStatus, now, link.ticket_id],
    );
    await recordEvent(link.ticket_id, null, 'synced', 'status', ticket.status, nextStatus);

    const watchers = await db.all<{ user_id: string }>(
      `SELECT user_id FROM ticket_watchers WHERE ticket_id = ?`,
      [link.ticket_id],
    );
    await notifyUsers(
      watchers.map((row) => row.user_id),
      {
        ticketId: link.ticket_id,
        type: 'status',
        title: `Linear moved this ticket to ${nextStatus.replace('_', ' ')}`,
        body: payload.data.identifier ? `Synced from ${payload.data.identifier}` : null,
      },
    );

    await recordAudit({
      actorName: 'Linear',
      entityType: 'ticket',
      entityId: link.ticket_id,
      action: 'status_synced',
      summary: `Linear moved the ticket to ${nextStatus}`,
      meta: { identifier: payload.data.identifier },
    });

    res.json({ ok: true, status: nextStatus });
  }),
);

/* --------------------------- Slack replies -------------------------------- */

/**
 * Inbound Slack events.
 *
 * Every ticket gets one thread in the channel, and a reply typed there becomes
 * a comment on that ticket - so the people who work in Slack do not have to
 * open the app to answer, and the requester still gets told.
 */
webhooksRouter.post(
  '/slack',
  asyncRoute(async (req, res) => {
    const envelope = req.body as SlackEventEnvelope;

    const record = await loadIntegration('slack');
    const config = record.config as SlackConfig;

    /*
     * Slack verifies the URL by posting a challenge when it is first saved.
     * This is answered before the enabled/secret checks, because otherwise the
     * endpoint cannot be registered until the integration is already working -
     * and the secret it would be verified with is the one being set up.
     */
    if (envelope.type === 'url_verification') {
      if (!envelope.challenge) return res.status(400).json({ error: 'No challenge supplied' });
      return res.json({ challenge: envelope.challenge });
    }

    if (!record.enabled) return res.status(503).json({ error: 'Slack integration is disabled' });
    if (!config.signingSecret) return res.status(400).json({ error: 'No Slack signing secret configured' });

    const verified = verifySlackSignature(req, config.signingSecret);
    if (!verified.ok) return res.status(401).json({ error: verified.reason });

    // Everything past here is accepted with 200 whatever happens: Slack retries
    // anything else, and a retry would post the same comment a second time.
    if (envelope.type !== 'event_callback' || !isThreadReply(envelope.event)) {
      return res.json({ ok: true, ignored: true });
    }

    const event = envelope.event!;
    const ticketId = await findTicketBySlackThread(event.thread_ts!);
    if (!ticketId) return res.json({ ok: true, ignored: true });

    const settings = await getSettings();
    const ticket = await findTicket(ticketId, settings.ticketPrefix);
    if (!ticket) return res.json({ ok: true, ignored: true });

    /*
     * Slack redelivers on any non-2xx and on its own timeouts, so the message
     * timestamp - unique per message - is what stops a retry becoming a second
     * comment. Checked before writing rather than after.
     */
    const seen = await db.get<{ id: string }>(
      `SELECT id FROM ticket_links WHERE provider = 'slack_reply' AND external_id = ?`,
      [event.ts!],
    );
    if (seen) return res.json({ ok: true, duplicate: true });

    const author = await resolveSlackAuthor(config.botToken ?? '', event.user!);
    const body = slackTextToPlain(event.text ?? '');
    if (!body) return res.json({ ok: true, ignored: true });

    const now = new Date().toISOString();
    const commentId = randomId();

    await db.run(
      `INSERT INTO ticket_comments (id, ticket_id, author_id, body, body_format, is_internal, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'text', 0, ?, ?)`,
      [
        commentId,
        ticket.id,
        author.userId,
        // Named in the body when the writer is not a user here, so the comment
        // is never silently anonymous.
        author.userId ? body : `${author.displayName} replied in Slack:\n\n${body}`,
        now,
        now,
      ],
    );

    await db.run(`INSERT INTO ticket_links (id, ticket_id, provider, external_id, external_key, url, created_at)
       VALUES (?, ?, 'slack_reply', ?, ?, ?, ?)`,
      [randomId(), ticket.id, event.ts!, commentId, '', now]);

    await recordEvent(ticket.id, author.userId, 'commented', 'source', null, 'slack');

    /*
     * Tell the people who are waiting on this ticket. The author is left out:
     * they just wrote it.
     */
    const recipients = [ticket.requesterId, ticket.assigneeId, ...ticket.watcherIds].filter(
      (id): id is string => Boolean(id) && id !== author.userId,
    );
    await notifyUsers(recipients, {
      ticketId: ticket.id,
      type: 'comment',
      title: `${author.displayName} replied to ${ticket.reference} in Slack`,
      body: body.slice(0, 280),
    });

    await recordAudit({
      actorId: author.userId,
      actorName: author.displayName,
      entityType: 'ticket',
      entityId: ticket.id,
      action: 'comment_from_slack',
      summary: `${author.displayName} replied to ${ticket.reference} from Slack`,
    });

    // Out to the other channels, but not back to Slack - that is where it came
    // from, and the thread already shows it.
    await dispatch(
      {
        event: 'ticketCommented',
        ticket,
        actorName: author.displayName,
        headline: `${author.displayName} replied in Slack`,
        detail: body,
        ticketUrl: await buildTicketUrl(ticket),
      },
      { exclude: ['slack'] },
    );

    res.json({ ok: true, ticket: ticket.reference });
  }),
);

/* ------------------------ Slack button clicks ----------------------------- */

/**
 * Inbound Slack interactions: the Resolve/Close/Reopen buttons.
 *
 * Slack gives three seconds before it shows the person an error, so the work
 * is done first and kept short, and anything slow - telling the other
 * integrations - is left to run after the reply has gone.
 *
 * Every non-signature failure still answers 200 with an explanation: a
 * non-2xx makes Slack retry, and a retry of a button click is another attempt
 * at the same change.
 */
webhooksRouter.post(
  '/slack/interactive',
  asyncRoute(async (req, res) => {
    const record = await loadIntegration('slack');
    const config = record.config as SlackConfig;

    if (!record.enabled) return res.status(503).json({ error: 'Slack integration is disabled' });
    if (!config.signingSecret) return res.status(400).json({ error: 'No Slack signing secret configured' });

    const verified = verifySlackSignature(req, config.signingSecret);
    if (!verified.ok) return res.status(401).json({ error: verified.reason });

    const payload = parseInteractivePayload(req);
    if (!payload) return res.json({ ok: true, ignored: true });

    /*
     * Three different things arrive here. The modal's department picker and
     * its submission are handled first; whatever is left is a button on a
     * ticket message.
     */
    if (payload.type === 'block_actions' && payload.view?.id) {
      return respondToModalAction(payload, config, res);
    }
    if (payload.type === 'view_submission') {
      return respondToModalSubmission(payload, config, res);
    }

    const action = payload.actions?.[0];
    const next = action?.action_id ? statusForAction(action.action_id) : null;
    const ticketId = action?.value;
    const responseUrl = payload.response_url;

    // Something else in the app was clicked, or Slack sent a shape we do not
    // handle. Acknowledged and dropped.
    if (!next || !ticketId || !payload.user?.id) return res.json({ ok: true, ignored: true });

    const actor = await resolveActor(config.botToken ?? '', payload.user.id, 'tickets.update');
    if (!actor.ok) {
      if (responseUrl) await respondEphemeral(responseUrl, actor.message);
      return res.json({ ok: true, refused: true });
    }

    const settings = await getSettings();
    const ticket = await findTicket(ticketId, settings.ticketPrefix);
    if (!ticket) {
      if (responseUrl) await respondEphemeral(responseUrl, 'That ticket no longer exists.');
      return res.json({ ok: true, ignored: true });
    }

    const change = await applyStatus(ticket.id, next, actor.user.id);
    if (!change) return res.json({ ok: true, ignored: true });

    if (!change.changed) {
      if (responseUrl) {
        await respondEphemeral(responseUrl, `${ticket.reference} was already ${next.replace('_', ' ')}.`);
      }
      return res.json({ ok: true, unchanged: true });
    }

    await recordAudit({
      actorId: actor.user.id,
      actorName: actor.user.name,
      entityType: 'ticket',
      entityId: ticket.id,
      action: 'status_changed_from_slack',
      summary: `${actor.user.name} moved ${ticket.reference} to ${next} from Slack`,
      meta: { from: change.from, to: next },
    });

    const watchers = [ticket.requesterId, ticket.assigneeId, ...ticket.watcherIds].filter(
      (id): id is string => Boolean(id) && id !== actor.user.id,
    );
    await notifyUsers(watchers, {
      ticketId: ticket.id,
      type: 'status',
      title: `${actor.user.name} marked ${ticket.reference} ${next.replace('_', ' ')}`,
      body: `Changed from ${change.from.replace('_', ' ')} in Slack.`,
    });

    /*
     * Fanned out before the reply rather than after it. On a serverless host
     * the function can be frozen the moment the response ends, so work left
     * running past it may simply never happen - and Linear, Teams and email
     * would silently miss the change. Slack may time out its three seconds
     * and retry, which is safe: applyStatus is a no-op the second time.
     */
    const updated = await findTicket(ticket.id, settings.ticketPrefix);
    if (updated) {
      await dispatch({
        event: 'ticketStatusChanged',
        ticket: updated,
        actorName: actor.user.name,
        headline: `${updated.reference} moved to ${next.replace('_', ' ')}`,
        detail: `${change.from.replace('_', ' ')} → ${next.replace('_', ' ')} (from Slack)`,
        ticketUrl: await buildTicketUrl(updated),
      });
    }

    if (responseUrl) {
      await respondEphemeral(
        responseUrl,
        `${ticket.reference} is now *${next.replace('_', ' ')}*. Everyone watching it has been told.`,
      );
    }
    res.json({ ok: true, ticket: ticket.reference, status: next });
  }),
);

/* ---------------------- Slack slash command: /gml ------------------------- */

/**
 * Opens the ticket form in Slack.
 *
 * Slack expires the trigger_id after three seconds, so this does the least
 * possible before calling views.open: verify, resolve the person, read the
 * teams, open. Anything slower and the person sees "this app is not
 * responding" with no modal.
 */
webhooksRouter.post(
  '/slack/commands',
  asyncRoute(async (req, res) => {
    const record = await loadIntegration('slack');
    const config = record.config as SlackConfig;

    if (!record.enabled) return res.status(503).json({ error: 'Slack integration is disabled' });
    if (!config.signingSecret) return res.status(400).json({ error: 'No Slack signing secret configured' });

    const verified = verifySlackSignature(req, config.signingSecret);
    if (!verified.ok) return res.status(401).json({ error: verified.reason });

    const command = parseSlashCommand(req.body);
    if (!command) return res.json({ response_type: 'ephemeral', text: 'That command could not be read.' });

    if (!config.botToken) {
      return res.json({
        response_type: 'ephemeral',
        text: 'This workspace is connected with an incoming webhook, which cannot open a form. Ask an administrator to connect Slack with a bot token instead.',
      });
    }

    const actor = await resolveActor(config.botToken, command.user_id!, 'tickets.create');
    if (!actor.ok) return res.json({ response_type: 'ephemeral', text: actor.message });

    const teams = await listTeams();
    if (teams.length === 0) {
      return res.json({
        response_type: 'ephemeral',
        text: 'No departments have been set up yet, so there is nothing to raise a ticket against.',
      });
    }

    const selectedTeam = matchTeam(command.text, teams);
    const fields = selectedTeam ? await listTeamFields(selectedTeam.id) : [];

    const opened = await slackApi(config.botToken, 'views.open', {
      trigger_id: command.trigger_id,
      view: buildTicketModal({ teams, selectedTeam, fields, channelId: command.channel_id }),
    });

    if (!opened.ok) {
      // Answer in the channel rather than failing silently: the person is
      // staring at a chat box waiting for something to happen.
      return res.json({
        response_type: 'ephemeral',
        text: `Slack would not open the form: ${opened.error ?? 'unknown error'}.`,
      });
    }

    // 200 with an empty body is how Slack is told the command was handled.
    res.status(200).end();
  }),
);

/**
 * The department picker changed, so the form is rebuilt around it.
 *
 * views.update rather than a fresh modal: the person is mid-form, and
 * replacing the view would throw away the summary they have already typed.
 * Slack keeps the state of blocks that survive the update.
 */
async function respondToModalAction(
  payload: SlackInteractivePayload,
  config: SlackConfig,
  res: Response,
): Promise<Response> {
  const changed = payload.actions?.find((action) => action.action_id === TEAM_ACTION);
  // Any other control inside a modal is Slack's business, not ours.
  if (!changed || !config.botToken) return res.json({ ok: true, ignored: true });

  const teamId = changed.selected_option?.value ?? changed.value;
  const teams = await listTeams();
  const selectedTeam = teams.find((team) => team.id === teamId) ?? null;
  const fields = selectedTeam ? await listTeamFields(selectedTeam.id) : [];

  let channelId: string | null = null;
  try {
    channelId = (JSON.parse(payload.view?.private_metadata || '{}') as { channelId?: string }).channelId ?? null;
  } catch {
    // Unknown channel is survivable; the ticket is still raised.
  }

  await slackApi(config.botToken, 'views.update', {
    view_id: payload.view!.id,
    hash: payload.view!.hash,
    view: buildTicketModal({ teams, selectedTeam, fields, channelId: channelId ?? undefined }),
  });

  return res.json({ ok: true });
}

/**
 * The form was submitted.
 *
 * Slack allows three seconds and treats the response body as the verdict:
 * an empty 200 closes the modal, and `response_action: errors` keeps it open
 * with the message pinned under the offending field. So a rejected answer has
 * to be turned back into the block id it came from, or the person is told
 * something is wrong with no idea what.
 */
async function respondToModalSubmission(
  payload: SlackInteractivePayload,
  config: SlackConfig,
  res: Response,
): Promise<Response> {
  if (payload.view?.callback_id !== TICKET_MODAL_CALLBACK) return res.json({ ok: true, ignored: true });

  const actor = await resolveActor(config.botToken ?? '', payload.user?.id ?? '', 'tickets.create');
  if (!actor.ok) {
    return res.json({ response_action: 'errors', errors: { subject: actor.message.slice(0, 250) } });
  }

  const submitted = readSubmission(payload.view);
  if (!submitted.teamId) {
    return res.json({ response_action: 'errors', errors: { team_block: 'Choose a department.' } });
  }
  if (!submitted.subject) {
    return res.json({ response_action: 'errors', errors: { subject: 'Give it a one-line summary.' } });
  }

  try {
    const ticket = await createTicket(
      {
        subject: submitted.subject.slice(0, 200),
        description: submitted.description.slice(0, 20_000),
        descriptionFormat: 'text',
        teamId: submitted.teamId,
        priority: submitted.priority as TicketPriority,
        source: 'slack',
        customFields: submitted.customFields,
      },
      { actor: actor.user },
    );

    /*
     * Confirmed to the person who raised it, in the channel they ran the
     * command in. The department's own channel hears about it separately,
     * through the same routing every other ticket uses.
     */
    if (config.botToken && submitted.channelId) {
      await slackApi(config.botToken, 'chat.postEphemeral', {
        channel: submitted.channelId,
        user: payload.user!.id,
        text: `Raised *${ticket.reference}* — ${ticket.subject}`,
      });
    }

    // An empty 200 is what closes the modal.
    return res.json({});
  } catch (error) {
    /*
     * A rejected answer names the field it came from, and the block ids in
     * the modal are that key with a prefix, so the message lands under the
     * right input instead of a generic failure.
     */
    const errors: Record<string, string> = {};
    if (error instanceof HttpError && error.details) {
      for (const [key, message] of Object.entries(error.details)) {
        errors[key === 'teamId' ? 'team_block' : `field:${key}`] = String(message).slice(0, 250);
      }
    }
    if (Object.keys(errors).length === 0) {
      errors.subject = error instanceof Error ? error.message.slice(0, 250) : 'That could not be saved.';
    }
    return res.json({ response_action: 'errors', errors });
  }
}

/* ----------------------- Microsoft Teams bot ------------------------------ */

/**
 * The Teams bot's messaging endpoint.
 *
 * Everything Teams can do in both directions arrives here: the bot being
 * installed, somebody asking for a ticket form, a submitted form, and a reply
 * in a ticket's thread. It is the endpoint that makes Teams two-way at all -
 * an incoming webhook, which is what this integration used to be, is a URL
 * you post to and nothing more.
 *
 * Answered with 200 in almost every case: Microsoft retries anything else,
 * and a retried card submission is a second ticket.
 */
webhooksRouter.post(
  '/msteams',
  asyncRoute(async (req, res) => {
    const record = await loadIntegration('msteams');
    const config = record.config as MsTeamsConfig;
    const activity = req.body as TeamsActivity;

    if (!record.enabled) return res.status(503).json({ error: 'Teams integration is disabled' });
    if (config.mode !== 'bot' || !config.appId) {
      return res.status(400).json({ error: 'Teams is not connected as a bot' });
    }

    const verified = await verifyTeamsRequest(req.header('authorization'), config.appId, activity?.serviceUrl);
    if (!verified.ok) return res.status(401).json({ error: verified.reason });

    // A single-tenant deployment says so, and activities from anywhere else
    // are refused even though Microsoft signed them.
    const tenant = activity?.channelData?.tenant?.id;
    if (config.tenantId && tenant && tenant !== config.tenantId) {
      return res.status(403).json({ error: 'That tenant is not allowed to use this bot' });
    }

    const serviceUrl = activity?.serviceUrl;
    const conversationId = activity?.conversation?.id;
    if (!serviceUrl || !conversationId) return res.json({ ok: true, ignored: true });

    /*
     * Remembered on every activity, not only on install: Microsoft will not
     * accept a message to a conversation it has not seen, and the service URL
     * can change when a tenant is moved between clouds.
     */
    await rememberConversation({
      conversationId,
      serviceUrl,
      tenantId: tenant ?? null,
      channelName: activity.channelData?.channel?.name ?? activity.conversation?.name ?? null,
      teamName: activity.channelData?.team?.name ?? null,
    });

    if (activity.type === 'conversationUpdate') {
      const botWasAdded = activity.membersAdded?.some((member) => member.id === activity.recipient?.id);
      if (botWasAdded) {
        const teams = await listTeams();
        const names = teams.map((team) => team.key.toLowerCase()).join(', ') || 'none yet';
        await sendActivity(
          config,
          { serviceUrl, conversationId },
          {
            text:
              `Connected. Mention me with a department to raise a ticket — for example ` +
              `**@${activity.recipient?.name ?? 'InfraTicket'} finance**.\n\n` +
              `Departments: ${names}`,
          },
        );
      }
      return res.json({ ok: true });
    }

    if (!isFromPerson(activity)) return res.json({ ok: true, ignored: true });

    // A submitted card carries its data in `value`, with no text at all.
    if (activity.value?.action === TICKET_CARD_ACTION) {
      return handleTeamsCardSubmission(activity, config, res);
    }

    // A reply inside a ticket's thread becomes a comment on that ticket.
    const rootId = activity.replyToId;
    if (rootId) {
      const ticketId = await findTicketByTeamsThread(rootId);
      if (ticketId) return handleTeamsReply(activity, config, ticketId, res);
    }

    return handleTeamsCommand(activity, config, res);
  }),
);

/** Somebody mentioned the bot: work out the department and post the form. */
async function handleTeamsCommand(
  activity: TeamsActivity,
  config: MsTeamsConfig,
  res: Response,
): Promise<Response> {
  const target = { serviceUrl: activity.serviceUrl!, conversationId: activity.conversation!.id!, replyToId: activity.id };

  const actor = await resolveTeamsActor(config, activity, 'tickets.create');
  if (!actor.ok) {
    await sendActivity(config, target, { text: actor.message });
    return res.json({ ok: true, refused: true });
  }

  const teams = await listTeams();
  if (teams.length === 0) {
    await sendActivity(config, target, { text: 'No departments have been set up yet.' });
    return res.json({ ok: true });
  }

  const asked = stripMention(activity.text, activity.recipient?.name);
  const team = matchTeam(asked, teams);

  if (!team) {
    // Naming the departments beats "unknown command": Teams has no command
    // autocomplete for an argument, so the list is the only discoverability.
    await sendActivity(config, target, {
      text:
        `Which department? Mention me with one of: ${teams.map((t) => `**${t.key.toLowerCase()}**`).join(', ')}.`,
    });
    return res.json({ ok: true });
  }

  const [fields, settings] = await Promise.all([listTeamFields(team.id), getSettings()]);
  const sent = await sendActivity(config, target, {
    attachments: [asAttachment(buildTicketCard({ team, fields, organizationName: settings.organizationName }))],
  });

  return res.json({ ok: sent.ok, team: team.key });
}

/** A form came back: validate it and raise the ticket. */
async function handleTeamsCardSubmission(
  activity: TeamsActivity,
  config: MsTeamsConfig,
  res: Response,
): Promise<Response> {
  const target = { serviceUrl: activity.serviceUrl!, conversationId: activity.conversation!.id!, replyToId: activity.id };

  const actor = await resolveTeamsActor(config, activity, 'tickets.create');
  if (!actor.ok) {
    await sendActivity(config, target, { text: actor.message });
    return res.json({ ok: true, refused: true });
  }

  const submitted = readCardSubmission(activity.value ?? {});
  if (!submitted.teamId || !submitted.subject) {
    await sendActivity(config, target, { text: 'That needs a department and a one-line summary.' });
    return res.json({ ok: true, invalid: true });
  }

  try {
    const ticket = await createTicket(
      {
        subject: submitted.subject.slice(0, 200),
        description: submitted.description.slice(0, 20_000),
        descriptionFormat: 'text',
        teamId: submitted.teamId,
        priority: submitted.priority as TicketPriority,
        source: 'msteams',
        customFields: submitted.customFields,
      },
      { actor: actor.user },
    );

    await sendActivity(config, target, {
      attachments: [
        asAttachment(buildConfirmationCard(ticket.reference, ticket.subject, await buildTicketUrl(ticket))),
      ],
    });
    return res.json({ ok: true, ticket: ticket.reference });
  } catch (error) {
    // Said back in the thread rather than swallowed: the person is waiting.
    const message = error instanceof HttpError ? error.message : 'That could not be saved.';
    await sendActivity(config, target, { text: message });
    return res.json({ ok: true, invalid: true });
  }
}

/** A reply in a ticket's thread becomes a comment on that ticket. */
async function handleTeamsReply(
  activity: TeamsActivity,
  config: MsTeamsConfig,
  ticketId: string,
  res: Response,
): Promise<Response> {
  const settings = await getSettings();
  const ticket = await findTicket(ticketId, settings.ticketPrefix);
  if (!ticket) return res.json({ ok: true, ignored: true });

  /*
   * Microsoft redelivers on any non-2xx and on its own timeouts, so the
   * activity id - unique per message - is what stops a retry becoming a
   * second comment.
   */
  const seen = await db.get<{ id: string }>(
    `SELECT id FROM ticket_links WHERE provider = 'msteams_reply' AND external_id = ?`,
    [activity.id ?? ''],
  );
  if (seen) return res.json({ ok: true, duplicate: true });

  const body = teamsTextToPlain(activity.text ?? '');
  if (!body) return res.json({ ok: true, ignored: true });

  const author = await resolveTeamsAuthor(config, activity);
  const now = new Date().toISOString();
  const commentId = randomId();

  await db.run(
    `INSERT INTO ticket_comments (id, ticket_id, author_id, body, body_format, is_internal, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'text', 0, ?, ?)`,
    [
      commentId,
      ticket.id,
      author.userId,
      author.userId ? body : `${author.displayName} replied in Teams:\n\n${body}`,
      now,
      now,
    ],
  );
  await db.run(
    `INSERT INTO ticket_links (id, ticket_id, provider, external_id, external_key, url, created_at)
     VALUES (?, ?, 'msteams_reply', ?, ?, ?, ?)`,
    [randomId(), ticket.id, activity.id ?? randomId(), commentId, '', now],
  );
  await recordEvent(ticket.id, author.userId, 'commented', 'source', null, 'msteams');

  const recipients = [ticket.requesterId, ticket.assigneeId, ...ticket.watcherIds].filter(
    (id): id is string => Boolean(id) && id !== author.userId,
  );
  await notifyUsers(recipients, {
    ticketId: ticket.id,
    type: 'comment',
    title: `${author.displayName} replied to ${ticket.reference} in Teams`,
    body: body.slice(0, 280),
  });

  await recordAudit({
    actorId: author.userId,
    actorName: author.displayName,
    entityType: 'ticket',
    entityId: ticket.id,
    action: 'comment_from_teams',
    summary: `${author.displayName} replied to ${ticket.reference} from Teams`,
  });

  // Out to the other channels, but not back to Teams - that is where it came
  // from, and the thread already shows it.
  await dispatch(
    {
      event: 'ticketCommented',
      ticket,
      actorName: author.displayName,
      headline: `${author.displayName} replied in Teams`,
      detail: body,
      ticketUrl: await buildTicketUrl(ticket),
    },
    { exclude: ['msteams'] },
  );

  return res.json({ ok: true, ticket: ticket.reference });
}

/**
 * An issue raised in Linear becomes a ticket here.
 *
 * The department comes from the Linear team it was raised in; an issue in a
 * team nobody has mapped is left alone rather than dumped into a default
 * queue where nobody is watching for it.
 */
async function createTicketFromLinearIssue(
  issue: {
    id?: string;
    identifier?: string;
    title?: string;
    description?: string;
    priority?: number;
    teamId?: string;
    creatorId?: string;
  },
  config: LinearConfig,
  res: Response,
): Promise<Response> {
  if (!issue.teamId || !issue.title) return res.json({ ok: true, ignored: true });

  const teamId = await departmentForLinearTeam(issue.teamId);
  if (!teamId) return res.json({ ok: true, ignored: true, reason: 'That Linear team is not mapped to a department' });

  /*
   * Raised as whoever it belongs to. With no matching account the issue is
   * still worth having, so it falls back to an administrator rather than
   * being dropped - but it is never attributed to somebody it is not.
   */
  const author = issue.creatorId && config.apiKey
    ? await findUserForLinearActor(config.apiKey, issue.creatorId)
    : null;

  const fallback = await db.get<{ id: string; name: string }>(
    `SELECT id, name FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1`,
  );
  const actorRow = author ?? fallback;
  if (!actorRow) return res.json({ ok: true, ignored: true, reason: 'No account to raise it as' });

  const actor = await findUserById(actorRow.id);
  if (!actor) return res.json({ ok: true, ignored: true });

  const ticket = await createTicket(
    {
      subject: issue.title.slice(0, 200),
      description: [
        issue.description?.slice(0, 19_000) ?? '',
        '',
        `Raised in Linear as ${issue.identifier ?? issue.id}${author ? '' : ` by a Linear user with no account here`}.`,
      ]
        .join('\n')
        .trim(),
      descriptionFormat: 'text',
      teamId,
      priority: priorityFromLinear(issue.priority),
      source: 'api',
    },
    { actor },
  );

  // Linked straight away, so the status sync above recognises it from now on
  // and a second webhook for the same issue cannot raise a second ticket.
  await addLink(ticket.id, 'linear', issue.id!, issue.identifier ?? null, '');

  await recordAudit({
    actorId: actor.id,
    actorName: author ? actor.name : 'Linear',
    entityType: 'ticket',
    entityId: ticket.id,
    action: 'ticket_created_from_linear',
    summary: `${issue.identifier ?? issue.id} in Linear raised ${ticket.reference}`,
  });

  return res.json({ ok: true, ticket: ticket.reference });
}
