# M6 multi-host validation and soak checklist

Purpose: prove the same remote ADPList MCP server works in Claude Desktop, Claude Code, and Cursor without adding host-specific code unless a host materially breaks the beta-user experience.

Use a fresh config/profile where possible. Replace `https://mcp.adplist.org/sse` with the deployed Worker SSE URL for the environment being validated.

## Install snippets

### Claude Desktop

Add ADPList from Settings → Connectors if available. For config-file installs, add this to `claude_desktop_config.json`:

```json
{
	"mcpServers": {
		"adplist": {
			"type": "sse",
			"url": "https://mcp.adplist.org/sse"
		}
	}
}
```

### Claude Code

```bash
claude mcp add --transport sse adplist https://mcp.adplist.org/sse
```

Fresh-config equivalent:

```json
{
	"mcpServers": {
		"adplist": {
			"type": "sse",
			"url": "https://mcp.adplist.org/sse"
		}
	}
}
```

### Cursor

Cursor Settings → MCP → Add server:

```json
{
	"mcpServers": {
		"adplist": {
			"type": "sse",
			"url": "https://mcp.adplist.org/sse"
		}
	}
}
```

## Required pass/fail checks per host

1. Fresh install starts OAuth without manual token copy/paste.
2. User can sign in via ADPList email OTP.
3. `search_mentors` succeeds for a simple query.
4. Tool failures return structured JSON: `{ "error": { "code", "message", "retryable", "user_action" } }`.
5. Host can recover gracefully from:
    - `AUTH_EXPIRED` → reconnect/sign in again.
    - `SLOT_GONE` → call `list_availability`, then ask user to pick a fresh slot.
    - `RATE_LIMITED` → wait/retry instead of changing tool inputs blindly.

## 15-prompt soak set

Run the same prompt set in each host. Mark P1 only for failures that block the beta user from completing the task; cosmetic formatting differences go into the M7 README notes.

1. "Find me 5 product mentors for a PM moving into AI products."
2. "Find growth mentors in Singapore who can help with marketplace activation."
3. "Remember that I am a founder focused on B2B SaaS growth."
4. "What ADPList context do you remember about me?"
5. "Show availability for the first mentor from the search results."
6. "Draft a booking note for the earliest useful slot, but ask me before booking."
7. "Book the slot I confirmed with that note." (use a non-production test account only)
8. "List my upcoming ADPList sessions."
9. "Cancel the test session I just booked, and ask me to confirm before doing it." (test account only)
10. "List my past session summaries."
11. "Read the most recent session summary."
12. Simulate/force expired auth, then ask: "List my sessions."
13. Simulate/force a stale slot, then ask: "Book this old slot."
14. Simulate/force rate limiting, then ask: "Find mentors for leadership coaching."
15. "Clear the ADPList context you stored about me."

## Host notes

Validation environment: beta Worker `https://remote-mcp-server-beta.dev-774.workers.dev/sse`.

| Host | Install result | OAuth result | Soak result | P1 bugs | Cosmetic quirks / follow-ups |
| --- | --- | --- | --- | --- | --- |
| Claude Desktop | PASS — Felix confirmed the beta SSE MCP server was installed on his MacBook Claude Desktop | PASS — Felix completed ADPList auth in Claude Desktop | PASS — non-destructive smoke passed: mentor search, context read/write/cleanup, availability, upcoming sessions, past summaries | None reported | `search_mentors` initially tried a Product Management discipline filter that returned zero, then retried broader and returned profiles. Treat as a ranker/filter taxonomy quirk, not a host/MCP packaging blocker. |
| Claude Code | PASS — fresh SSE MCP config recognized the beta server and requested auth | PASS — email OTP OAuth callback completed against the local Claude Code listener | PASS for non-mutating beta-user prompts: `search_mentors`, `manage_my_context` read/merge/clear, `list_availability`, `list_my_sessions`, `list_journals`; `read_journal` skipped because the staging account had no journals | None found in Claude Code envelope/OAuth path | `read_journal` needs an account with journal data for full positive-path coverage. Invalid availability slug currently returns structured `UPSTREAM_UNAVAILABLE` because the upstream service returns HTTP 500; the envelope is correct, but `NOT_FOUND` would be semantically better if upstream can distinguish missing mentors. |
| Cursor | WAIVED for M6 by Felix on 2026-05-22 | WAIVED | WAIVED | None observed | Original M6 asked for Cursor, but Felix explicitly accepted proceeding without Cursor after Claude Code + Claude Desktop passed. Track Cursor as follow-up validation rather than a release blocker. |

### Claude Desktop beta validation details

Run date: 2026-05-22. Reported by Felix from Claude Desktop on MacBook.

- OAuth/install: PASS — ADPList MCP beta was installed and usable in Claude Desktop.
- `search_mentors`: PASS — returned profiles. Quirk: Claude first tried a Product Management discipline filter that returned zero, then retried broader and succeeded.
- `manage_my_context` read: PASS.
- `manage_my_context` merge + read-back: PASS — beta validation note was stored and read back.
- `list_availability`: PASS.
- `list_my_sessions`: PASS.
- `list_journals`: PASS — returned summaries or an empty result without breaking the flow.
- Cleanup: PASS — Felix confirmed the stored test context was cleared.

### Claude Code beta validation details

Run date: 2026-05-22.

- OAuth: PASS — ADPList email OTP completed and Claude Code accepted the callback.
- `search_mentors`: PASS — returned 5 ranked mentor cards with `queryID` and `indexUsed: "explore"`.
- `manage_my_context` read: PASS — clean empty state before validation.
- `manage_my_context` merge + read-back: PASS — validation key persisted, then cleanup restored the empty state.
- `list_availability`: PASS — returned 6 UTC slots for a mentor from search results, `truncated: false`.
- `list_my_sessions`: PASS — valid empty `sessions: []` for the staging account.
- `list_journals`: PASS — valid empty `journals: []`, `total_items: 0` for the staging account.
- `read_journal`: SKIPPED positive path — no journal id available on the staging account.
- Negative-path structured errors: PASS — invalid `read_journal` returned structured `NOT_FOUND`; invalid `list_availability` returned structured `UPSTREAM_UNAVAILABLE` with the required envelope fields.
