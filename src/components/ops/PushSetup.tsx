import { useCallback, useEffect, useState } from 'react';
import { BellRing, Smartphone } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { opsApi } from '@/lib/ops-api';
import { currentSubscription, disablePush, enablePush, isIos, pushSupport, type PushSupport } from '@/lib/push';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';

const WHY_NOT: Record<Exclude<PushSupport, { ok: true }>['reason'], string> = {
  insecure:
    'Push needs InfraTicket to be opened over https (or on localhost). Open it at its https address, e.g. https://tickets.lab.yourcompany.com, then come back here.',
  unsupported: 'This browser cannot receive push notifications. Use Chrome, Edge or Firefox, or Safari on an iPhone added to the home screen.',
  'ios-not-installed':
    'On an iPhone, push only works from the home-screen app: tap Share → Add to Home Screen, open InfraTicket from the new icon, then come back here (iOS 16.4 or newer).',
  denied: 'Notifications are blocked for InfraTicket. Allow them in the browser\'s site settings (or the phone\'s Settings → Notifications), then reload.',
};

/** "Phone notifications": turning push on for this device, and proving it works. */
export function PushSetup() {
  const toast = useToast();
  const [support] = useState(pushSupport);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<number | null>(null);
  const [busy, setBusy] = useState<'toggle' | 'test' | null>(null);
  const [testResult, setTestResult] = useState<{ status: string; detail: string } | null>(null);

  const refresh = useCallback(async () => {
    setSubscribed(Boolean(await currentSubscription().catch(() => null)));
    setDevices((await opsApi.me.push().catch(() => ({ devices: 0 }))).devices);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async () => {
    setBusy('toggle');
    try {
      if (subscribed) await disablePush();
      else await enablePush();
      await refresh();
      toast.success(subscribed ? 'Push turned off on this device' : 'Push turned on for this device');
    } catch (caught) {
      toast.error('Could not change push', caught instanceof Error ? caught.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    try {
      setTestResult((await opsApi.me.testPush()).result);
    } catch (caught) {
      toast.error('Test failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3 rounded-sm border p-3 surface-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <Smartphone className="size-3.5" /> Phone notifications
        </p>
        {subscribed !== null && (
          <Badge color={subscribed ? 'var(--status-resolved)' : 'var(--status-closed)'}>
            {subscribed ? 'On for this device' : 'Off for this device'}
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted">
        Pages arrive as notifications with an <strong>Acknowledge</strong> button, even with InfraTicket closed.
        {devices ? ` ${devices} device${devices === 1 ? '' : 's'} of yours ${devices === 1 ? 'is' : 'are'} set up.` : ''}
      </p>

      {support.ok ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={subscribed ? 'secondary' : 'primary'} loading={busy === 'toggle'} onClick={toggle}>
            <BellRing className="size-3.5" /> {subscribed ? 'Turn off on this device' : 'Turn on for this device'}
          </Button>
          <Button size="sm" loading={busy === 'test'} disabled={!devices} onClick={test}>
            Send a test notification
          </Button>
        </div>
      ) : (
        <p className="rounded-sm border border-[var(--priority-high)]/40 bg-[var(--priority-high)]/5 px-2.5 py-2 text-xs">{WHY_NOT[support.reason]}</p>
      )}
      {testResult && <p className="text-xs text-subtle">{testResult.detail}</p>}

      <ul className="list-disc space-y-1 pl-4 text-2xs text-subtle">
        {isIos() ? (
          <li>iPhone: Share → Add to Home Screen, open InfraTicket from the home screen, then turn it on here (iOS 16.4+).</li>
        ) : (
          <li>Android: open InfraTicket in Chrome, turn it on here and allow notifications. "Install app" from the menu keeps it one tap away.</li>
        )}
        <li>Turn it on on each phone and computer you want paged on.</li>
        <li>
          Notifications reach you anywhere, but tapping Acknowledge needs the phone to reach InfraTicket (company Wi-Fi, VPN, or the
          tunnel). If it cannot, the notification opens InfraTicket instead.
        </li>
      </ul>
    </div>
  );
}
