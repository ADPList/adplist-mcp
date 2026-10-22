import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	TOOL_CALL_EVENT_KEYS,
	buildToolCallEvent,
	clientFromClientName,
	clientFromPublicSource,
	isInternalTest,
	trackToolCall,
} from "../src/toolCallEvent.ts";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

const SEARCH_OK = {
	structuredContent: {
		mentors: [{ slug: "alice-visible" }, { slug: "bob-visible" }, { slug: "carol-visible" }],
		queryID: "query-123",
	},
	content: [{ type: "text", text: "{}" }],
};
const TOOL_ERROR = { content: [{ type: "text", text: "{}" }], isError: true };
const PII = ["alice-visible", "query-123", "user@example.com", "Bearer", "203.0.113.7", "sess-", "Claude Desktop"];

async function capture(run) {
	const logs = [];
	const calls = [];
	const pending = [];
	const originalLog = console.log;
	const originalFetch = globalThis.fetch;
	console.log = (line) => logs.push(String(line));
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return new Response("{}", { status: 200 });
	};
	try {
		await run({ waitUntil: (promise) => pending.push(promise) });
		await Promise.all(pending);
	} finally {
		console.log = originalLog;
		globalThis.fetch = originalFetch;
	}
	return { logs, calls };
}

test("mcp_tool_call carries exactly the allowed keys and nothing identifying", async () => {
	const { logs, calls } = await capture(async (ctx) => {
		trackToolCall({ AMPLITUDE_API_KEY: "amp-key" }, ctx, {
			tool: "search_mentors",
			tier: "authenticated",
			clientName: "Claude Desktop",
			headers: {
				authorization: "Bearer sk-ant-FAKE123",
				"cf-connecting-ip": "203.0.113.7",
				"mcp-session-id": "sess-abc",
			},
			result: SEARCH_OK,
			startedAt: Date.now() - 5,
		});
	});

	assert.equal(logs.length, 1);
	const logged = JSON.parse(logs[0]);
	assert.deepEqual(Object.keys(logged).sort(), ["event", ...TOOL_CALL_EVENT_KEYS].sort());
	assert.equal(logged.event, "mcp_tool_call");
	assert.equal(logged.tool, "search_mentors");
	assert.equal(logged.tier, "authenticated");
	assert.equal(logged.client, "claude");
	assert.equal(logged.status, "ok");
	assert.equal(logged.result_count, 3);
	assert.equal(logged.is_internal_test, false);
	assert.ok(logged.latency_ms >= 0);

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://api2.amplitude.com/2/httpapi");
	const sent = JSON.parse(calls[0].init.body).events[0];
	assert.deepEqual(Object.keys(sent).sort(), [
		"device_id",
		"event_properties",
		"event_type",
		"insert_id",
		"time",
	]);
	assert.equal(sent.event_type, "mcp_tool_call");
	assert.equal(sent.device_id, "mcp-authenticated-claude");
	assert.deepEqual(Object.keys(sent.event_properties).sort(), [...TOOL_CALL_EVENT_KEYS].sort());

	const everything = JSON.stringify({ logs, sent });
	for (const forbidden of PII) assert.ok(!everything.includes(forbidden), forbidden);
	for (const key of ["user_id", "email", "slug", "query", "ip", "session_id", "token"]) {
		assert.equal(sent[key], undefined, key);
		assert.equal(sent.event_properties[key], undefined, key);
		assert.equal(logged[key], undefined, key);
	}
});

test("mcp_tool_call reports errors and profile counts as 1/0", () => {
	const base = { tier: "public", client: "other", startedAt: Date.now() };
	const profileOk = buildToolCallEvent({ ...base, tool: "get_mentor_profile", result: { structuredContent: {} } });
	const profileError = buildToolCallEvent({ ...base, tool: "get_mentor_profile", result: TOOL_ERROR });
	const searchError = buildToolCallEvent({ ...base, tool: "search_mentors", result: TOOL_ERROR });
	assert.deepEqual([profileOk.status, profileOk.result_count], ["ok", 1]);
	assert.deepEqual([profileError.status, profileError.result_count], ["error", 0]);
	assert.deepEqual([searchError.status, searchError.result_count], ["error", 0]);
});

