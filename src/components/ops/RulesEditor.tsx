import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Send, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { opsApi } from '@/lib/ops-api';
import { useAuth } from '@/state/auth';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Badge';
import { Spinner } from '@/components/ui/Feedback';
import { NOTIFY_CHANNELS, NOTIFY_CHANNEL_LABELS, type NotificationAttempt, type NotificationRule, type NotifyChannel, type Urgency } from '@shared/ops';

type DraftRule = Omit<NotificationRule, 'id'> & { key: string };

const ATTEMPT_COLORS: Record<NotificationAttempt['status'], string> = {
  sent: 'var(--status-resolved)',
  simulated: 'var(--status-open)',
  answered: 'var(--status-resolved)',
  acknowledged: 'var(--status-resolved)',
  skipped: 'var(--status-closed)',
  failed: 'var(--priority-urgent)',
};

let keySeq = 0;
const withKey = (rule: Omit<NotificationRule, 'id'>): DraftRule => ({ ...rule, key: `r${(keySeq += 1)}` });

/** "How to reach me when I am paged", plus the phone number SMS and calls go to. */
export function RulesEditor() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [rules, setRules] = useState<DraftRule[] | null>(null);
  const [isDefault, setIsDefault] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [attempts, setAttempts] = useState<NotificationAttempt[] | null>(null);
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [savingPhone, setSavingPhone] = useState(false);

  useEffect(() => {
    void opsApi.me
      .rules()
      .then((result) => {
        setRules(result.rules.map(({ urgency, channel, delayMins }) => withKey({ urgency, channel, delayMins })));
        setIsDefault(result.isDefault);
      })
      .catch(() => setRules([]));
  }, []);

  if (!user) return null;

  const update = (key: string, patch: Partial<DraftRule>) =>
    setRules((current) => (current ?? []).map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)));

  const save = async () => {
    if (!rules) return;
    setSaving(true);
    setError(null);
    try {
      const result = await opsApi.me.saveRules(rules.map(({ urgency, channel, delayMins }) => ({ urgency, channel, delayMins })));
      setRules(result.rules.map(({ urgency, channel, delayMins }) => withKey({ urgency, channel, delayMins })));
      setIsDefault(result.isDefault);
      toast.success('Notification rules saved');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save your rules.');
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      setAttempts((await opsApi.me.testPage()).attempts);
    } catch (caught) {
      toast.error('Test page failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setTesting(false);
    }
  };

  const savePhone = async () => {
    setSavingPhone(true);
    try {
      await api.auth.updatePhone(phone.trim() || null);
      await refresh();
      toast.success('Phone number saved');
    } catch (caught) {
      toast.error('Could not save the number', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSavingPhone(false);
    }
  };

  const phoneValid = /^\+[1-9]\d{6,14}$/.test((user.phone ?? '').replace(/[\s\-().]/g, ''));

  const group = (urgency: Urgency) => (rules ?? []).filter((rule) => rule.urgency === urgency);

  return (
    <section className="rounded-md border surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <h2 className="text-xs font-semibold">Notifications when paged</h2>
        {isDefault && <Badge dot={false}>Using defaults</Badge>}
      </div>

      <div className="space-y-4 px-4 py-4">
        <div className="space-y-2">
          <Field label="Mobile number for SMS and calls" hint="International format, e.g. +27 82 123 4567.">
            <div className="flex gap-2">
              <Input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+27 82 123 4567" inputMode="tel" />
              <Button onClick={savePhone} loading={savingPhone} disabled={phone === (user.phone ?? '')}>
                Save
              </Button>
            </div>
          </Field>
          {!phoneValid && (
            <p className="rounded-sm border border-[var(--priority-high)]/40 bg-[var(--priority-high)]/5 px-2.5 py-2 text-xs">
              {user.phone ? 'Your number is not in international format (+country code), so SMS and calls cannot reach you.' : 'Without a mobile number, SMS and phone calls cannot reach you.'}
            </p>
          )}
        </div>

        {rules === null ? (
          <Spinner />
        ) : (
          (['high', 'low'] as Urgency[]).map((urgency) => (
            <div key={urgency} className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="eyebrow">{urgency === 'high' ? 'High urgency (SEV1, SEV2)' : 'Low urgency (SEV3, SEV4)'}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRules((current) => [...(current ?? []), withKey({ urgency, channel: 'email', delayMins: 0 })])}
                >
                  <Plus className="size-3.5" />
                  Add
                </Button>
              </div>
              {group(urgency).length === 0 && <p className="text-xs text-subtle">Nothing: you will not be notified at this urgency.</p>}
              {group(urgency).map((rule) => (
                <div key={rule.key} className="flex flex-wrap items-center gap-2 text-xs">
                  <Select
                    className="w-40 flex-1"
                    value={rule.channel}
                    onChange={(event) => update(rule.key, { channel: event.target.value as NotifyChannel })}
                    aria-label="Channel"
                  >
                    {NOTIFY_CHANNELS.map((channel) => (
                      <option key={channel} value={channel}>
                        {NOTIFY_CHANNEL_LABELS[channel]}
                      </option>
                    ))}
                  </Select>
                  <span className="text-subtle">after</span>
                  <Input
                    type="number"
                    min={0}
                    max={120}
                    className="w-16"
                    value={rule.delayMins}
                    onChange={(event) => update(rule.key, { delayMins: Math.max(0, Number(event.target.value) || 0) })}
                    aria-label="Delay in minutes"
                  />
                  <span className="text-subtle">min</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Remove rule"
                    onClick={() => setRules((current) => (current ?? []).filter((item) => item.key !== rule.key))}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          ))
        )}

        {error && (
          <p role="alert" className="text-xs text-[var(--priority-urgent)]">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Button variant="primary" onClick={save} loading={saving} disabled={!rules}>
            Save rules
          </Button>
          <Button onClick={sendTest} loading={testing}>
            <Send className="size-3.5" />
            Send a test page to me
          </Button>
        </div>
        <p className="text-xs text-subtle">
          Phone calls repeat until you acknowledge: press 1 on the call, reply ACK to the SMS, or use the button in the app. Until
          an administrator connects Twilio under <Link to="/oncall" className="text-[var(--accent)] hover:underline">On-call</Link>,
          SMS and calls run in sandbox mode and are only simulated.
        </p>

        {attempts && (
          <ul className="divide-y rounded-sm border text-xs">
            {attempts.length === 0 && <li className="px-3 py-2 text-subtle">No high-urgency channels to test.</li>}
            {attempts.map((attempt) => (
              <li key={attempt.id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
                <span className="font-medium">{NOTIFY_CHANNEL_LABELS[attempt.channel]}</span>
                <span className="min-w-0 flex-1 text-subtle">{attempt.detail}</span>
                <Badge color={ATTEMPT_COLORS[attempt.status]}>{attempt.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
