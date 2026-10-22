/**
 * Types for the operations side of InfraTicket: monitoring, alerts, on-call,
 * status pages and database backups. Shared by the API and the client, like
 * ./types.ts.
 */

export const SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_LABELS: Record<Severity, string> = {
  sev1: 'SEV1 · Critical',
  sev2: 'SEV2 · Major',
  sev3: 'SEV3 · Minor',
  sev4: 'SEV4 · Low',
};

/* ------------------------------ Monitoring ------------------------------- */

export const MONITOR_KINDS = ['http', 'tcp', 'ping', 'dns', 'ssl', 'heartbeat', 'database'] as const;
export type MonitorKind = (typeof MONITOR_KINDS)[number];

export const MONITOR_KIND_LABELS: Record<MonitorKind, string> = {
  http: 'HTTP(S)',
  tcp: 'TCP port',
  ping: 'Ping (ICMP)',
  dns: 'DNS record',
  ssl: 'SSL certificate expiry',
  heartbeat: 'Heartbeat (cron / job)',
  database: 'Database health',
};

export type MonitorState = 'pending' | 'up' | 'down' | 'paused';

/** Kind-specific settings. Every field is optional; defaults are applied server-side. */
export interface MonitorConfig {
  /* http */
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  body?: string;
  /** e.g. "200-299" or "200,204". Defaults to 200-399. */
  expectedStatus?: string;
  /** Response must contain this text. */
  keyword?: string;
  /** Fail when the response contains the keyword instead. */
  keywordInverted?: boolean;
  maxResponseMs?: number;
  /* http + tcp + dns + ping + database */
  timeoutMs?: number;
  /* dns */
  recordType?: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS';
  expectedValue?: string;
  /* ssl */
  warnDays?: number;
  /* database: the database connector (a backup job) whose connection is checked */
  databaseId?: string;
}

export interface Monitor {
  id: string;
  name: string;
  kind: MonitorKind;
  /** URL, host:port, hostname, or empty for heartbeat/database. */
  target: string;
  config: MonitorConfig;
  intervalSecs: number;
  /** Heartbeat only: how late a ping may be before it counts as missed. */
  graceSecs: number;
  /** Consecutive failures before the monitor is marked down. */
  failureThreshold: number;
  teamId: string | null;
  teamName: string | null;
  severity: Severity;
  escalationPolicyId: string | null;
  enabled: boolean;
  state: MonitorState;
  lastCheckedAt: string | null;
  lastChangeAt: string | null;
  lastLatencyMs: number | null;
  lastMessage: string | null;
  consecutiveFailures: number;
  /** Heartbeat only: the URL to ping. */
  heartbeatUrl: string | null;
  /** Percentage over the last 24 hours, or null with no checks yet. */
  uptime24h: number | null;
  /** The maintenance window covering this monitor right now, if any. */
  maintenance: { windowId: string; title: string; endsAt: string; effect: MaintenanceEffect } | null;
  createdAt: string;
  updatedAt: string;
}

export interface MonitorCheck {
  id: string;
  ok: boolean;
  latencyMs: number | null;
  message: string;
  createdAt: string;
}

export interface MonitorDay {
  day: string;
  total: number;
  failures: number;
  /** Failed checks during maintenance: neither up nor an outage. */
  maintenance?: number;
}

/* --------------------------------- Alerts -------------------------------- */

export const ALERT_SOURCE_KINDS = [
  'generic',
  'aws_sns',
  'azure_monitor',
  'cloudflare',
  'jenkins',
  'grafana',
  'digitalocean',
  'entra_id',
  'stratigix',
] as const;
export type AlertSourceKind = (typeof ALERT_SOURCE_KINDS)[number];

export const ALERT_SOURCE_LABELS: Record<AlertSourceKind, string> = {
  generic: 'Generic webhook',
  aws_sns: 'AWS CloudWatch / SNS',
  azure_monitor: 'Azure Monitor (common alert schema)',
  cloudflare: 'Cloudflare Notifications',
  jenkins: 'Jenkins',
  grafana: 'Grafana / Prometheus Alertmanager',
  digitalocean: 'DigitalOcean (webhook)',
  entra_id: 'Entra ID / Microsoft 365 (webhook)',
  stratigix: 'Stratigix (generic mapping)',
};

