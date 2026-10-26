import { PERMISSIONS, type Permission, type UserRole } from '../shared/types.ts';

/**
 * Every permission, one per thing a person can do in the app.
 *
 * Roles are data now (the `roles` table): a role is a named set of these, and
 * a person holds their role's set plus any extras granted to them alone.
 *
 * Each permission added after the first release names the older permission it
 * was split out of (`impliedBy`). On upgrade, anyone who held the older one is
 * given the newer one too, so splitting a permission never takes access away
 * from anybody. `everyone` marks things every signed-in person could always
 * do; they start on in every built-in role and can be switched off per role.
 */
export interface PermissionInfo {
  key: Permission;
  label: string;
  hint: string;
  impliedBy?: Permission;
  everyone?: boolean;
}

export const PERMISSION_GROUPS: Array<{ label: string; permissions: PermissionInfo[] }> = [
  {
    label: 'Tickets',
    permissions: [
      { key: 'tickets.view_all', label: 'View all tickets', hint: 'See tickets outside their own departments' },
      { key: 'tickets.create', label: 'Create tickets', hint: 'Raise new tickets, including from quick-ticket templates' },
      { key: 'tickets.update', label: 'Edit ticket details', hint: 'Subject, description, type, department, severity, commander, due date and tags' },
      { key: 'tickets.change_status', label: 'Change status', hint: 'Move a ticket between open, in progress and pending', impliedBy: 'tickets.update' },
      { key: 'tickets.close', label: 'Resolve and close', hint: 'Mark a ticket resolved or closed', impliedBy: 'tickets.update' },
      { key: 'tickets.reopen', label: 'Reopen', hint: 'Bring a resolved or closed ticket back', impliedBy: 'tickets.update' },
      { key: 'tickets.change_priority', label: 'Change priority', hint: 'Raise or lower a ticket’s priority', impliedBy: 'tickets.update' },
      { key: 'tickets.assign', label: 'Assign tickets', hint: 'Choose who works a ticket' },
      { key: 'tickets.escalate', label: 'Escalate', hint: 'Escalate a ticket to another department', impliedBy: 'tickets.update' },
      { key: 'tickets.page', label: 'Page on-call about a ticket', hint: 'Start an escalation policy by hand from a ticket', impliedBy: 'tickets.update' },
      { key: 'tickets.request_approval', label: 'Request approval', hint: 'Ask named people to sign a ticket off before work starts', impliedBy: 'tickets.update' },
      { key: 'approvals.manage', label: 'Manage approval rules', hint: 'Which tickets need sign-off, and from whom', impliedBy: 'teams.manage' },
      { key: 'tickets.push_linear', label: 'Send to Linear', hint: 'Create a Linear issue from a ticket', impliedBy: 'tickets.update' },
      { key: 'tickets.reply', label: 'Reply', hint: 'Post public replies on tickets they can see', everyone: true },
      { key: 'tickets.comment_internal', label: 'Internal notes', hint: 'Read and write notes hidden from requesters' },
      { key: 'tickets.attach', label: 'Attach files', hint: 'Upload files and screenshots to tickets they can see', everyone: true },
      { key: 'tickets.delete_attachment', label: 'Delete any attachment', hint: 'Remove files other people uploaded (anyone may remove their own)', impliedBy: 'tickets.delete' },
      { key: 'tickets.delete', label: 'Delete tickets', hint: 'Permanently remove a ticket' },
      { key: 'templates.manage', label: 'Manage quick tickets', hint: 'Create and edit quick-ticket templates', impliedBy: 'teams.manage' },
    ],
  },
  {
    label: 'People and departments',
    permissions: [
      { key: 'users.view', label: 'View users', hint: 'Browse the user directory' },
      { key: 'users.create', label: 'Create users', hint: 'Provision new accounts' },
      { key: 'users.update', label: 'Edit users', hint: 'Change profile details, departments and account status' },
      { key: 'users.assign_roles', label: 'Assign roles and permissions', hint: 'Change someone’s role and extra permissions (never beyond their own)' },
      { key: 'users.invite', label: 'Invite people', hint: 'Create invite links people use to sign themselves up into a department', impliedBy: 'users.create' },
      { key: 'users.delete', label: 'Delete users', hint: 'Remove accounts' },
      { key: 'users.reset_password', label: 'Reset passwords', hint: 'Issue a new password for an account' },
      { key: 'roles.manage', label: 'Manage roles', hint: 'Create, edit and delete roles (never beyond their own permissions)' },
      { key: 'teams.manage', label: 'Manage departments', hint: 'Create departments and set their routing and SLA rules' },
      { key: 'teams.forms', label: 'Edit intake forms', hint: 'Change the questions a department asks on new tickets', impliedBy: 'teams.manage' },
      { key: 'teams.links', label: 'Manage department links', hint: 'Links to AWS, Azure, Entra ID and other systems on a department', impliedBy: 'teams.manage' },
    ],
  },
  {
    label: 'Administration',
    permissions: [
      { key: 'settings.manage', label: 'Manage settings', hint: 'Organisation profile, ticket prefix and global SLA defaults' },
      { key: 'branding.manage', label: 'Manage branding', hint: 'Logo, colours and product name', impliedBy: 'settings.manage' },
      { key: 'sso.manage', label: 'Manage single sign-on', hint: 'Microsoft Entra ID and SAML sign-in', impliedBy: 'settings.manage' },
      { key: 'integrations.manage', label: 'Manage integrations', hint: 'Slack, Microsoft Teams, Discord, Linear, email, custom HTTP and database lookups' },
      { key: 'connector.manage', label: 'Manage the AI connector', hint: 'Turn the Claude/Copilot connector on and register clients', impliedBy: 'settings.manage' },
      { key: 'connector.use', label: 'Use the AI connector', hint: 'Create personal access tokens and connect an AI assistant', everyone: true },
      { key: 'reports.view', label: 'View reports', hint: 'Open the analytics dashboard' },
      { key: 'reports.export', label: 'Export reports', hint: 'Download ticket data as XLSX or CSV' },
      { key: 'audit.view', label: 'View audit log', hint: 'Inspect the full system activity trail' },
    ],
  },
  {
    label: 'Operations',
    permissions: [
      { key: 'ops.view', label: 'View operations', hint: 'Monitors, alerts, maintenance, on-call schedules and status pages', everyone: true },
      { key: 'monitors.manage', label: 'Manage monitoring', hint: 'Create monitors and alert sources' },
      { key: 'alerts.routing', label: 'Manage alert routing', hint: 'Rules that send alerts to departments and policies', impliedBy: 'monitors.manage' },
      { key: 'maintenance.manage', label: 'Manage maintenance', hint: 'Schedule, extend and end maintenance windows', impliedBy: 'monitors.manage' },
      { key: 'oncall.manage', label: 'Manage all on-call', hint: 'Every department’s schedules and overrides, escalation policies and telephony' },
      { key: 'oncall.manage_own_department', label: 'Manage own department’s on-call', hint: 'Schedules, rosters and overrides for the departments they belong to' },
      { key: 'oncall.cover', label: 'Cover shifts', hint: 'Add or remove themselves as cover on a schedule', everyone: true },
      { key: 'pages.respond', label: 'Respond to pages', hint: 'Acknowledge or escalate pages that reached them', everyone: true },
      { key: 'statuspages.manage', label: 'Manage status pages', hint: 'Create, edit and delete status pages' },
      { key: 'statuspages.post', label: 'Post status updates', hint: 'Post incident updates to status pages', impliedBy: 'statuspages.manage' },
      { key: 'databases.manage', label: 'Manage database connectors', hint: 'Add, edit and remove databases, health checks and backup schedules', impliedBy: 'backups.manage' },
      { key: 'backups.manage', label: 'Run backups', hint: 'Start a database backup now' },
      { key: 'backups.restore', label: 'Download backups', hint: 'Download decrypted backups for a restore' },
    ],
  },
];

