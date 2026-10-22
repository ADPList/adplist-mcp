import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { handlePublicRequest, PUBLIC_TOOLS } from "../src/public/mcp.ts";
import { PUBLIC_MENTOR_KEYS, publicPhotoUrl, publicProfileUrl } from "../src/public/mapper.ts";
import { normalizeSource, parsePublicMcpPath, sourceFromClientName } from "../src/public/source.ts";
import { checkMentorVisibility, internalVisibilityUrl, publicVisibilityUrl } from "../src/public/visibility.ts";
import { PUBLIC_RATE_WINDOWS, takeRateSlot } from "../src/public/rateWindows.ts";
import {
	companyCandidates,
	companyConfirmedByEmployers,
	companyNamedByEmployers,
	countryIntentIn,
	currentEmployer,
	isCurrentEmployer,
	knownCompanyIn,
	titleMarksEmployerPast,
	requestedAfterSelfReference,
	withoutPlaces,
} from "../src/public/company.ts";
import { requestedRoleFamilies, roleFit } from "../src/public/role.ts";
import {
	buildSearchMentorsUrl,
	employerCandidate,
	literalNameCandidate,
	mapSearchMentorsResponse,
} from "../src/searchMentors.ts";
import { checkField, FIELDS, pageTexts, verifyMentor } from "../scripts/verify-public-fields.mjs";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const wranglerSource = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const previewSource = readFileSync(new URL("../wrangler.preview.jsonc", import.meta.url), "utf8");
const readmeSource = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const publicDocsSource = readFileSync(new URL("../docs/public-mcp.md", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// Fake upstream. Every record and row is stuffed with fields that must never
// reach a public output, plus the injected secrets below.
// ---------------------------------------------------------------------------

const FAKE_TOKEN = "sk-ant-FAKE123";
const FAKE_HOST = "internal.adplist.local";
const FAKE_ID = "da1a242d";
const SECRETS = [FAKE_TOKEN, FAKE_HOST, FAKE_ID];
const BANNED_SUBSTRINGS = [
	"availability",
	"queryID",
	"indexUsed",
	"position",
	"legacy",
	"userId",
	"gender",
	"timezone",
	// Not shown on the public profile page (ADPLIST-4360), so never public.
	"total_sessions",
	"sessions_count",
];

const NAMES = {
	"alice-visible": "Alice Visible",
	"bob-visible": "Bob Visible",
	"gina-google": "Gina Google",
	"gary-google": "Gary Google",
	"inactive-mentor": "Ina Active",
	"status-inactive": "Stan Status",
	"not-a-mentor": "Nate Mentee",
	"suspended-mentor": "Sue Spended",
	"onbreak-mentor": "Brea King",
	"optout-mentor": "Otto Out",
	"denied-mentor": "Dee Nied",
	"profile-500": "Five Hundred",
	"profile-throws": "Thea Throws",
	"profile-malformed": "Mal Formed",
	"profile-noshape": "Nash Ape",
	"jane-hidden": "Jane Hidden",
	"stringy-break": "Stringy Break",
	"stringy-optout": "Stringy Optout",
	"null-suspended": "Nell Suspended",
	"stringy-active": "Stringy Active",
	"array-flags": "Ari Flags",
	"no-optout-flag": "Nova Flagless",
	"left-google": "Lee Left",
	"now-google": "Nora Now",
	"past-google": "Pat Past",
	"ina-initech": "Ina Initech",
	"pia-google": "Pia Pm",
	"nico-google": "Nico Now",
	"paul-google": "Paul Past",
	"mia-meta": "Mia Meta",
	"dee-deepmind": "Dee Mind",
	"rita-reality": "Rita Reality",
	"fay-figma": "Fay Figma",
	"cara-canva": "Cara Canva",
	"chris-google": "Chris Former",
	"dora-google": "Dora Director",
	"ezra-google": "Ezra Expm",
	"ada-google": "Ada Advisor",
};

// Search rows say Google for every *-google slug unless overridden here.
const ROW_EMPLOYER = {
	"now-google": "Google | previously at Meta",
	"past-google": "Stripe | previously at Google",
	"ina-initech": "Initech",
	"nico-google": "Google | previously at Meta",
	"paul-google": "Stripe | previously at Google",
	"mia-meta": "Meta",
	"dee-deepmind": "Google DeepMind",
	"rita-reality": "Meta Reality Labs | previously at Google",
	"fay-figma": "Figma",
	"cara-canva": "Canva",
};
const PM_SLUGS = new Set(["pia-google", "nico-google", "paul-google", "mia-meta", "rita-reality"]);
// Company field Google; the title says whether that is current (ADPLIST-4479).
const TITLE_OVERRIDES = {
	"chris-google": "Former Director of UX",
	"dora-google": "Director of UX",
	"ezra-google": "Ex-Google PM",
	"ada-google": "Advisor | Former Director at Google",
};
const titleOf = (slug) =>
	TITLE_OVERRIDES[slug] ?? (PM_SLUGS.has(slug) ? "Senior Product Manager" : "Senior Product Designer");
// Per-slug disciplines/expertise for both the search row and the identity
// record; everyone else is a Product Design mentor.
const LABEL_OVERRIDES = {};
// A stale search-index title; the card always shows the profile's.
const ROW_TITLE_OVERRIDES = {};
const disciplinesOf = (slug) => LABEL_OVERRIDES[slug]?.disciplines ?? ["Product Design"];
const expertiseOf = (slug) => LABEL_OVERRIDES[slug]?.expertise ?? ["Product Strategy", "Mobile Apps"];
// Identity records; left-google disagrees with its search row.
const RECORD_COMPANY = { ...ROW_EMPLOYER, "left-google": "Other Company" };

const HIDDEN_OVERRIDES = {
	"inactive-mentor": { is: { active: false } },
	"status-inactive": { status: "inactive" },
	"not-a-mentor": { is: { mentor: false } },
	"suspended-mentor": { is: { suspended: true } },
	"onbreak-mentor": { is: { onBreak: true } },
	"optout-mentor": { is: { aiSearchOptOut: true } },
	"jane-hidden": { is: { suspended: true } },
	// Malformed flags: present but not booleans.
	"stringy-break": { is: { onBreak: "true" } },
	"stringy-optout": { is: { aiSearchOptOut: "true" } },
	"null-suspended": { is: { suspended: null } },
	"stringy-active": { is: { active: "true" } },
	// Absent is fine: aiSearchOptOut is new and older records lack it.
	"no-optout-flag": { is: { aiSearchOptOut: undefined } },
};

const MALFORMED_FLAG_SLUGS = ["stringy-break", "stringy-optout", "null-suspended", "stringy-active", "array-flags"];

// Per-slug overrides of either record's top-level listing flags.
const INTERNAL_OVERRIDES = {};
const PUBLIC_OVERRIDES = {};
// Per-slug search-row fields (e.g. country), merged over the defaults.
const ROW_OVERRIDES = {};

// GET /internal/users/profile/mentor/{slug} (x-api-key, ADPLIST-4485): flags
// and identifiers only, exactly the keys the live route returns. Nothing
// displayable — no fullName, profile, experiences, preferences, country, bio.
function internalRecord(slug) {
	const override = HIDDEN_OVERRIDES[slug] ?? {};
	return {
		data: {
			bookable: true,
			indexable: true,
			is: slug === "array-flags"
				? [true, true]
				: {
						active: true,
						mentor: true,
						suspended: false,
						onBreak: false,
						aiSearchOptOut: false,
						...override.is,
					},
			legacyId: 4242,
			metadata: { queryID: "q-123", indexUsed: "mentors_prod" },
			slug,
			status: override.status ?? "active",
			userId: `user-${FAKE_ID}`,
			...INTERNAL_OVERRIDES[slug],
		},
	};
}

// GET /users/profile/mentor/{slug} (anonymous): the display record. No is.*
// since identity-service #184; stuffed with fields that must never be public.
function identityRecord(slug) {
	const override = HIDDEN_OVERRIDES[slug] ?? {};
	const company = RECORD_COMPANY[slug] ?? (slug.endsWith("google") ? "Google" : "Acme Labs");
	return {
		data: {
			id: FAKE_ID,
			_id: FAKE_ID,
			legacy_id: 4242,
			slug,
			fullName: NAMES[slug],
			status: override.status ?? "active",
			bookable: true,
			indexable: true,
			userType: "mentor",
			relationshipTarget: `user-${FAKE_ID}`,
			gender: "female",
			timezone: "Asia/Singapore",
			email: `${slug}@${FAKE_HOST}`,
			bio: `Bio for ${NAMES[slug]}. ${"Mentoring product teams for a decade. ".repeat(20)}`,
			profile: {
				title: titleOf(slug),
				organization: company,
				image: `https://adplist-bucket.s3.us-east-2.amazonaws.com/media/${slug}.jpg?X-Amz-Signature=${FAKE_TOKEN}`,
			},
			country: { iso: "SG", countryName: "Singapore", legacyId: 7 },
			experiences: {
				expertise: expertiseOf(slug).map((expertise, index) => ({ legacyId: index + 1, expertise })),
				disciplines: disciplinesOf(slug).map((discipline, index) => ({ legacyId: index + 3, discipline })),
				experienceLevel: { legacyId: 9, seniority: "Senior" },
			},
			preferences: { languages: [{ legacyId: 1, language: "English" }], timezone: "Asia/Singapore" },
			webLinks: { linkedin: `https://linkedin.com/in/${slug}` },
			workExperience: [{ company: FAKE_HOST, position: "CTO" }],
			metadata: { queryID: "q-123", indexUsed: "mentors_prod" },
			legal: { acceptedTermsAt: 1 },
			reviews: [{ review: `Great mentor ${FAKE_TOKEN}`, userId: FAKE_ID }],
			swagUrl: `https://adplist.org/swag?ref=${FAKE_ID}`,
			referralUrl: `https://adplist.org/r/${FAKE_ID}`,
			...PUBLIC_OVERRIDES[slug],
		},
	};
}

function searchRow(slug, position) {
	return {
		id: FAKE_ID,
		objectID: FAKE_ID,
		legacy_id: 4242,
		userId: `user-${FAKE_ID}`,
		queryID: "q-123",
		indexUsed: "mentors_prod",
		position,
		name: NAMES[slug],
		slug,
		title: ROW_TITLE_OVERRIDES[slug] ?? titleOf(slug),
		employer: ROW_EMPLOYER[slug] ?? (slug.endsWith("google") ? "Google" : "Acme Labs"),
		expertise: expertiseOf(slug),
		disciplines: disciplinesOf(slug),
		languages: ["English"],
		country: { iso: "SG", name: "Singapore" },
		average_rating: 4.9123,
		total_reviews: 31,
		total_sessions: 120,
		sessions_count: 120,
		next_7_day_slots_count: 4,
		available_asap: true,
		average_attendance: 0.97,
		slots: [{ start: "2026-10-15T00:00:00Z" }],
		on_break: false,
		gender: "male",
		timezone: "Asia/Singapore",
		verified: true,
		profile: { image: `https://${FAKE_HOST}/photo.jpg` },
		bio: `Internal note ${FAKE_TOKEN}`,
		...ROW_OVERRIDES[slug],
	};
}

const DEFAULT_SEARCH = {
	"mobile app design": ["alice-visible", "bob-visible"],
	Google: ["gina-google", "gary-google", "alice-visible"],
	"mentors at Google": ["bob-visible"],
	"Alice Visible": ["alice-visible"],
	"Jane Hidden": ["jane-hidden"],
	"mixed visibility": [
		"inactive-mentor",
		"status-inactive",
		"not-a-mentor",
		"suspended-mentor",
		"onbreak-mentor",
		"optout-mentor",
		"denied-mentor",
		"profile-500",
		"alice-visible",
	],
	"everyone hidden": [
		"inactive-mentor",
		"suspended-mentor",
		"onbreak-mentor",
		"optout-mentor",
		"denied-mentor",
		"profile-500",
		"profile-throws",
		"profile-malformed",
		"profile-noshape",
	],
};

function fakeUpstream({ search = DEFAULT_SEARCH, searchFails = false, profileFails = false, calls = [] } = {}) {
	return async (input, init = {}) => {
		const url = new URL(String(input));
		calls.push({ url, init });
		if (url.hostname === "api2.amplitude.com") return new Response("{}", { status: 200 });
		if (url.pathname === "/search") {
			if (searchFails === "throw") {
				throw new Error(`connect ECONNREFUSED ${FAKE_HOST} token=${FAKE_TOKEN} id=${FAKE_ID}`);
			}
			if (searchFails) {
				return new Response(`{"message":"boom at https://${FAKE_HOST}/x ${FAKE_TOKEN} ${FAKE_ID}"}`, {
					status: 502,
				});
			}
			const slugs = search[url.searchParams.get("q")] ?? [];
			// The search service applies the country filter, like the live one.
			const countries = url.searchParams.get("countries");
			return Response.json({
				results: slugs
					.map((slug, index) => searchRow(slug, index + 1))
					.filter((row) => !countries || row.country.iso === countries),
				queryID: "q-123",
				indexUsed: "mentors_prod",
			});
		}
		if (url.pathname === "/users/statistics") {
			return Response.json({
				data: { reviews: { reviewsCount: 31, averageRating: 4.876 }, userId: FAKE_ID, sessions: { total: 5 } },
			});
		}
		// Visibility reads both: the keyed internal route (flags only) and the
		// anonymous public route (display fields only).
		const profileMatch = url.pathname.match(/^\/(internal\/)?users\/profile\/mentor\/(.+)$/);
		if (profileMatch) {
			const internal = Boolean(profileMatch[1]);
			const slug = decodeURIComponent(profileMatch[2]);
			if (profileFails) throw new Error(`fetch failed ${FAKE_HOST} ${FAKE_TOKEN} ${FAKE_ID}`);
			if (slug === "profile-500") {
				return new Response(`Internal error at ${FAKE_HOST}: ${FAKE_TOKEN} ${FAKE_ID}`, { status: 500 });
			}
			if (slug === "profile-throws") throw new Error(`socket hang up ${FAKE_HOST} ${FAKE_TOKEN} ${FAKE_ID}`);
			if (slug === "profile-malformed") return new Response("<html>not json", { status: 200 });
			if (slug === "profile-noshape") return Response.json({ data: { slug, fullName: "Nash Ape" } });
			if (slug === "profile-timeout") {
				return new Promise((_, reject) => {
					init.signal?.addEventListener("abort", () => reject(new Error(`timeout ${FAKE_HOST}`)));
				});
			}
			if (!NAMES[slug]) return Response.json({ message: `not found ${FAKE_ID}` }, { status: 404 });
			return Response.json(internal ? internalRecord(slug) : identityRecord(slug));
		}
		return new Response("unexpected", { status: 418 });
	};
}

function makeEnv(overrides = {}) {
	const keys = [];
	return {
		AUTH_SERVICE_URL: "https://auth.test",
		SEARCH_SERVICE_URL: "https://search.test",
		IDENTITY_INTERNAL_API_KEY: "test-internal-key",
		PUBLIC_OPT_OUT_SLUGS: " Denied-Mentor , other-slug",
		PUBLIC_RATE_LIMITER: {
			keys,
			async limit({ key }) {
				keys.push(key);
				return { success: true };
			},
		},
		PUBLIC_RATE_LIMIT_DO: fakeRateLimitNamespace(),
		...overrides,
	};
}

// Stands in for the PublicRateLimiter namespace: one Map-backed store per
// idFromName, running the same window logic the Durable Object runs.
function fakeRateLimitNamespace({ now = () => Date.now(), take } = {}) {
	const stores = new Map();
	const names = [];
	return {
		names,
		idFromName(name) {
			names.push(name);
			return { name };
		},
		get(id) {
			return {
				async take() {
					if (take) return take();
					if (!stores.has(id.name)) stores.set(id.name, new Map());
					const store = stores.get(id.name);
					return takeRateSlot({ get: (key) => store.get(key), set: (key, value) => store.set(key, value) }, now());
				},
			};
		},
	};
}

async function withFetch(fetchImpl, run) {
	const original = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	try {
		return await run();
	} finally {
		globalThis.fetch = original;
	}
}

let nextId = 1;
async function rpc(method, params, { path = "/public/mcp", env = makeEnv(), headers = {}, ctx } = {}) {
	const request = new Request(`https://mcp.adplist.org${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"CF-Connecting-IP": "203.0.113.7",
			...headers,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
	});
	const response = await handlePublicRequest(request, env, ctx ?? { waitUntil() {} });
	const text = await response.text();
	return { response, text, body: text ? JSON.parse(text) : null };
}

async function callTool(name, args, options = {}) {
	return rpc("tools/call", { name, arguments: args }, options);
}

// ---------------------------------------------------------------------------
// Leak assertions
// ---------------------------------------------------------------------------

const ENVELOPE_KEYS = new Set([
	"jsonrpc",
	"id",
	"result",
	"error",
	"code",
	"message",
	"content",
	"type",
	"text",
	"structuredContent",
	"isError",
	"mentors",
]);
const ALLOWED_KEYS = new Set([...ENVELOPE_KEYS, ...PUBLIC_MENTOR_KEYS]);
const MENTOR_KEYS = new Set(PUBLIC_MENTOR_KEYS);

function assertOnlyAllowlistedKeys(value, path = "$") {
	if (Array.isArray(value)) {
		value.forEach((item, index) => assertOnlyAllowlistedKeys(item, `${path}[${index}]`));
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		assert.ok(ALLOWED_KEYS.has(key), `non-allowlisted key "${key}" at ${path}`);
		if (key === "mentors") {
			for (const mentor of child) {
				for (const mentorKey of Object.keys(mentor)) {
					assert.ok(MENTOR_KEYS.has(mentorKey), `non-allowlisted mentor key "${mentorKey}" at ${path}`);
				}
			}
		}
		assertOnlyAllowlistedKeys(child, `${path}.${key}`);
	}
}

function assertPublicOutputClean({ text, body }) {
	assertOnlyAllowlistedKeys(body);
	const result = body.result;
	if (result?.content) {
		assert.deepEqual(
			result.content.map((item) => item.type),
			["text"],
			"public tools return text content only (no widgets/resource links)",
		);
		for (const item of result.content) {
			const parsed = JSON.parse(item.text);
			assertOnlyAllowlistedKeys(parsed);
			assert.deepEqual(parsed, result.structuredContent);
		}
		assert.equal(result._meta, undefined);
	}
	for (const banned of BANNED_SUBSTRINGS) {
		assert.ok(!text.includes(banned), `banned substring "${banned}" in ${text}`);
	}
	for (const secret of SECRETS) {
		assert.ok(!text.includes(secret), `secret "${secret}" leaked in ${text}`);
	}
	for (const banned of ["linkedin", "swag", "/r/", "X-Amz", FAKE_HOST, "Internal note", "CTO"]) {
		assert.ok(!text.includes(banned), `"${banned}" leaked in ${text}`);
	}
}

function mentorsOf(body) {
	return body.result.structuredContent.mentors;
}

function errorCodeOf(body) {
	assert.equal(body.result.isError, true);
	return body.result.structuredContent.error.code;
}

// ---------------------------------------------------------------------------
// Protocol and routing
// ---------------------------------------------------------------------------

test("public route answers initialize and tools/list without any credentials", async () => {
	const init = await rpc("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "test-client", version: "1" },
	});
	assert.equal(init.response.status, 200);
	assert.equal(init.body.result.protocolVersion, "2025-06-18");
	assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });

	const list = await rpc("tools/list", {});
	assert.equal(list.response.status, 200);
	assert.deepEqual(
		list.body.result.tools.map((tool) => tool.name),
		["search_mentors", "get_mentor_profile"],
	);
	for (const tool of list.body.result.tools) {
		assert.equal(tool.annotations.readOnlyHint, true);
		assert.equal(tool.annotations.destructiveHint, false);
		assert.equal(tool._meta, undefined, "no widget/_meta UI on public tools");
	}

	const ping = await rpc("ping", {});
	assert.deepEqual(ping.body.result, {});
});

test("notifications get 202 with no body; unknown methods get a fixed JSON-RPC error", async () => {
	const request = new Request("https://mcp.adplist.org/public/mcp", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
	});
	const response = await handlePublicRequest(request, makeEnv(), { waitUntil() {} });
	assert.equal(response.status, 202);
	assert.equal(await response.text(), "");

	const unknown = await rpc("sampling/createMessage", {});
	assert.deepEqual(unknown.body.error, { code: -32601, message: "Method not found" });

	const badTool = await callTool("book_session", { mentor_slug: "alice-visible" });
	assert.deepEqual(badTool.body.error, { code: -32602, message: "Invalid params" });
});

test("malformed JSON gets a fixed parse error", async () => {
	const request = new Request("https://mcp.adplist.org/public/mcp", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: `{"jsonrpc":"2.0", ${FAKE_TOKEN}`,
	});
	const response = await handlePublicRequest(request, makeEnv(), { waitUntil() {} });
	assert.equal(response.status, 400);
	const text = await response.text();
	assert.deepEqual(JSON.parse(text).error, { code: -32700, message: "Parse error" });
	assert.ok(!text.includes(FAKE_TOKEN));
});

test("public responses carry no-store, noindex, and open CORS headers", async () => {
	const { response } = await rpc("tools/list", {});
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	assert.equal(response.headers.get("X-Robots-Tag"), "noindex");
	assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
	assert.match(response.headers.get("Access-Control-Allow-Methods"), /POST/);
	assert.match(response.headers.get("Access-Control-Allow-Methods"), /GET/);
	assert.match(response.headers.get("Access-Control-Allow-Methods"), /OPTIONS/);

	for (const [method, path, status] of [
		["OPTIONS", "/public/mcp", 204],
		["GET", "/public/mcp", 405],
		["POST", "/public/nope", 404],
		["GET", "/public/claude/extra/mcp", 404],
	]) {
		const res = await handlePublicRequest(
			new Request(`https://mcp.adplist.org${path}`, { method }),
			makeEnv(),
			{ waitUntil() {} },
		);
		assert.equal(res.status, status, `${method} ${path}`);
		assert.equal(res.headers.get("Cache-Control"), "no-store");
		assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
		assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
	}
});

test("non-public paths fall through, so /sse and OAuth stay on the OAuth provider", async () => {
	for (const path of ["/sse", "/sse/message", "/oauth/authorize", "/", "/publicity", "/mcp"]) {
		const res = await handlePublicRequest(new Request(`https://mcp.adplist.org${path}`), makeEnv());
		assert.equal(res, null, path);
	}
	// index.ts routes /public before constructing the OAuth provider.
	const fetchBody = indexSource.slice(indexSource.indexOf("export default"));
	const publicAt = fetchBody.indexOf("handlePublicRequest(request, env, ctx)");
	const oauthAt = fetchBody.indexOf("createOAuthProvider(env).fetch");
	assert.ok(publicAt > 0 && oauthAt > publicAt, "public route must run before OAuthProvider");
	assert.match(indexSource, /apiRoute:\s*"\/sse"/);
});

test("composed like index.ts, /sse still returns 401 without a token while /public/mcp serves", async () => {
	// The OAuth provider imports cloudflare:workers; stub just that module.
	register(
		`data:text/javascript,${encodeURIComponent(
			'export async function resolve(s, c, n) { if (s === "cloudflare:workers") return { url: "data:text/javascript,export class WorkerEntrypoint {}", shortCircuit: true }; return n(s, c); }',
		)}`,
	);
	const { default: OAuthProvider } = await import("@cloudflare/workers-oauth-provider");
	let apiHits = 0;
	const provider = new OAuthProvider({
		apiRoute: "/sse",
		apiHandler: {
			fetch() {
				apiHits += 1;
				return new Response("protected");
			},
		},
		defaultHandler: { fetch: () => new Response("default") },
		authorizeEndpoint: "/oauth/authorize",
		tokenEndpoint: "/oauth/token",
		clientRegistrationEndpoint: "/oauth/register",
	});
	const env = makeEnv();
	const ctx = { waitUntil() {} };
	const worker = async (request) =>
		(await handlePublicRequest(request, env, ctx)) ?? provider.fetch(request, env, ctx);

	const sse = await worker(new Request("https://mcp.adplist.org/sse"));
	assert.equal(sse.status, 401);
	assert.equal(apiHits, 0);

	const publicInit = await worker(
		new Request("https://mcp.adplist.org/public/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		}),
	);
	assert.equal(publicInit.status, 200);
	assert.equal(apiHits, 0);
});

// ---------------------------------------------------------------------------
// Source and links
// ---------------------------------------------------------------------------

test("source is validated against the enum and never echoed raw", () => {
	assert.equal(normalizeSource("Claude"), "claude");
	assert.equal(normalizeSource("chatgpt"), "chatgpt");
	assert.equal(normalizeSource("api"), "api");
	assert.equal(normalizeSource("<script>"), "mcp");
	assert.equal(normalizeSource(undefined), "mcp");
	assert.deepEqual(parsePublicMcpPath("/public/mcp"), { source: null });
	assert.deepEqual(parsePublicMcpPath("/public/chatgpt/mcp"), { source: "chatgpt" });
	assert.deepEqual(parsePublicMcpPath("/public/evil%22/mcp"), { source: "mcp" });
	assert.equal(parsePublicMcpPath("/public/a/b/mcp"), null);
	assert.equal(sourceFromClientName("claude-ai"), "claude");
	assert.equal(sourceFromClientName("Claude Code"), "claude");
	assert.equal(sourceFromClientName("openai-mcp"), "chatgpt");
	assert.equal(sourceFromClientName("ChatGPT"), "chatgpt");
	assert.equal(sourceFromClientName("cursor"), "mcp");
});

test("profile_url carries the UTM set and ref for the source", () => {
	const url = new URL(publicProfileUrl("felix lee", "claude"));
	assert.equal(url.origin + url.pathname, "https://adplist.org/mentors/felix%20lee");
	assert.equal(url.searchParams.get("utm_source"), "claude");
	assert.equal(url.searchParams.get("utm_medium"), "ai_assistant");
	assert.equal(url.searchParams.get("utm_campaign"), "mentor_search");
	assert.equal(url.searchParams.get("ref"), "ai_claude");
});

test("path source flows into links; unknown path segments become mcp", async () => {
	await withFetch(fakeUpstream(), async () => {
		const claude = await callTool("get_mentor_profile", { mentor_slug: "alice-visible" }, { path: "/public/claude/mcp" });
		assert.match(claude.body.result.structuredContent.profile_url, /utm_source=claude&.*ref=ai_claude$/);

		const evil = await callTool(
			"get_mentor_profile",
			{ mentor_slug: "alice-visible" },
			{ path: "/public/%3Cscript%3Eevil/mcp" },
		);
		assert.match(evil.body.result.structuredContent.profile_url, /utm_source=mcp&.*ref=ai_mcp$/);
		assert.ok(!evil.text.includes("evil") && !evil.text.includes("script"));
	});
});

test("initialize clientInfo picks the source when the path has none, carried by Mcp-Session-Id", async () => {
	await withFetch(fakeUpstream(), async () => {
		const init = await rpc("initialize", {
			protocolVersion: "2025-06-18",
			clientInfo: { name: "ChatGPT <img src=x>", version: "1" },
		});
		const sessionId = init.response.headers.get("Mcp-Session-Id");
		assert.match(sessionId, /^adplist-public-chatgpt-[0-9a-f-]{36}$/);
		assert.ok(!init.text.includes("img"));

		const call = await callTool(
			"get_mentor_profile",
			{ mentor_slug: "alice-visible" },
			{ headers: { "Mcp-Session-Id": sessionId } },
		);
		assert.match(call.body.result.structuredContent.profile_url, /utm_source=chatgpt/);

		// The path wins over the session, and forged session ids fall back to mcp.
		const pathWins = await callTool(
			"get_mentor_profile",
			{ mentor_slug: "alice-visible" },
			{ path: "/public/api/mcp", headers: { "Mcp-Session-Id": sessionId } },
		);
		assert.match(pathWins.body.result.structuredContent.profile_url, /utm_source=api/);
		const forged = await callTool(
			"get_mentor_profile",
			{ mentor_slug: "alice-visible" },
			{ headers: { "Mcp-Session-Id": "adplist-public-evil-123" } },
		);
		assert.match(forged.body.result.structuredContent.profile_url, /utm_source=mcp/);
	});
});

// ---------------------------------------------------------------------------
// Allowlist / deep-key / banned substrings
// ---------------------------------------------------------------------------

test("search (intent path) returns only allowlisted fields, built from scratch", async () => {
	const calls = [];
	await withFetch(fakeUpstream({ calls }), async () => {
		const result = await callTool("search_mentors", { query: "mobile app design" });
		assertPublicOutputClean(result);
		const mentors = mentorsOf(result.body);
		assert.deepEqual(
			mentors.map((mentor) => mentor.slug),
			["alice-visible", "bob-visible"],
		);
		const [alice] = mentors;
		assert.equal(alice.name, "Alice Visible");
		assert.equal(alice.title, "Senior Product Designer");
		assert.equal(alice.company, "Acme Labs");
		assert.equal(alice.country, "Singapore");
		assert.deepEqual(alice.expertise, ["Product Strategy", "Mobile Apps"]);
		assert.deepEqual(alice.disciplines, ["Product Design"]);
		assert.deepEqual(alice.languages, ["English"]);
		assert.equal(alice.average_rating, 4.9, "one decimal, as the public page shows it");
		assert.equal(alice.total_reviews, 31);
		assert.equal(alice.total_sessions, undefined, "session totals are not on the public page");
		assert.equal(alice.sessions_count, undefined);
		assert.equal(alice.bio, undefined, "bio is profile-only");
		assert.equal(alice.photo_url, "https://adplist-bucket.s3.amazonaws.com/media/alice-visible.jpg");
		assert.match(alice.why_match, /Mobile Apps|Product Design/);
		assert.doesNotMatch(alice.why_match, /availab|session|rank/i);
	});
	// Anonymous upstream: no Authorization header on any call.
	for (const { init } of calls) {
		const headers = new Headers(init.headers);
		assert.equal(headers.get("Authorization"), null);
	}
	const searchCall = calls.find(({ url }) => url.pathname === "/search");
	assert.equal(searchCall.url.searchParams.get("provider"), "explore");
});

test("search (company path) returns only current employees and stays clean", async () => {
	await withFetch(fakeUpstream(), async () => {
		const result = await callTool("search_mentors", { query: "mentors at Google", limit: 9 });
		assertPublicOutputClean(result);
		const mentors = mentorsOf(result.body);
		assert.deepEqual(
			mentors.map((mentor) => mentor.slug),
			["gina-google", "gary-google"],
		);
		assert.equal(mentors[0].why_match, "Works at Google.");

		const explicit = await callTool("search_mentors", { query: "design leadership", company: "Google" });
		assertPublicOutputClean(explicit);
		assert.deepEqual(
			mentorsOf(explicit.body).map((mentor) => mentor.slug),
			["gina-google", "gary-google"],
		);
	});
});

test("an explicit company filter drops intent results and identity records at other employers", async () => {
	const search = {
		...DEFAULT_SEARCH,
		Google: ["gina-google", "left-google", "gary-google"],
		design: ["alice-visible", "gary-google", "bob-visible", "left-google"],
	};
	await withFetch(fakeUpstream({ search }), async () => {
		const result = await callTool("search_mentors", { query: "design", company: "Google", limit: 9 });
		assertPublicOutputClean(result);
		const mentors = mentorsOf(result.body);
		assert.deepEqual(
			mentors.map((mentor) => mentor.slug),
			["gina-google", "gary-google"],
		);
		for (const mentor of mentors) assert.equal(mentor.company, "Google");

		// A company the employer search cannot match still filters the intent rows.
		const none = await callTool("search_mentors", { query: "design", company: "Initech" });
		assert.deepEqual(mentorsOf(none.body), []);

		// A well-known company read from the query filters the same way.
		const implied = await callTool("search_mentors", { query: "mentors at Google", limit: 9 });
		assert.deepEqual(
			mentorsOf(implied.body).map((mentor) => mentor.slug),
			["gina-google", "gary-google"],
		);

		// An unconfirmed "mentors at X" phrase (no mentor works at X) only orders.
		const place = await callTool("search_mentors", { query: "mentors from Canada", limit: 9 });
		assert.equal(place.body.result.isError, undefined);
	});
});

test("company is parsed out of free-text queries; role words alone are not a company", () => {
	for (const [query, company] of [
		["product manager Google", "Google"],
		["PM at Meta", "Meta"],
		["designer from Airbnb", "Airbnb"],
		["google pm", "Google"],
		["Senior UX designer @ Stripe", "Stripe"],
		["mentors who work at Google", "Google"],
	]) {
		assert.equal(knownCompanyIn(query), company, query);
	}
	for (const query of ["product manager", "senior product designer", "mentors from Canada", "Alice Visible", "pm"]) {
		assert.equal(knownCompanyIn(query), "", query);
	}
	assert.deepEqual(companyCandidates("product manager"), []);
	assert.ok(companyCandidates("ux designer Initech").includes("Initech"));
	assert.ok(!companyCandidates("ux designer Initech").some((candidate) => /designer|ux/i.test(candidate)));
});

test("tools, skills and the requester's own employer are not a mentor-employer filter", () => {
	// A product or skill named without at/from is something to learn.
	for (const query of [
		"help with Figma",
		"Figma designer",
		"designer Figma",
		"learn Notion",
		"Jira",
		"product manager Excel",
		"python engineer",
		"SQL analyst",
		"Webflow designer",
		"Framer developer",
		"Sketch designer",
		// Tools that are also companies (Codex repro: "Canva designer").
		"Canva designer",
		"designer Canva",
		"Salesforce admin",
		"HubSpot marketer",
		"Tableau analyst",
		"Miro facilitator",
		"Airtable consultant",
	]) {
		assert.equal(knownCompanyIn(query), "", query);
		assert.deepEqual(companyCandidates(query), [], query);
	}
	// The requester's employer is who is asking, not who they want.
	for (const query of [
		"I work at Google and need a design mentor",
		"I'm at Google, looking for a design mentor",
		"I'm a PM at Meta and want design mentorship",
		"I've been working at Stripe and need career advice",
		"my company Google wants me to learn design",
		"my company is Airbnb, need a mentor",
		// Any first-person clause, with or without an article (Codex repro).
		"I'm PM at Google and need a design mentor",
		"I’m PM at Google and need a design mentor",
		"Im PM at Google, need a design mentor",
		"I am senior designer at Meta but want PM mentorship",
		"I'm currently a designer for Stripe and looking for a mentor",
		"we are at Airbnb and need a mentor",
		"my team is with Google. Need a design mentor",
		"I work for Google and need a design mentor",
	]) {
		assert.equal(knownCompanyIn(query), "", query);
	}
	// Explicit employer intent wins over a tool and over the requester.
	assert.equal(knownCompanyIn("mentors at Acme using Figma"), "");
	assert.equal(companyCandidates("mentors at Acme using Figma")[0], "Acme");
	assert.ok(!companyCandidates("mentors at Acme using Figma").includes("Figma"));
	assert.equal(knownCompanyIn("mentors at Google using Figma"), "Google");
	assert.equal(knownCompanyIn("I work at Google and want mentors from Meta"), "Meta");
	assert.equal(knownCompanyIn("I'm at Stripe, looking for a PM at Google"), "Google");
	// at/from still makes a tool-named company an employer.
	assert.equal(knownCompanyIn("designers at Figma"), "Figma");
	assert.equal(knownCompanyIn("PM from Notion"), "Notion");
	assert.equal(knownCompanyIn("people at Figma"), "Figma");
	assert.equal(knownCompanyIn("designer at Canva"), "Canva");
	assert.equal(knownCompanyIn("mentors from Canva"), "Canva");
	assert.equal(knownCompanyIn("designer @Canva"), "Canva");
	assert.equal(knownCompanyIn("I'm PM at Stripe and need a designer at Google"), "Google");
	// Skill phrasing is never an employer, and a tool after a bare at is not one.
	for (const query of [
		"I want to get better at Figma",
		"good at Figma",
		"someone good at Figma",
		"skilled at Google Ads",
		"experience at Stripe",
		"mentor with experience with Notion",
		"help at Figma",
	]) {
		assert.equal(knownCompanyIn(query), "", query);
		assert.deepEqual(companyCandidates(query), [], query);
	}
	// Typographic apostrophes still mark the requester's own employer.
	for (const query of [
		"I’m a PM at Google and need a design mentor",
		"I‘m at Google, looking for a design mentor",
		"Iʼve been working at Stripe and need career advice",
	]) {
		assert.equal(knownCompanyIn(query), "", query);
	}
});

test("tool and requester mentions do not filter search results; an explicit company wins", async () => {
	const search = {
		...COMPANY_SEARCH,
		"help with Figma": ["alice-visible", "gina-google", "bob-visible"],
		"I work at Google and need a design mentor": ["alice-visible", "gina-google", "bob-visible"],
		"I want to get better at Figma": ["alice-visible", "gina-google", "fay-figma"],
		"I'm a PM at Google and need a design mentor": ["alice-visible", "gina-google", "fay-figma"],
		"I’m a PM at Google and need a design mentor": ["alice-visible", "gina-google", "fay-figma"],
		"I’m PM at Google and need a design mentor": ["alice-visible", "gina-google", "fay-figma"],
		"Canva designer": ["alice-visible", "cara-canva", "bob-visible"],
	};
	await withFetch(fakeUpstream({ search }), async () => {
		for (const query of ["help with Figma", "I work at Google and need a design mentor"]) {
			const result = await callTool("search_mentors", { query, limit: 9 });
			assertPublicOutputClean(result);
			assert.deepEqual(
				mentorsOf(result.body).map((mentor) => mentor.slug),
				["alice-visible", "gina-google", "bob-visible"],
				query,
			);
		}
		// Skill phrasing and a typographic apostrophe in the requester's own
		// employment keep mentors at Acme, Google and Figma alike.
		for (const query of [
			"I want to get better at Figma",
			"I'm a PM at Google and need a design mentor",
			"I’m a PM at Google and need a design mentor",
			// Requester phrasing without an article (Codex repro).
			"I’m PM at Google and need a design mentor",
		]) {
			const result = await callTool("search_mentors", { query, limit: 9 });
			assertPublicOutputClean(result);
			assert.deepEqual(
				mentorsOf(result.body).map((mentor) => mentor.slug),
				["alice-visible", "gina-google", "fay-figma"],
				query,
			);
		}

		// A tool that is also a company is a skill without at/from (Codex repro):
		// "Canva designer" keeps the Acme designers alongside the Canva one.
		const canva = await callTool("search_mentors", { query: "Canva designer", limit: 9 });
		assertPublicOutputClean(canva);
		assert.deepEqual(
			mentorsOf(canva.body).map((mentor) => mentor.slug),
			["alice-visible", "cara-canva", "bob-visible"],
		);

		// The explicit company argument overrides whatever the text implies.
		const explicit = await callTool("search_mentors", { query: "help with Figma", company: "Google", limit: 9 });
		const mentors = mentorsOf(explicit.body);
		assert.ok(mentors.length > 0);
		for (const mentor of mentors) assert.equal(mentor.company, "Google");
		const overridden = await callTool("search_mentors", { query: "PM at Meta", company: "Google", limit: 9 });
		assert.ok(mentorsOf(overridden.body).length > 0);
		for (const mentor of mentorsOf(overridden.body)) assert.equal(mentor.company, "Google");
	});
});

test("company matching uses the current employer only, never a previous one", () => {
	assert.equal(currentEmployer("Google | previously at Meta"), "Google");
	assert.equal(currentEmployer("Stripe | previously at Google"), "Stripe");
	assert.equal(currentEmployer("Spotify (ex-Google)"), "Spotify");
	assert.equal(currentEmployer("Meta, formerly Facebook"), "Meta");
	assert.equal(currentEmployer("Canva · Prev. Atlassian"), "Canva");
	assert.equal(currentEmployer("ex-Google"), "");
	assert.equal(currentEmployer("Coca-Cola"), "Coca-Cola");
	assert.equal(currentEmployer("Acme Labs"), "Acme Labs");
	assert.ok(isCurrentEmployer("Google | previously at Meta", "Google"));
	assert.ok(!isCurrentEmployer("Google | previously at Meta", "Meta"));
	assert.ok(!isCurrentEmployer("Stripe | previously at Google", "Google"));
	assert.ok(!isCurrentEmployer("Spotify (ex-Google)", "Google"));
	assert.ok(isCurrentEmployer("Google LLC", "google"));
});

test("multiword employers sharing a well-known prefix are kept whole and matched by token prefix", () => {
	// The full employer phrase survives parsing; it is never cut to the known prefix.
	assert.equal(knownCompanyIn("mentors at Google DeepMind"), "Google DeepMind");
	assert.equal(knownCompanyIn("PM at Meta Reality Labs"), "Meta Reality Labs");
	assert.equal(knownCompanyIn("designer from Google DeepMind"), "Google DeepMind");
	assert.equal(knownCompanyIn("google deepmind pm"), "google deepmind");
	for (const query of ["mentors at Google DeepMind", "PM at Meta Reality Labs", "google deepmind pm"]) {
		const candidates = companyCandidates(query);
		assert.ok(!candidates.some((c) => /^(google|meta)$/i.test(c)), `${query}: ${candidates.join()}`);
	}
	// Clause words still end the phrase.
	assert.equal(knownCompanyIn("mentors at Google in London"), "Google");
	assert.equal(knownCompanyIn("mentors at Google based in London"), "Google");
	assert.equal(knownCompanyIn("PM at Meta who mentors"), "Meta");

	// Token prefix: a company matches employers that start with all its tokens.
	assert.ok(isCurrentEmployer("Google DeepMind", "Google"));
	assert.ok(isCurrentEmployer("Google DeepMind", "Google DeepMind"));
	assert.ok(isCurrentEmployer("Google DeepMind Ltd", "google deepmind"));
	assert.ok(!isCurrentEmployer("Google", "Google DeepMind"));
	assert.ok(!isCurrentEmployer("Google Cloud", "Google DeepMind"));
	assert.ok(!isCurrentEmployer("DeepMind", "Google DeepMind"));
	assert.ok(!isCurrentEmployer("Snapchat", "Snap"));
	assert.ok(isCurrentEmployer("Meta Reality Labs | previously at Google", "Meta"));
	// Still current employer only.
	assert.ok(!isCurrentEmployer("Meta Reality Labs | previously at Google", "Google"));
	assert.ok(!isCurrentEmployer("Stripe (ex-Google DeepMind)", "Google"));

	// A prefix-confirmed company keeps the query's phrase, not the longer employer.
	assert.equal(companyConfirmedByEmployers("ux designer Initech", ["Initech Labs"]), "Initech");
	assert.equal(companyConfirmedByEmployers("ux designer Initech", ["INITECH"]), "INITECH");
	assert.equal(companyConfirmedByEmployers("mentors at Initech Labs", ["Initech"]), "");
});

test("a multiword employer filters to that employer; its known prefix still covers it", async () => {
	const search = {
		...DEFAULT_SEARCH,
		Google: ["gina-google", "dee-deepmind"],
		"Google DeepMind": ["dee-deepmind", "gina-google"],
		"mentors at Google DeepMind": ["gina-google", "dee-deepmind", "alice-visible"],
		"mentors at Google": ["alice-visible", "dee-deepmind"],
		Meta: ["mia-meta", "rita-reality"],
		"Meta Reality Labs": ["rita-reality", "mia-meta"],
		"PM at Meta Reality Labs": ["mia-meta", "rita-reality"],
		"PM at Meta": ["rita-reality"],
	};
	const slugsFor = async (query) => {
		const result = await callTool("search_mentors", { query, limit: 9 });
		assertPublicOutputClean(result);
		return mentorsOf(result.body).map((mentor) => mentor.slug);
	};
	await withFetch(fakeUpstream({ search }), async () => {
		assert.deepEqual(await slugsFor("mentors at Google DeepMind"), ["dee-deepmind"]);
		assert.deepEqual((await slugsFor("mentors at Google")).sort(), ["dee-deepmind", "gina-google"]);
		assert.deepEqual(await slugsFor("PM at Meta Reality Labs"), ["rita-reality"]);
		assert.deepEqual((await slugsFor("PM at Meta")).sort(), ["mia-meta", "rita-reality"]);

		// The explicit argument follows the same rule.
		const explicit = await callTool("search_mentors", { query: "design", company: "Google DeepMind", limit: 9 });
		assert.deepEqual(
			mentorsOf(explicit.body).map((mentor) => mentor.slug),
			["dee-deepmind"],
		);
		for (const mentor of mentorsOf(explicit.body)) assert.equal(mentor.company, "Google DeepMind");
	});
});

test("a bare well-known company query is an employer filter; a bare tool is not (Codex repro)", async () => {
	for (const [query, company] of [
		["Google", "Google"],
		["google", "Google"],
		["  Google  ", "Google"],
		["Google DeepMind", "Google DeepMind"],
		["mentors Google", "Google"],
		["Google mentors", "Google"],
		["mentor at Google DeepMind", "Google DeepMind"],
		["people at Meta", "Meta"],
		["Goldman Sachs", "Goldman Sachs"],
	]) {
		assert.equal(knownCompanyIn(query), company, query);
	}
	for (const query of ["Canva", "Figma", "Notion", "Salesforce", "mentors Figma", "Initech", "mentors"]) {
		assert.equal(knownCompanyIn(query), "", query);
	}

	const search = {
		...DEFAULT_SEARCH,
		Google: ["gina-google", "mia-meta", "dee-deepmind"],
		"Google DeepMind": ["gina-google", "mia-meta", "dee-deepmind"],
		Canva: ["alice-visible", "cara-canva", "bob-visible"],
	};
	const callSearch = async (query) => {
		const result = await callTool("search_mentors", { query, limit: 9 });
		assertPublicOutputClean(result);
		return result;
	};
	await withFetch(fakeUpstream({ search }), async () => {
		const google = await callSearch("Google");
		assert.deepEqual(mentorsOf(google.body).map((mentor) => mentor.slug).sort(), ["dee-deepmind", "gina-google"]);
		const deepmind = await callSearch("Google DeepMind");
		assert.deepEqual(mentorsOf(deepmind.body).map((mentor) => mentor.slug), ["dee-deepmind"]);
		const canva = await callSearch("Canva");
		assert.deepEqual(
			mentorsOf(canva.body).map((mentor) => mentor.slug),
			["alice-visible", "cara-canva", "bob-visible"],
		);
	});
});

const COMPANY_SEARCH = {
	...DEFAULT_SEARCH,
	Google: ["gina-google", "past-google", "now-google", "left-google", "gary-google"],
	"product manager Google": ["mia-meta", "paul-google", "pia-google", "nico-google"],
	"google pm": ["paul-google", "mia-meta"],
	"PM at Meta": ["nico-google", "paul-google"],
	"designer from Airbnb": ["alice-visible", "bob-visible"],
	"ux designer Initech": ["alice-visible", "ina-initech", "bob-visible"],
	"product manager": ["mia-meta", "paul-google", "pia-google"],
};
// Employer searches for the PM test: Google returns a past employee and a
// mentor whose company text mentions Meta only as a previous employer.
const PM_COMPANY_SEARCH = {
	...COMPANY_SEARCH,
	Google: ["pia-google", "paul-google", "nico-google"],
	Meta: ["nico-google", "mia-meta"],
};

test("a company named in free text runs the company path and filters on current employer", async () => {
	const calls = [];
	await withFetch(fakeUpstream({ search: PM_COMPANY_SEARCH, calls }), async () => {
		for (const query of ["product manager Google", "google pm"]) {
			const result = await callTool("search_mentors", { query, limit: 9 });
			assertPublicOutputClean(result);
			const mentors = mentorsOf(result.body);
			assert.deepEqual(
				mentors.map((mentor) => mentor.slug).sort(),
				["nico-google", "pia-google"],
				query,
			);
			for (const mentor of mentors) assert.equal(mentor.company, "Google", query);
			assert.ok(mentors.every((mentor) => mentor.why_match.startsWith("Works at Google")), query);
		}
		// The employer search used the canonical company, not the query's casing.
		assert.ok(calls.some(({ url }) => url.pathname === "/search" && url.searchParams.get("q") === "Google"));

		// "Google | previously at Meta" is a Google employee, not a Meta one.
		const meta = await callTool("search_mentors", { query: "PM at Meta", limit: 9 });
		assert.deepEqual(
			mentorsOf(meta.body).map((mentor) => mentor.slug),
			["mia-meta"],
		);

		// "from Airbnb" runs the company path; nobody works there, so nobody else
		// is passed off as an Airbnb mentor.
		const airbnb = await callTool("search_mentors", { query: "designer from Airbnb", limit: 9 });
		assert.deepEqual(mentorsOf(airbnb.body), []);
		assert.ok(calls.some(({ url }) => url.searchParams.get("q") === "Airbnb"));

		// Not a well-known company, but a returned mentor currently works there.
		const initech = await callTool("search_mentors", { query: "ux designer Initech", limit: 9 });
		assert.deepEqual(
			mentorsOf(initech.body).map((mentor) => mentor.slug),
			["ina-initech"],
		);

		// Role words alone: no company filter, mentors at any employer.
		const role = await callTool("search_mentors", { query: "product manager", limit: 9 });
		const companies = new Set(mentorsOf(role.body).map((mentor) => mentor.company));
		assert.ok(companies.has("Meta") && companies.has("Google") && companies.has("Stripe"), [...companies].join());
	});
});

test("an explicit company filter matches the current employer only", async () => {
	await withFetch(fakeUpstream({ search: COMPANY_SEARCH }), async () => {
		const google = await callTool("search_mentors", { query: "design", company: "Google", limit: 9 });
		assertPublicOutputClean(google);
		const slugs = mentorsOf(google.body).map((mentor) => mentor.slug);
		assert.deepEqual(slugs, ["gina-google", "now-google", "gary-google"]);
		assert.ok(!slugs.includes("past-google"), "previously at Google is not at Google");
		assert.equal(mentorsOf(google.body)[1].company, "Google", "past employers are cut from company");

		const meta = await callTool("search_mentors", { query: "design", company: "Meta", limit: 9 });
		assert.deepEqual(mentorsOf(meta.body), []);
	});
});

test("a title starting Former/Ex-/Previously marks the company field as past", () => {
	for (const title of [
		"Former Director of UX",
		"former director of ux",
		"  - Former Director of UX",
		"Ex-Google PM",
		"Ex Google PM",
		"ex–Google PM",
		"Previously Head of Design",
		"Formerly Staff Designer",
		"Past President",
		"Retired VP of Product",
		"(Former) Design Lead",
		"Advisor | Former Director at Google",
		"Advisor, ex-Google",
		"Coach (Ex-Google)",
	]) {
		assert.ok(titleMarksEmployerPast(title, "Google"), title);
		assert.ok(!isCurrentEmployer("Google", "Google", title), title);
	}
	for (const title of [
		"Director of UX",
		"Executive Director",
		"Pastry Chef",
		"Expert Product Designer",
		"Design Lead | Ex-Meta",
		"Product Designer (ex-Spotify)",
		"",
	]) {
		assert.ok(!titleMarksEmployerPast(title, "Google"), title);
		assert.ok(isCurrentEmployer("Google", "Google", title), title);
	}
	// Company text that itself opens as past.
	for (const company of [
		"Former Google",
		"Ex-Google",
		"Ex Google",
		"Previously Google",
		"- formerly Google",
		"Past Google",
		"Retired Google",
		"Retired, Google",
		"Retired from Google",
		"Formerly at Google",
		"Ex @ Google",
	]) {
		assert.equal(currentEmployer(company), "", company);
		assert.ok(!isCurrentEmployer(company, "Google"), company);
	}
	// A past tail, including a punctuated bare "Ex ".
	for (const company of ["Stripe | Past Google", "Stripe, retired from Google", "Stripe | Ex Google", "Stripe (Ex Google)"]) {
		assert.equal(currentEmployer(company), "Stripe", company);
	}
	assert.equal(currentEmployer("Pastel Labs"), "Pastel Labs");
	assert.equal(currentEmployer("Exness"), "Exness");
	assert.equal(currentEmployer("Design Ex Machina"), "Design Ex Machina");
});

const PAST_TITLE_SEARCH = {
	...DEFAULT_SEARCH,
	Google: ["chris-google", "dora-google", "ezra-google", "ada-google"],
	"UX at Google": ["chris-google", "dora-google", "ezra-google"],
	"director of ux": ["chris-google", "dora-google"],
};

test("a Former/Ex- title at the company is excluded from company searches, kept elsewhere", async () => {
	await withFetch(fakeUpstream({ search: PAST_TITLE_SEARCH }), async () => {
		const explicit = await callTool("search_mentors", { query: "design", company: "Google", limit: 9 });
		assertPublicOutputClean(explicit);
		assert.deepEqual(
			mentorsOf(explicit.body).map((mentor) => mentor.slug),
			["dora-google"],
		);

		const phrased = await callTool("search_mentors", { query: "UX at Google", limit: 9 });
		assertPublicOutputClean(phrased);
		assert.deepEqual(
			mentorsOf(phrased.body).map((mentor) => mentor.slug),
			["dora-google"],
		);

		// No company in the query: the former director still shows up.
		const open = await callTool("search_mentors", { query: "director of ux", limit: 9 });
		assert.deepEqual(
			mentorsOf(open.body).map((mentor) => mentor.slug).sort(),
			["chris-google", "dora-google"],
		);
	});
});

test("a parsed company outside the known list stays a filter when every match is past (Initech)", async () => {
	ROW_EMPLOYER["fred-initech"] = "Initech";
	RECORD_COMPANY["fred-initech"] = "Initech";
	TITLE_OVERRIDES["fred-initech"] = "Former Director of UX";
	NAMES["fred-initech"] = "Fred Former";
	const search = {
		...DEFAULT_SEARCH,
		Initech: ["fred-initech"],
		"mentors at Initech": ["fred-initech", "alice-visible", "bob-visible"],
	};
	try {
		await withFetch(fakeUpstream({ search }), async () => {
			assert.equal(knownCompanyIn("mentors at Initech"), "");
			const phrased = await callTool("search_mentors", { query: "mentors at Initech", limit: 9 });
			assertPublicOutputClean(phrased);
			assert.deepEqual(mentorsOf(phrased.body), [], "no former employee, and no unfiltered fallback");

			const explicit = await callTool("search_mentors", { query: "mentors", company: "Initech", limit: 9 });
			assert.deepEqual(mentorsOf(explicit.body), []);
		});
	} finally {
		for (const table of [ROW_EMPLOYER, RECORD_COMPANY, TITLE_OVERRIDES, NAMES]) delete table["fred-initech"];
	}
});

// Codex repro: only the employer search sees the former employee; the intent
// search returns unrelated mentors. The past row still confirms Initech.
test("a past employee seen only by the employer search keeps the parsed company strict", async () => {
	const cases = [
		{ company: "Initech", title: "Former Director of UX" },
		{ company: "Retired Initech", title: "Senior Product Designer" },
		{ company: "Past Initech", title: "Senior Product Designer" },
		{ company: "Ex Initech", title: "Senior Product Designer" },
		// Connecting words after the marker (Codex repro: "Retired from").
		{ company: "Retired from Initech", title: "Senior Product Designer" },
		{ company: "Formerly at Initech", title: "Senior Product Designer" },
		{ company: "Ex @ Initech", title: "Senior Product Designer" },
		{ company: "Former: Initech", title: "Senior Product Designer" },
		{ company: "Previously with Initech", title: "Senior Product Designer" },
		{ company: "Past - Initech", title: "Senior Product Designer" },
		{ company: "Stripe | Retired from Initech", title: "Senior Product Designer" },
	];
	NAMES["fred-initech"] = "Fred Former";
	try {
		for (const { company, title } of cases) {
			ROW_EMPLOYER["fred-initech"] = company;
			RECORD_COMPANY["fred-initech"] = company;
			TITLE_OVERRIDES["fred-initech"] = title;
			const search = {
				...DEFAULT_SEARCH,
				Initech: ["fred-initech"],
				"mentors at Initech": ["alice-visible", "bob-visible"],
			};
			await withFetch(fakeUpstream({ search }), async () => {
				const phrased = await callTool("search_mentors", { query: "mentors at Initech", limit: 9 });
				assertPublicOutputClean(phrased);
				assert.deepEqual(mentorsOf(phrased.body), [], `${company} / ${title}`);
			});
		}
	} finally {
		for (const table of [ROW_EMPLOYER, RECORD_COMPANY, TITLE_OVERRIDES, NAMES]) delete table["fred-initech"];
	}
});

// Codex repro: splitting on a bare "at" turned "AT&T" into "&T", so a
// past-only AT&T match no longer kept the filter strict.
test("company names that start with 'at' survive past-marker parsing (AT&T)", async () => {
	assert.equal(companyNamedByEmployers("mentors at AT&T", ["AT&T"]), "AT&T");
	assert.equal(companyNamedByEmployers("mentors at AT&T", ["Former AT&T"]), "AT&T");
	assert.equal(companyNamedByEmployers("mentors at AT&T", ["Stripe | Formerly at AT&T"]), "AT&T");
	assert.equal(companyNamedByEmployers("mentors at Home", ["At Home"]), "", "At Home is not split into Home");
	assert.equal(companyNamedByEmployers("mentors at Atlassian", ["Retired from Atlassian"]), "Atlassian");
	assert.equal(companyNamedByEmployers("mentors at Initech", ["Designer at Initech"]), "Initech");

	ROW_EMPLOYER["fred-att"] = "AT&T";
	RECORD_COMPANY["fred-att"] = "AT&T";
	TITLE_OVERRIDES["fred-att"] = "Former Director of UX";
	NAMES["fred-att"] = "Fred Former";
	const search = {
		...DEFAULT_SEARCH,
		"AT&T": ["fred-att"],
		"mentors at AT&T": ["fred-att", "ina-initech"],
	};
	try {
		await withFetch(fakeUpstream({ search }), async () => {
			const phrased = await callTool("search_mentors", { query: "mentors at AT&T", limit: 9 });
			assertPublicOutputClean(phrased);
			assert.deepEqual(mentorsOf(phrased.body), [], "no former AT&T director, no current Initech employee");
		});
	} finally {
		for (const table of [ROW_EMPLOYER, RECORD_COMPANY, TITLE_OVERRIDES, NAMES]) delete table["fred-att"];
	}
});

// Codex repro: splitting "Acme (Europe)" on its parentheses lost the full
// name, so a past-only match on it fell back to unfiltered intent results.
test("punctuated company names survive past-marker parsing (Acme (Europe))", async () => {
	assert.equal(companyNamedByEmployers("mentors at Acme Europe", ["Acme (Europe)"]), "Acme Europe");
	assert.equal(companyNamedByEmployers("mentors at Acme Europe", ["Former Acme (Europe)"]), "Acme Europe");
	assert.equal(companyNamedByEmployers("mentors at Acme", ["Acme (Europe)"]), "Acme");

	ROW_EMPLOYER["fred-acme"] = "Acme (Europe)";
	RECORD_COMPANY["fred-acme"] = "Acme (Europe)";
	TITLE_OVERRIDES["fred-acme"] = "Former Director of UX";
	NAMES["fred-acme"] = "Fred Former";
	const search = {
		...DEFAULT_SEARCH,
		"Acme Europe": ["fred-acme"],
		"mentors at Acme Europe": ["fred-acme", "ina-initech"],
	};
	try {
		await withFetch(fakeUpstream({ search }), async () => {
			const phrased = await callTool("search_mentors", { query: "mentors at Acme Europe", limit: 9 });
			assertPublicOutputClean(phrased);
			assert.deepEqual(mentorsOf(phrased.body), [], "no former Acme (Europe) director, no current Initech employee");
		});
	} finally {
		for (const table of [ROW_EMPLOYER, RECORD_COMPANY, TITLE_OVERRIDES, NAMES]) delete table["fred-acme"];
	}
});

// Codex repro: in "Stripe | Former Acme (Europe)" the parentheses split Acme
// from Europe and the whole text started with Stripe, so nothing named "Acme
// Europe" and unrelated Acme Labs intent rows came back.
test("punctuated company names survive inside a past-employer segment", async () => {
	assert.equal(companyNamedByEmployers("mentors at Acme Europe", ["Stripe | Former Acme (Europe)"]), "Acme Europe");

	ROW_EMPLOYER["fred-acme"] = "Stripe | Former Acme (Europe)";
	RECORD_COMPANY["fred-acme"] = "Stripe | Former Acme (Europe)";
	NAMES["fred-acme"] = "Fred Former";
	const search = {
		...DEFAULT_SEARCH,
		"Acme Europe": ["fred-acme"],
		"mentors at Acme Europe": ["alice-visible", "bob-visible"],
	};
	try {
		await withFetch(fakeUpstream({ search }), async () => {
			const phrased = await callTool("search_mentors", { query: "mentors at Acme Europe", limit: 9 });
			assertPublicOutputClean(phrased);
			assert.deepEqual(mentorsOf(phrased.body), [], "no former Acme (Europe) employee, no Acme Labs mentors");
		});
	} finally {
		for (const table of [ROW_EMPLOYER, RECORD_COMPANY, NAMES]) delete table["fred-acme"];
	}
});

test("companyNamedByEmployers across mixed employer strings", () => {
	const cases = [
		["mentors at Acme Europe", "Stripe | Former Acme (Europe)", "Acme Europe"],
		["mentors at Acme Europe", "Stripe, previously at Acme (Europe)", "Acme Europe"],
		["mentors at Acme Europe", "Stripe; Ex-Acme [Europe]", "Acme Europe"],
		["mentors at Acme Europe", "Stripe / Retired from Acme (Europe)", "Acme Europe"],
		["mentors at Acme Europe", "Stripe - Formerly at Acme (Europe)", "Acme Europe"],
		["mentors at Acme Europe", "Stripe previously Acme (Europe)", "Acme Europe"],
		["mentors at Google", "Stripe · Past: Google", "Google"],
		["mentors at Google", "Stripe • Ex @ Google", "Google"],
		["mentors at Google", "Designer at Google (Mountain View)", "Google"],
		["mentors at Google DeepMind", "Meta | ex-Google (DeepMind)", "Google DeepMind"],
		["mentors at AT&T", "Stripe | Formerly at AT&T", "AT&T"],
		["mentors at Atlassian", "Retired from Atlassian", "Atlassian"],
		["mentors at Machina", "Design Ex Machina", ""],
		["mentors at Home", "Stripe | At Home", ""],
		["mentors at Acme Europe", "Acme Labs | Europe", ""],
		["mentors at Initech", "Stripe | Former Acme (Europe)", ""],
	];
	for (const [query, employer, expected] of cases) {
		assert.equal(companyNamedByEmployers(query, [employer]), expected, `${query} / ${employer}`);
	}
});

test("Retired/Past/Ex company text is past when intent results include the employee too", async () => {
	NAMES["fred-initech"] = "Fred Former";
	try {
		for (const company of ["Retired Initech", "Past Initech", "Ex Initech", "Retired from Initech", "Formerly at Initech", "Ex @ Initech"]) {
			ROW_EMPLOYER["fred-initech"] = company;
			RECORD_COMPANY["fred-initech"] = company;
			const search = {
				...DEFAULT_SEARCH,
				Initech: ["fred-initech"],
				"mentors at Initech": ["fred-initech", "alice-visible"],
			};
			await withFetch(fakeUpstream({ search }), async () => {
				const phrased = await callTool("search_mentors", { query: "mentors at Initech", limit: 9 });
				assert.deepEqual(mentorsOf(phrased.body), [], company);
			});
		}
	} finally {
		for (const table of [ROW_EMPLOYER, RECORD_COMPANY, NAMES]) delete table["fred-initech"];
	}
});

// ---------------------------------------------------------------------------
// Role relevance (ADPLIST-4479): the right employer, and the right role there
// ---------------------------------------------------------------------------

// slug → [name, title, current company text, disciplines, expertise, hidden?]
const ROLE_MENTORS = {
	"noe-google": ["Noe Network", "Network Operations Engineer", "Google", ["Site Reliability"], ["Networking"]],
	"cal-google": ["Cal Cad", "Hardware CAD Engineer", "Google", ["Hardware Design"], ["CAD"]],
	"cy-google": ["Cy Secure", "Cyber Security Instructor", "Google", ["Security Engineering"], ["Teaching"]],
	"sam-google": ["Sam Swe", "Software Engineer", "Google", ["Back-end"], ["Distributed Systems"]],
	"uma-google": ["Uma Ux", "Senior UX Designer", "Google", ["UX Design"], ["Design Systems"]],
	"fran-google": ["Fran Former", "Former UX Designer", "Google", ["UX Design"], []],
	"pete-google": ["Pete Pd", "Product Designer", "Google", ["Product Design"], ["Prototyping"]],
	"hal-google": ["Hal Hidden", "UX Designer", "Google", ["UX Design"], [], true],
	"rae-google": ["Rae Research", "UX Researcher", "Google", ["UX Research"], ["Usability Testing"]],
	"gus-google": ["Gus Gpm", "Group Product Manager", "Google", ["Generalist Product Management"], ["Roadmapping"]],
	"dot-google": ["Dot Director", "Director", "Google", ["UX Design"], ["Leadership"]],
	"fin-google": ["Fin Founder", "Founder", "Google", ["Back-end"], ["Fundraising"]],
	"flo-google": ["Flo Founder", "Founder", "Google", [], ["Leadership"]],
	"stu-google": ["Stu Stripe", "UX Designer", "Stripe | previously at Google", ["UX Design"], []],
	"ivy-meta": ["Ivy Ios", "iOS Engineer", "Meta", ["iOS Engineering"], []],
	"dan-meta": ["Dan Data", "Data Scientist", "Meta", ["Data Scientist"], []],
	"mo-meta": ["Mo Pm", "Product Manager", "Meta", ["Generalist Product Management"], []],
	"don-meta": ["Don Dev", "Software Engineer", "Meta", ["Front-end"], []],
	"xia-meta": ["Xia Ex", "Ex-Meta Product Manager", "Meta", ["Generalist Product Management"], []],
	"max-meta": ["Max Pm", "Senior PM", "Meta", ["Growth Product Management"], []],
	"ed-meta": ["Ed Em", "Engineering Manager", "Meta", ["Back-end"], []],
	"pam-meta": ["Pam Lead", "Product Lead", "Meta", ["Generalist Product Management"], []],
	"pd-meta": ["Pia Designer", "Product Designer", "Meta", ["Product Design"], []],
	"ari-airbnb": ["Ari Swe", "Software Engineer", "Airbnb", ["Back-end"], []],
	"kay-airbnb": ["Kay Knowledge", "Knowledge Strategist", "Airbnb", ["Content Strategy"], ["Knowledge Management"]],
	"dee-airbnb": ["Dee Design", "Staff Product Designer", "Airbnb", ["Product Design"], []],
	"ben-airbnb": ["Ben Swe", "Senior Software Engineer", "Airbnb", ["Full stack"], []],
	"una-airbnb": ["Una Ux", "UX Designer", "Airbnb", ["UX Design"], []],
};

const ROLE_SEARCH = {
	...DEFAULT_SEARCH,
	Google: [
		"noe-google", "cal-google", "cy-google", "sam-google", "uma-google", "fran-google", "pete-google",
		"hal-google", "rae-google", "gus-google", "dot-google", "fin-google", "flo-google", "stu-google",
	],
	Meta: ["ivy-meta", "dan-meta", "mo-meta", "don-meta", "xia-meta", "max-meta", "ed-meta", "pam-meta", "pd-meta"],
	Airbnb: ["ari-airbnb", "kay-airbnb", "dee-airbnb", "ben-airbnb", "una-airbnb"],
};

async function withRoleMentors(mentors, run) {
	for (const [slug, [name, title, company, disciplines, expertise, hidden]] of Object.entries(mentors)) {
		NAMES[slug] = name;
		TITLE_OVERRIDES[slug] = title;
		ROW_EMPLOYER[slug] = company;
		RECORD_COMPANY[slug] = company;
		LABEL_OVERRIDES[slug] = { disciplines, expertise };
		if (hidden) HIDDEN_OVERRIDES[slug] = { is: { suspended: true } };
	}
	try {
		return await run();
	} finally {
		for (const slug of Object.keys(mentors)) {
			for (const table of [NAMES, TITLE_OVERRIDES, ROW_EMPLOYER, RECORD_COMPANY, LABEL_OVERRIDES, HIDDEN_OVERRIDES, ROW_TITLE_OVERRIDES]) {
				delete table[slug];
			}
		}
	}
}

test("the requested role is parsed from the query without the company, plus the discipline", () => {
	for (const [query, families] of [
		["UX at Google", ["design"]],
		["product manager at Meta", ["product"]],
		["PM", ["product"]],
		["designer from Airbnb", ["design"]],
		["data scientist", ["data"]],
		["engineering manager", ["engineering"]],
		["researcher", ["design"]],
		["growth marketer in Singapore", ["marketing"]],
		["I'm a designer at Stripe, looking for a PM at Google", ["product"]],
		["mentors at Google", []],
		["Google", []],
		["career advice", []],
	]) {
		assert.deepEqual(requestedRoleFamilies(query), families, query);
	}
	// The company's own words are not a role: "Data Co" is an employer.
	assert.deepEqual(requestedRoleFamilies("mentors at Data Co", "Data Co"), []);
	assert.deepEqual(requestedRoleFamilies("mentors", "", "UX Research"), ["design"]);
	assert.deepEqual(requestedRoleFamilies("mentors", "", "Generalist Product Management"), ["product"]);
});

test("role fit: title first, then disciplines; clear mismatches only when nothing matches", () => {
	const design = ["design"];
	assert.deepEqual(roleFit(design, { title: "Senior UX Designer", disciplines: ["UX Design"] }), { score: 3, mismatch: false });
	assert.deepEqual(roleFit(design, { title: "Director", disciplines: ["UX Design"] }), { score: 1, mismatch: false });
	assert.deepEqual(roleFit(design, { title: "Founder", disciplines: [] }), { score: 0, mismatch: false });
	assert.deepEqual(roleFit(design, { title: "Founder", disciplines: ["Back-end"] }), { score: 0, mismatch: true });
	// A title in another role is a mismatch even with a matching label.
	assert.deepEqual(roleFit(design, { title: "Software Engineer", disciplines: ["UX Engineering"] }), { score: 1, mismatch: true });
	for (const [title, disciplines] of [
		["Network Operations Engineer", ["Site Reliability"]],
		["Hardware CAD Engineer", ["Hardware Design"]],
		["Cyber Security Instructor", ["Security Engineering"]],
		["Knowledge Strategist", ["Content Strategy"]],
	]) {
		assert.equal(roleFit(design, { title, disciplines }).mismatch, true, title);
	}
	// Design-family titles that say "engineer" are design titles, not mismatches.
	for (const title of [
		"Human Factors Engineer", "UX Engineer", "Design Engineer", "Design Technologist", "Usability Engineer",
	]) {
		assert.deepEqual(roleFit(design, { title, disciplines: ["UX Research"] }), { score: 3, mismatch: false }, title);
		assert.deepEqual(roleFit(design, { title, disciplines: [] }), { score: 2, mismatch: false }, title);
	}
	assert.equal(roleFit(["product"], { title: "Senior Product Designer", disciplines: ["Product Design"] }).mismatch, true);
	assert.equal(roleFit(["product"], { title: "Product Marketing Manager", disciplines: [] }).mismatch, true);
});

test("company searches return only the requested role there (live cases)", async () => {
	await withRoleMentors(ROLE_MENTORS, () =>
		withFetch(fakeUpstream({ search: ROLE_SEARCH }), async () => {
			// "UX at Google": designers and researchers lead, the UX director with
			// an ambiguous title follows, the founder with no role signal last.
			const ux = await callTool("search_mentors", { query: "UX at Google", limit: 9 });
			assertPublicOutputClean(ux);
			const uxSlugs = mentorsOf(ux.body).map((mentor) => mentor.slug);
			assert.deepEqual(uxSlugs.slice(0, 3).sort(), ["pete-google", "rae-google", "uma-google"]);
			assert.deepEqual(uxSlugs.slice(3), ["dot-google", "flo-google"]);
			for (const mentor of mentorsOf(ux.body)) assert.equal(mentor.company, "Google");

			const pm = await callTool("search_mentors", { query: "product manager at Meta", limit: 9 });
			assertPublicOutputClean(pm);
			assert.deepEqual(
				mentorsOf(pm.body).map((mentor) => mentor.slug).sort(),
				["max-meta", "mo-meta", "pam-meta"],
			);

			const airbnb = await callTool("search_mentors", { query: "designer from Airbnb", limit: 9 });
			assertPublicOutputClean(airbnb);
			assert.deepEqual(
				mentorsOf(airbnb.body).map((mentor) => mentor.slug).sort(),
				["dee-airbnb", "una-airbnb"],
			);
		}),
	);
});

test("PM with an explicit company keeps PMs and ambiguous titles without another role", async () => {
	await withRoleMentors(ROLE_MENTORS, () =>
		withFetch(fakeUpstream({ search: ROLE_SEARCH }), async () => {
			const result = await callTool("search_mentors", { query: "PM", company: "Google", limit: 9 });
			assertPublicOutputClean(result);
			// The UX director and the back-end founder are other roles; the founder
			// with no role signal stays, after the PM.
			assert.deepEqual(
				mentorsOf(result.body).map((mentor) => mentor.slug),
				["gus-google", "flo-google"],
			);
		}),
	);
});

// Product roles with no product-management label, which the signed-in
// product-management filter drops for "product manager" but not for "PM".
const PM_TITLE_MENTORS = {
	"spm-google": ["Sky Pm", "Senior PM", "Google", [], []],
	"pl-google": ["Lee Lead", "Product Lead", "Google", [], []],
	"po-google": ["Oli Owner", "Product Owner", "Google", [], []],
	"fo-google": ["Fay Founder", "Founder", "Google", [], []],
	"fe-google": ["Fen Founder", "Founder", "Google", ["Back-end"], []],
	"se-google": ["Sol Swe", "Software Engineer", "Google", ["Back-end"], []],
	"spm-meta": ["Sid Pm", "Senior PM", "Meta", [], []],
	"pl-meta": ["Lou Lead", "Product Lead", "Meta", [], []],
	"po-meta": ["Oz Owner", "Product Owner", "Meta", [], []],
	"fo-meta": ["Flynn Founder", "Founder", "Meta", [], []],
	"fe-meta": ["Fern Founder", "Founder", "Meta", ["Front-end"], []],
	"de-meta": ["Dev Designer", "Product Designer", "Meta", ["Product Design"], []],
};

const PM_TITLE_SEARCH = {
	...DEFAULT_SEARCH,
	Google: ["spm-google", "pl-google", "po-google", "fo-google", "fe-google", "se-google"],
	Meta: ["spm-meta", "pl-meta", "po-meta", "fo-meta", "fe-meta", "de-meta"],
};

test("'product manager' keeps unlabeled PM titles and ambiguous founders, like 'PM'", async () => {
	await withRoleMentors(PM_TITLE_MENTORS, () =>
		withFetch(fakeUpstream({ search: PM_TITLE_SEARCH }), async () => {
			for (const [args, pms, founder] of [
				[{ query: "product manager", company: "Google", limit: 9 }, ["pl-google", "po-google", "spm-google"], "fo-google"],
				[{ query: "PM", company: "Google", limit: 9 }, ["pl-google", "po-google", "spm-google"], "fo-google"],
				[{ query: "product manager at Meta", limit: 9 }, ["pl-meta", "po-meta", "spm-meta"], "fo-meta"],
			]) {
				const result = await callTool("search_mentors", args);
				assertPublicOutputClean(result);
				const slugs = mentorsOf(result.body).map((mentor) => mentor.slug);
				// PM titles lead; the founder with no role signal follows; the
				// founder with an engineering label and other roles are dropped.
				assert.deepEqual(slugs.slice(0, 3).sort(), pms, args.query);
				assert.deepEqual(slugs.slice(3), [founder], args.query);
			}
		}),
	);
});

// The live preview rows (ADPLIST-4479), every one labelled with the requested
// discipline: labels rescue ambiguous titles only, never a title in another role.
const PM = ["Generalist Product Management"];
const LIVE_ROLE_MENTORS = {
	"kieran-yi-moon": ["Kieran Yi Moon", "Product Manager", "Meta", PM, []],
	"kunyu-lin": ["Kunyu Lin", "Technical Solutions Consultants", "Meta", PM, []],
	"vaidehi-bhandari-jain": ["Vaidehi Bhandari Jain", "Director Program Management", "Meta", PM, []],
	"deepak-k-phd": ["Deepak K", "Software Engineer", "Meta Inc", PM, []],
	"david-goldenshluger": ["David Goldenshluger", "Principal Product & Program Manager", "Meta", PM, []],
	"shahin-katebi": ["Shahin Katebi", "Lead Software Engineer", "Meta", PM, []],
	"ramachandra-nalam": ["Ramachandra Nalam", "Data - AI/ML", "Meta", PM, []],
	"meet-thakkar": ["Meet Thakkar", "Senior Software Engineer", "Meta platforms Inc", PM, []],
	"deepika-nathany": ["Deepika Nathany", "Manager, Enterprise Applications", "Meta Inc", PM, []],
	"kirsten-zverina-archer": ["Kirsten Zverina Archer", "Senior Product Manager", "Google", PM, []],
	"edmur-huq": ["Edmur Huq", "Product Lead", "Google", PM, []],
	"sophia-dhawan-mshg6g3v": ["Sophia Dhawan", "Technical Product Lead", "Google", PM, []],
	"nikhil-mohanlal": ["Nikhil Mohanlal", "Cyber Security Instructor", "Google", PM, []],
	"yogeshree-tawde": ["Yogeshree Tawde", "Product", "Google", PM, []],
	"terry-toh": ["Terry Toh", "Product Strategy & Operations, APAC Go-To Market", "Google", PM, []],
	"zhongying-alex-wu": ["Zhongying Alex Wu", "Senior Account Manager", "Google", PM, []],
	"chandan-agarwal": ["Chandan Agarwal", "Engineering Manager 2", "Google", PM, []],
	"somet-kipchilat": ["Somet Kipchilat", "Program Manager", "Google", PM, []],
	"lead-knowledge-airbnb": ["Lena Knowledge", "Lead Knowledge Strategist", "Airbnb", ["UX Design"], ["Design Systems"]],
	"una-ux-airbnb": ["Una Ux", "UX Designer", "Airbnb", ["UX Design"], []],
};

const LIVE_ROLE_SEARCH = {
	...DEFAULT_SEARCH,
	Meta: [
		"kieran-yi-moon", "kunyu-lin", "vaidehi-bhandari-jain", "deepak-k-phd", "david-goldenshluger",
		"shahin-katebi", "ramachandra-nalam", "meet-thakkar", "deepika-nathany",
	],
	Google: [
		"kirsten-zverina-archer", "edmur-huq", "sophia-dhawan-mshg6g3v", "nikhil-mohanlal", "yogeshree-tawde",
		"terry-toh", "zhongying-alex-wu", "chandan-agarwal", "somet-kipchilat",
	],
	Airbnb: ["lead-knowledge-airbnb", "una-ux-airbnb"],
};

test("a title in another role is dropped whatever its disciplines (live preview rows)", async () => {
	await withRoleMentors(LIVE_ROLE_MENTORS, () =>
		withFetch(fakeUpstream({ search: LIVE_ROLE_SEARCH }), async () => {
			for (const [args, expected] of [
				[{ query: "product manager at Meta", limit: 9 }, ["kieran-yi-moon", "david-goldenshluger"]],
				[
					{ query: "product manager", company: "Google", limit: 9 },
					// "Product" alone is ambiguous: its PM label keeps it, after the PM titles.
					["kirsten-zverina-archer", "edmur-huq", "sophia-dhawan-mshg6g3v", "yogeshree-tawde"],
				],
				[{ query: "designer from Airbnb", limit: 9 }, ["una-ux-airbnb"]],
			]) {
				const result = await callTool("search_mentors", args);
				assertPublicOutputClean(result);
				assert.deepEqual(mentorsOf(result.body).map((mentor) => mentor.slug), expected, args.query);
			}
		}),
	);
});

test("role fit: PM titles stay; titles in other families drop despite a PM label", () => {
	const product = ["product"];
	for (const title of [
		"Product Lead", "Technical Product Lead", "Senior PM", "Product Owner", "Group PM",
		"Principal Product & Program Manager", "Senior Product Manager",
	]) {
		assert.equal(roleFit(product, { title, disciplines: [] }).mismatch, false, title);
	}
	// "and", "&", "+" and "/" join a combined title the same way.
	for (const title of [
		"Principal Product & Program Manager", "Principal Product and Program Manager",
		"Principal Product + Program Manager", "Product / Program Manager",
	]) {
		assert.deepEqual(
			roleFit(product, { title, disciplines: ["Generalist Product Management"] }),
			{ score: 3, mismatch: false },
			title,
		);
	}
	for (const title of ["UX & Product Designer", "UX and Product Designer", "UX/Product Designer"]) {
		assert.deepEqual(roleFit(["design"], { title, disciplines: [] }), { score: 2, mismatch: false }, title);
	}
	for (const title of ["Director", "Founder", "Head", "Lead", "Manager", "Product"]) {
		assert.equal(roleFit(product, { title, disciplines: PM }).mismatch, false, title);
		assert.equal(roleFit(product, { title, disciplines: ["Back-end"] }).mismatch, true, title);
	}
	for (const title of [
		"Software Engineer", "Security Engineer", "Data Engineer", "ML Engineer", "Engineering Manager 2",
		"Senior Account Manager", "Sales Manager", "Technical Solutions Consultants", "Cyber Security Instructor",
		"Program Manager", "Director Program Management", "Lead Knowledge Strategist",
		"Product Strategy & Operations, APAC Go-To Market", "Manager, Enterprise Applications", "Data - AI/ML",
	]) {
		assert.equal(roleFit(product, { title, disciplines: PM }).mismatch, true, title);
	}
});

test("role filtering keeps the company, Former and visibility filters", async () => {
	await withRoleMentors(ROLE_MENTORS, () =>
		withFetch(fakeUpstream({ search: ROLE_SEARCH }), async () => {
			for (const args of [
				{ query: "UX designer at Google", limit: 9 },
				{ query: "designer", company: "Google", limit: 9 },
			]) {
				const slugs = mentorsOf((await callTool("search_mentors", args)).body).map((mentor) => mentor.slug);
				assert.ok(slugs.includes("uma-google"), args.query);
				assert.ok(!slugs.includes("fran-google"), "Former UX Designer is not at Google");
				assert.ok(!slugs.includes("hal-google"), "hidden designer stays hidden");
				assert.ok(!slugs.includes("stu-google"), "previously at Google is not at Google");
			}
			const pm = await callTool("search_mentors", { query: "product manager at Meta", limit: 9 });
			assert.ok(!mentorsOf(pm.body).some((mentor) => mentor.slug === "xia-meta"), "Ex-Meta PM is past");
		}),
	);
});

test("with a role, deeper pages and extra gating batches fill the limit past stale rows", async () => {
	// Nine rows the index still calls UX Designers whose profiles now say
	// Software Engineer, ahead of five real designers. Both rows score as a
	// title match, so upstream order holds and the first batch is all stale.
	const stale = Array.from({ length: 9 }, (_, index) => `stale${index}-google`);
	const designers = Array.from({ length: 5 }, (_, index) => `des${index}-google`);
	const mentors = {
		...Object.fromEntries(stale.map((slug) => [slug, [slug, "Software Engineer", "Google", ["Back-end"], []]])),
		...Object.fromEntries(designers.map((slug) => [slug, [slug, "Product Designer", "Google", [], []]])),
	};
	const calls = [];
	await withRoleMentors(mentors, async () => {
		for (const slug of stale) ROW_TITLE_OVERRIDES[slug] = "UX Designer";
		const search = { ...DEFAULT_SEARCH, Google: [...stale, ...designers] };
		await withFetch(fakeUpstream({ search, calls }), async () => {
			const five = await callTool("search_mentors", { query: "UX at Google", limit: 5 });
			assertPublicOutputClean(five);
			assert.deepEqual(mentorsOf(five.body).map((mentor) => mentor.slug), designers);
			for (const { url } of calls.filter(({ url }) => url.pathname === "/search")) {
				assert.ok(Number(url.searchParams.get("pageSize")) >= 27, url.searchParams.get("q"));
			}

			// At most 3 × limit candidates are gated: limit 4 checks 12 of 14.
			const four = await callTool("search_mentors", { query: "UX at Google", limit: 4 });
			assert.deepEqual(mentorsOf(four.body).map((mentor) => mentor.slug), designers.slice(0, 3));
		});
	});
});

test("a query without a role is unchanged by role relevance", async () => {
	const calls = [];
	await withRoleMentors(ROLE_MENTORS, () =>
		withFetch(fakeUpstream({ search: ROLE_SEARCH, calls }), async () => {
			const result = await callTool("search_mentors", { query: "Google", limit: 9 });
			assertPublicOutputClean(result);
			// Upstream order, every role, the first nine candidates gated.
			assert.deepEqual(
				mentorsOf(result.body).map((mentor) => mentor.slug),
				["noe-google", "cal-google", "cy-google", "sam-google", "uma-google", "pete-google", "rae-google", "gus-google"],
			);
			for (const { url } of calls.filter(({ url }) => url.pathname === "/search")) {
				assert.equal(url.searchParams.get("pageSize"), "9");
			}
		}),
	);
});

test("search_mentors description says company is the current employer", () => {
	const [search] = PUBLIC_TOOLS;
	assert.match(search.description, /current employer/);
	assert.match(search.inputSchema.properties.company.description, /current employer/);
});

test("search (literal name path) finds a visible mentor by name and stays clean", async () => {
	await withFetch(fakeUpstream(), async () => {
		const result = await callTool("search_mentors", { query: "Alice Visible" });
		assertPublicOutputClean(result);
		const mentors = mentorsOf(result.body);
		assert.deepEqual(
			mentors.map((mentor) => mentor.slug),
			["alice-visible"],
		);
		assert.equal(mentors[0].why_match, "Name matches your search.");
	});
});

test("search with no results returns an empty, clean envelope", async () => {
	await withFetch(fakeUpstream(), async () => {
		const result = await callTool("search_mentors", { query: "nothing matches this" });
		assertPublicOutputClean(result);
		assert.deepEqual(result.body.result.structuredContent, { mentors: [] });
	});
});

test("failed upstream search returns UNAVAILABLE and leaks nothing", async () => {
	for (const searchFails of [true, "throw"]) {
		await withFetch(fakeUpstream({ searchFails }), async () => {
			const result = await callTool("search_mentors", { query: "mobile app design" });
			assertPublicOutputClean(result);
			assert.equal(errorCodeOf(result.body), "UNAVAILABLE");
			assert.deepEqual(Object.keys(result.body.result.structuredContent.error).sort(), ["code", "message"]);
		});
	}
});

test("profile returns allowlisted fields with a ≤300 char bio and best-effort stats", async () => {
	await withFetch(fakeUpstream(), async () => {
		const result = await callTool("get_mentor_profile", {
			mentor_slug: "https://adplist.org/mentors/alice-visible?tab=reviews",
		});
		assertPublicOutputClean(result);
		const profile = result.body.result.structuredContent;
		assert.equal(profile.slug, "alice-visible");
		assert.ok(profile.bio.length <= 300);
		assert.equal(profile.average_rating, 4.9);
		assert.equal(profile.total_reviews, 31);
		assert.equal(profile.total_sessions, undefined);
		assert.equal(profile.why_match, undefined);
		for (const key of Object.keys(profile)) assert.ok(MENTOR_KEYS.has(key), key);
	});
});

test("profile stats are omitted when the statistics fetch fails", async () => {
	const base = fakeUpstream();
	await withFetch(
		async (input, init) => {
			if (String(input).includes("/users/statistics")) throw new Error(`stats down ${FAKE_TOKEN}`);
			return base(input, init);
		},
		async () => {
			const result = await callTool("get_mentor_profile", { mentor_slug: "alice-visible" });
			assertPublicOutputClean(result);
			const profile = result.body.result.structuredContent;
			assert.equal(profile.average_rating, undefined);
			assert.equal(profile.total_reviews, undefined);
			assert.equal(profile.name, "Alice Visible");
		},
	);
});

test("photo_url only allows https ADPList S3 and strips query strings", () => {
	assert.equal(
		publicPhotoUrl("https://adplist-bucket.s3.amazonaws.com/a/b.png?X-Amz-Signature=x"),
		"https://adplist-bucket.s3.amazonaws.com/a/b.png",
	);
	assert.equal(
		publicPhotoUrl("https://adplist-bucket.s3.us-east-2.amazonaws.com/a.png"),
		"https://adplist-bucket.s3.amazonaws.com/a.png",
	);
	for (const bad of [
		"http://adplist-bucket.s3.amazonaws.com/a.png",
		"https://evil-bucket.s3.amazonaws.com/a.png",
		"https://adplist-bucket.s3.amazonaws.com.evil.com/a.png",
		"https://user:pass@adplist-bucket.s3.amazonaws.com/a.png",
		`https://${FAKE_HOST}/a.png`,
		"https://lh3.googleusercontent.com/a.png",
		"/media/a.png",
		"javascript:alert(1)",
	]) {
		assert.equal(publicPhotoUrl(bad), "", bad);
	}
});

// ---------------------------------------------------------------------------
// Visibility gate, per path
// ---------------------------------------------------------------------------

const HIDDEN_SLUGS = [
	"inactive-mentor",
	"status-inactive",
	"not-a-mentor",
	"suspended-mentor",
	"onbreak-mentor",
	"optout-mentor",
	"denied-mentor",
	"DENIED-MENTOR",
	"profile-500",
	"profile-throws",
	"profile-malformed",
	"profile-noshape",
	"no-such-mentor",
];

test("search omits every hidden, opted-out, denylisted, or unverifiable mentor", async () => {
	await withFetch(fakeUpstream(), async () => {
		const result = await callTool("search_mentors", { query: "mixed visibility", limit: 9 });
		assertPublicOutputClean(result);
		assert.deepEqual(
			mentorsOf(result.body).map((mentor) => mentor.slug),
			["alice-visible"],
		);
	});
});

test("search where every result is hidden returns an empty list", async () => {
	await withFetch(fakeUpstream(), async () => {
		const result = await callTool("search_mentors", { query: "everyone hidden", limit: 9 });
		assertPublicOutputClean(result);
		assert.deepEqual(mentorsOf(result.body), []);
	});
});

test("search fails closed when every visibility check throws", async () => {
	await withFetch(fakeUpstream({ profileFails: true }), async () => {
		const result = await callTool("search_mentors", { query: "mobile app design" });
		assertPublicOutputClean(result);
		assert.deepEqual(mentorsOf(result.body), []);
		assert.equal(result.response.headers.get("Cache-Control"), "no-store");
	});
});

test("literal-name lookup never surfaces a hidden mentor", async () => {
	await withFetch(fakeUpstream(), async () => {
		const result = await callTool("search_mentors", { query: "Jane Hidden" });
		assertPublicOutputClean(result);
		assert.deepEqual(mentorsOf(result.body), []);
	});
});

test("malformed visibility flags fail closed on the search path; an absent opt-out flag does not", async () => {
	const search = { ...DEFAULT_SEARCH, "malformed flags": [...MALFORMED_FLAG_SLUGS, "no-optout-flag", "alice-visible"] };
	await withFetch(fakeUpstream({ search }), async () => {
		const result = await callTool("search_mentors", { query: "malformed flags", limit: 9 });
		assertPublicOutputClean(result);
		assert.deepEqual(
			mentorsOf(result.body).map((mentor) => mentor.slug),
			["no-optout-flag", "alice-visible"],
		);
	});
});

test("malformed visibility flags fail closed on the literal-name path", async () => {
	const search = Object.fromEntries(
		[...MALFORMED_FLAG_SLUGS, "no-optout-flag"].map((slug) => [NAMES[slug], [slug]]),
	);
	await withFetch(fakeUpstream({ search }), async () => {
		for (const slug of MALFORMED_FLAG_SLUGS) {
			const result = await callTool("search_mentors", { query: NAMES[slug] });
			assertPublicOutputClean(result);
			assert.deepEqual(mentorsOf(result.body), [], slug);
		}
		// Control: the same path does surface a well-formed record.
		const control = await callTool("search_mentors", { query: NAMES["no-optout-flag"] });
		assert.deepEqual(
			mentorsOf(control.body).map((mentor) => mentor.slug),
			["no-optout-flag"],
		);
	});
});

test("malformed visibility flags fail closed on the slug path with the usual NOT_FOUND", async () => {
	await withFetch(fakeUpstream(), async () => {
		const hidden = await callTool("get_mentor_profile", { mentor_slug: "onbreak-mentor" });
		for (const slug of MALFORMED_FLAG_SLUGS) {
			const result = await callTool("get_mentor_profile", { mentor_slug: slug });
			assertPublicOutputClean(result);
			assert.equal(errorCodeOf(result.body), "NOT_FOUND", slug);
			assert.deepEqual(result.body.result, hidden.body.result, slug);
			assert.equal(result.response.headers.get("Cache-Control"), "no-store");
		}
	});
});

test("visibility fetch uses the internal keyed URL with no query params (ADPLIST-4485b)", async () => {
	assert.equal(
		internalVisibilityUrl("https://auth.test/?syncFromLegacy=true#x", "a?syncFromLegacy=true#b"),
		"https://auth.test/internal/users/profile/mentor/a%3FsyncFromLegacy%3Dtrue%23b",
	);
	// The anonymous display read is stripped the same way.
	assert.equal(
		publicVisibilityUrl("https://auth.test/?syncFromLegacy=true#x", "a?syncFromLegacy=true#b"),
		"https://auth.test/users/profile/mentor/a%3FsyncFromLegacy%3Dtrue%23b",
	);
	const calls = [];
	const search = {
		...DEFAULT_SEARCH,
		"mobile app design": ["alice-visible", "bob-visible?syncFromLegacy=true"],
	};
	const env = makeEnv({ AUTH_SERVICE_URL: "https://auth.test/?syncFromLegacy=true" });
	await withFetch(fakeUpstream({ search, calls }), async () => {
		await callTool("search_mentors", { query: "mobile app design" }, { env });
		await callTool("search_mentors", { query: "Alice Visible" }, { env });
		const profile = await callTool(
			"get_mentor_profile",
			{ mentor_slug: "https://adplist.org/mentors/alice-visible?syncFromLegacy=true" },
			{ env },
		);
		assert.equal(profile.body.result.structuredContent.slug, "alice-visible");
	});
	const profileCalls = calls.filter(({ url }) =>
		url.pathname.startsWith("/internal/users/profile/mentor/"),
	);
	assert.ok(profileCalls.length >= 4);
	for (const { url, init } of profileCalls) {
		assert.equal(url.search, "", url.href);
		assert.equal(url.hash, "", url.href);
		assert.ok(!url.href.includes("syncFromLegacy=true"), url.href);
		const headers = init?.headers || {};
		const key = headers["x-api-key"] || headers["X-Api-Key"];
		assert.equal(key, "test-internal-key", url.href);
	}
});

test("a redirect from the visibility endpoint fails closed and never forwards the key", async () => {
	const { createServer } = await import("node:http");
	const listen = (handler) =>
		new Promise((resolve) => {
			const server = createServer(handler);
			server.listen(0, "127.0.0.1", () => resolve(server));
		});
	const otherOriginHits = [];
	const other = await listen((req, res) => {
		otherOriginHits.push(req.headers);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ data: { slug: "alice-visible", status: "active", is: { active: true, mentor: true } } }));
	});
	const otherUrl = `http://127.0.0.1:${other.address().port}/steal`;
	const auth = await listen((req, res) => {
		const status = Number(req.url.split("/").pop().replace("redirect-", "")) || 302;
		res.writeHead(status, { Location: otherUrl });
		res.end();
	});
	const env = makeEnv({ AUTH_SERVICE_URL: `http://127.0.0.1:${auth.address().port}` });
	try {
		for (const status of [301, 302, 303, 307, 308]) {
			const result = await checkMentorVisibility(env, `redirect-${status}`);
			assert.deepEqual(result, { visible: false, failed: true }, String(status));
		}
		assert.equal(otherOriginHits.length, 0, "redirect target must never be contacted");
		assert.ok(otherOriginHits.every((headers) => !("x-api-key" in headers)));
	} finally {
		auth.close();
		other.close();
	}

	const inits = [];
	await withFetch(async (input, init) => {
		inits.push(init);
		return new Response(null, { status: 302, headers: { Location: "https://evil.test/" } });
	}, async () => {
		assert.deepEqual(await checkMentorVisibility(makeEnv(), "alice-visible"), { visible: false, failed: true });
	});
	assert.ok(inits.length >= 1);
	for (const init of inits) assert.equal(init?.redirect, "manual");
});

