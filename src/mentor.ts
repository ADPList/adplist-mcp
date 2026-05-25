import type { McpUserProps } from "./types";

// ── Types ────────────────────────────────────────────────────────────

export type ListMentorRequestsInput = {
	limit?: number;
};

export type RespondToMentorRequestInput = {
	session_id: string;
	action: "accept" | "decline";
	message?: string;
};

export type RescheduleAsMentorInput = {
	session_id: string;
	new_slot_iso: string;
	message?: string;
};

export type MentorRequest = {
	session_id: string; // meetingId
	mentee: {
		name: string;
		slug: string;
		title: string;
		organization: string;
		profile_photo_url: string;
	};
	scheduled_at_iso: string;
	duration_minutes: number;
	source: string;
	booking_notes: string;
	session_url: string;
};

export type ListMentorRequestsOutput = {
	requests: MentorRequest[];
	limit: number;
};

export type RespondToMentorRequestOutput = {
	session_id: string;
	action: "accepted" | "declined";
	updated_at_iso: string;
};

export type RescheduleAsMentorOutput = {
	session_id: string;
	new_slot_iso: string;
	status: string;
};

export type MenteeInfo = {
	user_id: string;
	name: string;
	slug: string;
	title: string;
	organization: string;
	profile_photo_url: string;
};

export type ListMyMenteesOutput = {
	mentees: MenteeInfo[];
};

// ── Shared helpers ────────────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function requireBaseUrl(env: Env): string {
	const url = env.MEETINGS_SERVICE_URL;
	if (!url) throw new Error("MEETINGS_SERVICE_URL is not configured");
	return url;
}

function requireAuth(props: McpUserProps | undefined, toolName: string): void {
	if (!props?.cognitoAccessToken)
		throw new Error(`${toolName} requires an authenticated ADPList user`);
}