export const ALL_PERMISSIONS: Permission[] = [...PERMISSIONS];

const INFO = new Map(PERMISSION_GROUPS.flatMap((group) => group.permissions).map((info) => [info.key, info]));

export function permissionInfo(key: Permission): PermissionInfo | undefined {
  return INFO.get(key);
}

/**
 * What each built-in role held before roles became editable. Kept verbatim:
 * the built-in defaults and the upgrade path are both derived from it.
 */
const LEGACY_ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [],
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
    'monitors.manage',
    'oncall.manage',
    'statuspages.manage',
  ],
  agent: ['tickets.create', 'tickets.update', 'tickets.assign', 'tickets.comment_internal', 'users.view', 'reports.view'],
  viewer: ['users.view'],
};

/** Adds every newer permission that was split out of one in `held`. */
export function expandImplied(held: Iterable<Permission>): Permission[] {
  const set = new Set(held);
  for (const info of INFO.values()) {
    if (info.impliedBy && set.has(info.impliedBy)) set.add(info.key);
  }
  return ALL_PERMISSIONS.filter((key) => set.has(key));
}

/**
 * How the built-in Manager differs from what managers held before roles were
 * editable: they assign roles (as they always could, through the role field),
 * and on-call is limited to their own departments. Escalation policies and
 * telephony, which span departments, stay with oncall.manage.
 */
