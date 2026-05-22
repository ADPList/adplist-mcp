# ADPList MCP

Remote MCP server for ADPList. It lets signed-in ADPList users find mentors, manage career context, view availability, request/cancel sessions, and read post-session summaries from supported MCP hosts.

Production URL: `https://mcp.adplist.org/sse`

## Install

### Claude Desktop

Add ADPList from Settings → Connectors if available. For config-file installs, use an `mcp-remote` stdio bridge so current and older Claude Desktop builds parse the config consistently:

```json
{
	"mcpServers": {
		"adplist": {
			"command": "npx",
			"args": ["mcp-remote", "https://mcp.adplist.org/sse"]
		}
	}
}
```

### Claude Code

```bash
claude mcp add --transport http adplist https://mcp.adplist.org/sse
```

Cursor is experimental/unverified for launch and intentionally omitted from primary install instructions.

## Authentication

ADPList MCP uses a Worker-hosted email-OTP OAuth flow:

1. The MCP host opens `https://mcp.adplist.org/oauth/authorize`.
2. The user enters the email tied to their ADPList account.
3. ADPList emails a one-time code via auth-service.
4. The Worker completes MCP OAuth and stores host tokens through `@cloudflare/workers-oauth-provider`.

There is no Cognito hosted UI, Cognito app client, or external OAuth callback to configure for M7.

OAuth discovery is derived from the request host. After custom-domain cutover, verify:

```bash
curl https://mcp.adplist.org/.well-known/oauth-authorization-server
```

The returned issuer and authorization/token/registration endpoints should use `https://mcp.adplist.org`.

## Tools

- `search_mentors`
- `manage_my_context`
- `list_availability`
- `book_session`
- `list_my_sessions`
- `cancel_session`
- `list_journals`
- `read_journal`

## Rate limits

Authenticated MCP tool calls are limited per ADPList `userId` to 60 calls per 10-minute sliding window using the existing `OAUTH_KV` namespace.

When a user exceeds the limit, tools return the existing structured MCP error shape:

```json
{
	"error": {
		"code": "RATE_LIMITED",
		"message": "ADPList is temporarily rate limiting this request.",
		"retryable": true,
		"user_action": "Wait briefly, then retry. If the user is present, explain that ADPList needs a short cooldown."
	}
}
```

## Required Worker configuration

Configured in `wrangler.jsonc`:

- `AUTH_SERVICE_URL` — ADPList auth-service/API base URL for email OTP login
- `SEARCH_SERVICE_URL` — search-service base URL for `search_mentors`
- `MEETINGS_SERVICE_URL` — meetings-service base URL for session and journal tools
- `OAUTH_KV` — KV namespace for OAuth state, OTP throttling, and MCP tool-call rate limits
- `PROFILE_DB` — D1 database for MCP career context
- `MCP_OBJECT` — Durable Object binding for MCP SSE sessions
- `routes` — custom-domain binding for `mcp.adplist.org`

## Development

```bash
npm install
npm run type-check
npm test
npm run deploy
```

`npm run deploy` is guarded and runs `wrangler deploy --dry-run`. Use `npm run deploy:live` only from an approved release/cutover flow.

## Launch smoke checklist

1. Deploy reviewed Worker build.
2. Confirm Cloudflare route/custom domain for `mcp.adplist.org` is active.
3. Verify `https://mcp.adplist.org/health` returns `{ "ok": true }`.
4. Verify OAuth discovery endpoints use `https://mcp.adplist.org`.
5. Install in Claude Desktop and Claude Code using the snippets above.
6. Complete email-OTP sign-in.
7. Run non-destructive tool smoke: `search_mentors`, `manage_my_context` read/merge/clear, `list_availability`, `list_my_sessions`, `list_journals`.
8. Confirm a forced/exhausted limit returns structured `RATE_LIMITED`.
