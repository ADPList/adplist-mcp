import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
