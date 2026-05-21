# ADPList MCP

Cloudflare Worker foundation for ADPList's remote MCP server.

## M1 scope

- OAuth 2.1 provider surface for MCP clients via `@cloudflare/workers-oauth-provider`
- Cognito Hosted UI federation through `identity.adplist.org`
- SSE MCP endpoint at `/sse`
- Empty MCP tool list by design; tools start in later milestones
- Local health endpoint at `/health`

## Required Worker configuration

Set these before deploying from CI/reviewed release flow:

- `COGNITO_DOMAIN` — Cognito hosted UI origin, e.g. `https://identity.adplist.org`
- `COGNITO_CLIENT_ID`
- `COGNITO_CLIENT_SECRET` — optional if the Cognito app client is public/PKCE-only
- `COGNITO_REDIRECT_URI` — optional; defaults to `<worker-origin>/oauth/callback`
- `COGNITO_SCOPES` — optional; defaults to `openid email profile`
- `SEARCH_SERVICE_URL` — search-service base URL for `search_mentors`
- `MEETINGS_SERVICE_URL` — meetings-service base URL for `list_availability` and `book_session`
- `OAUTH_KV` KV namespace binding
- `MCP_OBJECT` Durable Object binding

## Development

```bash
npm install
npm run type-check
npm test
npm run dev
```

No deployment is performed by this PR.

## M6 hardening

- Shared MCP tool errors are returned as structured JSON: `{ "error": { "code", "message", "retryable", "user_action" } }`.
- Recovery-oriented codes include `AUTH_EXPIRED`, `SLOT_GONE`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `CONFIG_ERROR`, `VALIDATION_ERROR`, `FORBIDDEN`, `NOT_FOUND`, and `UNKNOWN_ERROR`.
- Multi-host install and 15-prompt soak checklist: [`docs/m6-host-soak.md`](docs/m6-host-soak.md).
