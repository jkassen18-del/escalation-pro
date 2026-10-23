/**
 * Domain types shared by the Express API and the React client.
 * Keeping one copy avoids the client and server drifting apart.
 */

export const TICKET_STATUSES = ['open', 'in_progress', 'pending', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_TYPES = ['incident', 'request', 'question', 'problem', 'escalation'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export const TICKET_SOURCES = ['web', 'email', 'slack', 'msteams', 'api', 'phone', 'linear', 'monitor', 'webhook', 'discord', 'claude'] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

export const USER_ROLES = ['admin', 'manager', 'agent', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const AUTO_ASSIGN_MODES = ['none', 'round_robin', 'least_busy'] as const;
export type AutoAssignMode = (typeof AUTO_ASSIGN_MODES)[number];

export const INTEGRATION_PROVIDERS = ['slack', 'msteams', 'linear', 'email', 'discord'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

/** Statuses that stop the SLA clock. */
export const TERMINAL_STATUSES: readonly TicketStatus[] = ['resolved', 'closed'];

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  name: string;
  /** The legacy tier of the person's role: admin only for the Administrator role. */
  role: UserRole;
  roleId: string | null;
  roleName: string;
  status: UserStatus;
  jobTitle: string | null;
  phone: string | null;
  avatarColor: string;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  teamIds: string[];
  /** The departments, among teamIds, this person is a manager of (the rest they are a member of). */
  managedTeamIds: string[];
  /** The role's permissions plus per-user grants, already merged. */
  permissions: Permission[];
  /** Grants stored explicitly against this user, on top of their role. */
  extraPermissions: Permission[];
}

/** Where a department's tickets are announced, overriding the defaults. */
export interface TeamRoute {
  provider: IntegrationProvider;
  /** Slack channel id, Teams webhook URL, or Linear team id. */
  target: string;
  /** Slack only: who to ping, in Slack's mention syntax. */
  mention: string | null;
}

export interface Team {
  id: string;
  key: string;
  name: string;
  description: string | null;
  color: string;
  autoAssign: AutoAssignMode;
  defaultPriority: TicketPriority;
  /** Minutes allowed before the first agent response breaches SLA. */
  slaResponseMins: number;
  /** Minutes allowed before resolution breaches SLA. */
  slaResolveMins: number;
  memberIds: string[];
  /** The members who manage this department. */
  managerIds: string[];
  createdAt: string;
  updatedAt: string;
  /** Present on list endpoints. */
  openTicketCount?: number;
}

/** A selectable label for a department's tickets; teamId null means every department. */
export interface TicketLabel {
  id: string;
  teamId: string | null;
  teamName: string | null;
  name: string;
  color: string;
  description: string | null;
  position: number;
}

/** Someone on call for a ticket's department, and how to reach them. */
export interface OnCallContact {
  scheduleId: string;
  scheduleName: string;
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  jobTitle: string | null;
  until: string | null;
}

/** One day on the activity heatmap. */
export interface ActivityDay {
  date: string;
  created: number;
  resolved: number;
}

export interface TicketComment {
  id: string;
  ticketId: string;
  authorId: string | null;
  authorName: string;
  body: string;
  bodyFormat: RichTextFormat;
  /** Internal notes are hidden from users without the internal-notes permission. */
  isInternal: boolean;
  createdAt: string;
  updatedAt: string;
  attachments: TicketAttachment[];
}

export interface TicketAttachment {
  id: string;
  ticketId: string;
  commentId: string | null;
  originalName: string;
  mimeType: string;
  size: number;
  uploadedById: string | null;
  uploadedByName: string;
  createdAt: string;
  url: string;
}

export interface TicketEvent {
  id: string;
  ticketId: string;
  actorId: string | null;
  actorName: string;
  action: string;
  field: string | null;
  fromValue: string | null;
  toValue: string | null;
  createdAt: string;
}

export interface TicketLink {
  id: string;
  provider: IntegrationProvider;
  externalId: string;
  externalKey: string | null;
  url: string;
  createdAt: string;
}

export interface Ticket {
  id: string;
  number: number;
  reference: string;
  subject: string;
  description: string;
  descriptionFormat: RichTextFormat;
  teamId: string | null;
  teamName: string | null;
  requesterId: string | null;
  requesterName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  type: TicketType;
  source: TicketSource;
  tags: string[];
  escalationLevel: number;
  dueAt: string | null;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdById: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  attachmentCount: number;
  watcherIds: string[];
  links: TicketLink[];
  /** Derived, not stored: true when past dueAt and not yet resolved. */
  isOverdue: boolean;
  /** Incidents only: SEV1 (critical) to SEV4. */
  severity: 'sev1' | 'sev2' | 'sev3' | 'sev4' | null;
  commanderId: string | null;
  commanderName: string | null;
  /** The quick-ticket template it was raised from, if any. */
  templateId: string | null;
  templateName: string | null;
}

export interface TicketDetail extends Ticket {
  comments: TicketComment[];
  events: TicketEvent[];
  attachments: TicketAttachment[];
  /** Answers to the department's intake form, as they were asked. */
  fieldValues: TicketFieldValue[];
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  actorName: string;
  entityType: string;
  entityId: string | null;
  action: string;
  summary: string;
  meta: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export interface Notification {
  id: string;
  userId: string;
  ticketId: string | null;
  ticketReference: string | null;
  type: string;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * How a stored body should be rendered. Values written before rich text
 * existed are plain text, and stay that way.
 */
export const DATA_SOURCE_ENGINES = ['postgres', 'mysql'] as const;
export type DataSourceEngine = (typeof DATA_SOURCE_ENGINES)[number];

/** A connection to a database the company already runs. Read-only. */
export interface DataSourceSummary {
  id: string;
  name: string;
  engine: DataSourceEngine;
  host: string;
  port: number;
  database: string;
  username: string;
  /** Whether a password is stored; the value itself is never sent out. */
  hasPassword: boolean;
  useTls: boolean;
  lookupQuery: string;
  valueColumn: string;
  labelColumn: string;
  status: 'unknown' | 'ok' | 'error';
  statusMessage: string | null;
  lastTestedAt: string | null;
}

/** The question types a department can put on its intake form. */
export const FORM_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'date',
  'select',
  'multiselect',
  'checkbox',
  'email',
  'url',
  'lookup',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface TeamFormField {
  id: string;
  teamId: string;
  /** Stable machine name; answers are keyed by it and it survives renames. */
  key: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  helpText: string | null;
  placeholder: string | null;
  /** Choices for select and multiselect. */
  options: string[];
  position: number;
  /** Set only for lookup fields: the external connection supplying options. */
  dataSourceId: string | null;
}

/** An answer, carrying a copy of the question as it was asked. */
export interface TicketFieldValue {
  fieldId: string | null;
  key: string;
  label: string;
  type: FormFieldType;
  value: string | number | boolean | string[] | null;
  position: number;
}

export type RichTextFormat = 'text' | 'html';

export interface AppSettings {
  organizationName: string;
  supportEmail: string;
  /** Public base URL, used to build links inside outbound notifications. */
  appUrl: string;
  defaultTeamId: string | null;
  defaultPriority: TicketPriority;
  slaResponseMins: number;
  slaResolveMins: number;
  ticketPrefix: string;
  /** Business hours are informational today; SLA math uses elapsed wall-clock time. */
  timezone: string;
}

export interface IntegrationSummary {
  provider: IntegrationProvider;
  enabled: boolean;
  configured: boolean;
  status: 'unconfigured' | 'ok' | 'error' | 'untested';
  lastCheckedAt: string | null;
  lastError: string | null;
  /** Secrets are redacted; only non-sensitive fields are returned. */
  config: Record<string, unknown>;
  events: IntegrationEventToggles;
}

export interface IntegrationEventToggles {
  ticketCreated: boolean;
  ticketAssigned: boolean;
  ticketStatusChanged: boolean;
  ticketEscalated: boolean;
  ticketCommented: boolean;
  slaBreached: boolean;
}

export const HTTP_METHODS = ['POST', 'PUT', 'PATCH'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** A custom outbound HTTP integration. Header values and the secret are never sent out. */
export interface HttpIntegration {
  id: string;
  name: string;
  url: string;
  method: HttpMethod;
  /** Names with a masked preview of each value. */
  headers: Array<{ name: string; preview: string }>;
  bodyTemplate: string | null;
  hasSigningSecret: boolean;
  allowPrivate: boolean;
  events: IntegrationEventToggles;
  /** Empty means every team. */
  teamIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HttpIntegrationInput {
  name: string;
  url: string;
  method: HttpMethod;
  /** An empty value keeps the stored value for that header name. */
  headers: Array<{ name: string; value: string }>;
  bodyTemplate: string | null;
  /** Undefined or '' keeps the stored secret; null removes it. */
  signingSecret?: string | null;
  allowPrivate: boolean;
  events: Partial<IntegrationEventToggles>;
  teamIds: string[];
  enabled: boolean;
}

/** One Linear team and the department its issues belong to. */
export interface LinearTeamMapping {
  linearTeamId: string;
  linearTeamKey: string | null;
  linearTeamName: string | null;
  teamId: string;
  isPrimary: boolean;
}

/** One tile on the Integrations catalogue. */
export interface CatalogueStatus {
  state: 'connected' | 'attention' | 'not_set_up';
  detail: string | null;
}

export interface IntegrationDelivery {
  id: string;
  /** An IntegrationProvider, or `http:<id>` for a custom HTTP integration. */
  provider: IntegrationProvider | `http:${string}`;
  event: string;
  ticketId: string | null;
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  createdAt: string;
}

export interface ReportSummary {
  totals: {
    open: number;
    inProgress: number;
    pending: number;
    resolved: number;
    closed: number;
    overdue: number;
    unassigned: number;
  };
  byPriority: Array<{ priority: TicketPriority; count: number }>;
  byTeam: Array<{ teamId: string; teamName: string; count: number; overdue: number }>;
  byAssignee: Array<{ assigneeId: string | null; assigneeName: string; open: number; resolved: number }>;
  volumeByDay: Array<{ date: string; created: number; resolved: number }>;
  /** Averages in minutes; null when there is not enough data. */
  avgFirstResponseMins: number | null;
  avgResolutionMins: number | null;
  slaCompliancePct: number | null;
}

/** Every permission, in the order the role editor shows them. */
export const PERMISSIONS = [
  'tickets.view_all',
  'tickets.create',
  'tickets.update',
  'tickets.change_status',
  'tickets.close',
  'tickets.reopen',
  'tickets.change_priority',
  'tickets.assign',
  'tickets.escalate',
  'tickets.page',
  'tickets.push_linear',
  'tickets.reply',
  'tickets.comment_internal',
  'tickets.attach',
  'tickets.delete_attachment',
  'tickets.delete',
  'templates.manage',
  'users.view',
  'users.create',
  'users.update',
  'users.assign_roles',
  'users.invite',
  'users.delete',
  'users.reset_password',
  'roles.manage',
  'teams.manage',
  'teams.forms',
  'teams.links',
  'settings.manage',
  'branding.manage',
  'sso.manage',
  'integrations.manage',
  'connector.manage',
  'connector.use',
  'reports.view',
  'reports.export',
  'audit.view',
  'ops.view',
  'monitors.manage',
  'alerts.routing',
  'maintenance.manage',
  'oncall.manage',
  'oncall.manage_own_department',
  'oncall.cover',
  'pages.respond',
  'statuspages.manage',
  'statuspages.post',
  'databases.manage',
  'backups.manage',
  'backups.restore',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Which permission moving a ticket from one status to another takes. */
export function statusPermission(from: string, to: string): Permission {
  const terminal = (status: string) => status === 'resolved' || status === 'closed';
  if (terminal(to)) return 'tickets.close';
  if (terminal(from)) return 'tickets.reopen';
  return 'tickets.change_status';
}

/** A named set of permissions people are given. The four built-ins carry a `systemKey`. */
export interface Role {
  id: string;
  name: string;
  description: string | null;
  permissions: Permission[];
  /** admin, manager, agent or viewer for the built-ins; null for roles people created. */
  systemKey: UserRole | null;
  /** The legacy tier the role behaves as in older code paths. */
  tier: UserRole;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApiError {
  error: string;
  details?: Record<string, string>;
}

/** A department membership: plain member, or one of the department's managers. */
export const DEPARTMENT_ROLES = ['member', 'manager'] as const;
export type DepartmentRole = (typeof DEPARTMENT_ROLES)[number];

export type InviteStatus = 'active' | 'expired' | 'used_up' | 'revoked';

/** An invite link as admins see it. The token itself is only returned once, on creation. */
export interface Invite {
  id: string;
  label: string | null;
  roleId: string;
  roleName: string;
  /** A single person the invite is for; anyone with the link otherwise. */
  email: string | null;
  /** Company email domains accepted, e.g. ["goldmedialab.com"]; empty accepts any. */
  allowedDomains: string[];
  /** Departments the person may pick from; empty means every department. */
  teamIds: string[];
  /** Null for unlimited. */
  maxUses: number | null;
  uses: number;
  expiresAt: string;
  revokedAt: string | null;
  createdById: string | null;
  createdByName: string | null;
  createdAt: string;
  status: InviteStatus;
}

/** What the public invite page shows before anyone signs up. */
export interface InvitePreview {
  organizationName: string;
  label: string | null;
  email: string | null;
  allowedDomains: string[];
  departments: Array<{ id: string; name: string }>;
  expiresAt: string;
}
