import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	buildListJournalsUrl,
	buildReadJournalUrl,
	listJournals,
	mapJournal,
	normalizeJournalLimit,
	normalizeSinceIso,
	readJournal,
} from "../src/journals.ts";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

const props = { userId: "u1", email: null, scopes: [], cognitoAccessToken: "token" };

function journal(overrides = {}) {
	return {
		journalId: "journal-1",
		title: "Pricing strategy with Sarah",
		meetingId: "meeting-1",
		sessionId: "session-1",
		meetingType: "direct",
		createdOn: 1_700_000_000_000,
		updatedOn: 1_700_000_060_000,
		participants: [
			{
				id: "mentor-1",
				name: "Sarah Mentor",
				slug: "sarah",
				title: "VP Product",
				type: "mentor",
				role: "HOST",
			},
			{
				id: "u1",
				name: "Riley Mentee",
				slug: "riley",
				title: "Founder",
				type: "member",
				role: "PARTICIPANT",
			},
		],
		tags: ["pricing", "growth"],
		hasMeaningfulContent: true,
		summary: {
			tldr: { markdown: "Talked through pricing tiers." },
			insights: { list: ["Start with willingness-to-pay interviews"] },
			highlights: { string: "Sarah recommended packaging around outcomes." },
			actionItems: { list: ["Draft three pricing options"] },
		},
		transcript: { transcriptUrl: "s3://private", segmentsUrl: "s3://private-segments" },
		...overrides,
	};
}

