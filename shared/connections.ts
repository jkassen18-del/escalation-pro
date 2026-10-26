import type { ApiAuth, HttpMethod } from './ops.ts';
import type { IntegrationEventToggles } from './types.ts';

/**
 * Connections: a department's own connectors, which other departments do
 * not see. A connection with no department is shared with everyone.
 *
 * - api: an API to call - a base URL with its auth and headers - used by
 *   API monitors, polling alert sources and flows.
 * - slack_webhook / teams_webhook: the department's own channel; its ticket
 *   notifications, handovers and approval requests go there as well.
 * - webhook: the department's ticket events POSTed as JSON to its own tools.
 */
export const CONNECTION_KINDS = ['api', 'slack_webhook', 'teams_webhook', 'webhook'] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export const CONNECTION_LABELS: Record<ConnectionKind, string> = {
  api: 'API connection',
  slack_webhook: 'Slack channel (incoming webhook)',
  teams_webhook: 'Teams channel (Workflows / incoming webhook)',
  webhook: 'Outgoing webhook',
};

export interface ApiConnectionConfig {
  baseUrl: string;
  auth?: ApiAuth;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  timeoutMs?: number;
}

export interface WebhookConnectionConfig {
  /** Stored encrypted; the browser sees a masked preview. */
  url: string;
  /** webhook only: signs the body with HMAC-SHA256, as custom HTTP integrations do. */
  signingSecret?: string;
}

export interface Connection {
  id: string;
  teamId: string | null;
  teamName: string | null;
  kind: ConnectionKind;
  name: string;
  description: string | null;
  /** api: the config with secrets masked. Webhooks: { url: masked preview }. */
  config: ApiConnectionConfig | (Omit<WebhookConnectionConfig, 'signingSecret'> & { hasSigningSecret?: boolean });
  /** Webhooks: which ticket events are sent. */
  events: IntegrationEventToggles;
  enabled: boolean;
  /** Whether the person asking may change it. */
  canEdit: boolean;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A request made through an API connection: the path and anything added to the connection's own settings. */
export interface ConnectionRequest {
  method?: HttpMethod;
  /** Appended to the base URL, e.g. /job/deploy/lastBuild/api/json. */
  path?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: string;
  bodyType?: 'none' | 'json' | 'text' | 'form';
}

/** Joins a base URL and a path without doubling or dropping the slash. */
export function joinUrl(baseUrl: string, path = ''): string {
  if (!path) return baseUrl;
  if (/^https?:\/\//i.test(path)) return path;
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
