import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BookOpen, ExternalLink, Menu as MenuIcon, Search, X } from 'lucide-react';
import { DOC_PAGES, DOC_SECTIONS, findDoc, searchDocs, type DocPage, type SearchHit } from '@/lib/docs';
import { Markdown } from '@/lib/markdown';
import { Input } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

/**
 * The in-app documentation at /docs and /docs/:slug. Every page is bundled
 * markdown (see lib/docs.ts), so it reads offline and in the portable build.
 */
export function DocsPage() {
  const { slug } = useParams();
  const location = useLocation();
  const [query, setQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const articleRef = useRef<HTMLElement>(null);

  const page = slug ? findDoc(slug) : DOC_PAGES[0];
  const hits = useMemo(() => searchDocs(query), [query]);

  // Land on the heading named in the hash, or the top of a new page.
  useEffect(() => {
    setDrawerOpen(false);
    const id = decodeURIComponent(location.hash.slice(1));
    const target = id ? document.getElementById(id) : null;
    if (target) target.scrollIntoView({ block: 'start' });
    else articleRef.current?.scrollIntoView({ block: 'start' });
  }, [location.pathname, location.hash]);

  if (slug && !page) return <Navigate to="/docs" replace />;
  if (!page) return null;

  const position = DOC_PAGES.indexOf(page);
  const previous = DOC_PAGES[position - 1];
  const next = DOC_PAGES[position + 1];
  const onThisPage = page.headings.filter((heading) => heading.depth === 2 || heading.depth === 3);

  const sidebar = (
    <DocsSidebar
      current={page}
      query={query}
      onQuery={setQuery}
      hits={hits}
      onNavigate={() => {
        setDrawerOpen(false);
      }}
    />
  );

  return (
    <div className="flex min-h-full">
      <aside className="hidden w-64 shrink-0 border-r surface lg:block">
        <div className="sticky top-0 max-h-dvh overflow-y-auto">{sidebar}</div>
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Documentation contents">
          <div className="absolute inset-0 bg-[var(--color-ink-950)]/40" onClick={() => setDrawerOpen(false)} />
          <div className="animate-in relative flex h-full w-[85vw] max-w-80 flex-col border-r surface">
            <button
              onClick={() => setDrawerOpen(false)}
              className="absolute top-3 right-3 rounded-xs p-1 text-[var(--fg-subtle)]"
              aria-label="Close contents"
            >
              <X className="size-4" />
            </button>
            <div className="overflow-y-auto">{sidebar}</div>
          </div>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 border-b px-4 py-2 surface lg:hidden">
          <Button variant="ghost" size="sm" onClick={() => setDrawerOpen(true)}>
            <MenuIcon className="size-3.5" />
            Contents and search
          </Button>
        </div>

        <div className="mx-auto flex max-w-6xl gap-8 px-4 py-6 sm:px-8">
          <article ref={articleRef} className="min-w-0 max-w-3xl flex-1 scroll-mt-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <p className="eyebrow">{page.section}</p>
              {page.app && (
                <Link
                  to={page.app}
                  className="inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs text-[var(--fg-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
                >
                  <ExternalLink className="size-3.5" />
                  Open in app
                </Link>
              )}
            </div>

            <Markdown blocks={page.blocks} />

            <nav className="mt-10 grid gap-3 border-t pt-4 sm:grid-cols-2" aria-label="Previous and next page">
              {previous ? (
                <PagerLink page={previous} direction="previous" />
              ) : (
                <span />
              )}
              {next && <PagerLink page={next} direction="next" />}
            </nav>
          </article>

          {onThisPage.length > 1 && (
            <aside className="hidden w-52 shrink-0 xl:block">
              <div className="sticky top-6">
                <p className="eyebrow mb-2">On this page</p>
                <ul className="space-y-1 border-l text-xs">
                  {onThisPage.map((heading) => (
                    <li key={heading.id}>
                      <a
                        href={`#${heading.id}`}
                        onClick={(event) => {
                          event.preventDefault();
                          document.getElementById(heading.id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                          history.replaceState(null, '', `#${heading.id}`);
                        }}
                        className={cn(
                          'block -ml-px border-l border-transparent py-0.5 text-[var(--fg-muted)] hover:border-[var(--fg-subtle)] hover:text-[var(--fg)]',
                          heading.depth === 3 ? 'pl-5' : 'pl-3',
                        )}
                      >
                        {heading.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

function DocsSidebar({
  current,
  query,
  onQuery,
  hits,
  onNavigate,
}: {
  current: DocPage;
  query: string;
  onQuery: (value: string) => void;
  hits: SearchHit[];
  onNavigate: () => void;
}) {
  const searching = query.trim().length > 1;
  return (
    <div className="p-3">
      <Link to="/docs" onClick={onNavigate} className="mb-3 flex items-center gap-2 px-1 text-sm font-semibold">
        <BookOpen className="size-4 text-[var(--accent)]" />
        Documentation
      </Link>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-[var(--fg-subtle)]" />
        <Input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search the docs"
          aria-label="Search the docs"
          className="pl-7"
        />
      </div>

      {searching ? (
        <div aria-live="polite">
          <p className="mb-2 px-1 text-2xs text-subtle">
            {hits.length ? `${hits.length}${hits.length === 30 ? '+' : ''} results` : 'No results. Try fewer or different words.'}
          </p>
          <ul className="space-y-1">
            {hits.map((hit, n) => (
              <li key={`${hit.page.slug}-${hit.heading?.id ?? ''}-${n}`}>
                <Link
                  to={`/docs/${hit.page.slug}${hit.heading ? `#${hit.heading.id}` : ''}`}
                  onClick={onNavigate}
                  className="block rounded-sm px-2 py-1.5 hover:bg-[var(--surface-2)]"
                >
                  <span className="block text-xs font-medium">
                    <Highlight text={hit.heading?.text ?? hit.page.title} terms={hit.terms} />
                  </span>
                  {hit.heading && <span className="block text-2xs text-subtle">{hit.page.title}</span>}
                  <span className="mt-0.5 line-clamp-3 block text-2xs leading-relaxed text-muted">
                    <Highlight text={hit.snippet} terms={hit.terms} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <nav aria-label="Documentation">
          {DOC_SECTIONS.map((section) => (
            <div key={section.title} className="mb-4">
              <p className="eyebrow mb-1 px-2">{section.title}</p>
              <ul className="space-y-px">
                {section.pages.map((page) => (
                  <li key={page.slug}>
                    <Link
                      to={`/docs/${page.slug}`}
                      onClick={onNavigate}
                      aria-current={page.slug === current.slug ? 'page' : undefined}
                      className={cn(
                        'block rounded-sm px-2 py-1 text-xs transition-colors',
                        page.slug === current.slug
                          ? 'bg-[var(--surface-3)] font-medium text-[var(--fg)]'
                          : 'text-[var(--fg-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]',
                      )}
                    >
                      {page.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      )}
    </div>
  );
}

/** Marks every occurrence of the search terms. Text only, never HTML. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = text.split(new RegExp(`(${escaped.join('|')})`, 'gi'));
  const nodes: ReactNode[] = parts.map((part, n) =>
    n % 2 === 1 ? (
      <mark key={n} className="rounded-[2px] bg-[var(--accent)]/20 px-px text-[var(--fg)]">
        {part}
      </mark>
    ) : (
      part
    ),
  );
  return <>{nodes}</>;
}

function PagerLink({ page, direction }: { page: DocPage; direction: 'previous' | 'next' }) {
  return (
    <Link
      to={`/docs/${page.slug}`}
      className={cn(
        'group rounded-md border px-3 py-2 transition-colors hover:bg-[var(--surface-2)]',
        direction === 'next' && 'text-right sm:col-start-2',
      )}
    >
      <span className={cn('flex items-center gap-1 text-2xs text-subtle', direction === 'next' && 'justify-end')}>
        {direction === 'previous' && <ArrowLeft className="size-3" />}
        {direction === 'previous' ? 'Previous' : 'Next'}
        {direction === 'next' && <ArrowRight className="size-3" />}
      </span>
      <span className="block text-xs font-medium">{page.title}</span>
    </Link>
  );
}