test("client names map onto the four-value enum only", () => {
	assert.equal(clientFromClientName("claude-ai"), "claude");
	assert.equal(clientFromClientName("Claude Code"), "claude");
	assert.equal(clientFromClientName("openai-mcp"), "chatgpt");
	assert.equal(clientFromClientName("ChatGPT"), "chatgpt");
	assert.equal(clientFromClientName("cursor-vscode"), "cursor");
	assert.equal(clientFromClientName("Cursor"), "cursor");
	assert.equal(clientFromClientName("some-other-host"), "other");
	assert.equal(clientFromClientName(undefined), "other");
	assert.equal(clientFromClientName(42), "other");
	assert.equal(clientFromPublicSource("claude"), "claude");
	assert.equal(clientFromPublicSource("chatgpt"), "chatgpt");
	assert.equal(clientFromPublicSource("mcp"), "other");
	assert.equal(clientFromPublicSource("api"), "other");
});

test("internal test traffic is flagged by header or adplist-test client name", () => {
	assert.equal(isInternalTest({ "x-adplist-test": "1" }, "Claude Code"), true);
	assert.equal(isInternalTest(new Headers({ "X-ADPList-Test": "1" }), undefined), true);
	assert.equal(isInternalTest({ "x-adplist-test": ["1"] }, undefined), true);
	assert.equal(isInternalTest({}, "adplist-test-harness"), true);
	assert.equal(isInternalTest({}, "ADPList-Test"), true);
	assert.equal(isInternalTest({ "x-adplist-test": "0" }, "claude-ai"), false);
	assert.equal(isInternalTest(undefined, "my-adplist-test"), false);
	assert.equal(isInternalTest(undefined, undefined), false);
});

test("a failing Amplitude fetch or waitUntil never throws", async () => {
	const originalLog = console.log;
	const originalFetch = globalThis.fetch;
	console.log = () => {};
	const pending = [];
	try {
		globalThis.fetch = async () => {
			throw new Error("network down");
		};
		const input = { tool: "get_mentor_profile", tier: "authenticated", result: {}, startedAt: Date.now() };
		trackToolCall({ AMPLITUDE_API_KEY: "amp-key" }, { waitUntil: (p) => pending.push(p) }, input);
		await Promise.all(pending);

		globalThis.fetch = () => {
			throw new Error("sync throw");
		};
		trackToolCall({ AMPLITUDE_API_KEY: "amp-key" }, { waitUntil: (p) => pending.push(p) }, input);

		globalThis.fetch = () => Promise.resolve(new Response(null, { status: 200 }));
		let waitUntilCalled = false;
		trackToolCall(
			{ AMPLITUDE_API_KEY: "amp-key" },
			{
				waitUntil: () => {
					waitUntilCalled = true;
					throw new Error("no ctx");
				},
			},
			input,
		);
		assert.equal(waitUntilCalled, true);
		console.log = () => {
			throw new Error("log sink down");
		};
		trackToolCall({ AMPLITUDE_API_KEY: "amp-key" }, undefined, input);
	} finally {
		console.log = originalLog;
		globalThis.fetch = originalFetch;
	}
});

test("without AMPLITUDE_API_KEY mcp_tool_call is only logged", async () => {
	const { logs, calls } = await capture(async (ctx) => {
		trackToolCall({}, ctx, { tool: "search_mentors", tier: "authenticated", result: SEARCH_OK, startedAt: Date.now() });
	});
	assert.equal(logs.length, 1);
	assert.equal(calls.length, 0);
});

test("authenticated search_mentors and get_mentor_profile are tracked in the Durable Object", () => {
	assert.match(indexSource, /trackedToolResponse\("search_mentors", extra,/);
	assert.match(indexSource, /trackedToolResponse\("get_mentor_profile", extra,/);
	assert.match(indexSource, /trackToolCall\(this\.env, this\.ctx,/);
});
