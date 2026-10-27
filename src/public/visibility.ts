import { textOf } from "../profile.ts";

// Visibility gate for the public tier (ADPLIST-4479). Every public path —
// search results, literal-name lookups, slug lookups — goes through
// checkMentorVisibility. It makes two identity-service reads in parallel:
//  - GET /internal/users/profile/mentor/{slug} (x-api-key, ADPLIST-4485) is the
//    authoritative source for the visibility flags and canonical slug. It
//    carries nothing displayable: no name, profile, experiences or country.
//  - GET /users/profile/mentor/{slug} (anonymous) carries the display fields
//    and current employer, but no longer the is.* flags.
// Anything short of two well-formed records with a clearly visible verdict
// omits the mentor (fail closed). A failure to reach identity (network error,
// timeout, 429/5xx, missing config) that the other read does not already
// settle as hidden or malformed is also marked `unreachable`, so a
// caller can tell an outage from a hidden or malformed mentor; it still shows
// nothing.
export const VISIBILITY_TIMEOUT_MS = 3000;

export type VisibilityResult =
	| {
			visible: true;
			slug: string;
			// From the internal record; server-side only (stats lookup), never mapped.
			userId: string;
			// The anonymous public profile: the only source of display fields.
			record: Record<string, unknown>;
	  }
	| { visible: false; failed: boolean; unreachable?: true };

const HIDDEN: VisibilityResult = { visible: false, failed: false };
const FAILED: VisibilityResult = { visible: false, failed: true };
const UNREACHABLE: VisibilityResult = { visible: false, failed: true, unreachable: true };

export function optOutSlugs(env: Env): Set<string> {
	return new Set(
		(env.PUBLIC_OPT_OUT_SLUGS ?? "")
			.split(",")
			.map((slug) => slug.trim().toLowerCase())
			.filter(Boolean),
	);
}

// Exclusion flags may be absent (aiSearchOptOut is new), but when present they
// must be real booleans: "true", 1 or null are unexpected shapes and hide the
// mentor rather than reading as "not excluded".
const REQUIRED_FLAGS = ["active", "mentor"] as const;
const EXCLUSION_FLAGS = ["suspended", "onBreak", "aiSearchOptOut"] as const;
// Top-level listing flags, checked on both records under the same rule:
// absent is fine, present must be a boolean, and false hides the mentor.
const LISTING_FLAGS = ["bookable", "indexable"] as const;

function flagsOf(data: Record<string, unknown>): Record<string, unknown> | null {
	const is = data.is;
	return is && typeof is === "object" && !Array.isArray(is) ? (is as Record<string, unknown>) : null;
}

function hasWellFormedFlags(is: Record<string, unknown>): boolean {
	return (
		REQUIRED_FLAGS.every((flag) => typeof is[flag] === "boolean") &&
		EXCLUSION_FLAGS.every((flag) => is[flag] === undefined || typeof is[flag] === "boolean")
	);
}

function hasWellFormedListingFlags(data: Record<string, unknown>): boolean {
	return LISTING_FLAGS.every((flag) => data[flag] === undefined || typeof data[flag] === "boolean");
}

function isListed(data: Record<string, unknown>): boolean {
	return LISTING_FLAGS.every((flag) => data[flag] === undefined || data[flag] === true);
}

export function isVisibleMentorRecord(data: Record<string, unknown>): boolean {
	const is = flagsOf(data);
	return Boolean(
		is &&
			data.status === "active" &&
			isListed(data) &&
			is.active === true &&
			is.mentor === true &&
			EXCLUSION_FLAGS.every((flag) => is[flag] === undefined || is[flag] === false),
	);
}

// Both URLs are built here, not with mentorProfile.ts's builder, so every check
// is the bare record URL: no query string (e.g. syncFromLegacy, which would
// let an anonymous read trigger a legacy sync), no fragment, and a slug that
// cannot smuggle its own `?`, `#` or `/` in.
export function internalVisibilityUrl(baseUrl: string, slug: string): string {
	const url = new URL(`/internal/users/profile/mentor/${encodeURIComponent(slug)}`, baseUrl);
	url.search = "";
	url.hash = "";
	return url.toString();
}

export function publicVisibilityUrl(baseUrl: string, slug: string): string {
	const url = new URL(`/users/profile/mentor/${encodeURIComponent(slug)}`, baseUrl);
	url.search = "";
	url.hash = "";
	return url.toString();
}

type Fetched = Record<string, unknown> | "hidden" | "failed" | "unreachable";

