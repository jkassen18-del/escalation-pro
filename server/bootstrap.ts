import { config } from './config.ts';
import { countUsers, createUser, emailInUse, findUserById } from './repositories/users.ts';
import { listTeams, createTeam } from './repositories/teams.ts';
import { getSettings, updateSettings } from './repositories/settings.ts';
import { ALL_PERMISSIONS } from './permissions.ts';
import { conflict } from './lib/http.ts';
import type { PublicUser } from '../shared/types.ts';

/** Sensible starting queues so a fresh install is usable immediately. */
const STARTER_TEAMS = [
  {
    key: 'SUP',
    name: 'Support',
    description: 'First-line customer and internal support requests.',
    color: '#4d6b8a',
    slaResponseMins: 120,
    slaResolveMins: 1440,
  },
  {
    key: 'OPS',
    name: 'Operations',
    description: 'Service disruptions, incidents, and operational escalations.',
    color: '#b54708',
    slaResponseMins: 30,
    slaResolveMins: 480,
  },
  {
    key: 'ENG',
    name: 'Engineering',
    description: 'Defects and technical escalations requiring engineering work.',
    color: '#6b5c8a',
    slaResponseMins: 240,
    slaResolveMins: 4320,
  },
];

export async function bootstrapFirstAdmin(input: {
  name: string;
  email: string;
  password: string;
  organizationName: string;
}): Promise<PublicUser> {
  if ((await countUsers()) > 0) throw conflict('This system already has users.');

  const teams = await listTeams();
  const teamIds = teams.length
    ? teams.map((team) => team.id)
    : await Promise.all(STARTER_TEAMS.map((team) => createTeam(team)));

  const username = input.email.split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '') || 'admin';

  const id = await createUser({
    email: input.email,
    username,
    name: input.name,
    password: input.password,
    role: 'admin',
    teamIds,
    extraPermissions: [...ALL_PERMISSIONS],
    mustChangePassword: false,
  });

  const settings = await getSettings();
  await updateSettings({
    organizationName: input.organizationName,
    supportEmail: settings.supportEmail || input.email,
    defaultTeamId: teamIds[0] ?? null,
  });

  const user = await findUserById(id);
  if (!user) throw new Error('Failed to create the administrator account.');
  return user;
}

/**
 * Creates the first admin from environment variables, for container and CI
 * deployments where nobody can complete the setup screen by hand.
 */
export async function bootstrapFromEnvironment(): Promise<void> {
  const { email, password, name } = config.bootstrapAdmin;
  if (!email || !password) return;
  if ((await countUsers()) > 0) return;

  if (await emailInUse(email)) return;
  if (password.length < 10) {
    console.warn('[bootstrap] BOOTSTRAP_ADMIN_PASSWORD must be at least 10 characters. Skipping.');
    return;
  }

  await bootstrapFirstAdmin({
    name,
    email,
    password,
    organizationName: process.env.ORGANIZATION_NAME || 'Service Desk',
  });
  console.log(`[bootstrap] created initial administrator ${email}`);
}
