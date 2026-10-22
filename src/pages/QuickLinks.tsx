import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Link2 } from 'lucide-react';
import { teamLinksApi } from '@/lib/sso-api';
import { useAuth } from '@/state/auth';
import { useDocumentTitle } from '@/state/branding';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { TeamLinkIcon } from '@/components/TeamLinkIcon';
import type { TeamLink } from '@shared/sso';

/** The consoles and portals each of your teams works in, one click away. */
export function QuickLinksPage() {
  useDocumentTitle('Quick links');
  const { can } = useAuth();
  const [links, setLinks] = useState<TeamLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    void teamLinksApi
      .mine()
      .then((result) => setLinks(result.links))
      .catch(() => setError('Could not load your links.'));
  };
  useEffect(load, []);

  const groups = new Map<string, TeamLink[]>();
  for (const link of links ?? []) {
    const key = link.teamName ?? 'Team';
    groups.set(key, [...(groups.get(key) ?? []), link]);
  }

  return (
    <div>
      <PageHeader title="Quick links" description="The AWS, Azure, Entra ID and other consoles your teams work in." />
      <div className="space-y-5 px-6 py-5">
        {error ? (
          <ErrorPane message={error} retry={load} />
        ) : links === null ? (
          <LoadingPane label="Loading links" />
        ) : links.length === 0 ? (
          <EmptyState
            icon={Link2}
            title="No links yet"
            description={
              can('teams.links')
                ? 'Open a team under Teams and add links to the systems it works in.'
                : 'Your teams have no links yet. Ask a team manager to add them.'
            }
            action={
              can('teams.links') ? (
                <Link to="/teams" className="text-xs text-[var(--accent)] underline-offset-2 hover:underline">
                  Go to Teams
                </Link>
              ) : undefined
            }
          />
        ) : (
          [...groups.entries()].map(([team, items]) => (
            <section key={team}>
              <p className="eyebrow mb-2">{team}</p>
              <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((link) => (
                  <a
                    key={link.id}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-start gap-3 rounded-md border p-3.5 surface transition-colors hover:border-[var(--border-strong)]"
                  >
                    <TeamLinkIcon kind={link.icon} className="size-8" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1 text-xs font-medium">
                        <span className="truncate">{link.name}</span>
                        <ArrowUpRight className="size-3 shrink-0 text-[var(--fg-subtle)] transition-transform group-hover:-translate-y-px group-hover:translate-x-px" />
                      </span>
                      {link.description && <span className="mt-0.5 block text-xs text-subtle">{link.description}</span>}
                      <span className="mt-1 block truncate font-mono text-2xs text-subtle">{new URL(link.url).host}</span>
                    </span>
                  </a>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
