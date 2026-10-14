import { PublicError } from "./errors.ts";

// Per-IP limit for public tools/call (ADPLIST-4479), via the Workers Rate
// Limiting binding configured in wrangler.jsonc (30 calls / 60 s). Keyed on
// CF-Connecting-IP only — X-Forwarded-For is client-controlled. A missing or
// broken binding means the tier cannot be protected, so it reports UNAVAILABLE
// rather than serving unthrottled.
export async function enforcePublicRateLimit(env: Env, request: Request): Promise<void> {
	const limiter = env.PUBLIC_RATE_LIMITER;
	if (!limiter || typeof limiter.limit !== "function") throw new PublicError("UNAVAILABLE");
	const ip = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
	let success: boolean;
	try {
		({ success } = await limiter.limit({ key: `public-mcp:${ip}` }));
	} catch {
		throw new PublicError("UNAVAILABLE");
	}
	if (!success) throw new PublicError("RATE_LIMITED");
}
