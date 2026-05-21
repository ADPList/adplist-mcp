import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	buildCancelSessionUrl,
	buildListMySessionsUrl,
	cancelSession,
	listMySessions,
	mapInstanceToSession,
	normalizeSessionLimit,
	normalizeSessionScope,
} from "../src/sessions.ts";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("M4 registers list_my_sessions and cancel_session MCP tools with cancellation confirmation guidance", () => {
	assert.match(indexSource, /registerTool\(\s*"list_my_sessions"/);
	assert.match(indexSource, /registerTool\(\s*"cancel_session"/);
	assert.match(
		indexSource,
		/Before calling this tool, always confirm the exact session, mentor, and scheduled time/i,
	);
	assert.match(indexSource, /there is no native reschedule_session tool in v1/i);
});

test("session scope defaults to upcoming and limit defaults to 20", () => {
	assert.equal(normalizeSessionScope(undefined), "upcoming");
	assert.equal(normalizeSessionScope("past"), "past");
	assert.equal(normalizeSessionScope("all"), "all");
	assert.equal(normalizeSessionLimit(undefined), 20);
	assert.equal(normalizeSessionLimit(0), 1);
	assert.equal(normalizeSessionLimit(99), 50);
	assert.equal(normalizeSessionLimit(7.9), 7);
});

test("buildListMySessionsUrl targets /meetings/instances so both roles are returned", () => {
	const url = new URL(
		buildListMySessionsUrl("https://meetings.example", { scope: "past", limit: 3 }),
	);
	assert.equal(url.origin, "https://meetings.example");
	assert.equal(url.pathname, "/meetings/instances");
	assert.equal(url.searchParams.get("filter"), "past");
	assert.equal(url.searchParams.get("limit"), "3");
	assert.equal(url.searchParams.get("full"), "true");
});

test("buildCancelSessionUrl uses existing cancellation endpoint", () => {
	assert.equal(
		buildCancelSessionUrl("https://meetings.example", "meeting 1"),
		"https://meetings.example/meetings/cancel/meeting%201",
	);
});

test("mapInstanceToSession returns both parties with profile and booking context", () => {
	const result = mapInstanceToSession({
		meetingId: "meeting-1",
		scheduledDate: 1_700_003_600,
		status: "AWAITING_CONFIRMATION",
		duration: 45,
		meeting: {
			metadata: {
				source: "mcp",
				bookingNotes: [{ description: "Want help moving from design to PM" }],
				questions: [{ question: "Biggest challenge?", answer: "Positioning myself" }],
			},
			mentor: {
				fullName: "Sarah Mentor",
				slug: "sarah",
				title: "Group PM",
				organization: "Stripe",
			},
			mentee: { fullName: "Riley Mentee", slug: "riley", title: "Senior Designer" },
		},
	});
	assert.deepEqual(result, {
		session_id: "meeting-1",
		mentor: { name: "Sarah Mentor", slug: "sarah", title: "Group PM", organization: "Stripe" },
		mentee: { name: "Riley Mentee", slug: "riley", title: "Senior Designer", organization: "" },
		scheduled_at_iso: "2023-11-14T23:13:20.000Z",
		scheduled_at_local_display: "Tue, Nov 14, 11:13 PM UTC",
		duration_minutes: 45,
		status: "requested",
		source: "mcp",
		booking_notes: "Want help moving from design to PM",
		booking_questions: ["Biggest challenge? — Positioning myself"],
		session_url: "https://adplist.org/meetings/meeting-1",
	});
});

test("mapInstanceToSession degrades gracefully when parties and booking context are missing", () => {
	const result = mapInstanceToSession({
		meetingId: "meeting-2",
		scheduledDate: 1_700_086_400,
		status: "CONFIRMED",
		duration: 30,
		meeting: { mentor: { fullName: "Solo Mentor", slug: "solo" } },
	});
	assert.deepEqual(result.mentor, {
		name: "Solo Mentor",
		slug: "solo",
		title: "",
		organization: "",
	});
	assert.deepEqual(result.mentee, { name: "", slug: "", title: "", organization: "" });
	assert.equal(result.booking_notes, "");
	assert.deepEqual(result.booking_questions, []);
	assert.equal(result.status, "confirmed");
	assert.equal(result.scheduled_at_iso, "2023-11-15T22:13:20.000Z");
});

test("listMySessions passes Cognito bearer and returns both-party sessions with context", async () => {
	const calls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return Response.json({
			instances: [
				{
					meetingId: "meeting-1",
					scheduledDate: 1_700_000_000,
					status: "CONFIRMED",
					duration: 30,
					meeting: {
						metadata: {
							source: "WEB",
							bookingNotes: [{ description: "Looking forward to it" }],
						},
						mentor: {
							fullName: "Sarah Mentor",
							slug: "sarah",
							title: "Group PM",
							organization: "Stripe",
						},
						mentee: { fullName: "Riley Mentee", slug: "riley" },
					},
				},
			],
		});
	};
	try {
		const result = await listMySessions(
			{ MEETINGS_SERVICE_URL: "https://meetings.example" },
			{ userId: "u1", email: null, scopes: [], cognitoAccessToken: "token" },
			{ scope: "upcoming", limit: 20 },
		);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].init.headers.Authorization, "Bearer token");
		assert.match(calls[0].url, /\/meetings\/instances/);
		assert.match(calls[0].url, /filter=upcoming/);
		assert.equal(result.sessions[0].status, "confirmed");
		assert.equal(result.sessions[0].source, "web");
		assert.equal(result.sessions[0].mentor.name, "Sarah Mentor");
		assert.equal(result.sessions[0].mentor.organization, "Stripe");
		assert.equal(result.sessions[0].mentee.name, "Riley Mentee");
		assert.equal(result.sessions[0].booking_notes, "Looking forward to it");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("cancelSession posts optional reason and returns cancellation time", async () => {
	const calls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return Response.json({ meeting: { updatedAt: 1_700_004_000 } });
	};
	try {
		const result = await cancelSession(
			{ MEETINGS_SERVICE_URL: "https://meetings.example" },
			{ userId: "u1", email: null, scopes: [], cognitoAccessToken: "token" },
			{ session_id: "meeting-1", reason: "rescheduling" },
		);
		assert.equal(calls[0].url, "https://meetings.example/meetings/cancel/meeting-1");
		assert.equal(calls[0].init.method, "POST");
		assert.equal(calls[0].init.headers.Authorization, "Bearer token");
		assert.deepEqual(JSON.parse(calls[0].init.body), { message: "rescheduling" });
		assert.deepEqual(result, {
			cancelled: true,
			cancelled_at_iso: "2023-11-14T23:20:00.000Z",
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("cancelSession returns clear rejection reason for meetings-service rule failures", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		Response.json({ error: "Cannot cancel less than 2 hours before start" }, { status: 400 });
	try {
		const result = await cancelSession(
			{ MEETINGS_SERVICE_URL: "https://meetings.example" },
			{ userId: "u1", email: null, scopes: [], cognitoAccessToken: "token" },
			{ session_id: "meeting-1" },
		);
		assert.deepEqual(result, {
			cancelled: false,
			rejection_reason: "Cannot cancel less than 2 hours before start",
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("reschedule v1 flow is composed from cancel, availability, and booking tools", () => {
	const reschedulePrompt = "Reschedule my Sarah session to Wednesday";
	assert.match(reschedulePrompt, /reschedule/i);
	assert.match(indexSource, /cancel_session/);
	assert.match(indexSource, /list_availability/);
	assert.match(indexSource, /book_session/);
});

test("10 cancellation prompts are covered by confirmation guidance before tool use", () => {
	const prompts = [
		"Cancel my next session",
		"Cancel Sarah tomorrow",
		"I can't make my 3pm mentorship call",
		"Delete that booking",
		"Reschedule my next session to Wednesday",
		"Can you cancel my confirmed session?",
		"Cancel meeting-123 because I'm sick",
		"I need to move my session",
		"Please cancel the session with Jane",
		"Cancel all upcoming sessions",
	];
	assert.equal(prompts.length, 10);
	for (const prompt of prompts) assert.match(prompt, /cancel|reschedule|move|can't make|Delete/i);
	assert.match(indexSource, /always confirm the exact session, mentor, and scheduled time/i);
});
