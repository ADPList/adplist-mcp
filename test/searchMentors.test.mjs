import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	buildSearchMentorsUrl,
	employerCandidate,
	mapSearchMentorsResponse,
	normalizeMaxResults,
	searchMentors,
} from "../src/searchMentors.ts";

const source = readFileSync(new URL("../src/searchMentors.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("M2 registers the search_mentors MCP tool", () => {
	assert.match(indexSource, /registerTool\(\s*"search_mentors"/);
	assert.match(indexSource, /Explore personalization ranker/);
	assert.match(indexSource, /min\(3\)/);
	assert.match(indexSource, /max\(9\)/);
});

test("search_mentors states one call is sufficient per request (widget-stacking fix)", () => {
	// Loose patterns on purpose: pin the constraint, not the exact wording.
	// Stated as a property of the server rather than as an instruction to the model,
	// so the description carries no model-behaviour directives (directory policy).
	assert.match(indexSource, /one call is sufficient for a request/i);
	assert.match(
		indexSource,
		/overfetches, reranks, relaxes over-strict discipline filters, and tops up sparse domain results/i,
	);
	assert.match(indexSource, /up to nine ranked mentor cards/i);
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
	assert.notEqual(leadershipGrowthUrl.searchParams.get("pageSize"), "72");

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

test("search_mentors exposes and infers seniority filters for executive product intent", () => {
	assert.match(indexSource, /experience_level: z/);
	assert.match(source, /experience_level\?: string/);

	const explicitUrl = new URL(
		buildUrl({
			intent: "Find product leaders in the US",
			filters: { experience_level: "VP Product", max_results: 6 },
		}),
	);
	assert.equal(explicitUrl.searchParams.get("level"), "executive");
	assert.equal(explicitUrl.searchParams.get("pageSize"), "72");

	const leadVerbUrl = new URL(
		buildUrl({
			intent: "Find a mentor who can lead me through a portfolio review",
			filters: { max_results: 6 },
		}),
	);
	assert.equal(leadVerbUrl.searchParams.has("level"), false);
	assert.equal(leadVerbUrl.searchParams.get("pageSize"), "6");

	const inferredUrl = new URL(
		buildUrl({
			intent: "VP of Product in the US",
			filters: { max_results: 6 },
		}),
	);
	assert.equal(inferredUrl.searchParams.get("level"), "executive");
	assert.equal(inferredUrl.searchParams.get("countries"), "US");
});

test("search_mentors reranks executive product leaders above IC PMs and unrelated roles", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "IC PM",
					slug: "ic-pm",
					title: "Product Manager",
					countryISO: "US",
					expertise: ["Product"],
					disciplines: ["Generalist Product Management"],
					total_sessions: 20,
				},
				{
					name: "Product Exec",
					slug: "product-exec",
					title: "VP of Product",
					countryISO: "US",
					expertise: ["Product Strategy"],
					disciplines: ["Generalist Product Management"],
					total_sessions: 8,
				},
				{
					name: "Design Exec",
					slug: "design-exec",
					title: "VP of Design",
					countryISO: "US",
					expertise: ["Design"],
					disciplines: ["Product Design"],
					total_sessions: 30,
				},
			],
			queryID: "q",
			indexUsed: "explore",
		},
		{ intent: "VP of Product in the US", filters: { country: "US", max_results: 3 } },
	);

	assert.equal(result.mentors[0].slug, "product-exec");
	assert.equal(result.mentors[0].title, "VP of Product");
});

test("search_mentors does not let generic Product expertise satisfy product management intent", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "Product Designer",
					slug: "product-designer",
					title: "Product Designer",
					countryISO: "US",
					expertise: ["Product", "Design", "UX"],
					disciplines: ["Product Design"],
					total_sessions: 30,
				},
				{
					name: "Product Engineer",
					slug: "product-engineer",
					title: "Software Engineer",
					countryISO: "US",
					expertise: ["Product", "Architecture"],
					disciplines: ["Full stack"],
					total_sessions: 50,
				},
				{
					name: "Product Manager",
					slug: "product-manager",
					title: "Senior Product Manager",
					countryISO: "US",
					expertise: ["Roadmapping", "Product Strategy"],
					disciplines: ["Generalist Product Management"],
					total_sessions: 10,
				},
			],
		},
		{
			intent: "product management mentor for roadmap and strategy",
			filters: { max_results: 3 },
		},
	);

	assert.deepEqual(
		result.mentors.map((mentor) => mentor.slug),
		["product-manager"],
	);
});

test("search_mentors keeps product designers for product design intent", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "Product Designer",
					slug: "product-designer",
					title: "Product Designer",
					countryISO: "US",
					expertise: ["Product", "Design", "UX"],
					disciplines: ["Product Design"],
				},
			],
		},
		{
			intent: "product design portfolio mentor",
			filters: { max_results: 3 },
		},
	);

	assert.deepEqual(
		result.mentors.map((mentor) => mentor.slug),
		["product-designer"],
	);
});