const MANAGER_ADDS: Permission[] = ['users.assign_roles', 'oncall.manage_own_department'];
const MANAGER_DROPS: Permission[] = ['oncall.manage'];

/**
 * The permissions a built-in role starts with. Administrator always holds
 * everything, including permissions added in later versions.
 */
export function permissionsForRole(role: UserRole): Permission[] {
  if (role === 'admin') return [...ALL_PERMISSIONS];
  const base = LEGACY_ROLE_PERMISSIONS[role] ?? LEGACY_ROLE_PERMISSIONS.viewer;
  const everyone = [...INFO.values()].filter((info) => info.everyone).map((info) => info.key);
  const granted = expandImplied([...base, ...everyone, ...(role === 'manager' ? MANAGER_ADDS : [])]);
  return role === 'manager' ? granted.filter((key) => !MANAGER_DROPS.includes(key)) : granted;
}

/**
 * Grants only an administrator may hand out, in a role or as an extra:
 * everything the built-in Manager role does not start with. Keeps a manager
 * from minting a de-facto administrator.
 */
export const ADMIN_ONLY_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter(
  (permission) => !permissionsForRole('manager').includes(permission),
);

/**
 * The grants in `requested` that `actor` may not hand out: ones the actor does
 * not hold, and, for anyone but an administrator, the admin-only ones.
 */
export function ungrantablePermissions(
  actor: { role: UserRole; permissions: Permission[] },
  requested: Permission[],
): Permission[] {
  return requested.filter(
    (permission) =>
      !actor.permissions.includes(permission) || (actor.role !== 'admin' && ADMIN_ONLY_PERMISSIONS.includes(permission)),
  );
}

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Administrator',
  manager: 'Manager',
  agent: 'Agent',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  admin: 'Full access, including integrations, settings, and the audit log.',
  manager: 'Runs queues and people. Everything except integrations and system settings.',
  agent: 'Works tickets in their assigned departments.',
  viewer: 'Read-only access to tickets in their assigned departments.',
};

/**
 * The legacy tier a custom role behaves as where older code asks for one (who
 * can be assigned tickets, who counts as staff). Derived from what the role
 * can do, so there is nothing extra to keep in step.
 */
export function tierForPermissions(permissions: Permission[]): Exclude<UserRole, 'admin'> {
  const has = (key: Permission) => permissions.includes(key);
  if (has('users.update') || has('teams.manage') || has('users.assign_roles')) return 'manager';
  if (has('tickets.update') || has('tickets.change_status') || has('tickets.close') || has('tickets.assign')) return 'agent';
  return 'viewer';
}

/** A role's permissions plus a person's extras, deduplicated and in catalogue order. */
export function resolvePermissions(rolePermissions: Permission[], extra: string[] = []): Permission[] {
  const set = new Set<string>([...rolePermissions, ...extra.filter(isPermission)]);
  return ALL_PERMISSIONS.filter((key) => set.has(key));
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (ALL_PERMISSIONS as string[]).includes(value);
}

export { statusPermission } from '../shared/types.ts';

/** Any one of these lets a person open the ticket edit route at all. */
export const TICKET_EDIT_PERMISSIONS: Permission[] = [
  'tickets.update',
  'tickets.change_status',
  'tickets.close',
  'tickets.reopen',
  'tickets.change_priority',
  'tickets.assign',
];
