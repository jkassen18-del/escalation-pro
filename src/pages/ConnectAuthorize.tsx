import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { connectorApi } from '@/lib/connector-api';
import { useAuth } from '@/state/auth';
import { useBranding, useDocumentTitle } from '@/state/branding';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Feedback';
import type { ConnectorScope, OAuthConsentRequest } from '@shared/connector';

/**
 * The OAuth consent screen. Reached from /oauth/authorize once the request
 * checks out; the person is already signed in (the app shows sign-in first).
 * Shown full-screen, outside the app shell, so it reads as a decision.
 */
export function ConnectAuthorizePage() {
  useDocumentTitle('Connect an app');
  const { user } = useAuth();
  const { organizationName } = useBranding();
  const requestId = new URLSearchParams(window.location.search).get('request') ?? '';
  const [request, setRequest] = useState<OAuthConsentRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<ConnectorScope>('read_write');
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);

  useEffect(() => {
    connectorApi
      .consent(requestId)
      .then((r) => {
        setRequest(r);
        setScope(r.effectiveScope);
      })
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'This request could not be loaded.'));
  }, [requestId]);

  const decide = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'deny');
    try {
      const { redirectTo } = approve ? await connectorApi.approve(requestId, scope) : await connectorApi.deny(requestId);
      window.location.assign(redirectTo);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
      setBusy(null);
    }
  };

  const org = organizationName || 'InfraTicket';

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10" style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-md rounded-md border surface p-6 shadow-sm">
        <div className="flex items-center gap-2 text-subtle">
          <ShieldCheck className="size-4" />
          <span className="text-xs">{org}</span>
        </div>

        {error ? (
          <>
            <h1 className="mt-4 text-base font-semibold">Can't connect</h1>
            <p className="mt-2 text-sm text-muted">{error}</p>
            <p className="mt-2 text-xs text-subtle">Close this window and start again from the app you were connecting.</p>
          </>
        ) : !request ? (
          <div className="flex justify-center py-10">
            <Spinner className="size-5" />
          </div>
        ) : (
          <>
            <h1 className="mt-4 text-base font-semibold">
              {request.clientName} wants to use {org} as you
            </h1>
            <p className="mt-2 text-sm text-muted">
              Signed in as <b className="text-[var(--fg)]">{user?.name}</b>. It will see only what you can see and act only within your
              permissions. Its changes are recorded as <i>{user?.name} via Claude</i>.
            </p>

            <dl className="mt-4 space-y-2 rounded-sm border p-3 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-subtle">Application</dt>
                <dd className="text-right font-medium">{request.clientName}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-subtle">Sends you back to</dt>
                <dd className="break-all text-right font-mono font-medium">{request.redirectHost}</dd>
              </div>
            </dl>

            <div className="mt-4">
              <p className="text-xs font-medium">Access</p>
              {request.effectiveScope === 'read_write' ? (
                <SegmentedControl
                  className="mt-1.5"
                  value={scope}
                  onChange={setScope}
                  options={[
                    { value: 'read_write', label: 'Read and write' },
                    { value: 'read', label: 'Read only' },
                  ]}
                />
              ) : (
                <p className="mt-1 text-xs text-muted">
                  Read only{request.scope === 'read_write' ? ' - your organisation does not allow AI assistants to make changes.' : '.'}
                </p>
              )}
              <p className="mt-1.5 text-xs text-subtle">
                {scope === 'read_write' && request.effectiveScope === 'read_write'
                  ? 'Search and read tickets, incidents, on-call and monitors; comment on, update, escalate and raise tickets; acknowledge pages.'
                  : 'Search and read tickets, incidents, on-call and monitors. No changes.'}
              </p>
            </div>

            <p className="mt-4 text-xs text-subtle">
              Only approve if you started this from {request.clientName} and recognise <b>{request.redirectHost}</b>. You can disconnect it any
              time under Profile → Connect Claude.
            </p>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => decide(false)} loading={busy === 'deny'} disabled={Boolean(busy)}>
                Deny
              </Button>
              <Button variant="primary" onClick={() => decide(true)} loading={busy === 'approve'} disabled={Boolean(busy)}>
                Approve
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
