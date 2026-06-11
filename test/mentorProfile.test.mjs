import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatToolError } from "../src/errors.ts";
import {
	buildMentorProfileUrl,
	buildMentorReviewsUrl,
	buildMentorStatisticsUrl,
	getMentorProfile,
} from "../src/mentorProfile.ts";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("registers get_mentor_profile as a read-only tool with deep-dive guidance (ADPLIST-3203)", () => {
	assert.match(indexSource, /registerTool\(\s*"get_mentor_profile"/);
	assert.match(indexSource, /full public ADPList profile by slug/);
	// search_mentors points the host at the deep-dive flow
	assert.match(indexSource, /deep-diving the top 2-3 candidates with get_mentor_profile/);
	assert.match(indexSource, /do not just restate the cards/);
});

test("URL builders target the public api.adplist.org endpoints", () => {
	assert.equal(
		buildMentorProfileUrl("https://auth.example", "felix lee"),
		"https://auth.example/users/profile/mentor/felix%20lee",
	);
	const stats = new URL(buildMentorStatisticsUrl("https://auth.example", "u1"));
	assert.equal(stats.pathname, "/users/statistics");
	assert.equal(stats.searchParams.get("userId"), "u1");
	assert.equal(stats.searchParams.get("type"), "mentor");
	const reviews = new URL(buildMentorReviewsUrl("https://auth.example", "u1"));
	assert.equal(reviews.pathname, "/users/review");
	assert.equal(reviews.searchParams.get("target"), "for");
	assert.equal(reviews.searchParams.get("limit"), "5");
});

// Shapes mirror real prod responses captured 2026-06-11 (felix-lee).
const PROFILE_RESPONSE = {
	data: {
		userId: "mentor-user-1",
		fullName: "Felix Lee",
		slug: "felix-lee",
		bio: "Felix is the Co-founder & CEO of ADPList.",
		profile: { title: "Co-founder and CEO", organization: "ADPList" },
		experiences: {
			disciplines: [
				{ legacyId: 2, discipline: "UX Design" },
				{ legacyId: 14, discipline: "Product Design" },
			],
			expertise: [],
			rankedExpertise: [
				{ expertise: { legacyId: 24, expertise: "Design" }, rank: 1 },
				{ expertise: { legacyId: 30, expertise: "Leadership" }, rank: 2 },
			],
			experienceLevel: { legacyId: 32, seniority: "Founder", years: 7, months: 9 },
		},
		preferences: {
			languages: [
				{ legacyId: 1, language: "English" },
				{ legacyId: 4, language: "Mandarin Chinese" },
			],
			interests: [{ legacyId: 1, interest: "Startups" }],
		},
		country: { countryName: "United States", iso: "US" },
		is: { active: true, onBreak: false, mentor: true },
	},
};

const STATS_RESPONSE = {
	data: {
		userId: "mentor-user-1",
		reviews: { reviewsCount: 155, averageRating: 4.876623376623376 },
	},
};

const REVIEWS_RESPONSE = {
	data: {
		reviews: [
			{
				review: "It was great catching up with Felix. He gave me a different perspective.",
				rating: 5,
				createdOn: 1779394224751,
				status: "active",
				reviewedByUser: { name: "Tomilola Abiodun" },
			},
			{ review: "", rating: 4, createdOn: 1779394224751, status: "active" },
			{
				review: "Hidden review",
				rating: 1,
				createdOn: 1779394224751,
				status: "inactive",
			},
		],
	},
};

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

test("getMentorProfile maps the full public profile with stats and review snippets", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		const u = String(url);
		if (u.includes("/users/profile/mentor/")) return jsonResponse(PROFILE_RESPONSE);
		if (u.includes("/users/statistics")) return jsonResponse(STATS_RESPONSE);
		if (u.includes("/users/review")) return jsonResponse(REVIEWS_RESPONSE);
		throw new Error(`unexpected fetch ${u}`);
	};

	try {
		const result = await getMentorProfile(
			{ AUTH_SERVICE_URL: "https://auth.example" },
			{ mentor_slug: "felix-lee" },
		);
		assert.equal(result.name, "Felix Lee");
		assert.equal(result.title, "Co-founder and CEO");
		assert.equal(result.employer, "ADPList");
		assert.equal(result.country, "United States");
		// rankedExpertise fallback when expertise[] is empty
		assert.deepEqual(result.expertise, ["Design", "Leadership"]);
		assert.deepEqual(result.disciplines, ["UX Design", "Product Design"]);
		assert.deepEqual(result.languages, ["English", "Mandarin Chinese"]);
		assert.equal(result.experience_level, "Founder");
		assert.equal(result.on_break, false);
		assert.equal(result.stats.average_rating, 4.88);
		assert.equal(result.stats.reviews_count, 155);
		// empty-text and inactive reviews filtered out
		assert.equal(result.recent_reviews.length, 1);
		assert.equal(result.recent_reviews[0].rating, 5);
		assert.match(result.recent_reviews[0].date_iso, /^\d{4}-\d{2}-\d{2}T/);
		assert.equal(result.profile_url, "https://adplist.org/mentors/felix-lee");
		// public-by-construction: no Authorization header on any call
		assert.ok(calls.every((c) => !(c.init?.headers || {}).Authorization));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("getMentorProfile still returns the profile when stats and reviews fail", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		const u = String(url);
		if (u.includes("/users/profile/mentor/")) return jsonResponse(PROFILE_RESPONSE);
		throw new Error("downstream broke");
	};

	try {
		const result = await getMentorProfile(
			{ AUTH_SERVICE_URL: "https://auth.example" },
			{ mentor_slug: "felix-lee" },
		);
		assert.equal(result.name, "Felix Lee");
		assert.deepEqual(result.stats, { average_rating: null, reviews_count: null });
		assert.deepEqual(result.recent_reviews, []);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("getMentorProfile reports a clear error for unknown slugs", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => jsonResponse({ message: "Not found" }, 404);
	try {
		await assert.rejects(
			() =>
				getMentorProfile(
					{ AUTH_SERVICE_URL: "https://auth.example" },
					{ mentor_slug: "nobody-here" },
				),
			/No ADPList mentor found for slug "nobody-here"/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("unknown-slug errors surface as NOT_FOUND with the slug in the message", () => {
	const result = formatToolError(new Error('No ADPList mentor found for slug "nobody-here".'));
	assert.equal(result.error.code, "NOT_FOUND");
	assert.match(result.error.message, /nobody-here/);
});

test("getMentorProfile tolerates sparse payloads and caps long text", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		const u = String(url);
		if (u.includes("/users/profile/mentor/")) {
			return jsonResponse({
				data: { userId: "u2", fullName: "Sparse Mentor", bio: "x".repeat(5000) },
			});
		}
		if (u.includes("/users/review")) {
			return jsonResponse({
				data: {
					reviews: [
						{ review: "y".repeat(2000), rating: 5, createdOn: 1779394224751, status: "active" },
					],
				},
			});
		}
		return jsonResponse({ data: {} });
	};

	try {
		const result = await getMentorProfile(
			{ AUTH_SERVICE_URL: "https://auth.example" },
			{ mentor_slug: "sparse" },
		);
		assert.equal(result.title, "");
		assert.deepEqual(result.disciplines, []);
		assert.deepEqual(result.languages, []);
		assert.ok(result.bio.length <= 1200);
		assert.match(result.bio, /…$/);
		assert.ok(result.recent_reviews[0].text.length <= 300);
		assert.match(result.recent_reviews[0].text, /…$/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
