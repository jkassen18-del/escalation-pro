import type { Ticket } from '../../shared/types.ts';

export type IntegrationEvent =
  | 'ticketCreated'
  | 'ticketAssigned'
  | 'ticketStatusChanged'
  | 'ticketEscalated'
  | 'ticketCommented'
  | 'slaBreached';

export interface NotificationContext {
  event: IntegrationEvent;
  ticket: Ticket;
  actorName: string;
  /** Human-readable headline, e.g. "Ticket assigned to Dana Reyes". */
  headline: string;
  /** Optional extra detail, e.g. the comment body or the status transition. */
  detail?: string;
  ticketUrl: string;
}

export interface TestResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface DeliveryResult {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
}

export const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'attention',
  high: 'warning',
  normal: 'accent',
  low: 'good',
};

export const PRIORITY_HEX: Record<string, string> = {
  urgent: '#b42318',
  high: '#b54708',
  normal: '#175cd3',
  low: '#667085',
};

/** Shared fetch wrapper with a timeout so a hung webhook cannot stall a request. */
export async function postJson(
  url: string,
  body: unknown,
  options: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, text };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Request timed out after 10 seconds');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
