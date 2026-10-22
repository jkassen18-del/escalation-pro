# AI assistants (MCP connector)

InfraTicket includes a [Model Context Protocol](https://modelcontextprotocol.io) server at `<Public URL>/mcp`. Claude (Claude Code, Claude Desktop, claude.ai), Microsoft Copilot Studio (and through it Teams and Microsoft 365 Copilot), GitHub Copilot in VS Code and any other MCP client can search tickets, check who is on call, summarise incidents and, if allowed, comment on, update, escalate and raise tickets.

An assistant always acts **as the person who connected it**: it sees only what they can see and does only what their role allows. Every change is in the audit log as *"Jane Doe via Claude: …"*.

[Connect Claude from your profile](/profile)

## Ways to connect

| Client | Signs in with | Needs a public https address? |
| --- | --- | --- |
| Claude Code | Personal access token | No |
| Claude Desktop | Personal access token (via `mcp-remote`) | No |
| claude.ai (web, desktop and mobile apps) | OAuth: sign in and approve | Yes |
| Copilot Studio (Teams, Microsoft 365 Copilot) | OAuth, or an API key | Yes |
| GitHub Copilot in VS Code | Personal access token | No |

### Personal access tokens

*Profile → Connect Claude*: a name, *Read only* or *Read and write*, and an expiry (30, 90 or 365 days, or never). The token (`itk_…`) is shown **once**, with ready-to-paste setup for each client below filled in with your address and token. Your tokens are listed with when each was last used; revoke any at any time.

### Claude Code

```bash
claude mcp add --transport http infraticket https://tickets.example.com/mcp \
  --header "Authorization: Bearer itk_..."
```

To share the server with a repository without sharing anyone's token, commit a `.mcp.json` and have each person set `INFRATICKET_TOKEN`:

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

In Claude Code, `/mcp` shows the connection. Ask *"what's in my queue?"*, or run the prompts `/mcp__infraticket__daily_briefing` and `/mcp__infraticket__incident_summary`.

### Claude Desktop

*Settings → Developer → Edit Config* (`claude_desktop_config.json`), using [`mcp-remote`](https://github.com/geelen/mcp-remote) (needs Node.js):

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

Keep `Authorization:${AUTH_HEADER}` without a space (it avoids an argument-escaping bug on Windows), then restart Claude Desktop.

### claude.ai

1. In Claude: **Settings → Connectors → Add custom connector**.
2. Name it *InfraTicket* and paste `https://tickets.example.com/mcp`. Leave the OAuth fields empty; Claude registers itself.
3. Claude sends you to InfraTicket. Sign in, check the app name and the address it will return to, choose the access level, and **Approve**.

claude.ai connects from Anthropic's servers, so the address must be public https (see [below](#making-it-reachable)). Connected apps are listed under *Profile → Connect Claude*, where you can disconnect them.

### Microsoft Copilot Studio

In your agent: **Tools → Add a tool → New tool → Model Context Protocol**. Give a name, a description (*"Search and update IT tickets, incidents and on-call in InfraTicket"*) and the **Server URL** `https://tickets.example.com/mcp`. Then choose authentication:

- **OAuth 2.0 → Dynamic discovery** (simplest): nothing to fill in. Each person who uses the agent signs in to InfraTicket and approves it once.
- **OAuth 2.0 → Manual**: create a client under *Settings → AI connectors (MCP) → OAuth clients*, copy its client ID and secret (shown once), and paste them with:

| Copilot Studio field | Value |
| --- | --- |
| Authorization URL | `https://tickets.example.com/oauth/authorize` |
| Token URL template | `https://tickets.example.com/oauth/token` |
| Refresh URL | `https://tickets.example.com/oauth/token` |
| Scopes | `read_write` (or `read`) |

  After **Create**, Copilot Studio shows a callback URL: paste it into the client's *Callback URLs* in InfraTicket and save.
- **API key**: Type **Header**, header name `X-InfraTicket-Token`, and a personal access token of a service account. Everyone using the agent then acts as that one account, so prefer OAuth for anything that writes.

Then **Create a new connection → Add to agent**, test, and **Publish**. For Teams and Microsoft 365 Copilot, add the *Teams and Microsoft 365 Copilot* channel. Steps verified against Microsoft Learn; untested against a live tenant.

### GitHub Copilot in VS Code

`.vscode/mcp.json` (VS Code asks for the token and keeps it in its secret storage, so the file can be committed):

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

## What it can do

| Read tools | Returns |
| --- | --- |
| `search_tickets` | Tickets by text, status, priority, type, team, assignee, overdue, dates |
| `get_ticket` | One ticket in full; internal notes only if you may read them |
| `my_queue` | Your open tickets, most urgent first |
| `list_incidents` | Open incidents and who is being paged |
| `who_is_on_call` | On call now (or at a time) and the next handover |
| `list_monitors`, `get_monitor` | Monitor state, uptime, recent checks |
| `list_alerts` | Alerts and their tickets |
| `get_status_page` | What a status page shows |
| `list_maintenance` | Maintenance in progress and coming up |
| `list_teams` | Departments and SLAs |
| `list_quick_tickets` | Templates you may raise, with their questions |
| `ticket_report` | Counts, response and resolution times, SLA compliance (needs *View reports*) |

| Write tools | Needs |
| --- | --- |
| `create_ticket` | *Create tickets* |
| `add_comment` | Internal notes need *Internal notes* |
| `update_ticket` | *Update tickets*; reassigning needs *Assign tickets* |
| `escalate_ticket` | *Update tickets* |
| `acknowledge_page` | Being able to see the incident |

Prompts: `daily_briefing` and `incident_summary`. Nothing deletes data, and results never include secrets or credentials.

## Access levels

All three must allow a change:

1. **The connection**: a *Read only* token or approval never writes.
2. **The organisation**: *Settings → AI connectors (MCP) → What they may do: Read only* overrides every token.
3. **The person**: their permissions, checked on every call. Suspending someone takes effect immediately.

## Making it reachable

claude.ai and Copilot Studio need a public https address, but only these paths: `/mcp`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` and `/.well-known/oauth-protected-resource` / `/.well-known/oauth-authorization-server`. With a Cloudflare Tunnel:

```yaml
ingress:
  - hostname: tickets-mcp.example.com
    path: ^/(mcp|oauth/(register|authorize|token|revoke)|\.well-known/oauth-(protected-resource|authorization-server)(/mcp)?)$
    service: http://localhost:3000
  - service: http_status:404
```

Then set **Settings → AI connectors (MCP) → Public address** to `https://tickets-mcp.example.com`. People approve on the consent screen at the internal Public URL, so they must be on the network or VPN when they first connect.

## Administration

*Settings → AI connectors (MCP)* (permission `settings.manage`):

- **Allow AI assistants to connect**: off stops every token and app immediately.
- **What they may do**: read and write, or read only.
- **Public address**: what clients are given (defaults to the Public URL). Changing it disconnects OAuth apps.
- **OAuth clients** for Copilot Studio *Manual*.
- **Personal access tokens**: every token in the organisation; revoke any.

## Security

- Tokens, codes and client secrets are stored as SHA-256 hashes.
- OAuth 2.1 with PKCE required for public clients, 60-second single-use codes, one-hour access tokens, rotating refresh tokens, and tokens bound to this server's `/mcp` address.
- `/mcp` rejects browser requests from other origins and allows 120 requests a minute per credential (`MCP_RATE_LIMIT_PER_MIN`).
- **Prompt injection**: ticket text is written by requesters and read by the assistant. Treat its suggested changes as you would a colleague's, and give read-only access where writing is not needed.

The full reference is `CLAUDE_CONNECTOR.md` in the repository.
