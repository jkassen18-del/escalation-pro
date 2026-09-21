import { db } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { getSettings } from '../repositories/settings.ts';
import { addLink } from '../repositories/tickets.ts';
import { loadIntegration } from './store.ts';
import { sendSlack } from './slack.ts';
import { sendMsTeams } from './msteams.ts';
import { createLinearIssue, shouldMirror, type LinearConfig } from './linear.ts';
import { sendEmail } from './email.ts';
import type { DeliveryResult, IntegrationEvent, NotificationContext } from './types.ts';
import type { IntegrationProvider, Ticket } from '../../shared/types.ts';

async function logDelivery(
  provider: IntegrationProvider,
  event: string,
  ticketId: string | null,
  result: DeliveryResult,
): Promise<void> {
  await db.run(
    `INSERT INTO integration_deliveries (id, provider, event, ticket_id, ok, status_code, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomId(), provider, event, ticketId, result.ok ? 1 : 0, result.statusCode, result.error, new Date().toISOString()],
  );
}

/** Falls back to the request origin when APP_URL is not configured. */
export async function buildTicketUrl(ticket: Ticket, origin?: string): Promise<string> {
  const settings = await getSettings();
  const base = (settings.appUrl || process.env.APP_URL || origin || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/tickets/${ticket.id}`;
}

async function emailRecipients(ticket: Ticket): Promise<string[]> {
  const ids = [ticket.assigneeId, ticket.requesterId, ...ticket.watcherIds].filter(
    (id): id is string => Boolean(id),
  );
  if (!ids.length) return [];
  const unique = Array.from(new Set(ids));
  const rows = await db.all<{ email: string }>(
    `SELECT email FROM users WHERE id IN (${unique.map(() => '?').join(', ')}) AND status = 'active'`,
    unique,
  );
  return rows.map((row) => row.email);
}

/**
 * Fans a ticket event out to every enabled integration that subscribes to it.
 *
 * Failures are recorded and swallowed: a Slack outage must never roll back a
 * ticket update or surface as a 500 to the person who made the change.
 */
export async function dispatch(ctx: NotificationContext): Promise<void> {
  const event: IntegrationEvent = ctx.event;

  const providers: IntegrationProvider[] = ['slack', 'msteams', 'email'];
  await Promise.all(
    providers.map(async (provider) => {
      try {
        const record = await loadIntegration(provider);
        if (!record.enabled || !record.events[event]) return;

        let result: DeliveryResult;
        if (provider === 'slack') result = await sendSlack(record, ctx);
        else if (provider === 'msteams') result = await sendMsTeams(record, ctx);
        else result = await sendEmail(record, ctx, await emailRecipients(ctx.ticket));

        await logDelivery(provider, event, ctx.ticket.id, result);
        if (!result.ok) console.warn(`[integrations] ${provider} ${event} failed: ${result.error}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await logDelivery(provider, event, ctx.ticket.id, { ok: false, statusCode: null, error: message });
        console.error(`[integrations] ${provider} threw during ${event}`, error);
      }
    }),
  );

  await maybeMirrorToLinear(ctx);
}

/**
 * Linear is a mirror rather than a notifier: it creates a tracked issue for
 * escalations at or above the configured priority, once per ticket.
 */
async function maybeMirrorToLinear(ctx: NotificationContext): Promise<void> {
  if (ctx.event !== 'ticketCreated' && ctx.event !== 'ticketEscalated') return;

  try {
    const record = await loadIntegration('linear');
    if (!record.enabled) return;
    if (!shouldMirror(record.config as LinearConfig, ctx.ticket.priority)) return;
    if (ctx.ticket.links.some((link) => link.provider === 'linear')) return;

    const result = await createLinearIssue(record, ctx);
    await logDelivery('linear', ctx.event, ctx.ticket.id, {
      ok: result.ok,
      statusCode: result.ok ? 200 : null,
      error: result.error ?? null,
    });

    if (result.ok && result.issueId && result.url) {
      await addLink(ctx.ticket.id, 'linear', result.issueId, result.identifier ?? null, result.url);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logDelivery('linear', ctx.event, ctx.ticket.id, { ok: false, statusCode: null, error: message });
  }
}

/** Fire-and-forget wrapper: notifications must not block the HTTP response. */
export function dispatchAsync(ctx: NotificationContext): void {
  void dispatch(ctx).catch((error) => console.error('[integrations] dispatch failed', error));
}

export async function listDeliveries(limit = 50) {
  return db.all<Record<string, unknown>>(
    `SELECT * FROM integration_deliveries ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );
}
