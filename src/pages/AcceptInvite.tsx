import { useEffect, useState, type FormEvent } from 'react';
import { MailCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/state/auth';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Feedback';
import { useDocumentTitle } from '@/state/branding';
import type { InvitePreview } from '@shared/types';
import { AuthLayout } from './Login';

/**
 * Where an invite link lands. The person fills in who they are and picks
 * their department; the account is made with the role the invite carries,
 * and they are signed straight in.
 */
export function AcceptInvitePage({ token }: { token: string }) {
  useDocumentTitle('Join');
  const { user, refresh, logout } = useAuth();
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [teamId, setTeamId] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [ssoRequired, setSsoRequired] = useState(false);

  useEffect(() => {
    api.invites
      .preview(token)
      .then(({ invite: preview }) => {
        setInvite(preview);
        if (preview.email) setEmail(preview.email);
        if (preview.departments.length === 1) setTeamId(preview.departments[0].id);
      })
      .catch((caught) => setLoadError(caught instanceof ApiError ? caught.message : 'This invite could not be opened.'));
  }, [token]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.invites.accept(token, { firstName, lastName, email, teamId, password });
      if (result.ssoRequired) {
        setSsoRequired(true);
        return;
      }
      await refresh();
      window.location.assign('/tickets');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create your account. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (user) {
    return (
      <AuthLayout>
        <h1 className="text-lg font-semibold">You are already signed in</h1>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          You are signed in as {user.name}. An invite is for someone without an account; sign out first to use it for a new one.
        </p>
        <div className="mt-5 flex gap-2">
          <Button variant="primary" onClick={() => window.location.assign('/tickets')}>
            Continue as {user.name.split(' ')[0]}
          </Button>
          <Button variant="secondary" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (loadError) {
    return (
      <AuthLayout>
        <h1 className="text-lg font-semibold">Invite not available</h1>
        <p className="mt-1 text-xs leading-relaxed text-muted">{loadError}</p>
        <Button variant="secondary" className="mt-5" onClick={() => window.location.assign('/')}>
          Go to sign in
        </Button>
      </AuthLayout>
    );
  }

  if (!invite) {
    return (
      <AuthLayout>
        <div className="flex justify-center py-6">
          <Spinner className="size-5" />
        </div>
      </AuthLayout>
    );
  }

  if (ssoRequired) {
    return (
      <AuthLayout>
        <MailCheck className="size-5 text-[var(--status-resolved)]" />
        <h1 className="mt-2 text-lg font-semibold">Your account is ready</h1>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          {invite.organizationName} signs in with single sign-on. Use the sign-in button with your company account.
        </p>
        <Button variant="primary" className="mt-5" onClick={() => window.location.assign('/')}>
          Go to sign in
        </Button>
      </AuthLayout>
    );
  }

  const domainHint = invite.allowedDomains.length ? invite.allowedDomains.map((domain) => `@${domain}`).join(' or ') : null;

  return (
    <AuthLayout>
      <h1 className="text-lg font-semibold">Join {invite.organizationName}</h1>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        {invite.label ? `${invite.label}. ` : ''}Set up your account to raise and follow tickets. This link expires{' '}
        {new Date(invite.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-3.5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" htmlFor="invite-first">
            <Input id="invite-first" autoComplete="given-name" value={firstName} onChange={(event) => setFirstName(event.target.value)} required autoFocus />
          </Field>
          <Field label="Surname" htmlFor="invite-last">
            <Input id="invite-last" autoComplete="family-name" value={lastName} onChange={(event) => setLastName(event.target.value)} required />
          </Field>
        </div>

        <Field label="Company email" htmlFor="invite-email" hint={domainHint ? `Must end in ${domainHint}.` : undefined}>
          <Input
            id="invite-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={invite.allowedDomains[0] ? `you@${invite.allowedDomains[0]}` : 'you@company.com'}
            readOnly={Boolean(invite.email)}
            required
          />
        </Field>

        <Field label="Department" htmlFor="invite-team">
          <Select id="invite-team" value={teamId} onChange={(event) => setTeamId(event.target.value)} required>
            <option value="" disabled>
              Choose your department
            </option>
            {invite.departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Password" htmlFor="invite-password" hint="At least 10 characters.">
          <Input
            id="invite-password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        <Field label="Confirm password" htmlFor="invite-confirm">
          <Input
            id="invite-confirm"
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
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
          Create my account
        </Button>
      </form>

      <p className="mt-5 border-t pt-4 text-xs leading-relaxed text-subtle">
        Already have an account?{' '}
        <a href="/" className="text-[var(--accent)] hover:underline">
          Sign in
        </a>
        . Department managers are chosen by an administrator after you join.
      </p>
    </AuthLayout>
  );
}
