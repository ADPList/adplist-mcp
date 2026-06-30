import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	buildSearchMentorsUrl,
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

test("search_mentors instructs at most one search per user request (widget-stacking fix)", () => {
	// Loose patterns on purpose: pin the constraint, not the exact wording.
	assert.match(indexSource, /at most\s+once\s+per user request/i);
	assert.match(indexSource, /every call renders another.{0,20}card grid/i);
	assert.match(indexSource, /do not run multiple filter variations/i);
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

test("search_mentors expands weak taxonomy intents instead of forcing brittle discipline facets", () => {
	const growthUrl = new URL(
		buildUrl({
			intent: "need a growth marketing mentor for activation and retention",
			filters: { discipline: "growth marketing" },
		}),
	);
	assert.equal(growthUrl.searchParams.has("disciplines"), false);
	assert.match(growthUrl.searchParams.get("q"), /growth marketing acquisition/i);

	const broadGrowthUrl = new URL(
		buildUrl({
			intent: "US growth mentors",
			filters: { discipline: "Growth" },
		}),
	);
	assert.equal(broadGrowthUrl.searchParams.has("disciplines"), false);
	assert.match(broadGrowthUrl.searchParams.get("q"), /growth marketing acquisition/i);

	const leadershipGrowthUrl = new URL(
		buildUrl({
			intent: "leadership growth mentor",
		}),
	);
	assert.doesNotMatch(leadershipGrowthUrl.searchParams.get("q"), /growth marketing acquisition/i);
	assert.notEqual(leadershipGrowthUrl.searchParams.get("pageSize"), "36");

	const returnshipUrl = new URL(
		buildUrl({
			intent: "career coach for returnship after a career break",
			filters: { discipline: "career coaching" },
		}),
	);
	assert.equal(returnshipUrl.searchParams.has("disciplines"), false);
	assert.match(returnshipUrl.searchParams.get("q"), /return to work/i);

	const productUrl = new URL(
		buildUrl({
			intent: "product design portfolio review",
			filters: { discipline: "product design" },
		}),
	);
	assert.equal(productUrl.searchParams.get("disciplines"), "product design");
});

test("search_mentors infers US country filter from natural language intent", () => {
	const url = new URL(
		buildUrl({
			intent: "Find US growth marketing mentors for retention",
			filters: { max_results: 6 },
		}),
	);
	assert.equal(url.searchParams.get("countries"), "US");

	const lowerCasePronounUrl = new URL(
		buildUrl({
			intent: "help us find growth marketing mentors",
			filters: { max_results: 6 },
		}),
	);
	assert.equal(lowerCasePronounUrl.searchParams.has("countries"), false);

	const outsideUsUrl = new URL(
		buildUrl({
			intent: "find growth marketing mentors outside the US",
			filters: { max_results: 6 },
		}),
	);
	assert.equal(outsideUsUrl.searchParams.has("countries"), false);

	const enrichedProfileOnlyUrl = new URL(
		buildUrl({
			intent:
				"Stored ADPList career context: Role: Founder. Based in United States\nCurrent request: find growth marketing mentors",
			filters: { max_results: 6 },
		}),
	);
	assert.equal(enrichedProfileOnlyUrl.searchParams.has("countries"), false);

	const enrichedRequestUrl = new URL(
		buildUrl({
			intent:
				"Stored ADPList career context: Role: Founder. Based in Canada\nCurrent request: find US growth marketing mentors",
			filters: { max_results: 6 },
		}),
	);
	assert.equal(enrichedRequestUrl.searchParams.get("countries"), "US");
});

test("search_mentors overfetches candidates when a domain-fit gate is active", () => {
	const growthUrl = new URL(
		buildUrl({
			intent: "need a growth marketing mentor for activation and retention",
			filters: { max_results: 6 },
		}),
	);
	assert.equal(growthUrl.searchParams.get("pageSize"), "36");

	const productUrl = new URL(
		buildUrl({
			intent: "product design mentor",
			filters: { max_results: 6 },
		}),
	);
	assert.equal(productUrl.searchParams.get("pageSize"), "6");

	const talentAcquisitionUrl = new URL(
		buildUrl({
			intent: "talent acquisition mentor",
			filters: { max_results: 6 },
		}),
	);
	assert.equal(talentAcquisitionUrl.searchParams.get("pageSize"), "6");
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
	assert.match(source, /const relaxedInput = inputWithoutDiscipline\(input\)/);
	assert.match(
		source,
		/const \{ discipline: _discipline, \.\.\.relaxedFilters \} = input\.filters/,
	);
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
					countryISO: "US",
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

test("search_mentors enforces requested country from upstream country fields", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "US Growth Mentor",
					slug: "us-growth",
					title: "Growth Marketing Lead",
					country: { iso: "US" },
					expertise: ["growth marketing"],
				},
				{
					name: "Canada Product Mentor",
					slug: "canada-product",
					title: "Product Designer",
					countryISO: "CA",
					expertise: ["product design"],
				},
				{
					name: "Missing Country Mentor",
					slug: "missing-country",
					title: "Designer",
					expertise: ["design"],
				},
			],
		},
		{
			intent: "growth marketing mentor in the US",
			filters: { country: "us", max_results: 9 },
		},
	);

	assert.equal(result.mentors.length, 1);
	assert.equal(result.mentors[0].slug, "us-growth");
	assert.equal(result.mentors[0].country_iso, "US");
});

