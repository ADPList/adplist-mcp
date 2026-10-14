# Public no-login MCP tier (ADPLIST-4479, phase 1)

A stateless, read-only MCP endpoint that lets anyone's AI assistant search
ADPList mentors and read public profiles without signing in. Scope and
rationale: `growth/mentor-search-scope/scope.md`.

Code: `src/public/` · Tests: `test/publicMcp.test.mjs` ·
Field check: `scripts/verify-public-fields.mjs`

## Routes

| Path | Source |
|---|---|
| `POST /public/mcp` | from `initialize.clientInfo.name` (`claude*` → `claude`; `chatgpt`/`openai*` → `chatgpt`; else `mcp`) |
| `POST /public/{source}/mcp` | path segment, one of `chatgpt` `claude` `mcp` `api`; anything else → `mcp` |

- Handled in the Worker's default `fetch` **before** `OAuthProvider`; any path
  outside `/public` falls through unchanged, so `/sse` and every OAuth tool
  behave exactly as before.
- Streamable HTTP, JSON responses only. Supports `initialize`, `ping`,
  `tools/list`, `tools/call`, notifications (→ `202`), and empty
  `resources/list` / `prompts/list`. `GET`/`DELETE` → `405` (no server stream).
  Body cap 64 KB, batch cap 10.
- Stateless: no KV or D1, and no Durable Object beyond the per-IP rate
  limiter (see Rate limit). Because `clientInfo` only arrives on
  `initialize`, the chosen source is carried in the `Mcp-Session-Id` the server
  issues (`adplist-public-{source}-{uuid}`). Only the enum value is ever read
  back; a path segment always wins over the session id.
- Hand-rolled JSON-RPC rather than the SDK transport so validation failures
  never echo SDK/zod error text.
- Headers on every `/public/*` response: `Cache-Control: no-store`,
  `X-Robots-Tag: noindex`, `Access-Control-Allow-Origin: *`,
  `Access-Control-Allow-Methods: POST, GET, OPTIONS`.

## Tools

Both are annotated `readOnlyHint: true`, `destructiveHint: false`, and return
`content` (one text item) plus `structuredContent` — no widgets, resource
links, or `_meta` UI.

- **`search_mentors`** — `query` (required, 1–200 chars), optional `company`,
  `discipline` (ADPList taxonomy), `country` (ISO alpha-2), `language`,
  `limit` (1–9, default 5). Flow: company detection → literal-name lookup →
  employer + intent search, all via anonymous
  `GET {SEARCH_SERVICE_URL}/search?provider=explore` using the existing URL
  builder, employer-token rule and domain ranking. At most 9 candidates are
  gated in parallel per phase.

  **Company = current employer** (`src/public/company.ts`). The mentor's
  company is the search row's `employer` / identity `profile.organization`,
  cut before any `previously` / `prev.` / `formerly` / `ex-` tail:
  `"Google | previously at Meta"` is Google and only Google, and is shown as
  `Google`. Work history and bio never count. A company is a hard filter —
  intent rows at other current employers are dropped before gating, and every
  card's final company (identity record first) must match — when it is:
  - the explicit `company` input;
  - a well-known company (small built-in list) named in the query, or a
    phrase starting with one: "product manager Google", "PM at Meta",
    "designer from Airbnb", "google pm", "mentors at Google DeepMind"; or
  - a phrase from the query ("mentors at X", "… at/from X", or 1–3 words at
    either end) that a returned mentor's current employer starts with.

  Matching is by whole-token prefix: the employer must start with every
  company token. A query for `Google` matches `Google` and `Google DeepMind`;
  a query for `Google DeepMind` matches only employers starting with
  `Google DeepMind`, never plain `Google`. The query's employer phrase is kept
  whole and only shortened at clause words ("Meta in London" → Meta), so
  "Meta Reality Labs" is never cut down to "Meta".

  Candidate phrases containing a role, level, field or filler word are never
  companies, so "product manager" alone is not one. An unconfirmed
  "mentors at X" phrase (e.g. "mentors from Canada") only orders results, as
  before.
- **`get_mentor_profile`** — `mentor_slug` (slug or adplist.org/mentors URL).
  Rating and review count come from the existing statistics endpoint,
  best-effort (fields omitted if it fails).

## Allowlist

