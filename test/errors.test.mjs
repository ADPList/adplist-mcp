import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatToolError, toolResponse } from "../src/errors.ts";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("M6 wraps MCP tool handlers so failures return structured JSON errors", () => {
	const wrappers = indexSource.match(/toolResponse\(\(\) =>/g) ?? [];
	assert.equal(wrappers.length, 8);
});

test("AUTH_EXPIRED gives the LLM a reconnect recovery path", () => {
	const result = formatToolError(
		new Error("book_session requires an authenticated ADPList user"),
	);
	assert.equal(result.error.code, "AUTH_EXPIRED");
	assert.equal(result.error.retryable, false);
	assert.match(result.error.user_action, /reconnect ADPList/i);
});

test("SLOT_GONE tells the LLM to refresh availability before booking", () => {
	const result = formatToolError(
		new Error(
			"Selected slot is no longer available. Ask the user to choose a fresh slot from list_availability.",
		),
	);
	assert.equal(result.error.code, "SLOT_GONE");
	assert.equal(result.error.retryable, false);
	assert.match(result.error.user_action, /list_availability/i);
});

test("RATE_LIMITED is retryable and preserves HTTP 429 detail", () => {
	const result = formatToolError(new Error("search-service returned HTTP 429"));
	assert.equal(result.error.code, "RATE_LIMITED");
	assert.equal(result.error.retryable, true);
	assert.equal(result.error.details.http_status, 429);
});

test("UPSTREAM_UNAVAILABLE is retryable for 5xx service failures", () => {
	const result = formatToolError(new Error("meetings-service journals returned HTTP 503"));
	assert.equal(result.error.code, "UPSTREAM_UNAVAILABLE");
	assert.equal(result.error.retryable, true);
	assert.equal(result.error.details.http_status, 503);
});

test("CONFIG_ERROR is not retryable by the user", () => {
	const result = formatToolError(new Error("SEARCH_SERVICE_URL is not configured"));
	assert.equal(result.error.code, "CONFIG_ERROR");
	assert.equal(result.error.retryable, false);
	assert.match(result.error.user_action, /server operator/i);
});

test("toolResponse preserves success output and marks failures as MCP tool errors", async () => {
	const success = await toolResponse(async () => ({ ok: true }));
	assert.deepEqual(JSON.parse(success.content[0].text), { ok: true });
	assert.equal(success.isError, undefined);

	const failure = await toolResponse(async () => {
		throw new Error("meetings-service availability returned HTTP 500");
	});
	assert.equal(failure.isError, true);
	assert.equal(JSON.parse(failure.content[0].text).error.code, "UPSTREAM_UNAVAILABLE");
});
