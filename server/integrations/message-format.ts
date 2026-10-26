import { getSettings } from '../repositories/settings.ts';
import { richTextToPlain } from '../lib/rich-text.ts';
import { loadIntegration } from './store.ts';
import type { NotificationContext } from './types.ts';
import { normaliseTemplate, type MessageTemplate, type TemplateProvider, type TemplateValues } from '../../shared/message-template.ts';

/** The saved message design for a provider, or the default when none was saved. */
export async function templateFor(provider: TemplateProvider): Promise<MessageTemplate> {
  try {
    const record = await loadIntegration(provider);
    return normaliseTemplate(provider, record.config.messageTemplate);
  } catch {
    return normaliseTemplate(provider, null);
  }
}

const words = (value: string) => value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function when(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleString('en-GB', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return date.toUTCString();
  }
}

/** Everything a template can say about this notification, in words people read. */
export async function valuesFor(ctx: NotificationContext): Promise<TemplateValues> {
  const { ticket } = ctx;
  const settings = await getSettings().catch(() => null);
  const zone = settings?.timezone || 'UTC';
  const description = ticket.descriptionFormat === 'html' ? richTextToPlain(ticket.description ?? '') : (ticket.description ?? '');
  return {
    headline: ctx.headline,
    reference: ticket.reference,
    subject: ticket.subject,
    description: description.length > 1800 ? `${description.slice(0, 1800)}…` : description,
    detail: ctx.detail ? (ctx.detail.length > 2800 ? `${ctx.detail.slice(0, 2800)}…` : ctx.detail) : '',
    status: ticket.status ? words(ticket.status) : '',
    priority: ticket.priority ? words(ticket.priority) : '',
    type: ticket.type ? words(ticket.type) : '',
    team: ticket.teamName ?? 'Unassigned',
    assignee: ticket.assigneeName ?? 'Unassigned',
    requester: ticket.requesterName ?? 'Unknown',
    actor: ctx.actorName,
    labels: (ticket.tags ?? []).join(', '),
    due: when(ticket.dueAt, zone),
    severity: ticket.severity ? ticket.severity.toUpperCase() : '',
    source: ticket.source ? words(ticket.source === 'msteams' ? 'Teams' : ticket.source) : '',
    created: when(ticket.createdAt, zone),
    url: ctx.ticketUrl,
    time: when(new Date().toISOString(), zone),
    org: settings?.organizationName?.trim() || 'Service Desk',
  };
}