The public mapper (`src/public/mapper.ts`) builds every object field by field.
Nothing upstream is spread or passed through.

| Field | Notes |
|---|---|
| `name`, `slug`, `title`, `company` | identity record first, search row as fallback; `company` is the current employer only (text before any "previously"/"ex-" tail) |
| `expertise[]`, `disciplines[]`, `languages[]` | ≤10 labels, ≤80 chars each |
| `country` | display name, never ISO code alone |
| `bio` | profile only, ≤300 chars |
| `photo_url` | only `https://adplist-bucket.s3[.region].amazonaws.com/…`, rewritten to the global host, query string dropped |
| `average_rating` | rounded to 1 decimal, as the page shows it (`reviewStats.avg` 4.81 → 4.8); search row on search, statistics fetch on profile |
| `total_reviews` | the page's `reviewStats.count`; search row on search, statistics fetch on profile |
| `profile_url` | `https://adplist.org/mentors/{slug}?utm_source={source}&utm_medium=ai_assistant&utm_campaign=mentor_search&ref=ai_{source}` |
| `why_match` | search only; see below |

**Field verification finding.** `scripts/verify-public-fields.mjs` compared
the mapper output for 50 mentors with their logged-out
`adplist.org/mentors/{slug}` pages:

- Session totals are **not** shown on the public profile page (removed in
  ADPLIST-4360), so `total_sessions` is not public and is dropped. It and
  `sessions_count` are banned keys in the tests.
- The page shows the rating as `reviewStats.avg` rounded to one decimal and the
  review count as `reviewStats.count`; the mapper matches both.
- Rating, review count, country and languages are rendered client-side, so the
  server HTML may carry them only in the page's embedded data (`__NEXT_DATA__`
  or the script holding `reviewStats`). The script reports those as
  `embedded`, not as failures. Any other field found only in script data is
  still `script-only` and fails.

Never emitted, at any depth, in envelope, `structuredContent`, text, or error:
ids (`id`, `legacy_id`, `userId`), `queryID`, `indexUsed`, `position`,
`available_asap`, `next_7_day_slots_count`, `average_attendance`, slots,
`on_break`, `total_sessions`/`sessions_count`, gender, timezone, verified, web links/LinkedIn, work experience,
metadata, legal, review text, swag/referral URLs. The deep-key test walks every
output and fails on any key outside the allowlist.

**`why_match`** is rebuilt from allowlisted fields only — company match, title,
expertise, discipline, or language overlap with the query or filters, else
"{title} at {company}". It never mentions availability, sessions, ratings, or
ranking, and never echoes the raw query.

## Visibility

One function, `checkMentorVisibility` (`src/public/visibility.ts`), gates all
three paths: search results, literal-name lookups (slug guess and name search),
and slug lookups.

Anonymous `GET {AUTH_SERVICE_URL}/users/profile/mentor/{slug}` (3 s timeout),
always the bare record URL: no query parameters (never `syncFromLegacy`), and
the slug is percent-encoded so it cannot add its own.
A mentor is visible **only if**:

```
data.status === "active" && is.active === true && is.mentor === true &&
is.suspended, is.onBreak, is.aiSearchOptOut each absent or === false &&
slug (requested and canonical) not in PUBLIC_OPT_OUT_SLUGS
```

Fail closed: non-200, network error, timeout, non-JSON, a body without
`data.status` and an `data.is` object, or any present flag that is not a
boolean (`"true"`, `1`, `null`) all omit the mentor. On profile lookup hidden,
opted-out, on-break, missing, and unverifiable all return the same
`NOT_FOUND`, byte for byte, so the response is not an oracle for why.
Every public response is `no-store`.

### Decisions

- **Visibility source:** the identity-service mentor profile record is
  authoritative.
- **Anonymous search:** confirmed as approved and verified for this tier (per
  the ADPLIST-4479 decision; the code never attaches a bearer token on this
  path, and tests assert no `Authorization` header).
- **Opt-out:** `is.aiSearchOptOut` on the identity-service record, plus the
  `PUBLIC_OPT_OUT_SLUGS` var (comma-separated, case-insensitive) as an
  immediate kill list. Until identity-service ships `aiSearchOptOut`, the
  flag is absent and therefore passes; the kill list is the only per-mentor
  switch in the meantime. Editing the var needs a deploy (see CLAUDE.md).

