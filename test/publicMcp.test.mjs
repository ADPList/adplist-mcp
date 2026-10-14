import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { handlePublicRequest, PUBLIC_TOOLS } from "../src/public/mcp.ts";
import { PUBLIC_MENTOR_KEYS, publicPhotoUrl, publicProfileUrl } from "../src/public/mapper.ts";
import { normalizeSource, parsePublicMcpPath, sourceFromClientName } from "../src/public/source.ts";
import { publicVisibilityUrl } from "../src/public/visibility.ts";
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
};

// Search rows say Google for every *-google slug; these identity records disagree.
const RECORD_COMPANY = { "left-google": "Other Company" };

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

function identityRecord(slug) {
	const override = HIDDEN_OVERRIDES[slug] ?? {};
	const company = RECORD_COMPANY[slug] ?? (slug.endsWith("google") ? "Google" : "Acme Labs");
	if (slug === "array-flags") {
		const record = identityRecord("alice-visible");
		return { data: { ...record.data, slug, fullName: NAMES[slug], is: [true, true] } };
	}
	return {
		data: {
			id: FAKE_ID,
			_id: FAKE_ID,
			legacyId: 4242,
			legacy_id: 4242,
			userId: `user-${FAKE_ID}`,
			slug,
			fullName: NAMES[slug],
			status: override.status ?? "active",
			is: {
				active: true,
				mentor: true,
				suspended: false,
				onBreak: false,
				aiSearchOptOut: false,
				verified: true,
				...override.is,
			},
			gender: "female",
			timezone: "Asia/Singapore",
			email: `${slug}@${FAKE_HOST}`,
			bio: `Bio for ${NAMES[slug]}. ${"Mentoring product teams for a decade. ".repeat(20)}`,
			profile: {
				title: "Senior Product Designer",
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
		title: "Senior Product Designer",
		employer: slug.endsWith("google") ? "Google" : "Acme Labs",
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
		const profileMatch = url.pathname.match(/^\/users\/profile\/mentor\/(.+)$/);
		if (profileMatch) {
			const slug = decodeURIComponent(profileMatch[1]);
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
			return Response.json(identityRecord(slug));
		}
		return new Response("unexpected", { status: 418 });
	};
}

function makeEnv(overrides = {}) {
	const keys = [];
	return {
		AUTH_SERVICE_URL: "https://auth.test",
		SEARCH_SERVICE_URL: "https://search.test",
		PUBLIC_OPT_OUT_SLUGS: " Denied-Mentor , other-slug",
		PUBLIC_RATE_LIMITER: {
			keys,
			async limit({ key }) {
				keys.push(key);
				return { success: true };
			},
		},
		...overrides,
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

test("search (company path) puts employer matches first and stays clean", async () => {
	await withFetch(fakeUpstream(), async () => {
		const result = await callTool("search_mentors", { query: "mentors at Google", limit: 9 });
		assertPublicOutputClean(result);
		const mentors = mentorsOf(result.body);
		assert.deepEqual(
			mentors.map((mentor) => mentor.slug),
			["gina-google", "gary-google", "bob-visible"],
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

		// A company read from the query only orders; other matches still follow.
		const implied = await callTool("search_mentors", { query: "mentors at Google", limit: 9 });
		assert.deepEqual(
			mentorsOf(implied.body).map((mentor) => mentor.slug),
			["gina-google", "left-google", "gary-google", "bob-visible"],
		);
	});
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

test("visibility fetch is always the bare record URL, never with query params", async () => {
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
	const profileCalls = calls.filter(({ url }) => url.pathname.startsWith("/users/profile/mentor/"));
	assert.ok(profileCalls.length >= 4);
	for (const { url } of profileCalls) {
		assert.equal(url.search, "", url.href);
		assert.equal(url.hash, "", url.href);
		assert.ok(!url.href.includes("syncFromLegacy=true"), url.href);
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

test("rate limit applies to tools/call only, not to initialize or tools/list", async () => {
	const env = makeEnv({ PUBLIC_RATE_LIMITER: undefined });
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
	assert.equal(events[0].result_count, 3);
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