test("M5 registers list_journals and read_journal with AI session-summary framing", () => {
	assert.match(indexSource, /registerTool\(\s*"list_journals"/);
	assert.match(indexSource, /registerTool\(\s*"read_journal"/);
	assert.match(indexSource, /AI-generated post-session summaries/i);
	assert.match(indexSource, /not user-authored free-form journals/i);
	assert.match(indexSource, /never frame results as 'what you wrote in your journal'/i);
});

test("journal limit defaults to 30 and clamps to 100", () => {
	assert.equal(normalizeJournalLimit(undefined), 30);
	assert.equal(normalizeJournalLimit(0), 1);
	assert.equal(normalizeJournalLimit(101), 100);
	assert.equal(normalizeJournalLimit(7.9), 7);
});

test("since_iso normalizes valid ISO input and rejects invalid input", () => {
	assert.equal(normalizeSinceIso(undefined), undefined);
	assert.equal(normalizeSinceIso("2026-05-01"), "2026-05-01T00:00:00.000Z");
	assert.throws(() => normalizeSinceIso("not-a-date"), /since_iso/);
});

test("buildListJournalsUrl uses meaningful-content filter and requested page", () => {
	const url = new URL(
		buildListJournalsUrl("https://meetings.example", { limit: 45, since_iso: "2026-05-01" }, 2),
	);
	assert.equal(url.origin, "https://meetings.example");
	assert.equal(url.pathname, "/journals");
	assert.equal(url.searchParams.get("page"), "2");
	assert.equal(url.searchParams.get("pageSize"), "45");
	assert.equal(url.searchParams.get("hasMeaningfulContent"), "true");
	assert.equal(url.searchParams.has("since_iso"), false);
});

test("buildReadJournalUrl targets one journal by id", () => {
	assert.equal(
		buildReadJournalUrl("https://meetings.example", "journal 1"),
		"https://meetings.example/journals/journal%201",
	);
});

test("mapJournal omits structured summary by default and never exposes transcript URLs", () => {
	const result = mapJournal(journal(), false);
	assert.equal(result.journal_id, "journal-1");
	assert.equal(result.created_at_iso, "2023-11-14T22:13:20.000Z");
	assert.equal(result.participants[0].name, "Sarah Mentor");
	assert.equal(result.has_meaningful_content, true);
	assert.equal(result.summary, undefined);
	assert.equal("transcript" in result, false);
});

test("mapJournal includes full structured summary when requested", () => {
	const result = mapJournal(journal(), true);
	assert.deepEqual(result.summary, {
		tldr: { markdown: "Talked through pricing tiers." },
		insights: { list: ["Start with willingness-to-pay interviews"] },
		highlights: { string: "Sarah recommended packaging around outcomes." },
		action_items: { list: ["Draft three pricing options"] },
	});
});

test("listJournals passes bearer token and returns graceful empty array", async () => {
	const calls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return Response.json({ journals: [], totalPages: 0, totalItems: 0, currentPage: 1 });
	};
	try {
		const result = await listJournals(
			{ MEETINGS_SERVICE_URL: "https://meetings.example" },
			props,
			{},
		);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].init.headers.Authorization, "Bearer token");
		assert.match(calls[0].url, /hasMeaningfulContent=true/);
		assert.deepEqual(result.journals, []);
		assert.equal(result.total_items, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("listJournals paginates until since_iso yields enough matching journals", async () => {
	const calls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		const page = new URL(String(url)).searchParams.get("page");
		return Response.json({
			journals:
				page === "1"
					? [journal({ journalId: "old", createdOn: 1_600_000_000_000 })]
					: [journal({ journalId: "new", createdOn: 1_700_000_000_000 })],
			totalPages: 2,
			totalItems: 2,
			currentPage: Number(page),
		});
	};
	try {
		const result = await listJournals(
			{ MEETINGS_SERVICE_URL: "https://meetings.example" },
			props,
			{ limit: 1, since_iso: "2023-01-01T00:00:00.000Z" },
		);
		assert.equal(calls.length, 2);
		assert.deepEqual(
			result.journals.map((item) => item.journal_id),
			["new"],
		);
		assert.equal(result.pages_read, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("listJournals with_content includes structured summaries without truncation", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		Response.json({ journals: [journal()], totalPages: 1, totalItems: 1, currentPage: 1 });
	try {
		const result = await listJournals(
			{ MEETINGS_SERVICE_URL: "https://meetings.example" },
			props,
			{ with_content: true },
		);
		assert.equal(result.with_content, true);
		assert.deepEqual(result.journals[0].summary.action_items.list, [
			"Draft three pricing options",
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("readJournal fetches a single journal with full structured summary", async () => {
	const calls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return Response.json(journal({ journalId: "journal-2" }));
	};
	try {
		const result = await readJournal(
			{ MEETINGS_SERVICE_URL: "https://meetings.example" },
			props,
			{ journal_id: "journal-2" },
		);
		assert.equal(calls[0].url, "https://meetings.example/journals/journal-2");
		assert.equal(calls[0].init.headers.Authorization, "Bearer token");
		assert.equal(result.journal_id, "journal-2");
		assert.deepEqual(result.summary.action_items.list, ["Draft three pricing options"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("readJournal refuses a journal that is not associated with the authenticated user", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		Response.json(journal({ participants: [{ id: "someone-else", name: "Other User" }] }));
	try {
		await assert.rejects(
			readJournal({ MEETINGS_SERVICE_URL: "https://meetings.example" }, props, {
				journal_id: "journal-1",
			}),
			/not associated with the authenticated user/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("readJournal fails closed when the journal has no participant IDs", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		Response.json(journal({ participants: [{ name: "Nameless", slug: "nameless" }] }));
	try {
		await assert.rejects(
			readJournal({ MEETINGS_SERVICE_URL: "https://meetings.example" }, props, {
				journal_id: "journal-1",
			}),
			/not associated with the authenticated user/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("journal tools require authenticated ADPList user", async () => {
	await assert.rejects(
		listJournals({ MEETINGS_SERVICE_URL: "https://meetings.example" }, undefined, {}),
		/authenticated ADPList user/,
	);
	await assert.rejects(
		readJournal({ MEETINGS_SERVICE_URL: "https://meetings.example" }, undefined, {
			journal_id: "j1",
		}),
		/authenticated ADPList user/,
	);
});