test("search_mentors enforces country inferred from intent when Claude omits the filter", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "US Growth Mentor",
					slug: "us-growth",
					title: "Growth Marketing Lead",
					countryISO: "US",
					expertise: ["growth marketing"],
				},
				{
					name: "Canada Growth Mentor",
					slug: "canada-growth",
					title: "Growth Marketing Lead",
					countryISO: "CA",
					expertise: ["growth marketing"],
				},
			],
		},
		{
			intent: "US growth marketing mentor for retention",
			filters: { max_results: 6 },
		},
	);

	assert.equal(result.mentors.length, 1);
	assert.equal(result.mentors[0].slug, "us-growth");
});

test("search_mentors removes design-only mentors for marketing intents", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "Design Only",
					slug: "design-only",
					title: "Product Design Manager",
					countryISO: "US",
					expertise: ["product design"],
					disciplines: ["design"],
				},
				{
					name: "Design At Marketing Company",
					slug: "design-marketing-company",
					title: "Product Design Director",
					company: "Stagwell Marketing Cloud",
					countryISO: "US",
					expertise: ["product design"],
					disciplines: ["design"],
				},
				{
					name: "Talent Acquisition Product Leader",
					slug: "talent-acquisition-product",
					title: "Product Design Lead",
					countryISO: "US",
					expertise: ["talent acquisition", "marketing"],
					disciplines: ["product", "design"],
				},
				{
					name: "Growth Marketer",
					slug: "growth-marketer",
					title: "Growth Marketing Lead",
					countryISO: "US",
					expertise: ["lifecycle marketing", "retention"],
					disciplines: ["marketing"],
				},
				{
					name: "Talent Acquisition With Growth Craft",
					slug: "ta-growth-craft",
					title: "Talent Acquisition Lead",
					countryISO: "US",
					expertise: ["customer acquisition", "demand generation"],
					disciplines: ["marketing"],
				},
			],
		},
		{
			intent: "growth marketing mentor for activation and retention",
			filters: { country: "US", max_results: 6 },
		},
	);

	assert.deepEqual(
		result.mentors.map((mentor) => mentor.slug),
		["growth-marketer", "ta-growth-craft"],
	);
});

