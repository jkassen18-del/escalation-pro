import type {
  DepartmentRole,
  Invite,
  InvitePreview,
  DataSourceSummary,
  HttpIntegration,
  HttpIntegrationInput,
  LinearTeamMapping,
  TeamRoute,
  TeamFormField,
  AppSettings,
  AuditEntry,
  IntegrationProvider,
  IntegrationSummary,
  Notification,
  Permission,
  Role,
  PublicUser,
  ReportSummary,
  Team,
  Ticket,
  TicketDetail,
  TicketLabel,
  OnCallContact,
  ActivityDay,
} from '@shared/types';
import type { MessageTemplate, TemplateProvider } from '@shared/message-template';
import type { ShiftException, ShiftPattern } from '@shared/shifts';

export type RoutedProvider = 'slack' | 'msteams' | 'linear' | 'github';

/** Where each department's tickets go for one provider; mirrors server/routes/integration-routing.ts. */
export interface RoutingView {
  provider: RoutedProvider;
  kind: 'pick' | 'url';
  departments: Array<{ teamId: string; teamName: string; target: string; mention: string | null }>;
  fallback: string;
  fallbackOptions: Array<{ id: string; name: string }>;
  destinations: Array<{ id: string; name: string; warning?: string | null }>;
  notice: string | null;
}

export interface ShiftPerson {
  id: string;
  name: string;
  phone: string | null;
  email: string;
  jobTitle: string | null;
}

export interface StaffedShift {
  patternId: string;
  name: string;
  date: string;
  startsAt: string;
  endsAt: string;
  note: string | null;
  leader: ShiftPerson | null;
  members: ShiftPerson[];
}

export interface DepartmentShiftStatus {
  teamId: string;
  teamName: string;
  color: string;
  timeZone: string;
  configured: boolean;
  current: StaffedShift | null;
  next: StaffedShift | null;
}