// 200 with an object `data` → the record; 404 → hidden; a thrown fetch
// (timeout included), 429 or 5xx, or a body whose read is cut short →
// unreachable; anything else, a 3xx or a body that is not valid JSON included,
// has failed: identity answered, so a bad body is malformed, not an outage.
async function fetchRecord(url: string, init: RequestInit): Promise<Fetched> {
	let response: Response;
	try {
		response = await fetch(url, { ...init, signal: AbortSignal.timeout(VISIBILITY_TIMEOUT_MS) });
	} catch {
		return "unreachable";
	}
	if (response.status === 404) return "hidden";
	if (response.status === 429 || response.status >= 500) return "unreachable";
	if (response.status !== 200) return "failed";
	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		// Only invalid JSON is identity answering badly; a body read cut short
		// (timeout or abort DOMException, stream TypeError) is unreachable.
		return error instanceof SyntaxError ? "failed" : "unreachable";
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) return "failed";
	const rawData = (body as { data?: unknown }).data;
	if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) return "failed";
	return rawData as Record<string, unknown>;
}

export async function checkMentorVisibility(env: Env, slug: string): Promise<VisibilityResult> {
	const requested = slug.trim();
	if (!requested) return HIDDEN;
	const denied = optOutSlugs(env);
	if (denied.has(requested.toLowerCase())) return HIDDEN;
	const baseUrl = env.AUTH_SERVICE_URL;
	if (!baseUrl) return UNREACHABLE;
	// Required Worker secret for the keyed internal record below. Unset, every
	// mentor past the opt-out list fails closed as unreachable (UNAVAILABLE).
	// Setup, preview and production: README.md "Required Worker configuration"
	// and "Public tier preview" (`wrangler secret put IDENTITY_INTERNAL_API_KEY`);
	// the endpoint and the rules: docs/public-mcp.md "Visibility".
	const apiKey = env.IDENTITY_INTERNAL_API_KEY;
	if (!apiKey) return UNREACHABLE;

	const [flags, display] = await Promise.all([
		fetchRecord(internalVisibilityUrl(baseUrl, requested), {
			headers: { Accept: "application/json", "x-api-key": apiKey },
			// Never follow redirects: a 3xx would re-send x-api-key to its target.
			redirect: "manual",
		}),
		// Anonymous on purpose: no Authorization header or API key on this read.
		fetchRecord(publicVisibilityUrl(baseUrl, requested), {
			headers: { Accept: "application/json" },
			redirect: "manual",
		}),
	]);
	if (flags === "failed" || display === "failed") return FAILED;
	if (flags === "hidden" || display === "hidden") return HIDDEN;
	// One read may be unreachable while the other already proves the mentor
	// hidden or malformed. Everything either record settles on its own is
	// checked first; only a verdict that still needs the missing record is
	// `unreachable`.
	const internal = typeof flags === "object" ? flags : null;
	const shown = typeof display === "object" ? display : null;

	if (internal) {
		const is = flagsOf(internal);
		if (typeof internal.status !== "string" || !is || !hasWellFormedFlags(is)) return FAILED;
		if (!hasWellFormedListingFlags(internal)) return FAILED;
	}
	if (shown) {
		if (!hasWellFormedListingFlags(shown)) return FAILED;
		if (shown.status !== undefined && typeof shown.status !== "string") return FAILED;
	}
	if (internal && !isVisibleMentorRecord(internal)) return HIDDEN;
	if (shown && (!isListed(shown) || (shown.status !== undefined && shown.status !== "active"))) {
		return HIDDEN;
	}

	// The internal record's slug is the canonical one, and is checked against
	// the kill list too, so a case or alias variant cannot slip past it. It
	// must be a real string: a missing or malformed slug fails closed rather
	// than falling back to the one asked for. The display record must describe
	// the same mentor and carry the display fields mapping relies on; a
	// missing or malformed slug, name or profile fails closed rather than
	// falling back to search-row data.
	let canonical = "";
	if (internal) {
		if (typeof internal.slug !== "string") return FAILED;
		canonical = internal.slug.trim();
		if (!canonical) return FAILED;
		if (denied.has(canonical.toLowerCase())) return HIDDEN;
	}
	let displaySlug = "";
	if (shown) {
		displaySlug = textOf(shown.slug);
		if (!displaySlug || !textOf(shown.fullName)) return FAILED;
		const profile = shown.profile;
		if (!profile || typeof profile !== "object" || Array.isArray(profile)) return FAILED;
	}
	if (!internal || !shown) return UNREACHABLE;
	if (displaySlug.toLowerCase() !== canonical.toLowerCase()) return FAILED;
	return { visible: true, slug: canonical, userId: textOf(internal.userId), record: shown };
}