test("search_mentors reranks marketing candidates by growth and product marketing evidence", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "Generic Marketing",
					slug: "generic-marketing",
					title: "Marketing Project Manager",
					countryISO: "US",
					expertise: ["marketing"],
					disciplines: ["event marketing"],
				},
				{
					name: "Product Marketing",
					slug: "product-marketing",
					title: "Product Marketing Advisor",
					countryISO: "US",
					expertise: ["marketing"],
					disciplines: ["product marketing"],
				},
				{
					name: "Growth Lead",
					slug: "growth-lead",
					title: "Head of Product Growth",
					countryISO: "US",
					expertise: ["marketing"],
					disciplines: ["growth product management", "growth hacking"],
				},
				{
					name: "Technical Broad Tags",
					slug: "technical-broad-tags",
					title: "Solution Architect",
					countryISO: "US",
					expertise: ["marketing", "product"],
					disciplines: ["growth product management", "product marketing"],
				},
				{
					name: "Generic Marketing Two",
					slug: "generic-marketing-two",
					title: "Marketing Coordinator",
					countryISO: "US",
					expertise: ["marketing"],
					disciplines: ["event marketing"],
				},
				{
					name: "Generic Marketing Three",
					slug: "generic-marketing-three",
					title: "Marketing Manager",
					countryISO: "US",
					expertise: ["marketing"],
					disciplines: ["event marketing"],
				},
			],
		},
		{
			intent: "US growth marketing mentors",
			filters: { max_results: 6 },
		},
	);

	assert.deepEqual(result.mentors.map((mentor) => mentor.slug), [
		"growth-lead",
		"product-marketing",
	]);
});

test("search_mentors does not fill growth marketing results with weak broad-tag matches", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "Product AI",
					slug: "product-ai",
					title: "Head of Product and AI",
					countryISO: "US",
					expertise: ["product", "ai", "marketing"],
					disciplines: ["platform growth"],
				},
				{
					name: "Founder Product Research",
					slug: "founder-product-research",
					title: "Founder",
					countryISO: "US",
					expertise: ["product research"],
					disciplines: ["platform growth"],
				},
				{
					name: "Customer Success",
					slug: "customer-success",
					title: "Director of Customer Success",
					countryISO: "US",
					expertise: ["product", "sales/bd", "marketing"],
					disciplines: ["customer success"],
				},
				{
					name: "Creative Design",
					slug: "creative-design",
					title: "Creative Leader and Storyteller",
					countryISO: "US",
					expertise: ["design", "marketing"],
					disciplines: ["design"],
				},
				{
					name: "Product Marketing Lead",
					slug: "product-marketing-lead",
					title: "Head of Product Marketing",
					countryISO: "US",
					expertise: ["marketing", "product"],
					disciplines: ["product marketing"],
				},
				{
					name: "Growth Lead",
					slug: "growth-lead",
					title: "Head of Product Growth",
					countryISO: "US",
					expertise: ["marketing"],
					disciplines: ["growth product management"],
				},
			],
		},
		{
			intent: "US growth marketing mentors for acquisition retention lifecycle",
			filters: { max_results: 9 },
		},
	);

	assert.deepEqual(
		result.mentors.map((mentor) => mentor.slug),
		["growth-lead", "product-marketing-lead"],
	);
});

test("search_mentors gates broader growth retries with marketing fit", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "CRM Consultant",
					slug: "crm-consultant",
					title: "Microsoft Dynamics 365/CRM/Power Apps Consultant",
					countryISO: "US",
					expertise: ["no/low code", "engineering", "product"],
					disciplines: ["growth"],
				},
				{
					name: "Product Designer",
					slug: "product-designer",
					title: "Sr Director Product Design",
					countryISO: "US",
					expertise: ["design", "product"],
					disciplines: ["growth"],
				},
				{
					name: "Founder",
					slug: "founder",
					title: "Founder",
					countryISO: "US",
					expertise: ["marketing", "product"],
					disciplines: ["growth"],
				},
				{
					name: "Growth Marketer",
					slug: "growth-marketer",
					title: "Growth Marketing Lead",
					countryISO: "US",
					expertise: ["marketing"],
					disciplines: ["growth"],
				},
				{
					name: "Product Growth",
					slug: "product-growth",
					title: "Head of Product Growth",
					countryISO: "US",
					expertise: ["marketing"],
					disciplines: ["growth product management"],
				},
			],
		},
		{
			intent: "US growth mentors",
			filters: { discipline: "Growth", max_results: 9 },
		},
	);

	assert.deepEqual(
		result.mentors.map((mentor) => mentor.slug),
		["growth-marketer", "product-growth"],
	);
});

