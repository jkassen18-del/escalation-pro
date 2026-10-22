import { ApiError } from '@/lib/api';
import type { SamlServiceProvider, SamlSettings, TeamLink, TeamLinkIcon } from '@shared/sso';

/** Client for single sign-on settings and team links. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
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

export interface SsoBootstrap {
  enabled: boolean;
  label: string;
  required: boolean;
  provider: 'entra' | 'generic';
}

export type TeamLinkInput = { teamId: string; name: string; url: string; icon: TeamLinkIcon; description?: string | null };

export const ssoApi = {
  bootstrap: async (): Promise<SsoBootstrap | null> => {
    const result = await request<{ sso?: SsoBootstrap }>('GET', '/auth/bootstrap');
    return result.sso ?? null;
  },
  /** A full-page navigation, not a fetch: the identity provider takes over the browser. */
  loginUrl: (returnTo = '/') => `/api/auth/saml/login?returnTo=${encodeURIComponent(returnTo)}`,
  get: () => request<{ settings: SamlSettings; serviceProvider: SamlServiceProvider }>('GET', '/sso/saml'),
  save: (settings: SamlSettings) => request<{ settings: SamlSettings; serviceProvider: SamlServiceProvider }>('PUT', '/sso/saml', settings),
  importMetadata: (url: string) => request<{ metadata: { entityId: string; loginUrl: string; certificate: string } }>('POST', '/sso/saml/import-metadata', { url }),
};

export const teamLinksApi = {
  mine: () => request<{ links: TeamLink[] }>('GET', '/team-links/mine'),
  list: (teamId: string) => request<{ links: TeamLink[] }>('GET', `/team-links?teamId=${encodeURIComponent(teamId)}`),
  create: (input: TeamLinkInput) => request<{ link: TeamLink }>('POST', '/team-links', input),
  update: (id: string, input: TeamLinkInput & { position?: number }) => request<{ link: TeamLink }>('PUT', `/team-links/${id}`, input),
  remove: (id: string) => request<void>('DELETE', `/team-links/${id}`),
};
