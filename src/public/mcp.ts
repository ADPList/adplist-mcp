import { z } from "zod";
import { emitPublicEvent } from "./analytics.ts";
import { formatPublicError, publicErrorCode, type PublicErrorBody } from "./errors.ts";
import { enforcePublicRateLimit, type RateLimitSignal } from "./rateLimit.ts";
import {
	parsePublicMcpPath,
	sessionIdForSource,
	sourceFromClientName,
	sourceFromSessionId,
	type PublicSource,
} from "./source.ts";
import {
	intentCategory,
	publicGetMentorProfile,
	publicProfileInputSchema,
	publicSearchInputSchema,
	publicSearchMentors,
} from "./tools.ts";

// Public, no-login, read-only MCP tier (ADPLIST-4479): `/public/mcp` and
// `/public/{source}/mcp`. Stateless Streamable HTTP with JSON responses — no
// KV or D1, and no Durable Object beyond the per-IP rate limiter. Hand-rolled rather than the SDK
// transport so every byte of every response, including validation failures,
// is under the public mapper's control.
export const PUBLIC_SERVER_INFO = { name: "adplist-mcp-public", version: "0.1.0" } as const;
export const PUBLIC_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 64 * 1024;

const TOOL_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
} as const;

export const PUBLIC_TOOLS = [
	{
		name: "search_mentors",
		title: "Search ADPList mentors",
		description:
			"Search ADPList's public mentor directory without signing in. Accepts a natural-language query or a mentor's name, plus optional company, discipline, country, and language filters. Company means the mentor's current employer only: a company given in the filter, or a well-known company named in the query (e.g. \"product manager Google\"), returns only mentors who currently work there, never people who worked there in the past. Returns up to 9 mentors (5 by default), each with name, headline, current company, expertise, disciplines, languages, country, profile photo, public rating and review count when available, a short note on which of the mentor's profile fields match the query, and a link to the mentor's public adplist.org profile. Mentors who are not publicly listed are never returned. Read-only; booking happens on adplist.org.",
		inputSchema: jsonSchema(publicSearchInputSchema),
		annotations: { title: "Search ADPList mentors", ...TOOL_ANNOTATIONS },
	},
	{
		name: "get_mentor_profile",
		title: "Get ADPList mentor profile",
		description:
			"Fetch one mentor's public ADPList profile by slug or adplist.org/mentors URL, without signing in. Returns name, headline, company, expertise, disciplines, languages, country, a bio excerpt of up to 300 characters, profile photo, public rating and review count when available, and a link to the full profile on adplist.org. Returns NOT_FOUND for any mentor who is not publicly listed. Read-only.",
		inputSchema: jsonSchema(publicProfileInputSchema),
		annotations: { title: "Get ADPList mentor profile", ...TOOL_ANNOTATIONS },
	},
];

