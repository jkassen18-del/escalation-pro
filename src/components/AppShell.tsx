import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell,
  Building2,
  ChevronDown,
  Inbox,
  KeyRound,
  LayoutGrid,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Plug,
  Radar,
  ScrollText,
  Settings as SettingsIcon,
  Sun,
  Ticket as TicketIcon,
  TriangleAlert,
  Users as UsersIcon,
  X,
} from 'lucide-react';
import { BrandMark } from '@/components/BrandMark';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { useTheme } from '@/state/theme';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Menu } from '@/components/ui/Menu';
import type { Notification, Permission } from '@shared/types';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: Permission;
  countKey?: 'mine' | 'unassigned' | 'overdue' | 'all';
  end?: boolean;
}

const PRIMARY_NAV: NavItem[] = [
  { to: '/tickets?assignee=me', label: 'My tickets', icon: Inbox, countKey: 'mine' },
  { to: '/tickets', label: 'All tickets', icon: TicketIcon, countKey: 'all', end: true },
  { to: '/tickets?unassigned=true', label: 'Unassigned', icon: LayoutGrid, countKey: 'unassigned' },
  { to: '/tickets?overdue=true', label: 'Breached SLA', icon: TriangleAlert, countKey: 'overdue' },
];

const MANAGE_NAV: NavItem[] = [
  { to: '/infragrid', label: 'InfraGrid', icon: Radar },
  { to: '/reports', label: 'Reports', icon: ScrollText, permission: 'reports.view' },
  { to: '/people', label: 'People', icon: UsersIcon, permission: 'users.view' },
  { to: '/teams', label: 'Teams', icon: Building2, permission: 'teams.manage' },
  { to: '/integrations', label: 'Integrations', icon: Plug, permission: 'integrations.manage' },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, permission: 'settings.manage' },
  { to: '/audit', label: 'Audit log', icon: KeyRound, permission: 'audit.view' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, organizationName, logout, can } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const [counts, setCounts] = useState({ all: 0, mine: 0, unassigned: 0, overdue: 0, open: 0 });
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Refresh the sidebar badges on navigation and on a slow poll.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [nextCounts, nextNotifications] = await Promise.all([
          api.tickets.counts(),
          api.notifications.list(),
        ]);
        if (cancelled) return;
        setCounts(nextCounts);
        setNotifications(nextNotifications.notifications);
        setUnread(nextNotifications.unread);
      } catch {
        // Badge counts are non-critical; a failure here should stay silent.
      }
    };

    void load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [location.pathname, location.search]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname, location.search]);

  // Keyboard shortcuts: `c` composes, `/` focuses search.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'c' && can('tickets.create')) {
        event.preventDefault();
        navigate('/tickets/new');
      }
      if (event.key === '/') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('[data-search-input]')?.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [navigate, can]);

  const markAllRead = async () => {
    await api.notifications.markRead();
    setUnread(0);
    setNotifications((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
  };

  const visibleManageNav = MANAGE_NAV.filter((item) => !item.permission || can(item.permission));

  const navContent = (
    <>
      <div className="px-3 py-3">
        <Link to="/tickets" className="flex items-center gap-2 rounded-sm px-1 py-1">
          <BrandMark className="size-6 text-[10px]" />
          <span className="min-w-0 truncate text-xs font-semibold">{organizationName}</span>
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        <ul className="space-y-px">
          {PRIMARY_NAV.map((item) => (
            <NavRow key={item.to} item={item} count={item.countKey ? counts[item.countKey] : undefined} />
          ))}
        </ul>

        {visibleManageNav.length > 0 && (
          <>
            <p className="eyebrow mt-5 mb-1.5 px-2">Manage</p>
            <ul className="space-y-px">
              {visibleManageNav.map((item) => (
                <NavRow key={item.to} item={item} />
              ))}
            </ul>
          </>
        )}
      </nav>

      <div className="border-t p-2">
        <Menu
          align="start"
          trigger={({ toggle }) => (
            <button
              onClick={toggle}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-3)]"
            >
              <Avatar name={user?.name ?? '?'} color={user?.avatarColor} size="md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{user?.name}</span>
                <span className="block truncate text-2xs text-subtle">{user?.email}</span>
              </span>
              <ChevronDown className="size-3.5 shrink-0 text-[var(--fg-subtle)]" />
            </button>
          )}
          items={[
            { label: 'Your profile', icon: UsersIcon, onSelect: () => navigate('/profile') },
            {
              label: theme === 'dark' ? 'Light theme' : theme === 'light' ? 'System theme' : 'Dark theme',
              icon: theme === 'dark' ? Sun : theme === 'light' ? Monitor : Moon,
              onSelect: () => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark'),
            },
            {
              label: 'Sign out',
              icon: LogOut,
              destructive: true,
              onSelect: () => {
                void logout();
              },
            },
          ]}
        />
      </div>
    </>
  );

  return (
    <div className="flex h-dvh overflow-hidden" style={{ background: 'var(--bg)' }}>
      {/* Desktop rail */}
      <aside className="hidden w-56 shrink-0 flex-col border-r surface md:flex">{navContent}</aside>

      {/* Mobile drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-[var(--color-ink-950)]/40" onClick={() => setMobileNavOpen(false)} />
          <aside className="animate-in relative flex h-full w-60 flex-col border-r surface">
            <button
              onClick={() => setMobileNavOpen(false)}
              className="absolute top-3 right-3 rounded-xs p-1 text-[var(--fg-subtle)]"
              aria-label="Close navigation"
            >
              <X className="size-4" />
            </button>
            {navContent}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 surface">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation"
          >
            <MenuIcon className="size-4" />
          </Button>

          <div className="flex-1" />

          <div className="relative">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setNotificationsOpen((open) => !open);
                if (!notificationsOpen && unread > 0) void markAllRead();
              }}
              aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
            >
              <Bell className="size-4" />
              {unread > 0 && (
                <span className="absolute top-1 right-1 size-1.5 rounded-full bg-[var(--priority-urgent)]" />
              )}
            </Button>

            {notificationsOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setNotificationsOpen(false)} />
                <div className="animate-in absolute right-0 z-40 mt-1 w-80 rounded-md border surface overlay-shadow">
                  <div className="flex items-center justify-between border-b px-3 py-2">
                    <p className="text-xs font-semibold">Notifications</p>
                    {notifications.length > 0 && (
                      <button
                        onClick={markAllRead}
                        className="text-2xs text-[var(--accent)] underline-offset-2 hover:underline"
                      >
                        Mark all read
                      </button>
                    )}
                  </div>
                  <div className="max-h-80 overflow-y-auto">
                    {notifications.length === 0 ? (
                      <p className="px-3 py-8 text-center text-xs text-subtle">Nothing new right now.</p>
                    ) : (
                      notifications.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => {
                            setNotificationsOpen(false);
                            if (item.ticketId) navigate(`/tickets/${item.ticketId}`);
                          }}
                          className="block w-full border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-[var(--surface-3)]"
                        >
                          <p className="text-xs font-medium">{item.title}</p>
                          {item.body && <p className="mt-0.5 line-clamp-2 text-2xs text-muted">{item.body}</p>}
                          <p className="mt-1 text-2xs text-subtle">{relativeTime(item.createdAt)}</p>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {can('tickets.create') && (
            <Button variant="primary" size="sm" onClick={() => navigate('/tickets/new')}>
              New ticket
            </Button>
          )}
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

function NavRow({ item, count }: { item: NavItem; count?: number }) {
  const location = useLocation();
  const Icon = item.icon;

  // NavLink's own matching ignores the query string, but our ticket views are
  // distinguished by it, so the active state is computed manually.
  const [path, query] = item.to.split('?');
  const active =
    location.pathname === path &&
    (item.end ? !location.search || location.search === '?' : location.search === `?${query ?? ''}`);

  return (
    <li>
      <NavLink
        to={item.to}
        className={cn(
          'flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors',
          active
            ? 'bg-[var(--surface-3)] font-medium text-[var(--fg)]'
            : 'text-[var(--fg-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]',
        )}
      >
        <Icon className={cn('size-3.5 shrink-0', active ? 'text-[var(--accent)]' : 'opacity-70')} />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {count !== undefined && count > 0 && (
          <span className="tabular shrink-0 text-2xs text-[var(--fg-subtle)]">{count}</span>
        )}
      </NavLink>
    </li>
  );
}
