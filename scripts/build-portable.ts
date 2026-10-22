/**
 * Builds the portable single-file executable.
 *
 *   npm run build:portable                 # Windows: dist/portable/InfraTicket.exe
 *   npm run build:portable -- --target linux-x64
 *   npm run build:portable -- --target darwin-arm64
 *
 * How: the server is bundled into one CommonJS file, the web UI is attached as
 * assets, and both are injected into an official Node.js binary for the target
 * platform using Node's single-executable-application support. Nothing native
 * is bundled - the embedded database is Node's own node:sqlite - so a Windows
 * executable can be produced from Linux or macOS.
 *
 * The Node binary is downloaded from nodejs.org once, checked against the
 * published SHA-256, and cached under .cache/node/.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { APP_VERSION } from '../shared/version.ts';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'dist/portable');
const CACHE = path.join(ROOT, '.cache/node');

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const target = arg('target') || 'win-x64';
const [os] = target.split('-');
if (!['win', 'linux', 'darwin'].includes(os)) throw new Error(`Unknown --target ${target}`);

// The blob format is tied to the Node version that writes it, so the target
// binary must be the same release as the Node running this script.
const NODE_VERSION = process.version;

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchNodeBinary(): Promise<string> {
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  const cached = path.join(CACHE, `${NODE_VERSION}-${target}${os === 'win' ? '.exe' : ''}`);
  if (fs.existsSync(cached)) return cached;
  fs.mkdirSync(CACHE, { recursive: true });

  const sums = (await download(`${base}/SHASUMS256.txt`)).toString('utf8');
  let binary: Buffer;
  let expectedName: string;
  if (os === 'win') {
    expectedName = `win-${target.split('-')[1]}/node.exe`;
    binary = await download(`${base}/${expectedName}`);
  } else {
    expectedName = `node-${NODE_VERSION}-${target}.tar.gz`;
    const archive = await download(`${base}/${expectedName}`);
    verify(archive, sums, expectedName);
    const scratch = path.join(CACHE, `extract-${target}`);
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
    const tarball = path.join(scratch, 'node.tar.gz');
    fs.writeFileSync(tarball, archive);
    execFileSync('tar', ['-xzf', tarball, '-C', scratch, `node-${NODE_VERSION}-${target}/bin/node`]);
    binary = fs.readFileSync(path.join(scratch, `node-${NODE_VERSION}-${target}/bin/node`));
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.writeFileSync(cached, binary, { mode: 0o755 });
    return cached;
  }
  verify(binary, sums, expectedName);
  fs.writeFileSync(cached, binary, { mode: 0o755 });
  return cached;
}

function verify(bytes: Buffer, sums: string, name: string) {
  const line = sums.split('\n').find((entry) => entry.trim().endsWith(`  ${name}`));
  if (!line) throw new Error(`${name} is not listed in SHASUMS256.txt`);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== line.split(/\s+/)[0]) throw new Error(`Checksum mismatch for ${name}`);
}

function listFiles(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), relative) : [relative];
  });
}

async function main() {
  console.log(`Building InfraTicket ${APP_VERSION} portable for ${target} (Node ${NODE_VERSION})`);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  if (!process.argv.includes('--skip-client')) {
    execFileSync('npx', ['vite', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
  }
  const clientDir = path.join(ROOT, 'dist/client');
  if (!fs.existsSync(path.join(clientDir, 'index.html'))) throw new Error('dist/client is missing; run vite build');

  const bundle = path.join(OUT, 'infraticket.cjs');
  await build({
    entryPoints: [path.join(ROOT, 'server/portable.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: bundle,
    // vite is only loaded in development; the others are optional native addons.
    external: ['vite', 'better-sqlite3', 'pg-native', 'cpu-features', 'ssh2'],
    logLevel: 'warning',
    logOverride: { 'empty-import-meta': 'silent' },
  });

  const webFiles = listFiles(clientDir);
  // Every build of one version shares a version number, so the unpacked UI is
  // keyed by a hash of its contents: a newer exe never reuses an older UI.
  const hash = crypto.createHash('sha256');
  for (const file of webFiles) hash.update(file).update(fs.readFileSync(path.join(clientDir, file)));
  const manifestPath = path.join(OUT, 'web-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ build: hash.digest('hex').slice(0, 12), files: webFiles }));
  const assets: Record<string, string> = { 'web-manifest.json': manifestPath };
  for (const file of webFiles) assets[`web/${file}`] = path.join(clientDir, file);

  const blob = path.join(OUT, 'sea-prep.blob');
  const seaConfig = path.join(OUT, 'sea-config.json');
  fs.writeFileSync(
    seaConfig,
    JSON.stringify({
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      // Both are specific to the machine that builds them, and this one may
      // not be the target platform.
      useSnapshot: false,
      useCodeCache: false,
      assets,
    }),
  );
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

  const executable = path.join(OUT, os === 'win' ? 'InfraTicket.exe' : `infraticket-${target}`);
  fs.copyFileSync(await fetchNodeBinary(), executable);
  fs.chmodSync(executable, 0o755);

  const postjectArgs = [executable, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
  if (os === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/postject/dist/cli.js'), ...postjectArgs], { stdio: 'inherit' });
  if (os === 'darwin' && process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', executable]);

  for (const scratch of [bundle, blob, seaConfig, manifestPath]) fs.rmSync(scratch, { force: true });

  const size = fs.statSync(executable).size;
  const digest = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  fs.writeFileSync(`${executable}.sha256`, `${digest}  ${path.basename(executable)}\n`);
  console.log(`\n${path.relative(ROOT, executable)}  ${(size / 1024 / 1024).toFixed(1)} MB\nsha256 ${digest}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
