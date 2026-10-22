import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { opsApi } from '@/lib/ops-api';
import { fullDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { NOTIFY_CHANNEL_LABELS, type NotificationAttempt, type Page } from '@shared/ops';

const ATTEMPT_COLORS: Record<NotificationAttempt['status'], string> = {
  sent: 'var(--status-open)',
  simulated: 'var(--status-pending)',
  failed: 'var(--priority-urgent)',
  skipped: 'var(--status-closed)',
  answered: 'var(--status-progress)',
  missed: 'var(--priority-high)',
  acknowledged: 'var(--status-resolved)',
};

/** "Why did this page me?": the routing reason, the policy, and every attempt made. */
export function PageExplainer({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    opsApi.pages
      .get(pageId)
      .then((result) => setPage(result.page))
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'Could not load the page.'));
  }, [pageId]);

  return (
    <Modal open onClose={onClose} title="Why did this page me?" description={page?.ticketReference ?? undefined} size="lg">
      {error ? (
        <ErrorPane message={error} />
      ) : !page ? (
        <LoadingPane />
      ) : (
        <div className="space-y-5">
          <section>
            <p className="eyebrow mb-1.5">Routing</p>
            <p className="text-sm leading-relaxed">{page.reason || 'Paged by hand.'}</p>
          </section>

          <section>
            <p className="eyebrow mb-1.5">{page.policy ? `Policy: ${page.policy.name}` : 'Policy'}</p>
            {page.policy ? (
              <ol className="space-y-1.5">
                {page.policy.levels.map((level, index) => {
                  const current = index === page.currentLevel && page.status === 'triggered';
                  return (
                    <li
                      key={level.id}
                      className={cn(
                        'flex flex-wrap items-center gap-2 rounded-sm border px-3 py-2 text-xs',
                        current ? 'border-[var(--priority-urgent)]/50 bg-[var(--priority-urgent)]/5' : 'surface-2',
                      )}
                    >
                      <span className="font-medium">Level {index + 1}</span>
                      <span className="text-muted">{level.targets.map((t) => `${t.name ?? t.id} (${t.type})`).join(', ')}</span>
                      <span className="ml-auto text-subtle">escalates after {level.delayMins} min</span>
                      {current && <Badge color="var(--priority-urgent)">current</Badge>}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="text-xs text-muted">The policy has been deleted.</p>
            )}
            {page.policy && page.policy.repeatCount > 0 && (
              <p className="mt-1.5 text-xs text-subtle">
                Repeats {page.policy.repeatCount} more time{page.policy.repeatCount === 1 ? '' : 's'} if nobody acknowledges.
              </p>
            )}
          </section>

          <section>
            <p className="eyebrow mb-1.5">Attempts</p>
            {page.attempts?.length ? (
              <ol className="space-y-1">
                {page.attempts.map((attempt) => (
                  <li key={attempt.id} className="grid gap-x-3 gap-y-0.5 border-b pb-1.5 text-xs sm:grid-cols-[9rem_1fr_auto]">
                    <span className="tabular text-subtle">{fullDateTime(attempt.createdAt)}</span>
                    <span className="min-w-0">
                      <span className="font-medium">{attempt.userName ?? 'Unknown'}</span> · {NOTIFY_CHANNEL_LABELS[attempt.channel]}
                      {attempt.seq > 0 ? ` #${attempt.seq + 1}` : ''} · L{attempt.level + 1}
                      {attempt.detail && <span className="block truncate text-subtle">{attempt.detail}</span>}
                    </span>
                    <span className="flex items-start gap-1.5">
                      <span className="text-2xs text-subtle">{attempt.provider}</span>
                      <Badge color={ATTEMPT_COLORS[attempt.status]}>{attempt.status}</Badge>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs text-muted">No notifications have gone out yet.</p>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
