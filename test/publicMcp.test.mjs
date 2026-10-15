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
	currentEmployer,
	isCurrentEmployer,
	knownCompanyIn,
	titleMarksEmployerPast,
} from "../src/public/company.ts";
import { checkField, FIELDS, pageTexts, verifyMentor } from "../scripts/verify-public-fields.mjs";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const wranglerSource = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const previewSource = readFileSync(new URL("../wrangler.preview.jsonc", import.meta.url), "utf8");

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
const PM_SLUGS = new Set(["pia-google", "nico-google", "paul-google", "mia-meta"]);
// Company field Google; the title says whether that is current (ADPLIST-4479).
const TITLE_OVERRIDES = {
	"chris-google": "Former Director of UX",
	"dora-google": "Director of UX",
	"ezra-google": "Ex-Google PM",
	"ada-google": "Advisor | Former Director at Google",
};
const titleOf = (slug) =>
	TITLE_OVERRIDES[slug] ?? (PM_SLUGS.has(slug) ? "Senior Product Manager" : "Senior Product Designer");
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
				expertise: [
					{ legacyId: 1, expertise: "Product Strategy" },
					{ legacyId: 2, expertise: "Mobile Apps" },
				],
				disciplines: [{ legacyId: 3, discipline: "Product Design" }],
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
		title: titleOf(slug),
		employer: ROW_EMPLOYER[slug] ?? (slug.endsWith("google") ? "Google" : "Acme Labs"),
		expertise: ["Product Strategy", "Mobile Apps"],
		disciplines: ["Product Design"],
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
			return Response.json({
				results: slugs.map((slug, index) => searchRow(slug, index + 1)),
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
	const events = logs.map((line) => JSON.parse(line));
	assert.deepEqual(
		events.map((event) => event.event),
		["ai_mentor_search_query", "ai_mentor_profile_view", "ai_mentor_profile_view"],
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
	assert.equal(amplitude.length, 3);
	const sent = amplitude.map(({ init }) => JSON.parse(init.body));
	assert.equal(sent[0].events[0].device_id, "ai-mcp-claude");
	assert.equal(sent[0].events[0].event_type, "ai_mentor_search_query");
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
