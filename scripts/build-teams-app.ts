/**
 * Builds the Teams app package from the command line.
 *
 * The running app offers the same download under Integrations, already
 * filled in from its own configuration.
 *
 * With --from-db it builds exactly that package - name, icon, commands,
 * version - from the database the server uses (the same DATABASE_URL /
 * DATA_DIR environment), and records it as downloaded, so it is the same
 * bytes as the button:
 *
 *   npm run build:teams-app -- --from-db [--out infrabot-teams.zip]
 *
 * Without it, for when there is no running app yet - a developer setting
 * Teams up before the deployment exists, or a CI job:
 *
 *   npx tsx scripts/build-teams-app.ts \
 *     --app-id 00000000-0000-0000-0000-000000000000 \
 *     --url https://tickets.example.internal \
 *     [--name InfraBot] [--org "Gold Media Lab"] [--version 1.1.0] \
 *     [--departments finance,hr,it] [--out infrabot-teams.zip]
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildTeamsAppPackage, ManifestError, validateTeamsPackage, type ManifestOptions } from '../server/integrations/teams-manifest.ts';
import type { Team } from '../shared/types.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv.includes('--from-db')) {
  const { initDatabase, db } = await import('../server/db/index.ts');
  await initDatabase();
  const { packageForDownload } = await import('../server/integrations/teams-app.ts');
  try {
    const { options, record } = await packageForDownload();
    write(options);
    await record();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
  await db.close();
  process.exit();
}

function write(options: ManifestOptions) {
  for (const problem of validateTeamsPackage(options)) console.warn(`warning: ${problem}`);
  const { filename, zip } = buildTeamsAppPackage(options);
  const out = path.resolve(arg('out') ?? filename);
  fs.writeFileSync(out, zip);
  console.log(`Wrote ${out} (${zip.length} bytes), version ${options.version ?? '1.0.0'}`);
  console.log('First install: Teams → Apps → Manage your apps → Upload an app → Upload a custom app.');
  console.log('Update: Teams admin center → Teams apps → Manage apps → the app → Upload file (the version must be higher).');
}

const appId = arg('app-id');
const appUrl = arg('url');

if (!appId || !appUrl) {
  console.error(
    'Usage: npx tsx scripts/build-teams-app.ts --app-id <guid> --url <https://host> ' +
      '[--name InfraBot] [--org "Your Company"] [--version 1.1.0] [--departments finance,hr,it] [--out file.zip]\n' +
      '   or: npm run build:teams-app -- --from-db [--out file.zip]',
  );
  process.exit(2);
}

/*
 * Only the key and a title-cased name are needed here: the command list is
 * the menu Teams shows, and the bot answers any department whether or not it
 * is listed. The running app fills these in from the database instead.
 */
const departments: Team[] = (arg('departments') ?? '')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean)
  .map(
    (key) =>
      ({
        id: key,
        key: key.toUpperCase(),
        name: key.charAt(0).toUpperCase() + key.slice(1),
      }) as Team,
  );

try {
  write({
    appId,
    appUrl,
    botName: arg('name') ?? 'InfraBot',
    organizationName: arg('org') ?? 'Service Desk',
    version: arg('version') ?? '1.1.0',
    teams: departments,
  });
} catch (error) {
  console.error(error instanceof ManifestError ? error.message : error);
  process.exit(1);
}
