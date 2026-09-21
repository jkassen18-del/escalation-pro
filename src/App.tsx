import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '@/state/auth';
import { AppShell } from '@/components/AppShell';
import { Spinner } from '@/components/ui/Feedback';
import { LoginPage } from '@/pages/Login';
import { SetupPage } from '@/pages/Setup';
import { TicketListPage } from '@/pages/TicketList';
import { TicketDetailPage } from '@/pages/TicketDetail';
import { NewTicketPage } from '@/pages/NewTicket';
import { PeoplePage } from '@/pages/People';
import { TeamsPage } from '@/pages/Teams';
import { ReportsPage } from '@/pages/Reports';
import { IntegrationsPage } from '@/pages/Integrations';
import { SettingsPage } from '@/pages/Settings';
import { AuditLogPage } from '@/pages/AuditLog';
import { ProfilePage } from '@/pages/Profile';
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

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/tickets" replace />} />
        <Route path="/tickets" element={<TicketListPage />} />
        <Route path="/tickets/new" element={<Guard permission="tickets.create"><NewTicketPage /></Guard>} />
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
