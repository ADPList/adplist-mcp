# adplist-mcp

ADPList's remote MCP server: a Cloudflare Worker on `mcp.adplist.org` that lets
signed-in ADPList users find mentors, check availability, book and cancel
sessions, and read post-session summaries from Claude.

Also the home of the `adplist` Claude Code plugin and the marketplace that
serves it (`.claude-plugin/marketplace.json` → `plugins/adplist/`).

## ⚠️ Deploys are manual. A green Cloudflare build means nothing.

`scripts/deploy.mjs` runs `wrangler deploy --dry-run` unless
`ALLOW_WORKER_DEPLOY=1`. The `Workers Builds: remote-mcp-server` check therefore
**passes without deploying anything**.

This is not theoretical. Cloudflare recorded no deployment at all between
2026-07-01 and 2026-08-26 — eight weeks — while merges to `main` kept reporting
green. A commit titled `chore: trigger MCP production deploy` (`cd0728b`,
2026-07-04) produced zero deployments. Production served code that was missing
`search_journal_learnings` for the whole period.

The guard now fails loudly rather than exiting 0: in CI it blocks and returns a
non-zero exit, so the Cloudflare check goes red instead of implying a release.
It also refuses to deploy from a dirty tree or from a HEAD that does not match
`origin/main`, which is how a deploy run before its merge ships the old code.

To actually ship:

```bash
npx wrangler login              # once per machine
git checkout main && git pull --ff-only
ALLOW_WORKER_DEPLOY=1 npm run deploy:live
```

Merge first, then pull, then deploy — deploying before merging ships the old
code and looks identical in the output.

**Verify by behaviour, never by a green check.** `/health` returns `{"ok":true}`
from a stale Worker just as happily as a fresh one. Grep the tree for the change
you expect before deploying, and confirm a new `Current Version ID` after. To
check what the live server actually exposes, reconnect it in the connectors
submission portal and read the tool count and descriptions.

## Tool descriptions are compliance surface

This server is listed in the Anthropic Connectors Directory, whose policy
requires that tool descriptions carry no instructions about model behaviour,
other tools, or external instruction sources. State what a tool does, what it
returns, and the consequences of calling it — then let the model reason.

Per-conversation orchestration guidance belongs in the plugin's skills
(`plugins/adplist/skills/`), not in descriptions. Confirmation belongs in the
schema: `book_session`, `cancel_session`, `respond_to_mentor_request`, and
`reschedule_as_mentor` all take `user_confirmed: z.literal(true)`.

When editing a description, re-read the schema underneath it. #82 advertised the
booking note as optional while the schema required it, which broke booking
outright; #83 added a test pinning description and schema together.

## Commands

```bash
npm test           # node --test, currently 203 tests
npm run type-check # tsc --noEmit
npx oxlint src/    # lint
npm run dev        # wrangler dev
claude plugin validate ./plugins/adplist   # after touching the plugin
```

Config lives in `wrangler.jsonc`: KV (`OAUTH_KV`), D1 (`PROFILE_DB`), the
`MyMCP` Durable Object, and the `mcp.adplist.org` custom domain. Auth is
Worker-hosted email-OTP OAuth with RFC 7591 dynamic client registration — no
Cognito hosted UI, no external callback to configure.