export interface DepartmentSchedule {
  teamId: string;
  timeZone: string;
  handover: { enabled?: boolean; leadMins?: number; channels?: Array<'slack' | 'msteams' | 'email'> };
  patterns: ShiftPattern[];
  exceptions: ShiftException[];
}

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
const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
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
    updatePhone: (phone: string | null) => patch<{ user: PublicUser }>('/auth/me/phone', { phone }),
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
      sampleWorkspace?: boolean;
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
    counts: (teamId?: string) =>
      get<{ all: number; mine: number; unassigned: number; overdue: number; open: number }>(`/tickets/counts${toQuery({ teamId })}`),
    get: (id: string) => get<{ ticket: TicketDetail }>(`/tickets/${id}`),
    create: (body: Record<string, unknown>) => post<{ ticket: Ticket }>('/tickets', body),
    update: (id: string, body: Record<string, unknown>) => patch<{ ticket: Ticket }>(`/tickets/${id}`, body),
    remove: (id: string) => del<{ ok: true }>(`/tickets/${id}`),
    comment: (id: string, body: { body: string; bodyFormat?: 'text' | 'html'; isInternal: boolean }) =>
      post<{ ticket: TicketDetail; commentId: string | null }>(`/tickets/${id}/comments`, body),
    escalate: (id: string, body: { reason: string; teamId?: string; priority?: string }) =>
      post<{ ticket: Ticket }>(`/tickets/${id}/escalate`, body),
    watch: (id: string, watch: boolean) => post<{ ticket: Ticket }>(`/tickets/${id}/watch`, { watch }),
    pushToLinear: (id: string, linearTeamId?: string) =>
      post<{ ticket: Ticket }>(`/tickets/${id}/push-to-linear`, linearTeamId ? { linearTeamId } : {}),
    githubTargets: (id: string) => get<{ repos: Array<{ id: string; name: string }>; suggested: string | null }>(`/tickets/${id}/github-targets`),
    pushToGitHub: (id: string, repo?: string) => post<{ ticket: Ticket }>(`/tickets/${id}/push-to-github`, repo ? { repo } : {}),
    linearTargets: (id: string) =>
      get<{ teams: Array<{ id: string; key: string; name: string }>; suggested: string | null }>(`/tickets/${id}/linear-targets`),
    upload: (id: string, files: File[], commentId?: string | null) => {
      const form = new FormData();
      // Before the files: multer only sees fields that arrive ahead of them.
      if (commentId) form.append('commentId', commentId);
      for (const file of files) form.append('files', file);
      return request<{ ok: true; count: number }>(`/tickets/${id}/attachments`, { method: 'POST', body: form });
    },
    removeAttachment: (ticketId: string, attachmentId: string) =>
      del<{ ok: true }>(`/tickets/${ticketId}/attachments/${attachmentId}`),
    activity: (params: { days?: number; teamId?: string } = {}) =>
      get<{ days: ActivityDay[]; from: string }>(
        `/tickets/activity${toQuery({ ...params, tzOffset: new Date().getTimezoneOffset() })}`,
      ),
    onCall: (id: string) => get<{ contacts: OnCallContact[]; teamsConnected: boolean }>(`/tickets/${id}/oncall`),
    notifyOnCall: (id: string, body: { userIds?: string[]; note?: string }) =>
      post<{
        results: Array<{ channel: 'in_app' | 'push' | 'msteams'; userId: string | null; status: 'sent' | 'failed' | 'skipped'; detail: string }>;
        notified: OnCallContact[];
      }>(`/tickets/${id}/notify-oncall`, body),
  },

  shifts: {
    board: () => get<{ departments: DepartmentShiftStatus[] }>('/shifts/board'),
    calendar: (teamId: string, from: string, days = 7) => get<{ shifts: StaffedShift[] }>(`/shifts/${teamId}/calendar${toQuery({ from, days })}`),
    get: (teamId: string) => get<{ schedule: DepartmentSchedule; canEdit: boolean }>(`/shifts/${teamId}`),
    save: (teamId: string, body: { timeZone?: string; handover?: DepartmentSchedule['handover']; patterns?: Array<Omit<ShiftPattern, 'id'> & { id?: string }> }) =>
      put<{ schedule: DepartmentSchedule }>(`/shifts/${teamId}`, body),
    addException: (teamId: string, body: Omit<ShiftException, 'id'>) => post<{ schedule: DepartmentSchedule }>(`/shifts/${teamId}/exceptions`, body),
    removeException: (teamId: string, id: string) => del<{ schedule: DepartmentSchedule }>(`/shifts/${teamId}/exceptions/${id}`),
    handoverPreview: (teamId: string) => get<{ text: string }>(`/shifts/${teamId}/handover/preview`),
    sendHandover: (teamId: string) => post<{ deliveries: Array<{ channel: string; ok: boolean; detail: string }> }>(`/shifts/${teamId}/handover/send`, {}),
  },

  labels: {
    list: (teamId?: string) => get<{ labels: TicketLabel[] }>(`/labels${toQuery({ teamId })}`),
    create: (body: { teamId: string | null; name: string; color: string; description?: string | null }) =>
      post<{ label: TicketLabel }>('/labels', body),
    update: (id: string, body: { name: string; color: string; description?: string | null; position?: number }) =>
      put<{ label: TicketLabel }>(`/labels/${id}`, body),
    remove: (id: string) => del<void>(`/labels/${id}`),
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
        roles: Role[];
        permissionGroups: Array<{
          label: string;
          permissions: Array<{ key: Permission; label: string; hint: string; impliedBy?: Permission; everyone?: boolean }>;
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
  invites: {
    list: () => get<{ invites: Invite[] }>('/invites'),
    create: (body: {
      label?: string | null;
      roleId: string;
      email?: string | null;
      allowedDomains?: string[];
      teamIds?: string[];
      expiresInDays?: number;
      maxUses?: number | null;
      sendEmail?: boolean;
    }) => post<{ invite: Invite; token: string; url: string; emailed: { ok: boolean; error: string | null } | null }>('/invites', body),
    revoke: (id: string) => del<{ invite: Invite }>(`/invites/${id}`),
    /** The public side, used before anyone is signed in. */
    preview: (token: string) => get<{ invite: InvitePreview }>(`/invite/${encodeURIComponent(token)}`),
    accept: (token: string, body: { firstName: string; lastName: string; email: string; teamId: string; password: string }) =>
      post<{ user: PublicUser | null; ssoRequired: boolean }>(`/invite/${encodeURIComponent(token)}/accept`, body),
  },
  roles: {
    list: () => get<{ roles: Role[] }>('/roles'),
    create: (body: { name: string; description?: string | null; permissions: Permission[] }) => post<{ role: Role }>('/roles', body),
    update: (id: string, body: { name?: string; description?: string | null; permissions?: Permission[] }) =>
      patch<{ role: Role }>(`/roles/${id}`, body),
    remove: (id: string, replacementRoleId?: string) =>
      del<{ ok: true }>(`/roles/${id}${replacementRoleId ? `?replacementRoleId=${encodeURIComponent(replacementRoleId)}` : ''}`),
  },

  teams: {
    list: () => get<{ teams: Team[] }>('/teams'),
    create: (body: Record<string, unknown>) => post<{ team: Team }>('/teams', body),
    update: (id: string, body: Record<string, unknown>) => patch<{ team: Team }>(`/teams/${id}`, body),
    remove: (id: string) => del<{ ok: true }>(`/teams/${id}`),
    setMemberRole: (teamId: string, userId: string, role: DepartmentRole) =>
      put<{ team: Team; user: PublicUser }>(`/teams/${teamId}/members/${userId}`, { role }),
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
    routing: (provider: RoutedProvider) => get<RoutingView>(`/integrations/routing/${provider}`),
    saveRouting: (
      provider: RoutedProvider,
      body: { departments: Array<{ teamId: string; target: string; mention?: string | null }>; fallback?: string },
    ) => put<RoutingView>(`/integrations/routing/${provider}`, body),
    testRouting: (provider: 'slack' | 'msteams') =>
      post<{ results: Array<{ target: string; name: string; departments: string[]; ok: boolean; error: string | null }> }>(
        `/integrations/routing/${provider}/test`,
      ),
    template: (provider: TemplateProvider) =>
      get<{ template: MessageTemplate; defaults: MessageTemplate }>(`/integrations/templates/${provider}`),
    saveTemplate: (provider: TemplateProvider, template: MessageTemplate | null) =>
      put<{ template: MessageTemplate; defaults: MessageTemplate }>(`/integrations/templates/${provider}`, { template }),
    update: (
      provider: IntegrationProvider,
      body: { enabled?: boolean; config?: Record<string, unknown>; events?: Record<string, boolean> },
    ) => patch<{ integration: IntegrationSummary }>(`/integrations/${provider}`, body),
    test: (provider: IntegrationProvider, body?: { recipient?: string }) =>
      post<{ ok: boolean; message: string; details?: Record<string, unknown>; integration: IntegrationSummary }>(
        `/integrations/${provider}/test`,
        body,
      ),
    discord: {
      overview: () =>
        get<{
          gateway: { running: boolean; connected: boolean; botUserId: string | null };
          inviteUrl: string | null;
          routes: Array<{ teamId: string; channelId: string }>;
        }>('/integrations/discord/overview'),
      channels: () =>
        get<{ channels: Array<{ id: string; name: string; guildId: string; guildName: string }> }>('/integrations/discord/channels'),
      saveRoutes: (routes: Array<{ teamId: string; channelId: string }>) =>
        request<{ routes: Array<{ teamId: string; channelId: string }> }>('/integrations/discord/routes', {
          method: 'PUT',
          body: JSON.stringify({ routes }),
        }),
    },
    /** The key is optional: without it the server uses the saved one. */
    linearTeams: (apiKey?: string) =>
      post<{ teams: Array<{ id: string; key: string; name: string }> }>('/integrations/linear/teams', { apiKey }),
    linearTeamMap: () => get<{ mappings: LinearTeamMapping[] }>('/integrations/linear/team-map'),
    saveLinearTeamMap: (mappings: LinearTeamMapping[]) =>
      request<{ mappings: LinearTeamMapping[] }>('/integrations/linear/team-map', {
        method: 'PUT',
        body: JSON.stringify({ mappings }),
      }),
    http: {
      list: () => get<{ integrations: HttpIntegration[] }>('/integrations/http'),
      create: (body: HttpIntegrationInput) => post<{ integration: HttpIntegration }>('/integrations/http', body),
      update: (id: string, body: HttpIntegrationInput) =>
        request<{ integration: HttpIntegration }>(`/integrations/http/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
      remove: (id: string) => del<void>(`/integrations/http/${id}`),
      test: (id: string) =>
        post<{ result: { ok: boolean; statusCode: number | null; error: string | null; responseExcerpt: string | null } }>(
          `/integrations/http/${id}/test`,
        ),
    },
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

  discord: {
    me: () => get<{ available: boolean; linked: boolean; discordUsername: string | null }>('/discord/me'),
    link: (code: string) => post<{ linked: true; discordUsername: string }>('/discord/link', { code }),
    unlink: () => del<{ linked: false }>('/discord/link'),
  },

  audit: {
    list: (params: Record<string, string | number | undefined>) =>
      get<{ entries: AuditEntry[]; total: number; limit: number; offset: number }>(`/audit${toQuery(params)}`),
  },
};
