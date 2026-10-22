import { db, parseJson, placeholders, toBool } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import {
  STATUS_UPDATE_STATES,
  type ComponentStatus,
  type MonitorDay,
  type StatusComponent,
  type StatusPage,
  type StatusPageAppearance,
  type StatusPageView,
  type StatusUpdate,
  type StatusUpdateState,
} from '../../shared/ops.ts';
import { occurrencesBetween, scopeCovers, scopeOf } from './maintenance.ts';

/**
 * Status pages, internal and public, as many as you like.
 *
 * A component's state comes from its monitor; the words come from people.
 * Updates are written for the page on purpose, never lifted from a ticket's
 * comments, so nothing said internally about an incident ends up public.
 */

interface PageRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  is_public: number | string;
  components: string;
  appearance: string | null;
  created_at: string;
  updated_at: string;
}

function mapPage(row: PageRow): StatusPage {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    isPublic: toBool(row.is_public),
    components: parseJson<StatusComponent[]>(row.components, []),
    appearance: parseJson<StatusPageAppearance>(row.appearance, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listStatusPages(): Promise<StatusPage[]> {
  return (await db.all<PageRow>(`SELECT * FROM status_pages ORDER BY title`)).map(mapPage);
}

export async function getStatusPage(idOrSlug: string): Promise<StatusPage | null> {
  const row = await db.get<PageRow>(`SELECT * FROM status_pages WHERE id = ? OR slug = ?`, [idOrSlug, idOrSlug]);
  return row ? mapPage(row) : null;
}

export function validateStatusPage(body: Record<string, unknown>) {
  const title = String(body.title ?? '').trim().slice(0, 120);
  if (!title) throw badRequest('Give the page a title.', { title: 'Required' });
  const slug = String(body.slug ?? title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!slug) throw badRequest('The page needs a web address.', { slug: 'Required' });
  const components = (Array.isArray(body.components) ? body.components : [])
    .map((c) => c as Record<string, unknown>)
    .filter((c) => typeof c.monitorId === 'string')
    .map((c) => ({ monitorId: String(c.monitorId), label: String(c.label || '').slice(0, 80) }))
    .slice(0, 50);
  return {
    title,
    slug,
    description: body.description ? String(body.description).slice(0, 1000) : null,
    isPublic: Boolean(body.isPublic),
    components,
    appearance: validateAppearance(body.appearance),
  };
}

function validateAppearance(value: unknown): StatusPageAppearance {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const text = (field: string, max: number) => (typeof raw[field] === 'string' && raw[field] ? String(raw[field]).trim().slice(0, max) : undefined);
  const accent = text('accentColor', 7);
  if (accent && !/^#[0-9a-f]{6}$/i.test(accent)) throw badRequest('The brand colour must look like #b4863a.', { accentColor: 'Invalid' });
  const supportUrl = text('supportUrl', 500);
  if (supportUrl && !/^(https?:\/\/|mailto:)/i.test(supportUrl)) throw badRequest('The support link must start with https://, http:// or mailto:.', { supportUrl: 'Invalid' });
  return {
    theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'auto',
    accentColor: accent,
    showLogo: raw.showLogo !== false,
    headerText: text('headerText', 120),
    supportUrl,
    footerText: text('footerText', 300),
    // CSS cannot run script, but "<" could close the style element and open
    // one that does; nothing legitimate in a stylesheet needs it.
    customCss: text('customCss', 20_000)?.replace(/</g, ''),
  };
}

export async function saveStatusPage(id: string | null, input: ReturnType<typeof validateStatusPage>): Promise<StatusPage> {
  const clash = await db.get<{ id: string }>(`SELECT id FROM status_pages WHERE slug = ? AND id <> ?`, [input.slug, id ?? '']);
  if (clash) throw badRequest('Another status page already uses that address.', { slug: 'Taken' });
  const now = new Date().toISOString();
  const pageId = id ?? randomId();
  if (id) {
    await db.run(`UPDATE status_pages SET slug = ?, title = ?, description = ?, is_public = ?, components = ?, appearance = ?, updated_at = ? WHERE id = ?`, [
      input.slug,
      input.title,
      input.description,
      input.isPublic ? 1 : 0,
      JSON.stringify(input.components),
      JSON.stringify(input.appearance),
      now,
      id,
    ]);
  } else {
    await db.run(
      `INSERT INTO status_pages (id, slug, title, description, is_public, components, appearance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [pageId, input.slug, input.title, input.description, input.isPublic ? 1 : 0, JSON.stringify(input.components), JSON.stringify(input.appearance), now, now],
    );
  }
  return (await getStatusPage(pageId))!;
}

export async function addStatusUpdate(
  pageId: string,
  input: { title: string; state: StatusUpdateState; body: string; ticketId: string | null },
  userId: string | null,
): Promise<void> {
  if (!STATUS_UPDATE_STATES.includes(input.state as (typeof STATUS_UPDATE_STATES)[number]) && input.state !== 'maintenance') {
    throw badRequest('Unknown update state.');
  }
  await db.run(
    `INSERT INTO status_updates (id, status_page_id, ticket_id, title, state, body, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomId(), pageId, input.ticketId, input.title.slice(0, 200), input.state, input.body.slice(0, 5000), userId, new Date().toISOString()],
  );
}

const RANK: Record<ComponentStatus, number> = { operational: 0, unknown: 1, maintenance: 2, degraded: 3, outage: 4 };

export async function renderStatusPage(page: StatusPage): Promise<StatusPageView> {
  const ids = page.components.map((c) => c.monitorId);
  const monitors = ids.length
    ? await db.all<{ id: string; state: string; enabled: number | string; consecutive_failures: number | string; team_id: string | null }>(
        `SELECT id, state, enabled, consecutive_failures, team_id FROM monitors WHERE id IN (${placeholders(ids.length)})`,
        ids,
      )
    : [];
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const dayRows = ids.length
    ? await db.all<{ monitor_id: string; day: string; total: number; failures: number; maintenance: number | null }>(
        `SELECT monitor_id, day, total, failures, maintenance FROM monitor_daily WHERE day >= ? AND monitor_id IN (${placeholders(ids.length)}) ORDER BY day`,
        [since, ...ids],
      )
    : [];

  // Every maintenance occurrence from now to a week out, once; components and
  // the page's maintenance list are both worked out from it.
  const now = Date.now();
  const occurrences = await occurrencesBetween(now, now + 7 * 86_400_000);
  const teamOf = new Map(monitors.map((m) => [m.id, m.team_id]));
  const covers = (window: (typeof occurrences)[number]['row'], monitorId: string) =>
    scopeCovers(scopeOf(window), { sourceId: monitorId, teamId: teamOf.get(monitorId) ?? null });

  const components = await Promise.all(
    page.components.map(async (component) => {
      const monitor = byId.get(component.monitorId);
      let status: ComponentStatus = 'unknown';
      const underMaintenance = occurrences.some(
        ({ row, occurrence }) => new Date(occurrence.startsAt).getTime() <= now && covers(row, component.monitorId),
      );
      if (monitor && toBool(monitor.enabled)) {
        if (underMaintenance) status = 'maintenance';
        else if (monitor.state === 'down') status = 'outage';
        else if (monitor.state === 'up') status = Number(monitor.consecutive_failures) > 0 ? 'degraded' : 'operational';
      }
      const days: MonitorDay[] = dayRows
        .filter((row) => row.monitor_id === component.monitorId)
        .map((row) => ({ day: row.day, total: Number(row.total), failures: Number(row.failures), maintenance: Number(row.maintenance ?? 0) }));
      // Checks that failed during maintenance count neither way.
      const total = days.reduce((sum, d) => sum + d.total - (d.maintenance ?? 0), 0);
      const failures = days.reduce((sum, d) => sum + d.failures, 0);
      return { ...component, status, uptime90d: total > 0 ? Math.round(((total - failures) / total) * 10000) / 100 : null, days };
    }),
  );

  const labelOf = new Map(page.components.map((c) => [c.monitorId, c.label]));
  const maintenance = occurrences
    .filter(({ row }) => Number(row.publish ?? 0) === 1)
    .map(({ row, occurrence }) => {
      const affected = page.components.filter((c) => covers(row, c.monitorId)).map((c) => labelOf.get(c.monitorId) || 'Service');
      return {
        title: row.title,
        description: row.description,
        startsAt: occurrence.startsAt,
        endsAt: occurrence.endsAt,
        timeZone: row.time_zone || 'Africa/Johannesburg',
        inProgress: new Date(occurrence.startsAt).getTime() <= now,
        components: affected,
        everything: Boolean(scopeOf(row).everything),
      };
    })
    // A window that touches nothing on this page is not this page's news.
    .filter((m) => m.components.length > 0 || m.everything)
    .map(({ everything: _everything, ...m }) => m);

  const updateRows = await db.all<Record<string, string | null>>(
    `SELECT * FROM status_updates WHERE status_page_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 50`,
    [page.id, new Date(Date.now() - 14 * 86_400_000).toISOString()],
  );
  const updates: StatusUpdate[] = updateRows.map((row) => ({
    id: row.id!,
    ticketId: row.ticket_id ?? null,
    title: row.title!,
    state: row.state as StatusUpdateState,
    body: row.body ?? '',
    createdAt: row.created_at!,
  }));

  const overall = components.reduce<ComponentStatus>((worst, c) => (RANK[c.status] > RANK[worst] ? c.status : worst), 'operational');
  return { page, overall: components.length ? overall : 'unknown', components, updates, maintenance, generatedAt: new Date().toISOString() };
}

/* -------------------------- Server-rendered page -------------------------- */

const LABEL: Record<ComponentStatus, string> = {
  operational: 'Operational',
  degraded: 'Degraded performance',
  outage: 'Outage',
  maintenance: 'Under maintenance',
  unknown: 'No data yet',
};
const HEADLINE: Record<ComponentStatus, string> = {
  operational: 'All systems operational',
  degraded: 'Some systems are degraded',
  outage: 'We are experiencing an outage',
  maintenance: 'Scheduled maintenance in progress',
  unknown: 'Status is being collected',
};
const STATE_LABEL: Record<StatusUpdateState, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
  maintenance: 'Maintenance',
};

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Small inline icons, so the page needs no icon font or script. */
const ICON: Record<ComponentStatus, string> = {
  operational: '<path d="M20 6 9 17l-5-5"/>',
  degraded: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  outage: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  maintenance: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8Z"/>',
  unknown: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
};
const icon = (status: ComponentStatus, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[status]}</svg>`;

export interface StatusPageChrome {
  organisation: string;
  /** The organisation logo, when one is uploaded and the page shows it. */
  logoUrl: string | null;
  /** The app's own Geist font file, when the web bundle is present. */
  fontUrl: string | null;
}

/** "Gold Media Lab" -> "GM", the same mark the app's sidebar shows. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

/**
 * "SAST" rather than "GMT+2". Each locale only knows the names of its own
 * region's zones, so a few are asked in turn before settling for the offset.
 */
export function zoneAbbreviation(at: Date, timeZone: string): string {
  let fallback = timeZone;
  for (const locale of ['en-ZA', 'en-GB', 'en-US', 'en-AU']) {
    const name = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value;
    if (!name) continue;
    if (!/^(GMT|UTC)[+-−]/.test(name)) return name;
    fallback = name;
  }
  return fallback;
}

/** "Sat 25 Oct, 22:00 – Sun 26 Oct, 02:00 SAST", in the window's own zone. */
function formatRange(startIso: string, endIso: string, timeZone: string): string {
  const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone });
  const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
  const zone = zoneAbbreviation(new Date(startIso), timeZone);
  const sameDay = day(startIso) === day(endIso);
  return `${day(startIso)}, ${time(startIso)} – ${sameDay ? '' : `${day(endIso)}, `}${time(endIso)} ${zone}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
}

/**
 * A complete HTML page with no scripts and no app bundle: it has to load for
 * anyone, fast, even while the rest of the platform is having a bad day.
 *
 * It uses the app's own palette (warm neutrals, brass accent) and font, in
 * light and dark. Each page can pick its theme and brand colour, show the
 * organisation logo, and add custom CSS for a fully custom look.
 */
export function statusPageHtml(view: StatusPageView, chrome: StatusPageChrome): string {
  const a = view.page.appearance ?? {};
  const theme = a.theme ?? 'auto';
  const accent = a.accentColor;
  const today = new Date();
  const days = 90;

  const bars = (rows: MonitorDay[]) => {
    const byDay = new Map(rows.map((d) => [d.day, d]));
    return Array.from({ length: days }, (_, i) => {
      const date = new Date(today.getTime() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
      const d = byDay.get(date);
      const counted = d ? d.total - (d.maintenance ?? 0) : 0;
      const ratio = d && counted > 0 ? d.failures / counted : null;
      const level = d && d.maintenance && !d.failures ? 'maint' : ratio === null ? (d && d.total ? 'maint' : 'none') : ratio === 0 ? 'ok' : ratio < 0.05 ? 'warn' : 'bad';
      const label =
        d && d.total
          ? `${date} · ${counted > 0 ? `${(((counted - d.failures) / counted) * 100).toFixed(2)}% up` : 'maintenance'}${d.maintenance ? ' · planned maintenance' : ''}`
          : `${date} · no data`;
      return `<span class="bar bar-${level}" title="${label}"></span>`;
    }).join('');
  };

  const components = view.components
    .map(
      (c) => `<li class="component">
        <div class="row">
          <span class="name">${esc(c.label || 'Service')}</span>
          <span class="pill pill-${c.status}">${icon(c.status, 13)}${LABEL[c.status]}</span>
        </div>
        <div class="bars" role="img" aria-label="Uptime over the last ${days} days">${bars(c.days)}</div>
        <div class="row axis"><span>${days} days ago</span><span class="uptime">${c.uptime90d === null ? '' : `${c.uptime90d}% uptime`}</span><span>Today</span></div>
      </li>`,
    )
    .join('');

  // Maintenance posts its own updates; while it runs, its section says so instead.
  const ongoing = view.updates.filter((u) => u.state !== 'resolved' && u.state !== 'maintenance');
  const maintenanceBlock = (m: NonNullable<StatusPageView['maintenance']>[number]) => `<article class="maint">
      <div class="update-head"><span class="state state-maintenance">${m.inProgress ? 'In progress' : 'Scheduled'}</span><h3>${esc(m.title)}</h3></div>
      <p class="when">${esc(formatRange(m.startsAt, m.endsAt, m.timeZone))}</p>
      ${m.description ? `<p>${esc(m.description).replace(/\n/g, '<br>')}</p>` : ''}
      ${m.components.length ? `<p class="affects">Affects: ${esc(m.components.join(', '))}</p>` : ''}
    </article>`;
  const inProgress = (view.maintenance ?? []).filter((m) => m.inProgress);
  const upcoming = (view.maintenance ?? []).filter((m) => !m.inProgress);
  const update = (u: StatusUpdate) => `<article class="update">
      <div class="update-head"><span class="state state-${u.state}">${STATE_LABEL[u.state]}</span><h3>${esc(u.title)}</h3></div>
      ${u.body ? `<p>${esc(u.body).replace(/\n/g, '<br>')}</p>` : ''}
      <time datetime="${u.createdAt}">${formatDate(u.createdAt)}</time>
    </article>`;

  const header = a.headerText || chrome.organisation;
  const logo = a.showLogo !== false && chrome.logoUrl ? `<img class="logo" src="${esc(chrome.logoUrl)}" alt="">` : `<span class="mark">${esc(initials(header))}</span>`;

  const light = `--bg:#f7f6f3;--surface:#fff;--surface-2:#faf9f7;--border:#e3e0da;--fg:#1a1815;--muted:#6b665e;--subtle:#938d84;--accent:${accent ?? '#96692f'};
    --ok:#3f7d4e;--ok-bg:#ecf5ee;--warn:#b54708;--warn-bg:#fdf1e7;--bad:#b42318;--bad-bg:#fbeceb;--info:#1d6fb8;--info-bg:#e9f2fb;--none:#e5e2dd`;
  const dark = `--bg:#100f0d;--surface:#191714;--surface-2:#1f1d19;--border:#302c27;--fg:#ede9e3;--muted:#9c968c;--subtle:#746e65;--accent:${accent ?? '#c9a04b'};
    --ok:#74b183;--ok-bg:#1c2a1f;--warn:#dc9350;--warn-bg:#2f2216;--bad:#e8776b;--bad-bg:#331b18;--info:#6ba7de;--info-bg:#17242f;--none:#2a2721`;
  const palette =
    theme === 'light'
      ? `:root{${light}}`
      : theme === 'dark'
        ? `:root{${dark}}`
        : `:root{${light}}@media (prefers-color-scheme:dark){:root{${dark}}}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<meta name="color-scheme" content="${theme === 'auto' ? 'light dark' : theme}">
<title>${esc(view.page.title)} · ${esc(header)}</title>
<style>
${chrome.fontUrl ? `@font-face{font-family:'Geist';src:url('${esc(chrome.fontUrl)}') format('woff2');font-weight:100 900;font-display:swap}` : ''}
${palette}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 'Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
.top{border-bottom:1px solid var(--border);background:var(--surface)}
.top-inner,main{max-width:760px;margin:0 auto;padding:0 16px}
.top-inner{display:flex;align-items:center;gap:10px;height:56px}
.mark{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:5px;background:var(--fg);color:var(--bg);font-size:10px;font-weight:700;letter-spacing:.02em}
.logo{height:26px;width:auto;border-radius:4px}
.org{font-weight:600;font-size:13px}
.top a{margin-left:auto;color:var(--accent);font-size:13px;text-decoration:none}.top a:hover{text-decoration:underline}
main{padding-top:36px;padding-bottom:48px}
h1{margin:0;font-size:22px;font-weight:600;letter-spacing:-.01em}
.lede{margin:4px 0 0;color:var(--muted)}
.banner{display:flex;align-items:center;gap:12px;margin:24px 0 28px;padding:16px 18px;border-radius:8px;border:1px solid;font-weight:600;font-size:15px}
.banner small{display:block;font-weight:400;font-size:12px;color:var(--muted);margin-top:1px}
.banner-operational{background:var(--ok-bg);border-color:color-mix(in srgb,var(--ok) 30%,transparent);color:var(--ok)}
.banner-degraded{background:var(--warn-bg);border-color:color-mix(in srgb,var(--warn) 30%,transparent);color:var(--warn)}
.banner-outage{background:var(--bad-bg);border-color:color-mix(in srgb,var(--bad) 30%,transparent);color:var(--bad)}
.banner-maintenance{background:var(--info-bg);border-color:color-mix(in srgb,var(--info) 30%,transparent);color:var(--info)}
.banner-unknown{background:var(--surface);border-color:var(--border);color:var(--muted)}
h2{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--subtle);margin:0 0 10px}
section{margin-bottom:32px}
ul{list-style:none;margin:0;padding:0;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.component{padding:16px 18px;border-top:1px solid var(--border)}.component:first-child{border-top:0}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px}
.name{font-weight:550;font-size:14px}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:550;white-space:nowrap}
.pill-operational{color:var(--ok)}.pill-degraded{color:var(--warn)}.pill-outage{color:var(--bad)}.pill-maintenance{color:var(--info)}.pill-unknown{color:var(--subtle)}
.bars{display:flex;gap:2px;margin:12px 0 6px;height:30px}
.bar{flex:1;min-width:2px;border-radius:2px;background:var(--none);transition:opacity .15s}.bar:hover{opacity:.7}
.bar-ok{background:var(--ok)}.bar-warn{background:var(--warn)}.bar-bad{background:var(--bad)}.bar-maint{background:var(--info)}
.axis{font-size:11px;color:var(--subtle)}.uptime{color:var(--muted)}
.update{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;padding:14px 16px;margin-bottom:10px}
.update-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.update h3{margin:0;font-size:14px;font-weight:600}
.update p{margin:8px 0 6px;color:var(--fg)}
.update time{color:var(--subtle);font-size:12px}
.state{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:2px 7px;border-radius:4px}
.state-investigating{background:var(--bad-bg);color:var(--bad)}.state-identified{background:var(--warn-bg);color:var(--warn)}
.state-monitoring{background:var(--info-bg);color:var(--info)}.state-resolved{background:var(--ok-bg);color:var(--ok)}.state-maintenance{background:var(--info-bg);color:var(--info)}
.maint{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--info);border-radius:8px;padding:14px 16px;margin-bottom:10px}
.maint h3{margin:0;font-size:14px;font-weight:600}.maint p{margin:6px 0}.maint .when{color:var(--muted);font-size:13px}.maint .affects{color:var(--subtle);font-size:12px}
.empty{color:var(--muted);font-size:13px;margin:0}
footer{border-top:1px solid var(--border);padding-top:16px;color:var(--subtle);font-size:12px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
footer a{color:var(--accent)}
@media (max-width:520px){.bars{gap:1px;height:26px}.banner{font-size:14px}h1{font-size:19px}}
${a.customCss ?? ''}
</style></head>
<body>
<header class="top"><div class="top-inner">${logo}<span class="org">${esc(header)}</span>${a.supportUrl ? `<a href="${esc(a.supportUrl)}" rel="noopener">Contact support</a>` : ''}</div></header>
<main>
<h1>${esc(view.page.title)}</h1>
${view.page.description ? `<p class="lede">${esc(view.page.description)}</p>` : ''}
<div class="banner banner-${view.overall}">${icon(view.overall, 22)}<div>${HEADLINE[view.overall]}<small>Updated ${formatDate(view.generatedAt)}</small></div></div>
${ongoing.length ? `<section><h2>Ongoing</h2>${ongoing.map(update).join('')}</section>` : ''}
${inProgress.length ? `<section><h2>Maintenance in progress</h2>${inProgress.map(maintenanceBlock).join('')}</section>` : ''}
<section><h2>Services</h2>${view.components.length ? `<ul>${components}</ul>` : '<p class="empty">No services on this page yet.</p>'}</section>
${upcoming.length ? `<section><h2>Scheduled maintenance</h2>${upcoming.map(maintenanceBlock).join('')}</section>` : ''}
<section><h2>Recent updates</h2>${
    view.updates.filter((u) => u.state === 'resolved' || u.state === 'maintenance').map(update).join('') ||
    '<p class="empty">No incidents reported in the last 14 days.</p>'
  }</section>
<footer><span>${a.footerText ? esc(a.footerText) : `© ${esc(chrome.organisation)}`}</span><span>Powered by InfraTicket · refreshes every minute</span></footer>
</main></body></html>`;
}

/**
 * Posts a maintenance window's own start or end to every page it touches.
 * Called by the ops runner once per occurrence transition.
 */
export async function postMaintenanceUpdates(
  window: { id: string; title: string; description: string | null; scope: ReturnType<typeof scopeOf> },
  phase: 'started' | 'ended',
): Promise<number> {
  const pages = await listStatusPages();
  const scope = window.scope;
  const teams = scope.teamIds?.length
    ? new Map(
        (await db.all<{ id: string; team_id: string | null }>(`SELECT id, team_id FROM monitors`)).map((m) => [m.id, m.team_id]),
      )
    : new Map<string, string | null>();
  let posted = 0;
  for (const page of pages) {
    const touched = scope.everything || page.components.some((c) => scopeCovers(scope, { sourceId: c.monitorId, teamId: teams.get(c.monitorId) ?? null }));
    if (!touched) continue;
    await addStatusUpdate(
      page.id,
      phase === 'started'
        ? { title: `Maintenance in progress: ${window.title}`, state: 'maintenance', body: window.description ?? 'Planned maintenance has started.', ticketId: null }
        : { title: `Maintenance completed: ${window.title}`, state: 'resolved', body: 'The planned maintenance has finished.', ticketId: null },
      null,
    );
    posted += 1;
  }
  return posted;
}
