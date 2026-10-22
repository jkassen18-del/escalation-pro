import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, BellRing, CheckCircle2, Circle, Database, PhoneCall, Siren, TriangleAlert } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { opsApi, type OpsOverview } from '@/lib/ops-api';
import { relativeTime, shortDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { MaintenanceBadge } from '@/components/ops/MaintenanceShared';
import { useToast } from '@/components/ui/Toast';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { SeverityBadge } from '@/components/ops/IncidentPanel';
import { useDocumentTitle } from '@/state/branding';
import type { Page } from '@shared/ops';

const POLL_MS = 15_000;

/**
 * The command centre: what is paging me, what is down, who is on call.
 * Polls, because an incident view that has to be refreshed by hand is one
 * nobody trusts at three in the morning.
 */
export function OperationsPage() {
  useDocumentTitle('Command centre');
  const toast = useToast();
  const [overview, setOverview] = useState<OpsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acking, setAcking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await opsApi.overview());
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the command centre.');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const acknowledge = async (page: Page) => {
    setAcking(page.id);
    try {
      await opsApi.pages.ack(page.id);
      toast.success(`Acknowledged ${page.ticketReference ?? 'the page'}`, 'Escalation stopped and the incident is yours.');
      await load();
    } catch (caught) {
      toast.error('Could not acknowledge', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setAcking(null);
    }
  };

  if (!overview) return error ? <ErrorPane message={error} retry={load} /> : <LoadingPane label="Loading the command centre" />;

  const fresh =
    overview.monitors.total === 0 && overview.onCall.length === 0 && overview.backups.total === 0 && overview.openAlerts.length === 0;
  const othersPaging = overview.activePages.filter((page) => !overview.myPages.some((mine) => mine.id === page.id));

  return (
    <div>
      <PageHeader title="Command centre" description="What is paging you, what is down, and who is on call. Refreshes every 15 seconds." />

      <div className="space-y-4 p-4 sm:p-6">
        {overview.myPages.length > 0 && (
          <section className="rounded-md border-2 border-[var(--priority-urgent)] bg-[var(--priority-urgent)]/8 p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--priority-urgent)]">
              <BellRing className="size-4 animate-pulse" />
              You are being paged
            </h2>
            <ul className="mt-3 space-y-2">
              {overview.myPages.map((page) => (
                <li key={page.id} className="flex flex-col gap-3 rounded-sm border p-3 surface sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={page.severity} />
                      <Link to={`/tickets/${page.ticketId}`} className="font-mono text-xs text-[var(--accent)] hover:underline">
                        {page.ticketReference}
                      </Link>
                    </div>
                    <p className="mt-1 text-sm font-medium break-words">{page.ticketSubject}</p>
                    <p className="mt-0.5 text-2xs text-subtle">
                      {page.policyName} · level {page.currentLevel + 1} · started {relativeTime(page.createdAt)}
                    </p>
                  </div>
                  <Button variant="danger" size="lg" className="w-full sm:w-auto" loading={acking === page.id} onClick={() => acknowledge(page)}>
                    Acknowledge
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {fresh ? (
          <GettingStarted />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile
                to="/monitors"
                icon={Activity}
                label="Monitors down"
                value={overview.monitors.down}
                sub={`${overview.monitors.up} of ${overview.monitors.total} up`}
                alarm={overview.monitors.down > 0}
              />
              <Tile to="/monitors" icon={TriangleAlert} label="Open alerts" value={overview.openAlerts.length} alarm={overview.openAlerts.length > 0} />
              <Tile
                to="/oncall"
                icon={Siren}
                label="Active pages"
                value={overview.activePages.length}
                sub={othersPaging.length ? `${othersPaging.length} paging others` : undefined}
                alarm={overview.activePages.length > 0}
              />
              <Tile
                to="/databases"
                icon={Database}
                label="Failing backups"
                value={overview.backups.failing}
                sub={`${overview.backups.total} databases`}
                alarm={overview.backups.failing > 0}
              />
            </div>

            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <section className="min-w-0 rounded-md border surface">
                <h2 className="border-b px-4 py-2.5 text-xs font-semibold">Open alerts</h2>
                {overview.openAlerts.length === 0 ? (
                  <p className="flex items-center gap-2 px-4 py-6 text-xs text-muted">
                    <CheckCircle2 className="size-4 text-[var(--status-resolved)]" />
                    Nothing is firing.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[34rem] text-xs">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="eyebrow px-4 py-2 font-medium">Severity</th>
                          <th className="eyebrow px-2 py-2 font-medium">Alert</th>
                          <th className="eyebrow px-2 py-2 font-medium">Count</th>
                          <th className="eyebrow px-2 py-2 font-medium">Last seen</th>
                          <th className="eyebrow px-4 py-2 font-medium">Incident</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.openAlerts.map((alert) => (
                          <tr key={alert.id} className="border-b last:border-0">
                            <td className="px-4 py-2">
                              <SeverityBadge severity={alert.severity} />
                            </td>
                            <td className="px-2 py-2">
                              <p className="font-medium">{alert.title}</p>
                              <p className="text-2xs text-subtle">
                                {alert.sourceName}
                                {alert.suppressed ? ' · not paging' : ''}
                              </p>
                            </td>
                            <td className="px-2 py-2 tabular-nums">{alert.count}</td>
                            <td className="px-2 py-2 whitespace-nowrap text-muted">{relativeTime(alert.lastSeenAt)}</td>
                            <td className="px-4 py-2">
                              {alert.ticketId ? (
                                <Link to={`/tickets/${alert.ticketId}`} className="font-mono text-[var(--accent)] hover:underline">
                                  {alert.ticketReference}
                                </Link>
                              ) : (
                                '—'
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <div className="space-y-4">
              {overview.inMaintenance.length > 0 && (
                <section className="rounded-md border surface">
                  <div className="flex items-center justify-between border-b px-4 py-2.5">
                    <h2 className="text-xs font-semibold">In maintenance</h2>
                    <Link to="/maintenance" className="text-2xs text-[var(--accent)] hover:underline">
                      Maintenance
                    </Link>
                  </div>
                  <ul className="divide-y">
                    {overview.inMaintenance.map((entry) => (
                      <li key={entry.monitorId} className="flex items-center justify-between gap-2 px-4 py-2">
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-medium">{entry.name}</span>
                          <span className="block truncate text-2xs text-subtle">{entry.title}</span>
                        </span>
                        <MaintenanceBadge maintenance={entry} />
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <section className="rounded-md border surface">
                <div className="flex items-center justify-between border-b px-4 py-2.5">
                  <h2 className="text-xs font-semibold">On call now</h2>
                  <Link to="/oncall" className="text-2xs text-[var(--accent)] hover:underline">
                    Schedules
                  </Link>
                </div>
                {overview.onCall.length === 0 ? (
                  <p className="px-4 py-6 text-xs text-muted">
                    No schedules yet. <Link to="/oncall" className="text-[var(--accent)] hover:underline">Create one</Link>.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {overview.onCall.map((entry) => (
                      <li key={entry.scheduleId} className="px-4 py-2.5">
                        <p className="text-2xs text-subtle">
                          {entry.scheduleName}
                          {entry.teamName ? ` · ${entry.teamName}` : ''}
                        </p>
                        <p className={cn('text-xs font-medium', !entry.userName && 'text-[var(--priority-high)]')}>
                          <PhoneCall className="mr-1 inline size-3" />
                          {entry.userName ?? 'Nobody on call'}
                        </p>
                        {entry.until && <p className="text-2xs text-subtle">until {shortDateTime(entry.until)}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Tile({
  to,
  icon: Icon,
  label,
  value,
  sub,
  alarm,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  sub?: string;
  alarm?: boolean;
}) {
  return (
    <Link
      to={to}
      className={cn(
        'rounded-md border p-3 surface transition-colors hover:bg-[var(--surface-2)]',
        alarm && 'border-[var(--priority-urgent)]/45',
      )}
    >
      <p className="flex items-center gap-1.5 text-2xs text-subtle">
        <Icon className="size-3.5" />
        {label}
      </p>
      <p className={cn('mt-1 text-2xl font-semibold tabular-nums', alarm && 'text-[var(--priority-urgent)]')}>{value}</p>
      {sub && <p className="text-2xs text-subtle">{sub}</p>}
    </Link>
  );
}

const STEPS: Array<{ to: string; title: string; detail: string }> = [
  { to: '/monitors', title: 'Watch something', detail: 'Add an HTTP, TCP, SSL or heartbeat monitor, or an alert source for AWS, Azure, Grafana or Jenkins.' },
  { to: '/oncall', title: 'Set up on-call', detail: 'Create a rotation and an escalation policy, then make it your team’s default.' },
  { to: '/profile', title: 'Make sure you can be woken', detail: 'Add your mobile number and notification rules, then send yourself a test page.' },
  { to: '/integrations?setup=slack', title: 'Connect your chat tools', detail: 'Add InfraTicket to Slack in a few clicks; Microsoft Teams, Discord and Linear are in the same catalogue.' },
  { to: '/integrations?setup=source:generic', title: 'Send alerts from your tools', detail: 'AWS, Azure, Grafana, Jenkins, Cloudflare or any webhook: create a source and paste its URL.' },
  { to: '/status-pages', title: 'Publish a status page', detail: 'Internal or public, fed by your monitors.' },
  { to: '/databases', title: 'Back up a database', detail: 'Scheduled, encrypted backups of Postgres, MySQL, MongoDB, SQLite or SQL Server.' },
];

function GettingStarted() {
  return (
    <section className="max-w-2xl rounded-md border surface">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Get to your first page in 15 minutes</h2>
        <p className="mt-0.5 text-xs text-muted">Nothing is being watched yet. Work down this list; each step takes a couple of minutes.</p>
      </div>
      <ol className="divide-y">
        {STEPS.map((step, index) => (
          <li key={step.to}>
            <Link to={step.to} className="flex gap-3 px-4 py-3 hover:bg-[var(--surface-2)]">
              <Circle className="mt-0.5 size-4 shrink-0 text-[var(--fg-subtle)]" />
              <span className="min-w-0">
                <span className="block text-xs font-medium">
                  {index + 1}. {step.title}
                </span>
                <span className="block text-xs text-muted">{step.detail}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
