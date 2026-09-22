import type { Request } from 'express';
import { db } from '../db/index.ts';
import { TERMINAL_STATUSES, type TicketStatus } from '../../shared/types.ts';
import { recordEvent } from '../repositories/tickets.ts';
import { resolveSlackAuthor } from './slack-events.ts';
import type { SlackView } from './slack-modal.ts';
import { can } from '../middleware/auth.ts';
import type { Permission, PublicUser } from '../../shared/types.ts';
import { findUserById } from '../repositories/users.ts';

/**
 * Buttons on a ticket's Slack message.
 *
 * Slack delivers a click to a different endpoint than it delivers a message,
 * in a different encoding, so the two inbound paths share only the signature
 * check. What they do have in common is the reason they exist: the people who
 * live in Slack should not have to open a browser to move a ticket along.
 */

/** Encoded into each button so a click names the ticket and the intent. */
export const SLACK_ACTIONS = {
  resolve: 'ticket_resolve',
  close: 'ticket_close',
  reopen: 'ticket_reopen',
} as const;

export type SlackActionId = (typeof SLACK_ACTIONS)[keyof typeof SLACK_ACTIONS];

const STATUS_FOR_ACTION: Record<SlackActionId, TicketStatus> = {
  [SLACK_ACTIONS.resolve]: 'resolved',
  [SLACK_ACTIONS.close]: 'closed',
  [SLACK_ACTIONS.reopen]: 'open',
};

export function statusForAction(actionId: string): TicketStatus | null {
  return STATUS_FOR_ACTION[actionId as SlackActionId] ?? null;
}

/**
 * The buttons shown under a ticket, chosen by where the ticket currently is.
 *
 * An open ticket offers the two ways forward; a finished one offers the way
 * back. Showing all three always would invite a click that does nothing.
 */
export function ticketActionButtons(ticket: { id: string; status: string; priority: string }, ticketUrl: string) {
  const open = !TERMINAL_STATUSES.includes(ticket.status as TicketStatus);

  const elements: unknown[] = [
    {
      type: 'button',
      text: { type: 'plain_text', text: 'Open ticket' },
      url: ticketUrl,
      style: open && ticket.priority === 'urgent' ? 'danger' : undefined,
    },
  ];

  if (open) {
    elements.push(
      {
        type: 'button',
        action_id: SLACK_ACTIONS.resolve,
        text: { type: 'plain_text', text: 'Resolve' },
        value: ticket.id,
        style: 'primary',
      },
      {
        type: 'button',
        action_id: SLACK_ACTIONS.close,
        text: { type: 'plain_text', text: 'Close' },
        value: ticket.id,
        // Closing skips straight past "resolved", so it asks first.
        confirm: {
          title: { type: 'plain_text', text: 'Close this ticket?' },
          text: { type: 'mrkdwn', text: 'It will be marked closed and everyone watching it will be told.' },
          confirm: { type: 'plain_text', text: 'Close it' },
          deny: { type: 'plain_text', text: 'Cancel' },
        },
      },
    );
  } else {
    elements.push({
      type: 'button',
      action_id: SLACK_ACTIONS.reopen,
      text: { type: 'plain_text', text: 'Reopen' },
      value: ticket.id,
    });
  }

  return { type: 'actions', elements };
}

export interface SlackInteractivePayload {
  type?: string;
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string };
  response_url?: string;
  actions?: Array<{
    action_id?: string;
    value?: string;
    /** Present when the control is a select rather than a button. */
    selected_option?: { value?: string } | null;
  }>;
  /** Present on a modal's own actions and on its submission. */
  view?: SlackView;
}

/**
 * Slack posts interactions as form-encoded with the JSON in a `payload`
 * field - not as a JSON body like every other delivery it makes.
 */
export function parseInteractivePayload(req: Request): SlackInteractivePayload | null {
  const raw = (req.body as { payload?: unknown } | undefined)?.payload;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as SlackInteractivePayload;
  } catch {
    return null;
  }
}

export type ActorResult =
  | { ok: true; user: PublicUser }
  | { ok: false; message: string };

/**
 * Who clicked, and whether they are allowed to.
 *
 * This is the whole of the authorisation for the button. Anyone who can see
 * the channel can click it, so a click proves nothing on its own: it has to
 * be tied back to an account here, and that account checked, or a ticket
 * could be closed by any guest in the workspace.
 */
export async function resolveActor(
  botToken: string,
  slackUserId: string,
  permission: Permission,
): Promise<ActorResult> {
  const author = await resolveSlackAuthor(botToken, slackUserId, { includeSuspended: true });

  if (!author.userId) {
    return {
      ok: false,
      message:
        'Your Slack account is not linked to a user here, so this ticket was left alone. ' +
        'Ask an administrator to add you with the same email address as your Slack profile.',
    };
  }

  const user = await findUserById(author.userId);
  if (!user || user.status !== 'active') {
    return { ok: false, message: 'That account is no longer active here, so this ticket was left alone.' };
  }
  if (!can(user, permission)) {
    return { ok: false, message: `You do not have permission to change a ticket's status.` };
  }

  return { ok: true, user };
}

export interface StatusChange {
  changed: boolean;
  from: TicketStatus;
}

/**
 * Applies a status change, stamping the lifecycle timestamps the SLA report
 * reads. Returns `changed: false` when the ticket is already there, which is
 * what a double-click on a slow connection looks like.
 */
export async function applyStatus(
  ticketId: string,
  next: TicketStatus,
  actorId: string | null,
): Promise<StatusChange | null> {
  const current = await db.get<{ status: TicketStatus }>(`SELECT status FROM tickets WHERE id = ?`, [ticketId]);
  if (!current) return null;
  if (current.status === next) return { changed: false, from: current.status };

  const now = new Date().toISOString();

  if (TERMINAL_STATUSES.includes(next)) {
    // Stamp the one that applies and leave the other as it was, matching what
    // the web route does when a resolved ticket is then closed.
    await db.run(
      `UPDATE tickets SET status = ?, updated_at = ?,
         resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END,
         closed_at   = CASE WHEN ? = 'closed'   THEN ? ELSE closed_at   END
       WHERE id = ?`,
      [next, now, next, now, next, now, ticketId],
    );
  } else {
    // Reopening clears both, or the SLA report still counts it as finished.
    await db.run(`UPDATE tickets SET status = ?, updated_at = ?, resolved_at = NULL, closed_at = NULL WHERE id = ?`, [
      next,
      now,
      ticketId,
    ]);
  }
  await recordEvent(ticketId, actorId, 'status_changed', 'status', current.status, next);

  return { changed: true, from: current.status };
}

/**
 * Answers the click in the channel, visible only to the person who clicked.
 *
 * Sent to Slack's one-use response_url rather than chat.postMessage: it needs
 * no scope, and it is the only way to reply privately to someone who may not
 * be a member of the channel.
 */
export async function respondEphemeral(responseUrl: string, text: string): Promise<void> {
  // Bounded, because this sits in front of the reply to Slack and Slack gives
  // the whole request three seconds before it warns the person it failed.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
      signal: controller.signal,
    });
  } catch {
    // The ticket has already been updated by this point. Failing to say so in
    // Slack is worth a silent miss, not an error the person cannot act on.
  } finally {
    clearTimeout(timer);
  }
}
