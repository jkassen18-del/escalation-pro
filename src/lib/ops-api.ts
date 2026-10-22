import { ApiError, toQuery } from '@/lib/api';
import type {
  Alert,
  AlertRule,
  AlertRuleActions,
  AlertRuleMatch,
  RoutingOutcome,
  AlertSource,
  BackupJob,
  BackupRun,
  DatabaseHealth,
  EscalationPolicy,
  MaintenanceWindow,
  Monitor,
  MonitorCheck,
  MonitorDay,
  NotificationAttempt,
  NotificationRule,
  Page,
  Schedule,
  Shift,
  StatusPage,
  StatusPageView,
  TelephonySettings,
} from '@shared/ops';

/**
 * Client for /api/ops: monitoring, alerts, on-call, status pages and backups.
 * Kept apart from api.ts so the core ticketing client stays readable.
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/ops${path}`, {
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

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body);
const put = <T>(path: string, body: unknown) => request<T>('PUT', path, body);
const del = (path: string) => request<void>('DELETE', path);

export interface OpsOverview {
  monitors: { total: number; down: number; up: number };
  openAlerts: Alert[];
  activePages: Page[];
  myPages: Page[];
  onCall: Array<{ scheduleId: string; scheduleName: string; teamName: string | null; userId?: string; userName?: string; until?: string | null }>;
  backups: { total: number; failing: number };
}

export type MonitorInput = Pick<
  Monitor,
  'name' | 'kind' | 'target' | 'config' | 'intervalSecs' | 'graceSecs' | 'failureThreshold' | 'teamId' | 'severity' | 'escalationPolicyId' | 'enabled'
>;
export type AlertSourceInput = Pick<AlertSource, 'name' | 'kind' | 'teamId' | 'escalationPolicyId' | 'defaultSeverity' | 'mapping' | 'enabled'>;
export type ScheduleInput = Pick<Schedule, 'name' | 'description' | 'teamId' | 'timeZone'> & { layers: Array<Omit<Schedule['layers'][number], 'id'>> };
export type PolicyInput = Pick<EscalationPolicy, 'name' | 'description' | 'teamId' | 'repeatCount'> & {
  levels: Array<{ delayMins: number; targets: Array<{ type: 'user' | 'schedule' | 'team'; id: string }> }>;
};
export type StatusPageInput = Pick<StatusPage, 'title' | 'slug' | 'description' | 'isPublic' | 'components' | 'appearance'>;
export type DatabaseInput = Pick<BackupJob, 'name' | 'engine' | 'schedule' | 'retention' | 'destination' | 'enabled' | 'teamId'> & { connection?: string };

export interface AlertRuleInput {
  name: string;
  enabled: boolean;
  match: AlertRuleMatch;
  actions: AlertRuleActions;
  continueEvaluating: boolean;
}

/** A made-up alert for the rule tester. `rule` tries an unsaved rule on its own. */
export interface AlertRuleSample {
  title: string;
  summary?: string;
  severity: string;
  sourceId?: string;
  sourceKind?: string;
  payload?: string;
  at?: string;
  rule?: AlertRuleInput;
}

