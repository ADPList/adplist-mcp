import assert from "node:assert/strict";
import test from "node:test";
import { enforceToolCallRateLimit } from "../src/rateLimit.ts";

function createEnv() {
	const store = new Map();
	return {
		OAUTH_KV: {
			async get(key) {
				return store.get(key) ?? null;
			},
			async put(key, value) {
				store.set(key, value);
			},
		},
		store,
	};
}

const props = { userId: "user-123", email: "user@example.com", scopes: [] };

test("per-user tool call rate limit allows 60 calls in the 10 minute window", async () => {
	const env = createEnv();
	for (let i = 0; i < 60; i += 1) {
		await enforceToolCallRateLimit(env, props, 1_000_000 + i);
	}

	const bucket = JSON.parse(env.store.get("mcp_tool_rate:user-123"));
	assert.equal(bucket.calls.length, 60);
});

test("per-user tool call rate limit blocks the 61st call", async () => {
	const env = createEnv();
	for (let i = 0; i < 60; i += 1) {
		await enforceToolCallRateLimit(env, props, 1_000_000 + i);
	}

	await assert.rejects(
		enforceToolCallRateLimit(env, props, 1_000_100),
		/RATE_LIMITED: per-user tool call rate limit exceeded/,
	);
});

test("per-user tool call rate limit slides out old calls", async () => {
	const env = createEnv();
	for (let i = 0; i < 60; i += 1) {
		await enforceToolCallRateLimit(env, props, 1_000_000 + i);
	}

	await enforceToolCallRateLimit(env, props, 1_000_000 + 10 * 60 * 1000 + 60);
	const bucket = JSON.parse(env.store.get("mcp_tool_rate:user-123"));
	assert.equal(bucket.calls.length, 1);
});

test("per-user tool call rate limit degrades open when KV is unavailable", async () => {
	const env = {
		OAUTH_KV: {
			async get() {
				throw new Error("KV unavailable");
			},
			async put() {
				throw new Error("KV unavailable");
			},
		},
	};
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		await assert.doesNotReject(enforceToolCallRateLimit(env, props, 1_000_000));
	} finally {
		console.warn = originalWarn;
	}
});
