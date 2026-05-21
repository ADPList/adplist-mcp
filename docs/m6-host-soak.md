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

## Host notes template

| Host           | Install result | OAuth result | 15-prompt soak | P1 bugs | Cosmetic quirks for M7 README |
| -------------- | -------------- | ------------ | -------------- | ------- | ----------------------------- |
| Claude Desktop |                |              |                |         |                               |
| Claude Code    |                |              |                |         |                               |
| Cursor         |                |              |                |         |                               |
