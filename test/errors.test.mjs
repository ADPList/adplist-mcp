import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatToolError, toolResponse } from "../src/errors.ts";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("M7 wraps MCP tool handlers with per-user rate limiting and structured errors", () => {
	const wrappers = indexSource.match(/this\.toolResponse\(\(\) =>/g) ?? [];
	assert.equal(wrappers.length, 13);
	assert.match(indexSource, /runWithToolRateLimit/);
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

test("unknown taxonomy discipline is a structured validation error", () => {
	const result = formatToolError(
		new Error(
			'Unknown discipline "Product Management". Try: Generalist Product Management, Group Product Management, Technical Product Management.',
		),
	);
	assert.equal(result.error.code, "VALIDATION_ERROR");
	assert.equal(result.error.retryable, false);
	assert.match(result.error.message, /Generalist Product Management/);
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

test("toolResponse can suppress app resource links for empty successful results", async () => {
	const app = {
		resourceUri: "ui://adplist/mentor-cards.html",
		name: "adplist-mentor-cards",
		title: "ADPList mentor cards",
		description: "Interactive ADPList mentor results with profile photos.",
		shouldRender: (result) => result.mentors.length > 0,
	};
	const empty = await toolResponse(async () => ({ mentors: [] }), app);
	assert.deepEqual(empty.structuredContent, { mentors: [] });
	assert.deepEqual(empty.content.map((item) => item.type), ["text"]);

	const populated = await toolResponse(
		async () => ({ mentors: [{ slug: "mentor-one" }] }),
		app,
	);
	assert.deepEqual(populated.content.map((item) => item.type), ["text", "resource_link"]);
});