function buildHeaders(props: McpUserProps | undefined): HeadersInit {
	return {
		Accept: "application/json",
		"Content-Type": "application/json",
		...(props?.cognitoAccessToken
			? { Authorization: `Bearer ${props.cognitoAccessToken}` }
			: {}),
	};
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function normalizeImageUrl(value: unknown): string {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (trimmed.startsWith("https://")) return trimmed;
	if (trimmed.startsWith("//")) return `https:${trimmed}`;
	if (trimmed.startsWith("/")) return `https://adplist.org${trimmed}`;
	return "";
}

// ── list_mentor_requests ──────────────────────────────────────────────

type MeetingsListResponse = {
	meetings?: RawMeeting[];
	nextToken?: string;
	totalCount?: number;
};

type RawMeeting = {
	meetingId?: string;
	status?: string;
	mentorUserId?: string;
	menteeUserId?: string;
	scheduledDate?: number;
	duration?: number;
	source?: string;
	notes?: string;
	message?: string;
	mentor?: {
		userId?: string;
		fullName?: string;
		slug?: string;
		title?: string;
		organization?: string;
		profileImage?: string;
	};
	mentee?: {
		userId?: string;
		fullName?: string;
		slug?: string;
		title?: string;
		organization?: string;
		profileImage?: string;
	};
};

function mapMeetingToMentorRequest(meeting: RawMeeting): MentorRequest {
	const scheduledEpoch =
		typeof meeting.scheduledDate === "number" && Number.isFinite(meeting.scheduledDate)
			? meeting.scheduledDate
			: 0;
	const duration =
		typeof meeting.duration === "number" ? Math.max(1, Math.round(meeting.duration)) : 30;

	return {
		session_id: meeting.meetingId || "",
		mentee: {
			name: meeting.mentee?.fullName || "",
			slug: meeting.mentee?.slug || "",
			title: meeting.mentee?.title || "",
			organization: meeting.mentee?.organization || "",
			profile_photo_url: normalizeImageUrl(meeting.mentee?.profileImage),
		},
		scheduled_at_iso: new Date(scheduledEpoch * 1000).toISOString(),
		duration_minutes: duration,
		source: (meeting.source || "web").toLowerCase(),
		booking_notes: meeting.notes || meeting.message || "",
		session_url: `https://adplist.org/meetings/${meeting.meetingId || ""}`,
	};
}

export async function listMentorRequests(
	env: Env,
	props: McpUserProps | undefined,
	input: ListMentorRequestsInput = {},
): Promise<ListMentorRequestsOutput> {
	const baseUrl = requireBaseUrl(env);
	requireAuth(props, "list_mentor_requests");

	const limit = normalizeLimit(input.limit);
	const url = new URL("/meetings", baseUrl);
	url.searchParams.set("filter", "pending");
	url.searchParams.set("limit", String(limit));

	const response = await fetch(url.toString(), { headers: buildHeaders(props) });

	if (!response.ok) {
		const body = await safeJson<{ error?: string }>(response);
		throw new Error(
			`meetings-service list returned HTTP ${response.status}${body?.error ? `: ${body.error}` : ""}`,
		);
	}

	const data = (await response.json()) as MeetingsListResponse;
	const meetings = data.meetings ?? [];

	return {
		requests: meetings.slice(0, limit).map(mapMeetingToMentorRequest),
		limit,
	};
}

// ── respond_to_mentor_request ─────────────────────────────────────────

type MeetingActionResponse = {
	requestId?: string;
	meeting?: {
		meetingId?: string;
		status?: string;
		updatedAt?: number;
		updatedOn?: number;
	};
	message?: string;
	error?: string;
};

export async function respondToMentorRequest(
	env: Env,
	props: McpUserProps | undefined,
	input: RespondToMentorRequestInput,
): Promise<RespondToMentorRequestOutput> {
	const baseUrl = requireBaseUrl(env);
	requireAuth(props, "respond_to_mentor_request");

	const sessionId = input.session_id.trim();
	if (!sessionId) throw new Error("session_id is required");

	const endpoint = input.action === "accept" ? "confirm" : "decline";
	const url = new URL(`/meetings/${endpoint}/${encodeURIComponent(sessionId)}`, baseUrl);

	const response = await fetch(url.toString(), {
		method: "POST",
		headers: buildHeaders(props),
		body: JSON.stringify({ message: input.message?.trim() || undefined }),
	});

	const body = await safeJson<MeetingActionResponse>(response);

	if (!response.ok) {
		const err = body?.error || body?.message || `HTTP ${response.status}`;
		throw new Error(`Failed to ${input.action} session ${sessionId}: ${err}`);
	}

	const updatedAt =
		body?.meeting?.updatedAt || body?.meeting?.updatedOn || Math.floor(Date.now() / 1000);

	return {
		session_id: sessionId,
		action: input.action === "accept" ? "accepted" : "declined",
		updated_at_iso: new Date(updatedAt * 1000).toISOString(),
	};
}

// ── reschedule_as_mentor ───────────────────────────────────────────────

export async function rescheduleAsMentor(
	env: Env,
	props: McpUserProps | undefined,
	input: RescheduleAsMentorInput,
): Promise<RescheduleAsMentorOutput> {
	const baseUrl = requireBaseUrl(env);
	requireAuth(props, "reschedule_as_mentor");

	const sessionId = input.session_id.trim();
	if (!sessionId) throw new Error("session_id is required");

	const slotDate = new Date(input.new_slot_iso);
	if (isNaN(slotDate.getTime()))
		throw new Error("new_slot_iso must be a valid ISO 8601 datetime");

	const startDateTime = Math.floor(slotDate.getTime() / 1000);

	const url = new URL(
		`/meetings/reschedule/${encodeURIComponent(sessionId)}`,
		baseUrl,
	);

	const response = await fetch(url.toString(), {
		method: "POST",
		headers: buildHeaders(props),
		body: JSON.stringify({
			startDateTime,
			message: input.message?.trim() || undefined,
		}),
	});

	const body = await safeJson<MeetingActionResponse>(response);

	if (!response.ok) {
		const err = body?.error || body?.message || `HTTP ${response.status}`;
		throw new Error(`Failed to reschedule session ${sessionId}: ${err}`);
	}

	return {
		session_id: sessionId,
		new_slot_iso: slotDate.toISOString(),
		status: body?.meeting?.status || "RESCHEDULED",
	};
}

// ── list_my_mentees ────────────────────────────────────────────────────

type MenteesListResponse = {
	mentees?: RawMentee[];
};

type RawMentee = {
	userId?: string;
	fullName?: string;
	slug?: string;
	title?: string;
	organization?: string;
	profileImage?: string;
	profile?: { image?: string };
	image?: string;
};

function mapMentee(raw: RawMentee): MenteeInfo {
	return {
		user_id: raw.userId || "",
		name: raw.fullName || "",
		slug: raw.slug || "",
		title: raw.title || raw.organization || "",
		organization: raw.organization || "",
		profile_photo_url: normalizeImageUrl(
			raw.profileImage ?? raw.profile?.image ?? raw.image,
		),
	};
}

export async function listMyMentees(
	env: Env,
	props: McpUserProps | undefined,
): Promise<ListMyMenteesOutput> {
	const baseUrl = requireBaseUrl(env);
	requireAuth(props, "list_my_mentees");

	const url = new URL("/meetings/mentees", baseUrl);
	const response = await fetch(url.toString(), { headers: buildHeaders(props) });

	if (!response.ok) {
		const body = await safeJson<{ error?: string }>(response);
		throw new Error(
			`meetings-service mentees returned HTTP ${response.status}${body?.error ? `: ${body.error}` : ""}`,
		);
	}

	const data = (await response.json()) as MenteesListResponse;
	return {
		mentees: (data.mentees ?? []).map(mapMentee),
	};
}

// ── Utilities ──────────────────────────────────────────────────────────

async function safeJson<T>(response: Response): Promise<T | undefined> {
	try {
		return (await response.json()) as T;
	} catch {
		return undefined;
	}
}
