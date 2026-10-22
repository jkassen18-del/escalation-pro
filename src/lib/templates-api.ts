import { api, ApiError } from '@/lib/api';
import type { Ticket } from '@shared/types';
import type { TicketTemplate } from '@shared/templates';

/** Client for /api/ticket-templates: quick tickets. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/ticket-templates${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof payload === 'object' && payload?.error ? String(payload.error) : `Request failed with status ${response.status}`;
    throw new ApiError(response.status, message, typeof payload === 'object' ? payload?.details : undefined);
  }
  return payload as T;
}

export type TemplateInput = Omit<TicketTemplate, 'id' | 'teamName' | 'position' | 'createdAt' | 'updatedAt' | 'fields'> & {
  fields: Array<Partial<TicketTemplate['fields'][number]> & { label: string; type: TicketTemplate['fields'][number]['type'] }>;
};

export const templatesApi = {
  /** The quick tickets this person can raise. */
  usable: () => request<{ templates: TicketTemplate[] }>('GET', ''),
  /** Every template, for team managers. */
  all: () => request<{ templates: TicketTemplate[] }>('GET', '?all=1'),
  create: (input: TemplateInput) => request<{ template: TicketTemplate }>('POST', '', input),
  update: (id: string, input: TemplateInput) => request<{ template: TicketTemplate }>('PUT', `/${id}`, input),
  remove: (id: string) => request<void>('DELETE', `/${id}`),
  raise: (
    id: string,
    body: { summary: string; answers: Record<string, unknown>; customFields: Record<string, unknown>; description: string; screenshotsToFollow: number },
  ) => request<{ ticket: Ticket }>('POST', `/${id}/tickets`, body),
  /** Screenshots chosen with the file picker go up through the normal attachments route. */
  upload: (ticketId: string, files: File[]) => api.tickets.upload(ticketId, files),
};
