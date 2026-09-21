import type { Permission, UserRole } from '../shared/types.ts';

export const ALL_PERMISSIONS: Permission[] = [
  'tickets.view_all',
  'tickets.create',
  'tickets.update',
  'tickets.assign',
  'tickets.delete',
  'tickets.comment_internal',
  'users.view',
  'users.create',
  'users.update',
  'users.delete',
  'users.reset_password',
  'teams.manage',
  'settings.manage',
  'integrations.manage',
  'reports.view',
  'reports.export',
  'audit.view',
];

export const PERMISSION_GROUPS: Array<{ label: string; permissions: Array<{ key: Permission; label: string; hint: string }> }> = [
  {
    label: 'Tickets',
    permissions: [
      { key: 'tickets.view_all', label: 'View all tickets', hint: 'See tickets outside their own teams' },
      { key: 'tickets.create', label: 'Create tickets', hint: 'Raise new tickets and escalations' },
      { key: 'tickets.update', label: 'Update tickets', hint: 'Change status, priority, and fields' },
      { key: 'tickets.assign', label: 'Assign tickets', hint: 'Route tickets to a team or agent' },
      { key: 'tickets.delete', label: 'Delete tickets', hint: 'Permanently remove a ticket' },
      { key: 'tickets.comment_internal', label: 'Internal notes', hint: 'Read and write notes hidden from requesters' },
    ],
  },
  {
    label: 'People',
    permissions: [
      { key: 'users.view', label: 'View users', hint: 'Browse the user directory' },
      { key: 'users.create', label: 'Create users', hint: 'Provision new accounts' },
      { key: 'users.update', label: 'Edit users', hint: 'Change profile, role, and team membership' },
      { key: 'users.delete', label: 'Deactivate users', hint: 'Suspend or remove accounts' },
      { key: 'users.reset_password', label: 'Reset passwords', hint: 'Issue a new password for an account' },
      { key: 'teams.manage', label: 'Manage teams', hint: 'Create teams and set routing and SLA rules' },
    ],
  },
  {
    label: 'Administration',
    permissions: [
      { key: 'settings.manage', label: 'Manage settings', hint: 'Organisation profile and global SLA defaults' },
      { key: 'integrations.manage', label: 'Manage integrations', hint: 'Configure Slack, Microsoft Teams, Linear, and email' },
      { key: 'reports.view', label: 'View reports', hint: 'Open the analytics dashboard' },
      { key: 'reports.export', label: 'Export reports', hint: 'Download ticket data as XLSX or CSV' },
      { key: 'audit.view', label: 'View audit log', hint: 'Inspect the full system activity trail' },
    ],
  },
];

/**
 * Baseline grants per role. Users can be given extra permissions on top of
 * these, but never fewer - demote the role instead.
 */
const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [...ALL_PERMISSIONS],
  manager: [
    'tickets.view_all',
    'tickets.create',
    'tickets.update',
    'tickets.assign',
    'tickets.comment_internal',
    'users.view',
    'users.create',
    'users.update',
    'users.reset_password',
    'teams.manage',
    'reports.view',
    'reports.export',
    'audit.view',
  ],
  agent: ['tickets.create', 'tickets.update', 'tickets.assign', 'tickets.comment_internal', 'users.view', 'reports.view'],
  viewer: ['users.view'],
};

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Administrator',
  manager: 'Manager',
  agent: 'Agent',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  admin: 'Full access, including integrations, settings, and the audit log.',
  manager: 'Runs queues and people. Everything except integrations and system settings.',
  agent: 'Works tickets in their assigned teams.',
  viewer: 'Read-only access to tickets in their assigned teams.',
};

export function permissionsForRole(role: UserRole): Permission[] {
  return ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS.viewer;
}

export function resolvePermissions(role: UserRole, extra: string[] = []): Permission[] {
  const valid = extra.filter((item): item is Permission => (ALL_PERMISSIONS as string[]).includes(item));
  return Array.from(new Set([...permissionsForRole(role), ...valid]));
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (ALL_PERMISSIONS as string[]).includes(value);
}
