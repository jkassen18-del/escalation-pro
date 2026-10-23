import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/state/auth';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { BrandMark } from '@/components/BrandMark';
import { useBranding, useDocumentTitle } from '@/state/branding';
import { ssoApi, type SsoBootstrap } from '@/lib/sso-api';
import { MicrosoftIcon } from '@/components/BrandIcons';

export function LoginPage() {
  const { login } = useAuth();
  const { organizationName } = useBranding();
  useDocumentTitle('Sign in');
  const [loginValue, setLoginValue] = useState('');
  const [password, setPassword] = useState('');
  // A failed single sign-on comes back as ?sso_error=..., set by the server.
  const [error, setError] = useState<string | null>(() => new URLSearchParams(window.location.search).get('sso_error'));
  const [submitting, setSubmitting] = useState(false);
  const [sso, setSso] = useState<SsoBootstrap | null>(null);

  useEffect(() => {
    void ssoApi.bootstrap().then(setSso).catch(() => undefined);
    if (new URLSearchParams(window.location.search).has('sso_error')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const returnTo = window.location.pathname === '/' ? '/' : `${window.location.pathname}${window.location.search}`;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(loginValue, password);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not sign in. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout>
      <h1 className="text-lg font-semibold">Sign in</h1>
      <p className="mt-1 text-xs text-muted">Continue to {organizationName}.</p>

      {sso?.enabled && (
        <div className="mt-6">
          <a
            href={ssoApi.loginUrl(returnTo)}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-sm border text-sm font-medium transition-colors surface hover:bg-[var(--surface-3)]"
          >
            {sso.provider === 'entra' ? <MicrosoftIcon className="size-4" /> : <KeyRound className="size-4 text-[var(--fg-subtle)]" />}
            {sso.label}
          </a>
          <div className="mt-5 flex items-center gap-3 text-2xs text-subtle">
            <span className="h-px flex-1 bg-[var(--border)]" />
            {sso.required ? 'administrators can also use a password' : 'or use a password'}
            <span className="h-px flex-1 bg-[var(--border)]" />
          </div>
        </div>
      )}

      <form onSubmit={onSubmit} className={sso?.enabled ? 'mt-4 space-y-3.5' : 'mt-6 space-y-3.5'}>
        <Field label="Email or username" htmlFor="login">
          <Input
            id="login"
            name="username"
            autoComplete="username"
            autoFocus={!sso?.enabled}
            value={loginValue}
            onChange={(event) => setLoginValue(event.target.value)}
            placeholder="you@company.com"
            required
          />
        </Field>

        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>

        {error && (
          <div
            role="alert"
            className="rounded-sm border border-[var(--priority-urgent)]/30 bg-[var(--priority-urgent)]/5 px-2.5 py-2 text-xs text-[var(--priority-urgent)]"
          >
            {error}
          </div>
        )}

        <Button type="submit" variant="primary" size="lg" className="w-full" loading={submitting}>
          Sign in
        </Button>
      </form>

      <div className="mt-6 flex gap-2 border-t pt-4">
        <ShieldCheck className="mt-px size-3.5 shrink-0 text-[var(--fg-subtle)]" />
        <p className="text-xs leading-relaxed text-subtle">
          Accounts are created by an administrator. If you need access, ask your team lead for an account or an
          invite link.
        </p>
      </div>
    </AuthLayout>
  );
}

export function AuthLayout({ children }: { children: React.ReactNode }) {
  const { organizationName } = useBranding();
  return (
    <div className="flex min-h-dvh items-center justify-center p-6" style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-sm">
        <div className="mb-5 flex items-center gap-2">
          <BrandMark className="size-7 text-[11px]" />
          <span className="text-sm font-semibold tracking-tight">{organizationName}</span>
        </div>
        <div className="rounded-md border p-6 surface">{children}</div>
      </div>
    </div>
  );
}
