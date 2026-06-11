import type { McpUserProps } from "./types";

export type ListMySessionsInput = {
	scope?: "upcoming" | "past" | "all";
	limit?: number;
};

export type CancelSessionInput = {
	session_id: string;
	user_confirmed: true;
	reason?: string;
};

type MeetingStatus =
	| "AWAITING_PAYMENT"
	| "AWAITING_CONFIRMATION"
	| "CONFIRMED"
	| "COMPLETED"
	| "CANCELLED"
	| "DECLINED"
	| "RESCHEDULED"
	| string;

type InstanceParty = {
	fullName?: string;
	slug?: string;
	title?: string;
	organization?: string;
	profile?: { image?: string };
	image?: string;
	profileImage?: string;
	profile_photo_url?: string;
};

type BookingNote = {
	description?: string;
};

type InstanceMeeting = {
	metadata?: {
		source?: string;
		questions?: unknown[];
		bookingNotes?: BookingNote[];
	};
	mentor?: InstanceParty;
	mentee?: InstanceParty;
};

type MeetingInstanceRecord = {
	meetingId?: string;
	scheduledDate?: number;
	status?: MeetingStatus;
	duration?: number;
	meeting?: InstanceMeeting;
};

type MeetingInstancesResponse = {
	instances?: MeetingInstanceRecord[];
};

type CancelMeetingResponse = {
	meeting?: { updatedAt?: number };
	message?: string;
	error?: string;
};

export type SessionParty = {
	name: string;
	slug: string;
	title: string;
	organization: string;
	profile_photo_url: string;
};

export type MySession = {
	session_id: string;
	mentor: SessionParty;
	mentee: SessionParty;
	scheduled_at_iso: string;
	scheduled_at_local_display: string;
	duration_minutes: number;
	status: "requested" | "confirmed" | "completed" | "cancelled" | "declined";
	source: string;
	booking_notes: string;
	booking_questions: string[];
	session_url: string;
};

export type ListMySessionsOutput = {
	sessions: MySession[];
	scope: "upcoming" | "past" | "all";
	limit: number;
};

export type CancelSessionOutput = {
	cancelled: boolean;
	cancelled_at_iso?: string;
	rejection_reason?: string;
};

const DEFAULT_SESSION_LIMIT = 20;
const MAX_SESSION_LIMIT = 50;

export function normalizeSessionScope(
	scope: ListMySessionsInput["scope"],
): "upcoming" | "past" | "all" {
	return scope === "past" || scope === "all" ? scope : "upcoming";
}

export function normalizeSessionLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SESSION_LIMIT;
	return Math.min(MAX_SESSION_LIMIT, Math.max(1, Math.trunc(limit)));
}

// /meetings/instances returns both mentee-role and mentor-role sessions; /meetings
// returns only one role based on the caller's userType, so it hides bookings the
// user made as a mentee when their account is a mentor.
export function buildListMySessionsUrl(baseUrl: string, input: ListMySessionsInput = {}): string {
	const url = new URL("/meetings/instances", baseUrl);
	url.searchParams.set("filter", normalizeSessionScope(input.scope));
	url.searchParams.set("limit", String(normalizeSessionLimit(input.limit)));
	url.searchParams.set("full", "true");
	return url.toString();
}

export function buildCancelSessionUrl(baseUrl: string, sessionId: string): string {
	return new URL(`/meetings/cancel/${encodeURIComponent(sessionId)}`, baseUrl).toString();
}

export async function listMySessions(
	env: Env,
	props: McpUserProps | undefined,
	input: ListMySessionsInput = {},
): Promise<ListMySessionsOutput> {
	const response = await fetchMeetingInstances(env, props, input);
	return {
		sessions: (response.instances ?? []).map(mapInstanceToSession),
		scope: normalizeSessionScope(input.scope),
		limit: normalizeSessionLimit(input.limit),
	};
}

export async function cancelSession(
	env: Env,
	props: McpUserProps | undefined,
	input: CancelSessionInput,
): Promise<CancelSessionOutput> {
	const baseUrl = requireMeetingsServiceUrl(env);
	requireAuthenticatedUser(props, "cancel_session");
	const sessionId = input.session_id.trim();
	if (!sessionId) throw new Error("session_id is required");

	const response = await fetch(buildCancelSessionUrl(baseUrl, sessionId), {
		method: "POST",
		headers: { ...buildHeaders(props), "Content-Type": "application/json" },
		body: JSON.stringify({ message: input.reason?.trim() || undefined }),
	});
	const body = await safeJson<CancelMeetingResponse>(response);

	if (!response.ok) {
		return {
			cancelled: false,
			rejection_reason:
				body?.error ||
				body?.message ||
				`meetings-service cancellation returned HTTP ${response.status}`,
		};
	}

	return {
		cancelled: true,
		cancelled_at_iso: new Date(
			(body?.meeting?.updatedAt ?? Math.floor(Date.now() / 1000)) * 1000,
		).toISOString(),
	};
}

