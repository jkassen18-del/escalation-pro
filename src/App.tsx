import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '@/state/auth';
import { AppShell } from '@/components/AppShell';
import { Spinner } from '@/components/ui/Feedback';
import { LoginPage } from '@/pages/Login';
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
import { QuickLinksPage } from '@/pages/QuickLinks';
import { OperationsPage } from '@/pages/Operations';
import { MonitorsPage } from '@/pages/Monitors';
import { MaintenancePage } from '@/pages/Maintenance';
import { OnCallPage } from '@/pages/OnCall';
import { StatusPagesPage } from '@/pages/StatusPages';
import { DatabasesPage } from '@/pages/Databases';
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
  if (!user) return <LoginPage />;
  // The OAuth consent screen stands alone, outside the app shell.
  if (window.location.pathname === '/connect/authorize') return <ConnectAuthorizePage />;

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/tickets" replace />} />
        <Route path="/tickets" element={<TicketListPage />} />
        <Route path="/tickets/new" element={<Guard permission="tickets.create"><NewTicketPage /></Guard>} />
        <Route path="/tickets/quick/:id" element={<Guard permission="tickets.create"><QuickTicketPage /></Guard>} />
        <Route path="/quick-tickets" element={<Guard permission="teams.manage"><QuickTicketsPage /></Guard>} />
        <Route path="/tickets/:id" element={<TicketDetailPage />} />
        <Route path="/people" element={<Guard permission="users.view"><PeoplePage /></Guard>} />
        <Route path="/teams" element={<Guard permission="teams.manage"><TeamsPage /></Guard>} />
        <Route path="/reports" element={<Guard permission="reports.view"><ReportsPage /></Guard>} />
        <Route
          path="/integrations"
          element={<Guard permission="integrations.manage"><IntegrationsPage /></Guard>}
        />
        <Route path="/settings" element={<Guard permission="settings.manage"><SettingsPage /></Guard>} />
        <Route path="/audit" element={<Guard permission="audit.view"><AuditLogPage /></Guard>} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/links" element={<QuickLinksPage />} />
        <Route path="/operations" element={<OperationsPage />} />
        <Route path="/monitors" element={<MonitorsPage />} />
        <Route path="/maintenance" element={<MaintenancePage />} />
        <Route path="/oncall" element={<OnCallPage />} />
        <Route path="/status-pages" element={<StatusPagesPage />} />
        <Route path="/databases" element={<Guard permission="backups.manage"><DatabasesPage /></Guard>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AppShell>
  );
}

/** Route-level permission check. The API enforces the same rules server-side. */
function Guard({ permission, children }: { permission: Permission; children: React.ReactNode }) {
  const { can } = useAuth();
  if (!can(permission)) {
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
