import { db } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { getSettings } from '../repositories/settings.ts';
import { addLink } from '../repositories/tickets.ts';
import { loadIntegration } from './store.ts';
import { sendSlack } from './slack.ts';
import { sendMsTeams, type MsTeamsConfig } from './msteams.ts';
import { createLinearIssue, shouldMirror, type LinearConfig } from './linear.ts';
import { sendEmail } from './email.ts';
import { sendDiscord } from './discord.ts';
import { listHttpIntegrations, sendHttpIntegration, wants, type HttpIntegrationRecord } from './http-custom.ts';
import type { DeliveryResult, IntegrationEvent, NotificationContext } from './types.ts';
import type { IntegrationProvider, Ticket } from '../../shared/types.ts';

async function logDelivery(
  provider: IntegrationProvider | `http:${string}`,
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
export async function dispatch(
  ctx: NotificationContext,
  options: { exclude?: IntegrationProvider[] } = {},
): Promise<void> {
  const event: IntegrationEvent = ctx.event;

  /*
   * `exclude` exists for events that arrived *from* one of these providers.
   * A reply typed in Slack should still reach the people who watch by email,
   * but sending it back to Slack would post the message into the thread it
   * came from.
   */
  const providers: IntegrationProvider[] = (['slack', 'msteams', 'email', 'discord'] as const).filter(
    (provider) => !options.exclude?.includes(provider),
  );
  await Promise.all(
    providers.map(async (provider) => {
      try {
        const record = await loadIntegration(provider);
        if (!record.enabled || !record.events[event]) return;

        let result: DeliveryResult;
        if (provider === 'slack') result = await sendSlack(record, ctx);
        else if (provider === 'msteams') result = await sendMsTeams(record, ctx);
        else if (provider === 'discord') result = await sendDiscord(record, ctx);
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

  await Promise.all([maybeMirrorToLinear(ctx), sendToHttpIntegrations(ctx), sendToDepartmentConnections(ctx), startFlows(ctx)]);
}

/** Departments' flows that start on this event. A flow's own changes never start flows. */
async function startFlows(ctx: NotificationContext): Promise<void> {
  const { insideFlow, runFlowsForEvent } = await import('../ops/flows.ts');
  if (insideFlow()) return;
  await runFlowsForEvent(ctx.event, ctx.ticket, ctx.actorName).catch((error) => console.error('[flows] could not start', error));
}

/**
 * The department's own channels and webhooks (Connections). They are the
 * department's, so they are sent to whether or not the organisation-wide
 * Slack or Teams integration is set up.
 */
async function sendToDepartmentConnections(ctx: NotificationContext): Promise<void> {
  const { departmentConnections, noteConnectionUse } = await import('../ops/connections.ts');
  let connections: Awaited<ReturnType<typeof departmentConnections>>;
  try {
    connections = (await departmentConnections(ctx.ticket.teamId, ['slack_webhook', 'teams_webhook', 'webhook'])).filter((connection) => connection.events[ctx.event]);
  } catch (error) {
    console.error('[integrations] could not load department connections', error);
    return;
  }
  await Promise.all(
    connections.map(async (connection) => {
      const { url, signingSecret } = connection.config as { url: string; signingSecret?: string };
      let result: DeliveryResult;
      try {
        if (connection.kind === 'webhook') {
          result = await sendHttpIntegration(
            {
              id: connection.id,
              name: connection.name,
              url,
              method: 'POST',
              headers: [],
              bodyTemplate: null,
              signingSecret: signingSecret ?? null,
              allowPrivate: true,
              events: connection.events,
              teamIds: [],
              enabled: true,
              createdAt: connection.createdAt,
              updatedAt: connection.updatedAt,
            },
            ctx,
          );
        } else if (connection.kind === 'slack_webhook') {
          const { buildMessage } = await import('./slack.ts');
          const { templateFor, valuesFor } = await import('./message-format.ts');
          const { postJson } = await import('./types.ts');
          const { status, text } = await postJson(url, buildMessage(ctx, await templateFor('slack'), await valuesFor(ctx)));
          result = { ok: status === 200, statusCode: status, error: status === 200 ? null : text.slice(0, 200) };
        } else {
          const { buildPayload } = await import('./msteams.ts');
          const teamsConfig = { mode: 'webhook', webhookUrl: url, format: 'auto' } as MsTeamsConfig;
          const { postJson } = await import('./types.ts');
          const { status, text } = await postJson(url, await buildPayload(teamsConfig, ctx));
          result = { ok: status === 200 || status === 202, statusCode: status, error: status === 200 || status === 202 ? null : text.slice(0, 200) };
        }
      } catch (error) {
        result = { ok: false, statusCode: null, error: (error as Error).message };
      }
      await noteConnectionUse(connection.id, result.ok ? null : result.error).catch(() => undefined);
      await logDelivery(`http:${connection.id}`, ctx.event, ctx.ticket.id, result).catch(() => undefined);
      if (!result.ok) console.warn(`[integrations] department connection "${connection.name}" ${ctx.event} failed: ${result.error}`);
    }),
  );
}

/** Every enabled custom HTTP integration that wants this event for this ticket's team. */
async function sendToHttpIntegrations(ctx: NotificationContext): Promise<void> {
  let records: HttpIntegrationRecord[];
  try {
    records = await listHttpIntegrations();
  } catch (error) {
    console.error('[integrations] could not load custom HTTP integrations', error);
    return;
  }
  await Promise.all(
    records.filter((record) => wants(record, ctx)).map(async (record) => {
      const result = await sendHttpIntegration(record, ctx);
      await logDelivery(`http:${record.id}`, ctx.event, ctx.ticket.id, result).catch(() => undefined);
      if (!result.ok) console.warn(`[integrations] http "${record.name}" ${ctx.event} failed: ${result.error}`);
    }),
  );
}

/** Records the outcome of a custom HTTP integration's test send. */
export async function logHttpTestDelivery(id: string, ticketId: string | null, result: DeliveryResult): Promise<void> {
  await logDelivery(`http:${id}`, 'test', ticketId, result);
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
    // Raised from a Linear issue: it already has one, and its link is only
    // recorded after this runs. Mirroring it would create a duplicate, whose
    // own webhook could raise another ticket.
    if (ctx.ticket.source === 'linear') return;

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