// Live (preview) symptoms after 3d8b213: the flags-only internal record was used
// as the display record, so profiles came back nameless and every company
// check read an absent profile.organization.
test("get_mentor_profile takes display fields from the public profile, not the flags-only internal record", async () => {
	NAMES["edmur-huq"] = "Edmur Huq";
	const calls = [];
	try {
		await withFetch(fakeUpstream({ calls }), async () => {
			const result = await callTool("get_mentor_profile", { mentor_slug: "edmur-huq" });
			assertPublicOutputClean(result);
			const mentor = result.body.result.structuredContent;
			assert.equal(mentor.name, "Edmur Huq");
			assert.equal(mentor.slug, "edmur-huq");
			assert.equal(mentor.title, "Senior Product Designer");
			assert.equal(mentor.company, "Acme Labs");
			assert.deepEqual(mentor.expertise, ["Product Strategy", "Mobile Apps"]);
			assert.deepEqual(mentor.disciplines, ["Product Design"]);
			assert.deepEqual(mentor.languages, ["English"]);
			assert.equal(mentor.country, "Singapore");
			assert.ok(mentor.bio?.startsWith("Bio for Edmur Huq."));
			assert.equal(mentor.total_reviews, 31);
		});
	} finally {
		delete NAMES["edmur-huq"];
	}
	const internal = calls.filter(({ url }) => url.pathname === "/internal/users/profile/mentor/edmur-huq");
	const anonymous = calls.filter(({ url }) => url.pathname === "/users/profile/mentor/edmur-huq");
	assert.equal(internal.length, 1);
	assert.equal(anonymous.length, 1);
	assert.equal(internal[0].init.headers["x-api-key"], "test-internal-key");
	// The key never goes to the anonymous read.
	assert.ok(!Object.keys(anonymous[0].init.headers).some((name) => /api-key|authorization/i.test(name)));
	assert.equal(anonymous[0].init.redirect, "manual");
});

