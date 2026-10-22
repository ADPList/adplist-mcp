import { emitAggregateEvent, type WaitUntil } from "./public/analytics.ts";
import type { PublicSource } from "./public/source.ts";

// Weekly usage read for the mentor discovery tools on both tiers
// (ADPLIST-4479). Aggregate only: no user id, email, slug, query text, IP,
// session id, token, or raw client name ever goes into the event.
export const TOOL_CALL_EVENT = "mcp_tool_call";
export const TRACKED_TOOLS = ["search_mentors", "get_mentor_profile"] as const;
export const TOOL_CALL_CLIENTS = ["claude", "chatgpt", "cursor", "other"] as const;
export const TOOL_CALL_EVENT_KEYS = [
	"client",
	"is_internal_test",
	"latency_ms",
	"result_count",
	"status",
	"tier",
	"tool",
] as const;

export type TrackedTool = (typeof TRACKED_TOOLS)[number];
export type ToolCallClient = (typeof TOOL_CALL_CLIENTS)[number];
export type ToolCallTier = "authenticated" | "public";

export type ToolCallEvent = {
	tool: TrackedTool;
	tier: ToolCallTier;
	client: ToolCallClient;
	status: "ok" | "error";
	result_count: number;
	latency_ms: number;
	is_internal_test: boolean;
};

const TEST_HEADER = "x-adplist-test";
const TEST_CLIENT_PREFIX = "adplist-test";

// Same style as sourceFromClientName: hosts name themselves in
// initialize.clientInfo.name; only the mapped enum is kept.
export function clientFromClientName(name: unknown): ToolCallClient {
	if (typeof name !== "string") return "other";
	const lower = name.toLowerCase();
	if (lower.includes("claude")) return "claude";
	if (lower.includes("chatgpt") || lower.includes("openai")) return "chatgpt";
	if (lower.includes("cursor")) return "cursor";
	return "other";
}

// The stateless public tier only keeps the attribution source between
// requests, so cursor and other hosts both land in "other" there.
export function clientFromPublicSource(source: PublicSource): ToolCallClient {
	return source === "claude" || source === "chatgpt" ? source : "other";
}

// `headers` is a Fetch Headers or the plain record the MCP SDK hands tool
// handlers as extra.requestInfo.headers (lower-cased keys).
export function isInternalTest(headers: unknown, clientName: unknown): boolean {
	if (typeof clientName === "string" && clientName.toLowerCase().startsWith(TEST_CLIENT_PREFIX)) {
		return true;
	}
	let value: unknown;
	if (headers instanceof Headers) value = headers.get(TEST_HEADER);
	else if (headers && typeof headers === "object") value = (headers as Record<string, unknown>)[TEST_HEADER];
	if (Array.isArray(value)) value = value[0];
	return typeof value === "string" && value.trim() === "1";
}

// Mentor cards for search, 1/0 for a profile; 0 for any tool error.
export function toolCallResultCount(tool: TrackedTool, result: unknown): number {
	if (!isRecord(result) || result.isError === true) return 0;
	if (tool === "get_mentor_profile") return 1;
	const structured = isRecord(result.structuredContent) ? result.structuredContent : {};
	return Array.isArray(structured.mentors) ? structured.mentors.length : 0;
}

export function buildToolCallEvent(input: {
	tool: TrackedTool;
	tier: ToolCallTier;
	clientName?: unknown;
	client?: ToolCallClient;
	headers?: unknown;
	result: unknown;
	startedAt: number;
}): ToolCallEvent {
	const isError = !isRecord(input.result) || input.result.isError === true;
	return {
		tool: input.tool,
		tier: input.tier,
		client: input.client ?? clientFromClientName(input.clientName),
		status: isError ? "error" : "ok",
		result_count: toolCallResultCount(input.tool, input.result),
		latency_ms: Math.max(0, Date.now() - input.startedAt),
		is_internal_test: isInternalTest(input.headers, input.clientName),
	};
}

// Builds and emits in one guarded step so a telemetry bug can never change
// or fail the tool response it is reporting on.
export function trackToolCall(
	env: Env,
	ctx: WaitUntil | undefined,
	input: Parameters<typeof buildToolCallEvent>[0],
): void {
	try {
		const event = buildToolCallEvent(input);
		emitAggregateEvent(
			env,
			ctx,
			TOOL_CALL_EVENT,
			`mcp-${event.tier}-${event.client}`,
			{ event: TOOL_CALL_EVENT, ...event },
			event,
		);
	} catch {
		// Telemetry must never surface to the caller.
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
