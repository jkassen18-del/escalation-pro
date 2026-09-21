import { useCallback, useEffect, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { fullDateTime, shortDateTime } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { Badge } from '@/components/ui/Badge';
import type { AuditEntry } from '@shared/types';
import { useDocumentTitle } from '@/state/branding';

const ENTITY_TYPES = ['ticket', 'user', 'team', 'settings', 'integration', 'auth', 'system'];
const PAGE_SIZE = 100;

export function AuditLogPage() {
  useDocumentTitle('Audit log');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [entityType, setEntityType] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.audit.list({
        search: search || undefined,
        entityType: entityType || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setEntries(result.entries);
      setTotal(result.total);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the audit log.');
    } finally {
      setLoading(false);
    }
  }, [search, entityType, offset]);

  useEffect(() => {
    const timer = window.setTimeout(load, 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Every privileged action, recorded with who did it and when. Entries are append-only."
      >
        <div className="mt-3 flex flex-wrap gap-2">
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
            placeholder="Search actions, people, or summaries…"
            className="max-w-xs"
          />
          <Select
            value={entityType}
            onChange={(event) => {
              setEntityType(event.target.value);
              setOffset(0);
            }}
            className="w-auto"
          >
            <option value="">All areas</option>
            {ENTITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </Select>
        </div>
      </PageHeader>

      {error ? (
        <ErrorPane message={error} retry={load} />
      ) : loading ? (
        <LoadingPane label="Loading audit entries" />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="No matching entries"
          description="Audit entries are written whenever someone signs in, changes a ticket, or updates configuration."
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] border-collapse text-sm">
              <thead>
                <tr className="border-b surface-2">
                  <th className="eyebrow px-3 py-2 pl-4 text-left font-medium sm:pl-6">When</th>
                  <th className="eyebrow px-3 py-2 text-left font-medium">Who</th>
                  <th className="eyebrow px-3 py-2 text-left font-medium">Area</th>
                  <th className="eyebrow px-3 py-2 text-left font-medium">What happened</th>
                  <th className="eyebrow px-3 py-2 pr-4 text-left font-medium sm:pr-6">Source</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-b hover:bg-[var(--surface-2)]">
                    <td className="px-3 py-1.5 pl-4 whitespace-nowrap sm:pl-6">
                      <time className="text-xs text-muted" dateTime={entry.createdAt} title={fullDateTime(entry.createdAt)}>
                        {shortDateTime(entry.createdAt)}
                      </time>
                    </td>
                    <td className="px-3 py-1.5 text-xs font-medium">{entry.actorName}</td>
                    <td className="px-3 py-1.5">
                      <Badge dot={false}>{entry.entityType}</Badge>
                    </td>
                    <td className="px-3 py-1.5 text-xs">{entry.summary}</td>
                    <td className="px-3 py-1.5 pr-4 font-mono text-2xs text-subtle sm:pr-6">{entry.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t px-4 py-2.5 sm:px-6">
              <p className="tabular text-xs text-muted">
                {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
