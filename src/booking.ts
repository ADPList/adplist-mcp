import type { McpUserProps } from "./types";

export type ListAvailabilityInput = {
	mentor_slug: string;
	days?: number;
};

export type BookSessionInput = {
	mentor_slug: string;
	slot_iso: string;
	note: string;
	queryID?: string;
};

type AvailabilitySlot = {
	startEpoch?: number;
	endEpoch?: number;
};

type AvailabilitySession = {
	sessionId?: string;
	legacyId?: string | number;
	callerTimezone?: string;
	slots?: AvailabilitySlot[];
};

type AvailabilityResponse = {
	timezone?: string;
	sessions?: AvailabilitySession[];
};

type CreateMeetingResponse = {
	meetingId?: string;
	status?: string;
	autoAccepted?: boolean;
	checkoutUrl?: string;
	error?: string;
	message?: string;
};

export type AvailableSlot = {
	mentor_slug: string;
	session_id: string;
	slot_iso: string;
	slot_local_display: string;
	duration_minutes: number;
};

export type ListAvailabilityOutput = {
	slots: AvailableSlot[];
	truncated: boolean;
	timezone: string;
};

export type BookSessionOutput = {
	status: "requested" | "confirmed";
	session_id: string;
	session_url: string;
	expected_confirmation_time: string;
};

const DEFAULT_DAYS = 14;
const MAX_DAYS = 30;
const MAX_SLOTS = 20;

export function normalizeAvailabilityDays(days: number | undefined): number {
	if (days === undefined || !Number.isFinite(days)) return DEFAULT_DAYS;
	return Math.min(MAX_DAYS, Math.max(1, Math.trunc(days)));
}

export function buildAvailabilityUrl(baseUrl: string, mentorSlug: string, days?: number): string {
	const url = new URL(`/availability/${encodeURIComponent(mentorSlug)}`, baseUrl);
	const now = new Date();
	const end = new Date(now.getTime() + normalizeAvailabilityDays(days) * 24 * 60 * 60 * 1000);
	url.searchParams.set("startDate", toDateParam(now));
	url.searchParams.set("endDate", toDateParam(end));
	return url.toString();
}

export function buildCreateMeetingUrl(baseUrl: string): string {
	return new URL("/meetings", baseUrl).toString();
}

export function mapAvailabilityResponse(
	mentorSlug: string,
	response: AvailabilityResponse,
): ListAvailabilityOutput {
	const timezone = response.timezone || "UTC";
	const allSlots = (response.sessions ?? [])
		.flatMap((session) => (session.slots ?? []).map((slot) => ({ session, slot })))
		.filter(({ session, slot }) => session.sessionId && isFiniteEpoch(slot.startEpoch))
		.sort((a, b) => Number(a.slot.startEpoch) - Number(b.slot.startEpoch));

	// Every session type repeats the same start times, so without dedupe the
	// widget shows identical unlabeled slot buttons. Dedupe before the
	// MAX_SLOTS slice so the cap applies to distinct times.
	const seenEpochs = new Set<number>();
	const dedupedSlots = allSlots.filter(({ slot }) => {
		const epoch = Number(slot.startEpoch);
		if (seenEpochs.has(epoch)) return false;
		seenEpochs.add(epoch);
		return true;
	});

	const slots = dedupedSlots.slice(0, MAX_SLOTS).map(({ session, slot }) => {
		const startEpoch = Number(slot.startEpoch);
		const endEpoch = isFiniteEpoch(slot.endEpoch)
			? Number(slot.endEpoch)
			: startEpoch + 30 * 60;
		return {
			mentor_slug: mentorSlug,
			session_id: session.sessionId!,
			slot_iso: new Date(startEpoch * 1000).toISOString(),
			slot_local_display: formatSlotLocalDisplay(
				startEpoch,
				session.callerTimezone || timezone,
			),
			duration_minutes: Math.max(1, Math.round((endEpoch - startEpoch) / 60)),
		};
	});

	return { slots, truncated: dedupedSlots.length > MAX_SLOTS, timezone };
}

export async function listAvailability(
	env: Env,
	props: McpUserProps | undefined,
	input: ListAvailabilityInput,
): Promise<ListAvailabilityOutput> {
	const response = await fetchAvailability(env, props, input);
	return mapAvailabilityResponse(input.mentor_slug, response);
}

