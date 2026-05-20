import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
