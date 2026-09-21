import { useState, type FormEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/state/auth';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';

export function LoginPage() {
  const { login, organizationName } = useAuth();
  const [loginValue, setLoginValue] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

      <form onSubmit={onSubmit} className="mt-6 space-y-3.5">
        <Field label="Email or username" htmlFor="login">
          <Input
            id="login"
            name="username"
            autoComplete="username"
            autoFocus
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
          Accounts are created by an administrator. If you need access, ask your team lead to provision an account
          for you.
        </p>
      </div>
    </AuthLayout>
  );
}

export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6" style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-sm">
        <div className="mb-5 flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-[5px] bg-[var(--fg)] text-[11px] font-bold text-[var(--bg)]">
            EP
          </span>
          <span className="text-sm font-semibold tracking-tight">Escalation Pro</span>
        </div>
        <div className="rounded-md border p-6 surface">{children}</div>
      </div>
    </div>
  );
}
