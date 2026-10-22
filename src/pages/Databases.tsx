import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Database, Download, HeartPulse, MoreHorizontal, Plus, Play, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { opsApi } from '@/lib/ops-api';
import { fileSize, relativeTime, shortDateTime } from '@/lib/format';
import { useToast } from '@/components/ui/Toast';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Menu } from '@/components/ui/Menu';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { ConfirmDialog } from '@/components/ui/Modal';
import { DatabaseDialog } from '@/components/ops/DatabaseDialog';
import { useAuth } from '@/state/auth';
import { useDocumentTitle } from '@/state/branding';
import { BACKUP_ENGINE_LABELS, type BackupJob, type BackupRun } from '@shared/ops';
import type { Team } from '@shared/types';

const RUN_COLORS: Record<BackupRun['status'], string> = {
  running: 'var(--status-open)',
  succeeded: 'var(--status-resolved)',
  failed: 'var(--priority-urgent)',
  pruned: 'var(--status-closed)',
};

const SCHEDULE_NAMES: Record<string, string> = {
  '0 * * * *': 'Hourly',
  '0 1 * * *': 'Nightly, 01:00 UTC',
  '0 2 * * 0': 'Weekly, Sunday 02:00 UTC',
};

export function scheduleLabel(cron: string): string {
  return SCHEDULE_NAMES[cron] ?? `${cron} (UTC)`;
}

function destinationLabel(job: BackupJob): string {
  const d = job.destination;
  if (d.type === 's3') return `s3://${d.bucket}${d.prefix ? `/${d.prefix}` : ''}${d.endpoint ? ` @ ${new URL(d.endpoint).host}` : ''}`;
  return d.path || 'Local disk (data folder)';
}

