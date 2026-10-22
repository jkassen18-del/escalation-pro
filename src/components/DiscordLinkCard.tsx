import { useEffect, useState } from 'react';
import { DiscordIcon } from '@/components/BrandIcons';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';

/**
 * Linking your own Discord account. The code comes from typing /link in
 * Discord, which is what proves the account is yours.
 */
export function DiscordLinkCard() {
  const toast = useToast();
  const [state, setState] = useState<{ available: boolean; linked: boolean; discordUsername: string | null } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.discord.me().then(setState).catch(() => setState(null));
  }, []);

  // Nothing to link to until an administrator has set Discord up, unless this person is already linked.
  if (!state || (!state.available && !state.linked)) return null;

  const link = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.discord.link(code);
      setState({ ...state, linked: true, discordUsername: result.discordUsername });
      setCode('');
      toast.success('Discord linked', `Signed in as ${result.discordUsername} in Discord.`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not link the account.');
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    setBusy(true);
    try {
      await api.discord.unlink();
      setState({ ...state, linked: false, discordUsername: null });
      toast.success('Discord unlinked');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-md border surface">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <DiscordIcon className="size-3.5" />
        <h2 className="text-xs font-semibold">Discord</h2>
      </div>
      <div className="space-y-3 px-4 py-4">
        {state.linked ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs">
              Linked to <span className="font-medium">{state.discordUsername ?? 'your Discord account'}</span>. You can raise tickets with{' '}
              <code>/ticket</code>, reply in ticket threads, use the buttons, and be paged by direct message.
            </p>
            <Button variant="ghost" size="sm" onClick={unlink} loading={busy}>
              Unlink
            </Button>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted">
              In Discord, type <code>/link</code> in any channel the InfraTicket bot is in. It replies (only to you) with a code; enter it here within 10 minutes.
            </p>
            <Field label="Link code" error={error ?? undefined}>
              <div className="flex gap-2">
                <Input
                  value={code}
                  onChange={(event) => setCode(event.target.value.toUpperCase())}
                  placeholder="ABCD-2345"
                  className="font-mono text-xs uppercase"
                  maxLength={9}
                  autoComplete="off"
                />
                <Button onClick={link} loading={busy} disabled={code.replace(/[^A-Za-z0-9]/g, '').length !== 8}>
                  Link
                </Button>
              </div>
            </Field>
          </>
        )}
      </div>
    </section>
  );
}
