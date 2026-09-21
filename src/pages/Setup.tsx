import { useState, type FormEvent } from 'react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/state/auth';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { AuthLayout } from './Login';

/**
 * Shown only while the database has no users. Creates the first administrator,
 * after which this screen is unreachable and all further accounts are made
 * from the People page.
 */
export function SetupPage() {
  const { completeSetup } = useAuth();
  const [form, setForm] = useState({
    organizationName: '',
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (form.password !== form.confirmPassword) {
      setError('The two passwords do not match.');
      return;
    }
    if (form.password.length < 10) {
      setError('Choose a password of at least 10 characters.');
      return;
    }

    setSubmitting(true);
    try {
      await completeSetup({
        name: form.name,
        email: form.email,
        password: form.password,
        organizationName: form.organizationName || 'Escalation Pro',
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Setup failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout>
      <h1 className="text-lg font-semibold">Set up Escalation Pro</h1>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        This creates the first administrator account. Everyone else is added from the People page afterwards — there
        is no public sign-up.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-3.5">
        <Field label="Organisation name" htmlFor="organizationName" hint="Shown in the sidebar and notifications.">
          <Input
            id="organizationName"
            value={form.organizationName}
            onChange={set('organizationName')}
            placeholder="Northwind Services"
            autoFocus
          />
        </Field>

        <Field label="Your name" htmlFor="name" required>
          <Input id="name" value={form.name} onChange={set('name')} placeholder="Avery Whitlock" required />
        </Field>

        <Field label="Email" htmlFor="email" required>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            value={form.email}
            onChange={set('email')}
            placeholder="avery@company.com"
            required
          />
        </Field>

        <Field label="Password" htmlFor="password" hint="At least 10 characters." required>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={set('password')}
            required
          />
        </Field>

        <Field label="Confirm password" htmlFor="confirmPassword" required>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={form.confirmPassword}
            onChange={set('confirmPassword')}
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
          Create administrator account
        </Button>
      </form>
    </AuthLayout>
  );
}