test("company=Google search reads the current employer from the public profile", async () => {
	const search = {
		...PM_COMPANY_SEARCH,
		"product manager": ["mia-meta", "paul-google", "pia-google", "nico-google", "left-google"],
		Google: ["pia-google", "paul-google", "nico-google", "left-google"],
	};
	// left-google's row says Google but its profile says Other Company.
	PM_SLUGS.add("left-google");
	try {
		await withFetch(fakeUpstream({ search }), async () => {
			const result = await callTool("search_mentors", { query: "product manager", company: "Google", limit: 9 });
			assertPublicOutputClean(result);
			const mentors = mentorsOf(result.body);
			assert.deepEqual(mentors.map((mentor) => mentor.slug).sort(), ["nico-google", "pia-google"]);
			for (const mentor of mentors) {
				assert.equal(mentor.company, "Google");
				assert.equal(mentor.name, NAMES[mentor.slug]);
				assert.equal(mentor.title, "Senior Product Manager");
				assert.deepEqual(mentor.disciplines, ["Product Design"]);
			}
		});
	} finally {
		PM_SLUGS.delete("left-google");
	}
});

test("bookable or indexable false on either record hides the mentor; non-booleans fail closed", async () => {
	const env = makeEnv();
	const cases = [
		[INTERNAL_OVERRIDES, { bookable: false }, { visible: false, failed: false }],
		[INTERNAL_OVERRIDES, { indexable: false }, { visible: false, failed: false }],
		[PUBLIC_OVERRIDES, { bookable: false }, { visible: false, failed: false }],
		[PUBLIC_OVERRIDES, { indexable: false }, { visible: false, failed: false }],
		[PUBLIC_OVERRIDES, { status: "inactive" }, { visible: false, failed: false }],
		[INTERNAL_OVERRIDES, { bookable: "false" }, { visible: false, failed: true }],
		[INTERNAL_OVERRIDES, { indexable: null }, { visible: false, failed: true }],
		[PUBLIC_OVERRIDES, { indexable: 0 }, { visible: false, failed: true }],
		[PUBLIC_OVERRIDES, { bookable: "true" }, { visible: false, failed: true }],
		// The display record must be the same mentor the flags describe.
		[PUBLIC_OVERRIDES, { slug: "someone-else" }, { visible: false, failed: true }],
	];
	await withFetch(fakeUpstream(), async () => {
		for (const [table, override, expected] of cases) {
			table["alice-visible"] = override;
			try {
				assert.deepEqual(
					await checkMentorVisibility(env, "alice-visible"),
					expected,
					JSON.stringify(override),
				);
				const profile = await callTool("get_mentor_profile", { mentor_slug: "alice-visible" });
				assert.equal(errorCodeOf(profile.body), "NOT_FOUND", JSON.stringify(override));
			} finally {
				delete table["alice-visible"];
			}
		}
		// Absent flags are fine on both records.
		INTERNAL_OVERRIDES["alice-visible"] = { bookable: undefined, indexable: undefined };
		PUBLIC_OVERRIDES["alice-visible"] = { bookable: undefined, indexable: undefined, status: undefined };
		try {
			const result = await checkMentorVisibility(env, "alice-visible");
			assert.equal(result.visible, true);
		} finally {
			delete INTERNAL_OVERRIDES["alice-visible"];
			delete PUBLIC_OVERRIDES["alice-visible"];
		}
	});
});

