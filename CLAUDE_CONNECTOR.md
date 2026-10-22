# Connecting Claude (and other AI assistants)

InfraTicket includes a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server at **`<App URL>/mcp`**. It lets Claude (Claude Code, Claude Desktop, claude.ai), Microsoft Copilot Studio, GitHub Copilot in VS Code and any other MCP client search tickets, check who is on call, summarise incidents and, if allowed, comment on, update, escalate and raise tickets.

An assistant always acts **as the person who connected it**. It sees only what that person can see in the web app and can do only what that person's role allows. Every change it makes is in the audit log as *"Jane Doe via Claude: ..."*.

- [Ways to connect](#ways-to-connect)
  - [Claude Code](#claude-code)
  - [Claude Desktop](#claude-desktop)
  - [claude.ai](#claudeai-web-and-mobile)
  - [Microsoft Copilot Studio](#microsoft-copilot-studio-teams-and-microsoft-365-copilot)
  - [GitHub Copilot in VS Code](#github-copilot-in-vs-code)
- [What it can do](#what-it-can-do)
- [Access levels](#access-levels)
- [Making it reachable from the internet](#making-it-reachable-from-the-internet)
- [Administration](#administration)
- [Security notes](#security-notes)
- [What was verified](#what-was-verified)

## Ways to connect

| Client | How it signs in | Needs a public https address? |
|---|---|---|
| Claude Code | Personal access token | No |
| Claude Desktop | Personal access token (via `mcp-remote`) | No |
| claude.ai (web, desktop and mobile apps) | OAuth: sign in and approve | **Yes** |
| Copilot Studio (Teams, Microsoft 365 Copilot) | OAuth (dynamic discovery or manual), or API key | **Yes** |
| GitHub Copilot in VS Code | Personal access token | No |

**Personal access tokens** are created under **Profile → Connect Claude**: give it a name, choose *Read only* or *Read and write*, and an expiry (30, 90 or 365 days, or never). The token (`itk_...`) is shown **once**, together with ready-to-paste setup for every client below with your real address and token filled in. Your tokens are listed there with when each was last used; revoke any of them at any time.

### Claude Code

```bash
claude mcp add --transport http infraticket https://tickets.example.com/mcp \
  --header "Authorization: Bearer itk_..."
```

To share the server with everyone working in a repository without sharing anyone's token, commit a project-scoped `.mcp.json` (an example is in [`.mcp.json.example`](.mcp.json.example)) and have each person set `INFRATICKET_TOKEN` in their own environment. Claude Code expands `${VAR}` and `${VAR:-default}` in the `url` and `headers` of `.mcp.json`:

```json
{
  "mcpServers": {
    "infraticket": {
      "type": "http",
      "url": "https://tickets.example.com/mcp",
      "headers": { "Authorization": "Bearer ${INFRATICKET_TOKEN}" }
    }
  }
}
```

```bash
export INFRATICKET_TOKEN=itk_...
```

Then in Claude Code: `/mcp` shows the connection, and you can ask *"what's in my queue?"*, or use the prompts `/mcp__infraticket__daily_briefing` and `/mcp__infraticket__incident_summary`.

### Claude Desktop

Claude Desktop talks to remote servers through [`mcp-remote`](https://github.com/geelen/mcp-remote) (needs Node.js). In **Settings → Developer → Edit Config** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "infraticket": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://tickets.example.com/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer itk_..." }
    }
  }
}
```

The `Authorization:${AUTH_HEADER}` form, with no space, is what `mcp-remote` recommends to avoid an argument-escaping bug on Windows. Restart Claude Desktop afterwards. Without a token, `mcp-remote` can instead run the OAuth flow in your browser, the same way claude.ai does.

### claude.ai (web and mobile)

1. In Claude: **Settings → Connectors → Add custom connector**.
2. Name it *InfraTicket* and paste `https://tickets.example.com/mcp`. Leave the OAuth fields empty; Claude registers itself.
3. Claude sends you to InfraTicket. Sign in if asked, check the app name and the address it will send you back to, choose the access level, and **Approve**.

claude.ai connects from Anthropic's servers, not from your browser, so the address must be **public https**: see [Making it reachable from the internet](#making-it-reachable-from-the-internet). Your connected apps are listed under **Profile → Connect Claude**, where you can disconnect them.

### Microsoft Copilot Studio (Teams and Microsoft 365 Copilot)

In your agent: **Tools → Add a tool → New tool → Model Context Protocol** ([Microsoft Learn](https://learn.microsoft.com/microsoft-copilot-studio/mcp-add-existing-server-to-agent)). Give a name, a description (e.g. *"Search and update IT tickets, incidents and on-call in InfraTicket"*) and the **Server URL** `https://tickets.example.com/mcp`. Then pick one authentication:

**OAuth 2.0 → Dynamic discovery** (simplest). Nothing to fill in: Copilot Studio reads InfraTicket's discovery documents and registers itself. Each person who uses the agent signs in to InfraTicket and approves it once.

**OAuth 2.0 → Manual**, for when discovery can't be used or you want one named client per agent:

1. In InfraTicket, **Settings → AI connectors (MCP) → OAuth clients**, create a client (e.g. *Copilot Studio - IT helpdesk*). Copy the **client ID and secret**; the secret is shown once.
2. In Copilot Studio, choose *OAuth 2.0 → Manual* and paste the values the same panel shows:

   | Copilot Studio field | Value |
   |---|---|
   | Client ID / Client secret | from step 1 |
   | Authorization URL | `https://tickets.example.com/oauth/authorize` |
   | Token URL template | `https://tickets.example.com/oauth/token` |
   | Refresh URL | `https://tickets.example.com/oauth/token` |
   | Scopes | `read_write` (or `read` for a look-up-only agent) |

3. Select **Create**. Copilot Studio shows a **callback URL**: paste it into the client's *Callback URLs* in InfraTicket and save. Until then, sign-in is refused.

**API key**, for a single shared identity (e.g. a service account that can only read): choose *API key*, Type **Header**, header name **`X-InfraTicket-Token`**, and give a personal access token of that account as the key. Copilot Studio sends the key as-is, which is why this header exists alongside `Authorization: Bearer`. Everyone using the agent then acts as that one account, so prefer OAuth for anything that writes. Query-string keys are deliberately not supported: they end up in logs.

Then **Create a new connection → Add to agent**, test it, and **Publish**. To use the agent in Teams and Microsoft 365 Copilot, open **Channels** and add *Teams and Microsoft 365 Copilot* ([Microsoft Learn](https://learn.microsoft.com/microsoft-copilot-studio/publication-add-bot-to-microsoft-teams)). Copilot Studio reaches MCP servers through Power Platform connectors, so your tenant's data policies apply to it.

### GitHub Copilot in VS Code

Create `.vscode/mcp.json` in the workspace. VS Code asks for the token the first time and keeps it in its secret storage, so the file can be committed:

```json
{
  "inputs": [
    { "type": "promptString", "id": "infraticket-token", "description": "InfraTicket access token", "password": true }
  ],
  "servers": {
    "infraticket": {
      "type": "http",
      "url": "https://tickets.example.com/mcp",
      "headers": { "Authorization": "Bearer ${input:infraticket-token}" }
    }
  }
}
```

Start it from the CodeLens above the entry (or **MCP: List Servers**), then use Copilot Chat in **Agent** mode ([Microsoft Learn example](https://learn.microsoft.com/azure/app-service/configure-authentication-mcp-server-vscode)).

## What it can do

Read (every connection):

| Tool | What it returns |
|---|---|
| `search_tickets` | Tickets matching text, status, priority, type, team, assignee, overdue, dates; paginated |
| `get_ticket` | One ticket in full: description, comments, timeline, form answers, linked Slack/Teams/Linear items, alerts, pages. Internal notes only if you may read them |
| `my_queue` | Your open tickets, most urgent first |
| `list_incidents` | Open incidents, with who is being paged |
| `who_is_on_call` | On call now (or at a time) for each schedule, and the next handover |
| `list_monitors`, `get_monitor` | Monitor state, uptime and recent checks |
| `list_alerts` | Open (or other) alerts and their tickets |
| `get_status_page` | What a status page currently shows |
| `list_maintenance` | Maintenance in progress and coming up |
| `list_teams` | Departments and their SLAs |
| `list_quick_tickets` | Quick ticket templates you may raise, with their questions |
| `ticket_report` | Counts, response and resolution times, SLA compliance (needs *View reports*) |

Write (read-and-write connections, and only with the matching permission):

| Tool | Permission |
|---|---|
| `create_ticket` (free-form or from a quick ticket, with answers) | Create tickets |
| `add_comment` (public reply, or internal note) | Internal notes need *Internal notes* |
| `update_ticket` (status, priority, assignee, team, severity) | Update tickets; reassigning needs *Assign tickets* |
| `escalate_ticket` (to another department, with a reason) | Update tickets |
| `acknowledge_page` | Must be able to see the incident |

Prompts: `daily_briefing` (queue, incidents, on-call, maintenance) and `incident_summary` (a status update for one incident).

Every tool is annotated (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so clients can ask before writes. Nothing deletes data. Results are compact JSON with links back to the web app, and never include secrets, passwords, tokens or integration credentials.

## Access levels

Three things must all allow a change:

1. **The connection**: a *Read only* token or approval can never write. On the consent screen a person can grant less than the app asked for.
2. **The organisation**: Settings → AI connectors (MCP) → *Read only* overrides every token and approval.
3. **The person**: their role's permissions, checked on every call. The user is reloaded on every request, so suspending someone or changing their role takes effect immediately.

OAuth scopes: `infraticket:read` and `infraticket:write` (write includes read). The short forms `read` and `read_write` are accepted for hand-configured clients, and `offline_access` is accepted and ignored (refresh tokens are always issued). No scope means read and write, still capped by the consent screen and the organisation setting.

## Making it reachable from the internet

claude.ai and Copilot Studio connect from their own clouds, so they need a **public https** address. You don't have to expose the whole app: exposing only the MCP endpoint, the OAuth endpoints and the discovery documents is enough. People approve on the consent screen at your internal **App URL** (Settings → App URL), so they need to be on the office network or VPN when they first connect.

With a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), `config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  # Only the MCP endpoint, OAuth and discovery are reachable from the internet.
  - hostname: tickets-mcp.example.com
    path: ^/(mcp|oauth/(register|authorize|token|revoke)|\.well-known/oauth-(protected-resource|authorization-server)(/mcp)?)$
    service: http://localhost:3000
  - hostname: tickets-mcp.example.com
    service: http_status:404
  - service: http_status:404
```

Then in **Settings → AI connectors (MCP)** set **Public address** to `https://tickets-mcp.example.com`. Clients are given `https://tickets-mcp.example.com/mcp`; tokens are bound to that address, so changing it later disconnects OAuth apps (personal tokens keep working).

If your people are not on the network when they connect, expose the whole app instead (and point Public address and App URL at the same host).

## Administration

**Settings → AI connectors (MCP)** (needs *Manage settings*):

- **Allow AI assistants to connect**: off stops every token and app immediately and hides the discovery documents.
- **What they may do**: *Read and write*, or *Read only* for everyone.
- **Public address**: the address advertised to clients (defaults to the App URL).
- **OAuth clients**: client IDs and secrets for tools that need them (Copilot Studio *Manual*), with the authorization, token and refresh URLs to paste. Deleting a client disconnects everyone who used it.
- **Personal access tokens**: every token in the organisation, whose it is and when it was last used; revoke any of them.

Creating and revoking tokens, approving and disconnecting apps, and changing these settings are all audited.

## Security notes

- **Nothing secret is stored in the clear.** Personal tokens, OAuth access and refresh tokens, authorization codes and client secrets are stored as SHA-256 hashes. Tokens are 32 random bytes.
- **Personal tokens** go in the `Authorization: Bearer` header, or `X-InfraTicket-Token` for API-key clients. Never in the URL.
- **OAuth 2.1**: authorization code flow only, with **PKCE (S256) required** for every public client. Codes are single-use and expire after 60 seconds; reusing one revokes everything issued from it. Access tokens last one hour. Refresh tokens rotate on every use; presenting an old one revokes the whole grant (it means a copy leaked).
- **Audience binding** (RFC 8707): tokens are issued for, and accepted only at, this server's `/mcp` address.
- **Client registration**: dynamic registration (RFC 7591) accepts public clients only, with https redirect URIs (or http to localhost), and is rate-limited per address. Clients identified by a metadata document URL are fetched with the same SSRF guard as outbound webhooks. Unknown clients and unregistered redirect URIs get an error page, never a redirect. The consent screen shows the app's name and the host it sends you back to.
- **Confidential clients** (admin-created) authenticate with `client_secret_basic` or `client_secret_post`. PKCE is optional for them only because they prove themselves with the secret; if they send a challenge it is enforced.
- **The `/mcp` endpoint** has no CORS and rejects browser requests from other origins (DNS-rebinding protection from the MCP specification). It is stateless: no sessions to hijack. Each credential is limited to 120 requests a minute (`MCP_RATE_LIMIT_PER_MIN`).
- **Prompt injection**: ticket text is written by requesters, and an assistant reads it. Treat an assistant's suggested changes as you would a colleague's: the write tools are annotated so clients ask before using them, and every change is audited as made via Claude. Give read-only access where writing isn't needed.

## What was verified

Checked against the documentation and in the test suite (`tests/mcp.test.ts`, which drives the server with the official MCP TypeScript SDK client over HTTP):

- MCP Streamable HTTP (stateless), the 401 + `WWW-Authenticate: Bearer resource_metadata=...` challenge, Protected Resource Metadata (RFC 9728, both well-known forms), Authorization Server Metadata (RFC 8414), dynamic registration, PKCE, single-use codes, refresh rotation, audience binding and Origin checks follow the MCP authorization and transport specifications.
- Claude Code's `claude mcp add --transport http ... --header` and `.mcp.json` `${VAR}` expansion in `url` and `headers`: from the Claude Code MCP documentation.
- `mcp-remote` configuration: from its README.
- Copilot Studio's MCP wizard (None / API key with header or query / OAuth 2.0 dynamic discovery, dynamic, manual with client ID, secret, authorization, token and refresh URLs, scopes, and the callback URL shown afterwards): from Microsoft Learn.
- VS Code `.vscode/mcp.json` `servers` with `type: http`, `url` and `headers`: from Microsoft Learn examples. The `inputs` / `${input:...}` prompt form is VS Code's documented convention but could not be checked here.

Not tested end to end (needs the real services): connecting from claude.ai, from a Copilot Studio tenant, and publishing to Teams. Microsoft's documentation doesn't say whether Copilot Studio's *Manual* OAuth sends PKCE, which is why confidential clients may omit it.
