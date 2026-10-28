/**
 * Entry point for the portable build: one InfraTicket.exe, no installer.
 *
 * Everything it writes lives in a folder beside the executable, so the whole
 * workspace can be carried on a USB stick, zipped and mailed, or deleted
 * without leaving anything behind:
 *
 *   InfraTicket.exe
 *   InfraTicket-data/
 *     infraticket.db      the workspace (SQLite)
 *     uploads/            attachments
 *     backups/            database backups taken by the backup jobs
 *     web/<version>-<build>/  the web UI, unpacked from the executable on first run
 *
 * Commands:
 *   InfraTicket.exe                 start, and open the browser
 *   InfraTicket.exe --no-browser    start without opening the browser
 *   InfraTicket.exe --port 9090     listen somewhere other than 8080
 *   InfraTicket.exe --network       let others on the network open it
 *                                   (same as HOST=0.0.0.0 in .env)
 *   InfraTicket.exe decrypt-backup <file> [out]
 *                                   decrypt a backup with BACKUP_KEY/SECRET_KEY
 *                                   or this folder's key; no server needed
 *   InfraTicket.exe export [file]   pack the workspace into a .zip to move it
 *                                   into an on-prem or cloud install
 *   InfraTicket.exe --version
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION } from '../shared/version.ts';

interface SeaModule {
  isSea(): boolean;
  getAsset(key: string): ArrayBuffer;
}

function loadSea(): SeaModule | null {
  try {
    // `node:sea` exists only inside a single-executable build.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sea = require('node:sea') as SeaModule;
    return sea.isSea() ? sea : null;
  } catch {
    return null;
  }
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * The web UI travels inside the executable as one asset per file. Express
 * serves from disk, so they are written out once per build and reused. The
 * folder name carries a hash of the UI, because rebuilt executables share a
 * version number and must not pick up an older build's files.
 */
function unpackWebAssets(sea: SeaModule, root: string): string {
  const raw = JSON.parse(Buffer.from(sea.getAsset('web-manifest.json')).toString('utf8')) as string[] | { build: string; files: string[] };
  const { build, files } = Array.isArray(raw) ? { build: 'legacy', files: raw } : raw;
  const name = `${APP_VERSION}-${build}`;
  const target = path.join(root, name);
  const marker = path.join(target, '.complete');
  if (!fs.existsSync(marker)) {
    for (const file of files) {
      const destination = path.join(target, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from(sea.getAsset(`web/${file}`)));
    }
    fs.writeFileSync(marker, name);
  }
  // Older builds' copies are dead weight; a failed delete is harmless.
  for (const entry of fs.readdirSync(root)) {
    if (entry !== name) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }
  return target;
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // No browser to open (a server core install, a container). The URL is printed anyway.
  }
}

/** Keeps the console window open on a fatal error, so a double-click user can read it. */
function pauseBeforeExit(code: number): never {
  if (process.platform === 'win32' && process.stdin.isTTY) {
    console.error('\nPress Enter to close this window.');
    try {
      const buffer = Buffer.alloc(1);
      fs.readSync(0, buffer, 0, 1, null);
    } catch {
      // stdin closed
    }
  }
  process.exit(code);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    console.log(`InfraTicket ${APP_VERSION}`);
    return;
  }

  // node:sqlite announces itself as experimental on every start; on a
  // double-clicked console window that reads like an error, and it is not one.
  const emitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(text)) return;
    return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;

  const sea = loadSea();
  const home = sea ? path.dirname(process.execPath) : process.cwd();
  // The .env beside the exe is read before any default is applied, so every
  // choice in it - who can reach the app, the port, the data folder, the
  // database - is honoured. (dotenv never overwrites a variable that is
  // already set, so reading it after the defaults would silently ignore them.)
  (await import('dotenv')).config({ path: path.join(home, '.env'), quiet: true });
  const dataDir = process.env.DATA_DIR || path.join(home, 'InfraTicket-data');

  if (args[0] === 'decrypt-backup') {
    // Needs only the file and a key: no database, no web UI, no server.
    const { decryptBackupCommand } = await import('./ops/backup-format.ts');
    await decryptBackupCommand(args.slice(1), [dataDir]).catch((error: Error) => {
      console.error(`decrypt-backup: ${error.message}`);
      process.exitCode = 1;
    });
    return;
  }

  fs.mkdirSync(dataDir, { recursive: true });

  // Defaults for a laptop: this computer only, embedded database, production UI.
  // Anything set in the environment or the .env wins; --network and --host
  // open it to the company network without editing a file.
  process.env.NODE_ENV ||= 'production';
  process.env.DATA_DIR = dataDir;
  process.env.UPLOADS_DIR ||= path.join(dataDir, 'uploads');
  process.env.EXPORTS_DIR ||= path.join(dataDir, 'exports');
  process.env.SQLITE_FILE ||= 'infraticket.db';
  process.env.SQLITE_ENGINE ||= 'node';
  process.env.PORT = argValue(args, '--port') || process.env.PORT || '8080';
  if (args.includes('--network')) process.env.HOST = '0.0.0.0';
  if (argValue(args, '--host')) process.env.HOST = argValue(args, '--host');
  process.env.HOST ||= '127.0.0.1';
  process.env.INFRATICKET_PORTABLE = '1';
  if (sea) {
    process.env.CLIENT_DIST = unpackWebAssets(sea, path.join(dataDir, 'web'));
  }
  process.chdir(home);

  if (args[0] === 'export') {
    const { exportWorkspace } = await import('./lib/portable-export.ts');
    const file = await exportWorkspace(args[1]);
    console.log(`Workspace exported to ${file}`);
    return;
  }

  const { startServer } = await import('./index.ts');
  await startServer();

  const secure = Boolean(process.env.TLS_PFX_FILE || process.env.TLS_CERT_FILE);
  const url = `${secure ? 'https' : 'http'}://localhost:${process.env.PORT}`;
  console.log(`  Data folder: ${dataDir}`);
  console.log('  Close this window to stop InfraTicket.\n');
  if (!args.includes('--no-browser')) openBrowser(url);
}

main().catch((error) => {
  console.error('\n[fatal] InfraTicket failed to start:\n');
  console.error(error instanceof Error ? error.message : error);
  if (error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error('\nAnother program is using that port. Start with --port 9090 to pick another.');
  }
  pauseBeforeExit(1);
});