/** JSON paths (dot notation, e.g. "alert.labels.severity") into a generic payload. */
export interface AlertFieldMapping {
  title?: string;
  summary?: string;
  severity?: string;
  dedupKey?: string;
  status?: string;
  /** Payload values that mean "resolved", compared case-insensitively. */
  resolvedValues?: string[];
}

export interface AlertSource {
  id: string;
  name: string;
  kind: AlertSourceKind;
  teamId: string | null;
  teamName: string | null;
  escalationPolicyId: string | null;
  defaultSeverity: Severity;
  mapping: AlertFieldMapping;
  enabled: boolean;
  /** Full URL to POST alerts to. Contains the source's secret token. */
  webhookUrl: string;
  lastEventAt: string | null;
  eventCount: number;
  createdAt: string;
}

export type AlertStatus = 'firing' | 'acknowledged' | 'resolved';

export interface Alert {
  id: string;
  sourceType: 'monitor' | 'webhook';
  sourceId: string;
  sourceName: string;
  dedupKey: string;
  title: string;
  summary: string;
  severity: Severity;
  status: AlertStatus;
  count: number;
  ticketId: string | null;
  ticketReference: string | null;
  suppressed: boolean;
  /** The routing rule that decided where this alert went, if one matched. */
  ruleName: string | null;
  payload: unknown;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

export const MAINTENANCE_EFFECTS = ['pause_paging', 'pause_alerting'] as const;
/**
 * pause_paging: alerts are recorded and open tickets as usual, but nobody is paged.
 * pause_alerting: alerts are recorded as suppressed; no tickets, no pages.
 */
export type MaintenanceEffect = (typeof MAINTENANCE_EFFECTS)[number];

export const MAINTENANCE_EFFECT_LABELS: Record<MaintenanceEffect, string> = {
  pause_paging: 'Pause paging (still open tickets)',
  pause_alerting: 'Pause alerting (record only, no tickets)',
};

/** What a window covers. Any combination; `everything` overrides the rest. */
export interface MaintenanceScope {
  everything?: boolean;
  monitorIds?: string[];
  /** Alert sources (webhooks). */
  sourceIds?: string[];
  /** Every monitor and alert source belonging to these teams. */
  teamIds?: string[];
  /** Status page components: the monitor behind each, as shown on that page. */
  components?: Array<{ statusPageId: string; monitorId: string }>;
}

export const MAINTENANCE_RECURRENCE_KINDS = ['none', 'daily', 'weekly', 'monthly'] as const;
export type MaintenanceRecurrenceKind = (typeof MAINTENANCE_RECURRENCE_KINDS)[number];

/** A repeating window, written in its own time zone ("every Sunday 22:00 SAST for 3 hours"). */
export interface MaintenanceRecurrence {
  kind: MaintenanceRecurrenceKind;
  /** Weekly: 0 = Sunday ... 6 = Saturday. */
  daysOfWeek?: number[];
  /** Monthly: 1-31; a shorter month uses its last day. */
  dayOfMonth?: number;
  /** Wall-clock start, HH:MM. */
  startTime?: string;
  durationMins?: number;
  /** First date the series can occur on, YYYY-MM-DD. */
  startDate?: string;
  /** Last date it can start on, YYYY-MM-DD; null runs indefinitely. */
  until?: string | null;
}

export type MaintenanceState = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';

/** One concrete period of a window. A one-off window has exactly one. */
export interface MaintenanceOccurrence {
  windowId: string;
  /** Stable id of the occurrence: its originally scheduled start. */
  key: string;
  startsAt: string;
  endsAt: string;
  title: string;
  effect: MaintenanceEffect;
}

export interface MaintenanceWindow {
  id: string;
  title: string;
  description: string | null;
  scope: MaintenanceScope;
  /** Plain-language summary of the scope, e.g. "3 monitors, team Web". */
  scopeSummary: string;
  effect: MaintenanceEffect;
  recurrence: MaintenanceRecurrence;
  timeZone: string;
  /** One-off: the window. Recurring: when the series starts and (if set) stops. */
  startsAt: string;
  endsAt: string;
  notifyBeforeMins: number;
  publishToStatusPages: boolean;
  state: MaintenanceState;
  currentOccurrence: MaintenanceOccurrence | null;
  nextOccurrence: MaintenanceOccurrence | null;
  cancelledAt: string | null;
  /** Legacy field, the scope's monitor ids. */
  monitorIds: string[];
  createdByName: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface MaintenanceInput {
  title: string;
  description?: string | null;
  scope: MaintenanceScope;
  effect: MaintenanceEffect;
  recurrence: MaintenanceRecurrence;
  timeZone: string;
  /** One-off only. */
  startsAt?: string;
  endsAt?: string;
  notifyBeforeMins?: number;
  publishToStatusPages?: boolean;
}

/* ----------------------------- Alert routing ----------------------------- */

/**
 * What a rule looks at. Every condition that is set must hold; an empty match
 * matches every alert.
 */
export interface AlertRuleMatch {
  /** Specific monitors or alert sources, by id. */
  sourceIds?: string[];
  /** Monitor kinds (http, tcp, database...) or alert source kinds (aws_sns, jenkins...). */
  sourceKinds?: string[];
  /** Searched in the title and summary, case-insensitively. */
  text?: string;
  textMode?: 'contains' | 'regex';
  severities?: Severity[];
  /** A payload field, e.g. "labels.service" equals "checkout". */
  field?: { path: string; op: 'equals' | 'contains'; value: string };
  /** Only inside or only outside working hours in a time zone. */
  timeWindow?: { mode: 'business_hours' | 'after_hours'; timeZone: string; days: number[]; startHour: number; endHour: number };
}

export interface AlertRuleActions {
  /** Route the incident to this department. */
  teamId?: string | null;
  escalationPolicyId?: string | null;
  severity?: Severity | null;
  tags?: string[];
  /** Open the ticket, page nobody. */
  suppressPaging?: boolean;
  /** Ignore the alert entirely. It still counts as received on its source. */
  drop?: boolean;
}

export interface AlertRule {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  match: AlertRuleMatch;
  actions: AlertRuleActions;
  /** Keep evaluating later rules after this one matches; later actions add to or override earlier ones. */
  continueEvaluating: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What routing decided for one alert. Returned by the rule tester. */
export interface RoutingOutcome {
  matchedRules: Array<{ id: string; name: string }>;
  teamId: string | null;
  escalationPolicyId: string | null;
  severity: Severity;
  tags: string[];
  suppressPaging: boolean;
  drop: boolean;
  /** Plain-English summary, as written on the ticket. */
  explanation: string;
}

/* -------------------------------- On-call -------------------------------- */

/**
 * `roster` is not a rotation at all: a fixed list of who covers which dates
 * ("week 1 Jamal, week 2 Kopano"), set by hand.
 */
export const ROTATION_KINDS = ['daily', 'weekly', 'custom', 'roster'] as const;
export type RotationKind = (typeof ROTATION_KINDS)[number];

export interface ScheduleLayer {
  id: string;
  name: string;
  /** Higher wins when two layers both have someone on call. */
  position: number;
  rotation: RotationKind;
  /** Length of one shift, in hours. 24 for daily, 168 for weekly. */
  shiftHours: number;
  /** When the first shift starts; every handoff is a whole number of shifts later. */
  startsAt: string;
  memberIds: string[];
  /** Roster layers only: explicit cover, each [startsAt, endsAt). Gaps mean nobody from this layer. */
  entries: RosterEntry[];
}

export interface RosterEntry {
  userId: string;
  startsAt: string;
  endsAt: string;
}

export interface ScheduleOverride {
  id: string;
  userId: string;
  userName: string | null;
  startsAt: string;
  endsAt: string;
  note: string | null;
}

export interface Schedule {
  id: string;
  name: string;
  description: string | null;
  teamId: string | null;
  teamName: string | null;
  timeZone: string;
  layers: ScheduleLayer[];
  overrides: ScheduleOverride[];
  /** Resolved at request time. */
  onCallNow: { userId: string; userName: string; until: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface Shift {
  userId: string;
  userName: string;
  startsAt: string;
  endsAt: string;
  source: 'layer' | 'override';
  layerId: string | null;
}

export const ESCALATION_TARGET_TYPES = ['user', 'schedule', 'team'] as const;
export type EscalationTargetType = (typeof ESCALATION_TARGET_TYPES)[number];

export interface EscalationTarget {
  type: EscalationTargetType;
  id: string;
  /** Filled in when read, for display. */
  name?: string;
}

export interface EscalationLevel {
  id: string;
  position: number;
  /** Minutes without an acknowledgement before moving on to the next level. */
  delayMins: number;
  targets: EscalationTarget[];
}

export interface EscalationPolicy {
  id: string;
  name: string;
  description: string | null;
  teamId: string | null;
  teamName: string | null;
  /** How many times to run the whole policy again once the last level is exhausted. */
  repeatCount: number;
  levels: EscalationLevel[];
  createdAt: string;
  updatedAt: string;
}

export const NOTIFY_CHANNELS = ['in_app', 'push', 'email', 'sms', 'voice', 'teams_call', 'discord', 'chat'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

export const NOTIFY_CHANNEL_LABELS: Record<NotifyChannel, string> = {
  in_app: 'In-app / browser',
  push: 'Phone push',
  email: 'Email',
  sms: 'SMS',
  voice: 'Phone call',
  teams_call: 'Teams call',
  discord: 'Discord DM',
  chat: 'Slack / Teams',
};

/** Channels loud enough to wake someone: high urgency must include one. */
export const WAKE_UP_CHANNELS: readonly NotifyChannel[] = ['sms', 'voice', 'teams_call', 'discord'];

/** Channels that ring, and repeat every voiceRepeatMins until answered. */
export const CALL_CHANNELS: readonly NotifyChannel[] = ['voice', 'teams_call'];

export type Urgency = 'high' | 'low';

export interface NotificationRule {
  id: string;
  urgency: Urgency;
  channel: NotifyChannel;
  delayMins: number;
}

export type PageStatus = 'triggered' | 'acknowledged' | 'resolved' | 'exhausted';

export interface NotificationAttempt {
  id: string;
  pageId: string | null;
  userId: string;
  userName: string | null;
  channel: NotifyChannel;
  provider: string;
  status: 'sent' | 'simulated' | 'failed' | 'skipped' | 'answered' | 'missed' | 'acknowledged';
  level: number;
  cycle: number;
  seq: number;
  detail: string | null;
  createdAt: string;
}

export interface Page {
  id: string;
  ticketId: string;
  ticketReference: string | null;
  ticketSubject: string | null;
  severity: Severity;
  urgency: Urgency;
  policyId: string | null;
  policyName: string | null;
  status: PageStatus;
  currentLevel: number;
  cycle: number;
  levelStartedAt: string;
  currentTargetIds: string[];
  acknowledgedById: string | null;
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  /** "Why did this page me?": the routing that chose this policy. */
  reason: string;
  createdAt: string;
  attempts?: NotificationAttempt[];
  policy?: EscalationPolicy | null;
}

export interface TelephonySettings {
  provider: 'sandbox' | 'twilio';
  accountSid?: string;
  /** Write-only. Reads return hasAuthToken instead. */
  authToken?: string;
  hasAuthToken?: boolean;
  fromNumber?: string;
  /** Minutes between repeated calls while a page is unacknowledged. */
  voiceRepeatMins: number;
  /** Calls placed per person per escalation level before giving up on voice. */
  voiceMaxCalls: number;
}

/** Ringing people in Microsoft Teams through the Teams bot. */
export interface TeamsCallSettings {
  enabled: boolean;
  /** Whether a WAV prompt is uploaded; with one, callers press 1 to acknowledge. */
  hasPrompt: boolean;
  promptUpdatedAt: string | null;
  /** Where Microsoft must be able to post call events. */
  callingWebhookUrl: string | null;
  /** True when the Teams integration is in bot mode with an app id, secret and tenant. */
  botConfigured: boolean;
}

/* ------------------------------ Status pages ----------------------------- */

export interface StatusComponent {
  monitorId: string;
  label: string;
}

export type ComponentStatus = 'operational' | 'degraded' | 'outage' | 'maintenance' | 'unknown';

export const STATUS_UPDATE_STATES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
/** 'maintenance' is posted by maintenance windows themselves, not chosen by people. */
export type StatusUpdateState = (typeof STATUS_UPDATE_STATES)[number] | 'maintenance';

export interface StatusUpdate {
  id: string;
  ticketId: string | null;
  title: string;
  state: StatusUpdateState;
  body: string;
  createdAt: string;
}

/** How a status page looks. Every field is optional; the defaults match the app. */
export interface StatusPageAppearance {
  /** 'auto' follows the visitor's light/dark preference. */
  theme?: 'auto' | 'light' | 'dark';
  /** Brand colour for links, the header rule and highlights, as #rrggbb. */
  accentColor?: string;
  /** Show the organisation logo uploaded under Settings. */
  showLogo?: boolean;
  /** Replaces the organisation name in the header. */
  headerText?: string;
  /** "Need help? Contact support" link under the page. */
  supportUrl?: string;
  footerText?: string;
  /** Extra CSS appended last, for a fully custom look. */
  customCss?: string;
}

export interface StatusPage {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  isPublic: boolean;
  components: StatusComponent[];
  appearance: StatusPageAppearance;
  createdAt: string;
  updatedAt: string;
}

export interface StatusPageView {
  page: StatusPage;
  overall: ComponentStatus;
  components: Array<StatusComponent & { status: ComponentStatus; uptime90d: number | null; days: MonitorDay[] }>;
  /** Published maintenance touching this page: in progress now, and starting within 7 days. */
  maintenance?: Array<{ title: string; description: string | null; startsAt: string; endsAt: string; timeZone: string; inProgress: boolean; components: string[] }>;
  updates: StatusUpdate[];
  generatedAt: string;
}

/* -------------------------------- Backups -------------------------------- */

export const BACKUP_ENGINES = ['postgres', 'supabase', 'mysql', 'mongodb', 'sqlite', 'sqlserver'] as const;
export type BackupEngine = (typeof BACKUP_ENGINES)[number];

export const BACKUP_ENGINE_LABELS: Record<BackupEngine, string> = {
  postgres: 'PostgreSQL (pg_dump)',
  supabase: 'Supabase (pg_dump over the direct connection)',
  mysql: 'MySQL / MariaDB (mysqldump)',
  mongodb: 'MongoDB (mongodump)',
  sqlite: 'SQLite (online backup, no tools needed)',
  sqlserver: 'SQL Server (BACKUP DATABASE via sqlcmd)',
};

export interface BackupDestination {
  type: 'local' | 's3';
  /** local: folder; defaults to the data folder's backups/. */
  path?: string;
  /** s3: any S3-compatible endpoint (AWS, R2, Spaces, MinIO, Azure via gateway). */
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  accessKeyId?: string;
  /** Write-only. */
  secretAccessKey?: string;
  hasSecret?: boolean;
}

export interface BackupRetention {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

export interface BackupJob {
  id: string;
  name: string;
  engine: BackupEngine;
  /** postgres://..., mysql://..., mongodb://..., a file path for SQLite, or a sqlcmd connection. Write-only. */
  connection?: string;
  /** Host and database only, with the credential masked. */
  connectionHint: string;
  /** Five-field cron expression, in UTC. */
  schedule: string;
  retention: BackupRetention;
  destination: BackupDestination;
  enabled: boolean;
  teamId: string | null;
  /** The heartbeat monitor that pages when this job stops succeeding. */
  heartbeatMonitorId: string | null;
  lastRunAt: string | null;
  lastStatus: 'succeeded' | 'failed' | 'running' | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackupRun {
  id: string;
  jobId: string;
  status: 'running' | 'succeeded' | 'failed' | 'pruned';
  trigger: 'schedule' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  location: string | null;
  error: string | null;
}

export interface DatabaseHealth {
  ok: boolean;
  latencyMs: number | null;
  message: string;
  details: Record<string, string | number | null>;
}