test("a failed or missing public profile omits an otherwise visible mentor", async () => {
	const env = makeEnv();
	for (const [status, expected] of [
		[500, { visible: false, failed: true }],
		[302, { visible: false, failed: true }],
		[404, { visible: false, failed: false }],
	]) {
		const upstream = fakeUpstream();
		await withFetch(async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname.startsWith("/users/profile/mentor/")) {
				return new Response(null, { status, headers: status === 302 ? { Location: "https://evil.test/" } : {} });
			}
			return upstream(input, init);
		}, async () => {
			assert.deepEqual(await checkMentorVisibility(env, "alice-visible"), expected, String(status));
			const search = await callTool("search_mentors", { query: "mobile app design" });
			assert.deepEqual(mentorsOf(search.body), [], String(status));
		});
	}
});

test("a public profile without a matching slug, a name, or an object profile fails closed", async () => {
	const env = makeEnv();
	for (const body of [
		{ data: {} },
		{ data: { slug: 42, fullName: [], profile: [] } },
		{ data: { fullName: "Alice Visible" } },
		{ data: { slug: "alice-visible", fullName: "  " } },
		{ data: { slug: "alice-visible", fullName: "Alice Visible", profile: null } },
		{ data: { slug: "alice-visible", fullName: "Alice Visible", profile: [] } },
	]) {
		const upstream = fakeUpstream();
		await withFetch(async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname.startsWith("/users/profile/mentor/")) return Response.json(body);
			return upstream(input, init);
		}, async () => {
			assert.deepEqual(
				await checkMentorVisibility(env, "alice-visible"),
				{ visible: false, failed: true },
				JSON.stringify(body),
			);
			const profile = await callTool("get_mentor_profile", { mentor_slug: "alice-visible" });
			assert.equal(errorCodeOf(profile.body), "NOT_FOUND", JSON.stringify(body));
			const search = await callTool("search_mentors", { query: "mobile app design" });
			assert.deepEqual(mentorsOf(search.body), [], JSON.stringify(body));
		});
	}
});

