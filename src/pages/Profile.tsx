import { useState, type FormEvent } from 'react';
import { api, ApiError } from '@/lib/api';
import { ROLE_LABELS, fullDateTime } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { useTheme } from '@/state/theme';
import { useToast } from '@/components/ui/Toast';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Field, Input, SegmentedControl } from '@/components/ui/Field';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';

export function ProfilePage() {
  const { user, refresh } = useAuth();
  const { theme, setTheme } = useTheme();
  const toast = useToast();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('The two new passwords do not match.');
      return;
    }
    if (newPassword.length < 10) {
      setError('Choose a password of at least 10 characters.');
      return;
    }

    setSubmitting(true);
    try {
      await api.auth.changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      await refresh();
      toast.success('Password changed', 'Sessions on your other devices have been signed out.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not change your password.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <PageHeader title="Your profile" description="Account details, appearance, and password." />

      <div className="max-w-2xl space-y-4 p-4 sm:p-6">
        <section className="rounded-md border p-4 surface">
          <div className="flex items-center gap-3">
            <Avatar name={user.name} color={user.avatarColor} size="lg" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{user.name}</p>
              <p className="truncate text-xs text-muted">{user.email}</p>
            </div>
            <Badge dot={false} className="ml-auto">
              {ROLE_LABELS[user.role]}
            </Badge>
          </div>

          <dl className="mt-4 grid gap-2 border-t pt-4 text-xs sm:grid-cols-2">
            <div className="flex justify-between gap-2 sm:block">
              <dt className="text-subtle">Username</dt>
              <dd className="font-mono text-xs sm:mt-0.5">{user.username}</dd>
            </div>
            <div className="flex justify-between gap-2 sm:block">
              <dt className="text-subtle">Job title</dt>
              <dd className="sm:mt-0.5">{user.jobTitle ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-2 sm:block">
              <dt className="text-subtle">Teams</dt>
              <dd className="sm:mt-0.5">{user.teamIds.length || 'None'}</dd>
            </div>
            <div className="flex justify-between gap-2 sm:block">
              <dt className="text-subtle">Last signed in</dt>
              <dd className="sm:mt-0.5">{user.lastLoginAt ? fullDateTime(user.lastLoginAt) : '—'}</dd>
            </div>
          </dl>

          <p className="mt-3 border-t pt-3 text-xs text-subtle">
            Name, email, role, and team membership are managed by an administrator.
          </p>
        </section>

        <section className="rounded-md border surface">
          <h2 className="border-b px-4 py-2.5 text-xs font-semibold">Appearance</h2>
          <div className="px-4 py-4">
            <SegmentedControl
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'system', label: 'System' },
              ]}
            />
          </div>
        </section>

        <section className="rounded-md border surface">
          <h2 className="border-b px-4 py-2.5 text-xs font-semibold">Change password</h2>
          <form onSubmit={changePassword} className="space-y-3.5 px-4 py-4">
            {user.mustChangePassword && (
              <div className="rounded-sm border border-[var(--color-brass-400)]/45 bg-[var(--color-brass-50)] px-2.5 py-2 text-xs dark:bg-[var(--color-brass-900)]/20">
                You are still using a temporary password. Please choose your own.
              </div>
            )}

            <Field label="Current password" htmlFor="currentPassword" required>
              <Input
                id="currentPassword"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                required
              />
            </Field>

            <Field label="New password" htmlFor="newPassword" hint="At least 10 characters." required>
              <Input
                id="newPassword"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
              />
            </Field>

            <Field label="Confirm new password" htmlFor="confirmPassword" required>
              <Input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
              />
            </Field>

            {error && (
              <p role="alert" className="text-xs text-[var(--priority-urgent)]">
                {error}
              </p>
            )}

            <Button type="submit" variant="primary" loading={submitting}>
              Update password
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}
