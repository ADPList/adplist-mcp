import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	bookSession,
	buildAvailabilityUrl,
	listAvailability,
	mapAvailabilityResponse,
	normalizeAvailabilityDays,
} from "../src/booking.ts";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("M3 registers list_availability and book_session MCP tools with confirmation guidance", () => {
	assert.match(indexSource, /registerTool\(\s*"list_availability"/);
	assert.match(indexSource, /registerTool\(\s*"book_session"/);
	assert.match(indexSource, /always confirm the exact mentor, time, and note/i);
	assert.match(indexSource, /queryID from the earlier search_mentors result/i);
});

test("availability days default to 14 and clamp to max 30", () => {
	assert.equal(normalizeAvailabilityDays(undefined), 14);
	assert.equal(normalizeAvailabilityDays(0), 1);
	assert.equal(normalizeAvailabilityDays(99), 30);
	assert.equal(normalizeAvailabilityDays(7.9), 7);
});

test("buildAvailabilityUrl calls meetings-service mentor availability endpoint", () => {
	const url = new URL(buildAvailabilityUrl("https://meetings.example", "mentor one", 45));
	assert.equal(url.origin, "https://meetings.example");
	assert.equal(url.pathname, "/availability/mentor%20one");
	assert.match(url.searchParams.get("startDate"), /^\d{4}-\d{2}-\d{2}$/);
	assert.match(url.searchParams.get("endDate"), /^\d{4}-\d{2}-\d{2}$/);
});

test("mapAvailabilityResponse flattens, sorts, formats, and truncates slots", () => {
	const response = {
		timezone: "Asia/Singapore",
		sessions: [
			{
				sessionId: "later-session",
				callerTimezone: "Asia/Singapore",
				slots: [{ startEpoch: 1_800_000_000, endEpoch: 1_800_001_800 }],
			},
			{
				sessionId: "first-session",
				callerTimezone: "America/Los_Angeles",
				slots: Array.from({ length: 21 }, (_, index) => ({
					startEpoch: 1_700_000_000 + index * 1_800,
					endEpoch: 1_700_001_800 + index * 1_800,
				})),
			},
		],
	};

	const result = mapAvailabilityResponse("mentor-slug", response);
	assert.equal(result.slots.length, 20);
	assert.equal(result.truncated, true);
	assert.equal(result.timezone, "Asia/Singapore");
	assert.equal(result.slots[0].session_id, "first-session");
	assert.equal(result.slots[0].slot_iso, "2023-11-14T22:13:20.000Z");
	assert.equal(result.slots[0].duration_minutes, 30);
	assert.match(result.slots[0].slot_local_display, /Nov/);
});

test("listAvailability passes Cognito bearer and returns compact slots", async () => {
	const calls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return Response.json({
			timezone: "UTC",
			sessions: [
				{
					sessionId: "session-1",
					slots: [{ startEpoch: 1_700_000_000, endEpoch: 1_700_001_800 }],
				},
			],
		});
	};
	try {
		const result = await listAvailability(
			{ MEETINGS_SERVICE_URL: "https://meetings.example" },
			{ userId: "u1", email: null, scopes: [], cognitoAccessToken: "token" },
			{ mentor_slug: "mentor", days: 14 },
		);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].init.headers.Authorization, "Bearer token");
		assert.equal(result.slots[0].session_id, "session-1");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("bookSession refreshes availability and posts source mcp plus queryID", async () => {
	const calls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init = {}) => {
		calls.push({ url: String(url), init });
		if (String(url).includes("/availability/")) {
			return Response.json({
				timezone: "UTC",
				sessions: [
					{
						sessionId: "session-1",
						slots: [{ startEpoch: 1_700_000_000, endEpoch: 1_700_001_800 }],
					},
				],
			});
		}
		return Response.json(
			{ meetingId: "meeting-1", status: "AWAITING_CONFIRMATION", autoAccepted: false },
			{ status: 202 },
		);
	};
	try {
		const result = await bookSession(
			{ MEETINGS_SERVICE_URL: "https://meetings.example" },
			{ userId: "u1", email: null, scopes: [], cognitoAccessToken: "token" },
			{
				mentor_slug: "mentor",
				slot_iso: "2023-11-14T22:13:20.000Z",
				note: "I would love help with product strategy.",
				queryID: "algolia-query-id",
			},
		);
		assert.deepEqual(result, {
			status: "requested",
			session_id: "meeting-1",
			session_url: "https://adplist.org/meetings/meeting-1",
		});
		const createCall = calls.find((call) => call.init.method === "POST");
		assert.ok(createCall);
		assert.equal(createCall.url, "https://meetings.example/meetings");
		assert.equal(createCall.init.headers.Authorization, "Bearer token");
		assert.deepEqual(JSON.parse(createCall.init.body), {
			sessionId: "session-1",
			startDateTime: 1700000000,
			message: "I would love help with product strategy.",
			source: "mcp",
			queryID: "algolia-query-id",
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("bookSession refuses stale slots before creating a booking", async () => {
	const originalFetch = globalThis.fetch;
	let postCount = 0;
	globalThis.fetch = async (url, init = {}) => {
		if (init.method === "POST") postCount += 1;
		return Response.json({ timezone: "UTC", sessions: [] });
	};
	try {
		await assert.rejects(
			bookSession(
				{ MEETINGS_SERVICE_URL: "https://meetings.example" },
				{ userId: "u1", email: null, scopes: [], cognitoAccessToken: "token" },
				{ mentor_slug: "mentor", slot_iso: "2023-11-14T22:13:20.000Z", note: "Help" },
			),
			/no longer available/,
		);
		assert.equal(postCount, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