export function DatabasesPage() {
  useDocumentTitle('Databases');
  const toast = useToast();
  const [databases, setDatabases] = useState<BackupJob[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<BackupJob | 'new' | null>(null);
  const [deleting, setDeleting] = useState<BackupJob | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [result, teamResult] = await Promise.all([opsApi.databases.list(), api.teams.list().catch(() => ({ teams: [] as Team[] }))]);
      setDatabases(result.databases);
      setTeams(teamResult.teams);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load databases.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = databases.find((d) => d.id === selected);

  return (
    <div>
      <PageHeader
        title="Databases"
        description="Connect the databases you run to check their health and back them up on a schedule: compressed, encrypted with a key per backup, and verified."
        actions={
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <Plus className="size-3.5" />
            Add database
          </Button>
        }
      />

      {error ? (
        <ErrorPane message={error} retry={load} />
      ) : loading ? (
        <LoadingPane label="Loading databases" />
      ) : current ? (
        <DatabaseDetail database={current} onBack={() => setSelected(null)} onEdit={() => setEditing(current)} onChanged={load} />
      ) : databases.length === 0 ? (
        <EmptyState
          icon={Database}
          title="No databases connected"
          description="Add PostgreSQL, Supabase, MySQL or MariaDB, MongoDB, SQLite or SQL Server. Each one gets scheduled backups and a heartbeat monitor that pages its team if the backups stop."
          action={
            <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
              Add the first database
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] border-collapse text-sm">
            <thead>
              <tr className="border-b surface-2">
                <th className="eyebrow px-3 py-2 pl-4 text-left font-medium sm:pl-6">Database</th>
                <th className="eyebrow px-3 py-2 text-left font-medium">Schedule</th>
                <th className="eyebrow px-3 py-2 text-left font-medium">Last backup</th>
                <th className="eyebrow px-3 py-2 text-left font-medium">Next run</th>
                <th className="eyebrow px-3 py-2 text-left font-medium">Stored in</th>
                <th className="w-10 px-3 py-2 pr-4 sm:pr-6" />
              </tr>
            </thead>
            <tbody>
              {databases.map((db) => (
                <tr key={db.id} className="cursor-pointer border-b hover:bg-[var(--surface-2)]" onClick={() => setSelected(db.id)}>
                  <td className="px-3 py-2 pl-4 sm:pl-6">
                    <p className="font-medium">
                      {db.name}
                      {!db.enabled && <span className="ml-2 text-2xs font-normal text-subtle">paused</span>}
                    </p>
                    <p className="text-2xs text-subtle">
                      {BACKUP_ENGINE_LABELS[db.engine]} · <span className="font-mono">{db.connectionHint}</span>
                    </p>
                  </td>
                  <td className="px-3 py-2 text-xs">{scheduleLabel(db.schedule)}</td>
                  <td className="px-3 py-2 text-xs">
                    {db.lastStatus ? (
                      <span className="flex items-center gap-2 whitespace-nowrap">
                        <Badge color={RUN_COLORS[db.lastStatus]}>{db.lastStatus}</Badge>
                        <span className="text-subtle">{relativeTime(db.lastRunAt)}</span>
                      </span>
                    ) : (
                      <span className="text-subtle">Never</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted">{db.enabled ? shortDateTime(db.nextRunAt) : '—'}</td>
                  <td className="max-w-56 truncate px-3 py-2 font-mono text-2xs text-muted">{destinationLabel(db)}</td>
                  <td className="px-3 py-2 pr-4 sm:pr-6" onClick={(event) => event.stopPropagation()}>
                    <Menu
                      trigger={({ toggle }) => (
                        <Button variant="ghost" size="icon" onClick={toggle} aria-label={`Actions for ${db.name}`}>
                          <MoreHorizontal className="size-4" />
                        </Button>
                      )}
                      items={[
                        { label: 'Open', onSelect: () => setSelected(db.id) },
                        { label: 'Edit', onSelect: () => setEditing(db) },
                        { label: 'Remove', icon: Trash2, destructive: true, onSelect: () => setDeleting(db) },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <DatabaseDialog
          database={editing === 'new' ? null : editing}
          teams={teams}
          onClose={() => setEditing(null)}
          onSaved={async (saved) => {
            setEditing(null);
            await load();
            toast.success(`${saved.name} saved.`, 'A heartbeat monitor now watches its backups.');
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title={`Remove ${deleting?.name ?? ''}?`}
        message="Scheduled backups and the heartbeat monitor stop. Backup files already taken are left where they are."
        confirmLabel="Remove database"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await opsApi.databases.remove(deleting.id);
            setDeleting(null);
            setSelected(null);
            await load();
          } catch (caught) {
            toast.error('Could not remove', caught instanceof ApiError ? caught.message : undefined);
          }
        }}
      />
    </div>
  );
}

function DatabaseDetail({
  database,
  onBack,
  onEdit,
  onChanged,
}: {
  database: BackupJob;
  onBack: () => void;
  onEdit: () => void;
  onChanged: () => Promise<void>;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [runs, setRuns] = useState<BackupRun[] | null>(null);
  const [running, setRunning] = useState(false);
  const [testing, setTesting] = useState(false);

  const loadRuns = useCallback(async () => {
    const result = await opsApi.databases.get(database.id);
    setRuns(result.runs);
  }, [database.id]);

  useEffect(() => {
    void loadRuns().catch(() => setRuns([]));
  }, [loadRuns]);

  const backUpNow = async () => {
    setRunning(true);
    try {
      const { run } = await opsApi.databases.run(database.id);
      if (run.status === 'succeeded') toast.success('Backup complete.', run.sizeBytes ? fileSize(run.sizeBytes) : undefined);
      else toast.error('Backup failed', run.error ?? undefined);
      await Promise.all([loadRuns(), onChanged()]);
    } catch (caught) {
      toast.error('Could not start the backup', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setRunning(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      const { health } = await opsApi.databases.test({ id: database.id });
      if (health.ok) toast.success('Connection healthy', health.message);
      else toast.error('Connection failed', health.message);
    } catch (caught) {
      toast.error('Could not test', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setTesting(false);
    }
  };

  const durationOf = (run: BackupRun) => {
    if (!run.finishedAt) return '—';
    const secs = Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000);
    return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="size-3.5" />
        All databases
      </Button>

      <div className="rounded-md border p-4 surface">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{database.name}</h2>
            <p className="text-xs text-muted">{BACKUP_ENGINE_LABELS[database.engine]}</p>
            <p className="mt-1 break-all font-mono text-2xs text-subtle">{database.connectionHint}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" loading={testing} onClick={testConnection}>
              Test connection
            </Button>
            <Button variant="secondary" size="sm" onClick={onEdit}>
              Edit
            </Button>
            <Button variant="primary" size="sm" loading={running} onClick={backUpNow}>
              <Play className="size-3.5" />
              Back up now
            </Button>
          </div>
        </div>
        <dl className="mt-3 grid gap-2 border-t pt-3 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-subtle">Schedule</dt>
            <dd>{scheduleLabel(database.schedule)}</dd>
          </div>
          <div>
            <dt className="text-subtle">Next run</dt>
            <dd>{database.enabled ? shortDateTime(database.nextRunAt) : 'Paused'}</dd>
          </div>
          <div>
            <dt className="text-subtle">Keeps</dt>
            <dd>
              {database.retention.keepDaily} daily · {database.retention.keepWeekly} weekly · {database.retention.keepMonthly} monthly
            </dd>
          </div>
          <div>
            <dt className="text-subtle">Stored in</dt>
            <dd className="break-all font-mono text-2xs">{destinationLabel(database)}</dd>
          </div>
        </dl>
        <p className="mt-3 flex items-start gap-1.5 text-xs text-muted">
          <HeartPulse className="mt-0.5 size-3.5 shrink-0" />
          A heartbeat monitor ("Backup: {database.name}") expects a successful backup every scheduled period. A failed run, or
          a run that never happens, pages the database's team.
        </p>
      </div>

      <div className="rounded-md border surface">
        <div className="border-b px-4 py-2.5">
          <p className="text-xs font-semibold">Backups</p>
          {can('backups.restore') && (
            <p className="mt-0.5 text-2xs text-subtle">
              Downloads are decrypted and decompressed, ready for pg_restore, mysql or mongorestore. Treat the file like the
              database itself. Every download is recorded in the audit log.
            </p>
          )}
        </div>
        {runs === null ? (
          <LoadingPane />
        ) : runs.length === 0 ? (
          <p className="px-4 py-4 text-xs text-muted">No backups yet. Run one now to check everything works end to end.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] border-collapse text-sm">
              <thead>
                <tr className="border-b surface-2">
                  <th className="eyebrow px-4 py-2 text-left font-medium">Status</th>
                  <th className="eyebrow px-3 py-2 text-left font-medium">Started</th>
                  <th className="eyebrow px-3 py-2 text-left font-medium">Duration</th>
                  <th className="eyebrow px-3 py-2 text-left font-medium">Size</th>
                  <th className="eyebrow px-3 py-2 text-left font-medium">SHA-256</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b last:border-b-0 align-top">
                    <td className="px-4 py-2">
                      <Badge color={RUN_COLORS[run.status]}>{run.status}</Badge>
                      <span className="ml-1.5 text-2xs text-subtle">{run.trigger}</span>
                      {run.error && <p className="mt-1 max-w-sm text-2xs text-[var(--priority-urgent)]">{run.error}</p>}
                    </td>
                    <td className="px-3 py-2 text-xs">{shortDateTime(run.startedAt)}</td>
                    <td className="px-3 py-2 text-xs tabular">{durationOf(run)}</td>
                    <td className="px-3 py-2 text-xs tabular">{run.sizeBytes ? fileSize(run.sizeBytes) : '—'}</td>
                    <td className="px-3 py-2 font-mono text-2xs text-muted" title={run.sha256 ?? undefined}>
                      {run.sha256 ? run.sha256.slice(0, 12) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {run.status === 'succeeded' && can('backups.restore') && (
                        <a
                          href={opsApi.databases.downloadUrl(run.id)}
                          className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline"
                          download
                        >
                          <Download className="size-3.5" />
                          Download
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