test("search_mentors filters non-PM titles without Product expertise for PM intent", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "UX Researcher",
					slug: "ux-researcher",
					title: "UX Researcher",
					countryISO: "US",
					expertise: ["Research", "User Interviews"],
					disciplines: ["UX Research"],
				},
				{
					name: "Product Manager",
					slug: "product-manager",
					title: "Product Manager",
					countryISO: "US",
					expertise: ["Roadmapping"],
					disciplines: ["Generalist Product Management"],
				},
			],
		},
		{
			intent: "product management mentor for roadmap and strategy",
			filters: { max_results: 3 },
		},
	);

	assert.deepEqual(
		result.mentors.map((mentor) => mentor.slug),
		["product-manager"],
	);
});

test("search_mentors keeps PM filtering when product management intent mentions adjacent product roles", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "Product Marketing Mentor",
					slug: "product-marketing",
					title: "Product Marketing Manager",
					countryISO: "US",
					expertise: ["Product", "Marketing"],
					disciplines: ["Product Marketing"],
				},
				{
					name: "Product Manager",
					slug: "product-manager",
					title: "Product Manager",
					countryISO: "US",
					expertise: ["Roadmapping"],
					disciplines: ["Generalist Product Management"],
				},
			],
		},
		{
			intent: "transition from product marketing to product management",
			filters: { max_results: 3 },
		},
	);

	assert.deepEqual(
		result.mentors.map((mentor) => mentor.slug),
		["product-manager"],
	);
});

