import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { opsApi } from '@/lib/ops-api';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Field, Input, SegmentedControl } from '@/components/ui/Field';
import { ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import type { TelephonySettings } from '@shared/ops';

/** SMS and voice provider settings. Only shown to on-call managers. */
export function OnCallPhone() {
  const toast = useToast();
  const [settings, setSettings] = useState<TelephonySettings | null>(null);
  const [authToken, setAuthToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    opsApi.telephony
      .get()
      .then((result) => setSettings(result.telephony))
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'Could not load telephony settings.'));
  }, []);

  if (error) return <ErrorPane message={error} />;
  if (!settings) return <LoadingPane />;

  const set = (patch: Partial<TelephonySettings>) => setSettings((current) => (current ? { ...current, ...patch } : current));
  const origin = window.location.origin;

  const save = async () => {
    setSaving(true);
    try {
      const result = await opsApi.telephony.save({ ...settings, authToken: authToken || undefined });
      setSettings(result.telephony);
      setAuthToken('');
      toast.success('Phone and SMS settings saved.');
    } catch (caught) {
      toast.error('Could not save', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-5 p-4 sm:p-6">
      <div className="space-y-2">
        <p className="text-xs font-medium">Provider</p>
        <SegmentedControl
          value={settings.provider}
          onChange={(provider) => set({ provider })}
          options={[
            { value: 'sandbox', label: 'Sandbox' },
            { value: 'twilio', label: 'Twilio' },
          ]}
        />
        <p className="text-xs text-muted">
          {settings.provider === 'sandbox'
            ? 'Nothing leaves this server. Every SMS and call is recorded as "simulated" on the incident, so you can walk a whole escalation without a telephony account.'
            : 'Real SMS and voice calls through your Twilio account. Calls read the alert and take a keypress: 1 acknowledge, 2 escalate now, 3 hear the details.'}
        </p>
      </div>

      {settings.provider === 'twilio' && (
        <div className="space-y-3 rounded-md border p-4 surface">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Account SID">
              <Input value={settings.accountSid ?? ''} onChange={(event) => set({ accountSid: event.target.value })} placeholder="AC…" className="font-mono" />
            </Field>
            <Field label="Auth token" hint={settings.hasAuthToken ? 'Saved. Leave blank to keep it.' : 'Stored encrypted; never shown again.'}>
              <Input
                type="password"
                value={authToken}
                onChange={(event) => setAuthToken(event.target.value)}
                placeholder={settings.hasAuthToken ? '••••••••' : ''}
                autoComplete="off"
              />
            </Field>
            <Field label="From number" hint="E.164, e.g. +27215550100.">
              <Input value={settings.fromNumber ?? ''} onChange={(event) => set({ fromNumber: event.target.value })} placeholder="+27…" />
            </Field>
          </div>
          <div className="rounded-sm border p-3 text-xs surface-2">
            <p className="font-medium">Webhooks for acknowledgements</p>
            <p className="mt-1 text-muted">
              Twilio can only call back to a public https address, so set the App URL under Settings to this server's https
              address first. Then, on the Twilio number, set "A message comes in" to:
            </p>
            <code className="mt-1.5 block break-all rounded-[3px] border px-2 py-1 font-mono text-2xs surface">{origin}/api/webhooks/telephony/twilio/sms</code>
            <p className="mt-2 text-muted">Voice acknowledgements use this address, which InfraTicket passes to each call itself:</p>
            <code className="mt-1.5 block break-all rounded-[3px] border px-2 py-1 font-mono text-2xs surface">{origin}/api/webhooks/telephony/twilio/voice</code>
            <p className="mt-2 text-subtle">If this page is not on the public address, use the App URL in place of {origin}.</p>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Minutes between repeat calls" hint="While a page is unacknowledged.">
          <Input type="number" min={1} max={30} value={settings.voiceRepeatMins} onChange={(event) => set({ voiceRepeatMins: Number(event.target.value) })} />
        </Field>
        <Field label="Calls per person per level" hint="Before voice gives up and the policy escalates.">
          <Input type="number" min={1} max={20} value={settings.voiceMaxCalls} onChange={(event) => set({ voiceMaxCalls: Number(event.target.value) })} />
        </Field>
      </div>

      <Button variant="primary" loading={saving} onClick={save}>
        Save
      </Button>
    </div>
  );
}
