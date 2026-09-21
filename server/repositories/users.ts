import { db, fromBool, toBool } from '../db/index.ts';
import { hashPassword, randomId } from '../lib/crypto.ts';
import { resolvePermissions } from '../permissions.ts';
import type { Permission, PublicUser, UserRole, UserStatus } from '../../shared/types.ts';

export interface UserRow {
  id: string;
  email: string;
  username: string;
  name: string;
  password_hash: string;
  password_salt: string;
  role: UserRole;
  status: UserStatus;
  job_title: string | null;
  phone: string | null;
  avatar_color: string;
  must_change_password: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Muted, readable avatar colours. Deliberately not a rainbow. */
const AVATAR_COLORS = ['#9a7b2f', '#4d6b8a', '#6b7f5c', '#8a5c4d', '#6b5c8a', '#4d7f7a', '#8a6b4d', '#5c6b7f'];

export function pickAvatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** SQLite and Postgres spell case-insensitive ordering differently. */
function nameOrder(): string {
  return db.dialect === 'postgres' ? 'LOWER(name)' : 'name COLLATE NOCASE';
}

async function loadRelations() {
  const teams = new Map<string, string[]>();
  const perms = new Map<string, Permission[]>();

  const teamRows = await db.all<{ user_id: string; team_id: string }>(
    `SELECT tm.user_id, tm.team_id FROM team_members tm JOIN teams t ON t.id = tm.team_id ORDER BY t.name`,
  );
  for (const row of teamRows) {
    if (!teams.has(row.user_id)) teams.set(row.user_id, []);
    teams.get(row.user_id)!.push(row.team_id);
  }

  const permRows = await db.all<{ user_id: string; permission: string }>(
    `SELECT user_id, permission FROM user_permissions`,
  );
  for (const row of permRows) {
    if (!perms.has(row.user_id)) perms.set(row.user_id, []);
    perms.get(row.user_id)!.push(row.permission as Permission);
  }

  return { teams, perms };
}

export function mapUser(row: UserRow, teamIds: string[], extraPermissions: Permission[]): PublicUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    name: row.name,
    role: row.role,
    status: row.status,
    jobTitle: row.job_title,
    phone: row.phone,
    avatarColor: row.avatar_color,
    mustChangePassword: toBool(row.must_change_password),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    teamIds,
    extraPermissions,
    permissions: resolvePermissions(row.role, extraPermissions),
  };
}

export async function listUsers(options: { activeOnly?: boolean } = {}): Promise<PublicUser[]> {
  const rows = await db.all<UserRow>(
    `SELECT * FROM users ${options.activeOnly ? `WHERE status = 'active'` : ''} ORDER BY ${nameOrder()}`,
  );
  const { teams, perms } = await loadRelations();
  return rows.map((row) => mapUser(row, teams.get(row.id) ?? [], perms.get(row.id) ?? []));
}

export async function findUserById(id: string): Promise<PublicUser | null> {
  const row = await db.get<UserRow>(`SELECT * FROM users WHERE id = ?`, [id]);
  if (!row) return null;
  const { teams, perms } = await loadRelations();
  return mapUser(row, teams.get(id) ?? [], perms.get(id) ?? []);
}

export function findUserRowById(id: string) {
  return db.get<UserRow>(`SELECT * FROM users WHERE id = ?`, [id]);
}

/** Accepts either the username or the email address, both case-insensitively. */
export function findUserRowByLogin(login: string) {
  const needle = login.trim().toLowerCase();
  return db.get<UserRow>(`SELECT * FROM users WHERE LOWER(username) = ? OR LOWER(email) = ?`, [needle, needle]);
}

export async function countUsers(): Promise<number> {
  const row = await db.get<{ count: number | string }>(`SELECT COUNT(*) AS count FROM users`);
  return Number(row?.count ?? 0);
}

export interface CreateUserInput {
  email: string;
  username: string;
  name: string;
  password: string;
  role: UserRole;
  jobTitle?: string | null;
  phone?: string | null;
  teamIds?: string[];
  extraPermissions?: Permission[];
  mustChangePassword?: boolean;
  status?: UserStatus;
}

export async function createUser(input: CreateUserInput): Promise<string> {
  const id = randomId();
  const now = new Date().toISOString();
  const { hash, salt } = hashPassword(input.password);

  await db.run(
    `INSERT INTO users (id, email, username, name, password_hash, password_salt, role, status,
       job_title, phone, avatar_color, must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.email.toLowerCase(),
      input.username,
      input.name,
      hash,
      salt,
      input.role,
      input.status ?? 'active',
      input.jobTitle ?? null,
      input.phone ?? null,
      pickAvatarColor(input.email),
      fromBool(input.mustChangePassword ?? true),
      now,
      now,
    ],
  );

  await setUserTeams(id, input.teamIds ?? []);
  await setUserPermissions(id, input.extraPermissions ?? []);
  return id;
}

export async function setUserTeams(userId: string, teamIds: string[]): Promise<void> {
  await db.run(`DELETE FROM team_members WHERE user_id = ?`, [userId]);
  for (const teamId of Array.from(new Set(teamIds))) {
    await db.run(
      `INSERT INTO team_members (team_id, user_id, is_lead) VALUES (?, ?, 0)
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [teamId, userId],
    );
  }
}

export async function setUserPermissions(userId: string, permissions: Permission[]): Promise<void> {
  await db.run(`DELETE FROM user_permissions WHERE user_id = ?`, [userId]);
  for (const permission of Array.from(new Set(permissions))) {
    await db.run(
      `INSERT INTO user_permissions (user_id, permission) VALUES (?, ?)
       ON CONFLICT (user_id, permission) DO NOTHING`,
      [userId, permission],
    );
  }
}

export async function updatePassword(userId: string, password: string, mustChange: boolean): Promise<void> {
  const { hash, salt } = hashPassword(password);
  await db.run(
    `UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = ?, updated_at = ? WHERE id = ?`,
    [hash, salt, fromBool(mustChange), new Date().toISOString(), userId],
  );
}

export async function emailInUse(email: string, excludeId?: string): Promise<boolean> {
  const row = await db.get<{ id: string }>(
    `SELECT id FROM users WHERE LOWER(email) = ?${excludeId ? ' AND id <> ?' : ''}`,
    excludeId ? [email.toLowerCase(), excludeId] : [email.toLowerCase()],
  );
  return Boolean(row);
}

export async function usernameInUse(username: string, excludeId?: string): Promise<boolean> {
  const row = await db.get<{ id: string }>(
    `SELECT id FROM users WHERE LOWER(username) = ?${excludeId ? ' AND id <> ?' : ''}`,
    excludeId ? [username.toLowerCase(), excludeId] : [username.toLowerCase()],
  );
  return Boolean(row);
}

/** Guards against removing or demoting the last account that can administer the system. */
export async function countActiveAdmins(excludeId?: string): Promise<number> {
  const row = await db.get<{ count: number | string }>(
    `SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'${excludeId ? ' AND id <> ?' : ''}`,
    excludeId ? [excludeId] : [],
  );
  return Number(row?.count ?? 0);
}
