import { ApiError } from '@/lib/api';
import type { CatalogueStatus } from '@shared/types';

/** Client for the Integrations catalogue and its guided setups. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/integrations${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    throw new ApiError(response.status, payload?.error ?? `Request failed with status ${response.status}`, payload?.details);
  }
  return payload as T;
}

export interface SlackAppState {
  clientId: string | null;
  hasClientSecret: boolean;
  hasSigningSecret: boolean;
  command: string;
  appName: string;
  installedTeam: string | null;
  installedAt: string | null;
  hasBotToken: boolean;
  channel: string | null;
}

export interface SlackSetup {
  app: SlackAppState;
  base: string;
  publicUrl: boolean;
  manifest: Record<string, unknown>;
  createUrl: string;
  scopes: string[];
  redirectUrl: string;
}

export interface TeamsConsentState {
  consent: { grantedAt?: string; tenant?: string; error?: string; failedAt?: string };
  appId: string | null;
  tenantId: string | null;
  redirectUrl: string;
}

export type TeamsCommandAction =
  | { type: 'department'; teamId: string }
  | { type: 'template'; templateId: string }
  | { type: 'reply'; text: string; url?: string | null };

export interface TeamsCommand {
  id: string;
  kind: 'builtin' | 'department' | 'custom';
  title: string;
  description: string;
  enabled: boolean;
  builtin?: string;
  teamId?: string;
  action?: TeamsCommandAction;
  listed: boolean;
}

export interface TeamsAppState {
  version: string;
  lastDownload: { version: string; at: string } | null;
  updateAvailable: boolean;
  changes: string[];
  problems: string[];
  settings: { name: string; defaultName: string; shortDescription: string; fullDescription: string; accentColor: string; hasCustomIcon: boolean; hasCustomOutline: boolean; minimumVersion: string };
  commands: TeamsCommand[];
  limits: { commands: number; commandTitle: number; commandDescription: number; shortName: number; fullName: number; shortDescription: number; fullDescription: number };
}

export interface TeamsAppInput {
  name?: string;
  shortDescription?: string;
  fullDescription?: string;
  accentColor?: string;
  icon?: string | null;
  outline?: string | null;
  minimumVersion?: string;
  commands?: Array<{ id?: string; kind: TeamsCommand['kind']; ref?: string; title?: string; description: string; enabled: boolean; action?: TeamsCommandAction }>;
}

export const setupApi = {
  catalogue: () => request<{ status: Record<string, CatalogueStatus> }>('GET', '/catalogue'),
  slack: {
    setup: () => request<SlackSetup>('GET', '/slack/setup'),
    saveApp: (input: { clientId?: string; clientSecret?: string; signingSecret?: string; command?: string; appName?: string }) =>
      request<{ app: SlackAppState }>('PUT', '/slack/app', input),
    startInstall: () => request<{ url: string }>('POST', '/slack/oauth/start'),
    channels: () => request<{ channels: Array<{ id: string; name: string; isPrivate: boolean; isMember: boolean }> }>('GET', '/slack/channels'),
    setChannel: (channel: string) => request<{ result: { ok: boolean; message: string } }>('PUT', '/slack/channel', { channel }),
  },
  teams: {
    consent: () => request<TeamsConsentState>('GET', '/msteams/consent'),
    startConsent: () => request<{ url: string }>('POST', '/msteams/consent/start'),
    app: () => request<TeamsAppState>('GET', '/msteams/app'),
    saveApp: (input: TeamsAppInput) => request<TeamsAppState>('PUT', '/msteams/app', input),
    packageUrl: '/api/integrations/msteams/app-package',
  },
};
