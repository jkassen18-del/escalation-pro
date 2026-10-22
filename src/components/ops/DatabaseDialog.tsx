import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { opsApi, type DatabaseInput } from '@/lib/ops-api';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, SegmentedControl, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { BACKUP_ENGINES, BACKUP_ENGINE_LABELS, type BackupEngine, type BackupJob, type DatabaseHealth } from '@shared/ops';
import type { Team } from '@shared/types';

const PLACEHOLDERS: Record<BackupEngine, string> = {
  postgres: 'postgres://backup:password@db.internal:5432/app',
  supabase: 'postgresql://postgres:password@db.<project>.supabase.co:5432/postgres',
  mysql: 'mysql://backup:password@db.internal:3306/app',
  mongodb: 'mongodb://backup:password@mongo.internal:27017/app?authSource=admin',
  sqlite: 'C:\\data\\app.db  or  /var/lib/app/app.db',
  sqlserver: 'Server=sql.internal,1433;Database=App;User Id=backup;Password=password',
};

const CONNECTION_HINTS: Partial<Record<BackupEngine, string>> = {
  supabase: 'Use the direct connection on port 5432 (Project settings → Database), not the pooler on 6543.',
  sqlite: 'A file path on this server. The online backup is safe while the database is in use.',
  sqlserver: 'BACKUP DATABASE writes on the SQL Server host; set SQLSERVER_BACKUP_DIR to a folder both machines can reach.',
  mongodb: 'Needs mongodump on this server (or BACKUP_TOOLS_DIR).',
};

/** Least-privilege roles, so a leaked connection cannot write or drop anything. */
const ROLE_SQL: Partial<Record<BackupEngine, string>> = {
  postgres: `CREATE ROLE backup LOGIN PASSWORD '…';
GRANT pg_read_all_data TO backup;  -- PostgreSQL 14+`,
  supabase: `CREATE ROLE backup LOGIN PASSWORD '…';
GRANT pg_read_all_data TO backup;`,
  mysql: `CREATE USER 'backup'@'%' IDENTIFIED BY '…';
GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES, PROCESS ON *.* TO 'backup'@'%';`,
};

const PRESETS = [
  { value: '0 * * * *', label: 'Hourly' },
  { value: '0 1 * * *', label: 'Nightly' },
  { value: '0 2 * * 0', label: 'Weekly' },
  { value: 'custom', label: 'Custom' },
] as const;