type JsonRpcId = string | number | null;
type JsonRpcResponse =
	| { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
	| { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

const RPC_ERRORS = {
	parse: { code: -32700, message: "Parse error" },
	invalidRequest: { code: -32600, message: "Invalid Request" },
	methodNotFound: { code: -32601, message: "Method not found" },
	invalidParams: { code: -32602, message: "Invalid params" },
	internal: { code: -32603, message: "Internal error" },
} as const;

type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

// The body as UTF-8 text, or null once it exceeds `maxBytes`. Counts bytes as
// they stream in and stops reading at the limit, so a body without (or lying
// about) Content-Length is never buffered whole.
async function readBodyWithinLimit(request: Request, maxBytes: number): Promise<string | null> {
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

export function isPublicPath(pathname: string): boolean {
	return pathname === "/public" || pathname.startsWith("/public/");
}

// Returns null for anything outside /public so the caller can fall through to
// the OAuth-protected handler.
export async function handlePublicRequest(
	request: Request,
	env: Env,
	ctx?: WaitUntil,
): Promise<Response | null> {
	const url = new URL(request.url);
	if (!isPublicPath(url.pathname)) return null;
	try {
		return await routePublicRequest(request, env, ctx, url);
	} catch {
		return jsonResponse({ jsonrpc: "2.0", id: null, error: RPC_ERRORS.internal }, 500);
	}
}

async function routePublicRequest(
	request: Request,
	env: Env,
	ctx: WaitUntil | undefined,
	url: URL,
): Promise<Response> {
	const route = parsePublicMcpPath(url.pathname);
	if (!route) return textResponse("Not found", 404);
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: publicHeaders() });
	if (request.method !== "POST") {
		// No server-initiated stream on a stateless route.
		return textResponse("Method not allowed", 405, { Allow: "POST, OPTIONS" });
	}

	const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
		return jsonResponse({ jsonrpc: "2.0", id: null, error: RPC_ERRORS.invalidRequest }, 413);
	}
	const raw = await readBodyWithinLimit(request, MAX_BODY_BYTES);
	if (raw === null) {
		return jsonResponse({ jsonrpc: "2.0", id: null, error: RPC_ERRORS.invalidRequest }, 413);
	}
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		return jsonResponse({ jsonrpc: "2.0", id: null, error: RPC_ERRORS.parse }, 400);
	}

	const messages = Array.isArray(body) ? body : [body];
	if (messages.length === 0 || messages.length > 10) {
		return jsonResponse({ jsonrpc: "2.0", id: null, error: RPC_ERRORS.invalidRequest }, 400);
	}

	const sessionSource = sourceFromSessionId(request.headers.get("Mcp-Session-Id"));
	let newSessionId: string | null = null;
	const rateLimit: RateLimitSignal = {};
	const responses: JsonRpcResponse[] = [];
	for (const message of messages) {
		const record = isRecord(message) ? message : null;
		if (!record || record.jsonrpc !== "2.0") {
			responses.push({ jsonrpc: "2.0", id: null, error: RPC_ERRORS.invalidRequest });
			continue;
		}
		// Notifications and client responses need no reply.
		if (!("id" in record) || typeof record.method !== "string") continue;
		const id = safeId(record.id);
		if (id === undefined) {
			responses.push({ jsonrpc: "2.0", id: null, error: RPC_ERRORS.invalidRequest });
			continue;
		}
		const params = isRecord(record.params) ? record.params : {};

		if (record.method === "initialize") {
			const source = route.source ?? sourceFromClientName(asRecord(params.clientInfo).name);
			newSessionId = sessionIdForSource(source);
			responses.push({ jsonrpc: "2.0", id, result: initializeResult(params.protocolVersion) });
			continue;
		}
		const source: PublicSource = route.source ?? sessionSource ?? "mcp";
		const response = await handleMethod(record.method, id, params, request, env, ctx, source, rateLimit);
		responses.push(response);
	}

	const extra: Record<string, string> = newSessionId ? { "Mcp-Session-Id": newSessionId } : {};
	// The JSON-RPC body stays the fixed RATE_LIMITED tool error; the HTTP layer
	// carries the retry hint. Numbers only, never the key or IP.
	if (rateLimit.remaining !== undefined) extra["x-public-rl-remaining"] = String(rateLimit.remaining);
	if (rateLimit.retryAfter !== undefined) extra["Retry-After"] = String(rateLimit.retryAfter);
	if (responses.length === 0) return new Response(null, { status: 202, headers: publicHeaders(extra) });
	return jsonResponse(Array.isArray(body) ? responses : responses[0], 200, extra);
}

async function handleMethod(
	method: string,
	id: JsonRpcId,
	params: Record<string, unknown>,
	request: Request,
	env: Env,
	ctx: WaitUntil | undefined,
	source: PublicSource,
	rateLimit: RateLimitSignal,
): Promise<JsonRpcResponse> {
	switch (method) {
		case "ping":
			return { jsonrpc: "2.0", id, result: {} };
		case "tools/list":
			return { jsonrpc: "2.0", id, result: { tools: PUBLIC_TOOLS } };
		case "resources/list":
			return { jsonrpc: "2.0", id, result: { resources: [] } };
		case "resources/templates/list":
			return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
		case "prompts/list":
			return { jsonrpc: "2.0", id, result: { prompts: [] } };
		case "tools/call": {
			const name = params.name;
			if (name !== "search_mentors" && name !== "get_mentor_profile") {
				return { jsonrpc: "2.0", id, error: RPC_ERRORS.invalidParams };
			}
			const result = await callPublicTool(name, params.arguments, request, env, ctx, source, rateLimit);
			return { jsonrpc: "2.0", id, result };
		}
		default:
			return { jsonrpc: "2.0", id, error: RPC_ERRORS.methodNotFound };
	}
}

