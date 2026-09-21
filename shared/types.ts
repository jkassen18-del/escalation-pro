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

export const TICKET_SOURCES = ['web', 'email', 'slack', 'msteams', 'api', 'phone'] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

export const USER_ROLES = ['admin', 'manager', 'agent', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const AUTO_ASSIGN_MODES = ['none', 'round_robin', 'least_busy'] as const;
export type AutoAssignMode = (typeof AUTO_ASSIGN_MODES)[number];

export const INTEGRATION_PROVIDERS = ['slack', 'msteams', 'linear', 'email'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

/** Statuses that stop the SLA clock. */
export const TERMINAL_STATUSES: readonly TicketStatus[] = ['resolved', 'closed'];

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  jobTitle: string | null;
  phone: string | null;
  avatarColor: string;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  teamIds: string[];
  /** Role defaults plus per-user grants, already merged. */
  permissions: Permission[];
  /** Grants stored explicitly against this user, on top of their role. */
  extraPermissions: Permission[];
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
  createdAt: string;
  updatedAt: string;
  /** Present on list endpoints. */
  openTicketCount?: number;
}

export interface TicketComment {
  id: string;
  ticketId: string;
  authorId: string | null;
  authorName: string;
  body: string;
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
}

export interface TicketDetail extends Ticket {
  comments: TicketComment[];
  events: TicketEvent[];
  attachments: TicketAttachment[];
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

export interface IntegrationDelivery {
  id: string;
  provider: IntegrationProvider;
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

export type Permission =
  | 'tickets.view_all'
  | 'tickets.create'
  | 'tickets.update'
  | 'tickets.assign'
  | 'tickets.delete'
  | 'tickets.comment_internal'
  | 'users.view'
  | 'users.create'
  | 'users.update'
  | 'users.delete'
  | 'users.reset_password'
  | 'teams.manage'
  | 'settings.manage'
  | 'integrations.manage'
  | 'reports.view'
  | 'reports.export'
  | 'audit.view';

export interface ApiError {
  error: string;
  details?: Record<string, string>;
}
