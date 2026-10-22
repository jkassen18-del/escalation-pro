import { db, toBool } from '../db/index.ts';
import { loadSaml, samlReady } from '../lib/sso.ts';
import { getOpsSetting } from '../repositories/settings.ts';
import { ALERT_SOURCE_KINDS, type AlertSourceKind } from '../../shared/ops.ts';
import type { CatalogueStatus, IntegrationSummary } from '../../shared/types.ts';

/**
 * The state of every tile on the Integrations page, computed from real data:
 * a chat tool counts as connected only once its test has passed, a monitoring
 * source only once an alert has actually arrived.
 */

export interface TeamsConsentRecord {
  grantedAt?: string;
  tenant?: string;
  error?: string;
  failedAt?: string;
}

function chatStatus(summary: IntegrationSummary): CatalogueStatus {
  if (!summary.configured) return { state: 'not_set_up', detail: null };
  if (summary.status === 'error') return { state: 'attention', detail: summary.lastError ?? 'The last test failed.' };
  if (summary.status !== 'ok') return { state: 'attention', detail: 'Configured but not tested yet.' };
  if (!summary.enabled) return { state: 'attention', detail: 'Tested, but switched off.' };
  return { state: 'connected', detail: 'Connected and tested.' };
}

export async function catalogueStatus(summaries: IntegrationSummary[]): Promise<Record<string, CatalogueStatus>> {
  const status: Record<string, CatalogueStatus> = {};
  for (const summary of summaries) status[summary.provider] = chatStatus(summary);

  const consent = await getOpsSetting<TeamsConsentRecord>('msteams-consent', {});
  if (status.msteams && consent.error && !consent.grantedAt) {
    status.msteams = { state: 'attention', detail: `Admin consent failed: ${consent.error}` };
  }

  const sources = await db.all<{ kind: AlertSourceKind; enabled: number | string; event_count: number | string; last_event_at: string | null }>(
    `SELECT kind, enabled, event_count, last_event_at FROM alert_sources`,
  );
  for (const kind of ALERT_SOURCE_KINDS) {
    const mine = sources.filter((s) => s.kind === kind && toBool(s.enabled));
    if (!mine.length) {
      status[`source:${kind}`] = { state: 'not_set_up', detail: null };
      continue;
    }
    const events = mine.reduce((sum, s) => sum + Number(s.event_count), 0);
    const last = mine.map((s) => s.last_event_at).filter((v): v is string => Boolean(v)).sort().pop() ?? null;
    status[`source:${kind}`] = events
      ? { state: 'connected', detail: `${mine.length} source${mine.length > 1 ? 's' : ''} · last alert ${last}` }
      : { state: 'attention', detail: 'Waiting for the first alert. Send a test from the provider.' };
  }

  const http = await db.get<{ total: number | string; enabled: number | string }>(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled FROM http_integrations`,
  );
  const httpEnabled = Number(http?.enabled ?? 0);
  status.custom_http = httpEnabled
    ? { state: 'connected', detail: `${httpEnabled} endpoint${httpEnabled > 1 ? 's' : ''} sending` }
    : Number(http?.total ?? 0)
      ? { state: 'attention', detail: 'Every endpoint is switched off.' }
      : { state: 'not_set_up', detail: null };

  const beats = await db.all<{ state: string; enabled: number | string }>(`SELECT state, enabled FROM monitors WHERE kind = 'heartbeat'`);
  const down = beats.filter((b) => toBool(b.enabled) && b.state === 'down').length;
  status.heartbeats = !beats.length
    ? { state: 'not_set_up', detail: null }
    : down
      ? { state: 'attention', detail: `${down} heartbeat${down > 1 ? 's are' : ' is'} overdue.` }
      : { state: 'connected', detail: `${beats.length} heartbeat${beats.length > 1 ? 's' : ''}` };

  const jobs = await db.all<{ status: string | null }>(
    `SELECT (SELECT r.status FROM backup_runs r WHERE r.job_id = j.id AND r.status <> 'pruned' ORDER BY r.started_at DESC LIMIT 1) AS status
     FROM backup_jobs j`,
  );
  const failing = jobs.filter((j) => j.status === 'failed').length;
  status.databases = !jobs.length
    ? { state: 'not_set_up', detail: null }
    : failing
      ? { state: 'attention', detail: `${failing} backup${failing > 1 ? 's are' : ' is'} failing.` }
      : { state: 'connected', detail: `${jobs.length} database${jobs.length > 1 ? 's' : ''}` };

  const lookups = await db.all<{ status: string }>(`SELECT status FROM data_sources`);
  const broken = lookups.filter((l) => l.status === 'error').length;
  status.lookups = !lookups.length
    ? { state: 'not_set_up', detail: null }
    : broken
      ? { state: 'attention', detail: `${broken} connection${broken > 1 ? 's' : ''} failing.` }
      : { state: 'connected', detail: `${lookups.length} connection${lookups.length > 1 ? 's' : ''}` };

  const saml = await loadSaml();
  status.sso = samlReady(saml)
    ? { state: 'connected', detail: saml.requireSso ? 'On, and required.' : 'On.' }
    : saml.enabled
      ? { state: 'attention', detail: 'Switched on but missing the identity provider details.' }
      : { state: 'not_set_up', detail: null };

  return status;
}
