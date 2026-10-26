import { db } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { sanitizeRichText } from '../lib/rich-text.ts';
import { getSettings } from '../repositories/settings.ts';
import { findTicket, recordEvent } from '../repositories/tickets.ts';
import { createTicket, SYSTEM_ACTOR } from '../services/tickets.ts';
import { buildTicketUrl, dispatchAsync } from './dispatcher.ts';
import type { ConnectionRecord } from '../ops/connections.ts';
import type { MailboxConfig } from '../../shared/connections.ts';
import { TICKET_PRIORITIES, TICKET_TYPES, type PublicUser, type Ticket } from '../../shared/types.ts';

/**
 * A department's Outlook mailbox (Microsoft 365) as a way in: each new email
 * raises a ticket in the department - so its auto-assignment, approval rules
 * and channels apply - and a reply in the same conversation, or one naming
 * the ticket in its subject, is added to that ticket instead.
 *
 * Read through Microsoft Graph with the department's own app registration
 * (client credentials). Mail.Read is enough: each message is remembered once
 * handled. With Mail.ReadWrite it is also marked read; with Mail.Send the
 * sender can be told their ticket number.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_PER_POLL = 25;
const tokens = new Map<string, { token: string; expiresAt: number }>();

interface GraphMessage {
  id: string;
  subject?: string | null;
  conversationId?: string | null;
  receivedDateTime?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  body?: { contentType?: 'html' | 'text'; content?: string };
  bodyPreview?: string;
}

export interface MailPollResult {
  created: string[];
  commented: string[];
  skipped: number;
  error: string | null;
}

async function graphToken(connection: ConnectionRecord): Promise<string> {
  const config = connection.config as MailboxConfig;
  const cached = tokens.get(connection.id);
  if (cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.token;
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret ?? '', scope: 'https://graph.microsoft.com/.default' }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !body.access_token) throw new Error(`Microsoft refused the app registration: ${body.error_description?.split('\n')[0] ?? `HTTP ${response.status}`}`);
  tokens.set(connection.id, { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

async function graph(connection: ConnectionRecord, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await graphToken(connection)}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

async function graphFailure(response: Response, what: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  const detail = body.error?.message ?? body.error?.code ?? `HTTP ${response.status}`;
  if (response.status === 401 || response.status === 403) {
    return `${what} was refused (${detail}). Give the app registration the Microsoft Graph application permission Mail.Read (Mail.ReadWrite to mark mail read, Mail.Send to acknowledge) with an administrator's consent, and allow it this mailbox.`;
  }
  return `${what} failed: ${detail}`;
}

const mailboxPath = (config: MailboxConfig) => `/users/${encodeURIComponent(config.mailbox)}/mailFolders/${encodeURIComponent(config.folder || 'inbox')}`;

/** Checks the credentials and the mailbox can be read, without handling anything. */
export async function testMailbox(connection: ConnectionRecord): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await graph(connection, 'GET', `${mailboxPath(connection.config as MailboxConfig)}?$select=displayName,unreadItemCount`);
    if (!response.ok) return { ok: false, message: await graphFailure(response, 'Reading the mailbox') };
    const folder = (await response.json()) as { displayName?: string; unreadItemCount?: number };
    return { ok: true, message: `Connected to ${(connection.config as MailboxConfig).mailbox} · ${folder.displayName ?? 'Inbox'} has ${folder.unreadItemCount ?? 0} unread` };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

/** The ticket an email continues: the same conversation, or [FIN-1234] / FIN-1234 in its subject. */
async function existingTicket(message: GraphMessage, prefix: string): Promise<Ticket | null> {
  if (message.conversationId) {
    const thread = await db.get<{ ticket_id: string }>(`SELECT ticket_id FROM mail_threads WHERE conversation_id = ?`, [message.conversationId]);
    if (thread) {
      const ticket = await findTicket(thread.ticket_id, prefix);
      if (ticket) return ticket;
    }
  }
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reference = new RegExp(`\\b${escaped}-(\\d+)\\b`, 'i').exec(message.subject ?? '');
  return reference ? findTicket(reference[1], prefix) : null;
}

