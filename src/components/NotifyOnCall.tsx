import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BellRing, Copy, Mail, Phone, PhoneCall, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { shortDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { Avatar } from '@/components/ui/Avatar';
import type { OnCallContact } from '@shared/types';

export interface OnCallState {
  contacts: OnCallContact[] | null;
  teamsConnected: boolean;
  reload: () => Promise<void>;
}

/** Who is on call for the ticket's department; refetched when the ticket changes department. */
export function useOnCall(ticketId: string, teamId: string | null): OnCallState {
  const [contacts, setContacts] = useState<OnCallContact[] | null>(null);
  const [teamsConnected, setTeamsConnected] = useState(false);

  const latest = useRef(0);
  const reload = useCallback(async () => {
    const request = ++latest.current;
    if (!teamId) {
      setContacts([]);
      return;
    }
    try {
      const result = await api.tickets.onCall(ticketId);
      // A change of team while this was in flight makes it someone else's answer.
      if (request !== latest.current) return;
      setContacts(result.contacts);
      setTeamsConnected(result.teamsConnected);
    } catch {
      if (request === latest.current) setContacts([]);
    }
  }, [ticketId, teamId]);

  useEffect(() => {
    // Not the previous department's people while the new answer loads.
    setContacts(null);
    void reload();
  }, [reload]);

  return { contacts, teamsConnected, reload };
}

/** A tel: link wants digits and a leading +, not the spaces and brackets people type. */
function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

/**
 * The on-call card: who to ring, and a button that nudges them in the app,
 * on their phone and in the department's Teams channel. `variant="banner"` is
 * the louder version shown straight after the ticket is raised.
 */
export function NotifyOnCall({
  ticketId,
  teamName,
  state,
  variant = 'panel',
  onDismiss,
  onNotified,
}: {
  ticketId: string;
  teamName: string | null;
  state: OnCallState;
  variant?: 'panel' | 'banner';
  onDismiss?: () => void;
  onNotified?: () => void;
}) {
  const toast = useToast();
  const { can } = useAuth();
  const [composing, setComposing] = useState(false);
  const [note, setNote] = useState('');
  // Who the notification goes to; null until contacts load, then everyone on call.
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [sending, setSending] = useState(false);

  const contacts = state.contacts;
  const contactKey = (contacts ?? []).map((contact) => contact.userId).join(',');
  useEffect(() => {
    // A new set of people on call starts with all of them selected.
    setChosen(null);
  }, [contactKey]);
  if (contacts === null) return null;
  const banner = variant === 'banner';

  // Nobody to call: say so once in the panel; the banner has nothing to offer.
  if (!contacts.length) {
    if (banner) return null;
    return (
      <div className="border-b px-4 py-3">
        <p className="eyebrow mb-1">On call</p>
        <p className="text-xs text-muted">
          {teamName ? `Nobody is on call for ${teamName} right now.` : 'Assign a team to see who is on call.'}
          {teamName && can('ops.view') && (
            <>
              {' '}
              <Link to="/oncall" className="text-[var(--accent)] hover:underline">
                Schedules
              </Link>
            </>
          )}
        </p>
      </div>
    );
  }

  const unique = contacts.filter((contact, index) => contacts.findIndex((other) => other.userId === contact.userId) === index);
  const targets = (chosen ?? unique.map((contact) => contact.userId)).filter((id) => unique.some((contact) => contact.userId === id));

  const send = async () => {
    setSending(true);
    try {
      const { results, notified } = await api.tickets.notifyOnCall(ticketId, { userIds: targets, note: note.trim() || undefined });
      const teams = results.find((result) => result.channel === 'msteams');
      const pushed = results.filter((result) => result.channel === 'push' && result.status === 'sent').length;
      const parts = [
        'in the app',
        pushed ? `on ${pushed === 1 ? 'their phone' : `${pushed} phones`}` : null,
        teams?.status === 'sent' ? 'in Teams' : null,
      ].filter(Boolean);
      toast.success(`Notified ${notified.map((contact) => contact.name).join(', ')}`, `Sent ${parts.join(', ')}.`);
      if (teams && teams.status !== 'sent') toast.info('Teams was not notified', teams.detail);
      setComposing(false);
      setNote('');
      onNotified?.();
    } catch (caught) {
      toast.error('Could not notify on-call', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className={cn(
        banner
          ? 'animate-in mx-4 mt-4 rounded-md border border-[var(--accent)]/50 bg-[var(--accent)]/8 p-4 sm:mx-6'
          : 'border-b px-4 py-3',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {banner ? (
            <>
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                <PhoneCall className="size-4 text-[var(--accent)]" />
                Need {teamName ?? 'the team'} now?
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {unique.length === 1 ? `${unique[0].name} is` : `${unique.length} people are`} on call. Ring them, or send a
                notification{state.teamsConnected ? ' to their phone and the Teams channel' : ''}.
              </p>
            </>
          ) : (
            <p className="eyebrow">On call · {teamName}</p>
          )}
        </div>
        {banner && onDismiss && (
          <button onClick={onDismiss} className="rounded-xs p-1 text-[var(--fg-subtle)] hover:text-[var(--fg)]" aria-label="Dismiss">
            <X className="size-4" />
          </button>
        )}
      </div>

      <ul className={cn('mt-2 grid gap-2', banner && 'sm:grid-cols-2')}>
        {unique.map((contact) => (
          <li key={contact.userId} className="flex items-start gap-2.5 rounded-sm border p-2.5 surface">
            <Avatar name={contact.name} size="md" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold">{contact.name}</p>
              <p className="truncate text-2xs text-subtle">
                {contact.scheduleName}
                {contact.until ? ` · until ${shortDateTime(contact.until)}` : ''}
              </p>
              {contact.phone ? (
                <div className="mt-1 flex items-center gap-1">
                  <a
                    href={telHref(contact.phone)}
                    className="inline-flex min-w-0 items-center gap-1 font-mono text-xs font-medium text-[var(--accent)] hover:underline"
                  >
                    <Phone className="size-3 shrink-0" />
                    <span className="truncate">{contact.phone}</span>
                  </a>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(contact.phone!).then(
                        () => toast.success('Number copied'),
                        () => undefined,
                      );
                    }}
                    className="rounded-xs p-0.5 text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                    aria-label={`Copy ${contact.name}'s number`}
                  >
                    <Copy className="size-3" />
                  </button>
                </div>
              ) : (
                <p className="mt-1 text-2xs text-subtle">No phone number on their profile</p>
              )}
              <a href={`mailto:${contact.email}`} className="mt-0.5 flex min-w-0 items-center gap-1 text-2xs text-muted hover:text-[var(--fg)]">
                <Mail className="size-3 shrink-0" />
                <span className="truncate">{contact.email}</span>
              </a>
            </div>
          </li>
        ))}
      </ul>

      {composing ? (
        <div className="mt-2 space-y-2">
          {unique.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {unique.map((contact) => {
                const on = targets.includes(contact.userId);
                return (
                  <button
                    key={contact.userId}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setChosen(on ? targets.filter((id) => id !== contact.userId) : [...targets, contact.userId])
                    }
                    className={cn(
                      'rounded-[3px] border px-2 py-0.5 text-xs',
                      on ? 'border-[var(--accent)] font-medium text-[var(--accent)]' : 'text-muted',
                    )}
                  >
                    {contact.name}
                  </button>
                );
              })}
            </div>
          )}
          <Textarea
            rows={2}
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Optional: what you need from them, e.g. players cannot launch the game"
            aria-label="Note for on-call"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setComposing(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" loading={sending} disabled={!targets.length} onClick={() => void send()}>
              <BellRing className="size-3.5" />
              Send notification
            </Button>
          </div>
        </div>
      ) : (
        <Button variant={banner ? 'primary' : 'secondary'} size="sm" className="mt-2 w-full sm:w-auto" onClick={() => setComposing(true)}>
          <BellRing className="size-3.5" />
          Notify on-call
        </Button>
      )}
    </div>
  );
}
