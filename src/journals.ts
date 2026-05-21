import type { McpUserProps } from "./types";

export type ListJournalsInput = {
	limit?: number;
	since_iso?: string;
	with_content?: boolean;
};

export type ReadJournalInput = {
	journal_id: string;
};

type JournalContent = {
	markdown?: string;
	html?: string;
	string?: string;
	list?: string[];
};

type JournalSummary = {
	insights?: JournalContent;
	highlights?: JournalContent;
	tldr?: JournalContent;
	actionItems?: JournalContent;
};

type JournalParticipant = {
	id?: string;
	name?: string;
	slug?: string;
	title?: string;
	type?: string;
	role?: string;
};

type JournalRecord = {
	journalId?: string;
	title?: string;
	meetingId?: string;
	sessionId?: string;
	meetingType?: string;
	summary?: JournalSummary;
	createdOn?: number;
	updatedOn?: number;
	participants?: JournalParticipant[];
	tags?: string[];
	hasMeaningfulContent?: boolean;
};

type ListJournalsResponse = {
	journals?: JournalRecord[];
	totalPages?: number;
	totalItems?: number;
	currentPage?: number;
};

export type JournalParty = {
	name: string;
	slug: string;
	title: string;
	type: string;
	role: string;
};

export type JournalSummaryOutput = {
	tldr?: JournalContent;
	insights?: JournalContent;
	highlights?: JournalContent;
	action_items?: JournalContent;
};

export type JournalItem = {
	journal_id: string;
	title: string;
	meeting_id: string;
	session_id: string;
	meeting_type: string;
	created_at_iso: string;
	updated_at_iso: string;
	participants: JournalParty[];
	tags: string[];
	has_meaningful_content: boolean;
	summary?: JournalSummaryOutput;
};

export type ListJournalsOutput = {
	journals: JournalItem[];
	limit: number;
	since_iso?: string;
	with_content: boolean;
	total_items: number;
	total_pages: number;
	pages_read: number;
};

export type ReadJournalOutput = JournalItem;

const DEFAULT_JOURNAL_LIMIT = 30;
const MAX_JOURNAL_LIMIT = 100;

export function normalizeJournalLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_JOURNAL_LIMIT;
	return Math.min(MAX_JOURNAL_LIMIT, Math.max(1, Math.trunc(limit)));
}

export function normalizeSinceIso(sinceIso: string | undefined): string | undefined {
	if (!sinceIso) return undefined;
	const date = new Date(sinceIso);
	if (Number.isNaN(date.getTime()))
		throw new Error("since_iso must be a valid ISO 8601 datetime");
	return date.toISOString();
}

export function buildListJournalsUrl(
	baseUrl: string,
	input: ListJournalsInput = {},
	page = 1,
): string {
	const url = new URL("/journals", baseUrl);
	url.searchParams.set("page", String(page));
	url.searchParams.set("pageSize", String(normalizeJournalLimit(input.limit)));
	url.searchParams.set("hasMeaningfulContent", "true");
	return url.toString();
}

export function buildReadJournalUrl(baseUrl: string, journalId: string): string {
	return new URL(`/journals/${encodeURIComponent(journalId)}`, baseUrl).toString();
}

export async function listJournals(
	env: Env,
	props: McpUserProps | undefined,
	input: ListJournalsInput = {},
): Promise<ListJournalsOutput> {
	const baseUrl = requireMeetingsServiceUrl(env);
	requireAuthenticatedUser(props, "list_journals");
	const limit = normalizeJournalLimit(input.limit);
	const sinceIso = normalizeSinceIso(input.since_iso);
	const sinceMs = sinceIso ? new Date(sinceIso).getTime() : undefined;
	const journals: JournalItem[] = [];
	let page = 1;
	let totalPages = 1;
	let totalItems = 0;

	while (journals.length < limit && page <= totalPages) {
		const response = await fetch(buildListJournalsUrl(baseUrl, { ...input, limit }, page), {
			headers: buildHeaders(props),
		});
		const body = await safeJson<ListJournalsResponse>(response);

		if (!response.ok) {
			throw new Error(
				`meetings-service journals returned HTTP ${response.status}${errorMessage(body)}`,
			);
		}

		totalPages = Math.max(1, normalizePositiveInteger(body?.totalPages, 1));
		totalItems = normalizePositiveInteger(body?.totalItems, 0);
		const pageItems = (body?.journals ?? [])
			.filter((journal) => isOnOrAfter(journal.createdOn, sinceMs))
			.map((journal) => mapJournal(journal, Boolean(input.with_content)));
		journals.push(...pageItems);
		if ((body?.journals ?? []).length === 0) break;
		page += 1;
	}

	return {
		journals: journals.slice(0, limit),
		limit,
		...(sinceIso ? { since_iso: sinceIso } : {}),
		with_content: Boolean(input.with_content),
		total_items: totalItems,
		total_pages: totalPages,
		pages_read: page - 1,
	};
}