// Returns both parties on every session. The MCP host already knows which user
// it is helping, so it can frame each session correctly without the MCP having
// to resolve the caller's role from mismatched user-id forms.
export function mapInstanceToSession(instance: MeetingInstanceRecord): MySession {
	const meetingId = instance.meetingId || "";
	const scheduledEpoch = isFiniteNumber(instance.scheduledDate) ? instance.scheduledDate : 0;
	return {
		session_id: meetingId,
		mentor: toParty(instance.meeting?.mentor),
		mentee: toParty(instance.meeting?.mentee),
		scheduled_at_iso: new Date(scheduledEpoch * 1000).toISOString(),
		scheduled_at_local_display: formatLocalDisplay(scheduledEpoch),
		duration_minutes: normalizeDuration(instance.duration),
		status: mapMeetingStatus(instance.status),
		source: normalizeSource(instance.meeting?.metadata?.source),
		booking_notes: extractBookingNotes(instance.meeting),
		booking_questions: extractBookingQuestions(instance.meeting),
		session_url: `https://adplist.org/meetings/${meetingId}`,
	};
}

function toParty(party: InstanceParty | undefined): SessionParty {
	return {
		name: party?.fullName || "",
		slug: party?.slug || "",
		title: party?.title || "",
		organization: party?.organization || "",
		profile_photo_url: normalizeImageUrl(
			party?.profile?.image ??
				party?.profile_photo_url ??
				party?.profileImage ??
				party?.image,
		),
	};
}

// The note from the booking form (and what book_session sends as `message`) is
// persisted as meetings-service metadata.bookingNotes entries.
function extractBookingNotes(meeting: InstanceMeeting | undefined): string {
	return (meeting?.metadata?.bookingNotes ?? [])
		.map((note) => (typeof note?.description === "string" ? note.description.trim() : ""))
		.filter(Boolean)
		.join("\n");
}

// metadata.questions shape varies (form definitions vs answered responses), so
// extract text defensively rather than assuming a fixed shape.
function extractBookingQuestions(meeting: InstanceMeeting | undefined): string[] {
	return (meeting?.metadata?.questions ?? []).map(questionToText).filter(Boolean);
}

function questionToText(entry: unknown): string {
	if (typeof entry === "string") return entry.trim();
	if (entry && typeof entry === "object") {
		const obj = entry as Record<string, unknown>;
		const question = typeof obj.question === "string" ? obj.question.trim() : "";
		const answer =
			typeof obj.answer === "string"
				? obj.answer.trim()
				: typeof obj.response === "string"
					? obj.response.trim()
					: "";
		if (question && answer) return `${question} — ${answer}`;
		return question || answer;
	}
	return "";
}

function mapMeetingStatus(status: MeetingStatus | undefined): MySession["status"] {
	switch (status) {
		case "AWAITING_CONFIRMATION":
		case "AWAITING_PAYMENT":
			return "requested";
		case "CONFIRMED":
		case "RESCHEDULED":
			return "confirmed";
		case "COMPLETED":
			return "completed";
		case "CANCELLED":
			return "cancelled";
		case "DECLINED":
			return "declined";
		default:
			return "requested";
	}
}

async function fetchMeetingInstances(
	env: Env,
	props: McpUserProps | undefined,
	input: ListMySessionsInput,
): Promise<MeetingInstancesResponse> {
	const baseUrl = requireMeetingsServiceUrl(env);
	requireAuthenticatedUser(props, "list_my_sessions");

	const response = await fetch(buildListMySessionsUrl(baseUrl, input), {
		headers: buildHeaders(props),
	});

	if (!response.ok) {
		const body = await safeJson<CancelMeetingResponse>(response);
		throw new Error(
			`meetings-service sessions returned HTTP ${response.status}${body?.error ? `: ${body.error}` : ""}`,
		);
	}

	return (await response.json()) as MeetingInstancesResponse;
}

function requireMeetingsServiceUrl(env: Env): string {
	const baseUrl = env.MEETINGS_SERVICE_URL;
	if (!baseUrl) throw new Error("MEETINGS_SERVICE_URL is not configured");
	return baseUrl;
}

function requireAuthenticatedUser(props: McpUserProps | undefined, toolName: string): void {
	if (!props?.cognitoAccessToken)
		throw new Error(`${toolName} requires an authenticated ADPList user`);
}

function buildHeaders(props: McpUserProps | undefined): HeadersInit {
	return {
		Accept: "application/json",
		...(props?.cognitoAccessToken
			? { Authorization: `Bearer ${props.cognitoAccessToken}` }
			: {}),
	};
}

async function safeJson<T>(response: Response): Promise<T | undefined> {
	try {
		return (await response.json()) as T;
	} catch {
		return undefined;
	}
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

function normalizeSource(source: string | undefined): string {
	return (source || "web").toLowerCase();
}

function normalizeDuration(duration: number | undefined): number {
	return isFiniteNumber(duration) ? Math.max(1, Math.round(duration)) : 30;
}

function formatLocalDisplay(epochSeconds: number): string {
	return new Intl.DateTimeFormat("en-US", {
		timeZone: "UTC",
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(new Date(epochSeconds * 1000));
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
