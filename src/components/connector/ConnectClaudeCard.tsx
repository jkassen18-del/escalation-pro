import { useEffect, useState, type FormEvent } from 'react';
import { Sparkles } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { connectorApi, connectorSnippets, SCOPE_LABELS } from '@/lib/connector-api';
import { fullDateTime, relativeTime } from '@/lib/format';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Field, Input, SegmentedControl, Select } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/Modal';
import { CopyField } from '@/components/ops/MonitorShared';
import { CopyBlock, SnippetTabs } from '@/components/connector/CopyBlock';
import type { ApiToken, ConnectedApp, ConnectorInfo, ConnectorScope } from '@shared/connector';

/**
 * Profile → Connect Claude: personal access tokens for Claude Code, Claude
 * Desktop, VS Code and Copilot Studio, and the apps (claude.ai) that were
 * approved through OAuth. Everything here acts as you, with your permissions.
 */
export function ConnectClaudeCard() {
  const toast = useToast();
  const [info, setInfo] = useState<ConnectorInfo | null>(null);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<ConnectorScope>('read');
  const [expiry, setExpiry] = useState('90');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ token: string; record: ApiToken } | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const [disconnecting, setDisconnecting] = useState<ConnectedApp | null>(null);

  const load = () =>
    Promise.all([connectorApi.info(), connectorApi.tokens(), connectorApi.apps()])
      .then(([i, t, a]) => {
        setInfo(i);
        setTokens(t);
        setApps(a);
      })
      .catch(() => setInfo(null));

  useEffect(() => {
    void load();
  }, []);

  if (!info) return null;
  const { settings, mcpUrl, publicHttps } = info;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await connectorApi.createToken({ name, scope, expiresInDays: expiry === 'never' ? null : Number(expiry) });
      setFresh(created);
      setName('');
      setTokens((current) => [created.record, ...current]);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the token.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-md border surface" id="connect-claude">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Sparkles className="size-3.5" />
        <h2 className="text-xs font-semibold">Connect Claude</h2>
        {settings.enabled && settings.mode === 'read_only' && (
          <Badge dot={false} className="ml-auto">
            Read only for everyone
          </Badge>
        )}
      </div>

      {!settings.enabled ? (
        <p className="px-4 py-4 text-xs text-muted">An administrator has turned off connecting AI assistants to InfraTicket.</p>
      ) : (
        <div className="space-y-5 px-4 py-4">
          <p className="text-xs text-muted">
            Let Claude search tickets, check who is on call, summarise incidents and - if you allow it - comment, update and raise tickets.
            It acts as you: it sees only what you can see and can do only what you can do. Every change it makes is recorded as{' '}
            <i>you via Claude</i> in the audit log.
          </p>

          <div>
            <p className="text-2xs font-medium uppercase tracking-wide text-subtle">MCP server address</p>
            <CopyField value={mcpUrl} className="mt-1" />
          </div>

          {/* claude.ai */}
          <div className="space-y-1.5">
            <h3 className="text-xs font-semibold">claude.ai (web and mobile)</h3>
            <p className="text-xs text-muted">
              In Claude, open <b>Settings → Connectors → Add custom connector</b>, paste the address above, then sign in here and approve.
              No token needed.
            </p>
            {!publicHttps && (
              <p className="rounded-sm border border-[var(--color-brass-400)]/45 bg-[var(--color-brass-50)] px-2.5 py-2 text-xs dark:bg-[var(--color-brass-900)]/20">
                claude.ai connects from Anthropic's servers, so it needs a public https address. This one isn't - ask an administrator to
                set one up (for example with a Cloudflare Tunnel). Claude Code and Claude Desktop work with a token on your own network.
              </p>
            )}
          </div>

          {/* Tokens */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold">Access tokens (Claude Code, Claude Desktop, VS Code, Copilot Studio)</h3>

            {fresh ? (
              <div className="space-y-3 rounded-sm border border-[#16a34a]/40 p-3">
                <p className="text-xs">
                  <b>Copy your token now</b> - it won't be shown again. Anyone with it can act as you{' '}
                  {fresh.record.scope === 'read' ? '(read only)' : '(read and write)'}.
                </p>
                <CopyBlock code={fresh.token} label="Copy token" />
                <SnippetTabs snippets={connectorSnippets(mcpUrl, fresh.token)} />
                <Button variant="secondary" size="sm" onClick={() => setFresh(null)}>
                  Done
                </Button>
              </div>
            ) : (
              <form onSubmit={create} className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
                <Field label="Name" htmlFor="tokenName" error={error ?? undefined}>
                  <Input id="tokenName" value={name} maxLength={80} placeholder="Laptop - Claude Code" onChange={(e) => setName(e.target.value)} required />
                </Field>
                <Field label="Access">
                  <SegmentedControl
                    value={scope}
                    onChange={setScope}
                    options={[
                      { value: 'read', label: 'Read only' },
                      { value: 'read_write', label: 'Read and write' },
                    ]}
                  />
                </Field>
                <Field label="Expires" htmlFor="tokenExpiry">
                  <Select id="tokenExpiry" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                    <option value="30">30 days</option>
                    <option value="90">90 days</option>
                    <option value="365">1 year</option>
                    <option value="never">Never</option>
                  </Select>
                </Field>
                <div className="sm:col-span-3">
                  <Button type="submit" variant="primary" size="sm" loading={busy}>
                    Create token
                  </Button>
                </div>
              </form>
            )}

            {tokens.length > 0 && (
              <ul className="divide-y rounded-sm border">
                {tokens.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                    <span className="font-medium">{t.name}</span>
                    <code className="font-mono text-2xs text-subtle">{t.prefix}</code>
                    <Badge dot={false}>{SCOPE_LABELS[t.scope]}</Badge>
                    <span className="text-subtle" title={t.lastUsedAt ? fullDateTime(t.lastUsedAt) : undefined}>
                      {t.lastUsedAt ? `used ${relativeTime(t.lastUsedAt)}` : 'never used'}
                    </span>
                    <span className="text-subtle">{t.expiresAt ? `expires ${fullDateTime(t.expiresAt)}` : 'no expiry'}</span>
                    <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setRevoking(t)}>
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {!fresh && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted">Setup instructions for each app</summary>
                <div className="mt-2">
                  <SnippetTabs snippets={connectorSnippets(mcpUrl)} />
                </div>
              </details>
            )}
          </div>

          {/* OAuth apps */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold">Connected apps</h3>
            {apps.length === 0 ? (
              <p className="text-xs text-subtle">None yet. Apps you approve from claude.ai or Copilot Studio appear here.</p>
            ) : (
              <ul className="divide-y rounded-sm border">
                {apps.map((app) => (
                  <li key={app.grantId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                    <span className="font-medium">{app.clientName}</span>
                    <Badge dot={false}>{SCOPE_LABELS[app.scope]}</Badge>
                    <span className="text-subtle">connected {relativeTime(app.createdAt)}</span>
                    <span className="text-subtle">{app.lastUsedAt ? `used ${relativeTime(app.lastUsedAt)}` : 'not used yet'}</span>
                    <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setDisconnecting(app)}>
                      Disconnect
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        title="Revoke this token?"
        message={`Anything using "${revoking?.name}" stops working immediately.`}
        confirmLabel="Revoke"
        destructive
        onConfirm={() => void (async () => {
          if (!revoking) return;
          await connectorApi.revokeToken(revoking.id);
          setTokens((current) => current.filter((t) => t.id !== revoking.id));
          setRevoking(null);
          toast.success('Token revoked');
        })()}
      />
      <ConfirmDialog
        open={Boolean(disconnecting)}
        onClose={() => setDisconnecting(null)}
        title={`Disconnect ${disconnecting?.clientName ?? 'this app'}?`}
        message="It loses access at once. You can connect it again from the app."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => void (async () => {
          if (!disconnecting) return;
          await connectorApi.disconnectApp(disconnecting.grantId);
          setApps((current) => current.filter((a) => a.grantId !== disconnecting.grantId));
          setDisconnecting(null);
          toast.success('Disconnected');
        })()}
      />
    </section>
  );
}
