# M7 launch notes

## First-principles scope

1. **Question requirements** — ship only what blocks public beta: stable domain, install docs, per-user tool-call abuse protection, and a user-facing revoke path.
2. **Delete unnecessary parts** — no Cognito hosted UI, no Cognito app client, no Cursor launch claim, no analytics dashboard.
3. **Simplify/optimize** — use the existing Worker, OAuth provider, and `OAUTH_KV`; avoid a new rate-limit service.
4. **Accelerate cycle time** — verify with local tests first, then domain discovery and MCP host smoke after cutover.
5. **Automate last** — add only regression tests that protect the launch path.

## Domain

Production MCP endpoint:

```text
https://mcp.adplist.org/sse
```

`wrangler.jsonc` binds the Worker to `mcp.adplist.org` as a Cloudflare custom domain route. The email-OTP OAuth flow derives discovery URLs from the incoming request host, so no external callback/redirect configuration is required.

## Cutover verification

```bash
curl -fsS https://mcp.adplist.org/health
curl -fsS https://mcp.adplist.org/.well-known/oauth-authorization-server
```

Expected:

- `/health` returns `{ "ok": true }`.
- OAuth discovery `issuer`, `authorization_endpoint`, `token_endpoint`, and registration endpoints use `https://mcp.adplist.org`.
- Claude Desktop and Claude Code can install `https://mcp.adplist.org/sse`, complete email OTP, and call non-destructive tools.

## Rate limit

Per authenticated ADPList `userId`:

- 60 MCP tool calls
- 10-minute sliding window
- stored in `OAUTH_KV` under `mcp_tool_rate:<userId>`
- returns structured `RATE_LIMITED` through the existing MCP tool error envelope

This intentionally protects tool calls, not OAuth/login page visits. OTP email abuse protection remains the existing per-IP OTP throttle.
