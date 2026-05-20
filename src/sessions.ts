import type { McpUserProps } from "./types";

export type ListMySessionsInput = {
	scope?: "upcoming" | "past" | "all";
	limit?: number;
};

export type CancelSessionInput = {
	session_id: string;
	reason?: string;
};

type MeetingStatus =
	| "PENDING_PAYMENT"
	| "AWAITING_PAYMENT"
	| "AWAITING_CONFIRMATION"
	| "CONFIRMED"
	| "COMPLETED"
	| "CANCELLED"
	| "DECLINED"
	| "RESCHEDULED"
	| "PAYMENT_TIMEOUT"
	| string;

type MeetingProfile = {
	fullName?: string;
	slug?: string;
};

type MeetingSession = {
	duration?: number;
};

type MeetingInstance = {
	scheduledDate?: number;
	status?: string;
};

type MeetingRecord = {
	meetingId?: string;
	status?: MeetingStatus;
	initialStartDateTime?: number;
	createdAt?: number;
	updatedAt?: number;
	source?: string;
	metadata?: { source?: string };
	mentor?: MeetingProfile;
	meetingInstances?: MeetingInstance[];
	session?: MeetingSession;
};

type MeetingsResponse = {
	meetings?: MeetingRecord[];
};

type CancelMeetingResponse = {
	meeting?: MeetingRecord;
	message?: string;
	error?: string;
	requestId?: string;
};

export type MySession = {
	session_id: string;
	mentor_name: string;
	mentor_slug: string;
	scheduled_at_iso: string;
	scheduled_at_local_display: string;
	duration_minutes: number;
	status: "requested" | "confirmed" | "completed" | "cancelled" | "declined";
	source: string;
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
	session?: MySession;
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

export function buildListMySessionsUrl(baseUrl: string, input: ListMySessionsInput = {}): string {
	const scope = normalizeSessionScope(input.scope);
	const url = new URL("/meetings", baseUrl);
	url.searchParams.set("filter", scope);
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
	const response = await fetchMeetings(env, props, input);
	const scope = normalizeSessionScope(input.scope);
	const limit = normalizeSessionLimit(input.limit);
	return { sessions: (response.meetings ?? []).map(mapMeetingToSession), scope, limit };
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

	const meeting = body?.meeting;
	return {
		cancelled: true,
		cancelled_at_iso: new Date(
			(meeting?.updatedAt ?? Math.floor(Date.now() / 1000)) * 1000,
		).toISOString(),
		...(meeting ? { session: mapMeetingToSession(meeting) } : {}),
	};
}

export function mapMeetingToSession(meeting: MeetingRecord): MySession {
	const sessionId = meeting.meetingId || "";
	const scheduledEpoch = getScheduledEpoch(meeting);
	return {
		session_id: sessionId,
		mentor_name: meeting.mentor?.fullName || "",
		mentor_slug: meeting.mentor?.slug || "",
		scheduled_at_iso: new Date(scheduledEpoch * 1000).toISOString(),
		scheduled_at_local_display: formatLocalDisplay(scheduledEpoch),
		duration_minutes: normalizeDuration(meeting.session?.duration),
		status: mapMeetingStatus(meeting.status),
		source: normalizeSource(meeting.source ?? meeting.metadata?.source),
		session_url: `https://adplist.org/meetings/${sessionId}`,
	};
}

function getScheduledEpoch(meeting: MeetingRecord): number {
	const instances = (meeting.meetingInstances ?? [])
		.filter((instance) => isFiniteNumber(instance.scheduledDate))
		.sort((a, b) => Number(a.scheduledDate) - Number(b.scheduledDate));
	const currentInstance = instances.find((instance) => isCurrentInstanceStatus(instance.status));
	return (
		currentInstance?.scheduledDate ??
		instances[0]?.scheduledDate ??
		meeting.initialStartDateTime ??
		meeting.createdAt ??
		0
	);
}

function isCurrentInstanceStatus(status: string | undefined): boolean {
	return (
		status === "AWAITING_CONFIRMATION" ||
		status === "CONFIRMED" ||
		status === "AWAITING_PAYMENT"
	);
}

function mapMeetingStatus(status: MeetingStatus | undefined): MySession["status"] {
	switch (status) {
		case "AWAITING_CONFIRMATION":
		case "PENDING_PAYMENT":
		case "AWAITING_PAYMENT":
		case "PAYMENT_TIMEOUT":
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

async function fetchMeetings(
	env: Env,
	props: McpUserProps | undefined,
	input: ListMySessionsInput,
): Promise<MeetingsResponse> {
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

	return (await response.json()) as MeetingsResponse;
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
