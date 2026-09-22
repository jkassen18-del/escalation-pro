/**
 * Builds the Teams app package from the command line.
 *
 * The running app offers the same download under Integrations, already
 * filled in from its own configuration. This is for the case where there is
 * no running app yet - a developer setting Teams up before the deployment
 * exists, or a CI job that produces the package as a build artefact.
 *
 *   npx tsx scripts/build-teams-app.ts \
 *     --app-id 00000000-0000-0000-0000-000000000000 \
 *     --url https://tickets.example.internal \
 *     [--name InfraBot] [--org "Gold Media Lab"] \
 *     [--departments finance,hr,it] [--out infrabot-teams.zip]
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildTeamsAppPackage, ManifestError } from '../server/integrations/teams-manifest.ts';
import type { Team } from '../shared/types.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const appId = arg('app-id');
const appUrl = arg('url');

if (!appId || !appUrl) {
  console.error(
    'Usage: npx tsx scripts/build-teams-app.ts --app-id <guid> --url <https://host> ' +
      '[--name InfraBot] [--org "Your Company"] [--departments finance,hr,it] [--out file.zip]',
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
  const { filename, zip } = buildTeamsAppPackage({
    appId,
    appUrl,
    botName: arg('name') ?? 'InfraBot',
    organizationName: arg('org') ?? 'Service Desk',
    teams: departments,
  });

  const out = path.resolve(arg('out') ?? filename);
  fs.writeFileSync(out, zip);
  console.log(`Wrote ${out} (${zip.length} bytes)`);
  console.log('Upload it in Teams: Apps → Manage your apps → Upload an app → Upload a custom app.');
} catch (error) {
  console.error(error instanceof ManifestError ? error.message : error);
  process.exit(1);
}
