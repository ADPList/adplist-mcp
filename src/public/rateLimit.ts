import { PublicError } from "./errors.ts";
import type { RateDecision } from "./rateWindows.ts";

// Per-IP limit for public tools/call (ADPLIST-4479), keyed on CF-Connecting-IP
// only — X-Forwarded-For is client-controlled.
//
// 1. PUBLIC_RATE_LIMITER (Workers Rate Limiting binding, 30 / 60 s): a cheap
//    first gate. It is per-location, cached, and eventually consistent, so on
//    its own it let 32 calls through in 11 s.
// 2. PUBLIC_RATE_LIMIT_DO (PublicRateLimiter Durable Object, one per IP): the
//    strict limit, 10 / 10 s and 30 / 60 s fixed windows, atomic.
//
// A missing or broken binding means the tier cannot be protected, so it
// reports UNAVAILABLE rather than serving unthrottled.
export const BINDING_RETRY_AFTER_SECONDS = 60;

// Header-level signal for the response, kept apart from the fixed JSON-RPC body.
export type RateLimitSignal = { remaining?: number; retryAfter?: number };

type LimiterStub = { take(): Promise<RateDecision> | RateDecision };

export async function enforcePublicRateLimit(
	env: Env,
	request: Request,
	signal: RateLimitSignal = {},
): Promise<void> {
	const limiter = env.PUBLIC_RATE_LIMITER;
	const namespace = env.PUBLIC_RATE_LIMIT_DO;
	if (!limiter || typeof limiter.limit !== "function") throw new PublicError("UNAVAILABLE");
	if (!namespace || typeof namespace.idFromName !== "function") throw new PublicError("UNAVAILABLE");
	const ip = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";

	let success: boolean;
	try {
		({ success } = await limiter.limit({ key: `public-mcp:${ip}` }));
	} catch {
		throw new PublicError("UNAVAILABLE");
	}
	if (!success) {
		recordLimited(signal, BINDING_RETRY_AFTER_SECONDS);
		throw new PublicError("RATE_LIMITED");
	}

	let decision: RateDecision;
	try {
		const stub = namespace.get(namespace.idFromName(`ip:${ip}`)) as unknown as LimiterStub;
		decision = await stub.take();
	} catch {
		throw new PublicError("UNAVAILABLE");
	}
	if (
		!decision ||
		typeof decision.allowed !== "boolean" ||
		!Number.isFinite(decision.remaining) ||
		!Number.isFinite(decision.retryAfter)
	) {
		throw new PublicError("UNAVAILABLE");
	}
	signal.remaining = Math.max(0, Math.min(signal.remaining ?? Infinity, Math.floor(decision.remaining)));
	if (!decision.allowed) {
		const retryAfter = Math.max(1, Math.ceil(decision.retryAfter));
		recordLimited(signal, retryAfter);
		throw new PublicError("RATE_LIMITED");
	}
}

function recordLimited(signal: RateLimitSignal, retryAfter: number): void {
	signal.remaining = 0;
	signal.retryAfter = Math.max(signal.retryAfter ?? 0, retryAfter);
}