test("search_mentors keeps marketing-adjacent consultants while filtering CRM consultants", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "CRM Consultant",
					slug: "crm-consultant",
					title: "Microsoft Dynamics 365/CRM/Power Apps Consultant",
					countryISO: "US",
					expertise: ["no/low code", "engineering", "product"],
					disciplines: ["growth"],
				},
				{
					name: "Digital Consultant",
					slug: "digital-consultant",
					title: "Digital Strategy Consultant",
					countryISO: "US",
					expertise: ["digital marketing", "performance marketing"],
					disciplines: ["marketing"],
				},
				{
					name: "Performance Consultant",
					slug: "performance-consultant",
					title: "Performance Consultant",
					countryISO: "US",
					expertise: ["paid media", "conversion"],
					disciplines: ["marketing"],
				},
			],
		},
		{
			intent: "US growth marketing mentors",
			filters: { max_results: 9 },
		},
	);

	assert.deepEqual(
		result.mentors.map((mentor) => mentor.slug),
		["digital-consultant", "performance-consultant"],
	);
});

test("search_mentors removes product-only mentors for career coaching and returnship intents", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "Product Only",
					slug: "product-only",
					title: "Senior Product Manager",
					countryISO: "US",
					expertise: ["product strategy"],
					disciplines: ["product management"],
				},
				{
					name: "LinkedIn Only",
					slug: "linkedin-only",
					title: "Staff Software Engineer",
					company: "LinkedIn",
					countryISO: "US",
					expertise: ["software engineering"],
					disciplines: ["engineering"],
				},
				{
					name: "Career Coach",
					slug: "career-coach",
					title: "Career Coach",
					countryISO: "US",
					expertise: ["interview preparation", "job search"],
					disciplines: ["career coaching"],
				},
			],
		},
		{
			intent: "career coach for returnship after a career break",
			filters: { country: "US", max_results: 6 },
		},
	);

	assert.deepEqual(
		result.mentors.map((mentor) => mentor.slug),
		["career-coach"],
	);
});

test("why_match cites matched fields instead of only restating expertise tags", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "Maya",
					slug: "maya",
					title: "Director of Growth Marketing",
					employer: "Lifecycle Labs",
					countryISO: "US",
					expertise: ["marketing"],
					disciplines: ["marketing"],
				},
			],
		},
		{
			intent: "growth marketing mentor for lifecycle retention",
			filters: { country: "US", max_results: 3 },
		},
	);

	assert.match(result.mentors[0].why_match, /title mentions growth and marketing/i);
	assert.doesNotMatch(result.mentors[0].why_match, /^Strong in marketing/i);
});

