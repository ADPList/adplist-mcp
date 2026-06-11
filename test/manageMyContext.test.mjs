import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { adplistProfileToSearchText, fetchAdplistProfileText } from "../src/profile.ts";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const profileSource = readFileSync(new URL("../src/profile.ts", import.meta.url), "utf8");
const searchSource = readFileSync(new URL("../src/searchMentors.ts", import.meta.url), "utf8");
const wranglerSource = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const migrationSource = readFileSync(
	new URL("../migrations/0001_user_mcp_profile.sql", import.meta.url),
	"utf8",
);

test("M2 registers manage_my_context with explicit-only memory instructions", () => {
	assert.match(indexSource, /registerTool\(\s*"manage_my_context"/);
	assert.match(indexSource, /explicitly asks you to remember/);
	assert.match(indexSource, /Do not proactively store/);
	assert.match(indexSource, /explicit-only memory in v1/);
	assert.match(indexSource, /\.enum\(\["read", "merge", "clear"\]\)/);
});

test("D1 profile schema is bound and migrated", () => {
	assert.match(wranglerSource, /"binding":\s*"PROFILE_DB"/);
	assert.match(wranglerSource, /"database_name":\s*"adplist-mcp-profile"/);
	assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS user_mcp_profile/);
	assert.match(migrationSource, /user_id TEXT PRIMARY KEY/);
	assert.match(migrationSource, /profile_json TEXT NOT NULL/);
	assert.match(migrationSource, /updated_at INTEGER NOT NULL/);
});

test("manage_my_context implements read, shallow merge, and clear", () => {
	assert.match(profileSource, /action === "clear"/);
	assert.match(profileSource, /DELETE FROM user_mcp_profile WHERE user_id = \?/);
	assert.match(profileSource, /action === "merge"/);
	assert.match(profileSource, /\.\.\.\(existing\?\.profile \?\? \{\}\), \.\.\.updates/);
	assert.match(profileSource, /ON CONFLICT\(user_id\) DO UPDATE/);
	assert.match(profileSource, /action !== "read"/);
});

test("search_mentors prepends stored profile context without new embeddings", () => {
	assert.match(searchSource, /getProfileTextForSearch/);
	assert.match(searchSource, /combineIntentWithProfile/);
	assert.match(profileSource, /Stored ADPList career context:/);
	assert.match(profileSource, /Current request:/);
	assert.match(profileSource, /PROFILE_TEXT_SOFT_LIMIT = 1000/);
});

test("search_mentors description nudges rich who-the-user-is intents (ADPLIST-3202)", () => {
	assert.match(indexSource, /describe who the user is from the conversation/);
	assert.match(indexSource, /not just topic keywords/);
	assert.match(indexSource, /Include who the user is \(role, seniority, situation\)/);
});

test("adplistProfileToSearchText extracts career fields from a /users/profile/me payload", () => {
	// Field shapes mirror identity-service UserSchema (Expertise.expertise,
	// Discipline.discipline, Motivation.motivation, ExperienceLevel.seniority).
	const text = adplistProfileToSearchText({
		data: {
			profile: { title: "Senior Product Manager", organization: "Finch Fintech" },
			experiences: {
				experienceLevel: { seniority: "Senior", years: 8 },
				disciplines: [{ legacyId: 1, discipline: "product management" }, "growth"],
				expertise: [{ expertise: "roadmapping" }, { expertise: "user interviews" }],
			},
			preferences: {
				motivations: [{ legacyId: 2, motivation: "transition into UX research" }],
				interests: [{ legacyId: 3, interest: "fintech" }],
			},
			country: { countryName: "Singapore" },
		},
	});
	assert.match(text, /Role: Senior Product Manager at Finch Fintech/);
	assert.match(text, /Experience level: Senior/);
	assert.match(text, /Disciplines: product management, growth/);
	assert.match(text, /Expertise: roadmapping, user interviews/);
	assert.match(text, /Goals: transition into UX research/);
	assert.match(text, /Interests: fintech/);
	assert.match(text, /Based in Singapore/);
});

test("adplistProfileToSearchText returns empty for sparse or malformed payloads", () => {
	assert.equal(adplistProfileToSearchText(undefined), "");
	assert.equal(adplistProfileToSearchText({}), "");
	assert.equal(adplistProfileToSearchText({ data: {} }), "");
	assert.equal(adplistProfileToSearchText({ data: { profile: {}, experiences: null } }), "");
	assert.equal(adplistProfileToSearchText("not an object"), "");
});

test("adplistProfileToSearchText caps the synthesized text at its limit", () => {
	const text = adplistProfileToSearchText({
		data: {
			experiences: {
				expertise: Array.from({ length: 100 }, (_, i) => `very specific expertise ${i}`),
			},
		},
	});
	assert.ok(text.length <= 600);
	assert.match(text, /…$/);
});

test("fetchAdplistProfileText fails open on errors and skips unauthenticated callers", async () => {
	const originalFetch = globalThis.fetch;
	let called = 0;
	globalThis.fetch = async () => {
		called += 1;
		throw new Error("network down");
	};
	try {
		const env = { AUTH_SERVICE_URL: "https://auth.example" };
		// no token → no call at all
		assert.equal(await fetchAdplistProfileText(env, undefined), "");
		assert.equal(called, 0);
		// network error → fail open to ""
		assert.equal(
			await fetchAdplistProfileText(env, {
				userId: "u1",
				email: null,
				scopes: [],
				cognitoAccessToken: "token",
			}),
			"",
		);
		assert.equal(called, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