export async function callPublicTool(
	name: "search_mentors" | "get_mentor_profile",
	args: unknown,
	request: Request,
	env: Env,
	ctx: WaitUntil | undefined,
	source: PublicSource,
	rateLimit: RateLimitSignal = {},
) {
	try {
		await enforcePublicRateLimit(env, request, rateLimit);
	} catch (error) {
		return toolError(error);
	}

	const started = Date.now();
	if (name === "search_mentors") {
		try {
			const { output, meta } = await publicSearchMentors(env, args, source);
			emitPublicEvent(env, ctx, {
				event: "ai_mentor_search_query",
				source,
				status: "ok",
				...meta,
				latency_ms: Date.now() - started,
			});
			return toolSuccess(output);
		} catch (error) {
			const query = typeof asRecord(args).query === "string" ? (asRecord(args).query as string) : "";
			const hadCompany = typeof asRecord(args).company === "string";
			emitPublicEvent(env, ctx, {
				event: "ai_mentor_search_query",
				source,
				status: "error",
				result_count: 0,
				latency_ms: Date.now() - started,
				had_company_filter: hadCompany,
				intent_category: intentCategory(query, hadCompany, false),
			});
			return toolError(error);
		}
	}

	try {
		const profile = await publicGetMentorProfile(env, args, source);
		emitPublicEvent(env, ctx, {
			event: "ai_mentor_profile_view",
			source,
			status: "ok",
			found: true,
			latency_ms: Date.now() - started,
		});
		return toolSuccess(profile);
	} catch (error) {
		emitPublicEvent(env, ctx, {
			event: "ai_mentor_profile_view",
			source,
			status: publicErrorCode(error) === "NOT_FOUND" ? "ok" : "error",
			found: false,
			latency_ms: Date.now() - started,
		});
		return toolError(error);
	}
}

function toolSuccess(output: Record<string, unknown> | object) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(output) }],
		structuredContent: output,
	};
}

function toolError(error: unknown) {
	const body: PublicErrorBody = formatPublicError(error);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(body) }],
		structuredContent: body,
		isError: true,
	};
}

function initializeResult(requested: unknown) {
	const protocolVersion =
		typeof requested === "string" && PUBLIC_PROTOCOL_VERSIONS.includes(requested)
			? requested
			: PUBLIC_PROTOCOL_VERSIONS[0];
	return {
		protocolVersion,
		capabilities: { tools: { listChanged: false } },
		serverInfo: PUBLIC_SERVER_INFO,
	};
}

export function publicHeaders(extra: Record<string, string> = {}): Headers {
	const headers = new Headers({
		"Cache-Control": "no-store",
		"X-Robots-Tag": "noindex",
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "POST, GET, OPTIONS",
		"Access-Control-Allow-Headers":
			"Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
		"Access-Control-Expose-Headers": "Mcp-Session-Id, Retry-After, x-public-rl-remaining",
		"Access-Control-Max-Age": "86400",
	});
	for (const [key, value] of Object.entries(extra)) headers.set(key, value);
	return headers;
}

function jsonResponse(body: unknown, status: number, extra: Record<string, string> = {}): Response {
	const headers = publicHeaders(extra);
	headers.set("Content-Type", "application/json");
	return new Response(JSON.stringify(body), { status, headers });
}

function textResponse(text: string, status: number, extra: Record<string, string> = {}): Response {
	const headers = publicHeaders(extra);
	headers.set("Content-Type", "text/plain; charset=utf-8");
	return new Response(text, { status, headers });
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
	const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<
		string,
		unknown
	>;
	return rest;
}

function safeId(value: unknown): JsonRpcId | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.length <= 200) return value;
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}