test("search_mentors tops up sparse product management results with a canonical PM query", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		const parsed = new URL(String(url));
		if (parsed.searchParams.get("q")?.startsWith("product management product manager")) {
			return jsonResponse({
				results: [
					{
						name: "Second Product Manager",
						slug: "second-product-manager",
						title: "Product Manager",
						countryISO: "US",
						expertise: ["Prioritization"],
						disciplines: ["Generalist Product Management"],
					},
				],
				queryID: "canonical-pm-query",
				indexUsed: "explore",
			});
		}
		return jsonResponse({
			results: [
				{
					name: "Product Designer",
					slug: "product-designer",
					title: "Product Designer",
					countryISO: "US",
					expertise: ["Product", "Design"],
					disciplines: ["Product Design"],
				},
				{
					name: "First Product Manager",
					slug: "first-product-manager",
					title: "Product Manager",
					countryISO: "US",
					expertise: ["Roadmapping"],
					disciplines: ["Generalist Product Management"],
				},
			],
			queryID: "initial-query",
			indexUsed: "explore",
		});
	};

	try {
		const result = await searchMentors(
			{ SEARCH_SERVICE_URL: "https://search.example" },
			undefined,
			{
				intent: "product management mentor for roadmap and strategy",
				filters: { max_results: 6 },
			},
		);

		assert.equal(new URL(calls[0]).searchParams.get("pageSize"), "72");
		assert.equal(calls.length, 2);
		assert.deepEqual(
			result.mentors.map((mentor) => mentor.slug),
			["first-product-manager", "second-product-manager"],
		);
		assert.deepEqual(result.relaxed_filters, ["query"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors strips result-count instructions from search query text", () => {
	const url = new URL(
		buildUrl({
			intent:
				"Find the top 3 US growth marketing mentors and only return 3 candidates for acquisition retention lifecycle",
			filters: { discipline: "Marketing", country: "US", max_results: 3 },
		}),
	);
	const query = url.searchParams.get("q") ?? "";

	assert.doesNotMatch(query, /top 3/i);
	assert.doesNotMatch(query, /only return 3 candidates/i);
	assert.match(query, /growth marketing/i);
	assert.match(query, /acquisition retention lifecycle/i);
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
			intent: "Stored ADPList career context: Role: Founder. Based in United States\nCurrent request: find growth marketing mentors",
			filters: { max_results: 6 },
		}),
	);
	assert.equal(enrichedProfileOnlyUrl.searchParams.has("countries"), false);

	const enrichedRequestUrl = new URL(
		buildUrl({
			intent: "Stored ADPList career context: Role: Founder. Based in Canada\nCurrent request: find US growth marketing mentors",
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
	assert.equal(growthUrl.searchParams.get("pageSize"), "72");

	const gtmUrl = new URL(
		buildUrl({
			intent: "go-to-market mentor for a startup launch",
			filters: { max_results: 6 },
		}),
	);
	assert.equal(gtmUrl.searchParams.get("pageSize"), "72");
	assert.match(gtmUrl.searchParams.get("q"), /product marketing launch strategy/i);

	const productUrl = new URL(
		buildUrl({
			intent: "product design mentor",
			filters: { max_results: 6 },
		}),
	);
	assert.equal(productUrl.searchParams.get("pageSize"), "6");

	const productManagementUrl = new URL(
		buildUrl({
			intent: "product management mentor for roadmap and strategy",
			filters: { max_results: 6 },
		}),
	);
	assert.equal(productManagementUrl.searchParams.get("pageSize"), "72");

	const careerRoadmapUrl = new URL(
		buildUrl({
			intent: "career roadmap for engineers",
			filters: { max_results: 6 },
		}),
	);
	assert.equal(careerRoadmapUrl.searchParams.get("pageSize"), "6");

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

test("search_mentors validates taxonomy discipline values before search", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		return jsonResponse({ results: [], queryID: "should-not-search", indexUsed: "explore" });
	};

	try {
		await assert.rejects(
			() =>
				searchMentors({ SEARCH_SERVICE_URL: "https://search.example" }, undefined, {
					intent: "need a product mentor",
					filters: { discipline: "Product Management", max_results: 6 },
				}),
			/Unknown discipline "Product Management"\. Try: .*Generalist Product Management.*Group Product Management.*Technical Product Management/,
		);
		assert.equal(calls.length, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors preserves broad non-taxonomy discipline prompts as keyword expansion", () => {
	const url = new URL(
		buildUrl({
			intent: "need a growth marketing mentor",
			filters: { discipline: "growth marketing", max_results: 6 },
		}),
	);
	assert.equal(url.searchParams.has("disciplines"), false);
	assert.match(url.searchParams.get("q"), /growth marketing acquisition/i);
});

test("search_mentors dedupes and diversifies unknown discipline suggestions", async () => {
	await assert.rejects(
		() =>
			searchMentors({ SEARCH_SERVICE_URL: "https://search.example" }, undefined, {
				intent: "need data mentor",
				filters: { discipline: "Data Strategy", max_results: 6 },
			}),
		(error) => {
			assert.equal(
				(error.message.match(/Data Engineering/g) ?? []).length,
				1,
				"Data Engineering should not be suggested twice",
			);
			return true;
		},
	);

	await assert.rejects(
		() =>
			searchMentors({ SEARCH_SERVICE_URL: "https://search.example" }, undefined, {
				intent: "need revenue mentor",
				filters: { discipline: "Chief Revenue Officer", max_results: 6 },
			}),
		/Product Design, Generalist Product Management, Front-end, Data Analysis, Product Marketing, Customer Success Management/,
	);
});

test("search_mentors relaxes valid discipline filters after a zero-result over-strict search", () => {
	assert.match(source, /const relaxedInput = inputWithoutDiscipline\(input\)/);
	assert.match(
		source,
		/const \{ discipline: _discipline, \.\.\.relaxedFilters \} = input\.filters/,
	);
	assert.match(source, /relaxed_filters: \["discipline"\]/);
	assert.match(source, /validateDisciplineFilter\(input\)/);
	assert.match(source, /fetchAndMapSearchMentors/);
});

test("search_mentors retries without valid discipline when the constrained search is empty", async () => {
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
				intent: "senior designer mentors helping new grads break into design",
				filters: { discipline: "UX Design", country: "us", max_results: 5 },
			},
		);

		assert.equal(calls.length, 2);
		assert.equal(new URL(calls[0]).searchParams.get("disciplines"), "ux design");
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

	assert.deepEqual(
		result.mentors.map((mentor) => mentor.slug),
		["growth-lead"],
	);
});

test("search_mentors ranks specialist growth marketing evidence over general marketing", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "General Marketing",
					slug: "general-marketing",
					title: "Marketing Manager",
					countryISO: "US",
					expertise: ["marketing"],
					disciplines: ["marketing"],
				},
				{
					name: "Product Marketing",
					slug: "product-marketing",
					title: "Product Marketing Manager",
					countryISO: "US",
					expertise: ["marketing"],
					disciplines: ["product marketing"],
				},
				{
					name: "Lifecycle Specialist",
					slug: "lifecycle-specialist",
					title: "Lifecycle Marketing Lead",
					countryISO: "US",
					expertise: ["retention", "activation"],
					disciplines: ["marketing"],
				},
				{
					name: "Demand Gen Specialist",
					slug: "demand-gen-specialist",
					title: "Demand Generation Lead",
					countryISO: "US",
					expertise: ["customer acquisition", "paid media"],
					disciplines: ["growth marketing"],
				},
				{
					name: "Product Growth",
					slug: "product-growth",
					title: "Head of Product Growth",
					countryISO: "US",
					expertise: ["experimentation", "conversion"],
					disciplines: ["growth product management"],
				},
			],
		},
		{
			intent: "US growth marketing mentors for customer acquisition retention lifecycle and go-to-market",
			filters: { max_results: 9 },
		},
	);

	assert.deepEqual(
		result.mentors.map((mentor) => mentor.slug),
		["demand-gen-specialist", "product-growth", "lifecycle-specialist"],
	);
});

test("search_mentors keeps genuine growth-role mentors for specialist marketing asks", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "Growth Advisor",
					slug: "growth-advisor",
					title: "Growth Advisor",
					countryISO: "US",
					expertise: ["marketplaces"],
					disciplines: ["growth"],
				},
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
					name: "Bio Growth Only",
					slug: "bio-growth-only",
					title: "Product Advisor",
					bio: "I help companies achieve sustained growth.",
					countryISO: "US",
					expertise: ["marketing"],
					disciplines: ["marketing"],
				},
				{
					name: "Generic Growth Expertise",
					slug: "generic-growth-expertise",
					title: "Leadership Coach",
					countryISO: "US",
					expertise: ["growth"],
					disciplines: ["coaching"],
				},
			],
		},
		{
			intent: "US growth marketing mentors for acquisition retention lifecycle",
			filters: { max_results: 3 },
		},
	);

	assert.deepEqual(
		result.mentors.map((mentor) => mentor.slug),
		["growth-advisor"],
	);
});

