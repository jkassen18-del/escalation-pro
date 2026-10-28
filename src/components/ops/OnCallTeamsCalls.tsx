import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, PhoneCall, Trash2, Upload } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { opsApi } from '@/lib/ops-api';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Field';
import { ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import type { TeamsCallSettings } from '@shared/ops';

/**
 * Ringing the on-call person in Microsoft Teams. Most of this section is the
 * Azure and Entra setup, because that is where every first attempt fails.
 */
export function OnCallTeamsCalls() {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<TeamsCallSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'toggle' | 'upload' | 'remove' | 'test' | null>(null);
  const [testResult, setTestResult] = useState<{ status: string; detail: string } | null>(null);

  useEffect(() => {
    opsApi.teamsCalls
      .get()
      .then((result) => setSettings(result.settings))
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'Could not load Teams call settings.'));
  }, []);

  if (error) return <ErrorPane message={error} />;
  if (!settings) return <LoadingPane />;

  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<void>) => {
    setBusy(kind);
    try {
      await action();
    } catch (caught) {
      toast.error('That did not work', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const webhook = settings.callingWebhookUrl ?? `${window.location.origin}/api/webhooks/msteams/calling`;

  return (
    <section className="space-y-4 rounded-md border p-4 surface">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <PhoneCall className="size-4" /> Teams calls
          </p>
          <p className="mt-1 max-w-xl text-xs text-muted">
            The Teams bot rings the person being paged in Microsoft Teams, on their desktop and on the Teams app on their phone, and
            repeats like a phone call until someone acknowledges. People add "Teams call" to their own notification rules.
          </p>
        </div>
        <Checkbox
          label="Turned on"
          checked={settings.enabled}
          disabled={busy === 'toggle'}
          onChange={(event) =>
            void run('toggle', async () => {
              setSettings((await opsApi.teamsCalls.setEnabled(event.target.checked)).settings);
            })
          }
        />
      </div>

      <ol className="space-y-2 text-xs">
        <Step done={settings.botConfigured}>
          The Teams integration is in <strong>bot mode</strong> with the app id, client secret and <strong>tenant id</strong> filled in
          (Integrations → Microsoft Teams).
        </Step>
        <Step done={Boolean(settings.callingWebhookUrl)}>
          The App URL in Settings is a public <strong>https</strong> address. Microsoft posts call events to it; a reverse proxy or tunnel
          that exposes only <code className="font-mono">/api/webhooks/*</code> and <code className="font-mono">/api/public/*</code> is enough.
        </Step>
        <Step>
          In the Azure portal: your Azure Bot → Channels → Microsoft Teams → <strong>Calling</strong> → Enable calling, and set the
          webhook (for calling) to
          <code className="mt-1 block break-all rounded-[3px] border px-2 py-1 font-mono text-2xs surface-2">{webhook}</code>
        </Step>
        <Step>
          In Entra ID: App registrations → the bot's app → API permissions → Add → Microsoft Graph → <strong>Application</strong>{' '}
          permissions: <code className="font-mono">Calls.Initiate.All</code>, <code className="font-mono">Calls.AccessMedia.All</code>{' '}
          and <code className="font-mono">User.Read.All</code> → <strong>Grant admin consent</strong>.
        </Step>
        <Step>
          Download the Teams app package again from Integrations → Microsoft Teams (it now declares calling) and update the app in the
          Teams admin centre.
        </Step>
      </ol>

      <div className="space-y-2 rounded-sm border p-3 surface-2">
        <p className="text-xs font-medium">Spoken prompt</p>
        {settings.hasPrompt ? (
          <p className="text-xs text-muted">
            A prompt is uploaded. Callers hear it and press <strong>1</strong> to acknowledge or <strong>2</strong> to escalate.
          </p>
        ) : (
          <p className="text-xs text-muted">
            Without a prompt, answering is recorded but does <strong>not</strong> acknowledge: the person still acknowledges from the
            Teams card or the web, and the calls keep coming until they do.
          </p>
        )}
        <p className="text-2xs text-subtle">
          Teams plays recordings only, no text-to-speech: a WAV file, mono, 16-bit, 16 kHz, up to 512 KB. Record something like "This is
          InfraTicket. You are being paged for an incident. Press 1 to acknowledge, or 2 to escalate." In Audacity: set the project rate to
          16000 Hz and the track to mono, then File → Export → WAV, signed 16-bit PCM.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".wav,audio/wav"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file)
                void run('upload', async () => {
                  setSettings((await opsApi.teamsCalls.uploadPrompt(file)).settings);
                  toast.success('Prompt uploaded');
                });
            }}
          />
          <Button size="sm" loading={busy === 'upload'} onClick={() => fileRef.current?.click()}>
            <Upload className="size-3.5" /> {settings.hasPrompt ? 'Replace prompt' : 'Upload prompt'}
          </Button>
          {settings.hasPrompt && (
            <Button
              size="sm"
              variant="ghost"
              loading={busy === 'remove'}
              onClick={() =>
                void run('remove', async () => {
                  setSettings((await opsApi.teamsCalls.removePrompt()).settings);
                })
              }
            >
              <Trash2 className="size-3.5" /> Remove
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Button
          disabled={!settings.enabled}
          loading={busy === 'test'}
          onClick={() =>
            void run('test', async () => {
              setTestResult((await opsApi.teamsCalls.test()).result);
            })
          }
        >
          <PhoneCall className="size-3.5" /> Call me in Teams now
        </Button>
        {!settings.enabled && <p className="text-2xs text-subtle">Turn Teams calls on to place a test call.</p>}
        {testResult && (
          <p
            className={
              testResult.status === 'sent'
                ? 'rounded-sm border border-[var(--status-resolved)]/40 px-2.5 py-2 text-xs'
                : 'rounded-sm border border-[var(--priority-urgent)]/40 bg-[var(--priority-urgent)]/5 px-2.5 py-2 text-xs'
            }
          >
            {testResult.detail}
          </p>
        )}
      </div>
    </section>
  );
}

function Step({ done, children }: { done?: boolean; children: React.ReactNode }) {
  const Icon = done ? CheckCircle2 : Circle;
  return (
    <li className="flex gap-2">
      <Icon className={done ? 'mt-0.5 size-3.5 shrink-0 text-[var(--status-resolved)]' : 'mt-0.5 size-3.5 shrink-0 text-[var(--fg-subtle)]'} />
      <span className="min-w-0 text-muted">{children}</span>
    </li>
  );
}
