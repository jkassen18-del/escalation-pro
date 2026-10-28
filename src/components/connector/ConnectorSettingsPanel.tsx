import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { connectorApi, SCOPE_LABELS } from '@/lib/connector-api';
import { fullDateTime, relativeTime } from '@/lib/format';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, SegmentedControl, Textarea } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Badge';
import { CopyField } from '@/components/ops/MonitorShared';
import { CopyBlock } from '@/components/connector/CopyBlock';
import type { ApiToken, ConfidentialClient, ConnectorInfo, ConnectorSettings } from '@shared/connector';

/**
 * Settings → AI connectors (MCP): whether Claude and other MCP clients may
 * connect at all, whether they may change anything, the address they are
 * given, OAuth clients for tools that need a client id and secret, and every
 * personal access token in the organisation.
 */
export function ConnectorSettingsPanel() {
  const toast = useToast();
  const [info, setInfo] = useState<ConnectorInfo | null>(null);
  const [draft, setDraft] = useState<ConnectorSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [clients, setClients] = useState<ConfidentialClient[]>([]);
  const [newClientName, setNewClientName] = useState('');
  const [secret, setSecret] = useState<{ clientId: string; clientSecret: string } | null>(null);
  const [redirectDrafts, setRedirectDrafts] = useState<Record<string, string>>({});

  const load = async () => {
    const [i, t, c] = await Promise.all([connectorApi.info(), connectorApi.allTokens(), connectorApi.clients()]);
    setInfo(i);
    setDraft(i.settings);
    setTokens(t);
    setClients(c);
    setRedirectDrafts(Object.fromEntries(c.map((client) => [client.clientId, client.redirectUris.join('\n')])));
  };

  useEffect(() => {
    void load().catch(() => toast.error('Could not load the AI connector settings.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!info || !draft) return null;
  const base = info.mcpUrl.replace(/\/mcp$/, '');

  const save = async () => {
    setSaving(true);
    try {
      await connectorApi.saveSettings(draft);
      await load();
      toast.success('AI connector settings saved.');
    } catch (caught) {
      toast.error('Could not save', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const createClient = async () => {
    try {
      const created = await connectorApi.createClient({ name: newClientName, redirectUris: [] });
      setSecret({ clientId: created.client.clientId, clientSecret: created.clientSecret });
      setNewClientName('');
      await load();
    } catch (caught) {
      toast.error('Could not create the client', caught instanceof ApiError ? caught.message : undefined);
    }
  };

  const saveRedirects = async (client: ConfidentialClient) => {
    try {
      const uris = (redirectDrafts[client.clientId] ?? '').split(/\s+/).filter(Boolean);
      await connectorApi.updateClient(client.clientId, { redirectUris: uris });
      await load();
      toast.success('Callback URLs saved.');
    } catch (caught) {
      toast.error('Could not save', caught instanceof ApiError ? caught.message : undefined);
    }
  };

  return (
    <section className="rounded-md border surface" id="ai-connectors">
      <header className="border-b px-4 py-2.5">
        <h2 className="text-xs font-semibold">AI connectors (MCP)</h2>
        <p className="mt-0.5 text-xs text-muted">
          Let Claude, Microsoft Copilot Studio, GitHub Copilot and other MCP clients work with InfraTicket. They always act as the person
          who connected them, within that person's permissions.
        </p>
      </header>

      <div className="space-y-5 px-4 py-4">
        <Checkbox
          label="Allow AI assistants to connect"
          hint="Turning this off stops every token and connected app at once."
          checked={draft.enabled}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
        />

        <Field label="What they may do" hint="Read only overrides every token and approval: no AI assistant can change anything.">
          <SegmentedControl
            value={draft.mode}
            onChange={(mode) => setDraft({ ...draft, mode })}
            options={[
              { value: 'read_write', label: 'Read and write' },
              { value: 'read_only', label: 'Read only' },
            ]}
          />
        </Field>

        <Field
          label="Public address"
          htmlFor="connectorUrl"
          hint="The https address AI clients use, e.g. your reverse proxy or tunnel. Leave empty to use the App URL. Changing it disconnects OAuth apps, whose tokens are bound to the address."
        >
          <Input
            id="connectorUrl"
            value={draft.publicUrl}
            placeholder="https://tickets.example.com"
            onChange={(event) => setDraft({ ...draft, publicUrl: event.target.value })}
          />
        </Field>

        <Button variant="primary" size="sm" onClick={save} loading={saving}>
          Save
        </Button>

        <div className="space-y-1">
          <p className="text-2xs font-medium uppercase tracking-wide text-subtle">MCP server address</p>
          <CopyField value={info.mcpUrl} />
          {!info.publicHttps && (
            <p className="text-xs text-muted">
              Not a public https address: claude.ai and Copilot Studio cannot reach it. Claude Code, Claude Desktop and VS Code on your network can.
            </p>
          )}
        </div>

        {/* Connection instructions */}
        <div className="space-y-2 border-t pt-4">
          <h3 className="text-xs font-semibold">How people connect</h3>
          <ul className="list-disc space-y-1 pl-4 text-xs text-muted">
            <li>
              <b>claude.ai</b>: Settings → Connectors → Add custom connector, paste the address. Each person signs in and approves.
            </li>
            <li>
              <b>Claude Code, Claude Desktop, VS Code</b>: each person creates a token under Profile → Connect Claude, which shows the exact command or config.
            </li>
            <li>
              <b>Copilot Studio</b>: Tools → Add a tool → New tool → Model Context Protocol. Use <i>OAuth 2.0 → Dynamic discovery</i> (nothing to
              configure), <i>OAuth 2.0 → Manual</i> with a client below, or <i>API key → Header</i> named <code>X-InfraTicket-Token</code> with a
              personal token.
            </li>
          </ul>
        </div>

        {/* Manual OAuth */}
        <div className="space-y-3 border-t pt-4">
          <div>
            <h3 className="text-xs font-semibold">OAuth clients (Copilot Studio "Manual" and similar)</h3>
            <p className="mt-0.5 text-xs text-muted">
              For tools that ask for a client ID and secret. Create a client, paste these values into the tool, then paste the callback URL
              it shows you back here.
            </p>
          </div>

          <dl className="grid gap-2 text-xs sm:grid-cols-[9rem_1fr] sm:items-center">
            <dt className="text-subtle">Server URL</dt>
            <dd><CopyField value={info.mcpUrl} /></dd>
            <dt className="text-subtle">Authorization URL</dt>
            <dd><CopyField value={`${base}/oauth/authorize`} /></dd>
            <dt className="text-subtle">Token URL</dt>
            <dd><CopyField value={`${base}/oauth/token`} /></dd>
            <dt className="text-subtle">Refresh URL</dt>
            <dd><CopyField value={`${base}/oauth/token`} /></dd>
            <dt className="text-subtle">Scopes</dt>
            <dd><CopyField value="read_write" /></dd>
          </dl>
          <p className="text-xs text-subtle">
            Use the scope <code>read</code> instead for an agent that should only look things up.
          </p>

          {secret && (
            <div className="space-y-2 rounded-sm border border-[#16a34a]/40 p-3">
              <p className="text-xs">
                <b>Copy the client secret now</b> - it won't be shown again.
              </p>
              <CopyBlock code={`Client ID:      ${secret.clientId}\nClient secret:  ${secret.clientSecret}`} />
              <Button variant="secondary" size="sm" onClick={() => setSecret(null)}>
                Done
              </Button>
            </div>
          )}

          <div className="flex gap-2">
            <Input value={newClientName} placeholder="Copilot Studio - IT helpdesk agent" onChange={(e) => setNewClientName(e.target.value)} />
            <Button variant="secondary" size="sm" disabled={!newClientName.trim()} onClick={createClient}>
              Create client
            </Button>
          </div>

          {clients.map((client) => (
            <div key={client.clientId} className="space-y-2 rounded-sm border p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">{client.name}</span>
                <code className="font-mono text-2xs text-subtle">{client.clientId}</code>
                <span className="text-subtle">created {relativeTime(client.createdAt)}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={async () => {
                    if (!window.confirm(`Delete "${client.name}"? Everyone using it is disconnected.`)) return;
                    await connectorApi.deleteClient(client.clientId);
                    await load();
                  }}
                >
                  Delete
                </Button>
              </div>
              <Field label="Callback (redirect) URLs" hint="One per line. Copilot Studio shows its callback URL after you create the tool.">
                <Textarea
                  rows={2}
                  className="font-mono text-2xs"
                  value={redirectDrafts[client.clientId] ?? ''}
                  onChange={(e) => setRedirectDrafts({ ...redirectDrafts, [client.clientId]: e.target.value })}
                />
              </Field>
              <Button variant="secondary" size="sm" onClick={() => saveRedirects(client)}>
                Save callback URLs
              </Button>
              {client.redirectUris.length === 0 && <Badge dot color="#d97706">Not usable until a callback URL is added</Badge>}
            </div>
          ))}
        </div>

        {/* Every token */}
        <div className="space-y-2 border-t pt-4">
          <h3 className="text-xs font-semibold">Personal access tokens ({tokens.length})</h3>
          {tokens.length === 0 ? (
            <p className="text-xs text-subtle">Nobody has created one yet.</p>
          ) : (
            <ul className="divide-y rounded-sm border">
              {tokens.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                  <span className="font-medium">{t.userName}</span>
                  <span>{t.name}</span>
                  <code className="font-mono text-2xs text-subtle">{t.prefix}</code>
                  <Badge dot={false}>{SCOPE_LABELS[t.scope]}</Badge>
                  <span className="text-subtle">{t.lastUsedAt ? `used ${relativeTime(t.lastUsedAt)}` : 'never used'}</span>
                  <span className="text-subtle">{t.expiresAt ? `expires ${fullDateTime(t.expiresAt)}` : 'no expiry'}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={async () => {
                      if (!window.confirm(`Revoke ${t.userName}'s token "${t.name}"?`)) return;
                      await connectorApi.revokeToken(t.id);
                      setTokens((current) => current.filter((x) => x.id !== t.id));
                      toast.success('Token revoked');
                    }}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
