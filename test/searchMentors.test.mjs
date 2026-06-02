import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { searchMentors } from "../src/searchMentors.ts";

const source = readFileSync(new URL("../src/searchMentors.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("M2 registers the search_mentors MCP tool", () => {
	assert.match(indexSource, /registerTool\(\s*"search_mentors"/);
	assert.match(indexSource, /existing Explore personalization ranker/);
	assert.match(indexSource, /min\(5\)\.max\(8\)/);
});

test("search_mentors calls search-service Explore with compact filters", () => {
	assert.match(source, /new URL\("\/search", baseUrl\)/);
	assert.match(source, /provider", "explore"/);
	assert.doesNotMatch(source, /provider", "v2"/);
	assert.match(source, /pageSize/);
	assert.match(source, /disciplines/);
	assert.match(source, /countries/);
	assert.match(source, /languages/);
});

test("search_mentors preserves booking attribution and trims LLM output", () => {
	assert.match(source, /queryID/);
	assert.match(source, /expertise\.filter\(Boolean\)\.slice\(0, 3\)/);
	assert.match(source, /next_7_day_slots_count/);
	assert.match(source, /https:\/\/adplist\.org\/mentors\//);
	assert.match(source, /why_match/);
});

test("search_mentors maps common mentor photo aliases into profile_photo_url", () => {
	assert.match(source, /mentor\.profile\?\.avatarUrl/);
	assert.match(source, /mentor\.profile\?\.imageUrl/);
	assert.match(source, /mentor\.profile\?\.photo_url/);
	assert.match(source, /mentor\.profileImageUrl/);
	assert.match(source, /mentor\.avatar_url/);
	assert.match(source, /mentor\.picture/);
	assert.match(source, /trimmed\.startsWith\("\/\/"\)/);
	assert.match(source, /trimmed\.startsWith\("\/"\)/);
});

test("search_mentors relaxes only discipline after a zero-result taxonomy mismatch", () => {
	assert.match(source, /firstResult\.mentors\.length > 0 \|\| !input\.filters\?\.discipline/);
	assert.match(source, /const \{ discipline: _discipline, \.\.\.relaxedFilters \} = input\.filters/);
	assert.match(source, /relaxed_filters: \["discipline"\]/);
	assert.match(source, /fetchAndMapSearchMentors/);
});

test("search_mentors retries without discipline when the constrained search is empty", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		const parsed = new URL(String(url));
		if (parsed.searchParams.has("disciplines")) {
			return jsonResponse({ results: [], queryID: "strict-query", indexUsed: "explore" });
		}
		return jsonResponse({
			results: [
				{
					name: "Daniel Tuitt",
					slug: "daniel-tuitt",
					title: "Lead Service Designer",
					employer: "Developed Thinking",
					expertise: ["design", "product"],
					disciplines: ["ux design", "service design"],
					total_sessions: 100,
					next_7_day_slots_count: 4,
				},
			],
			queryID: "relaxed-query",
			indexUsed: "explore",
		});
	};

	try {
		const result = await searchMentors(
			{ SEARCH_SERVICE_URL: "https://search.example" },
			undefined,
			{
				intent: "senior designer mentors helping new grads break into tech design",
				filters: { discipline: "tech design", country: "us", max_results: 5 },
			},
		);

		assert.equal(calls.length, 2);
		assert.equal(new URL(calls[0]).searchParams.get("disciplines"), "tech design");
		assert.equal(new URL(calls[0]).searchParams.get("countries"), "US");
		assert.equal(new URL(calls[1]).searchParams.has("disciplines"), false);
		assert.equal(new URL(calls[1]).searchParams.get("countries"), "US");
		assert.equal(result.mentors.length, 1);
		assert.equal(result.mentors[0].slug, "daniel-tuitt");
		assert.equal(result.queryID, "relaxed-query");
		assert.deepEqual(result.relaxed_filters, ["discipline"]);
		assert.equal(Object.hasOwn(result, "original_result_count"), false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors does not retry when the constrained search has mentors", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		return jsonResponse({
			results: [{ name: "Elliot Roberts", slug: "elliot-roberts", disciplines: ["product design"] }],
			queryID: "strict-query",
			indexUsed: "explore",
		});
	};

	try {
		const result = await searchMentors(
			{ SEARCH_SERVICE_URL: "https://search.example" },
			undefined,
			{
				intent: "product design mentor",
				filters: { discipline: "product design", max_results: 5 },
			},
		);

		assert.equal(calls.length, 1);
		assert.equal(new URL(calls[0]).searchParams.get("disciplines"), "product design");
		assert.equal(result.mentors.length, 1);
		assert.equal(result.queryID, "strict-query");
		assert.equal(result.relaxed_filters, undefined);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

function jsonResponse(body) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}
