import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	buildCancelSessionUrl,
	buildListMySessionsUrl,
	cancelSession,
	listMySessions,
	mapMeetingToSession,
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

test("buildListMySessionsUrl uses existing meetings-service endpoint with full=true for source", () => {
	const url = new URL(
		buildListMySessionsUrl("https://meetings.example", { scope: "past", limit: 3 }),
	);
	assert.equal(url.origin, "https://meetings.example");
	assert.equal(url.pathname, "/meetings");
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

test("mapMeetingToSession trims full meeting shape into M4 response", () => {
	const result = mapMeetingToSession({
		meetingId: "meeting-1",
		status: "AWAITING_CONFIRMATION",
		initialStartDateTime: 1_700_000_000,
		source: "mcp",
		mentor: { fullName: "Sarah Mentor", slug: "sarah" },
		session: { duration: 45 },
		meetingInstances: [{ scheduledDate: 1_700_003_600, status: "CONFIRMED" }],
	});
	assert.deepEqual(result, {
		session_id: "meeting-1",
		mentor_name: "Sarah Mentor",
		mentor_slug: "sarah",
		scheduled_at_iso: "2023-11-14T23:13:20.000Z",
		scheduled_at_local_display: "Tue, Nov 14, 11:13 PM UTC",
		duration_minutes: 45,
		status: "requested",
		source: "mcp",
		session_url: "https://adplist.org/meetings/meeting-1",
	});
});

test("listMySessions passes Cognito bearer and returns compact sessions", async () => {
	const calls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return Response.json({
			meetings: [
				{
					meetingId: "meeting-1",
					status: "CONFIRMED",
					initialStartDateTime: 1_700_000_000,
					metadata: { source: "WEB" },
					mentor: { fullName: "Sarah Mentor", slug: "sarah" },
					session: { duration: 30 },
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
		assert.match(calls[0].url, /filter=upcoming/);
		assert.equal(result.sessions[0].status, "confirmed");
		assert.equal(result.sessions[0].source, "web");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("cancelSession posts optional reason and returns cancelled session", async () => {
	const calls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return Response.json({
			meeting: {
				meetingId: "meeting-1",
				status: "CANCELLED",
				updatedAt: 1_700_004_000,
				initialStartDateTime: 1_700_000_000,
				source: "mcp",
				mentor: { fullName: "Sarah Mentor", slug: "sarah" },
				session: { duration: 30 },
			},
		});
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
		assert.equal(result.cancelled, true);
		assert.equal(result.cancelled_at_iso, "2023-11-14T23:20:00.000Z");
		assert.equal(result.session.status, "cancelled");
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
