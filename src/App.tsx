import { lazy, Suspense } from 'react';
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
import type { Permission } from '@shared/types';

// Loaded when first opened, so the first visit downloads only sign-in and tickets.
const QuickTicketPage = lazy(() => import('@/pages/QuickTicket').then((module) => ({ default: module.QuickTicketPage })));
const QuickTicketsPage = lazy(() => import('@/pages/QuickTickets').then((module) => ({ default: module.QuickTicketsPage })));
const PeoplePage = lazy(() => import('@/pages/People').then((module) => ({ default: module.PeoplePage })));
const TeamsPage = lazy(() => import('@/pages/Teams').then((module) => ({ default: module.TeamsPage })));
const ReportsPage = lazy(() => import('@/pages/Reports').then((module) => ({ default: module.ReportsPage })));
const IntegrationsPage = lazy(() => import('@/pages/Integrations').then((module) => ({ default: module.IntegrationsPage })));
const SettingsPage = lazy(() => import('@/pages/Settings').then((module) => ({ default: module.SettingsPage })));
const AuditLogPage = lazy(() => import('@/pages/AuditLog').then((module) => ({ default: module.AuditLogPage })));
const ProfilePage = lazy(() => import('@/pages/Profile').then((module) => ({ default: module.ProfilePage })));
const ShiftsPage = lazy(() => import('@/pages/Shifts').then((module) => ({ default: module.ShiftsPage })));
const ApprovalsPage = lazy(() => import('@/pages/Approvals').then((module) => ({ default: module.ApprovalsPage })));
const ConnectionsPage = lazy(() => import('@/pages/Connections').then((module) => ({ default: module.ConnectionsPage })));
const FlowEditorPage = lazy(() => import('@/pages/Flows').then((module) => ({ default: module.FlowEditorPage })));
const FlowsPage = lazy(() => import('@/pages/Flows').then((module) => ({ default: module.FlowsPage })));
const QuickLinksPage = lazy(() => import('@/pages/QuickLinks').then((module) => ({ default: module.QuickLinksPage })));
const OperationsPage = lazy(() => import('@/pages/Operations').then((module) => ({ default: module.OperationsPage })));
const MonitorsPage = lazy(() => import('@/pages/Monitors').then((module) => ({ default: module.MonitorsPage })));
const MaintenancePage = lazy(() => import('@/pages/Maintenance').then((module) => ({ default: module.MaintenancePage })));
const OnCallPage = lazy(() => import('@/pages/OnCall').then((module) => ({ default: module.OnCallPage })));
const StatusPagesPage = lazy(() => import('@/pages/StatusPages').then((module) => ({ default: module.StatusPagesPage })));
const DatabasesPage = lazy(() => import('@/pages/Databases').then((module) => ({ default: module.DatabasesPage })));
const DocsPage = lazy(() => import('@/pages/Docs').then((module) => ({ default: module.DocsPage })));
const ConnectAuthorizePage = lazy(() => import('@/pages/ConnectAuthorize').then((module) => ({ default: module.ConnectAuthorizePage })));

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
  if (window.location.pathname === '/connect/authorize') {
    return (
      <Suspense fallback={<PageLoading />}>
        <ConnectAuthorizePage />
      </Suspense>
    );
  }

  return (
    <DepartmentProvider>
    <AppShell>
      <Suspense fallback={<PageLoading />}>
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
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/connections" element={<ConnectionsPage />} />
        <Route path="/flows" element={<FlowsPage />} />
        <Route path="/flows/:id" element={<FlowEditorPage />} />
        <Route path="/status-pages" element={<Guard permission="ops.view"><StatusPagesPage /></Guard>} />
        <Route path="/databases" element={<Guard permission={['databases.manage', 'backups.manage', 'backups.restore']}><DatabasesPage /></Guard>} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/docs/:slug" element={<DocsPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      </Suspense>
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

function PageLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <Spinner className="size-5" />
    </div>
  );
}