/** Which department an email belongs to: the first matching route, else the mailbox's own. */
export function routeFor(config: MailboxConfig, defaultTeamId: string | null, message: Pick<GraphMessage, 'subject' | 'from'>): string | null {
  const from = (message.from?.emailAddress?.address ?? '').toLowerCase();
  const subject = (message.subject ?? '').toLowerCase();
  for (const route of config.routes ?? []) {
    const needle = route.contains.trim().toLowerCase();
    if (!needle) continue;
    if ((route.field === 'from' ? from : subject).includes(needle)) return route.teamId;
  }
  return defaultTeamId;
}

function bodyOf(message: GraphMessage): { html: string; text: string } {
  const content = (message.body?.content ?? message.bodyPreview ?? '').slice(0, 200_000);
  if (message.body?.contentType === 'html') return { html: sanitizeRichText(content), text: content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() };
  const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return { html: `<p>${escaped.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`, text: content };
}

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function senderUser(address: string): Promise<PublicUser | null> {
  if (!address) return null;
  const row = await db.get<{ id: string }>(`SELECT id FROM users WHERE LOWER(email) = ? AND status = 'active'`, [address.toLowerCase()]);
  if (!row) return null;
  const { findUserById } = await import('../repositories/users.ts');
  return findUserById(row.id);
}