test("search_mentors keeps explicit product marketing candidates for hybrid GTM asks", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "Product Marketing",
					slug: "product-marketing",
					title: "Product Marketing Manager",
					countryISO: "US",
					expertise: ["marketing"],
					disciplines: ["product marketing"],
				},
				{
					name: "GTM Specialist",
					slug: "gtm-specialist",
					title: "Strategic GTM Architect",
					countryISO: "US",
					expertise: ["go-to-market", "customer acquisition"],
					disciplines: ["product marketing"],
				},
				{
					name: "Generic Marketing",
					slug: "generic-marketing",
					title: "Marketing Manager",
					countryISO: "US",
					expertise: ["marketing"],
					disciplines: ["marketing"],
				},
			],
		},
		{
			intent: "product marketing mentor to help with go-to-market strategy",
			filters: { max_results: 9 },
		},
	);

	assert.deepEqual(
		result.mentors.map((mentor) => mentor.slug),
		["gtm-specialist", "product-marketing"],
	);
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
		["growth-lead"],
	);
});

test("search_mentors returns a full marketing grid even when Claude asks for fewer", () => {
	const result = mapSearchMentorsResponse(
		{
			results: Array.from({ length: 9 }, (_, index) => ({
				name: `Growth ${index}`,
				slug: `growth-${index}`,
				title: "Growth Marketing Lead",
				countryISO: "US",
				expertise: ["marketing"],
				disciplines: ["growth marketing"],
			})),
		},
		{
			intent: "US growth marketing mentors",
			filters: { max_results: 3 },
		},
	);

	assert.equal(result.mentors.length, 9);
});

test("search_mentors respects explicit smaller user counts for marketing searches", () => {
	const result = mapSearchMentorsResponse(
		{
			results: Array.from({ length: 9 }, (_, index) => ({
				name: `Growth ${index}`,
				slug: `growth-${index}`,
				title: "Growth Marketing Lead",
				countryISO: "US",
				expertise: ["marketing"],
				disciplines: ["growth marketing"],
			})),
		},
		{
			intent: "show me exactly 3 US growth marketing mentors",
			filters: { max_results: 3 },
		},
	);

	assert.equal(result.mentors.length, 3);
});

test("search_mentors respects standalone exactly-N marketing caps", () => {
	const result = mapSearchMentorsResponse(
		{
			results: Array.from({ length: 9 }, (_, index) => ({
				name: `Growth ${index}`,
				slug: `growth-${index}`,
				title: "Growth Marketing Lead",
				countryISO: "US",
				expertise: ["marketing"],
				disciplines: ["growth marketing"],
			})),
		},
		{
			intent: "I want exactly 3",
			filters: { discipline: "Marketing", max_results: 3 },
		},
	);

	assert.equal(result.mentors.length, 3);
});

test("search_mentors does not treat top-N ranking language as a hard marketing cap", () => {
	const result = mapSearchMentorsResponse(
		{
			results: Array.from({ length: 9 }, (_, index) => ({
				name: `Growth ${index}`,
				slug: `growth-${index}`,
				title: "Growth Marketing Lead",
				countryISO: "US",
				expertise: ["marketing"],
				disciplines: ["growth marketing"],
			})),
		},
		{
			intent: "top 3 US growth marketing mentors",
			filters: { max_results: 3 },
		},
	);

	assert.equal(result.mentors.length, 9);
});

test("search_mentors keeps full marketing grids when top-N intent includes cap-like wording", () => {
	const result = mapSearchMentorsResponse(
		{
			results: Array.from({ length: 9 }, (_, index) => ({
				name: `Growth ${index}`,
				slug: `growth-${index}`,
				title: "Growth Marketing Lead",
				countryISO: "US",
				expertise: ["marketing"],
				disciplines: ["growth marketing"],
			})),
		},
		{
			intent: "Find the top 3 US growth marketing mentors and only return 3 candidates",
			filters: { max_results: 3 },
		},
	);

	assert.equal(result.mentors.length, 9);
});