test("a public profile with no profile object fails closed instead of using search-row employment", async () => {
	const env = makeEnv();
	// The search row for gina-google still says Google; only the public profile
	// may confirm that, and here it has no profile object at all.
	PUBLIC_OVERRIDES["gina-google"] = { profile: undefined };
	try {
		await withFetch(fakeUpstream(), async () => {
			assert.deepEqual(await checkMentorVisibility(env, "gina-google"), { visible: false, failed: true });
			const result = await callTool("search_mentors", { query: "design", company: "Google", limit: 9 });
			assert.ok(!mentorsOf(result.body).some((mentor) => mentor.slug === "gina-google"));
		});
	} finally {
		delete PUBLIC_OVERRIDES["gina-google"];
	}
});

test("a public profile without an organization has no current employer, whatever the search row says", async () => {
	PUBLIC_OVERRIDES["gina-google"] = { profile: { title: "Product Designer" } };
	try {
		await withFetch(fakeUpstream(), async () => {
			const filtered = await callTool("search_mentors", { query: "design", company: "Google", limit: 9 });
			assertPublicOutputClean(filtered);
			assert.ok(!mentorsOf(filtered.body).some((mentor) => mentor.slug === "gina-google"));
			const profile = await callTool("get_mentor_profile", { mentor_slug: "gina-google" });
			assert.equal(profile.body.result.structuredContent.company, undefined);
		});
	} finally {
		delete PUBLIC_OVERRIDES["gina-google"];
	}
});

test("a missing, empty or non-string internal slug fails closed", async () => {
	const env = makeEnv();
	for (const slug of [undefined, "", "   ", 42, null, ["alice-visible"]]) {
		INTERNAL_OVERRIDES["alice-visible"] = { slug };
		try {
			await withFetch(fakeUpstream(), async () => {
				assert.deepEqual(
					await checkMentorVisibility(env, "alice-visible"),
					{ visible: false, failed: true },
					JSON.stringify(slug),
				);
				const profile = await callTool("get_mentor_profile", { mentor_slug: "alice-visible" });
				assert.equal(errorCodeOf(profile.body), "NOT_FOUND", JSON.stringify(slug));
			});
		} finally {
			delete INTERNAL_OVERRIDES["alice-visible"];
		}
	}
});

test("profile lookup returns the same NOT_FOUND for every hidden or unverifiable mentor", async () => {
	await withFetch(fakeUpstream(), async () => {
		const bodies = new Set();
		for (const slug of HIDDEN_SLUGS) {
			const result = await callTool("get_mentor_profile", { mentor_slug: slug });
			assertPublicOutputClean(result);
			assert.equal(errorCodeOf(result.body), "NOT_FOUND", slug);
			bodies.add(JSON.stringify(result.body.result));
		}
		assert.equal(bodies.size, 1, "hidden reasons must be indistinguishable");
	});
});

test("visibility check times out after 3s and fails closed", async () => {
	// Node unrefs AbortSignal.timeout's timer; keep the loop alive while it runs.
	const keepAlive = setTimeout(() => {}, 10_000);
	try {
		await withFetch(fakeUpstream(), async () => {
			const started = Date.now();
			const result = await callTool("get_mentor_profile", { mentor_slug: "profile-timeout" });
			assert.equal(errorCodeOf(result.body), "NOT_FOUND");
			assert.ok(Date.now() - started < 4500);
			assertPublicOutputClean(result);
		});
	} finally {
		clearTimeout(keepAlive);
	}
});

// ---------------------------------------------------------------------------
// Errors and rate limiting
// ---------------------------------------------------------------------------

test("invalid input gets a fixed INVALID_INPUT with no validation text", async () => {
	await withFetch(fakeUpstream(), async () => {
		for (const args of [
			{},
			{ query: "" },
			{ query: "   " },
			{ query: "x".repeat(201) },
			{ query: "design", limit: 10 },
			{ query: "design", limit: 0 },
			{ query: "design", country: "Singapore" },
			{ query: "design", discipline: `Underwater ${FAKE_TOKEN}` },
		]) {
			const result = await callTool("search_mentors", args);
			assertPublicOutputClean(result);
			assert.equal(errorCodeOf(result.body), "INVALID_INPUT", JSON.stringify(args));
			assert.deepEqual(result.body.result.structuredContent, {
				error: { code: "INVALID_INPUT", message: "The request input is invalid." },
			});
		}
		for (const args of [{}, { mentor_slug: "" }, { mentor_slug: "https://evil.example/x y" }]) {
			const result = await callTool("get_mentor_profile", args);
			assert.equal(errorCodeOf(result.body), "INVALID_INPUT");
		}
	});
});

test("rate limiter is keyed on CF-Connecting-IP and returns RATE_LIMITED when exceeded", async () => {
	const keys = [];
	const env = makeEnv({
		PUBLIC_RATE_LIMITER: {
			async limit({ key }) {
				keys.push(key);
				return { success: false };
			},
		},
	});
	let upstreamCalls = 0;
	await withFetch(
		async () => {
			upstreamCalls += 1;
			return new Response("{}");
		},
		async () => {
			const result = await callTool(
				"search_mentors",
				{ query: "design" },
				{ env, headers: { "X-Forwarded-For": "198.51.100.1" } },
			);
			assertPublicOutputClean(result);
			assert.equal(errorCodeOf(result.body), "RATE_LIMITED");
		},
	);
	assert.deepEqual(keys, ["public-mcp:203.0.113.7"]);
	assert.equal(upstreamCalls, 0);
});

test("missing or broken rate limiter binding returns UNAVAILABLE", async () => {
	for (const limiter of [
		undefined,
		{
			async limit() {
				throw new Error(`binding error ${FAKE_HOST}`);
			},
		},
	]) {
		const result = await callTool(
			"get_mentor_profile",
			{ mentor_slug: "alice-visible" },
			{ env: makeEnv({ PUBLIC_RATE_LIMITER: limiter }) },
		);
		assertPublicOutputClean(result);
		assert.equal(errorCodeOf(result.body), "UNAVAILABLE");
	}
});

test("strict windows: 10 calls / 10 s and 30 calls / 60 s, denied calls not counted", () => {
	assert.deepEqual(
		PUBLIC_RATE_WINDOWS.map(({ limit, periodMs }) => [limit, periodMs]),
		[
			[10, 10_000],
			[30, 60_000],
		],
	);
	const store = new Map();
	const fake = { get: (key) => store.get(key), set: (key, value) => store.set(key, value) };
	const results = [];
	for (let i = 0; i < 12; i += 1) results.push(takeRateSlot(fake, 120_000 + i * 100));
	assert.equal(results.filter((r) => r.allowed).length, 10);
	assert.deepEqual(results[0], { allowed: true, remaining: 9, retryAfter: 0 });
	assert.equal(results[9].remaining, 0);
	assert.deepEqual(results[10], { allowed: false, remaining: 0, retryAfter: 9 });

	// Three full bursts fill the minute; the fourth burst waits for the minute.
	const minute = new Map();
	const m = { get: (key) => minute.get(key), set: (key, value) => minute.set(key, value) };
	let allowed = 0;
	for (const start of [0, 10_000, 20_000, 30_000]) {
		for (let i = 0; i < 10; i += 1) allowed += takeRateSlot(m, 600_000 + start + i).allowed ? 1 : 0;
	}
	assert.equal(allowed, 30);
	assert.deepEqual(takeRateSlot(m, 630_500), { allowed: false, remaining: 0, retryAfter: 30 });
	assert.equal(takeRateSlot(m, 660_000).allowed, true, "a new minute starts fresh");
});

test("strict per-IP limiter caps a 32-calls-in-11s burst and sets Retry-After", async () => {
	let clock = 1_000_000;
	const namespace = fakeRateLimitNamespace({ now: () => clock });
	const env = makeEnv({ PUBLIC_RATE_LIMIT_DO: namespace });
	let searchCalls = 0;
	const upstream = fakeUpstream();
	const statuses = [];
	await withFetch(
		async (input, init) => {
			if (new URL(String(input)).pathname === "/search") searchCalls += 1;
			return upstream(input, init);
		},
		async () => {
			for (let i = 0; i < 32; i += 1) {
				clock = 1_000_000 + Math.floor((i * 11_000) / 32);
				const result = await callTool(
					"search_mentors",
					{ query: "mobile app design" },
					{ env, headers: { "X-Forwarded-For": "198.51.100.1" } },
				);
				assertPublicOutputClean(result);
				const limited = result.body.result.isError === true;
				if (limited) {
					assert.equal(errorCodeOf(result.body), "RATE_LIMITED");
					assert.equal(result.response.status, 200, "JSON-RPC result stays a tool error");
					assert.match(result.response.headers.get("Retry-After"), /^[1-9]\d*$/);
					assert.equal(result.response.headers.get("x-public-rl-remaining"), "0");
				} else {
					assert.equal(result.response.headers.get("Retry-After"), null);
					assert.match(result.response.headers.get("x-public-rl-remaining"), /^\d+$/);
				}
				for (const value of result.response.headers.values()) assert.ok(!value.includes("203.0.113.7"));
				statuses.push(limited ? "limited" : "ok");
			}
		},
	);
	const ok = statuses.filter((s) => s === "ok").length;
	// 30 calls land in the first 10 s window (10 allowed), 2 in the next.
	assert.equal(ok, 12);
	assert.ok(searchCalls > 0);
	assert.ok(namespace.names.every((name) => name === "ip:203.0.113.7"), "keyed on CF-Connecting-IP only");
	assert.ok(env.PUBLIC_RATE_LIMITER.keys.length === 32, "binding stays the first gate");
});

test("a rate-limited call never reaches upstream; the binding gate short-circuits the DO", async () => {
	const namespace = fakeRateLimitNamespace({ take: () => ({ allowed: false, remaining: 0, retryAfter: 7 }) });
	let upstreamCalls = 0;
	await withFetch(
		async () => {
			upstreamCalls += 1;
			return new Response("{}");
		},
		async () => {
			const strict = await callTool("search_mentors", { query: "design" }, { env: makeEnv({ PUBLIC_RATE_LIMIT_DO: namespace }) });
			assert.equal(errorCodeOf(strict.body), "RATE_LIMITED");
			assert.equal(strict.response.headers.get("Retry-After"), "7");

			const gateDo = fakeRateLimitNamespace();
			const env = makeEnv({
				PUBLIC_RATE_LIMIT_DO: gateDo,
				PUBLIC_RATE_LIMITER: { limit: async () => ({ success: false }) },
			});
			const gated = await callTool("get_mentor_profile", { mentor_slug: "alice-visible" }, { env });
			assert.equal(errorCodeOf(gated.body), "RATE_LIMITED");
			assert.equal(gated.response.headers.get("Retry-After"), "60");
			assert.deepEqual(gateDo.names, [], "DO not consulted once the binding says no");
		},
	);
	assert.equal(upstreamCalls, 0);
});

test("missing, throwing, or malformed strict limiter fails closed with UNAVAILABLE", async () => {
	let upstreamCalls = 0;
	await withFetch(
		async () => {
			upstreamCalls += 1;
			return new Response("{}");
		},
		async () => {
			for (const namespace of [
				undefined,
				{},
				fakeRateLimitNamespace({
					take: () => {
						throw new Error(`DO overloaded ${FAKE_HOST} ${FAKE_ID}`);
					},
				}),
				fakeRateLimitNamespace({ take: () => ({ allowed: true }) }),
				fakeRateLimitNamespace({ take: () => null }),
			]) {
				const result = await callTool(
					"search_mentors",
					{ query: "design" },
					{ env: makeEnv({ PUBLIC_RATE_LIMIT_DO: namespace }) },
				);
				assertPublicOutputClean(result);
				assert.equal(errorCodeOf(result.body), "UNAVAILABLE");
				assert.equal(result.response.headers.get("Retry-After"), null);
			}
		},
	);
	assert.equal(upstreamCalls, 0);
});

test("PublicRateLimiter Durable Object counts atomically in SQLite storage", async () => {
	register(
		`data:text/javascript,${encodeURIComponent(
			'export async function resolve(s, c, n) { if (s === "cloudflare:workers") return { url: "data:text/javascript,export class WorkerEntrypoint {} export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }", shortCircuit: true }; return n(s, c); }',
		)}`,
	);
	const { PublicRateLimiter } = await import("../src/public/rateLimiterObject.ts");
	// Just enough of SqlStorage for the three statements the class runs.
	const rows = new Map();
	const statements = [];
	let inTransaction = false;
	const sql = {
		exec(query, ...params) {
			statements.push({ query, inTransaction });
			if (query.startsWith("CREATE TABLE")) return { toArray: () => [] };
			if (query.startsWith("SELECT")) {
				const row = rows.get(params[0]);
				return { toArray: () => (row ? [{ ...row }] : []) };
			}
			if (query.startsWith("INSERT")) {
				rows.set(params[0], { start: params[1], count: params[2] });
				return { toArray: () => [] };
			}
			throw new Error(`unexpected SQL ${query}`);
		},
	};
	const ctx = {
		storage: {
			sql,
			transactionSync(fn) {
				inTransaction = true;
				try {
					return fn();
				} finally {
					inTransaction = false;
				}
			},
		},
	};
	const limiter = new PublicRateLimiter(ctx, {});
	assert.match(statements[0].query, /CREATE TABLE IF NOT EXISTS windows/);
	const decisions = Array.from({ length: 11 }, () => limiter.take());
	assert.equal(decisions.filter((d) => d.allowed).length, 10);
	assert.equal(decisions[10].allowed, false);
	assert.ok(decisions[10].retryAfter >= 1);
	assert.deepEqual([...rows.keys()].sort(), ["burst", "minute"]);
	assert.equal(rows.get("minute").count, 10);
	assert.ok(
		statements.slice(1).every((statement) => statement.inTransaction),
		"every read and write runs inside one synchronous transaction",
	);
});

test("rate limit applies to tools/call only, not to initialize or tools/list", async () => {
	const env = makeEnv({ PUBLIC_RATE_LIMITER: undefined, PUBLIC_RATE_LIMIT_DO: undefined });
	assert.equal((await rpc("initialize", {}, { env })).response.status, 200);
	const list = await rpc("tools/list", {}, { env });
	assert.equal(list.body.result.tools.length, 2);
});