## Errors

`src/public/errors.ts`, fixed code and message only:

| Code | Message |
|---|---|
| `NOT_FOUND` | No public ADPList mentor profile matches that request. |
| `INVALID_INPUT` | The request input is invalid. |
| `RATE_LIMITED` | Too many requests. Try again in a minute. |
| `UNAVAILABLE` | ADPList mentor search is temporarily unavailable. |

No `details`, cause, upstream body, stack, URL, or validation text. Anything
that is not a deliberate public error becomes `UNAVAILABLE`. JSON-RPC protocol
errors use fixed messages too (`Parse error`, `Invalid Request`,
`Method not found`, `Invalid params`, `Internal error`).

## Rate limit

Two layers on every `tools/call`, both keyed on `CF-Connecting-IP` — never
`X-Forwarded-For` — and both checked before any upstream fetch.
`initialize`, `tools/list` and `ping` are not counted.

1. `PUBLIC_RATE_LIMITER` (Workers Rate Limiting binding, `wrangler.jsonc`
   `ratelimits`, 30 calls / 60 s): a cheap first gate. It is per-location,
   cached and eventually consistent — a preview reviewer got 32 calls in 11 s,
   all 200 — so it is not the limit.
2. `PUBLIC_RATE_LIMIT_DO` → `PublicRateLimiter` (`src/public/rateLimiterObject.ts`),
   a SQLite-backed Durable Object addressed by `idFromName("ip:" + IP)`.
   Fixed-window counters, **10 calls / 10 s and 30 calls / 60 s**, read and
   written in one synchronous `transactionSync`, so each decision is atomic and
   global. Denied calls are not counted. It stores only window start times and
   counts, never the IP (the IP is only the object's name).

If either binding is missing, throws, or returns an unexpected shape, tools
return `UNAVAILABLE` (fail closed).

When limited, the JSON-RPC result is still the fixed `RATE_LIMITED` tool error
(HTTP 200); the HTTP response adds `Retry-After` (seconds until the exceeded
window resets; 60 when the first-gate binding refused). Every response to a
`tools/call` that reached the strict limiter also carries
`x-public-rl-remaining` — a bare number (calls left in the tightest window), no
key or IP. Both headers are CORS-exposed.

Migrations are append-only: `v2` (`wrangler.jsonc`) and `preview-v2`
(`wrangler.preview.jsonc`) add `PublicRateLimiter` as a new SQLite class.

## Reporting

Two events, emitted once per executed tool call (not for rate-limited calls):

- `ai_mentor_search_query`: `source`, `status`, `result_count`, `latency_ms`,
  `had_company_filter`, `intent_category` (`company`, `name`, `design`,
  `product`, `engineering`, `data`, `marketing`, `career`, `leadership`,
  `other`).
- `ai_mentor_profile_view`: `source`, `status`, `found`, `latency_ms`.

No raw query, IP, slug, or session id. Always logged as one JSON line
(`{"event":…}`); also sent to the Amplitude HTTP API when the
`AMPLITUDE_API_KEY` secret is set, via `ctx.waitUntil`, with
`device_id: "ai-mcp-{source}"`. Amplitude failures are swallowed. Events are
sent from the Worker, so Amplitude sees a Cloudflare egress IP, never the
user's.

Follow-up: Workers observability is enabled for this Worker. Check whether
invocation logs record request headers such as `CF-Connecting-IP`; if they do,
decide on retention or `observability.logs.invocation_logs: false`.

## Preview

`wrangler.preview.jsonc` deploys a separate Worker,
`adplist-mcp-public-preview`, on workers.dev only (no routes, no custom
domain) with its own rate-limit namespace. See README → "Public tier preview".

## WAF plan (written, NOT applied)

For the `adplist.org` CloudFront web ACL that will front
`/api/public/{source}/mentors*` in phase 3 (distribution `E3DTTDDY69OVLI`).
Nothing here has been run. The owner of the web ACL executes it.

### 1. Read-only export first

CloudFront-scope WAF lives in `us-east-1`.

```bash
export AWS_REGION=us-east-1
mkdir -p waf-backup && cd waf-backup

aws wafv2 list-web-acls --scope CLOUDFRONT > web-acls.json
# pick the ACL attached to E3DTTDDY69OVLI:
aws cloudfront get-distribution-config --id E3DTTDDY69OVLI > cf-distribution.before.json
jq -r '.DistributionConfig.WebACLId' cf-distribution.before.json

ACL_NAME=...; ACL_ID=...; ACL_ARN=...
aws wafv2 get-web-acl --scope CLOUDFRONT --name "$ACL_NAME" --id "$ACL_ID" > web-acl.before.json
aws wafv2 get-logging-configuration --resource-arn "$ACL_ARN" > logging.before.json
aws wafv2 list-logging-configurations --scope CLOUDFRONT > logging-all.json
# any rule groups the ACL references:
jq -r '.WebACL.Rules[].Statement.RuleGroupReferenceStatement.ARN // empty' web-acl.before.json
aws wafv2 get-rule-group --scope CLOUDFRONT --name ... --id ... > rule-group-<name>.before.json
```

Review: which rules carry `/api/public` scope-down statements, the current
`VisibilityConfig` on each rule and on the ACL, the log destination, any
`LoggingFilter`, and whether Firewall Manager manages the ACL
(`ManagedByFirewallManager`) — if it does, change it there instead.

### 2. Disable sampled requests

Sampled requests keep full request copies (including query strings) for the
console, outside the log redaction. Preferred: set
`VisibilityConfig.SampledRequestsEnabled=false` on every rule whose scope
covers `/api/public/*`. Fallback if rules are shared with other paths: set it
firewall-wide on the ACL's own `VisibilityConfig`. Keep
`CloudWatchMetricsEnabled=true`.

```bash
jq '.WebACL' web-acl.before.json > acl.json
# edit acl.json: SampledRequestsEnabled=false on the public rules (or the ACL)
LOCK=$(jq -r '.LockToken' web-acl.before.json)
aws wafv2 update-web-acl --scope CLOUDFRONT --name "$ACL_NAME" --id "$ACL_ID" \
  --lock-token "$LOCK" \
  --default-action "$(jq -c '.DefaultAction' acl.json)" \
  --rules "$(jq -c '.Rules' acl.json)" \
  --visibility-config "$(jq -c '.VisibilityConfig' acl.json)" \
  --custom-response-bodies "$(jq -c '.CustomResponseBodies // {}' acl.json)"
```

`update-web-acl` replaces the whole rule list: always start from the exported
JSON, never from memory.

### 3. Redact query string and `x-api-key` in WAF logs

`put-logging-configuration` replaces the whole config. Start from
`logging.before.json` and only add to `RedactedFields`:

```bash
jq '.LoggingConfiguration
    | .RedactedFields = ((.RedactedFields // [])
        + [{"QueryString":{}}, {"SingleHeader":{"Name":"x-api-key"}}] | unique)' \
  logging.before.json > logging.json
aws wafv2 put-logging-configuration --logging-configuration file://logging.json
aws wafv2 get-logging-configuration --resource-arn "$ACL_ARN"   # confirm
```

Keep `LogDestinationConfigs` and any `LoggingFilter` exactly as exported.

### 4. Verify

- Send a request with `?q=probe-<random>` and `x-api-key: probe-<random>`; the
  WAF log record shows both as `REDACTED`.
- The console's sampled requests panel is empty for the changed rules.
- CloudWatch metrics for those rules still populate.

### 5. Rollback

```bash
FRESH=$(aws wafv2 get-web-acl --scope CLOUDFRONT --name "$ACL_NAME" --id "$ACL_ID")
LOCK=$(echo "$FRESH" | jq -r '.LockToken')
jq '.WebACL' web-acl.before.json > acl.before.json
aws wafv2 update-web-acl --scope CLOUDFRONT --name "$ACL_NAME" --id "$ACL_ID" \
  --lock-token "$LOCK" \
  --default-action "$(jq -c '.DefaultAction' acl.before.json)" \
  --rules "$(jq -c '.Rules' acl.before.json)" \
  --visibility-config "$(jq -c '.VisibilityConfig' acl.before.json)" \
  --custom-response-bodies "$(jq -c '.CustomResponseBodies // {}' acl.before.json)"
aws wafv2 put-logging-configuration \
  --logging-configuration "$(jq -c '.LoggingConfiguration' logging.before.json)"
```

If logging was not configured before, roll back with
`aws wafv2 delete-logging-configuration --resource-arn "$ACL_ARN"` instead.
