import { db, parseJson, placeholders, toBool } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import {
  STATUS_UPDATE_STATES,
  type ComponentStatus,
  type MonitorDay,
  type StatusComponent,
  type StatusPage,
  type StatusPageView,
  type StatusUpdate,
  type StatusUpdateState,
} from '../../shared/ops.ts';
import { inMaintenance } from './alerts.ts';

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
  return { title, slug, description: body.description ? String(body.description).slice(0, 1000) : null, isPublic: Boolean(body.isPublic), components };
}

export async function saveStatusPage(id: string | null, input: ReturnType<typeof validateStatusPage>): Promise<StatusPage> {
  const clash = await db.get<{ id: string }>(`SELECT id FROM status_pages WHERE slug = ? AND id <> ?`, [input.slug, id ?? '']);
  if (clash) throw badRequest('Another status page already uses that address.', { slug: 'Taken' });
  const now = new Date().toISOString();
  const pageId = id ?? randomId();
  if (id) {
    await db.run(`UPDATE status_pages SET slug = ?, title = ?, description = ?, is_public = ?, components = ?, updated_at = ? WHERE id = ?`, [
      input.slug,
      input.title,
      input.description,
      input.isPublic ? 1 : 0,
      JSON.stringify(input.components),
      now,
      id,
    ]);
  } else {
    await db.run(
      `INSERT INTO status_pages (id, slug, title, description, is_public, components, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [pageId, input.slug, input.title, input.description, input.isPublic ? 1 : 0, JSON.stringify(input.components), now, now],
    );
  }
  return (await getStatusPage(pageId))!;
}

export async function addStatusUpdate(
  pageId: string,
  input: { title: string; state: StatusUpdateState; body: string; ticketId: string | null },
  userId: string | null,
): Promise<void> {
  if (!STATUS_UPDATE_STATES.includes(input.state)) throw badRequest('Unknown update state.');
  await db.run(
    `INSERT INTO status_updates (id, status_page_id, ticket_id, title, state, body, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomId(), pageId, input.ticketId, input.title.slice(0, 200), input.state, input.body.slice(0, 5000), userId, new Date().toISOString()],
  );
}

const RANK: Record<ComponentStatus, number> = { operational: 0, unknown: 1, maintenance: 2, degraded: 3, outage: 4 };

export async function renderStatusPage(page: StatusPage): Promise<StatusPageView> {
  const ids = page.components.map((c) => c.monitorId);
  const monitors = ids.length
    ? await db.all<{ id: string; state: string; enabled: number | string; consecutive_failures: number | string }>(
        `SELECT id, state, enabled, consecutive_failures FROM monitors WHERE id IN (${placeholders(ids.length)})`,
        ids,
      )
    : [];
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const dayRows = ids.length
    ? await db.all<{ monitor_id: string; day: string; total: number; failures: number }>(
        `SELECT monitor_id, day, total, failures FROM monitor_daily WHERE day >= ? AND monitor_id IN (${placeholders(ids.length)}) ORDER BY day`,
        [since, ...ids],
      )
    : [];

  const components = await Promise.all(
    page.components.map(async (component) => {
      const monitor = byId.get(component.monitorId);
      let status: ComponentStatus = 'unknown';
      if (monitor && toBool(monitor.enabled)) {
        if (await inMaintenance(component.monitorId)) status = 'maintenance';
        else if (monitor.state === 'down') status = 'outage';
        else if (monitor.state === 'up') status = Number(monitor.consecutive_failures) > 0 ? 'degraded' : 'operational';
      }
      const days: MonitorDay[] = dayRows
        .filter((row) => row.monitor_id === component.monitorId)
        .map((row) => ({ day: row.day, total: Number(row.total), failures: Number(row.failures) }));
      const total = days.reduce((sum, d) => sum + d.total, 0);
      const failures = days.reduce((sum, d) => sum + d.failures, 0);
      return { ...component, status, uptime90d: total ? Math.round(((total - failures) / total) * 10000) / 100 : null, days };
    }),
  );

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
  return { page, overall: components.length ? overall : 'unknown', components, updates, generatedAt: new Date().toISOString() };
}

/* -------------------------- Server-rendered page -------------------------- */

const LABEL: Record<ComponentStatus, string> = {
  operational: 'Operational',
  degraded: 'Degraded performance',
  outage: 'Outage',
  maintenance: 'Under maintenance',
  unknown: 'No data',
};
const COLOR: Record<ComponentStatus, string> = {
  operational: '#16a34a',
  degraded: '#d97706',
  outage: '#dc2626',
  maintenance: '#2563eb',
  unknown: '#9ca3af',
};
const HEADLINE: Record<ComponentStatus, string> = {
  operational: 'All systems operational',
  degraded: 'Some systems are degraded',
  outage: 'We are experiencing an outage',
  maintenance: 'Scheduled maintenance in progress',
  unknown: 'Status unavailable',
};

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * A complete HTML page, with no scripts and no app bundle: it has to load for
 * anyone, fast, even while the rest of the platform is having a bad day.
 */
export function statusPageHtml(view: StatusPageView, organisation: string): string {
  const today = new Date();
  const bars = (days: MonitorDay[]) => {
    const byDay = new Map(days.map((d) => [d.day, d]));
    return Array.from({ length: 90 }, (_, i) => {
      const date = new Date(today.getTime() - (89 - i) * 86_400_000).toISOString().slice(0, 10);
      const d = byDay.get(date);
      const ratio = d && d.total ? d.failures / d.total : null;
      const color = ratio === null ? '#e5e7eb' : ratio === 0 ? '#16a34a' : ratio < 0.05 ? '#d97706' : '#dc2626';
      const title = d && d.total ? `${date}: ${(((d.total - d.failures) / d.total) * 100).toFixed(2)}% up` : `${date}: no data`;
      return `<span class="bar" style="background:${color}" title="${title}"></span>`;
    }).join('');
  };
  const components = view.components
    .map(
      (c) => `<li class="component">
        <div class="row"><strong>${esc(c.label || 'Service')}</strong><span class="state" style="color:${COLOR[c.status]}">${LABEL[c.status]}</span></div>
        <div class="bars" aria-hidden="true">${bars(c.days)}</div>
        <div class="row muted"><span>90 days ago</span><span>${c.uptime90d === null ? '' : `${c.uptime90d}% uptime`}</span><span>Today</span></div>
      </li>`,
    )
    .join('');
  const updates = view.updates.length
    ? view.updates
        .map(
          (u) => `<article class="update"><h3>${esc(u.title)} <span class="tag tag-${u.state}">${u.state}</span></h3>
          <p>${esc(u.body).replace(/\n/g, '<br>')}</p><time datetime="${u.createdAt}">${new Date(u.createdAt).toUTCString()}</time></article>`,
        )
        .join('')
    : '<p class="muted">No incidents reported in the last 14 days.</p>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>${esc(view.page.title)} · Status</title>
<style>
:root{--bg:#f8fafc;--card:#fff;--text:#0f172a;--muted:#64748b;--border:#e2e8f0}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#111827;--text:#e5e7eb;--muted:#94a3b8;--border:#1f2937}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 16px}
header h1{margin:0;font-size:24px}header p{margin:4px 0 0;color:var(--muted)}
.banner{margin:24px 0;padding:16px 20px;border-radius:10px;color:#fff;font-weight:600;font-size:17px;background:${COLOR[view.overall]}}
ul{list-style:none;margin:0;padding:0;background:var(--card);border:1px solid var(--border);border-radius:10px}
.component{padding:16px 20px;border-top:1px solid var(--border)}.component:first-child{border-top:0}
.row{display:flex;justify-content:space-between;gap:12px;align-items:center}.state{font-weight:600;font-size:14px}
.bars{display:flex;gap:2px;margin:10px 0 6px;height:28px}.bar{flex:1;border-radius:2px;min-width:2px}
.muted{color:var(--muted);font-size:12px}
h2{font-size:17px;margin:32px 0 12px}.update{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 18px;margin-bottom:10px}
.update h3{margin:0 0 6px;font-size:15px}.update p{margin:0 0 6px}.update time{color:var(--muted);font-size:12px}
.tag{font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:2px 6px;border-radius:4px;background:var(--border);margin-left:6px}
.tag-resolved{background:#dcfce7;color:#166534}.tag-investigating{background:#fee2e2;color:#991b1b}.tag-identified{background:#ffedd5;color:#9a3412}.tag-monitoring{background:#dbeafe;color:#1e40af}
footer{margin-top:40px;color:var(--muted);font-size:12px;text-align:center}
</style></head>
<body><main>
<header><h1>${esc(view.page.title)}</h1>${view.page.description ? `<p>${esc(view.page.description)}</p>` : ''}</header>
<div class="banner">${HEADLINE[view.overall]}</div>
${view.components.length ? `<ul>${components}</ul>` : '<p class="muted">No components on this page yet.</p>'}
<h2>Recent updates</h2>${updates}
<footer>${esc(organisation)} · Updated ${new Date(view.generatedAt).toUTCString()} · Powered by InfraTicket</footer>
</main></body></html>`;
}