export function DatabaseDialog({
  database,
  teams,
  onClose,
  onSaved,
}: {
  database: BackupJob | null;
  teams: Team[];
  onClose: () => void;
  onSaved: (saved: BackupJob) => Promise<void>;
}) {
  const toast = useToast();
  const [form, setForm] = useState<DatabaseInput>({
    name: database?.name ?? '',
    engine: database?.engine ?? 'postgres',
    connection: '',
    schedule: database?.schedule ?? '0 1 * * *',
    retention: database?.retention ?? { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 },
    destination: database?.destination ?? { type: 'local' },
    enabled: database?.enabled ?? true,
    teamId: database?.teamId ?? null,
  });
  const [preset, setPreset] = useState<string>(PRESETS.some((p) => p.value === form.schedule) ? form.schedule : 'custom');
  const [health, setHealth] = useState<DatabaseHealth | null>(null);
  const [testing, setTesting] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const set = (patch: Partial<DatabaseInput>) => setForm((current) => ({ ...current, ...patch }));
  const setDest = (patch: Partial<DatabaseInput['destination']>) => setForm((current) => ({ ...current, destination: { ...current.destination, ...patch } }));
  const dest = form.destination;

  const test = async () => {
    setTesting(true);
    setHealth(null);
    try {
      const result = form.connection
        ? await opsApi.databases.test({ engine: form.engine, connection: form.connection })
        : await opsApi.databases.test({ id: database!.id });
      setHealth(result.health);
    } catch (caught) {
      toast.error('Could not test', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setTesting(false);
    }
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const input: DatabaseInput = { ...form, connection: form.connection || undefined };
      const result = database ? await opsApi.databases.update(database.id, input) : await opsApi.databases.create(input);
      await onSaved(result.database);
    } catch (caught) {
      toast.error('Could not save', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  const keep = (key: keyof DatabaseInput['retention'], label: string) => (
    <Field label={label}>
      <Input
        type="number"
        min={0}
        max={365}
        value={form.retention[key]}
        onChange={(event) => set({ retention: { ...form.retention, [key]: Number(event.target.value) } })}
      />
    </Field>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={database ? `Edit ${database.name}` : 'Add a database'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={submitting}
            disabled={!form.name.trim() || (!database && !form.connection?.trim())}
            onClick={submit}
          >
            {database ? 'Save changes' : 'Add database'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_16rem]">
          <Field label="Name" required>
            <Input value={form.name} onChange={(event) => set({ name: event.target.value })} placeholder="Billing production" autoFocus />
          </Field>
          <Field label="Engine">
            <Select
              value={form.engine}
              onChange={(event) => {
                set({ engine: event.target.value as BackupEngine });
                setHealth(null);
              }}
            >
              {BACKUP_ENGINES.map((engine) => (
                <option key={engine} value={engine}>
                  {BACKUP_ENGINE_LABELS[engine]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label={form.engine === 'sqlite' ? 'File path' : 'Connection'}
          required={!database}
          hint={database ? `Saved: ${database.connectionHint}. Leave blank to keep it.` : CONNECTION_HINTS[form.engine] ?? 'Stored encrypted; never shown again after saving.'}
        >
          <div className="flex gap-2">
            <Input
              type={form.engine === 'sqlite' ? 'text' : 'password'}
              value={form.connection ?? ''}
              onChange={(event) => {
                set({ connection: event.target.value });
                setHealth(null);
              }}
              placeholder={PLACEHOLDERS[form.engine]}
              autoComplete="off"
              className="font-mono text-xs"
            />
            <Button variant="secondary" loading={testing} disabled={!form.connection && !database} onClick={test}>
              Test
            </Button>
          </div>
        </Field>

        {health && (
          <div
            className={cn(
              'rounded-sm border px-3 py-2 text-xs',
              health.ok ? 'border-[var(--status-resolved)]/40 bg-[var(--status-resolved)]/5' : 'border-[var(--priority-urgent)]/40 bg-[var(--priority-urgent)]/5',
            )}
          >
            <p className="font-medium" style={{ color: health.ok ? 'var(--status-resolved)' : 'var(--priority-urgent)' }}>
              {health.ok ? 'Healthy' : 'Not reachable'}: {health.message}
            </p>
            {Object.keys(health.details).length > 0 && (
              <dl className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                {Object.entries(health.details).map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-2">
                    <dt className="text-subtle">{key}</dt>
                    <dd className="truncate font-mono text-2xs">{value === null ? '—' : String(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}

        {ROLE_SQL[form.engine] && (
          <details className="rounded-sm border px-3 py-2 text-xs surface-2">
            <summary className="cursor-pointer font-medium">Use a read-only backup account</summary>
            <p className="mt-1.5 text-muted">Backups only need to read. Create a dedicated account and use it here:</p>
            <pre className="mt-1.5 overflow-x-auto rounded-[3px] border p-2 font-mono text-2xs surface">{ROLE_SQL[form.engine]}</pre>
          </details>
        )}

        <div className="space-y-2">
          <p className="text-xs font-medium">Schedule</p>
          <SegmentedControl
            value={preset}
            onChange={(value) => {
              setPreset(value);
              if (value !== 'custom') set({ schedule: value });
            }}
            options={PRESETS.map((p) => ({ value: p.value, label: p.label }))}
          />
          {preset === 'custom' && (
            <Input value={form.schedule} onChange={(event) => set({ schedule: event.target.value })} placeholder="30 3 * * 1-5" className="max-w-48 font-mono" />
          )}
          <p className="text-xs text-subtle">
            Cron: minute hour day month weekday, in UTC (South Africa is UTC+2). Currently <span className="font-mono">{form.schedule}</span>.
          </p>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium">Keep</p>
          <div className="grid grid-cols-3 gap-3">
            {keep('keepDaily', 'Daily')}
            {keep('keepWeekly', 'Weekly')}
            {keep('keepMonthly', 'Monthly')}
          </div>
          <p className="mt-1 text-xs text-subtle">The newest backup of each day, week and month is kept; the rest are pruned after each run.</p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium">Store backups in</p>
          <SegmentedControl
            value={dest.type}
            onChange={(type) => set({ destination: type === 'local' ? { type: 'local', path: '' } : { type: 's3', region: 'auto', prefix: 'infraticket-backups' } })}
            options={[
              { value: 'local', label: 'This server' },
              { value: 's3', label: 'S3-compatible storage' },
            ]}
          />
          {dest.type === 'local' ? (
            <Field hint="Leave blank for the backups folder inside the data folder.">
              <Input value={dest.path ?? ''} onChange={(event) => setDest({ path: event.target.value })} placeholder="D:\Backups\InfraTicket" />
            </Field>
          ) : (
            <div className="space-y-3 rounded-md border p-3 surface-2">
              <Field
                label="Endpoint"
                hint="Blank for AWS S3. R2: https://<account>.r2.cloudflarestorage.com · Spaces: https://<region>.digitaloceanspaces.com · MinIO: http://minio:9000"
              >
                <Input value={dest.endpoint ?? ''} onChange={(event) => setDest({ endpoint: event.target.value })} placeholder="https://…" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Region">
                  <Input value={dest.region ?? ''} onChange={(event) => setDest({ region: event.target.value })} placeholder="af-south-1" />
                </Field>
                <Field label="Bucket" required>
                  <Input value={dest.bucket ?? ''} onChange={(event) => setDest({ bucket: event.target.value })} />
                </Field>
                <Field label="Prefix">
                  <Input value={dest.prefix ?? ''} onChange={(event) => setDest({ prefix: event.target.value })} />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Access key ID" required>
                  <Input value={dest.accessKeyId ?? ''} onChange={(event) => setDest({ accessKeyId: event.target.value })} className="font-mono" />
                </Field>
                <Field label="Secret access key" hint={dest.hasSecret ? 'Saved. Leave blank to keep it.' : 'Stored encrypted.'}>
                  <Input
                    type="password"
                    value={dest.secretAccessKey ?? ''}
                    onChange={(event) => setDest({ secretAccessKey: event.target.value })}
                    placeholder={dest.hasSecret ? '••••••••' : ''}
                    autoComplete="off"
                  />
                </Field>
              </div>
            </div>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Team" hint="Paged by the heartbeat monitor if backups stop.">
            <Select value={form.teamId ?? ''} onChange={(event) => set({ teamId: event.target.value || null })}>
              <option value="">No team</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end pb-1.5">
            <Checkbox checked={form.enabled} onChange={(event) => set({ enabled: event.target.checked })} label="Run on schedule" />
          </div>
        </div>
      </div>
    </Modal>
  );
}
