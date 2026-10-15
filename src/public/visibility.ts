import { textOf } from "../profile.ts";

// Visibility gate for the public tier (ADPLIST-4479).
// After ADPLIST-4485b, flags live on GET /internal/users/profile/{type}/{slug}
// (x-api-key). The anonymous public profile no longer returns is.*.
export const VISIBILITY_TIMEOUT_MS = 3000;

export type VisibilityResult =
	| { visible: true; slug: string; record: Record<string, unknown> }
	| { visible: false; failed: boolean };

const HIDDEN: VisibilityResult = { visible: false, failed: false };
const FAILED: VisibilityResult = { visible: false, failed: true };

export function optOutSlugs(env: Env): Set<string> {
	return new Set(
		(env.PUBLIC_OPT_OUT_SLUGS ?? "")
			.split(",")
			.map((slug) => slug.trim().toLowerCase())
			.filter(Boolean),
	);
}

const REQUIRED_FLAGS = ["active", "mentor"] as const;
const EXCLUSION_FLAGS = ["suspended", "onBreak", "aiSearchOptOut"] as const;

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

export function isVisibleMentorRecord(data: Record<string, unknown>): boolean {
	const is = flagsOf(data);
	return Boolean(
		is &&
			data.status === "active" &&
			is.active === true &&
			is.mentor === true &&
			EXCLUSION_FLAGS.every((flag) => is[flag] === undefined || is[flag] === false),
	);
}

/** Internal visibility URL (ADPLIST-4485b). */
export function internalVisibilityUrl(baseUrl: string, slug: string): string {
	const url = new URL(`/internal/users/profile/mentor/${encodeURIComponent(slug)}`, baseUrl);
	url.search = "";
	url.hash = "";
	return url.toString();
}

/** @deprecated Public URL no longer carries is.* — prefer internalVisibilityUrl. */
export function publicVisibilityUrl(baseUrl: string, slug: string): string {
	const url = new URL(`/users/profile/mentor/${encodeURIComponent(slug)}`, baseUrl);
	url.search = "";
	url.hash = "";
	return url.toString();
}

export async function checkMentorVisibility(env: Env, slug: string): Promise<VisibilityResult> {
	const requested = slug.trim();
	if (!requested) return HIDDEN;
	const denied = optOutSlugs(env);
	if (denied.has(requested.toLowerCase())) return HIDDEN;
	const baseUrl = env.AUTH_SERVICE_URL;
	if (!baseUrl) return FAILED;
	const apiKey = env.IDENTITY_INTERNAL_API_KEY;
	if (!apiKey) return FAILED;

	let data: Record<string, unknown>;
	try {
		const response = await fetch(internalVisibilityUrl(baseUrl, requested), {
			headers: { Accept: "application/json", "x-api-key": apiKey },
			signal: AbortSignal.timeout(VISIBILITY_TIMEOUT_MS),
		});
		if (response.status === 404) return HIDDEN;
		if (response.status === 401 || response.status === 403) return FAILED;
		if (response.status !== 200) return FAILED;
		const body = (await response.json()) as unknown;
		if (!body || typeof body !== "object" || Array.isArray(body)) return FAILED;
		const rawData = (body as { data?: unknown }).data;
		if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) return FAILED;
		data = rawData as Record<string, unknown>;
	} catch {
		return FAILED;
	}

	const is = flagsOf(data);
	if (typeof data.status !== "string" || !is || !hasWellFormedFlags(is)) return FAILED;
	if (!isVisibleMentorRecord(data)) return HIDDEN;

	const canonical = textOf(data.slug) || requested;
	if (denied.has(canonical.toLowerCase())) return HIDDEN;
	return { visible: true, slug: canonical, record: data };
}
