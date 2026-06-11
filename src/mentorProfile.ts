import { asRecord, labelsOf, textOf } from "./profile.ts";

export type GetMentorProfileInput = {
	mentor_slug: string;
};

export type MentorReviewSnippet = {
	rating: number | null;
	text: string;
	date_iso: string;
};

export type GetMentorProfileOutput = {
	slug: string;
	name: string;
	title: string;
	employer: string;
	country: string;
	bio: string;
	expertise: string[];
	disciplines: string[];
	languages: string[];
	open_to: string[];
	on_break: boolean;
	experience_level: string;
	stats: {
		average_rating: number | null;
		reviews_count: number | null;
	};
	recent_reviews: MentorReviewSnippet[];
	profile_url: string;
};

const BIO_MAX_CHARS = 1200;
const REVIEW_TEXT_MAX_CHARS = 300;
const MAX_REVIEWS = 5;

export function buildMentorProfileUrl(baseUrl: string, mentorSlug: string): string {
	return new URL(
		`/users/profile/mentor/${encodeURIComponent(mentorSlug.trim())}`,
		baseUrl,
	).toString();
}

export function buildMentorStatisticsUrl(baseUrl: string, userId: string): string {
	const url = new URL("/users/statistics", baseUrl);
	url.searchParams.set("userId", userId);
	url.searchParams.set("type", "mentor");
	return url.toString();
}

export function buildMentorReviewsUrl(baseUrl: string, userId: string): string {
	const url = new URL("/users/review", baseUrl);
	url.searchParams.set("userId", userId);
	url.searchParams.set("type", "mentor");
	url.searchParams.set("target", "for");
	url.searchParams.set("limit", String(MAX_REVIEWS));
	return url.toString();
}

// Public mentor profile for agentic candidate comparison (ADPLIST-3203).
// Deliberately unauthenticated: scoped by construction to what the public
// mentor page already shows. Stats and reviews are best-effort — a hiccup in
// either must not take down the profile itself.
export async function getMentorProfile(
	env: Env,
	input: GetMentorProfileInput,
): Promise<GetMentorProfileOutput> {
	const baseUrl = env.AUTH_SERVICE_URL;
	if (!baseUrl) throw new Error("AUTH_SERVICE_URL is not configured");
	const slug = input.mentor_slug.trim();
	if (!slug) throw new Error("mentor_slug is required");

	const profileResponse = await fetch(buildMentorProfileUrl(baseUrl, slug), {
		headers: { Accept: "application/json" },
	});
	if (profileResponse.status === 404) {
		throw new Error(`No ADPList mentor found for slug "${slug}".`);
	}
	if (!profileResponse.ok) {
		throw new Error(`mentor profile lookup returned HTTP ${profileResponse.status}`);
	}
	const data = asRecord(((await profileResponse.json()) as { data?: unknown }).data);
	if (Object.keys(data).length === 0) {
		throw new Error(`No ADPList mentor found for slug "${slug}".`);
	}

	const userId = typeof data.userId === "string" ? data.userId : "";
	const [stats, recentReviews] = await Promise.all([
		userId ? fetchMentorStats(baseUrl, userId) : NO_STATS,
		userId ? fetchMentorReviews(baseUrl, userId) : Promise.resolve([]),
	]);

	const profile = asRecord(data.profile);
	const experiences = asRecord(data.experiences);
	const preferences = asRecord(data.preferences);
	const country = asRecord(data.country);
	const is = asRecord(data.is);

	// Some mentors fill `expertise`, others only the ranked variant whose
	// items nest the expertise object one level down.
	const expertise =
		labelsOf(experiences.expertise) ||
		labelsOf(
			(Array.isArray(experiences.rankedExpertise) ? experiences.rankedExpertise : []).map(
				(item) => asRecord(item).expertise,
			),
		);

	return {
		slug,
		name: textOf(data.fullName),
		title: textOf(profile.title),
		employer: textOf(profile.organization),
		country: textOf(country.countryName),
		bio: truncate(textOf(data.bio), BIO_MAX_CHARS),
		expertise: splitLabels(expertise),
		disciplines: splitLabels(labelsOf(experiences.disciplines)),
		languages: splitLabels(labelsOf(preferences.languages)),
		open_to: splitLabels(labelsOf(preferences.openTo ?? preferences.interests)),
		on_break: is.onBreak === true,
		experience_level: labelsOf(experiences.experienceLevel),
		stats,
		recent_reviews: recentReviews,
		profile_url: `https://adplist.org/mentors/${encodeURIComponent(slug)}`,
	};
}

const NO_STATS = Promise.resolve({ average_rating: null, reviews_count: null });

async function fetchMentorStats(
	baseUrl: string,
	userId: string,
): Promise<GetMentorProfileOutput["stats"]> {
	try {
		const response = await fetch(buildMentorStatisticsUrl(baseUrl, userId), {
			headers: { Accept: "application/json" },
		});
		if (!response.ok) return { average_rating: null, reviews_count: null };
		const body = (await response.json()) as {
			data?: { reviews?: { reviewsCount?: unknown; averageRating?: unknown } };
		};
		const reviews = body.data?.reviews;
		return {
			average_rating:
				typeof reviews?.averageRating === "number"
					? Math.round(reviews.averageRating * 100) / 100
					: null,
			reviews_count: typeof reviews?.reviewsCount === "number" ? reviews.reviewsCount : null,
		};
	} catch {
		return { average_rating: null, reviews_count: null };
	}
}

async function fetchMentorReviews(
	baseUrl: string,
	userId: string,
): Promise<MentorReviewSnippet[]> {
	try {
		const response = await fetch(buildMentorReviewsUrl(baseUrl, userId), {
			headers: { Accept: "application/json" },
		});
		if (!response.ok) return [];
		const body = (await response.json()) as { data?: unknown };
		const data = body.data;
		const items = Array.isArray(data)
			? data
			: Array.isArray(asRecord(data).reviews)
				? (asRecord(data).reviews as unknown[])
				: [];
		return items
			.map((item) => asRecord(item))
			.filter((item) => textOf(item.review) && item.status !== "inactive")
			.slice(0, MAX_REVIEWS)
			.map((item) => ({
				rating: typeof item.rating === "number" ? item.rating : null,
				text: truncate(textOf(item.review), REVIEW_TEXT_MAX_CHARS),
				date_iso: epochMillisToIso(item.createdOn),
			}));
	} catch {
		return [];
	}
}

function epochMillisToIso(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
	return new Date(value).toISOString();
}

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1).trimEnd()}…`;
}

function splitLabels(labels: string): string[] {
	return labels ? labels.split(", ").filter(Boolean) : [];
}