export const opsApi = {
  overview: () => get<OpsOverview>('/overview'),

  monitors: {
    list: () => get<{ monitors: Monitor[] }>('/monitors'),
    get: (id: string) => get<{ monitor: Monitor; checks: MonitorCheck[]; days: MonitorDay[] }>(`/monitors/${id}`),
    create: (input: MonitorInput) => post<{ monitor: Monitor }>('/monitors', input),
    update: (id: string, input: MonitorInput) => put<{ monitor: Monitor }>(`/monitors/${id}`, input),
    remove: (id: string) => del(`/monitors/${id}`),
    check: (id: string) => post<{ monitor: Monitor; checks: MonitorCheck[] }>(`/monitors/${id}/check`),
  },

  alerts: {
    list: (params: { status?: string; ticketId?: string } = {}) => get<{ alerts: Alert[] }>(`/alerts${toQuery(params)}`),
  },

  sources: {
    list: () => get<{ sources: AlertSource[] }>('/alert-sources'),
    create: (input: AlertSourceInput) => post<{ source: AlertSource }>('/alert-sources', input),
    update: (id: string, input: AlertSourceInput) => put<{ source: AlertSource }>(`/alert-sources/${id}`, input),
    remove: (id: string) => del(`/alert-sources/${id}`),
    rotate: (id: string) => post<{ source: AlertSource }>(`/alert-sources/${id}/rotate`),
    test: (id: string) => post<{ result: { action: string; ticketId: string | null; paged: boolean } }>(`/alert-sources/${id}/test`),
  },

  alertRules: {
    list: () => get<{ rules: AlertRule[] }>('/alert-rules'),
    create: (input: AlertRuleInput) => post<{ rule: AlertRule }>('/alert-rules', input),
    update: (id: string, input: AlertRuleInput) => put<{ rule: AlertRule }>(`/alert-rules/${id}`, input),
    remove: (id: string) => del(`/alert-rules/${id}`),
    reorder: (ids: string[]) => put<{ rules: AlertRule[] }>('/alert-rules/order', { ids }),
    test: (sample: AlertRuleSample) => post<{ outcome: RoutingOutcome }>('/alert-rules/test', sample),
  },

  maintenance: {
    list: () => get<{ windows: MaintenanceWindow[] }>('/maintenance'),
    create: (input: { title: string; startsAt: string; endsAt: string; monitorIds: string[] }) => post<{ windows: MaintenanceWindow[] }>('/maintenance', input),
    remove: (id: string) => del(`/maintenance/${id}`),
  },

  schedules: {
    list: () => get<{ schedules: Schedule[] }>('/schedules'),
    get: (id: string, range: { from?: string; to?: string } = {}) => get<{ schedule: Schedule; shifts: Shift[] }>(`/schedules/${id}${toQuery(range)}`),
    create: (input: ScheduleInput) => post<{ schedule: Schedule }>('/schedules', input),
    update: (id: string, input: ScheduleInput) => put<{ schedule: Schedule }>(`/schedules/${id}`, input),
    remove: (id: string) => del(`/schedules/${id}`),
    addOverride: (id: string, input: { userId: string; startsAt: string; endsAt: string; note?: string }) =>
      post<{ schedule: Schedule }>(`/schedules/${id}/overrides`, input),
    removeOverride: (id: string, overrideId: string) => del(`/schedules/${id}/overrides/${overrideId}`),
    calendarUrl: (id: string) => `/api/ops/schedules/${id}/calendar.ics`,
  },

  policies: {
    list: () => get<{ policies: EscalationPolicy[] }>('/policies'),
    create: (input: PolicyInput) => post<{ policy: EscalationPolicy }>('/policies', input),
    update: (id: string, input: PolicyInput) => put<{ policy: EscalationPolicy }>(`/policies/${id}`, input),
    remove: (id: string) => del(`/policies/${id}`),
    teamDefaults: () => get<{ teams: Array<{ teamId: string; teamName: string; policyId: string | null }> }>('/team-policies'),
    setTeamDefault: (teamId: string, policyId: string | null) => put<{ ok: true }>(`/team-policies/${teamId}`, { policyId }),
  },

  pages: {
    list: (params: { filter?: 'active' | 'mine' | 'all'; ticketId?: string } = {}) => get<{ pages: Page[] }>(`/pages${toQuery(params)}`),
    get: (id: string) => get<{ page: Page }>(`/pages/${id}`),
    ack: (id: string) => post<{ outcome: string; page: Page }>(`/pages/${id}/ack`),
    escalate: (id: string) => post<{ page: Page }>(`/pages/${id}/escalate`),
    trigger: (ticketId: string, input: { policyId: string; severity?: string }) => post<{ page: Page | null }>(`/tickets/${ticketId}/page`, input),
  },

  me: {
    rules: () => get<{ rules: NotificationRule[]; isDefault: boolean }>('/me/rules'),
    saveRules: (rules: Array<Omit<NotificationRule, 'id'>>) => put<{ rules: NotificationRule[]; isDefault: boolean }>('/me/rules', { rules }),
    testPage: () => post<{ attempts: NotificationAttempt[] }>('/me/test-page'),
  },

  telephony: {
    get: () => get<{ telephony: TelephonySettings }>('/telephony'),
    save: (input: Partial<TelephonySettings>) => put<{ telephony: TelephonySettings }>('/telephony', input),
  },

  statusPages: {
    list: () => get<{ pages: StatusPage[] }>('/status-pages'),
    view: (id: string) => get<{ view: StatusPageView }>(`/status-pages/${id}`),
    create: (input: StatusPageInput) => post<{ page: StatusPage }>('/status-pages', input),
    update: (id: string, input: StatusPageInput) => put<{ page: StatusPage }>(`/status-pages/${id}`, input),
    remove: (id: string) => del(`/status-pages/${id}`),
    postUpdate: (id: string, input: { title: string; state: string; body: string; ticketId?: string | null }) =>
      post<{ view: StatusPageView }>(`/status-pages/${id}/updates`, input),
  },

  databases: {
    list: () => get<{ databases: BackupJob[] }>('/databases'),
    get: (id: string) => get<{ database: BackupJob; runs: BackupRun[] }>(`/databases/${id}`),
    create: (input: DatabaseInput) => post<{ database: BackupJob }>('/databases', input),
    update: (id: string, input: DatabaseInput) => put<{ database: BackupJob }>(`/databases/${id}`, input),
    remove: (id: string) => del(`/databases/${id}`),
    test: (input: { engine?: string; connection?: string; id?: string }) => post<{ health: DatabaseHealth }>('/databases/test', input),
    run: (id: string) => post<{ run: BackupRun }>(`/databases/${id}/run`),
    downloadUrl: (runId: string) => `/api/ops/backup-runs/${runId}/download`,
  },
};
