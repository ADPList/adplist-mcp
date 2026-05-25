import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	listMentorRequests,
	respondToMentorRequest,
	rescheduleAsMentor,
} from "../src/mentor.ts";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

// ── Tool registration checks ──────────────────────────────────────────

test("V2 registers all mentor-mode MCP tools", () => {
	assert.match(indexSource, /registerTool\(\s*"list_mentor_requests"/);
	assert.match(indexSource, /registerTool\(\s*"respond_to_mentor_request"/);
	assert.match(indexSource, /registerTool\(\s*"reschedule_as_mentor"/);
	assert.match(indexSource, /registerTool\(\s*"list_my_mentees"/);
});

test("respond_to_mentor_request requires user confirmation in chat before acting", () => {
	assert.match(
		indexSource,
		/Before calling this tool, always confirm the action with the user in chat/i,
	);
});

test("reschedule_as_mentor requires user confirmation in chat before acting", () => {
	assert.match(
		indexSource,
		/Before calling this tool, always confirm the new time with the user in chat/i,
	);
});

// ── list_mentor_requests ──────────────────────────────────────────────

test("list_mentor_requests throws without MEETINGS_SERVICE_URL", async () => {
	await assert.rejects(
		listMentorRequests(/** @type {any} */ ({}), undefined, {}),
		/MEETINGS_SERVICE_URL/,
	);
});

test("list_mentor_requests throws without auth", async () => {
	await assert.rejects(
		listMentorRequests(
			/** @type {any} */ ({ MEETINGS_SERVICE_URL: "https://api.example" }),
			undefined,
			{},
		),
		/authenticated/,
	);
});

test("list_mentor_requests maps pending meetings to request shape", async () => {
	const env = /** @type {any} */ ({
		MEETINGS_SERVICE_URL: "https://api.example",
	});
	const props = { cognitoAccessToken: "tok", userId: "u1", email: null, scopes: [] };

	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		const u = new URL(url);
		assert.equal(u.pathname, "/meetings");
		assert.equal(u.searchParams.get("filter"), "pending");
		assert.equal(u.searchParams.get("limit"), "20");
		return new Response(
			JSON.stringify({
				meetings: [
					{
						meetingId: "m1",
						status: "AWAITING_CONFIRMATION",
						scheduledDate: 1714000000,
						duration: 30,
						source: "mcp",
						notes: "Need PM transition advice",
						mentee: {
							fullName: "Jane Mentee",
							slug: "jane",
							title: "Product Manager",
							organization: "Figma",
							profileImage: "https://img.example/jane.jpg",
						},
					},
				],
			}),
			{ status: 200 },
		);
	};

	try {
		const result = await listMentorRequests(env, props, {});
		assert.equal(result.requests.length, 1);
		const r = result.requests[0];
		assert.equal(r.session_id, "m1");
		assert.equal(r.mentee.name, "Jane Mentee");
		assert.equal(r.mentee.slug, "jane");
		assert.equal(r.mentee.title, "Product Manager");
		assert.equal(r.mentee.organization, "Figma");
		assert.equal(r.mentee.profile_photo_url, "https://img.example/jane.jpg");
		assert.equal(r.booking_notes, "Need PM transition advice");
		assert.equal(r.source, "mcp");
		assert.ok(r.scheduled_at_iso.startsWith("2024"));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("list_mentor_requests surfaces HTTP errors", async () => {
	const env = /** @type {any} */ ({
		MEETINGS_SERVICE_URL: "https://api.example",
	});
	const props = { cognitoAccessToken: "tok", userId: "u1", email: null, scopes: [] };

	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ error: "downstream failure" }), { status: 502 });

	try {
		await assert.rejects(listMentorRequests(env, props, {}), /HTTP 502/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

// ── respond_to_mentor_request ─────────────────────────────────────────

test("respond_to_mentor_request throws without auth", async () => {
	await assert.rejects(
		respondToMentorRequest(
			/** @type {any} */ ({ MEETINGS_SERVICE_URL: "https://api.example" }),
			undefined,
			{ session_id: "m1", action: "accept" },
		),
		/authenticated/,
	);
});

test("respond_to_mentor_request accept POSTs to /meetings/confirm/{id}", async () => {
	const env = /** @type {any} */ ({
		MEETINGS_SERVICE_URL: "https://api.example",
	});
	const props = { cognitoAccessToken: "tok", userId: "u1", email: null, scopes: [] };

	const originalFetch = globalThis.fetch;
	let calledUrl = "";
	let calledBody = "";
	globalThis.fetch = async (url, init) => {
		calledUrl = String(url);
		calledBody = init?.body || "";
		return new Response(
			JSON.stringify({
				meeting: { meetingId: "m1", status: "CONFIRMED", updatedAt: 1714000100 },
			}),
			{ status: 200 },
		);
	};

	try {
		const result = await respondToMentorRequest(env, props, {
			session_id: "m1",
			action: "accept",
			message: "Looking forward to it!",
		});
		assert.equal(result.action, "accepted");
		assert.equal(result.session_id, "m1");
		assert.match(calledUrl, /\/meetings\/confirm\/m1/);
		assert.match(calledBody, /Looking forward to it!/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("respond_to_mentor_request decline POSTs to /meetings/decline/{id}", async () => {
	const env = /** @type {any} */ ({
		MEETINGS_SERVICE_URL: "https://api.example",
	});
	const props = { cognitoAccessToken: "tok", userId: "u1", email: null, scopes: [] };

	const originalFetch = globalThis.fetch;
	let calledUrl = "";
	globalThis.fetch = async (url) => {
		calledUrl = String(url);
		return new Response(
			JSON.stringify({
				meeting: { meetingId: "m1", status: "DECLINED", updatedAt: 1714000100 },
			}),
			{ status: 200 },
		);
	};

	try {
		const result = await respondToMentorRequest(env, props, {
			session_id: "m1",
			action: "decline",
			message: "Schedule conflict",
		});
		assert.equal(result.action, "declined");
		assert.match(calledUrl, /\/meetings\/decline\/m1/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

// ── reschedule_as_mentor ───────────────────────────────────────────────

test("reschedule_as_mentor validates ISO datetime", async () => {
	const env = /** @type {any} */ ({
		MEETINGS_SERVICE_URL: "https://api.example",
	});
	const props = { cognitoAccessToken: "tok", userId: "u1", email: null, scopes: [] };

	await assert.rejects(
		rescheduleAsMentor(env, props, { session_id: "m1", new_slot_iso: "not-a-date" }),
		/valid ISO 8601/,
	);
});

test("reschedule_as_mentor POSTs to /meetings/reschedule/{id}", async () => {
	const env = /** @type {any} */ ({
		MEETINGS_SERVICE_URL: "https://api.example",
	});
	const props = { cognitoAccessToken: "tok", userId: "u1", email: null, scopes: [] };

	const originalFetch = globalThis.fetch;
	let calledUrl = "";
	let calledBody = "";
	globalThis.fetch = async (url, init) => {
		calledUrl = String(url);
		calledBody = init?.body || "";
		return new Response(
			JSON.stringify({
				meeting: { meetingId: "m1", status: "RESCHEDULED" },
			}),
			{ status: 200 },
		);
	};

	try {
		const result = await rescheduleAsMentor(env, props, {
			session_id: "m1",
			new_slot_iso: "2025-06-15T14:00:00Z",
			message: "Can we do this instead?",
		});
		assert.equal(result.status, "RESCHEDULED");
		assert.match(calledUrl, /\/meetings\/reschedule\/m1/);
		assert.match(calledBody, /"startDateTime"/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
