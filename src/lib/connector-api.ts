import { ApiError } from '@/lib/api';
import type {
  ApiToken,
  ConfidentialClient,
  ConnectedApp,
  ConnectorInfo,
  ConnectorScope,
  ConnectorSettings,
  OAuthConsentRequest,
} from '@shared/connector';

/** Client for /api/connector: the MCP connector's tokens, apps, consent and settings. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/connector${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    throw new ApiError(response.status, payload?.error ?? `Request failed with status ${response.status}`, payload?.details);
  }
  return payload as T;
}

export const connectorApi = {
  info: () => request<ConnectorInfo>('GET', '/info'),
  saveSettings: (input: Partial<ConnectorSettings>) => request<ConnectorSettings>('PUT', '/settings', input),

  tokens: () => request<ApiToken[]>('GET', '/tokens'),
  allTokens: () => request<ApiToken[]>('GET', '/tokens/all'),
  createToken: (input: { name: string; scope: ConnectorScope; expiresInDays: number | null }) =>
    request<{ token: string; record: ApiToken }>('POST', '/tokens', input),
  revokeToken: (id: string) => request<void>('DELETE', `/tokens/${encodeURIComponent(id)}`),

  apps: () => request<ConnectedApp[]>('GET', '/apps'),
  disconnectApp: (grantId: string) => request<void>('DELETE', `/apps/${encodeURIComponent(grantId)}`),

  consent: (id: string) => request<OAuthConsentRequest>('GET', `/requests/${encodeURIComponent(id)}`),
  approve: (id: string, scope: ConnectorScope) => request<{ redirectTo: string }>('POST', `/requests/${encodeURIComponent(id)}/approve`, { scope }),
  deny: (id: string) => request<{ redirectTo: string }>('POST', `/requests/${encodeURIComponent(id)}/deny`),

  clients: () => request<ConfidentialClient[]>('GET', '/clients'),
  createClient: (input: { name: string; redirectUris: string[] }) =>
    request<{ client: ConfidentialClient; clientSecret: string }>('POST', '/clients', input),
  updateClient: (id: string, input: { name?: string; redirectUris?: string[] }) =>
    request<ConfidentialClient>('PATCH', `/clients/${encodeURIComponent(id)}`, input),
  deleteClient: (id: string) => request<void>('DELETE', `/clients/${encodeURIComponent(id)}`),
};

/**
 * Ready-to-paste setup for each client. With a token, the token is filled in
 * where a client stores it safely; config files that tend to get committed use
 * an environment variable or a prompt instead.
 */
export interface Snippet {
  id: string;
  label: string;
  note: string;
  code: string;
}

export function connectorSnippets(mcpUrl: string, token?: string): Snippet[] {
  const shown = token ?? '<your-token>';
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      note: 'Run once in a terminal. Add --scope project to share the server (not the token) with your repository.',
      code: `claude mcp add --transport http infraticket ${mcpUrl} --header "Authorization: Bearer ${shown}"`,
    },
    {
      id: 'mcp-json',
      label: '.mcp.json',
      note: 'Project-scoped Claude Code config, safe to commit: the token comes from the INFRATICKET_TOKEN environment variable.',
      code: [
        `export INFRATICKET_TOKEN=${shown}`,
        '',
        JSON.stringify(
          { mcpServers: { infraticket: { type: 'http', url: mcpUrl, headers: { Authorization: 'Bearer ${INFRATICKET_TOKEN}' } } } },
          null,
          2,
        ),
      ].join('\n'),
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      note: 'In claude_desktop_config.json (Settings → Developer → Edit Config), via mcp-remote. Needs Node.js.',
      code: JSON.stringify(
        {
          mcpServers: {
            infraticket: {
              command: 'npx',
              args: ['-y', 'mcp-remote', mcpUrl, '--header', 'Authorization:${AUTH_HEADER}'],
              env: { AUTH_HEADER: `Bearer ${shown}` },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: 'vscode',
      label: 'VS Code',
      note: 'GitHub Copilot agent mode: .vscode/mcp.json. VS Code asks for the token once and stores it securely.',
      code: JSON.stringify(
        {
          inputs: [{ type: 'promptString', id: 'infraticket-token', description: 'InfraTicket access token', password: true }],
          servers: { infraticket: { type: 'http', url: mcpUrl, headers: { Authorization: 'Bearer ${input:infraticket-token}' } } },
        },
        null,
        2,
      ),
    },
    {
      id: 'copilot-studio',
      label: 'Copilot Studio',
      note: 'Tools → Add a tool → New tool → Model Context Protocol. Authentication: API key, Type: Header.',
      code: [`Server URL:   ${mcpUrl}`, 'Header name:  X-InfraTicket-Token', `API key:      ${shown}`].join('\n'),
    },
  ];
}

export const SCOPE_LABELS: Record<ConnectorScope, string> = { read: 'Read only', read_write: 'Read and write' };