export async function readJournal(
	env: Env,
	props: McpUserProps | undefined,
	input: ReadJournalInput,
): Promise<ReadJournalOutput> {
	const baseUrl = requireMeetingsServiceUrl(env);
	requireAuthenticatedUser(props, "read_journal");
	const journalId = input.journal_id.trim();
	if (!journalId) throw new Error("journal_id is required");

	const response = await fetch(buildReadJournalUrl(baseUrl, journalId), {
		headers: buildHeaders(props),
	});
	const body = await safeJson<JournalRecord>(response);

	if (!response.ok) {
		throw new Error(
			`meetings-service journal returned HTTP ${response.status}${errorMessage(body)}`,
		);
	}
	if (!body?.journalId)
		throw new Error("meetings-service journal response did not include journalId");
	assertJournalBelongsToUser(body, props);

	return mapJournal(body, true);
}

export function mapJournal(journal: JournalRecord, withContent: boolean): JournalItem {
	return {
		journal_id: journal.journalId || "",
		title: journal.title || "",
		meeting_id: journal.meetingId || "",
		session_id: journal.sessionId || "",
		meeting_type: journal.meetingType || "",
		created_at_iso: epochMillisToIso(journal.createdOn),
		updated_at_iso: epochMillisToIso(journal.updatedOn),
		participants: (journal.participants ?? []).map(toParty),
		tags: Array.isArray(journal.tags)
			? journal.tags.filter((tag) => typeof tag === "string")
			: [],
		has_meaningful_content: journal.hasMeaningfulContent === true,
		...(withContent ? { summary: mapSummary(journal.summary) } : {}),
	};
}

function mapSummary(summary: JournalSummary | undefined): JournalSummaryOutput {
	return {
		...(summary?.tldr ? { tldr: summary.tldr } : {}),
		...(summary?.insights ? { insights: summary.insights } : {}),
		...(summary?.highlights ? { highlights: summary.highlights } : {}),
		...(summary?.actionItems ? { action_items: summary.actionItems } : {}),
	};
}

function toParty(participant: JournalParticipant): JournalParty {
	return {
		name: participant.name || "",
		slug: participant.slug || "",
		title: participant.title || "",
		type: participant.type || "",
		role: participant.role || "",
	};
}

function assertJournalBelongsToUser(journal: JournalRecord, props: McpUserProps): void {
	const participantIds = (journal.participants ?? [])
		.map((participant) => participant.id)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
	if (participantIds.length > 0 && !participantIds.includes(props.userId)) {
		throw new Error(
			"read_journal refused a journal that is not associated with the authenticated user",
		);
	}
}

function isOnOrAfter(epochMillis: number | undefined, sinceMs: number | undefined): boolean {
	if (sinceMs === undefined) return true;
	return (
		typeof epochMillis === "number" && Number.isFinite(epochMillis) && epochMillis >= sinceMs
	);
}

function epochMillisToIso(epochMillis: number | undefined): string {
	if (typeof epochMillis !== "number" || !Number.isFinite(epochMillis)) return "";
	return new Date(epochMillis).toISOString();
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.trunc(value)
		: fallback;
}

function requireMeetingsServiceUrl(env: Env): string {
	const baseUrl = env.MEETINGS_SERVICE_URL;
	if (!baseUrl) throw new Error("MEETINGS_SERVICE_URL is not configured");
	return baseUrl;
}

function requireAuthenticatedUser(
	props: McpUserProps | undefined,
	toolName: string,
): asserts props is McpUserProps {
	if (!props?.cognitoAccessToken)
		throw new Error(`${toolName} requires an authenticated ADPList user`);
}

function buildHeaders(props: McpUserProps | undefined): HeadersInit {
	return {
		Accept: "application/json",
		Authorization: `Bearer ${props?.cognitoAccessToken ?? ""}`,
	};
}

async function safeJson<T>(response: Response): Promise<T | undefined> {
	try {
		return (await response.json()) as T;
	} catch {
		return undefined;
	}
}

function errorMessage(body: unknown): string {
	if (body && typeof body === "object") {
		const message = (body as Record<string, unknown>).message;
		const error = (body as Record<string, unknown>).error;
		if (typeof error === "string") return `: ${error}`;
		if (typeof message === "string") return `: ${message}`;
	}
	return "";
}
