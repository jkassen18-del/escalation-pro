import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useAuth } from '@/state/auth';
import { AppShell } from '@/components/AppShell';
import { DepartmentProvider } from '@/state/department';
import { Spinner } from '@/components/ui/Feedback';
import { LoginPage } from '@/pages/Login';
import { AcceptInvitePage } from '@/pages/AcceptInvite';
import { SetupPage } from '@/pages/Setup';
import { TicketListPage } from '@/pages/TicketList';
import { TicketDetailPage } from '@/pages/TicketDetail';
import { NewTicketPage } from '@/pages/NewTicket';
import { QuickTicketPage } from '@/pages/QuickTicket';
import { QuickTicketsPage } from '@/pages/QuickTickets';
import { PeoplePage } from '@/pages/People';
import { TeamsPage } from '@/pages/Teams';
import { ReportsPage } from '@/pages/Reports';
import { IntegrationsPage } from '@/pages/Integrations';
import { SettingsPage } from '@/pages/Settings';
import { AuditLogPage } from '@/pages/AuditLog';
import { ProfilePage } from '@/pages/Profile';
import { ShiftsPage } from '@/pages/Shifts';
import { QuickLinksPage } from '@/pages/QuickLinks';
import { OperationsPage } from '@/pages/Operations';
import { MonitorsPage } from '@/pages/Monitors';
import { MaintenancePage } from '@/pages/Maintenance';
import { OnCallPage } from '@/pages/OnCall';
import { StatusPagesPage } from '@/pages/StatusPages';
import { DatabasesPage } from '@/pages/Databases';
import { DocsPage } from '@/pages/Docs';
import { ConnectAuthorizePage } from '@/pages/ConnectAuthorize';
import type { Permission } from '@shared/types';

export function App() {
  const { user, loading, setupRequired } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center" style={{ background: 'var(--bg)' }}>
        <Spinner className="size-5" />
      </div>
    );
  }

  if (setupRequired) return <SetupPage />;
  // An invite link stands alone, signed in or not.
  const inviteMatch = /^\/invite\/([^/]+)\/?$/.exec(window.location.pathname);
  if (inviteMatch) return <AcceptInvitePage token={decodeURIComponent(inviteMatch[1])} />;
  if (!user) return <LoginPage />;
  // The OAuth consent screen stands alone, outside the app shell.
  if (window.location.pathname === '/connect/authorize') return <ConnectAuthorizePage />;

  return (
    <DepartmentProvider>
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/tickets" replace />} />
        <Route path="/tickets" element={<TicketListPage />} />
        <Route path="/tickets/new" element={<Guard permission="tickets.create"><NewTicketPage /></Guard>} />
        <Route path="/tickets/quick/:id" element={<Guard permission="tickets.create"><QuickTicketPage /></Guard>} />
        <Route path="/quick-tickets" element={<Guard permission="templates.manage"><QuickTicketsPage /></Guard>} />
        <Route path="/tickets/:id" element={<KeyedTicketDetail />} />
        <Route path="/people" element={<Guard permission="users.view"><PeoplePage /></Guard>} />
        <Route path="/teams" element={<Guard permission={['teams.manage', 'teams.forms', 'teams.links']}><TeamsPage /></Guard>} />
        <Route path="/reports" element={<Guard permission="reports.view"><ReportsPage /></Guard>} />
        <Route
          path="/integrations"
          element={<Guard permission="integrations.manage"><IntegrationsPage /></Guard>}
        />
        <Route path="/settings" element={<Guard permission={['settings.manage', 'branding.manage', 'sso.manage', 'connector.manage']}><SettingsPage /></Guard>} />
        <Route path="/audit" element={<Guard permission="audit.view"><AuditLogPage /></Guard>} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/links" element={<QuickLinksPage />} />
        <Route path="/operations" element={<Guard permission="ops.view"><OperationsPage /></Guard>} />
        <Route path="/monitors" element={<Guard permission="ops.view"><MonitorsPage /></Guard>} />
        <Route path="/maintenance" element={<Guard permission="ops.view"><MaintenancePage /></Guard>} />
        <Route path="/oncall" element={<Guard permission="ops.view"><OnCallPage /></Guard>} />
        <Route path="/shifts" element={<Guard permission="ops.view"><ShiftsPage /></Guard>} />
        <Route path="/status-pages" element={<Guard permission="ops.view"><StatusPagesPage /></Guard>} />
        <Route path="/databases" element={<Guard permission={['databases.manage', 'backups.manage', 'backups.restore']}><DatabasesPage /></Guard>} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/docs/:slug" element={<DocsPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AppShell>
    </DepartmentProvider>
  );
}

/**
 * A fresh ticket page per ticket: moving from one ticket to another (a
 * notification, a link) must not carry over the last one's state, banners or
 * an answer that arrives late.
 */
function KeyedTicketDetail() {
  const { id } = useParams();
  return <TicketDetailPage key={id} />;
}

/** Route-level permission check. The API enforces the same rules server-side. */
function Guard({ permission, children }: { permission: Permission | Permission[]; children: React.ReactNode }) {
  const { can } = useAuth();
  if (!can(...(Array.isArray(permission) ? permission : [permission]))) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-sm font-medium">You do not have access to this area</p>
        <p className="mt-1 text-xs text-muted">Ask an administrator if you think you should.</p>
      </div>
    );
  }
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="px-6 py-16 text-center">
      <p className="text-sm font-medium">Page not found</p>
      <p className="mt-1 text-xs text-muted">The link may be out of date.</p>
    </div>
  );
}