async function addEmailComment(ticket: Ticket, message: GraphMessage, sender: PublicUser | null): Promise<void> {
  const name = message.from?.emailAddress?.name || message.from?.emailAddress?.address || 'Someone';
  const { html, text } = bodyOf(message);
  const body = sender ? html : `<p><b>${escape(name)}</b> &lt;${escape(message.from?.emailAddress?.address ?? '')}&gt; replied by email:</p>${html}`;
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO ticket_comments (id, ticket_id, author_id, body, body_format, is_internal, created_at, updated_at) VALUES (?, ?, ?, ?, 'html', 0, ?, ?)`,
    [randomId(), ticket.id, sender?.id ?? null, body, now, now],
  );
  await db.run(`UPDATE tickets SET updated_at = ? WHERE id = ?`, [now, ticket.id]);
  await recordEvent(ticket.id, sender?.id ?? null, 'commented', 'source', null, 'email');
  dispatchAsync({
    event: 'ticketCommented',
    ticket,
    actorName: sender?.name ?? name,
    headline: `${name} replied by email on ${ticket.reference}`,
    detail: text.slice(0, 1500),
    ticketUrl: await buildTicketUrl(ticket),
  });
}

async function raiseFromEmail(connection: ConnectionRecord, message: GraphMessage, sender: PublicUser | null): Promise<Ticket> {
  const config = connection.config as MailboxConfig;
  const address = message.from?.emailAddress?.address ?? '';
  const name = message.from?.emailAddress?.name || address || 'Unknown sender';
  const { html } = bodyOf(message);
  const from = `<p><b>From:</b> ${escape(name)}${address ? ` &lt;${escape(address)}&gt;` : ''} · by email to ${escape(config.mailbox)}</p>`;
  const ticket = await createTicket(
    {
      subject: (message.subject?.trim() || '(no subject)').slice(0, 200),
      description: `${from}${html}`,
      descriptionFormat: 'html',
      teamId: routeFor(config, connection.teamId, message),
      requesterId: sender?.id ?? null,
      priority: TICKET_PRIORITIES.includes(config.priority as never) ? config.priority : undefined,
      type: TICKET_TYPES.includes(config.type as never) ? config.type : undefined,
      source: 'email',
    },
    { actor: sender ?? { ...SYSTEM_ACTOR, name: `Email (${config.mailbox})` } },
  );
  if (message.conversationId) {
    await db.run(`INSERT INTO mail_threads (conversation_id, connection_id, ticket_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (conversation_id) DO NOTHING`, [
      message.conversationId,
      connection.id,
      ticket.id,
      new Date().toISOString(),
    ]);
  }
  return ticket;
}

/** One pass over the mailbox: new mail raises tickets, replies join theirs. */
export async function pollMailbox(connection: ConnectionRecord): Promise<MailPollResult> {
  const config = connection.config as MailboxConfig;
  const result: MailPollResult = { created: [], commented: [], skipped: 0, error: null };
  const settings = await getSettings();
  let messages: GraphMessage[];
  try {
    const select = '$select=id,subject,conversationId,receivedDateTime,from,body,bodyPreview';
    const response = await graph(connection, 'GET', `${mailboxPath(config)}/messages?$filter=isRead eq false&$top=${MAX_PER_POLL}&${select}`);
    if (!response.ok) {
      result.error = await graphFailure(response, 'Reading the mailbox');
      return result;
    }
    messages = ((await response.json()) as { value?: GraphMessage[] }).value ?? [];
  } catch (error) {
    result.error = (error as Error).message;
    return result;
  }
  // Oldest first, so a thread's first email raises the ticket and later ones join it.
  messages.sort((a, b) => String(a.receivedDateTime).localeCompare(String(b.receivedDateTime)));

  for (const message of messages) {
    const seen = await db.get(`SELECT message_id FROM mail_messages WHERE connection_id = ? AND message_id = ?`, [connection.id, message.id]);
    if (seen) {
      result.skipped += 1;
      continue;
    }
    // Remembered before it is handled: a crash part-way must not raise it twice.
    await db.run(`INSERT INTO mail_messages (connection_id, message_id, ticket_id, created_at) VALUES (?, ?, NULL, ?)`, [connection.id, message.id, new Date().toISOString()]);
    // Our own acknowledgement, or anything else sent from the mailbox itself, is not a request.
    if ((message.from?.emailAddress?.address ?? '').toLowerCase() === config.mailbox.toLowerCase()) {
      result.skipped += 1;
      continue;
    }
    try {
      const sender = await senderUser(message.from?.emailAddress?.address ?? '');
      const existing = await existingTicket(message, settings.ticketPrefix);
      let ticket: Ticket;
      if (existing) {
        await addEmailComment(existing, message, sender);
        result.commented.push(existing.reference);
        ticket = existing;
      } else {
        ticket = await raiseFromEmail(connection, message, sender);
        result.created.push(ticket.reference);
        if (config.acknowledge) {
          const url = await buildTicketUrl(ticket);
          await graph(connection, 'POST', `/users/${encodeURIComponent(config.mailbox)}/messages/${encodeURIComponent(message.id)}/reply`, {
            comment: `Thanks - this is now ticket ${ticket.reference}. Reply to this email to add to it.\n\n${url}`,
          }).catch(() => undefined);
        }
      }
      await db.run(`UPDATE mail_messages SET ticket_id = ? WHERE connection_id = ? AND message_id = ?`, [ticket.id, connection.id, message.id]);
      if (config.markRead !== false) {
        await graph(connection, 'PATCH', `/users/${encodeURIComponent(config.mailbox)}/messages/${encodeURIComponent(message.id)}`, { isRead: true }).catch(() => undefined);
      }
    } catch (error) {
      console.error(`[mailbox] ${config.mailbox}: ${message.id}`, error);
    }
  }
  return result;
}

/** Called by the ops runner: each department mailbox, once a minute. */
export async function mailboxTick(now = Date.now()): Promise<number> {
  const { departmentConnectionsOfKind, noteConnectionUse } = await import('../ops/connections.ts');
  let handled = 0;
  for (const connection of await departmentConnectionsOfKind('mailbox')) {
    if (connection.lastUsedAt && now - Date.parse(connection.lastUsedAt) < 55_000) continue;
    const result = await pollMailbox(connection);
    await noteConnectionUse(connection.id, result.error);
    handled += result.created.length + result.commented.length;
  }
  return handled;
}
