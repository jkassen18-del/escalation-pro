import type {
  DataSourceSummary,
  TeamRoute,
  TeamFormField,
  AppSettings,
  AuditEntry,
  IntegrationProvider,
  IntegrationSummary,
  Notification,
  Permission,
  PublicUser,
  ReportSummary,
  Team,
  Ticket,
  TicketDetail,
  Alert,
  AlertSource,
  ApiKeySummary,
  Heartbeat,
} from '@shared/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers:
      init.body instanceof FormData
        ? (init.headers as Record<string, string>)
        : { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) },
    ...init,
  });

  if (response.status === 204) return undefined as T;

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload && 'error' in payload
        ? String((payload as { error: string }).error)
        : `Request failed with status ${response.status}`;
    const details =
      typeof payload === 'object' && payload && 'details' in payload
        ? ((payload as { details?: Record<string, string> }).details ?? undefined)
        : undefined;
    throw new ApiError(response.status, message, details);
  }

  return payload as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

/** Drops empty values so the query string stays readable. */
export function toQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export const api = {
  auth: {
    bootstrap: () =>
      get<{
        setupRequired: boolean;
        organizationName: string;
        registrationOpen: boolean;
        setupTokenRequired: boolean;
      }>('/auth/bootstrap'),
    setup: (body: {
      name: string;
      email: string;
      password: string;
      organizationName: string;
      setupToken?: string;
    }) =>
      post<{ user: PublicUser }>('/auth/setup', body),
    login: (body: { login: string; password: string }) => post<{ user: PublicUser }>('/auth/login', body),
    logout: () => post<{ ok: true }>('/auth/logout'),
    me: () => get<{ user: PublicUser }>('/auth/me'),
    changePassword: (body: { currentPassword: string; newPassword: string }) =>
      post<{ ok: true }>('/auth/change-password', body),
  },

  tickets: {
    list: (params: Record<string, string | number | boolean | undefined>) =>
      get<{ tickets: Ticket[]; total: number; limit: number; offset: number }>(`/tickets${toQuery(params)}`),
    counts: () =>
      get<{ all: number; mine: number; unassigned: number; overdue: number; open: number }>('/tickets/counts'),
    get: (id: string) => get<{ ticket: TicketDetail }>(`/tickets/${id}`),
    create: (body: Record<string, unknown>) => post<{ ticket: Ticket }>('/tickets', body),
    update: (id: string, body: Record<string, unknown>) => patch<{ ticket: Ticket }>(`/tickets/${id}`, body),
    remove: (id: string) => del<{ ok: true }>(`/tickets/${id}`),
    comment: (id: string, body: { body: string; bodyFormat?: 'text' | 'html'; isInternal: boolean }) =>
      post<{ ticket: TicketDetail }>(`/tickets/${id}/comments`, body),
    escalate: (id: string, body: { reason: string }) => post<{ ticket: Ticket }>(`/tickets/${id}/escalate`, body),
    watch: (id: string, watch: boolean) => post<{ ticket: Ticket }>(`/tickets/${id}/watch`, { watch }),
    pushToLinear: (id: string) => post<{ ticket: Ticket }>(`/tickets/${id}/push-to-linear`),
    upload: (id: string, files: File[]) => {
      const form = new FormData();
      for (const file of files) form.append('files', file);
      return request<{ ok: true; count: number }>(`/tickets/${id}/attachments`, { method: 'POST', body: form });
    },
    removeAttachment: (ticketId: string, attachmentId: string) =>
      del<{ ok: true }>(`/tickets/${ticketId}/attachments/${attachmentId}`),
  },

  users: {
    list: () => get<{ users: PublicUser[] }>('/users'),
    directory: () =>
      get<{
        users: Array<{
          id: string;
          name: string;
          email: string;
          avatarColor: string;
          jobTitle: string | null;
          role: string;
          teamIds: string[];
        }>;
      }>('/users/directory'),
    meta: () =>
      get<{
        roles: Array<{ value: string; label: string; description: string }>;
        permissionGroups: Array<{
          label: string;
          permissions: Array<{ key: Permission; label: string; hint: string }>;
        }>;
        allPermissions: Permission[];
      }>('/users/meta'),
    get: (id: string) => get<{ user: PublicUser }>(`/users/${id}`),
    create: (body: Record<string, unknown>) =>
      post<{ user: PublicUser; temporaryPassword?: string }>('/users', body),
    update: (id: string, body: Record<string, unknown>) => patch<{ user: PublicUser }>(`/users/${id}`, body),
    resetPassword: (id: string, body: { password?: string; mustChangePassword?: boolean }) =>
      post<{ ok: true; temporaryPassword?: string }>(`/users/${id}/reset-password`, body),
    remove: (id: string) => del<{ ok: true }>(`/users/${id}`),
  },

  teams: {
    list: () => get<{ teams: Team[] }>('/teams'),
    create: (body: Record<string, unknown>) => post<{ team: Team }>('/teams', body),
    update: (id: string, body: Record<string, unknown>) => patch<{ team: Team }>(`/teams/${id}`, body),
    remove: (id: string) => del<{ ok: true }>(`/teams/${id}`),
    form: (id: string) => get<{ fields: TeamFormField[] }>(`/teams/${id}/form`),
    allForms: () => get<{ forms: Record<string, TeamFormField[]> }>('/teams/forms/all'),
    routing: (id: string) => get<{ routes: TeamRoute[] }>(`/teams/${id}/routing`),
    saveRouting: (id: string, routes: unknown[]) =>
      request<{ routes: TeamRoute[] }>(`/teams/${id}/routing`, { method: 'PUT', body: JSON.stringify({ routes }) }),
    saveForm: (id: string, fields: unknown[]) =>
      request<{ fields: TeamFormField[] }>(`/teams/${id}/form`, { method: 'PUT', body: JSON.stringify({ fields }) }),
  },

  notifications: {
    list: () => get<{ notifications: Notification[]; unread: number }>('/notifications'),
    markRead: (ids?: string[]) => post<{ ok: true; unread: number }>('/notifications/read', { ids }),
  },

  settings: {
    get: () => get<{ settings: AppSettings }>('/settings'),
    update: (body: Partial<AppSettings>) => patch<{ settings: AppSettings }>('/settings', body),
  },

  infragrid: {
    overview: () =>
      get<{ sources: AlertSource[]; alerts: Alert[]; heartbeats: Heartbeat[] }>('/infragrid'),
    /** The ingest token comes back once here and is never retrievable again. */
    createSource: (body: { name: string; kind: string; teamId?: string | null; ticketThreshold?: string }) =>
      post<{ source: AlertSource; token: string }>('/infragrid/sources', body),
    updateSource: (id: string, body: Record<string, unknown>) =>
      patch<{ source: AlertSource }>(`/infragrid/sources/${id}`, body),
    removeSource: (id: string) => del<{ ok: true }>(`/infragrid/sources/${id}`),
    createHeartbeat: (body: { name: string; periodSeconds: number; graceSeconds?: number; teamId?: string | null }) =>
      post<{ heartbeat: Heartbeat }>('/infragrid/heartbeats', body),
    removeHeartbeat: (id: string) => del<{ ok: true }>(`/infragrid/heartbeats/${id}`),
  },

  apiKeys: {
    list: () => get<{ keys: ApiKeySummary[] }>('/settings/api-keys'),
    /** The token comes back once here and is never retrievable again. */
    create: (body: { name: string; scopes: string[]; defaultTeamId?: string | null }) =>
      post<{ key: ApiKeySummary; token: string }>('/settings/api-keys', body),
    revoke: (id: string) => del<{ ok: true }>(`/settings/api-keys/${id}`),
  },

  dataSources: {
    /**
     * Without integrations.manage the server returns only id and name, so the
     * shape is narrowed here rather than pretending the rest is present.
     */
    list: () => get<{ dataSources: Array<Partial<DataSourceSummary> & { id: string; name: string }> }>('/data-sources'),
    create: (body: Record<string, unknown>) => post<{ dataSource: DataSourceSummary }>('/data-sources', body),
    update: (id: string, body: Record<string, unknown>) =>
      patch<{ dataSource: DataSourceSummary }>(`/data-sources/${id}`, body),
    remove: (id: string) => del<{ ok: true }>(`/data-sources/${id}`),
    test: (id: string) =>
      post<{ ok: boolean; message: string; sample: Array<{ value: string; label: string }>; dataSource: DataSourceSummary }>(
        `/data-sources/${id}/test`,
      ),
    lookup: (id: string, query: string) =>
      get<{ rows: Array<{ value: string; label: string }> }>(`/data-sources/${id}/lookup?q=${encodeURIComponent(query)}`),
  },

  branding: {
    get: () => get<{ organizationName: string; logoUrl: string | null }>('/branding'),
    uploadLogo: (file: File) => {
      const form = new FormData();
      form.append('logo', file);
      return request<{ logoUrl: string }>('/branding/logo', { method: 'PUT', body: form });
    },
    removeLogo: () => del<{ logoUrl: null }>('/branding/logo'),
  },

  integrations: {
    list: () => get<{ integrations: IntegrationSummary[] }>('/integrations'),
    update: (
      provider: IntegrationProvider,
      body: { enabled?: boolean; config?: Record<string, unknown>; events?: Record<string, boolean> },
    ) => patch<{ integration: IntegrationSummary }>(`/integrations/${provider}`, body),
    test: (provider: IntegrationProvider, body?: { recipient?: string }) =>
      post<{ ok: boolean; message: string; details?: Record<string, unknown>; integration: IntegrationSummary }>(
        `/integrations/${provider}/test`,
        body,
      ),
    /** The key is optional: without it the server uses the saved one. */
    linearTeams: (apiKey?: string) =>
      post<{ teams: Array<{ id: string; key: string; name: string }> }>('/integrations/linear/teams', { apiKey }),
    deliveries: () =>
      get<{
        deliveries: Array<{
          id: string;
          provider: string;
          event: string;
          ticketId: string | null;
          ok: boolean;
          statusCode: number | null;
          error: string | null;
          createdAt: string;
        }>;
      }>('/integrations/deliveries'),
  },

  reports: {
    summary: (params: { from?: string; to?: string }) =>
      get<{ summary: ReportSummary; range: { from: string; to: string }; ticketCount: number }>(
        `/reports/summary${toQuery(params)}`,
      ),
    exportUrl: (params: { from?: string; to?: string }) => `/api/reports/export${toQuery(params)}`,
  },

  audit: {
    list: (params: Record<string, string | number | undefined>) =>
      get<{ entries: AuditEntry[]; total: number; limit: number; offset: number }>(`/audit${toQuery(params)}`),
  },
};