test("injected upstream errors never reach any output", async () => {
	const throwing = async () => {
		throw new Error(`Bearer ${FAKE_TOKEN} https://${FAKE_HOST}/users/${FAKE_ID} stack at x.js:1`);
	};
	const bodies = async (input) => {
		const url = String(input);
		const payload = `{"error":"${FAKE_TOKEN}","host":"${FAKE_HOST}","id":"${FAKE_ID}"}`;
		return new Response(payload, { status: url.includes("/search") ? 500 : 503 });
	};
	for (const impl of [throwing, bodies]) {
		await withFetch(impl, async () => {
			for (const [name, args] of [
				["search_mentors", { query: "mobile app design" }],
				["search_mentors", { query: "mentors at Google" }],
				["search_mentors", { query: "Alice Visible" }],
				["get_mentor_profile", { mentor_slug: "alice-visible" }],
			]) {
				const result = await callTool(name, args);
				assertPublicOutputClean(result);
				assert.ok(["UNAVAILABLE", "NOT_FOUND"].includes(errorCodeOf(result.body)));
			}
		});
	}
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

test("analytics events carry no query, IP, or slug and never block the response", async () => {
	const logs = [];
	const originalLog = console.log;
	console.log = (line) => logs.push(String(line));
	const pending = [];
	const ctx = { waitUntil: (promise) => pending.push(promise) };
	const calls = [];
	const env = makeEnv({ AMPLITUDE_API_KEY: "amp-key" });
	try {
		await withFetch(fakeUpstream({ calls }), async () => {
			await callTool("search_mentors", { query: "mentors at Google" }, { env, ctx, path: "/public/claude/mcp" });
			await callTool("get_mentor_profile", { mentor_slug: "alice-visible" }, { env, ctx });
			await callTool("get_mentor_profile", { mentor_slug: "onbreak-mentor" }, { env, ctx });
			await Promise.all(pending);
		});
	} finally {
		console.log = originalLog;
	}
	const logged = logs.map((line) => JSON.parse(line));
	const toolCalls = logged.filter((event) => event.event === "mcp_tool_call");
	const events = logged.filter((event) => event.event !== "mcp_tool_call");
	assert.deepEqual(
		events.map((event) => event.event),
		["ai_mentor_search_query", "ai_mentor_profile_view", "ai_mentor_profile_view"],
	);
	assert.deepEqual(
		toolCalls.map(({ tool, tier, client, status, result_count, is_internal_test }) => ({
			tool,
			tier,
			client,
			status,
			result_count,
			is_internal_test,
		})),
		[
			{ tool: "search_mentors", tier: "public", client: "claude", status: "ok", result_count: 2, is_internal_test: false },
			{ tool: "get_mentor_profile", tier: "public", client: "other", status: "ok", result_count: 1, is_internal_test: false },
			{ tool: "get_mentor_profile", tier: "public", client: "other", status: "error", result_count: 0, is_internal_test: false },
		],
	);
	assert.deepEqual(Object.keys(events[0]).sort(), [
		"event",
		"had_company_filter",
		"intent_category",
		"latency_ms",
		"result_count",
		"source",
		"status",
	]);
	assert.equal(events[0].source, "claude");
	assert.equal(events[0].had_company_filter, true);
	assert.equal(events[0].intent_category, "company");
	assert.equal(events[0].result_count, 2);
	assert.equal(events[1].found, true);
	assert.equal(events[2].found, false);

	const amplitude = calls.filter(({ url }) => url.hostname === "api2.amplitude.com");
	assert.equal(amplitude.length, 6);
	const sent = amplitude.map(({ init }) => JSON.parse(init.body));
	assert.equal(sent[0].events[0].device_id, "ai-mcp-claude");
	assert.equal(sent[0].events[0].event_type, "ai_mentor_search_query");
	assert.equal(sent[1].events[0].device_id, "mcp-public-claude");
	assert.equal(sent[1].events[0].event_type, "mcp_tool_call");
	const everything = JSON.stringify({ logs, sent });
	for (const forbidden of ["Google", "203.0.113.7", "alice-visible", "onbreak-mentor", "adplist-public-"]) {
		assert.ok(!everything.includes(forbidden), forbidden);
	}
	for (const event of [...events, ...sent.map((body) => body.events[0])]) {
		assert.equal(event.ip, undefined);
		assert.equal(event.user_id, undefined);
	}
});

test("analytics without AMPLITUDE_API_KEY only logs", async () => {
	const originalLog = console.log;
	console.log = () => {};
	const calls = [];
	try {
		await withFetch(fakeUpstream({ calls }), async () => {
			await callTool("get_mentor_profile", { mentor_slug: "alice-visible" });
		});
	} finally {
		console.log = originalLog;
	}
	assert.equal(calls.filter(({ url }) => url.hostname === "api2.amplitude.com").length, 0);
});

// ---------------------------------------------------------------------------
// Config and description/schema pinning
// ---------------------------------------------------------------------------

test("public tool schemas match their descriptions", () => {
	const [search, profile] = PUBLIC_TOOLS;
	assert.deepEqual(search.inputSchema.required, ["query"]);
	assert.equal(search.inputSchema.properties.query.maxLength, 200);
	assert.equal(search.inputSchema.properties.limit.maximum, 9);
	assert.match(search.description, /up to 9 mentors \(5 by default\)/);
	assert.deepEqual(profile.inputSchema.required, ["mentor_slug"]);
	assert.match(profile.description, /up to 300 characters/);
	for (const tool of PUBLIC_TOOLS) assert.equal(tool.inputSchema.$schema, undefined);
});

// ---------------------------------------------------------------------------
// scripts/verify-public-fields.mjs
// ---------------------------------------------------------------------------

const VERIFY_PAGE = pageTexts(`<!doctype html><html><body>
<img src="/_next/image?url=${encodeURIComponent("https://adplist-bucket.s3.amazonaws.com/media/alice.jpg")}&amp;w=256" alt="">
<h1>Alice Visible</h1><p>Senior Product Designer at Acme Labs</p><p>Singapore</p>
<p>4.9 rating &middot; 31 reviews</p>
<p>${"Mentoring product teams for a decade. ".repeat(12)}</p>
<ul><li>Product Strategy</li><li>Mobile Apps</li><li>Product Design</li><li>English</li></ul>
<script>self.__next_f.push({"languages":["Klingon"],"gender":"female"})</script>
</body></html>`);

const VERIFY_CARD = {
	name: "Alice Visible",
	slug: "alice-visible",
	title: "Senior Product Designer",
	company: "Acme Labs",
	country: "Singapore",
	expertise: ["Product Strategy", "Mobile Apps"],
	disciplines: ["Product Design"],
	languages: ["English"],
	photo_url: "https://adplist-bucket.s3.amazonaws.com/media/alice.jpg",
	average_rating: 4.9,
	total_reviews: 31,
};

test("verify script covers every emitted mentor value except our own link and explanation", () => {
	const ours = new Set(["slug", "profile_url", "why_match"]);
	assert.deepEqual(
		[...FIELDS].sort(),
		PUBLIC_MENTOR_KEYS.filter((key) => !ours.has(key)).sort(),
	);
	for (const key of ["total_sessions", "sessions_count"]) {
		assert.ok(!PUBLIC_MENTOR_KEYS.includes(key), key);
		assert.ok(!FIELDS.includes(key), key);
	}
});

test("verify script checks search and profile values independently", () => {
	// Search carries a rating and review count the page never shows; the
	// profile's (public) values must not cover for them.
	const search = { ...VERIFY_CARD, average_rating: 4.2, total_reviews: 77 };
	const profile = {
		...VERIFY_CARD,
		bio: `${"Mentoring product teams for a decade. ".repeat(8).slice(0, 299).trimEnd()}…`,
	};
	const results = verifyMentor({ search, profile }, VERIFY_PAGE);
	const statusOf = (source, field) => results.find((r) => r.source === source && r.field === field).status;
	assert.equal(statusOf("search", "average_rating"), "missing");
	assert.equal(statusOf("search", "total_reviews"), "missing");
	assert.equal(statusOf("profile", "average_rating"), "ok");
	assert.equal(statusOf("profile", "total_reviews"), "ok");
	assert.equal(results.find((r) => r.field === "total_sessions"), undefined);
	for (const field of ["name", "title", "company", "country", "expertise", "disciplines", "languages", "photo_url"]) {
		assert.equal(statusOf("search", field), "ok", `search.${field}`);
		assert.equal(statusOf("profile", field), "ok", `profile.${field}`);
	}
	assert.equal(statusOf("profile", "bio"), "ok");
	assert.equal(statusOf("search", "bio"), "absent");
});

test("verify script fails list, bio, and photo values the page does not show", () => {
	assert.equal(checkField("expertise", ["Product Strategy", "Hidden Skill"], VERIFY_PAGE), "missing");
	assert.equal(checkField("languages", ["English", "Klingon"], VERIFY_PAGE), "script-only");
	assert.equal(checkField("disciplines", ["UX Research"], VERIFY_PAGE), "missing");
	assert.equal(checkField("bio", "Internal note never published", VERIFY_PAGE), "missing");
	assert.equal(
		checkField("photo_url", "https://adplist-bucket.s3.amazonaws.com/media/someone-else.jpg", VERIFY_PAGE),
		"missing",
	);
});

test("verify script reports client-rendered values found in embedded page data as embedded", () => {
	const nextData = {
		props: {
			pageProps: {
				mentor: {
					title: "Staff Designer",
					country: { name: "Singapore" },
					languages: ["English", "Malay"],
					reviewStats: { avg: 4.81, count: 31 },
				},
			},
		},
	};
	const page = pageTexts(`<!doctype html><html><body>
<h1>Alice Visible</h1><p>Senior Product Designer at Acme Labs</p>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>
<script>self.__next_f.push({"country":"Atlantis","avg":4.2})</script>
</body></html>`);
	assert.equal(checkField("average_rating", 4.8, page), "embedded", "reviewStats.avg rounded to 1 decimal");
	assert.equal(checkField("average_rating", 4.81, page), "script-only", "unrounded value is not what the page shows");
	assert.equal(checkField("average_rating", 4.2, page), "script-only");
	assert.equal(checkField("total_reviews", 31, page), "embedded");
	assert.equal(checkField("total_reviews", 30, page), "missing");
	assert.equal(checkField("country", "Singapore", page), "embedded");
	assert.equal(checkField("country", "Atlantis", page), "script-only", "only the page's mentor data counts");
	assert.equal(checkField("languages", ["English", "Malay"], page), "embedded");
	assert.equal(checkField("languages", ["English", "Klingon"], page), "missing");
	assert.equal(checkField("title", "Staff Designer", page), "script-only", "other fields must be visible");
	assert.equal(checkField("title", "Senior Product Designer", page), "ok");

	// reviewStats streamed in an escaped RSC chunk instead of __NEXT_DATA__.
	const streamed = pageTexts(
		`<p>Alice</p><script>self.__next_f.push([1,"{\\"reviewStats\\":{\\"avg\\":4.86,\\"count\\":12}}"])</script>`,
	);
	assert.equal(checkField("average_rating", 4.9, streamed), "embedded");
	assert.equal(checkField("total_reviews", 12, streamed), "embedded");
});

test("wrangler binds the public rate limiter; preview config never touches prod", () => {
	assert.match(wranglerSource, /"name": "PUBLIC_RATE_LIMITER"/);
	assert.match(wranglerSource, /"PUBLIC_OPT_OUT_SLUGS": ""/);
	assert.match(previewSource, /"name": "adplist-mcp-public-preview"/);
	assert.match(previewSource, /"workers_dev": true/);
	assert.doesNotMatch(previewSource, /"routes"|custom_domain|mcp\.adplist\.org/);
	assert.match(previewSource, /__PREVIEW_KV_ID__/);
	assert.match(previewSource, /__PREVIEW_D1_ID__/);
	assert.doesNotMatch(previewSource, /cf4e12c1471a4be59dd1cf6c1f7f6de3|bf3eddaf-3e63-4b26-8008-9ee111a010ea/);
	assert.match(previewSource, /"name": "PUBLIC_RATE_LIMITER"/);
	assert.doesNotMatch(previewSource, /"namespace_id": "4479"/);
});

test("both configs bind the PublicRateLimiter DO with an appended SQLite migration", () => {
	assert.match(indexSource, /export \{ PublicRateLimiter \} from "\.\/public\/rateLimiterObject"/);
	for (const [source, firstTag, newTag] of [
		[wranglerSource, "v1", "v2"],
		[previewSource, "preview-v1", "preview-v2"],
	]) {
		assert.match(source, /"class_name": "PublicRateLimiter",\s*"name": "PUBLIC_RATE_LIMIT_DO"/);
		const migrations = source.slice(source.indexOf('"migrations"'));
		const first = migrations.indexOf(`"tag": "${firstTag}"`);
		const added = migrations.indexOf(`"tag": "${newTag}"`);
		assert.ok(first > 0 && added > first, "new migration appended after the existing one");
		assert.match(migrations.slice(first, added), /"new_sqlite_classes": \[\s*"MyMCP"\s*\]/, "existing migration unchanged");
		assert.match(migrations.slice(added), /"new_sqlite_classes": \[\s*"PublicRateLimiter"\s*\]/);
	}
});

// ---------------------------------------------------------------------------
// Greptile review regressions (ADPLIST-4479)
// ---------------------------------------------------------------------------

async function withPublicOverrides(overrides, run) {
	Object.assign(PUBLIC_OVERRIDES, overrides);
	try {
		return await run();
	} finally {
		for (const slug of Object.keys(overrides)) delete PUBLIC_OVERRIDES[slug];
	}
}

test("search cards are checked against the filters after the identity record replaces row fields", async () => {
	// The search index still says SG / English / Product Design for Bob; his
	// profile has since changed. The card shows the profile, so Bob must go.
	const stale = {
		country: { "bob-visible": { country: { iso: "US", countryName: "United States" } } },
		language: { "bob-visible": { preferences: { languages: [{ legacyId: 2, language: "Spanish" }] } } },
		discipline: {
			"bob-visible": { experiences: { expertise: [], disciplines: [{ legacyId: 3, discipline: "UX Research" }] } },
		},
	};
	const filters = { country: { country: "SG" }, language: { language: "English" }, discipline: { discipline: "Product Design" } };
	await withFetch(fakeUpstream(), async () => {
		for (const [name, override] of Object.entries(stale)) {
			await withPublicOverrides(override, async () => {
				const result = await callTool("search_mentors", { query: "mobile app design", limit: 9, ...filters[name] });
				assertPublicOutputClean(result);
				assert.deepEqual(mentorsOf(result.body).map((mentor) => mentor.slug), ["alice-visible"], name);
			});
		}
		// Unchanged profiles still pass every filter.
		const all = await callTool("search_mentors", {
			query: "mobile app design",
			limit: 9,
			country: "SG",
			language: "English",
			discipline: "Product Design",
		});
		assert.deepEqual(mentorsOf(all.body).map((mentor) => mentor.slug), ["alice-visible", "bob-visible"]);
	});
	// The literal-name path returns early; it is filtered on the final card too.
	await withFetch(fakeUpstream(), () =>
		withPublicOverrides({ "alice-visible": { country: { iso: "US", countryName: "United States" } } }, async () => {
			const byName = await callTool("search_mentors", { query: "Alice Visible", country: "SG" });
			assert.deepEqual(mentorsOf(byName.body), []);
			// The search service filters on country, so the index must agree here.
			await withRowOverrides({ "alice-visible": { country: { iso: "US", name: "United States" } } }, async () => {
				const unfiltered = await callTool("search_mentors", { query: "Alice Visible", country: "US" });
				assert.deepEqual(mentorsOf(unfiltered.body).map((mentor) => mentor.slug), ["alice-visible"]);
			});
		}),
	);
});

test("the requester's past employer is never a mentor-employer filter", () => {
	for (const query of [
		"I was at Google, looking for a design mentor",
		"I used to work at Google and want a career mentor",
		"I worked at Google and need a PM mentor",
		"I previously worked at Google, need a design mentor",
		"I was previously at Google, need a design mentor",
		"I was a PM at Google and want design mentorship",
		"I used to be a designer at Google, looking for a mentor",
		"we were at Google but need a mentor",
		"I'm a designer, previously at Google, looking for a mentor",
		"Previously at Google, now looking for a design mentor",
	]) {
		assert.equal(knownCompanyIn(query), "", query);
		assert.ok(!companyCandidates(query).some((candidate) => /google/i.test(candidate)), query);
	}
	// The role asked for is still read, without the requester's own history.
	assert.deepEqual(requestedRoleFamilies("I was a PM at Google, looking for a design mentor"), ["design"]);
	// A mentor-employer request next to the requester's history still counts.
	assert.equal(knownCompanyIn("I was at Stripe, looking for a PM at Google"), "Google");
	assert.equal(knownCompanyIn("I used to work at Stripe and want mentors from Meta"), "Meta");
	// "was" alone is not employment: what follows the stop word is the request.
	assert.equal(knownCompanyIn("I was hoping to find a PM at Google"), "Google");
});

test("a past-marked title only makes the company field past when it names that company or none", () => {
	for (const [title, company] of [
		["Former Director at Acme", "Google"],
		["Ex-Google PM | Design Lead at Meta", "Meta"],
		["Ex-Google PM", "Meta"],
		["Formerly at Stripe", "Google"],
		["Retired from Google", "Meta"],
	]) {
		assert.ok(!titleMarksEmployerPast(title, company), `${title} @ ${company}`);
		assert.ok(isCurrentEmployer(company, company, title), `${title} @ ${company}`);
	}
	for (const [title, company] of [
		["Former Director at Google", "Google"],
		["Ex-Google PM", "Google"],
		["Ex-Google PM", "Google DeepMind"],
		["Former Google PM", "Google"],
		["Retired from Google", "Google"],
		["Former Director of UX", "Meta"],
		["Past President", "Meta"],
	]) {
		assert.ok(titleMarksEmployerPast(title, company), `${title} @ ${company}`);
		assert.ok(!isCurrentEmployer(company, company, title), `${title} @ ${company}`);
	}
});

test("a mentor whose past role was elsewhere stays in the current-employer search", async () => {
	const mentors = {
		"al-google": ["Al Alum", "Former Director at Acme", "Google", ["Product Design"], []],
		"mae-meta": ["Mae Lead", "Ex-Google PM | Design Lead at Meta", "Meta", ["Product Design"], []],
	};
	const search = { ...DEFAULT_SEARCH, Google: ["al-google", "chris-google"], Meta: ["mae-meta"] };
	await withRoleMentors(mentors, () =>
		withFetch(fakeUpstream({ search }), async () => {
			const google = await callTool("search_mentors", { query: "mentors", company: "Google", limit: 9 });
			assertPublicOutputClean(google);
			// chris-google is "Former Director of UX": a past role naming no company.
			assert.deepEqual(mentorsOf(google.body).map((mentor) => mentor.slug), ["al-google"]);
			const meta = await callTool("search_mentors", { query: "mentors", company: "Meta", limit: 9 });
			assert.deepEqual(mentorsOf(meta.body).map((mentor) => mentor.slug), ["mae-meta"]);
		}),
	);
});

test("a place in an employer's office fragment never becomes a company filter", async () => {
	for (const [employer, place] of [
		["Acme (Canada)", "Canada"],
		["Acme | Canada", "Canada"],
		["Acme [Remote]", "Remote"],
		["Acme (US)", "US"],
		["Acme (Europe)", "Europe"],
		["Acme (India)", "India"],
	]) {
		assert.equal(companyNamedByEmployers(`mentors from ${place}`, [employer]), "", employer);
	}
	// The employer itself, and a past one, still count.
	assert.equal(companyNamedByEmployers("mentors at Initech", ["Former Initech (Canada)"]), "Initech");
	assert.equal(companyNamedByEmployers("mentors from Acme", ["Acme (Canada)"]), "Acme");

	const mentors = { "cam-acme": ["Cam Acme", "Product Designer", "Acme (Canada)", ["Product Design"], []] };
	const search = { ...DEFAULT_SEARCH, Canada: ["cam-acme"], "mentors from Canada": ["cam-acme", "alice-visible"] };
	const inCanada = { country: { iso: "CA", name: "Canada" } };
	await withRoleMentors(mentors, () =>
		withRowOverrides({ "cam-acme": inCanada, "alice-visible": inCanada }, () =>
			withPublicOverrides({ "cam-acme": { country: { iso: "CA" } }, "alice-visible": { country: { iso: "CA" } } }, () =>
				withFetch(fakeUpstream({ search }), async () => {
					const result = await callTool("search_mentors", { query: "mentors from Canada", limit: 9 });
					assertPublicOutputClean(result);
					assert.deepEqual(mentorsOf(result.body).map((mentor) => mentor.slug), ["cam-acme", "alice-visible"]);
				}),
			),
		),
	);
});

test("specialty searches keep the domain fit: a generic marketer is not a growth mentor", async () => {
	const generalist = { name: "Gen", slug: "gen", title: "Marketing Manager", countryISO: "SG", expertise: ["Brand"], disciplines: ["Marketing"] };
	const growth = { name: "Gro", slug: "gro", title: "Growth Marketing Lead", countryISO: "SG", expertise: ["Growth Marketing"], disciplines: ["Marketing"] };
	const input = { intent: "growth marketing", filters: { max_results: 9 } };
	const rank = (options) =>
		mapSearchMentorsResponse({ results: [generalist, growth] }, input, false, options).mentors.map((mentor) => mentor.slug);
	assert.deepEqual(rank(undefined), ["gro"], "signed-in");
	assert.deepEqual(rank({ maxRows: 27, roleDecided: true }), ["gro"], "public role ranking");

	const mentors = {
		"gen-mkt": ["Gen Generalist", "Marketing Manager", "Acme Labs", ["Marketing"], ["Brand"]],
		"gro-mkt": ["Gro Growth", "Growth Marketing Lead", "Acme Labs", ["Marketing"], ["Growth Marketing"]],
	};
	const upstream = fakeUpstream();
	await withRoleMentors(mentors, () =>
		withFetch(
			async (request, init) => {
				const url = new URL(String(request));
				if (url.pathname === "/search" && url.searchParams.get("q").startsWith("growth marketing.")) {
					return Response.json({ results: [searchRow("gen-mkt", 1), searchRow("gro-mkt", 2)] });
				}
				return upstream(request, init);
			},
			async () => {
				const result = await callTool("search_mentors", { query: "growth marketing", limit: 9 });
				assertPublicOutputClean(result);
				assert.deepEqual(mentorsOf(result.body).map((mentor) => mentor.slug), ["gro-mkt"]);
			},
		),
	);
});

test("the signed-in employer phrase is unchanged; the public tier cuts it at a tool clause", () => {
	// main (0e4d981) behaviour of the shared signed-in parser.
	assert.equal(employerCandidate("mentors at Acme using Figma"), "Acme using Figma");
	assert.equal(employerCandidate("mentors at Acme via Figma"), "Acme via Figma");
	assert.equal(companyCandidates("mentors at Acme via Figma")[0], "Acme");
});

test("generic consultant titles are ambiguous: disciplines decide, a named field still rejects", () => {
	const marketing = {
		title: "Digital Strategy Consultant",
		disciplines: ["marketing"],
		expertise: ["digital marketing", "performance marketing"],
	};
	assert.deepEqual(roleFit(["marketing"], marketing), { score: 1, mismatch: false });
	for (const title of ["Consultant", "Consultants", "Senior Consultant", "Independent Consultant"]) {
		assert.equal(roleFit(["product"], { title, disciplines: PM }).mismatch, false, title);
		assert.equal(roleFit(["product"], { title, disciplines: ["Back-end"] }).mismatch, true, title);
	}
	for (const title of ["Security Consultant", "HR Consultant", "Sales Consultant", "Technical Solutions Consultant"]) {
		assert.equal(roleFit(["product"], { title, disciplines: PM }).mismatch, true, title);
	}
});

test("a body without Content-Length is cut off at the byte limit while streaming", async () => {
	const post = (body) =>
		handlePublicRequest(
			new Request("https://mcp.adplist.org/public/mcp", {
				method: "POST",
				headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
				body,
				duplex: "half",
			}),
			makeEnv(),
			{ waitUntil() {} },
		);
	let pulled = 0;
	const endless = new ReadableStream({
		pull(controller) {
			pulled += 1;
			if (pulled > 1000) return controller.close();
			controller.enqueue(new Uint8Array(16 * 1024).fill(0x20));
		},
	});
	const tooBig = await post(endless);
	assert.equal(tooBig.status, 413);
	assert.ok(pulled <= 8, `read ${pulled} chunks of a body past the limit`);

	// Bytes, not characters: 40k "é" is 80 KB of UTF-8.
	const stream = (text) => new Blob([text]).stream();
	const wide = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "é".repeat(40_000) } });
	assert.ok(wide.length < 64 * 1024);
	assert.equal((await post(stream(wide))).status, 413);

	// A small streamed body still works.
	const ok = await post(stream(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })));
	assert.equal(ok.status, 200);
	assert.equal((await ok.json()).result.tools.length, 2);
});

test("verify script checks rating and review count against reviewStats, not any page number", () => {
	// reviewStats says 12 reviews at 4.6; the bio mentions 31 projects and 4.9.
	const nextData = { props: { pageProps: { mentor: { reviewStats: { avg: 4.61, count: 12 } } } } };
	const withStats = pageTexts(`<p>Led 31 projects, rated 4.9 by peers</p><p>31 reviews</p>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`);
	assert.equal(checkField("total_reviews", 31, withStats), "missing");
	assert.equal(checkField("average_rating", 4.9, withStats), "missing");
	assert.equal(checkField("total_reviews", 12, withStats), "embedded");
	assert.equal(checkField("average_rating", 4.6, withStats), "embedded");

	// No reviewStats: only a labelled number counts.
	const bioOnly = pageTexts(`<p>Led 31 projects, rated 4.9 by peers</p>`);
	assert.equal(checkField("total_reviews", 31, bioOnly), "missing");
	assert.equal(checkField("average_rating", 4.9, bioOnly), "missing");
	const labelled = pageTexts(`<p>★ 4.9</p><p>(31 reviews)</p><p>Led 12 projects</p>`);
	assert.equal(checkField("average_rating", 4.9, labelled), "ok");
	assert.equal(checkField("total_reviews", 31, labelled), "ok");
	assert.equal(checkField("total_reviews", 12, labelled), "missing");
});