test("search_mentors does not retry when the constrained search has mentors", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		return jsonResponse({
			results: [
				{ name: "Elliot Roberts", slug: "elliot-roberts", disciplines: ["product design"] },
			],
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

function buildUrl(input) {
	return buildSearchMentorsUrl("https://search.example", input);
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
		const searchCalls = calls.filter((c) => c.url.includes("/search?"));
		assert.equal(searchCalls.length, 2);
		const q = new URL(searchCall.url).searchParams.get("q");
		assert.match(q, /Senior Product Manager at Finch Fintech/);
		assert.match(q, /product management/);
		assert.match(q, /transition into UX research/);
		assert.match(q, /Current request: help running first discovery interviews/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors retries the bare intent when profile enrichment returns no mentors", async () => {
	const originalFetch = globalThis.fetch;
	const searchCalls = [];
	globalThis.fetch = async (url) => {
		const href = String(url);
		if (href.includes("/users/profile/me")) return jsonResponse(PROFILE_ME_RESPONSE);

		searchCalls.push(href);
		const q = new URL(href).searchParams.get("q");
		if (q.includes("Current request:")) {
			return jsonResponse({ results: [], queryID: "profile-query", indexUsed: "explore" });
		}
		return jsonResponse({
			results: [
				{
					name: "Growth Mentor",
					slug: "growth-mentor",
					title: "Head of Growth Marketing",
					employer: "Acme",
					countryISO: "US",
					expertise: ["marketing"],
					total_sessions: 22,
					next_7_day_slots_count: 1,
				},
			],
			queryID: "bare-query",
			indexUsed: "explore",
		});
	};

	try {
		const result = await searchMentors(
			{
				SEARCH_SERVICE_URL: "https://search.example",
				AUTH_SERVICE_URL: "https://auth.example",
				PROFILE_DB: EMPTY_PROFILE_DB,
			},
			AUTHED_PROPS,
			{
				intent: "US growth marketing mentor for retention and lifecycle",
				filters: { country: "US", max_results: 6 },
			},
		);

		assert.equal(searchCalls.length, 2);
		assert.match(new URL(searchCalls[0]).searchParams.get("q"), /Current request:/);
		const bareQuery = new URL(searchCalls[1]).searchParams.get("q");
		assert.match(bareQuery, /^US growth marketing mentor for retention and lifecycle/);
		assert.doesNotMatch(bareQuery, /Current request:/);
		assert.equal(result.mentors.length, 1);
		assert.equal(result.mentors[0].slug, "growth-mentor");
		assert.equal(result.queryID, "bare-query");
		assert.deepEqual(result.relaxed_filters, ["profile_context"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors clamps profile-enriched queries below Algolia's byte limit", async () => {
	const originalFetch = globalThis.fetch;
	const searchCalls = [];
	globalThis.fetch = async (url) => {
		if (String(url).includes("/users/profile/me")) return jsonResponse(PROFILE_ME_RESPONSE);
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
			{
				intent: "product designer based in san francisco looking for a mentor to help with design portfolio reviews and interview preparation for faang google meta amazon apple netflix and high-growth startup product design roles. wants someone with a strong product design background who has hiring or interviewing experience at top tech companies and can give sharp actionable feedback on portfolio storytelling case study structure behavioral whiteboard and app critique interview rounds. prefer mentors based in the usa or canada so timezones and the us north american hiring market align.",
				filters: { discipline: "product design", max_results: 6 },
			},
		);

		const q = new URL(searchCalls[0]).searchParams.get("q");
		assert.ok(Buffer.byteLength(q, "utf8") <= 500);
		assert.match(q, /Stored ADPList career context:/);
		assert.match(q, /Current request:/);
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

test("search_mentors keeps the ADPList profile when the D1 stored-context read throws", async () => {
	const originalFetch = globalThis.fetch;
	const searchCalls = [];
	globalThis.fetch = async (url) => {
		if (String(url).includes("/users/profile/me")) return jsonResponse(PROFILE_ME_RESPONSE);
		searchCalls.push(String(url));
		return jsonResponse({ results: [], queryID: "q", indexUsed: "explore" });
	};
	const throwingDb = {
		prepare: () => ({
			bind: () => ({
				first: async () => {
					throw new Error("D1 hiccup");
				},
			}),
		}),
	};

	try {
		await searchMentors(
			{
				SEARCH_SERVICE_URL: "https://search.example",
				AUTH_SERVICE_URL: "https://auth.example",
				PROFILE_DB: throwingDb,
			},
			AUTHED_PROPS,
			{ intent: "discovery interview help" },
		);
		const q = new URL(searchCalls[0]).searchParams.get("q");
		assert.match(q, /Senior Product Manager at Finch Fintech/);
		assert.match(q, /Current request: discovery interview help/);
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
		assert.equal(
			calls.some((url) => url.includes("/users/profile/me")),
			false,
		);
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
					image: "https://adplist-bucket.s3.us-east-2.amazonaws.com/media/profile_photos/4cdac20c.webp",
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
