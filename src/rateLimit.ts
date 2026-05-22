import type { McpUserProps } from "./types";

const TOOL_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const TOOL_RATE_LIMIT_MAX_CALLS = 60;
const TOOL_RATE_LIMIT_TTL_SECONDS = Math.ceil(TOOL_RATE_LIMIT_WINDOW_MS / 1000) + 60;

type ToolRateLimitBucket = {
	calls: number[];
};

export async function enforceToolCallRateLimit(
	env: Env,
	props: McpUserProps | undefined,
	now = Date.now(),
): Promise<void> {
	const userId = props?.userId?.trim();
	if (!userId) return;

	try {
		const key = `mcp_tool_rate:${userId}`;
		const cutoff = now - TOOL_RATE_LIMIT_WINDOW_MS;
		const bucket = await readBucket(env, key);
		const calls = bucket.calls.filter(
			(timestamp) => Number.isFinite(timestamp) && timestamp > cutoff,
		);

		if (calls.length >= TOOL_RATE_LIMIT_MAX_CALLS) {
			const oldest = Math.min(...calls);
			const retryAfterSeconds = Math.max(
				1,
				Math.ceil((oldest + TOOL_RATE_LIMIT_WINDOW_MS - now) / 1000),
			);
			throw new Error(
				`RATE_LIMITED: per-user tool call rate limit exceeded; retry after ${retryAfterSeconds} seconds`,
			);
		}

		calls.push(now);
		await env.OAUTH_KV.put(key, JSON.stringify({ calls } satisfies ToolRateLimitBucket), {
			expirationTtl: TOOL_RATE_LIMIT_TTL_SECONDS,
		});
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("RATE_LIMITED:")) {
			throw error;
		}
		console.warn("MCP tool rate limit skipped after KV failure", error);
	}
}

async function readBucket(env: Env, key: string): Promise<ToolRateLimitBucket> {
	const raw = await env.OAUTH_KV.get(key);
	if (!raw) return { calls: [] };

	try {
		const parsed = JSON.parse(raw) as Partial<ToolRateLimitBucket>;
		return { calls: Array.isArray(parsed.calls) ? parsed.calls : [] };
	} catch {
		return { calls: [] };
	}
}
