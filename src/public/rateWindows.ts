// Fixed-window counters for the strict per-IP public limit (ADPLIST-4479).
// Pure so the Durable Object and the tests share one implementation; the
// Durable Object runs it synchronously, which makes each decision atomic.
export type RateWindow = { name: string; limit: number; periodMs: number };

export const PUBLIC_RATE_WINDOWS: readonly RateWindow[] = [
	{ name: "burst", limit: 10, periodMs: 10_000 },
	{ name: "minute", limit: 30, periodMs: 60_000 },
];

export type WindowState = { start: number; count: number };

export interface WindowStore {
	get(name: string): WindowState | undefined;
	set(name: string, state: WindowState): void;
}

export type RateDecision = {
	allowed: boolean;
	// Calls left in the tightest window after this one.
	remaining: number;
	// Whole seconds until every exceeded window resets; 0 when allowed.
	retryAfter: number;
};

// A denied call is not counted, so a client that waits out Retry-After gets a
// full window back.
export function takeRateSlot(
	store: WindowStore,
	now: number,
	windows: readonly RateWindow[] = PUBLIC_RATE_WINDOWS,
): RateDecision {
	const current = windows.map((window) => {
		const start = Math.floor(now / window.periodMs) * window.periodMs;
		const stored = store.get(window.name);
		return { window, start, count: stored && stored.start === start ? stored.count : 0 };
	});
	const exceeded = current.filter(({ window, count }) => count >= window.limit);
	if (exceeded.length > 0) {
		const resetAt = Math.max(...exceeded.map(({ window, start }) => start + window.periodMs));
		return { allowed: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
	}
	for (const entry of current) store.set(entry.window.name, { start: entry.start, count: entry.count + 1 });
	const remaining = Math.min(...current.map(({ window, count }) => window.limit - count - 1));
	return { allowed: true, remaining, retryAfter: 0 };
}