export async function bookSession(
	env: Env,
	props: McpUserProps | undefined,
	input: BookSessionInput,
): Promise<BookSessionOutput> {
	const baseUrl = env.MEETINGS_SERVICE_URL;
	if (!baseUrl) throw new Error("MEETINGS_SERVICE_URL is not configured");
	if (!props?.cognitoAccessToken)
		throw new Error("book_session requires an authenticated ADPList user");

	const slotIso = normalizeSlotIso(input.slot_iso);
	const sessionId = await findSessionIdForSlot(env, props, input.mentor_slug, slotIso);
	const createResponse = await fetch(buildCreateMeetingUrl(baseUrl), {
		method: "POST",
		headers: { ...buildHeaders(props), "Content-Type": "application/json" },
		body: JSON.stringify({
			sessionId,
			startDateTime: Math.floor(new Date(slotIso).getTime() / 1000),
			message: input.note.trim(),
			source: "mcp",
			...(input.queryID ? { queryID: input.queryID } : {}),
		}),
	});

	if (!createResponse.ok) {
		const errorBody = await safeJson<CreateMeetingResponse>(createResponse);
		throw new Error(
			`meetings-service booking returned HTTP ${createResponse.status}${errorBody?.error ? `: ${errorBody.error}` : ""}`,
		);
	}

	const created = (await createResponse.json()) as CreateMeetingResponse;
	if (!created.meetingId)
		throw new Error("meetings-service booking response did not include meetingId");
	if (created.checkoutUrl) throw new Error("Paid sessions are out of scope for ADPList MCP v1");

	const status =
		created.autoAccepted || created.status === "CONFIRMED" ? "confirmed" : "requested";
	return {
		status,
		session_id: created.meetingId,
		session_url: `https://adplist.org/meetings/${created.meetingId}`,
		expected_confirmation_time:
			status === "confirmed"
				? "confirmed immediately"
				: "You'll be notified when the mentor confirms.",
	};
}

async function findSessionIdForSlot(
	env: Env,
	props: McpUserProps,
	mentorSlug: string,
	slotIso: string,
): Promise<string> {
	const targetEpoch = Math.floor(new Date(slotIso).getTime() / 1000);
	const availability = await fetchAvailability(env, props, {
		mentor_slug: mentorSlug,
		days: MAX_DAYS,
	});
	const exactSlot = (availability.sessions ?? [])
		.flatMap((session) => (session.slots ?? []).map((slot) => ({ session, slot })))
		.find(
			({ session, slot }) =>
				session.sessionId &&
				isFiniteEpoch(slot.startEpoch) &&
				Number(slot.startEpoch) === targetEpoch,
		);
	if (!exactSlot) {
		throw new Error(
			"Selected slot is no longer available. Ask the user to choose a fresh slot from list_availability.",
		);
	}
	return exactSlot.session.sessionId!;
}

async function fetchAvailability(
	env: Env,
	props: McpUserProps | undefined,
	input: ListAvailabilityInput,
): Promise<AvailabilityResponse> {
	const baseUrl = env.MEETINGS_SERVICE_URL;
	if (!baseUrl) throw new Error("MEETINGS_SERVICE_URL is not configured");

	const response = await fetch(buildAvailabilityUrl(baseUrl, input.mentor_slug, input.days), {
		headers: buildHeaders(props),
	});

	if (!response.ok) {
		throw new Error(`meetings-service availability returned HTTP ${response.status}`);
	}

	return (await response.json()) as AvailabilityResponse;
}

function buildHeaders(props: McpUserProps | undefined): HeadersInit {
	return {
		Accept: "application/json",
		...(props?.cognitoAccessToken
			? { Authorization: `Bearer ${props.cognitoAccessToken}` }
			: {}),
	};
}

function normalizeSlotIso(slotIso: string): string {
	const date = new Date(slotIso);
	if (Number.isNaN(date.getTime())) throw new Error("slot_iso must be a valid ISO 8601 datetime");
	return date.toISOString();
}

function formatSlotLocalDisplay(epochSeconds: number, timezone: string): string {
	try {
		return new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			weekday: "short",
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
			timeZoneName: "short",
		}).format(new Date(epochSeconds * 1000));
	} catch {
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
}

function toDateParam(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function isFiniteEpoch(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

async function safeJson<T>(response: Response): Promise<T | null> {
	try {
		return (await response.json()) as T;
	} catch {
		return null;
	}
}
