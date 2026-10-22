import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Cloud,
  CloudCog,
  Code2,
  Database,
  Droplet,
  Hammer,
  HeartPulse,
  KeyRound,
  ChartLine,
  MessagesSquare,
  Search,
  Server,
  Shield,
  TextSearch,
  Webhook,
} from 'lucide-react';
import { EmailIcon, LinearIcon, MicrosoftIcon, SlackIcon, TeamsIcon } from '@/components/BrandIcons';
import { DiscordIntegrationPanel } from '@/components/DiscordIntegrationPanel';
import { Input } from '@/components/ui/Field';
import { cn } from '@/lib/utils';
import type { CatalogueStatus } from '@shared/types';
import { GROUPS, TILES, type CatalogueTile } from './catalogue';
import { SetupDrawer, StatusLine } from './SetupDrawer';
import { DeveloperSetup, SlackSetup, SourceSetup, TeamsSetup } from './Setups';

const neutral = 'size-4 text-[var(--fg-subtle)]';

/** Simple marks: brand icons where the app already has them, neutral symbols otherwise. */
function TileIcon({ tile, className }: { tile: CatalogueTile; className?: string }): ReactNode {
  const cls = cn(neutral, className);
  switch (tile.id) {
    case 'slack':
      return <SlackIcon className={cls} />;
    case 'msteams':
      return <TeamsIcon className={cls} />;
    case 'linear':
      return <LinearIcon className={cls} />;
    case 'email':
      return <EmailIcon className={cls} />;
    case 'discord':
      return <MessagesSquare className={cls} />;
    case 'source:aws_sns':
      return <Cloud className={cls} />;
    case 'source:azure_monitor':
      return <CloudCog className={cls} />;
    case 'source:grafana':
      return <ChartLine className={cls} />;
    case 'source:jenkins':
      return <Hammer className={cls} />;
    case 'source:cloudflare':
      return <Shield className={cls} />;
    case 'source:digitalocean':
      return <Droplet className={cls} />;
    case 'source:entra_id':
      return <KeyRound className={cls} />;
    case 'source:stratigix':
      return <Server className={cls} />;
    case 'source:generic':
      return <Webhook className={cls} />;
    case 'custom_http':
      return <Code2 className={cls} />;
    case 'heartbeats':
      return <HeartPulse className={cls} />;
    case 'databases':
      return <Database className={cls} />;
    case 'lookups':
      return <TextSearch className={cls} />;
    case 'sso':
      return <MicrosoftIcon className={cls} />;
    default:
      return <Webhook className={cls} />;
  }
}

/**
 * The catalogue: every integration as a tile with its live status. A tile
 * opens a guided setup in a side drawer; `?setup=<id>` opens one directly.
 */
export function IntegrationCatalogue({
  status,
  renderCard,
  onChanged,
}: {
  status: Record<string, CatalogueStatus>;
  /** The existing configuration form for a chat provider, reused inside its drawer. */
  renderCard: (provider: string) => ReactNode;
  onChanged: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const openId = params.get('setup');
  const open = TILES.find((tile) => tile.id === openId) ?? null;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return TILES;
    return TILES.filter((tile) => `${tile.name} ${tile.blurb} ${tile.keywords ?? ''}`.toLowerCase().includes(needle));
  }, [query]);

  const openTile = (id: string) => setParams({ setup: id });
  // Closing drops the result parameters an OAuth round trip left behind too.
  const close = () => {
    setParams({});
    onChanged();
  };

  const connected = TILES.filter((t) => status[t.id]?.state === 'connected').length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--fg-subtle)]" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search integrations…" className="pl-8" aria-label="Search integrations" />
        </div>
        <p className="text-xs text-subtle">
          {connected} of {TILES.length} connected · all free to use
        </p>
      </div>

      {GROUPS.map((group) => {
        const tiles = filtered.filter((tile) => tile.group === group.id);
        if (!tiles.length) return null;
        return (
          <section key={group.id}>
            <div className="mb-2.5">
              <h2 className="text-sm font-semibold">{group.label}</h2>
              <p className="text-xs text-muted">{group.hint}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {tiles.map((tile) => (
                <button
                  key={tile.id}
                  type="button"
                  onClick={() => openTile(tile.id)}
                  className={cn(
                    'flex min-w-0 gap-3 rounded-md border p-3.5 text-left surface transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]',
                    status[tile.id]?.state === 'attention' && 'border-[var(--priority-high)]/40',
                  )}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md border surface-2">
                    <TileIcon tile={tile} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{tile.name}</span>
                    <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-muted">{tile.blurb}</span>
                    <StatusLine status={status[tile.id]} className="mt-1.5 max-w-full" />
                  </span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
      {!filtered.length && <p className="py-10 text-center text-xs text-subtle">Nothing matches “{query}”.</p>}

      {open && (
        <SetupDrawer title={open.name} icon={<TileIcon tile={open} className="size-4" />} status={status[open.id]} onClose={close}>
          {open.id === 'slack' ? (
            <SlackSetup result={params} card={renderCard('slack')} onChanged={onChanged} />
          ) : open.id === 'msteams' ? (
            <TeamsSetup result={params} card={renderCard('msteams')} />
          ) : open.id === 'discord' ? (
            <DiscordIntegrationPanel />
          ) : open.kind === 'chat' ? (
            renderCard(open.id)
          ) : open.kind === 'source' ? (
            <SourceSetup tile={open} />
          ) : (
            <DeveloperSetup tile={open} onChanged={onChanged} />
          )}
        </SetupDrawer>
      )}
    </div>
  );
}