test("setup docs require IDENTITY_INTERNAL_API_KEY on preview and production", () => {
	assert.match(readmeSource, /wrangler secret put IDENTITY_INTERNAL_API_KEY -c wrangler\.preview\.jsonc/);
	assert.match(readmeSource, /wrangler secret put IDENTITY_INTERNAL_API_KEY\s+#/);
	assert.match(readmeSource, /adplist\/internalApiKey/);
	assert.match(readmeSource, /never (?:echo|print)/i);
	assert.match(publicDocsSource, /IDENTITY_INTERNAL_API_KEY/);
	assert.match(publicDocsSource, /\/internal\/users\/profile\/mentor\/\{slug\}/);
	assert.match(publicDocsSource, /adplist\/internalApiKey/);
	// The documented route is the one the code calls.
	assert.equal(
		internalVisibilityUrl("https://auth.test", "alice"),
		"https://auth.test/internal/users/profile/mentor/alice",
	);
});

// ---------------------------------------------------------------------------
// Preview regressions after the Greptile fixes (ADPLIST-4479)
// ---------------------------------------------------------------------------

async function withRowOverrides(overrides, run) {
	Object.assign(ROW_OVERRIDES, overrides);
	try {
		return await run();
	} finally {
		for (const slug of Object.keys(overrides)) delete ROW_OVERRIDES[slug];
	}
}

test("a literal-name lookup applies only the caller's filters, never ones read from the name", async () => {
	// The live shape: title "Product", company "Google", country present, visible.
	const slug = "yogeshree-tawde";
	const mentors = { [slug]: ["Yogeshree Tawde", "Product", "Google", ["Product Management"], []] };
	const search = { ...DEFAULT_SEARCH, "Yogeshree Tawde": [slug, "gina-google"] };
	const india = { country: { iso: "IN", name: "India" } };
	await withRoleMentors(mentors, () =>
		withRowOverrides({ [slug]: india }, () =>
			withPublicOverrides({ [slug]: { country: { iso: "IN", countryName: "India" } } }, () =>
				withFetch(fakeUpstream({ search }), async () => {
					const result = await callTool("search_mentors", { query: "Yogeshree Tawde" });
					assertPublicOutputClean(result);
					const cards = mentorsOf(result.body);
					assert.deepEqual(cards.map((mentor) => mentor.slug), [slug]);
					assert.equal(cards[0].title, "Product");
					assert.equal(cards[0].company, "Google");
					assert.equal(cards[0].country, "India");
					assert.equal(cards[0].why_match, "Name matches your search.");

					// The caller's own filters still apply to the name lookup.
					const lookup = async (args) =>
						mentorsOf((await callTool("search_mentors", { query: "Yogeshree Tawde", ...args })).body).map(
							(mentor) => mentor.slug,
						);
					assert.deepEqual(await lookup({ country: "IN" }), [slug]);
					assert.deepEqual(await lookup({ company: "Google" }), [slug]);
					assert.deepEqual(await lookup({ language: "English" }), [slug]);
					assert.deepEqual(await lookup({ company: "Meta" }), []);
				}),
			),
		),
	);
	// A field the card lacks never drops it: the name search applied the filter.
	await withRoleMentors(mentors, () =>
		withRowOverrides({ [slug]: { ...india, languages: [] } }, () =>
			withPublicOverrides({ [slug]: { preferences: { languages: [] } } }, () =>
				withFetch(fakeUpstream({ search }), async () => {
					const result = await callTool("search_mentors", { query: "Yogeshree Tawde", language: "Hindi" });
					assert.deepEqual(mentorsOf(result.body).map((mentor) => mentor.slug), [slug]);
				}),
			),
		),
	);
});

test("a place after from/in/based in is a country, never a company candidate", () => {
	for (const [query, iso] of [
		["mentors from Canada", "CA"],
		["designers in India", "IN"],
		["PM based in UK", "GB"],
		["mentors in the UK", "GB"],
		["mentors from Canada who work at Google", "CA"],
	]) {
		assert.equal(countryIntentIn(query), iso, query);
		assert.ok(!companyCandidates(query).some((candidate) => /canada|india|uk/i.test(candidate)), query);
	}
	// "Canada Life" never confirms the place "Canada" as a company.
	assert.equal(companyConfirmedByEmployers("mentors from Canada", ["Canada Life"]), "");
	assert.equal(companyNamedByEmployers("mentors from Canada", ["Canada Life"]), "");
	// Cities and regions are places too, just not a country filter.
	assert.equal(countryIntentIn("mentors from New York"), "");
	assert.deepEqual(companyCandidates("mentors from New York"), []);
	// Fields and pronouns are not countries, and an employer named after a
	// place stays an employer.
	for (const query of ["mentors in IT", "PM from AI startups", "mentors near us"]) {
		assert.equal(countryIntentIn(query), "", query);
	}
	assert.equal(companyConfirmedByEmployers("mentors at Canada Life", ["Canada Life"]), "Canada Life");
	assert.equal(knownCompanyIn("mentors from Canada who work at Google"), "Google");
});

test("place queries return mentors in that country, not at an employer named after it", async () => {
	const mentors = {
		"cal-canlife": ["Cal Life", "Senior Product Designer", "Canada Life", ["Product Design"], []],
		"cam-north": ["Cam North", "Senior Product Designer", "Acme Labs", ["Product Design"], []],
		"ina-design": ["Ina Design", "Senior Product Designer", "Acme Labs", ["Product Design"], []],
		"uma-pm": ["Uma Pm", "Senior Product Manager", "Acme Labs", ["Product Management"], []],
	};
	const rows = {
		"cal-canlife": { country: { iso: "SG", name: "Singapore" } },
		"cam-north": { country: { iso: "CA", name: "Canada" } },
		"ina-design": { country: { iso: "IN", name: "India" } },
		"uma-pm": { country: { iso: "GB", name: "United Kingdom" } },
	};
	const records = {
		"cam-north": { country: { iso: "CA", countryName: "Canada" } },
		"ina-design": { country: { iso: "IN", countryName: "India" } },
		"uma-pm": { country: { iso: "GB", countryName: "United Kingdom" } },
	};
	const search = {
		...DEFAULT_SEARCH,
		Canada: ["cal-canlife"],
		"mentors from Canada": ["cal-canlife", "cam-north", "alice-visible"],
		"designers in India": ["ina-design", "alice-visible"],
		"PM based in UK": ["uma-pm", "bob-visible"],
	};
	const calls = [];
	await withRoleMentors(mentors, () =>
		withRowOverrides(rows, () =>
			withPublicOverrides(records, () =>
				withFetch(fakeUpstream({ search, calls }), async () => {
					for (const [query, iso, country, expected] of [
						["mentors from Canada", "CA", "Canada", ["cam-north"]],
						["designers in India", "IN", "India", ["ina-design"]],
						["PM based in UK", "GB", "United Kingdom", ["uma-pm"]],
					]) {
						calls.length = 0;
						const result = await callTool("search_mentors", { query, limit: 9 });
						assertPublicOutputClean(result);
						const cards = mentorsOf(result.body);
						assert.deepEqual(cards.map((mentor) => mentor.slug), expected, query);
						for (const card of cards) assert.equal(card.country, country, query);
						const searches = calls.filter(({ url }) => url.pathname === "/search");
						assert.ok(searches.length > 0, query);
						for (const { url } of searches) {
							assert.equal(url.searchParams.get("countries"), iso, query);
							assert.notEqual(url.searchParams.get("q"), country, query);
						}
					}
				}),
			),
		),
	);
});

test("a literal-name lookup sends only the caller's filters, never ones inferred from the name (Codex repro)", async () => {
	const slug = "usa-tanaka";
	const mentors = { [slug]: ["Usa Tanaka", "Product Designer", "Acme Labs", ["Product Design"], ["English"]] };
	const search = { ...DEFAULT_SEARCH, "Usa Tanaka": [slug] };
	const calls = [];
	await withRoleMentors(mentors, () =>
		withRowOverrides({ [slug]: { country: { iso: "SG", name: "Singapore" } } }, () =>
			withPublicOverrides({ [slug]: { country: { iso: "SG", countryName: "Singapore" } } }, () =>
				withFetch(fakeUpstream({ search, calls }), async () => {
					const result = await callTool("search_mentors", { query: "Usa Tanaka", language: "English" });
					assertPublicOutputClean(result);
					assert.deepEqual(mentorsOf(result.body).map((mentor) => mentor.slug), [slug]);
					const nameSearch = calls.find(
						({ url }) => url.pathname === "/search" && url.searchParams.get("q") === "Usa Tanaka",
					);
					assert.ok(nameSearch);
					assert.equal(nameSearch.url.searchParams.get("countries"), null);
					assert.equal(nameSearch.url.searchParams.get("languages"), "english");
				}),
			),
		),
	);
});

test("a place followed by more of a name is an employer, not a country (Canada Life, Codex repro)", async () => {
	for (const query of ["mentors from Canada Life", "mentors at Canada Life"]) {
		assert.equal(countryIntentIn(query), "", query);
	}
	// A real place later in the query still counts; the employer prefix does not.
	assert.equal(countryIntentIn("designers from Canada Life in Singapore"), "");
	// A clause word or punctuation after the place still ends it.
	assert.equal(countryIntentIn("mentors from Canada who work at Google"), "CA");
	assert.equal(countryIntentIn("mentors from Canada, ideally designers"), "CA");
	assert.equal(countryIntentIn("mentors in the UK at Google"), "GB");

	const mentors = { "cal-canlife": ["Cal Life", "Senior Product Designer", "Canada Life", ["Product Design"], []] };
	const search = {
		...DEFAULT_SEARCH,
		"Canada Life": ["cal-canlife"],
		"mentors from Canada Life": ["cal-canlife"],
	};
	const calls = [];
	await withRoleMentors(mentors, () =>
		withRowOverrides({ "cal-canlife": { country: { iso: "SG", name: "Singapore" } } }, () =>
			withPublicOverrides({ "cal-canlife": { country: { iso: "SG", countryName: "Singapore" } } }, () =>
				withFetch(fakeUpstream({ search, calls }), async () => {
					const result = await callTool("search_mentors", { query: "mentors from Canada Life", limit: 9 });
					assertPublicOutputClean(result);
					assert.deepEqual(mentorsOf(result.body).map((mentor) => mentor.slug), ["cal-canlife"]);
					for (const { url } of calls.filter(({ url }) => url.pathname === "/search")) {
						assert.equal(url.searchParams.get("countries"), null);
					}
				}),
			),
		),
	);
});

test("an explicit company on a literal-name lookup needs a current employer; missing or former-only is out (Codex repro)", async () => {
	for (const organization of [undefined, "", "Former Google"]) {
		const profile = { title: "Product Designer", ...(organization === undefined ? {} : { organization }) };
		await withPublicOverrides({ "alice-visible": { profile } }, () =>
			withFetch(fakeUpstream(), async () => {
				const result = await callTool("search_mentors", { query: "Alice Visible", company: "Google" });
				assertPublicOutputClean(result);
				assert.ok(
					!mentorsOf(result.body).some((mentor) => mentor.slug === "alice-visible"),
					JSON.stringify(organization),
				);
			}),
		);
	}
	// A current employer that matches still passes the name lookup.
	await withPublicOverrides({ "alice-visible": { profile: { title: "Product Designer", organization: "Google" } } }, () =>
		withFetch(fakeUpstream(), async () => {
			const result = await callTool("search_mentors", { query: "Alice Visible", company: "Google" });
			assert.ok(mentorsOf(result.body).some((mentor) => mentor.slug === "alice-visible"));
		}),
	);
});

test("a negated place is never an inclusion filter (Codex repro)", () => {
	for (const query of [
		"mentors not based in US",
		"mentors not based in the UK",
		"designers anywhere except in Canada",
		"PMs, excluding those from India",
		"mentors who are not from Canada",
	]) {
		assert.equal(countryIntentIn(query), "", query);
	}
	// Any negation anywhere means no country, even in an earlier clause.
	assert.equal(countryIntentIn("not a PM, mentors from Canada"), "");
});

const NEGATED_PLACE_QUERIES = [
	"mentors who aren't based in Canada",
	"mentors who aren’t based in Canada",
	"designers who isn't from India",
	"I don’t want mentors from Canada",
	"mentors who doesn't live in the UK, anyone else",
	"mentors who won't be in Canada",
	"mentors who wasn't based in India",
	"no mentors from Canada",
	"never anyone from India",
	"designers without anyone from Canada",
	"designers outside of the UK",
	"mentors except those from Canada",
	"mentors excluding those based in India",
	"mentors other than in Canada",
	"mentors anywhere but in the UK",
];

test("a negated place, contracted or typographic, is never an inclusion filter (Codex repro)", () => {
	for (const query of NEGATED_PLACE_QUERIES) {
		assert.equal(countryIntentIn(query), "", query);
	}
	// Words that merely contain a negation still allow the place; any real
	// negation, wherever it is, does not.
	assert.equal(countryIntentIn("knowledgeable mentors from Canada"), "CA");
	assert.equal(countryIntentIn("mentors who can’t wait, from Canada"), "");
});

test("search_mentors sends no country filter for a negated place (aren’t, Codex repro)", async () => {
	const calls = [];
	await withFetch(fakeUpstream({ calls }), async () => {
		for (const query of NEGATED_PLACE_QUERIES) {
			calls.length = 0;
			const result = await callTool("search_mentors", { query, limit: 9 });
			assertPublicOutputClean(result);
			const searches = calls.filter(({ url }) => url.pathname === "/search");
			assert.ok(searches.length > 0, query);
			for (const { url } of searches) assert.equal(url.searchParams.get("countries"), null, query);
		}
		// The unnegated query still filters, so the assertion above is not vacuous.
		calls.length = 0;
		await callTool("search_mentors", { query: "mentors based in Canada", limit: 9 });
		const searches = calls.filter(({ url }) => url.pathname === "/search");
		assert.ok(searches.some(({ url }) => url.searchParams.get("countries") === "CA"));
	});
});

const NEGATED_US_QUERIES = ["mentors who aren’t based in US", "I don’t want mentors from USA"];

test("search_mentors sends no US filter for a negated US place; the shared builder does not re-infer it (Codex repro)", async () => {
	const calls = [];
	await withFetch(fakeUpstream({ calls }), async () => {
		for (const query of NEGATED_US_QUERIES) {
			assert.equal(countryIntentIn(query), "", query);
			calls.length = 0;
			const result = await callTool("search_mentors", { query, limit: 9 });
			assertPublicOutputClean(result);
			const searches = calls.filter(({ url }) => url.pathname === "/search");
			assert.ok(searches.length > 0, query);
			for (const { url } of searches) assert.equal(url.searchParams.get("countries"), null, query);
		}
	});
	// Signed-in search keeps inferring US by default.
	const signedIn = new URL(buildSearchMentorsUrl("https://search.test", { intent: "product managers in the USA" }));
	assert.equal(signedIn.searchParams.get("countries"), "US");
});

test("countryIntentIn: punctuation does not bypass the ambiguous-code guard (Codex repro)", () => {
	for (const query of ["mentors in IT.", "mentors in HR.", "mentors in IT, please"]) {
		assert.equal(countryIntentIn(query), "", query);
	}
	assert.equal(countryIntentIn("designers in UK."), "GB");
});

test("search_mentors ranking keeps non-US mentors for a negated US place (Codex repro)", async () => {
	const slug = "sam-sg";
	const mentors = { [slug]: ["Sam Sg", "Senior Product Designer", "Acme Labs", ["Product Design"], []] };
	const search = Object.fromEntries(NEGATED_US_QUERIES.map((query) => [query, [slug]]));
	await withRoleMentors(mentors, () =>
		withRowOverrides({ [slug]: { country: { iso: "SG", name: "Singapore" } } }, () =>
			withPublicOverrides({ [slug]: { country: { iso: "SG", countryName: "Singapore" } } }, () =>
				withFetch(fakeUpstream({ search: { ...DEFAULT_SEARCH, ...search } }), async () => {
					for (const query of NEGATED_US_QUERIES) {
						const result = await callTool("search_mentors", { query, limit: 9 });
						assertPublicOutputClean(result);
						assert.deepEqual(mentorsOf(result.body).map((mentor) => mentor.slug), [slug], query);
					}
				}),
			),
		),
	);
	// The opt-out is what keeps it: the shared ranker's default still infers US.
	const rows = { results: [{ slug, name: "Sam Sg", countryISO: "SG" }] };
	const input = { intent: NEGATED_US_QUERIES[1] };
	assert.equal(mapSearchMentorsResponse(rows, input, false).mentors.length, 0);
	assert.equal(mapSearchMentorsResponse(rows, input, false, { inferCountry: false }).mentors.length, 1);
});

test("plain two-word person names take the literal-name path (Yogeshree Tawde, Edmur Huq regression)", async () => {
	// The live shapes: title "Product", company "Google", the search row and
	// display record both "Yogeshree Tawde".
	const mentors = {
		"yogeshree-tawde": ["Yogeshree Tawde", "Product", "Google", ["Product Management"], ["Product Strategy"]],
		"edmur-huq": ["Edmur Huq", "Senior Product Designer", "Acme Labs", ["Product Design"], ["Mobile Apps"]],
		// A name that opens with a well-known company still reads as a name.
		"meta-patel": ["Meta Patel", "Senior Product Designer", "Acme Labs", ["Product Design"], ["Mobile Apps"]],
		// Names that open with a self-description subject ("my", "im") are names.
		"my-nguyen": ["My Nguyen", "Senior Product Designer", "Acme Labs", ["Product Design"], ["Mobile Apps"]],
		"my-le": ["My Le", "Senior Product Designer", "Acme Labs", ["Product Design"], ["Mobile Apps"]],
		"im-soo-jung": ["Im Soo Jung", "Senior Product Designer", "Acme Labs", ["Product Design"], ["Mobile Apps"]],
	};
	const search = {
		...DEFAULT_SEARCH,
		"Yogeshree Tawde": ["yogeshree-tawde"],
		Yogeshree: ["yogeshree-tawde"],
		"Edmur Huq": ["edmur-huq"],
		"Meta Patel": ["meta-patel"],
		"My Nguyen": ["my-nguyen"],
		"My Le": ["my-le"],
		"Im Soo Jung": ["im-soo-jung"],
	};
	for (const [query, slug] of [
		["Yogeshree Tawde", "yogeshree-tawde"],
		["Yogeshree", "yogeshree-tawde"],
		["Edmur Huq", "edmur-huq"],
		["Meta Patel", "meta-patel"],
		["My Nguyen", "my-nguyen"],
		["My Le", "my-le"],
		["Im Soo Jung", "im-soo-jung"],
	]) {
		const calls = [];
		await withRoleMentors(mentors, () =>
			withFetch(fakeUpstream({ search, calls }), async () => {
				const result = await callTool("search_mentors", { query });
				assertPublicOutputClean(result);
				assert.deepEqual(mentorsOf(result.body).map((mentor) => mentor.slug), [slug], query);
				const searches = calls.filter(({ url }) => url.pathname === "/search");
				// Two-word names are looked up by name alone, with nothing inferred.
				if (query.includes(" ")) {
					assert.deepEqual(searches.map(({ url }) => url.searchParams.get("q")), [query], query);
					assert.equal(searches[0].url.searchParams.get("countries"), null, query);
				}
			}),
		);
	}
	// A name that opens with a self-description subject survives place
	// blanking; any self-reference still means no inferred country.
	assert.match(withoutPlaces("My Nguyen in Canada"), /My Nguyen/);
	assert.match(withoutPlaces("Im Soo Jung from the UK"), /Im Soo Jung/);
	assert.doesNotMatch(withoutPlaces("Im based in India, find Alice Visible"), /India/);
	assert.doesNotMatch(withoutPlaces("My team is in Singapore, find Alice Visible"), /Singapore/);
	assert.equal(countryIntentIn("My Le in Canada"), "");
	assert.equal(countryIntentIn("My team is in India"), "");
	assert.equal(countryIntentIn("I'm American"), "");
	// A role is not a plain name: "Google PM" stays a company search, never a
	// literal-name lookup (which would guess the slug google-pm).
	const calls = [];
	await withFetch(fakeUpstream({ calls }), async () => {
		await callTool("search_mentors", { query: "Google PM" });
		assert.ok(!calls.some(({ url }) => url.pathname.endsWith("/mentor/google-pm")));
	});
});

test("the requester's own location is never the mentor-country filter (Greptile, company.ts:450)", async () => {
	for (const [query, iso] of [
		["I am based in India and want a design mentor in Canada", ""],
		["I’m based in India, want a mentor in Canada", ""],
		["I'm in India, looking for mentors from Canada", ""],
		["I'm a designer in London looking for a PM in the US", ""],
		["We live in Singapore and need mentors in the UK", ""],
		// No first-person subject: "PM mentor in Canada" is stated directly.
		["Based in India, need a PM mentor in Canada", "CA"],
		// Any self-reference means no country, wherever the place is.
		["mentors in Canada, I'm in India", ""],
		["I'm keen on PMs in Canada", ""],
		["I'm looking for mentors in Canada", ""],
		["I am based in India and want a design mentor", ""],
		["I live in India, need a PM mentor", ""],
		["I'm from Canada looking for a design mentor", ""],
		["I'm a PM at Stripe in Canada and need a design mentor", ""],
	]) {
		assert.equal(countryIntentIn(query), iso, query);
	}
	const calls = [];
	await withFetch(fakeUpstream({ calls }), async () => {
		await callTool("search_mentors", { query: "I am based in India and want a design mentor in Canada" });
		const searches = calls.filter(({ url }) => url.pathname === "/search");
		assert.ok(searches.length > 0);
		for (const { url } of searches) assert.equal(url.searchParams.get("countries"), null);
	});
});

test("the requester's location clause ends at its place, never consuming the mentor request (Codex, company.ts:434)", () => {
	for (const [query, iso] of [
		["I am based in India searching for product managers in Canada", ""],
		["I am based in India hunting for a design mentor in Canada", ""],
		["I'm in India seeking mentors from Canada", ""],
		["I live in India looking for PMs in the UK", ""],
		["I'm based in India want a mentor in Canada", ""],
		["I'm based in India need a mentor in Canada", ""],
		["I'm based in the UK; mentors in Canada", ""],
		["I'm based in New York searching for designers in Canada", ""],
		["Based in India, searching for mentors in Canada", "CA"],
		["I am based in India searching for product managers", ""],
		["I'm searching for designers in Canada", ""],
		["I'm based in India product managers in Canada", ""],
		["I am based in India searching for product managers at Google in Canada", ""],
		["I'm hunting for PMs in the UK", ""],
		["I'm after a PM in Canada", ""],
	]) {
		assert.equal(countryIntentIn(query), iso, query);
	}
	for (const query of [
		"I am based in India searching for Alice Visible",
		"I'm in India hunting Alice Visible",
		"I live in New York, find Alice Visible",
	]) {
		// The name read for the lookup is the mentor's, never the place.
		assert.equal(literalNameCandidate(withoutPlaces(query)), "Alice Visible", query);
	}
	assert.deepEqual(companyCandidates("I am based in India searching for product managers at Google"), ["Google"]);
	assert.deepEqual(companyCandidates("I am at Stripe hunting for PMs at Google"), ["Google"]);
});

test("a place does not disable the literal-name lookup; the mentor country filters it (Greptile, tools.ts:176)", async () => {
	assert.match(withoutPlaces("Find Alice Visible in Singapore"), /Alice Visible/);
	assert.doesNotMatch(withoutPlaces("Find Alice Visible in Singapore"), /Singapore/);
	assert.doesNotMatch(withoutPlaces("Product designers in New York"), /New York/);
	assert.doesNotMatch(withoutPlaces("Jordan Lee from Hong Kong"), /Hong Kong/);
	assert.doesNotMatch(withoutPlaces("I'm based in India, find Alice Visible"), /India/);

	const calls = [];
	await withFetch(fakeUpstream({ calls }), async () => {
		// The name lookup uses only explicit filters: a place read from the
		// query never filters it.
		for (const query of ["Find Alice Visible in Singapore", "Find Alice Visible in Canada"]) {
			calls.length = 0;
			const found = await callTool("search_mentors", { query });
			assertPublicOutputClean(found);
			assert.deepEqual(mentorsOf(found.body).map((mentor) => mentor.slug), ["alice-visible"], query);
			const nameSearch = calls.find(({ url }) => url.pathname === "/search");
			assert.equal(nameSearch.url.searchParams.get("q"), "Alice Visible", query);
			assert.equal(nameSearch.url.searchParams.get("countries"), null, query);
		}

		// An explicit `country` still filters it, slug guess included.
		calls.length = 0;
		const elsewhere = await callTool("search_mentors", { query: "Find Alice Visible", country: "CA" });
		assert.ok(!mentorsOf(elsewhere.body).some((mentor) => mentor.slug === "alice-visible"));
		const searches = calls.filter(({ url }) => url.pathname === "/search");
		assert.equal(searches[0].url.searchParams.get("q"), "Alice Visible");
		assert.equal(searches[0].url.searchParams.get("countries"), "CA");
		assert.ok(!calls.some(({ url }) => url.pathname.endsWith("/mentor/alice-visible")));

		// A place alone is still never a name.
		calls.length = 0;
		await callTool("search_mentors", { query: "Product designers in New York" });
		assert.ok(!calls.some(({ url }) => url.searchParams.get("q") === "New York"));
		assert.ok(!calls.some(({ url }) => url.pathname.endsWith("/mentor/new-york")));
	});
});

test("US phrases without a preposition keep the US filter only as PLACE-based, negations excluded (Greptile, tools.ts:143)", async () => {
	for (const query of [
		"US-based product managers",
		"USA based designers",
		"usa-based designers",
		"U.S.-based mentors",
		"United States based PMs",
	]) {
		assert.equal(countryIntentIn(query), "US", query);
	}
	for (const query of [
		// Not stated directly as "US-based mentors" or "mentors in the US".
		"US product managers",
		"American mentors",
		"American product designers",
		"mentors who are US-based",
		"non-US product managers",
		"mentors who are not US-based",
		"not US-based designers",
		"Latin American mentors",
		"North American designers",
		"help us find designers",
		"mentors at US Bank",
		"American Express designers",
		"I'm US-based, looking for PMs",
	]) {
		assert.equal(countryIntentIn(query), "", query);
	}
	// A preposition place still wins over a US phrase.
	assert.equal(countryIntentIn("US-based company, mentors in Canada"), "CA");
	const calls = [];
	await withFetch(fakeUpstream({ calls }), async () => {
		for (const [query, iso] of [
			["US-based product managers", "US"],
			["non-US product managers", null],
		]) {
			calls.length = 0;
			await callTool("search_mentors", { query });
			const searches = calls.filter(({ url }) => url.pathname === "/search");
			assert.ok(searches.length > 0, query);
			for (const { url } of searches) assert.equal(url.searchParams.get("countries"), iso, query);
		}
	});
});

// An inferred country filters the full search (the last one) and no search
// carries any other; a name lookup before it uses explicit filters only, so it
// may carry none. "" or null: no search carries a country.
function assertInferredCountry(searches, expected, query) {
	const iso = expected || null;
	for (const { url } of searches) assert.ok([iso, null].includes(url.searchParams.get("countries")), query);
	assert.equal(searches[searches.length - 1].url.searchParams.get("countries"), iso, query);
}

test("US phrases need PLACE-based; a city never hides them; any requester clause means no country (Codex P2s)", async () => {
	for (const [query, iso] of [
		// A bare "US"/"American" before the role is not stated directly.
		["US software engineers", ""],
		["US data scientists", ""],
		["US senior product managers", ""],
		["US Senior Product Managers", ""],
		["American senior software engineers", ""],
		// A city or region resolves to no country, so the US phrase still holds.
		["US-based product managers in New York", "US"],
		["US data scientists in Silicon Valley", ""],
		// "US-based company" names no sought noun; "mentors in Canada" does.
		["US-based company, mentors in Canada", "CA"],
		// Any first-person clause: no country.
		["I am a senior product designer currently based in India and want a mentor in Canada", ""],
		["I'm a mid level product designer working remotely from India, need a mentor in Canada", ""],
		["I am a senior product designer currently based in India and want a design mentor", ""],
		// Employers and clause words never become a US filter.
		["mentors at US Bank", ""],
		["American Express designers", ""],
		["American Express senior designers", ""],
		["US and Canada mentors", ""],
		["non-US senior product managers", ""],
		["product managers in New York", ""],
	]) {
		assert.equal(countryIntentIn(query), iso, query);
	}
	const calls = [];
	await withFetch(fakeUpstream({ calls }), async () => {
		for (const [query, iso] of [
			["US senior product managers", ""],
			["US-based product managers in New York", "US"],
			["I am a senior product designer currently based in India and want a mentor in Canada", ""],
		]) {
			calls.length = 0;
			await callTool("search_mentors", { query });
			const searches = calls.filter(({ url }) => url.pathname === "/search");
			assert.ok(searches.length > 0, query);
			assertInferredCountry(searches, iso, query);
		}
	});
});

test("US-named employers in any case, a requester who is a mentor, and spaced places (Codex P2s)", async () => {
	for (const [query, iso] of [
		// Employers holding a US name are never a US filter, whatever the case.
		["american express designers", ""],
		["AMERICAN EXPRESS designers", ""],
		["US bank designers", ""],
		["U.S. Bank product managers", ""],
		["Bank of America designers", ""],
		["bank of america designers", ""],
		["USAA engineers", ""],
		// A US phrase beside such an employer still counts.
		["US-based designers at American Express", "US"],
		// …unless the query holds any negation.
		["American designers, not at Bank of America", ""],
		// Any first-person self-reference: no country, even with a wanted place.
		["I am a mentor in India and want a mentor in Canada", ""],
		["I'm a design mentor based in India, looking for mentors in the UK", ""],
		["I am a mentor in India and want a design mentor", ""],
		["I'm looking for mentors in Canada", ""],
		["I'm keen on mentors in Canada", ""],
	]) {
		assert.equal(countryIntentIn(query), iso, query);
	}

	// Place spans cover the place as written, extra spaces included.
	assert.equal(withoutPlaces("Find Alice Visible in New   York"), "Find Alice Visible  | ");
	assert.equal(withoutPlaces("Alice Visible in New   York who designs"), "Alice Visible  |  who designs");
	assert.equal(withoutPlaces("designers from  the   UK, please"), "designers  | , please");
	assert.equal(withoutPlaces("Jordan Lee from Hong\tKong who designs"), "Jordan Lee  |  who designs");

	const calls = [];
	await withFetch(fakeUpstream({ calls }), async () => {
		for (const [query, iso] of [
			["american express designers", null],
			["I am a mentor in India and want a mentor in Canada", ""],
		]) {
			calls.length = 0;
			await callTool("search_mentors", { query });
			const searches = calls.filter(({ url }) => url.pathname === "/search");
			assert.ok(searches.length > 0, query);
			assertInferredCountry(searches, iso, query);
		}
	});
});

test("verify-public-fields: statistics never match unrelated page numbers; secret docs are cited (Greptile P2s)", () => {
	// reviewStats says 30 reviews at 4.6; the bio's 31 projects and 4.9 GPA
	// must not approve total_reviews: 31 or average_rating: 4.9.
	const nextData = { props: { pageProps: { mentor: { reviewStats: { avg: 4.6, count: 30 } } } } };
	const page = pageTexts(`<p>Led 31 projects. 4.9 GPA.</p>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`);
	assert.equal(checkField("total_reviews", 31, page), "missing");
	assert.equal(checkField("average_rating", 4.9, page), "missing");
	assert.equal(checkField("total_reviews", 30, page), "embedded");
	assert.equal(checkField("average_rating", 4.6, page), "embedded");

	// The code that needs IDENTITY_INTERNAL_API_KEY points at setup sections that exist.
	const visibilitySource = readFileSync(new URL("../src/public/visibility.ts", import.meta.url), "utf8");
	for (const heading of ["Required Worker configuration", "Public tier preview"]) {
		assert.ok(visibilitySource.includes(`"${heading}"`), heading);
		assert.match(readmeSource, new RegExp(`^### ${heading}$`, "m"), heading);
	}
	assert.match(visibilitySource, /docs\/public-mcp\.md "Visibility"/);
	assert.match(publicDocsSource, /^## Visibility$/m);
	assert.match(readmeSource, /### Required Worker configuration[\s\S]*IDENTITY_INTERNAL_API_KEY[\s\S]*### Public no-login tier/);
});

test("dotted abbreviations (U.S., U.S.A., U.K.) read like US/USA/UK in requester clauses and US phrases (Codex)", async () => {
	for (const [query, iso] of [
		// The requester's own location, dotted, is never the mentor country.
		["I'm U.S.-based, looking for PMs", ""],
		["I'm U.S. based, looking for PMs", ""],
		["I am U.S.A.-based and want a design mentor", ""],
		["I'm based in the U.S. and want a design mentor", ""],
		["Based in the U.S., need a PM mentor", ""],
		["I'm from U.S. looking for a design mentor", ""],
		["I'm a PM at Stripe in the U.S. and need a design mentor", ""],
		// Any first-person self-reference: no country, even with a wanted place.
		// Without a subject, "PM mentor in Canada" is stated directly.
		["I'm based in the U.S. and want a mentor in Canada", ""],
		["I'm based in the U.S., want a mentor in Canada", ""],
		["Based in the U.S., need a PM mentor in Canada", "CA"],
		["I live in the U.K. and need mentors in Canada", ""],
		["I'm in the U.S.A. looking for mentors in the U.K.", ""],
		["I'm U.S.-based and want a mentor in the U.K.", ""],
		// A dotted place after a preposition is a country.
		["mentors in the U.S.", "US"],
		["mentors in the U.K.", "GB"],
		["mentors in U.K.", "GB"],
		["PMs based in the U.S.A.", "US"],
		["designers from the U.K. who design", "GB"],
		// Dotted US phrases (PLACE-based only), employers and negations.
		["U.S. product managers", ""],
		["U.S.A. based designers", "US"],
		["U.S.A.-based designers", "US"],
		["non-U.S. product managers", ""],
		["not U.S.-based designers", ""],
		["U.S. Bank product managers", ""],
		// An abbreviation's dots end no negated clause.
		["not U.K. or U.S. based mentors", ""],
		["mentors not in the U.K. or U.S.", ""],
	]) {
		assert.equal(countryIntentIn(query), iso, query);
	}
	// A dotted requester employer stays the requester's.
	assert.deepEqual(companyCandidates("I worked at U.S. Bank, looking for PMs at Google"), ["Google"]);
	// The requester's dotted location never becomes the name looked up.
	const text = withoutPlaces("I'm based in the U.S. searching for Alice Visible");
	assert.equal(literalNameCandidate(text), "Alice Visible");
	assert.doesNotMatch(text, /U\.S/);

	const calls = [];
	await withFetch(fakeUpstream({ calls }), async () => {
		for (const [query, iso] of [
			["I'm U.S.-based, looking for PMs", null],
			["I'm based in the U.S. and want a mentor in Canada", ""],
			["mentors in the U.K.", "GB"],
		]) {
			calls.length = 0;
			await callTool("search_mentors", { query });
			const searches = calls.filter(({ url }) => url.pathname === "/search");
			assert.ok(searches.length > 0, query);
			assertInferredCountry(searches, iso, query);
		}
	});
});

test("country inference: any self-reference or negation is none; otherwise only a directly stated country (Codex, general rule)", async () => {
	// [query, mentor country]. Every case from prior rounds, under the current policy.
	const cases = [
		// Prior rounds: prepositional places.
		["I am based in India and want a design mentor in Canada", ""],
		["I’m based in India, want a mentor in Canada", ""],
		["I'm in India, looking for mentors from Canada", ""],
		["I'm a designer in London looking for a PM in the US", ""],
		["We live in Singapore and need mentors in the UK", ""],
		["Based in India, need a PM mentor in Canada", "CA"],
		["mentors in Canada, I'm in India", ""],
		["I'm looking for mentors in Canada", ""],
		["I'm keen on PMs in Canada", ""],
		["I am based in India and want a design mentor", ""],
		["I live in India, need a PM mentor", ""],
		["I'm from Canada looking for a design mentor", ""],
		["I'm a PM at Stripe in Canada and need a design mentor", ""],
		["I am based in India searching for product managers in Canada", ""],
		["I am based in India hunting for a design mentor in Canada", ""],
		["I'm in India seeking mentors from Canada", ""],
		["I live in India looking for PMs in the UK", ""],
		["I'm based in India want a mentor in Canada", ""],
		["I'm based in India need a mentor in Canada", ""],
		["I'm based in the UK; mentors in Canada", ""],
		["I'm based in New York searching for designers in Canada", ""],
		["I'm based in India product managers in Canada", ""],
		["Based in India, searching for mentors in Canada", "CA"],
		["I am based in India searching for product managers", ""],
		["I am based in India searching for product managers at Google in Canada", ""],
		["I'm searching for designers in Canada", ""],
		["I'm hunting for PMs in the UK", ""],
		["I'm after a PM in Canada", ""],
		["I am a senior product designer currently based in India and want a mentor in Canada", ""],
		["I'm a mid level product designer working remotely from India, need a mentor in Canada", ""],
		["I am a senior product designer currently based in India and want a design mentor", ""],
		["I am a mentor in India and want a mentor in Canada", ""],
		["I'm a design mentor based in India, looking for mentors in the UK", ""],
		["I am a mentor in India and want a design mentor", ""],
		["I'm keen on mentors in Canada", ""],
		// Prior rounds: US phrases and dotted abbreviations.
		["I'm US-based, looking for PMs", ""],
		["I'm U.S.-based, looking for PMs", ""],
		["I'm U.S. based, looking for PMs", ""],
		["I am U.S.A.-based and want a design mentor", ""],
		["I'm based in the U.S. and want a design mentor", ""],
		["Based in the U.S., need a PM mentor", ""],
		["I'm from U.S. looking for a design mentor", ""],
		["I'm a PM at Stripe in the U.S. and need a design mentor", ""],
		["I'm based in the U.S. and want a mentor in Canada", ""],
		["I'm based in the U.S., want a mentor in Canada", ""],
		["Based in the U.S., need a PM mentor in Canada", "CA"],
		["I live in the U.K. and need mentors in Canada", ""],
		["I'm in the U.S.A. looking for mentors in the U.K.", ""],
		["I'm U.S.-based and want a mentor in the U.K.", ""],
		// Demonyms and bare US phrases.
		["I'm American and want a mentor in Canada", ""],
		["I'm an American designer looking for mentors", ""],
		["Im an American PM, need a design mentor", ""],
		["I'm a US product manager looking for a mentor", ""],
		["I'm currently a U.S. based designer, want a mentor in the U.K.", ""],
		["my company is American, looking for PMs", ""],
		// Other subjects, boundaries and abbreviation sentence ends.
		["I work in Germany and need mentors in Canada", ""],
		["I work remotely from India, need a mentor", ""],
		["I'm currently based in Germany — mentors in Canada", ""],
		["I'm in Germany - mentors in Canada", ""],
		["I live in the U.K. I need mentors in Canada", ""],
		["I live in the U.K. Mentors in Canada", ""],
		["I'm in India to find a mentor in Canada", ""],
		["I'm based in India for a mentor in Canada", ""],
		["I'm based in India, who can mentor me from Canada", ""],
		["I am a designer in India but want a mentor in Japan", ""],
		["I'm in India at a startup in Berlin, need a mentor", ""],
		["I'm based in India senior PMs in Canada", ""],
		["We're in Brazil, seeking mentors in Mexico", ""],
		["I moved to Canada from India and need a mentor", ""],
		["I'm from the U.S.A., want mentors in Japan", ""],
		["Currently based in India, need a mentor", ""],
		// "my"/"our" is a self-reference, even about the mentor sought.
		["My home is in India; mentors in Canada", ""],
		["my team is in Singapore and needs PMs in the UK", ""],
		["mentors in Japan for my team in India", ""],
		["My ideal mentor is in Canada", ""],
		// "Based in Canada" before a role is not "Canada-based designers".
		["Based in Canada product designers", ""],
		// Prior rounds: plain places, employers named after places, and codes.
		["mentors from Canada", "CA"],
		["designers in India", "IN"],
		["PM based in UK", "GB"],
		["mentors in the UK", "GB"],
		["mentors from Canada who work at Google", "CA"],
		["mentors from Canada, ideally designers", "CA"],
		["mentors in the UK at Google", "GB"],
		["designers from Canada Life in Singapore", ""],
		["knowledgeable mentors from Canada", "CA"],
		["designers in UK.", "GB"],
		["mentors from New York", ""],
		["mentors from Canada Life", ""],
		["mentors at Canada Life", ""],
		["mentors in IT", ""],
		["mentors in IT.", ""],
		["mentors in HR.", ""],
		["mentors in IT, please", ""],
		["PM from AI startups", ""],
		["mentors near us", ""],
		["help us find designers", ""],
		// Prior rounds: US phrases.
		["US-based product managers", "US"],
		["USA based designers", "US"],
		["usa-based designers", "US"],
		["U.S.-based mentors", "US"],
		["United States based PMs", "US"],
		["US product managers", ""],
		["American mentors", ""],
		["mentors who are US-based", ""],
		["US senior product managers", ""],
		["US-based product managers in New York", "US"],
		["US-based company, mentors in Canada", "CA"],
		["US-based designers at American Express", "US"],
		["U.S. product managers", ""],
		["U.S.A.-based designers", "US"],
		["mentors in the U.S.", "US"],
		["designers from the U.K. who design", "GB"],
		["Latin American mentors", ""],
		["North American designers", ""],
		["US and Canada mentors", ""],
		["American Express designers", ""],
		["bank of america designers", ""],
		["U.S. Bank product managers", ""],
		// Prior rounds: negations.
		["mentors not based in US", ""],
		["mentors not based in the UK", ""],
		["designers anywhere except in Canada", ""],
		["PMs, excluding those from India", ""],
		["mentors who are not from Canada", ""],
		...NEGATED_PLACE_QUERIES.map((query) => [query, ""]),
		...NEGATED_US_QUERIES.map((query) => [query, ""]),
		["non-US product managers", ""],
		["mentors who are not US-based", ""],
		["not US-based designers", ""],
		["non-U.S. product managers", ""],
		["not U.S.-based designers", ""],
		["not U.K. or U.S. based mentors", ""],
		["mentors not in the U.K. or U.S.", ""],
		["non-US senior product managers", ""],
		// Any negation anywhere means no country, whatever it governs.
		["I am not looking for mentors in Canada", ""],
		["I am not looking for US-based mentors", ""],
		["I'm not in Canada, looking for mentors in Canada", ""],
		["not a PM, mentors from Canada", ""],
		["mentors who can’t wait, from Canada", ""],
		["American designers, not at Bank of America", ""],
		["I never want mentors from Canada", ""],
		["mentors in Canada without a PhD", ""],
		["mentors from Canada, no recruiters", ""],
		["I'd like anyone other than mentors in Canada", ""],
		["designers outside Google in Canada", ""],
		["mentors in Canada except at Shopify", ""],
		["I cannot find mentors in Canada", ""],
		["non-technical mentors in Canada", ""],
		// Any first-person pronoun anywhere means no country, "I want"/"I need" included.
		["I need mentors; I'm a mentor in India", ""],
		["I want a mentor, I'm a designer in India", ""],
		["I need a mentor and I work with PMs in India", ""],
		["I am a mentor in India", ""],
		["I want mentors and I'm a PM in Canada", ""],
		["I want a mentor in Canada for my team in India", ""],
		["I want a mentor in Canada like me", ""],
		["I want US-based product managers", ""],
		["I'm in India, need U.S.-based designers", ""],
		["I'm looking for PMs from the U.K.", ""],
		["I'm looking for someone located in Canada", ""],
		["I'm looking for a mentor based in Canada", ""],
		["I'm looking for a mentor who lives in Canada", ""],
		["I'm looking for mentors living in Canada", ""],
		["I'm looking for American mentors", ""],
		["I want mentors in Canada or PMs in the UK", ""],
		["I'm looking for a coach in New York", ""],
		// "me"/"us" as an object is no self-reference.
		["help me find mentors in Canada", "CA"],
		["Find me mentors in Canada", "CA"],
		["Find me US-based product managers", "US"],
		["Show me designers from the UK", "GB"],
		["Get me PMs in Canada", "CA"],
		["I want US product managers", ""],
		["I need mentors in Canada", ""],
		["I'm looking for US product managers", ""],
		["I am searching for designers in the UK", ""],
		["We want mentors in Canada", ""],
		// A self-reference anywhere: no country.
		["I'm a designer, find me mentors in Canada", ""],
		["I'm in India, find me US product managers", ""],
		["I live in India, show me PMs in Canada", ""],
		["my team wants US product managers", ""],
		["I'm a designer looking for mentors in Canada", ""],
	];
	for (const [query, iso] of cases) assert.equal(countryIntentIn(query), iso, query);

	// The requester's place never becomes the name looked up either.
	for (const query of [
		"I am based in India searching for Alice Visible",
		"I'm in India hunting Alice Visible",
		"I live in New York, find Alice Visible",
		"I'm based in the U.S. searching for Alice Visible",
		"I work in Germany, find Alice Visible",
	]) {
		assert.equal(literalNameCandidate(withoutPlaces(query)), "Alice Visible", query);
	}

	const calls = [];
	await withFetch(fakeUpstream({ calls }), async () => {
		for (const [query, iso] of [
			["I'm an American designer looking for mentors", null],
			["I'm American and want a mentor in Canada", ""],
			["I work in Germany and need mentors in Canada", ""],
			["I am not looking for mentors in Canada", null],
			["I am not looking for US-based mentors", null],
			// Controls: a directly stated country still filters the search.
			["mentors in Canada", "CA"],
			["Find me US-based product managers", "US"],
		]) {
			calls.length = 0;
			await callTool("search_mentors", { query });
			const searches = calls.filter(({ url }) => url.pathname === "/search");
			assert.ok(searches.length > 0, query);
			assertInferredCountry(searches, iso, query);
		}
	});
});

test("country inference: any first-person pronoun anywhere means no country; 'me' does not (Codex P1, company.ts:485)", () => {
	const cases = [
		["I was a mentor in Canada, looking for designers", ""],
		["I moved to India, looking for mentors in Canada", ""],
		["I've lived in India; need mentors in Canada", ""],
		["I'd like mentors in Canada", ""],
		["I'll take mentors in Canada", ""],
		["Mentors in Canada for myself", ""],
		["mentors in Canada please, my background is design", ""],
		["i need mentors in Canada", ""],
		["Im after mentors in Canada", ""],
		["find me mentors in Canada", "CA"],
		["mentors in Canada", "CA"],
	];
	for (const [query, country] of cases) assert.equal(countryIntentIn(query), country, query);
});

test("country inference: 'mine', 'we', 'our(s)', lowercase 'us', and nobody/none/neither/avoid mean no country; the country US still reads (Codex)", () => {
	const cases = [
		["mentors in Canada with a background like mine", ""],
		["we need mentors in Canada", ""],
		["we're hiring, mentors in Canada", ""],
		["mentors in Canada for our team", ""],
		["mentors in Canada with a path like ours", ""],
		["help us find mentors in Canada", ""],
		["mentors in Canada, nobody from Google", ""],
		["mentors in Canada, none at startups", ""],
		["mentors in Canada, nothing junior", ""],
		["mentors in Canada, neither PMs nor engineers", ""],
		["mentors in Canada, avoid Google", ""],
		["mentors in Canada, Google excluded", ""],
		["US-based mentors", "US"],
		["mentors in the US", "US"],
		["mentors from US", "US"],
	];
	for (const [query, country] of cases) assert.equal(countryIntentIn(query), country, query);
});

test("requester employment is stripped even when a capitalized title follows the subject (Codex P1, company.ts:213)", () => {
	for (const query of [
		"I am Senior Designer at Google, looking for a PM",
		"I'm Senior Designer at Google, looking for a PM",
		"I'm Designer at Google, looking for a PM",
	]) {
		assert.deepEqual(requestedRoleFamilies(query), ["product"], query);
	}
});

test("a self-reference query reads a name only right after a request verb that follows it (Greptile P1, tools.ts:186)", async () => {
	for (const [query, clause] of [
		["I'm based in India, find Alice Visible", "Alice Visible"],
		["I’m in India. Can you look up Alice Visible in Singapore?", "Alice Visible in Singapore"],
		["We're hiring; search for Alice Visible, thanks", "Alice Visible"],
		["I'm Alice Visible, show me Bob Visible for my team", "Bob Visible for"],
		["I'm Alice Visible, is there Bob Visible on ADPList", "Bob Visible on ADPList"],
		// The capitalized name after the verb is taken verbatim, self-reference
		// words included (Codex P1, company.ts:568).
		["I'm based in India, find My Nguyen", "My Nguyen"],
		["I'm in India, find Im Soo Jung", "Im Soo Jung"],
		["I'm in India, find My Nguyen for my team", "My Nguyen for"],
		["I'm in India, find my mentor", ""],
		// No request verb after the self-reference: nothing is read as a name.
		["I'm Alice Visible in Singapore, looking for a design mentor", ""],
		["I am Alice Visible and need a design mentor", ""],
		["My name is Alice Visible. Looking for a design mentor", ""],
		["Find Alice Visible, I'm in India", ""],
		["design mentors in Canada", ""],
	]) {
		assert.equal(requestedAfterSelfReference(query), clause, query);
	}

	const mentors = {
		"yogeshree-tawde": ["Yogeshree Tawde", "Product", "Google", ["Product Management"], ["Product Strategy"]],
		"dana-design": ["Dana Design", "Senior Product Designer", "Acme Labs", ["Product Design"], ["Mobile Apps"]],
		"dev-design": ["Dev Design", "Design Lead", "Acme Labs", ["Product Design"], ["Design Systems"]],
	};
	const introductions = [
		["I'm Yogeshree Tawde in the US, looking for a design mentor", "yogeshree-tawde", "Yogeshree Tawde"],
		["I’m Alice Visible in Singapore, looking for a design mentor", "alice-visible", "Alice Visible"],
		["I am Alice Visible and need a design mentor", "alice-visible", "Alice Visible"],
		["I'm in India, find a design mentor named Alice Visible", "alice-visible", "Alice Visible"],
	];
	const search = {
		...DEFAULT_SEARCH,
		"Yogeshree Tawde": ["yogeshree-tawde"],
		...Object.fromEntries(
			introductions.map(([query, requester]) => [query, ["dana-design", requester, "dev-design", "yogeshree-tawde"]]),
		),
	};
	// The requester's own name is never looked up: the full query is searched
	// as a design request, so design mentors come back, never nothing.
	for (const [query, requester, name] of introductions) {
		const calls = [];
		await withRoleMentors(mentors, () =>
			withFetch(fakeUpstream({ search, calls }), async () => {
				const result = await callTool("search_mentors", { query });
				assertPublicOutputClean(result);
				const slugs = mentorsOf(result.body).map((mentor) => mentor.slug);
				assert.ok(slugs.includes("dana-design") && slugs.includes("dev-design"), query);
				assert.ok(!slugs.includes("yogeshree-tawde"), query);
				const searches = calls.filter(({ url }) => url.pathname === "/search");
				assert.ok(searches.length > 0, query);
				for (const { url } of searches) {
					assert.equal(url.searchParams.get("q"), query, query);
					// The requester's place is not a mentor-country filter.
					assert.equal(url.searchParams.get("countries"), null, query);
				}
				assert.ok(!searches.some(({ url }) => url.searchParams.get("q") === name), query);
			}),
		);
	}

	// A name right after a request verb that follows the self-reference is
	// looked up.
	for (const query of ["I'm based in India, find Alice Visible", "I’m in India. Can you look up Alice Visible in Singapore?"]) {
		const calls = [];
		await withFetch(fakeUpstream({ calls }), async () => {
			const result = await callTool("search_mentors", { query });
			assertPublicOutputClean(result);
			assert.deepEqual(mentorsOf(result.body).map((mentor) => mentor.slug), ["alice-visible"], query);
			const first = calls.find(({ url }) => url.pathname === "/search");
			assert.equal(first.url.searchParams.get("q"), "Alice Visible", query);
			assert.equal(first.url.searchParams.get("countries"), null, query);
		});
	}

	// Name-only queries keep the literal path, self-reference words and all.
	const names = {
		...mentors,
		"my-nguyen": ["My Nguyen", "Senior Product Designer", "Acme Labs", ["Product Design"], ["Mobile Apps"]],
		"im-soo-jung": ["Im Soo Jung", "Senior Product Designer", "Acme Labs", ["Product Design"], ["Mobile Apps"]],
		"meta-patel": ["Meta Patel", "Senior Product Designer", "Acme Labs", ["Product Design"], ["Mobile Apps"]],
	};
	const nameSearch = {
		...search,
		"My Nguyen": ["my-nguyen"],
		"Im Soo Jung": ["im-soo-jung"],
		"Meta Patel": ["meta-patel"],
	};
	for (const [query, slug] of [
		["Yogeshree Tawde", "yogeshree-tawde"],
		["My Nguyen", "my-nguyen"],
		["Im Soo Jung", "im-soo-jung"],
		["Meta Patel", "meta-patel"],
	]) {
		const calls = [];
		await withRoleMentors(names, () =>
			withFetch(fakeUpstream({ search: nameSearch, calls }), async () => {
				const result = await callTool("search_mentors", { query });
				assert.deepEqual(mentorsOf(result.body).map((mentor) => mentor.slug), [slug], query);
				const searches = calls.filter(({ url }) => url.pathname === "/search");
				assert.deepEqual(searches.map(({ url }) => url.searchParams.get("q")), [query], query);
			}),
		);
	}

	// Such a name after a request verb in a self-reference query is looked up
	// whole.
	for (const [query, name, slug] of [
		["I'm based in India, find My Nguyen", "My Nguyen", "my-nguyen"],
		["I'm in India, find Im Soo Jung", "Im Soo Jung", "im-soo-jung"],
	]) {
		const calls = [];
		await withRoleMentors(names, () =>
			withFetch(fakeUpstream({ search: nameSearch, calls }), async () => {
				const result = await callTool("search_mentors", { query });
				assert.deepEqual(mentorsOf(result.body).map((mentor) => mentor.slug), [slug], query);
				const first = calls.find(({ url }) => url.pathname === "/search");
				assert.equal(first.url.searchParams.get("q"), name, query);
				assert.equal(first.url.searchParams.get("countries"), null, query);
			}),
		);
	}
});

test("US-based product managers sends countries=US on every search (Greptile, tools.ts:143)", async () => {
	const query = "US-based product managers";
	assert.equal(countryIntentIn(query), "US");
	const calls = [];
	await withFetch(fakeUpstream({ calls }), async () => {
		await callTool("search_mentors", { query });
	});
	const searches = calls.filter(({ url }) => url.pathname === "/search");
	assert.ok(searches.length > 0);
	assert.ok(searches.some(({ url }) => url.searchParams.get("q") === query));
	for (const { url } of searches) assert.equal(url.searchParams.get("countries"), "US");
});

test("a self-reference query keeps its company and role: the full query is parsed (Greptile P1)", async () => {
	const query = "I'm after a product manager at Google, ideally for interview prep";
	assert.equal(knownCompanyIn(query), "Google");
	assert.deepEqual(requestedRoleFamilies(query, "Google"), ["product"]);
	assert.equal(requestedAfterSelfReference(query), "");

	const mentors = {
		"pia-google": ["Pia Google", "Senior Product Manager", "Google", ["Product Management"], ["Interview Prep"]],
		"dee-google": ["Dee Google", "Product Designer", "Google", ["Product Design"], ["Mobile Apps"]],
		"pat-acme": ["Pat Acme", "Product Manager", "Acme Labs", ["Product Management"], ["Interview Prep"]],
	};
	const rows = ["pia-google", "dee-google", "pat-acme"];
	const calls = [];
	await withRoleMentors(mentors, () =>
		withFetch(fakeUpstream({ search: { ...DEFAULT_SEARCH, Google: rows, [query]: rows }, calls }), async () => {
			const result = await callTool("search_mentors", { query });
			assertPublicOutputClean(result);
			assert.deepEqual(mentorsOf(result.body).map((mentor) => mentor.slug), ["pia-google"]);
		}),
	);
	const searches = calls.filter(({ url }) => url.pathname === "/search");
	assert.ok(searches.some(({ url }) => url.searchParams.get("q") === query));
});

test("the requester's own role is never a requested role; search and company text keep the full query (Codex P1, role.ts:91)", async () => {
	for (const [query, families] of [
		["I'm a software engineer, looking for a design mentor", ["design"]],
		["I’m a software engineer looking for a design mentor", ["design"]],
		["I am a data scientist and need a PM mentor", ["product"]],
		["As a product designer, I want an engineering mentor", ["engineering"]],
		["I work as a marketer, seeking a data mentor", ["data"]],
		["Im currently a frontend developer who wants a UX mentor", ["design"]],
	]) {
		assert.deepEqual(requestedRoleFamilies(query), families, query);
	}
	// A request word right after the subject is no self-description.
	assert.deepEqual(requestedRoleFamilies("I'm after a product manager at Google", "Google"), ["product"]);
	assert.deepEqual(requestedRoleFamilies("I'm looking for a software engineer"), ["engineering"]);
	assert.deepEqual(requestedRoleFamilies("I am Senior Designer at Google, looking for a PM"), ["product"]);

	const query = "I'm a software engineer, looking for a design mentor";
	const mentors = {
		"dana-design": ["Dana Design", "Senior Product Designer", "Acme Labs", ["Product Design"], ["Mobile Apps"]],
		"sam-engineer": ["Sam Engineer", "Senior Software Engineer", "Acme Labs", ["Software Engineering"], ["Backend"]],
	};
	const rows = ["sam-engineer", "dana-design"];
	const calls = [];
	await withRoleMentors(mentors, () =>
		withFetch(fakeUpstream({ search: { ...DEFAULT_SEARCH, [query]: rows }, calls }), async () => {
			const result = await callTool("search_mentors", { query });
			assertPublicOutputClean(result);
			assert.deepEqual(mentorsOf(result.body).map((mentor) => mentor.slug), ["dana-design"]);
		}),
	);
	const searches = calls.filter(({ url }) => url.pathname === "/search");
	assert.ok(searches.some(({ url }) => url.searchParams.get("q") === query));
});
