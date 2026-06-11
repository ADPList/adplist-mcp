import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	mapSearchMentorsResponse,
	normalizeMaxResults,
	searchMentors,
} from "../src/searchMentors.ts";

const source = readFileSync(new URL("../src/searchMentors.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("M2 registers the search_mentors MCP tool", () => {
	assert.match(indexSource, /registerTool\(\s*"search_mentors"/);
	assert.match(indexSource, /existing Explore personalization ranker/);
	assert.match(indexSource, /min\(3\)/);
	assert.match(indexSource, /max\(9\)/);
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

const AUTHED_PROPS = {
	userId: "u1",
	email: null,
	scopes: [],
	cognitoAccessToken: "cognito-token",
};

const PROFILE_ME_RESPONSE = {
	data: {
		profile: { title: "Senior Product Manager", organization: "Finch Fintech" },
		experiences: {
			disciplines: [{ name: "product management" }],
			expertise: [{ expertise: "roadmapping" }],
		},
		preferences: { motivations: ["transition into UX research"] },
		country: { countryName: "Singapore" },
	},
};

// PROFILE_DB stub: user has no stored D1 context.
const EMPTY_PROFILE_DB = {
	prepare: () => ({ bind: () => ({ first: async () => null }) }),
};

test("search_mentors merges the user's own ADPList profile into the search query", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		if (String(url).includes("/users/profile/me")) return jsonResponse(PROFILE_ME_RESPONSE);
		return jsonResponse({ results: [], queryID: "q", indexUsed: "explore" });
	};

	try {
		await searchMentors(
			{
				SEARCH_SERVICE_URL: "https://search.example",
				AUTH_SERVICE_URL: "https://auth.example",
				PROFILE_DB: EMPTY_PROFILE_DB,
			},
			AUTHED_PROPS,
			{ intent: "help running first discovery interviews" },
		);

		const profileCall = calls.find((c) => c.url.includes("/users/profile/me"));
		assert.ok(profileCall, "expected a /users/profile/me fetch");
		assert.equal(profileCall.init.headers.Authorization, "Bearer cognito-token");

		const searchCall = calls.find((c) => c.url.includes("/search?"));
		const q = new URL(searchCall.url).searchParams.get("q");
		assert.match(q, /Senior Product Manager at Finch Fintech/);
		assert.match(q, /product management/);
		assert.match(q, /transition into UX research/);
		assert.match(q, /Current request: help running first discovery interviews/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors fails open to the bare intent when the profile fetch errors", async () => {
	const originalFetch = globalThis.fetch;
	const searchCalls = [];
	globalThis.fetch = async (url) => {
		if (String(url).includes("/users/profile/me")) {
			return new Response("upstream broke", { status: 500 });
		}
		searchCalls.push(String(url));
		return jsonResponse({ results: [], queryID: "q", indexUsed: "explore" });
	};

	try {
		await searchMentors(
			{
				SEARCH_SERVICE_URL: "https://search.example",
				AUTH_SERVICE_URL: "https://auth.example",
				PROFILE_DB: EMPTY_PROFILE_DB,
			},
			AUTHED_PROPS,
			{ intent: "bare intent survives" },
		);
		assert.equal(searchCalls.length, 1);
		assert.equal(new URL(searchCalls[0]).searchParams.get("q"), "bare intent survives");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors never fetches the ADPList profile for unauthenticated callers", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		return jsonResponse({ results: [], queryID: "q", indexUsed: "explore" });
	};

	try {
		await searchMentors({ SEARCH_SERVICE_URL: "https://search.example" }, undefined, {
			intent: "anonymous search",
		});
		assert.equal(calls.some((url) => url.includes("/users/profile/me")), false);
		const q = new URL(calls[0]).searchParams.get("q");
		assert.equal(q, "anonymous search");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("max_results snaps to full rows of three for the card grid", () => {
	assert.equal(normalizeMaxResults(undefined), 6);
	assert.equal(normalizeMaxResults(3), 3);
	// floors to a full row, never exceeding what the caller asked for
	assert.equal(normalizeMaxResults(4), 3);
	assert.equal(normalizeMaxResults(5), 3);
	assert.equal(normalizeMaxResults(6), 6);
	assert.equal(normalizeMaxResults(7), 6);
	assert.equal(normalizeMaxResults(8), 6);
	assert.equal(normalizeMaxResults(9), 9);
	assert.equal(normalizeMaxResults(1), 3);
	assert.equal(normalizeMaxResults(50), 9);
});

test("partial trailing rows are trimmed so the grid renders without gaps", () => {
	const mentor = (i) => ({ name: `Mentor ${i}`, slug: `mentor-${i}` });
	const input = { intent: "design mentor", filters: { max_results: 9 } };
	const results = (n) => ({ results: Array.from({ length: n }, (_, i) => mentor(i)) });

	assert.equal(mapSearchMentorsResponse(results(8), input).mentors.length, 6);
	assert.equal(mapSearchMentorsResponse(results(9), input).mentors.length, 9);
	assert.equal(mapSearchMentorsResponse(results(7), input).mentors.length, 6);
	assert.equal(mapSearchMentorsResponse(results(6), input).mentors.length, 6);
	assert.equal(mapSearchMentorsResponse(results(4), input).mentors.length, 3);
	// below one full row there is nothing to trim against — keep what exists
	assert.equal(mapSearchMentorsResponse(results(2), input).mentors.length, 2);
	assert.equal(mapSearchMentorsResponse(results(0), input).mentors.length, 0);
});

test("region-style adplist-bucket S3 photo hosts are rewritten to the CSP-allowlisted global host", () => {
	const input = { intent: "design mentor" };
	const out = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "Hanshuman Tuteja",
					slug: "hanshuman-tuteja",
					image:
						"https://adplist-bucket.s3.us-east-2.amazonaws.com/media/profile_photos/4cdac20c.webp",
				},
				{
					name: "Global Host",
					slug: "global-host",
					image: "https://adplist-bucket.s3.amazonaws.com/media/profile_photos/abc.webp",
				},
				{
					name: "Other Host",
					slug: "other-host",
					image: "https://lh3.googleusercontent.com/photo.jpg",
				},
			],
		},
		input,
	);
	assert.equal(
		out.mentors[0].profile_photo_url,
		"https://adplist-bucket.s3.amazonaws.com/media/profile_photos/4cdac20c.webp",
	);
	assert.equal(
		out.mentors[1].profile_photo_url,
		"https://adplist-bucket.s3.amazonaws.com/media/profile_photos/abc.webp",
	);
	assert.equal(out.mentors[2].profile_photo_url, "https://lh3.googleusercontent.com/photo.jpg");
});
