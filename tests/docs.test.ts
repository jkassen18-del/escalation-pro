/**
 * The in-app documentation stays in step with the code it describes.
 *
 * Pages are markdown under docs/, ordered by docs/manifest.json and bundled
 * into the client. These checks catch the ways they drift: a page missing
 * from the manifest's list, a link to a page or heading that no longer
 * exists, an "Open in app" route the app does not have, an environment
 * variable the server reads but the reference does not mention, and a roles
 * table that disagrees with server/permissions.ts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { headingsOf, linksOf, parseMarkdown, resolveLink } from '../src/lib/markdown.tsx';
import { ALL_PERMISSIONS, permissionsForRole } from '../server/permissions.ts';

const ROOT = process.cwd();
const DOCS = path.join(ROOT, 'docs');
const manifest = JSON.parse(fs.readFileSync(path.join(DOCS, 'manifest.json'), 'utf8')) as {
  sections: Array<{ title: string; pages: Array<{ slug: string; title: string; app?: string }> }>;
};
const pages = manifest.sections.flatMap((section) => section.pages);
const read = (slug: string) => fs.readFileSync(path.join(DOCS, `${slug}.md`), 'utf8');

/** Headings by page, as the renderer will give them ids. */
const anchors = new Map(pages.map((page) => [page.slug, new Set(headingsOf(parseMarkdown(read(page.slug))).map((h) => h.id))]));

/** Static routes declared in the client router, e.g. "/monitors" and "/tickets/:id". */
function appRoutes(): string[] {
  const source = fs.readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8');
  return [...source.matchAll(/path="([^"]+)"/g)].map((match) => match[1]).filter((route) => route !== '*');
}

function routeExists(target: string, routes: string[]): boolean {
  const pathname = target.split(/[?#]/)[0];
  return routes.some((route) => {
    const pattern = new RegExp(`^${route.replace(/:[^/]+/g, '[^/]+')}$`);
    return pattern.test(pathname);
  });
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mts)$/.test(entry.name) ? [full] : [];
  });
}

test('every page in the manifest exists and has content', () => {
  const slugs = new Set<string>();
  for (const page of pages) {
    assert.ok(!slugs.has(page.slug), `${page.slug} is listed twice`);
    slugs.add(page.slug);
    assert.ok(fs.existsSync(path.join(DOCS, `${page.slug}.md`)), `docs/${page.slug}.md is missing`);
    const source = read(page.slug);
    assert.ok(source.trim().length > 400, `docs/${page.slug}.md is nearly empty`);
    assert.match(source, /^# /, `docs/${page.slug}.md should start with a # title`);
  }
});

test('every markdown file in docs/ is in the manifest', () => {
  const listed = new Set(pages.map((page) => page.slug));
  for (const file of fs.readdirSync(DOCS).filter((name) => name.endsWith('.md'))) {
    assert.ok(listed.has(file.replace(/\.md$/, '')), `docs/${file} is not in docs/manifest.json`);
  }
});

test('internal links resolve to a page and heading, app links to a route', () => {
  const routes = appRoutes();
  const problems: string[] = [];
  for (const page of pages) {
    for (const href of linksOf(read(page.slug))) {
      const target = resolveLink(href);
      if (target.kind === 'invalid') problems.push(`${page.slug}: "${href}" is not a usable link`);
      if (target.kind === 'anchor' && !anchors.get(page.slug)?.has(href.slice(1))) {
        problems.push(`${page.slug}: no heading for ${href}`);
      }
      if (target.kind === 'docs') {
        const [, slug, anchor] = /^\/docs\/?([^#]*)(?:#(.+))?$/.exec(target.to) ?? [];
        const headings = anchors.get(slug || pages[0].slug);
        if (!headings) problems.push(`${page.slug}: links to missing page ${href}`);
        else if (anchor && !headings.has(anchor)) problems.push(`${page.slug}: ${href} has no heading "${anchor}"`);
      }
      if (target.kind === 'app' && !routeExists(target.to, routes)) problems.push(`${page.slug}: app route ${href} does not exist`);
    }
  }
  assert.deepEqual(problems, []);
});

test('"Open in app" routes exist in the router', () => {
  const routes = appRoutes();
  for (const page of pages) {
    if (page.app) assert.ok(routeExists(page.app, routes), `${page.slug}: ${page.app} is not a route in src/App.tsx`);
  }
  assert.ok(routeExists('/docs', routes) && routeExists('/docs/monitoring', routes), 'the docs routes are registered');
});

test('the environment variable reference lists every variable the server reads', () => {
  const reference = read('environment-variables');
  const used = new Set<string>();
  for (const file of sourceFiles(path.join(ROOT, 'server'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) used.add(match[1]);
    for (const match of source.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) used.add(match[1]);
    // config.ts resolves its directories through a helper: dirOf('DATA_DIR', ...).
    for (const match of source.matchAll(/dirOf\('([A-Z][A-Z0-9_]*)'/g)) used.add(match[1]);
  }
  assert.ok(used.size > 20, 'the scan found the server variables');
  const missing = [...used].filter((name) => !reference.includes(`\`${name}\``)).sort();
  assert.deepEqual(missing, [], `document these in docs/environment-variables.md: ${missing.join(', ')}`);
});

test('the roles table matches server/permissions.ts', () => {
  const source = read('roles-and-permissions');
  const roles = ['admin', 'manager', 'agent', 'viewer'] as const;
  const rows = new Map<string, boolean[]>();
  for (const line of source.split('\n')) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    const key = /^`([a-z_.]+)`$/.exec(cells[0] ?? '')?.[1];
    if (key && cells.length === 6) rows.set(key, cells.slice(2).map((cell) => cell === '✓'));
  }
  assert.deepEqual([...rows.keys()].sort(), [...ALL_PERMISSIONS].sort(), 'the table lists exactly the permissions that exist');
  for (const [key, ticks] of rows) {
    roles.forEach((role, column) => {
      const granted = permissionsForRole(role).includes(key as (typeof ALL_PERMISSIONS)[number]);
      assert.equal(ticks[column], granted, `${key} for ${role}: docs say ${ticks[column]}, code says ${granted}`);
    });
  }
});