test("search_mentors tops up sparse domain results inside one tool call", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		const parsed = new URL(String(url));
		if (parsed.searchParams.has("disciplines")) {
			return jsonResponse({
				results: [
					{
						name: "Lifecycle Specialist",
						slug: "lifecycle-specialist",
						title: "Lifecycle Marketing Lead",
						countryISO: "US",
						expertise: ["retention"],
						disciplines: ["marketing"],
					},
				],
				queryID: "strict-query",
				indexUsed: "explore",
			});
		}
		return jsonResponse({
			results: [
				{
					name: "Lifecycle Specialist",
					slug: "lifecycle-specialist",
					title: "Lifecycle Marketing Lead",
					countryISO: "US",
					expertise: ["retention"],
					disciplines: ["marketing"],
				},
				{
					name: "Product Growth",
					slug: "product-growth",
					title: "Head of Product Growth",
					countryISO: "US",
					expertise: ["experimentation"],
					disciplines: ["growth product management"],
				},
				{
					name: "Demand Gen",
					slug: "demand-gen",
					title: "Demand Generation Lead",
					countryISO: "US",
					expertise: ["paid media"],
					disciplines: ["growth marketing"],
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
				intent: "US growth marketing mentors for acquisition retention lifecycle",
				filters: { discipline: "Marketing", max_results: 3 },
			},
		);

		assert.equal(calls.length, 3);
		assert.equal(new URL(calls[0]).searchParams.has("disciplines"), true);
		assert.equal(new URL(calls[1]).searchParams.has("disciplines"), false);
		assert.match(new URL(calls[2]).searchParams.get("q"), /^growth marketing acquisition/);
		assert.equal(new URL(calls[2]).searchParams.get("countries"), "US");
		assert.deepEqual(
			result.mentors.map((mentor) => mentor.slug),
			["lifecycle-specialist", "demand-gen", "product-growth"],
		);
		assert.equal(result.queryID, undefined);
		assert.deepEqual(
			result.mentors.map((mentor) => mentor.queryID),
			["strict-query", "relaxed-query", "relaxed-query"],
		);
		assert.deepEqual(result.relaxed_filters, ["discipline", "query"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors does not use growth top-up for non-growth marketing specialties", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		const parsed = new URL(String(url));
		if (parsed.searchParams.has("disciplines")) {
			return jsonResponse({
				results: [
					{
						name: "SEO Specialist",
						slug: "seo-specialist",
						title: "SEO Marketing Lead",
						countryISO: "US",
						expertise: ["SEO"],
						disciplines: ["marketing"],
					},
				],
				queryID: "strict-query",
				indexUsed: "explore",
			});
		}
		return jsonResponse({ results: [], queryID: "relaxed-query", indexUsed: "explore" });
	};

	try {
		const result = await searchMentors(
			{ SEARCH_SERVICE_URL: "https://search.example" },
			undefined,
			{
				intent: "US SEO mentors",
				filters: { discipline: "Marketing", max_results: 3 },
			},
		);

		// bare-name probe ("US SEO"), constrained search, relaxed retry
		assert.equal(calls.length, 3);
		assert.doesNotMatch(
			new URL(calls.at(-1)).searchParams.get("q") ?? "",
			/^growth marketing acquisition/,
		);
		assert.deepEqual(
			result.mentors.map((mentor) => mentor.slug),
			["seo-specialist"],
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors does not collapse slug-less mentors while merging top-up results", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		const parsed = new URL(String(url));
		if (parsed.searchParams.has("disciplines")) {
			return jsonResponse({
				results: [
					{
						name: "Lifecycle Specialist",
						title: "Lifecycle Marketing Lead",
						countryISO: "US",
						expertise: ["retention"],
						disciplines: ["marketing"],
					},
				],
				queryID: "strict-query",
				indexUsed: "explore",
			});
		}
		return jsonResponse({
			results: [
				{
					name: "Lifecycle Specialist",
					title: "Lifecycle Marketing Lead",
					countryISO: "US",
					expertise: ["retention"],
					disciplines: ["marketing"],
				},
				{
					name: "Demand Gen",
					title: "Demand Generation Lead",
					countryISO: "US",
					expertise: ["paid media"],
					disciplines: ["growth marketing"],
				},
				{
					name: "Product Growth",
					title: "Head of Product Growth",
					countryISO: "US",
					expertise: ["experimentation"],
					disciplines: ["growth product management"],
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
				intent: "US growth marketing mentors for acquisition retention lifecycle",
				filters: { discipline: "Marketing", max_results: 3 },
			},
		);

		assert.deepEqual(
			result.mentors.map((mentor) => mentor.name),
			["Lifecycle Specialist", "Demand Gen", "Product Growth"],
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
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

test("why_match explains taxonomy-expanded GTM matches", () => {
	const result = mapSearchMentorsResponse(
		{
			results: [
				{
					name: "Parth",
					slug: "parth",
					title: "Senior Marketing Manager - Demand Generation",
					countryISO: "US",
					expertise: ["marketing"],
					disciplines: ["marketing"],
					next_7_day_slots_count: 4,
				},
			],
		},
		{
			intent: "go-to-market mentor for a startup launch in the US",
			filters: { max_results: 3 },
		},
	);

	assert.match(result.mentors[0].why_match, /title mentions/i);
	assert.match(result.mentors[0].why_match, /marketing/i);
	assert.match(result.mentors[0].why_match, /demand/i);
	assert.doesNotMatch(result.mentors[0].why_match, /^Based in US; has availability/i);
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

test("search_mentors resolves a literal mentor name through the profile endpoint before Explore", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		if (String(url).includes("/users/profile/mentor/brennan-collins")) {
			return jsonResponse(BRENNAN_PROFILE_RESPONSE);
		}
		return jsonResponse({ results: [{ name: "Wrong Mentor", slug: "wrong-mentor" }] });
	};

	try {
		const result = await searchMentors(
			{
				SEARCH_SERVICE_URL: "https://search.example",
				AUTH_SERVICE_URL: "https://auth.example",
			},
			undefined,
			{ intent: "Find Brennan Collins mentor" },
		);

		assert.equal(calls.length, 1);
		assert.equal(calls[0], "https://auth.example/users/profile/mentor/brennan-collins");
		assert.equal(result.indexUsed, "profile_lookup");
		assert.equal(result.mentors[0].slug, "brennan-collins");
		assert.equal(result.mentors[0].name, "Brennan Collins");
		assert.equal(result.mentors[0].title, "Chief Product Officer");
		assert.equal(result.mentors[0].sessions_count, null);
		assert.equal(result.mentors[0].next_7_day_slots_count, null);
		assert.equal(result.mentors[0].country_iso, "US");
		assert.equal(result.mentors[0].why_match, "Exact ADPList mentor profile name match.");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors uses only the current request for literal name lookup", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		if (String(url).includes("/users/profile/mentor/brennan-collins")) {
			return jsonResponse(BRENNAN_PROFILE_RESPONSE);
		}
		return jsonResponse({ results: [] });
	};

	try {
		const result = await searchMentors(
			{
				SEARCH_SERVICE_URL: "https://search.example",
				AUTH_SERVICE_URL: "https://auth.example",
			},
			undefined,
			{
				intent: "Stored ADPList career context: Role: Founder. Based in United States\nCurrent request: Brennan Collins",
			},
		);

		assert.equal(calls.length, 1);
		assert.equal(calls[0], "https://auth.example/users/profile/mentor/brennan-collins");
		assert.equal(result.mentors[0].slug, "brennan-collins");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors falls back to Explore when a literal profile candidate does not match", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		if (String(url).includes("/users/profile/mentor/brennan-collins")) {
			return jsonResponse({ data: { fullName: "Brenna Collins" } });
		}
		return jsonResponse({
			results: [{ name: "Explore Brennan", slug: "explore-brennan" }],
			queryID: "explore-query",
			indexUsed: "explore",
		});
	};

	try {
		const result = await searchMentors(
			{
				SEARCH_SERVICE_URL: "https://search.example",
				AUTH_SERVICE_URL: "https://auth.example",
			},
			undefined,
			{ intent: "Brennan Collins" },
		);

		assert.equal(calls.length, 3);
		assert.equal(calls[0], "https://auth.example/users/profile/mentor/brennan-collins");
		assert.equal(new URL(calls[1]).searchParams.get("q"), "Brennan Collins");
		assert.equal(new URL(calls[2]).pathname, "/search");
		assert.equal(result.mentors[0].slug, "explore-brennan");
		assert.equal(result.queryID, "explore-query");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors falls back to Explore when literal profile filters do not match", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		if (String(url).includes("/users/profile/mentor/brennan-collins")) {
			return jsonResponse(BRENNAN_PROFILE_RESPONSE);
		}
		return jsonResponse({
			results: [{ name: "Filtered Explore", slug: "filtered-explore", countryISO: "CA" }],
			queryID: "filtered-query",
			indexUsed: "explore",
		});
	};

	try {
		const result = await searchMentors(
			{ SEARCH_SERVICE_URL: "https://search.example", AUTH_SERVICE_URL: "https://auth.example" },
			undefined,
			{ intent: "Brennan Collins", filters: { country: "CA" } },
		);

		assert.equal(calls.length, 3);
		assert.equal(result.mentors[0].slug, "filtered-explore");
		assert.equal(result.queryID, "filtered-query");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors finds a mentor by name through Explore when the slug guess misses (ADPLIST-3805)", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		if (String(url).includes("/users/profile/mentor/")) {
			return jsonResponse({ message: "Not found" }, 404);
		}
		if (String(url).includes("/users/profile/me")) return jsonResponse(PROFILE_ME_RESPONSE);
		return jsonResponse({
			results: [
				{ name: "Regina Riasantika Rahayu", slug: "regina-rahayu", title: "CX", countryISO: "ID" },
			],
			queryID: "name-query",
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
			{ intent: "Regina Ria Santika" },
		);

		const searchCalls = calls.filter((c) => c.includes("/search?"));
		assert.equal(searchCalls.length, 1, "one bare-name search, no profile-enriched retry");
		const q = new URL(searchCalls[0]).searchParams.get("q");
		assert.equal(q, "Regina Ria Santika", "the name reaches the search service as typed");
		assert.doesNotMatch(q, /Stored ADPList career context/);
		assert.equal(result.mentors.length, 1);
		assert.equal(result.mentors[0].slug, "regina-rahayu");
		assert.equal(result.mentors[0].why_match, 'Name matches "Regina Ria Santika".');
		assert.equal(result.queryID, "name-query");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors keeps only name hits that contain every requested word", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		if (String(url).includes("/users/profile/mentor/")) {
			return jsonResponse({ message: "Not found" }, 404);
		}
		return jsonResponse({
			results: [
				{ name: "Priyal Jain", slug: "priyal-jain" },
				{ name: "Priya Verma", slug: "priya-verma-5wq9" },
				{ name: "Priya Verma", slug: "priya-verma" },
				{ name: "Supriya Vermani", slug: "supriya-vermani" },
			],
			indexUsed: "explore",
		});
	};

	try {
		const result = await searchMentors(
			{ SEARCH_SERVICE_URL: "https://search.example", AUTH_SERVICE_URL: "https://auth.example" },
			undefined,
			{ intent: "Priya Verma" },
		);
		assert.deepEqual(
			result.mentors.map((m) => m.slug),
			["priya-verma-5wq9", "priya-verma"],
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors name match requires token starts, not substrings", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		if (String(url).includes("/users/profile/mentor/")) {
			return jsonResponse({ message: "Not found" }, 404);
		}
		return jsonResponse({
			results: [{ name: "Joanne Leeman", slug: "joanne-leeman" }],
			indexUsed: "explore",
		});
	};

	try {
		const result = await searchMentors(
			{ SEARCH_SERVICE_URL: "https://search.example", AUTH_SERVICE_URL: "https://auth.example" },
			undefined,
			{ intent: "Ann Lee" },
		);
		assert.equal(calls.filter((c) => c.includes("/search?")).length, 2, "fell through to intent path");
		assert.notEqual(result.mentors[0]?.why_match, 'Name matches "Ann Lee".');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors falls through to the intent path when no Explore hit carries the name", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		if (String(url).includes("/users/profile/mentor/")) {
			return jsonResponse({ message: "Not found" }, 404);
		}
		if (String(url).includes("/users/profile/me")) return jsonResponse(PROFILE_ME_RESPONSE);
		return jsonResponse({
			results: [
				{ name: "Ezzeddine Jradi", slug: "ezzeddine-jradi" },
				{ name: "Louise Honore", slug: "louise-honore" },
			],
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
			{ intent: "Portfolio Review" },
		);

		const queries = calls
			.filter((c) => c.includes("/search?"))
			.map((c) => new URL(c).searchParams.get("q"));
		assert.equal(queries[0], "Portfolio Review");
		assert.match(queries[1], /Stored ADPList career context/);
		assert.match(queries[1], /Current request: Portfolio Review/);
		assert.equal(result.mentors.length, 2);
		assert.notEqual(result.mentors[0].why_match, 'Name matches "Portfolio Review".');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors finds a mentor typed in lowercase", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		if (String(url).includes("/users/profile/mentor/")) {
			return jsonResponse({ message: "Not found" }, 404);
		}
		if (String(url).includes("/users/profile/me")) return jsonResponse(PROFILE_ME_RESPONSE);
		return jsonResponse({
			results: [{ name: "Regina Riasantika Rahayu", slug: "regina-rahayu" }],
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
			{ intent: "regina ria santika" },
		);
		assert.equal(result.mentors.length, 1);
		assert.equal(result.mentors[0].slug, "regina-rahayu");
		assert.equal(result.mentors[0].why_match, 'Name matches "regina ria santika".');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
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

const BRENNAN_PROFILE_RESPONSE = {
	data: {
		fullName: "Brennan Collins",
		profile: {
			title: "Chief Product Officer",
			organization: "Unabated Products",
			image: "https://adplist-bucket.s3.us-east-2.amazonaws.com/media/profile_photos/brennan.webp",
		},
		experiences: {
			expertise: [{ expertise: "Product Strategy" }, { expertise: "Leadership" }],
		},
		country: { iso: "US" },
	},
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

		assert.equal(searchCalls.length, 3);
		assert.match(new URL(searchCalls[0]).searchParams.get("q"), /Current request:/);
		const bareQuery = new URL(searchCalls[1]).searchParams.get("q");
		assert.match(bareQuery, /^US growth marketing mentor for retention and lifecycle/);
		assert.doesNotMatch(bareQuery, /Current request:/);
		assert.match(
			new URL(searchCalls[2]).searchParams.get("q"),
			/^growth marketing acquisition/,
		);
		assert.equal(result.mentors.length, 1);
		assert.equal(result.mentors[0].slug, "growth-mentor");
		assert.equal(result.queryID, "bare-query");
		assert.deepEqual(result.relaxed_filters, ["profile_context", "query"]);
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

		// "experience at top tech companies" also trips the employer detector,
		// which costs one bare search that matches nobody; assert on the enriched call.
		const q = searchCalls
			.map((url) => new URL(url).searchParams.get("q"))
			.find((value) => value.includes("Current request:"));
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
		// bare-name probe, then the intent search with no profile prefix
		assert.equal(searchCalls.length, 2);
		assert.equal(new URL(searchCalls.at(-1)).searchParams.get("q"), "bare intent survives");
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
		// [0] bare-name probe, [1] profile-enriched search, [2] bare retry
		const q = new URL(searchCalls[1]).searchParams.get("q");
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
	assert.equal(normalizeMaxResults(undefined), 9);
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

function employerMentor(index, employer) {
	return {
		name: `Mentor ${index}`,
		slug: `mentor-${index}`,
		title: "Product Designer",
		employer,
		country: { iso: "US" },
	};
}

test("employerCandidate detects at / from / work at phrasing without a capitalisation gate", () => {
	assert.equal(employerCandidate("find me mentors who work at Google"), "Google");
	assert.equal(employerCandidate("mentors at google who can review my portfolio"), "google");
	assert.equal(employerCandidate("designers from Google DeepMind, senior"), "Google DeepMind");
	assert.equal(employerCandidate("someone working for the New York Times"), "New York Times");
	assert.equal(
		employerCandidate("Stored ADPList career context: at Shopify\nCurrent request: mentors employed by Meta"),
		"Meta",
	);
	assert.equal(employerCandidate("senior product designer for portfolio review"), "");
	// Reviewer findings: geography, skills, transitions and self-descriptions are not employers.
	assert.equal(employerCandidate("mentors from Canada"), "");
	assert.equal(employerCandidate("mentors from the US"), "");
	assert.equal(employerCandidate("someone good at product strategy"), "");
	assert.equal(employerCandidate("help transitioning from design to product management"), "");
	assert.equal(employerCandidate("I'm a PM at Google who wants help transitioning to design"), "");
	assert.equal(employerCandidate("I'm a designer. Find mentors who work at Google"), "Google");
});

test("search_mentors keeps the role intent when filtering employer hits", async () => {
	const originalFetch = globalThis.fetch;
	const requests = [];
	globalThis.fetch = async (url) => {
		const parsed = new URL(url);
		requests.push({ q: parsed.searchParams.get("q"), pageSize: parsed.searchParams.get("pageSize") });
		if (parsed.searchParams.get("q") === "Google") {
			return jsonResponse({
				results: [
					{ ...employerMentor(1, "Google"), title: "Senior Product Manager" },
					{ ...employerMentor(2, "Google"), title: "Staff Software Engineer" },
					{ ...employerMentor(3, "Google"), title: "Group Product Manager" },
				],
				indexUsed: "explore",
			});
		}
		return jsonResponse({
			results: Array.from({ length: 9 }, (_, i) => ({ ...employerMentor(i + 10, "Other"), title: "Product Manager" })),
			indexUsed: "explore",
		});
	};

	try {
		const result = await searchMentors(
			{ SEARCH_SERVICE_URL: "https://search.example", AUTH_SERVICE_URL: "https://auth.example" },
			undefined,
			{ intent: "product managers who work at Google" },
		);
		assert.equal(requests[0].q, "Google");
		assert.equal(requests[0].pageSize, "72");
		assert.deepEqual(
			result.mentors.slice(0, 2).map((mentor) => mentor.slug),
			["mentor-1", "mentor-3"],
		);
		assert.ok(!result.mentors.some((mentor) => mentor.slug === "mentor-2"));
		assert.equal(result.mentors.length, 9);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors puts employer matches first and tops up to nine from the intent path", async () => {
	const originalFetch = globalThis.fetch;
	const queries = [];
	globalThis.fetch = async (url) => {
		const q = new URL(url).searchParams.get("q");
		queries.push(q);
		if (q === "Google") {
			return jsonResponse({
				results: [
					employerMentor(1, "Google"),
					employerMentor(2, "Meta"),
					employerMentor(3, "Google DeepMind"),
					employerMentor(4, "Googleplex Consulting"),
				],
				queryID: "bare",
				indexUsed: "explore",
			});
		}
		return jsonResponse({
			results: [employerMentor(1, "Google"), ...[5, 6, 7, 8, 9, 10, 11, 12].map((i) => employerMentor(i, "Other"))],
			queryID: "intent",
			indexUsed: "explore",
		});
	};

	try {
		const result = await searchMentors(
			{ SEARCH_SERVICE_URL: "https://search.example", AUTH_SERVICE_URL: "https://auth.example" },
			undefined,
			{ intent: "find me mentors who work at Google" },
		);

		assert.deepEqual(queries, ["Google", "find me mentors who work at Google"]);
		assert.equal(result.mentors.length, 9);
		assert.deepEqual(
			result.mentors.slice(0, 2).map((mentor) => mentor.slug),
			["mentor-1", "mentor-3"],
		);
		assert.equal(result.mentors[0].why_match, "Works at Google.");
		assert.ok(!result.mentors.some((mentor) => mentor.slug === "mentor-4"));
		assert.equal(new Set(result.mentors.map((mentor) => mentor.slug)).size, 9);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors returns only employer matches when they fill the requested size", async () => {
	const originalFetch = globalThis.fetch;
	const queries = [];
	globalThis.fetch = async (url) => {
		queries.push(new URL(url).searchParams.get("q"));
		return jsonResponse({
			results: Array.from({ length: 12 }, (_, i) => employerMentor(i, "Google")),
			indexUsed: "explore",
		});
	};

	try {
		const result = await searchMentors(
			{ SEARCH_SERVICE_URL: "https://search.example", AUTH_SERVICE_URL: "https://auth.example" },
			undefined,
			{ intent: "mentors at google" },
		);
		assert.deepEqual(queries, ["google"]);
		assert.equal(result.mentors.length, 9);
		assert.ok(result.mentors.every((mentor) => mentor.why_match === "Works at Google."));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("search_mentors behaves as before when no mentor works at the requested company", async () => {
	const originalFetch = globalThis.fetch;
	const queries = [];
	globalThis.fetch = async (url) => {
		queries.push(new URL(url).searchParams.get("q"));
		return jsonResponse({
			results: Array.from({ length: 9 }, (_, i) => employerMentor(i, "Other Co")),
			indexUsed: "explore",
		});
	};

	try {
		const result = await searchMentors(
			{ SEARCH_SERVICE_URL: "https://search.example", AUTH_SERVICE_URL: "https://auth.example" },
			undefined,
			{ intent: "mentors who work at Acme Tiny Startup" },
		);
		assert.deepEqual(queries, ["Acme Tiny Startup", "mentors who work at Acme Tiny Startup"]);
		assert.equal(result.mentors.length, 9);
		assert.ok(result.mentors.every((mentor) => !mentor.why_match.startsWith("Works at")));
	} finally {
		globalThis.fetch = originalFetch;
	}
});
