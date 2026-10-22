import { useEffect, useState } from 'react';
import { Download, Plus, Trash2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { ROLE_LABELS } from '@/lib/format';
import { ssoApi } from '@/lib/sso-api';
import { useToast } from '@/components/ui/Toast';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { CopyField } from '@/components/ops/MonitorShared';
import { USER_ROLES, type Team, type UserRole } from '@shared/types';
import { ENTRA_CLAIMS, type SamlServiceProvider, type SamlSettings, type SsoProvider } from '@shared/sso';

/**
 * "Single sign-on (SAML)" on the Settings page. Saved on its own, apart from
 * the organisation settings above it: turning SSO on or off is a decision of
 * its own and should not ride along with a change to the SLA defaults.
 */
export function SsoSettings({ teams }: { teams: Team[] }) {
  const toast = useToast();
  const [settings, setSettings] = useState<SamlSettings | null>(null);
  const [sp, setSp] = useState<SamlServiceProvider | null>(null);
  const [metadataUrl, setMetadataUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    void ssoApi
      .get()
      .then((result) => {
        setSettings(result.settings);
        setSp(result.serviceProvider);
      })
      .catch(() => setLoadError(true));
  }, []);

  if (loadError) return null;
  if (!settings || !sp) return <SsoShell status={null}>{<p className="text-xs text-subtle">Loading…</p>}</SsoShell>;

  const set = <K extends keyof SamlSettings>(key: K, value: SamlSettings[K]) =>
    setSettings((current) => (current ? { ...current, [key]: value } : current));

  const importMetadata = async () => {
    setImporting(true);
    setError(null);
    try {
      const { metadata } = await ssoApi.importMetadata(metadataUrl);
      setSettings((current) =>
        current ? { ...current, idpEntityId: metadata.entityId, idpLoginUrl: metadata.loginUrl, idpCertificate: metadata.certificate } : current,
      );
      toast.success('Identity provider details imported', 'Review them, then save.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not read that metadata URL.');
    } finally {
      setImporting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await ssoApi.save(settings);
      setSettings(result.settings);
      setSp(result.serviceProvider);
      toast.success(result.settings.enabled ? 'Single sign-on is on' : 'Single sign-on settings saved');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save single sign-on.');
    } finally {
      setSaving(false);
    }
  };

  const status = settings.enabled ? (settings.requireSso ? 'required' : 'on') : 'off';
  const isEntra = settings.provider === 'entra';

  return (
    <SsoShell status={status}>
      <Field label="Identity provider">
        <Select
          value={settings.provider}
          onChange={(event) => {
            const provider = event.target.value as SsoProvider;
            setSettings((current) =>
              current
                ? {
                    ...current,
                    provider,
                    buttonLabel:
                      current.buttonLabel === 'Sign in with Microsoft' || current.buttonLabel === 'Sign in with SSO'
                        ? provider === 'entra'
                          ? 'Sign in with Microsoft'
                          : 'Sign in with SSO'
                        : current.buttonLabel,
                  }
                : current,
            );
          }}
        >
          <option value="entra">Microsoft Entra ID</option>
          <option value="generic">Another SAML 2.0 provider</option>
        </Select>
      </Field>

      <Step number={1} title={isEntra ? 'Give these to Entra ID' : 'Give these to your identity provider'}>
        <p className="text-xs text-subtle">
          {isEntra
            ? 'In Entra ID: Enterprise applications → New application → Create your own application → Integrate any other application. Then Single sign-on → SAML → Basic SAML Configuration.'
            : 'Register this app as a SAML service provider with these values, or upload the metadata file.'}
        </p>
        {!sp.fromAppUrl && (
          <p className="rounded-sm border border-[var(--priority-high)]/40 bg-[var(--priority-high)]/5 px-2.5 py-2 text-xs">
            These are built from the address you are using now. Set the App URL above first if people reach this app by another address.
          </p>
        )}
        <Field label={isEntra ? 'Identifier (Entity ID)' : 'Entity ID'}>
          <CopyField value={sp.entityId} />
        </Field>
        <Field label={isEntra ? 'Reply URL (Assertion Consumer Service URL)' : 'Assertion consumer service (HTTP-POST)'}>
          <CopyField value={sp.acsUrl} />
        </Field>
        <Field label="Sign on URL">
          <CopyField value={sp.signOnUrl} />
        </Field>
        <a href="/api/auth/saml/metadata?download" className="inline-flex items-center gap-1.5 text-xs text-[var(--accent)] underline-offset-2 hover:underline">
          <Download className="size-3.5" />
          Download service provider metadata
        </a>
      </Step>

      <Step number={2} title={isEntra ? 'Paste what Entra ID gives you' : 'Paste your provider’s details'}>
        <Field
          label={isEntra ? 'App Federation Metadata URL' : 'Federation metadata URL'}
          hint={isEntra ? 'From "SAML Certificates" in Entra. Fills in the three fields below.' : 'Optional: fills in the three fields below.'}
        >
          <div className="flex gap-2">
            <Input
              value={metadataUrl}
              onChange={(event) => setMetadataUrl(event.target.value)}
              placeholder="https://login.microsoftonline.com/<tenant>/federationmetadata/2007-06/federationmetadata.xml?appid=…"
              className="font-mono text-xs"
            />
            <Button onClick={() => void importMetadata()} loading={importing} disabled={!metadataUrl.startsWith('https://')}>
              Import
            </Button>
          </div>
        </Field>
        <Field label={isEntra ? 'Microsoft Entra Identifier' : 'Identity provider entity ID'}>
          <Input value={settings.idpEntityId} onChange={(event) => set('idpEntityId', event.target.value)} placeholder="https://sts.windows.net/<tenant-id>/" className="font-mono text-xs" />
        </Field>
        <Field label="Login URL">
          <Input value={settings.idpLoginUrl} onChange={(event) => set('idpLoginUrl', event.target.value)} placeholder="https://login.microsoftonline.com/<tenant-id>/saml2" className="font-mono text-xs" />
        </Field>
        <Field label="Signing certificate" hint={isEntra ? 'The "Certificate (Base64)" download. Paste two during a certificate rollover.' : 'PEM or Base64. Paste two during a certificate rollover.'}>
          <Textarea
            value={settings.idpCertificate}
            onChange={(event) => set('idpCertificate', event.target.value)}
            rows={4}
            placeholder="-----BEGIN CERTIFICATE-----"
            className="font-mono text-2xs"
          />
        </Field>
      </Step>

      <Step number={3} title="Who can sign in">
        <Checkbox
          checked={settings.jitEnabled}
          onChange={(event) => set('jitEnabled', event.target.checked)}
          label="Create accounts on first sign-in"
          hint="Off: only people who already have an account here (matched by email) can sign in. On: anyone your identity provider lets in gets an account."
        />
        {settings.jitEnabled && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Role for new accounts">
              <Select value={settings.jitRole} onChange={(event) => set('jitRole', event.target.value as UserRole)}>
                {USER_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Team for new accounts">
              <Select value={settings.jitTeamId ?? ''} onChange={(event) => set('jitTeamId', event.target.value || null)}>
                <option value="">No team</option>
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs font-medium">Roles from groups</p>
          <p className="text-xs text-subtle">
            Map {isEntra ? 'Entra group object IDs' : 'group values'} to a role; it is applied at every sign-in, and the highest match wins.
            Administrators are never changed by a mapping.{isEntra && ' In Entra, add a group claim under Attributes & Claims.'}
          </p>
          {settings.groupRoles.map((entry, index) => (
            <div key={index} className="flex gap-2">
              <Input
                value={entry.group}
                onChange={(event) => set('groupRoles', settings.groupRoles.map((item, i) => (i === index ? { ...item, group: event.target.value } : item)))}
                placeholder="00000000-0000-0000-0000-000000000000"
                className="font-mono text-xs"
              />
              <Select
                value={entry.role}
                onChange={(event) => set('groupRoles', settings.groupRoles.map((item, i) => (i === index ? { ...item, role: event.target.value as UserRole } : item)))}
                className="w-40 shrink-0"
              >
                {USER_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </Select>
              <Button variant="ghost" size="icon" aria-label="Remove mapping" onClick={() => set('groupRoles', settings.groupRoles.filter((_, i) => i !== index))}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button size="sm" onClick={() => set('groupRoles', [...settings.groupRoles, { group: '', role: 'agent' }])}>
            <Plus className="size-3.5" />
            Add mapping
          </Button>
        </div>

        <details className="rounded-sm border px-3 py-2 surface-2">
          <summary className="cursor-pointer text-xs font-medium">Claim names</summary>
          <div className="mt-3 space-y-3">
            <Field label="Email" hint="Falls back to the Name ID when it looks like an email address.">
              <Input value={settings.emailAttribute} onChange={(event) => set('emailAttribute', event.target.value)} className="font-mono text-2xs" />
            </Field>
            <Field label="Display name" hint="Falls back to given name + surname.">
              <Input value={settings.nameAttribute} onChange={(event) => set('nameAttribute', event.target.value)} className="font-mono text-2xs" />
            </Field>
            <Field label="Groups">
              <Input value={settings.groupsAttribute} onChange={(event) => set('groupsAttribute', event.target.value)} className="font-mono text-2xs" />
            </Field>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setSettings((current) =>
                  current ? { ...current, emailAttribute: ENTRA_CLAIMS.email, nameAttribute: ENTRA_CLAIMS.name, groupsAttribute: ENTRA_CLAIMS.groups } : current,
                )
              }
            >
              Reset to Entra ID defaults
            </Button>
          </div>
        </details>
      </Step>

      <Step number={4} title="Turn it on">
        <Field label="Button text">
          <Input value={settings.buttonLabel} onChange={(event) => set('buttonLabel', event.target.value)} />
        </Field>
        <Checkbox checked={settings.enabled} onChange={(event) => set('enabled', event.target.checked)} label="Offer single sign-on on the sign-in page" />
        <Checkbox
          checked={settings.requireSso}
          disabled={!settings.enabled}
          onChange={(event) => set('requireSso', event.target.checked)}
          label="Require single sign-on for everyone except administrators"
          hint="Password sign-in is refused for everyone else. Administrators keep their password, so a broken identity provider can never lock everyone out."
        />
      </Step>

      {error && (
        <div role="alert" className="rounded-sm border border-[var(--priority-urgent)]/30 bg-[var(--priority-urgent)]/5 px-2.5 py-2 text-xs text-[var(--priority-urgent)]">
          {error}
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="primary" size="sm" loading={saving} onClick={() => void save()}>
          Save single sign-on
        </Button>
      </div>
    </SsoShell>
  );
}

function SsoShell({ status, children }: { status: 'off' | 'on' | 'required' | null; children: React.ReactNode }) {
  return (
    <section className="rounded-md border surface">
      <header className="flex items-start justify-between gap-3 border-b px-4 py-2.5">
        <div>
          <h2 className="text-xs font-semibold">Single sign-on (SAML)</h2>
          <p className="mt-0.5 text-xs text-muted">Let people sign in with their Microsoft work account, or any SAML 2.0 identity provider.</p>
        </div>
        {status && (
          <Badge color={status === 'off' ? 'var(--fg-subtle)' : '#16a34a'}>
            {status === 'off' ? 'Off' : status === 'required' ? 'Required' : 'On'}
          </Badge>
        )}
      </header>
      <div className="space-y-5 px-4 py-4">{children}</div>
    </section>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-xs font-semibold">
        <span className="flex size-5 items-center justify-center rounded-full border text-2xs">{number}</span>
        {title}
      </p>
      <div className="space-y-3 pl-7">{children}</div>
    </div>
  );
}
