import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, CircleDashed, Database, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { ConfirmDialog } from '@/components/ui/Modal';
import type { DataSourceEngine, DataSourceSummary } from '@shared/types';

/**
 * Connections to databases the company already runs, used to offer real
 * records as options on an intake form.
 *
 * Read-only by construction: the query has to be a single SELECT, it runs in
 * a read-only transaction, and the credential should be a read-only account.
 * That last part is the operator's to get right, so it is said plainly here.
 */

const DEFAULT_PORT: Record<DataSourceEngine, number> = { postgres: 5432, mysql: 3306 };

const BLANK = {
  name: '',
  engine: 'postgres' as DataSourceEngine,
  host: '',
  port: 5432,
  database: '',
  username: '',
  password: '',
  useTls: true,
  lookupQuery: "SELECT id, name FROM customers WHERE name ILIKE '%' || :search || '%' ORDER BY name",
  valueColumn: 'id',
  labelColumn: 'name',
};

export function DataSourcePanel() {
  const toast = useToast();
  const [sources, setSources] = useState<DataSourceSummary[]>([]);
  const [draft, setDraft] = useState<typeof BLANK | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<DataSourceSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.dataSources.list();
      /*
       * This panel only renders for someone who can manage integrations, and
       * the server sends full records to exactly those people. Anything
       * partial means the permission changed underneath us, so it is left out
       * rather than rendered as a row full of blanks.
       */
      setSources(result.dataSources.filter((source): source is DataSourceSummary => source.host !== undefined));
    } catch {
      toast.error('Could not load database connections.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      // An empty password on an edit means "keep the stored one", so it is
      // left out of the payload rather than sent as an empty string.
      const { password, ...rest } = draft;
      const payload = password ? { ...rest, password } : rest;
      if (editingId) await api.dataSources.update(editingId, payload);
      else await api.dataSources.create(payload);
      setDraft(null);
      setEditingId(null);
      await load();
      toast.success('Connection saved. Test it to confirm it works.');
    } catch (error) {
      toast.error('Could not save', error instanceof ApiError ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const test = async (source: DataSourceSummary) => {
    setBusy(true);
    try {
      const result = await api.dataSources.test(source.id);
      if (result.ok) toast.success(result.message);
      else toast.error('Connection failed', result.message);
      await load();
    } catch (error) {
      toast.error('Could not test', error instanceof ApiError ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await api.dataSources.remove(deleting.id);
      setDeleting(null);
      await load();
      toast.success('Connection removed.');
    } catch (error) {
      toast.error('Could not remove', error instanceof ApiError ? error.message : undefined);
    }
  };

  const set = <K extends keyof typeof BLANK>(key: K, value: (typeof BLANK)[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  return (
    <section className="rounded-md border surface">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border surface-2">
            <Database className="size-4 text-[var(--fg-subtle)]" aria-hidden />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Connected databases</h2>
            <p className="mt-0.5 text-xs text-muted">
              Read records from a database you already run, and offer them as options on an intake form.
            </p>
          </div>
        </div>
        {!draft && (
          <Button
            size="sm"
            onClick={() => {
              setEditingId(null);
              setDraft({ ...BLANK });
            }}
          >
            <Plus className="size-3.5" aria-hidden />
            Add connection
          </Button>
        )}
      </header>

      <div className="space-y-3 p-4">
        {sources.length === 0 && !draft && (
          <p className="text-xs text-subtle">No databases connected yet.</p>
        )}

        {sources.map((source) => {
          const StatusIcon =
            source.status === 'ok' ? CheckCircle2 : source.status === 'error' ? CircleAlert : CircleDashed;
          const color =
            source.status === 'ok'
              ? 'var(--status-resolved)'
              : source.status === 'error'
                ? 'var(--priority-urgent)'
                : 'var(--fg-subtle)';

          return (
            <div key={source.id} className="rounded-sm border p-3 surface-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold">{source.name}</span>
                    <span className="inline-flex items-center gap-1 text-2xs" style={{ color }}>
                      <StatusIcon className="size-3" aria-hidden />
                      {source.status === 'ok' ? 'Working' : source.status === 'error' ? 'Failing' : 'Not tested'}
                    </span>
                  </div>
                  <p className="mt-0.5 font-mono text-2xs text-subtle">
                    {source.engine} · {source.host}:{source.port}/{source.database} · {source.username || 'no user'}
                  </p>
                  {source.statusMessage && (
                    <p className="mt-1 text-2xs text-muted">{source.statusMessage}</p>
                  )}
                </div>

                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void test(source)}>
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingId(source.id);
                      setDraft({
                        ...BLANK,
                        ...source,
                        // Never populated from the server; typing a new one replaces it.
                        password: '',
                      });
                    }}
                  >
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(source)}>
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}

        {draft && (
          <div className="space-y-3 rounded-sm border p-3 surface-2">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" required>
                <Input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Customer CRM" />
              </Field>
              <Field label="Engine">
                <Select
                  value={draft.engine}
                  onChange={(e) => {
                    const engine = e.target.value as DataSourceEngine;
                    setDraft((current) => (current ? { ...current, engine, port: DEFAULT_PORT[engine] } : current));
                  }}
                >
                  <option value="postgres">PostgreSQL</option>
                  <option value="mysql">MySQL / MariaDB</option>
                </Select>
              </Field>
              <Field label="Host" required>
                <Input value={draft.host} onChange={(e) => set('host', e.target.value)} placeholder="db.internal" />
              </Field>
              <Field label="Port">
                <Input
                  type="number"
                  value={draft.port}
                  onChange={(e) => set('port', Number(e.target.value))}
                />
              </Field>
              <Field label="Database" required>
                <Input value={draft.database} onChange={(e) => set('database', e.target.value)} />
              </Field>
              <Field label="Username" hint="Use an account with SELECT and nothing else.">
                <Input value={draft.username} onChange={(e) => set('username', e.target.value)} />
              </Field>
              <Field
                label="Password"
                hint={editingId ? 'Leave blank to keep the stored password.' : 'Stored encrypted; never shown again.'}
              >
                <Input
                  type="password"
                  value={draft.password}
                  autoComplete="new-password"
                  onChange={(e) => set('password', e.target.value)}
                />
              </Field>
              <div className="flex items-end pb-1.5">
                <Checkbox
                  checked={draft.useTls}
                  label="Encrypt the connection"
                  onChange={(e) => set('useTls', e.target.checked)}
                />
              </div>
            </div>

            <Field
              label="Lookup query"
              required
              hint="A single SELECT. Put :search where the typed text should go — it is always sent as a parameter, never pasted into the query."
            >
              <Textarea
                rows={3}
                value={draft.lookupQuery}
                onChange={(e) => set('lookupQuery', e.target.value)}
                className="font-mono text-xs"
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Value column" hint="Stored on the ticket.">
                <Input value={draft.valueColumn} onChange={(e) => set('valueColumn', e.target.value)} />
              </Field>
              <Field label="Label column" hint="Shown in the picker.">
                <Input value={draft.labelColumn} onChange={(e) => set('labelColumn', e.target.value)} />
              </Field>
            </div>

            <div className="flex gap-2">
              <Button size="sm" variant="primary" loading={busy} onClick={save}>
                Save connection
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(null);
                  setEditingId(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Remove this connection?"
        message={`Form fields using "${deleting?.name}" will fall back to plain text. Tickets keep the answers already recorded.`}
        destructive
        confirmLabel="Remove"
        onConfirm={remove}
        onClose={() => setDeleting(null)}
      />
    </section>
  );
}
