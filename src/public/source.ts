// Attribution source for the public tier (ADPLIST-4479). Only these four
// values ever leave the Worker; anything a caller sends is mapped onto them
// and never echoed back raw.
export const PUBLIC_SOURCES = ["chatgpt", "claude", "mcp", "api"] as const;
export type PublicSource = (typeof PUBLIC_SOURCES)[number];

const DEFAULT_SOURCE: PublicSource = "mcp";
const SESSION_PREFIX = "adplist-public-";

export function normalizeSource(value: unknown): PublicSource {
	if (typeof value !== "string") return DEFAULT_SOURCE;
	const lower = value.trim().toLowerCase();
	return (PUBLIC_SOURCES as readonly string[]).includes(lower)
		? (lower as PublicSource)
		: DEFAULT_SOURCE;
}

// `/public/mcp` → no source; `/public/{segment}/mcp` → segment, normalized.
// Returns null when the path is not a public MCP route at all.
export function parsePublicMcpPath(
	pathname: string,
): { source: PublicSource | null } | null {
	const parts = pathname.replace(/\/+$/, "").split("/");
	if (parts.length === 3 && parts[1] === "public" && parts[2] === "mcp") return { source: null };
	if (parts.length === 4 && parts[1] === "public" && parts[3] === "mcp") {
		return { source: normalizeSource(decodeSegment(parts[2])) };
	}
	return null;
}

// Hosts name themselves in initialize.clientInfo.name ("claude-ai",
// "Claude Code", "openai-mcp", "ChatGPT"). Only the mapped enum is kept.
export function sourceFromClientName(name: unknown): PublicSource {
	if (typeof name !== "string") return DEFAULT_SOURCE;
	const lower = name.toLowerCase();
	if (lower.includes("claude")) return "claude";
	if (lower.includes("chatgpt") || lower.includes("openai")) return "chatgpt";
	return DEFAULT_SOURCE;
}

// The route is stateless, so the source picked at initialize rides along in
// the Mcp-Session-Id the client echoes on later requests. The id carries
// nothing but the enum value and a random nonce.
export function sessionIdForSource(source: PublicSource): string {
	return `${SESSION_PREFIX}${source}-${crypto.randomUUID()}`;
}

export function sourceFromSessionId(value: string | null): PublicSource | null {
	if (!value || !value.startsWith(SESSION_PREFIX)) return null;
	const candidate = value.slice(SESSION_PREFIX.length).split("-")[0];
	return (PUBLIC_SOURCES as readonly string[]).includes(candidate)
		? (candidate as PublicSource)
		: null;
}

function decodeSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return "";
	}
}
