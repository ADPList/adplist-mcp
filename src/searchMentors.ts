import { combineIntentWithProfile, getProfileTextForSearch } from "./profile";
import type { McpUserProps } from "./types";

export type SearchMentorsFilters = {
	discipline?: string;
	country?: string;
	language?: string;
	max_results?: number;
};

export type SearchMentorsInput = {
	intent: string;
	filters?: SearchMentorsFilters;
};

type SearchServiceMentor = {
	name?: string;
	slug?: string;
	title?: string;
	employer?: string;
	company?: string;
	profile?: { image?: string };
	image?: string;
	profileImage?: string;
	profile_photo_url?: string;
	photoUrl?: string;
	expertise?: string[];
	disciplines?: string[];
	average_rating?: number;
	total_sessions?: number;
	next_7_day_slots_count?: number;
	available_asap?: boolean;
	position?: number;
};

type SearchServiceResponse = {
	results?: SearchServiceMentor[];
	queryID?: string;
	indexUsed?: string;
};

export type SearchMentorResult = {
	name: string;
	slug: string;
	title: string;
	company: string;
	expertise: string[];
	rating: number | null;
	sessions_count: number;
	next_7_day_slots_count: number;
	profile_url: string;
	profile_photo_url: string;
	why_match: string;
	queryID?: string;
	position?: number;
};

export type SearchMentorsOutput = {
	mentors: SearchMentorResult[];
	queryID?: string;
	indexUsed?: string;
};

const DEFAULT_MAX_RESULTS = 6;
const MAX_RESULTS = 8;
const MIN_RESULTS = 5;

export function normalizeMaxResults(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
	return Math.min(MAX_RESULTS, Math.max(MIN_RESULTS, Math.trunc(value)));
}

export function buildSearchMentorsUrl(baseUrl: string, input: SearchMentorsInput): string {
	const url = new URL("/search", baseUrl);
	const filters = input.filters ?? {};
	url.searchParams.set("provider", "explore");
	url.searchParams.set("q", input.intent.trim());
	url.searchParams.set("page", "1");
	url.searchParams.set("pageSize", String(normalizeMaxResults(filters.max_results)));
	if (filters.discipline)
		url.searchParams.set("disciplines", filters.discipline.trim().toLowerCase());
	if (filters.country) url.searchParams.set("countries", filters.country.trim().toUpperCase());
	if (filters.language) url.searchParams.set("languages", filters.language.trim().toLowerCase());
	return url.toString();
}

export function mapSearchMentorsResponse(
	response: SearchServiceResponse,
	input: SearchMentorsInput,
): SearchMentorsOutput {
	const maxResults = normalizeMaxResults(input.filters?.max_results);
	const mentors = (response.results ?? []).slice(0, maxResults).map((mentor) => {
		const expertise = Array.isArray(mentor.expertise)
			? mentor.expertise.filter(Boolean).slice(0, 3)
			: [];
		const company = mentor.employer ?? mentor.company ?? "";
		const sessions = numberOrZero(mentor.total_sessions);
		const slots = numberOrZero(mentor.next_7_day_slots_count);
		const profilePhotoUrl = normalizeImageUrl(
			mentor.profile?.image ??
				mentor.profile_photo_url ??
				mentor.profileImage ??
				mentor.image ??
				mentor.photoUrl,
		);
		return {
			name: mentor.name ?? "",
			slug: mentor.slug ?? "",
			title: mentor.title ?? "",
			company,
			expertise,
			rating:
				typeof mentor.average_rating === "number" && Number.isFinite(mentor.average_rating)
					? mentor.average_rating
					: null,
			sessions_count: sessions,
			next_7_day_slots_count: slots,
			profile_url: mentor.slug
				? `https://adplist.org/mentors/${mentor.slug}`
				: "https://adplist.org/explore",
			profile_photo_url: profilePhotoUrl,
			why_match: buildWhyMatch(mentor, input),
			queryID: response.queryID,
			position: mentor.position,
		};
	});
	return { mentors, queryID: response.queryID, indexUsed: response.indexUsed };
}

export async function searchMentors(
	env: Env,
	props: McpUserProps | undefined,
	input: SearchMentorsInput,
): Promise<SearchMentorsOutput> {
	const baseUrl = env.SEARCH_SERVICE_URL;
	if (!baseUrl) throw new Error("SEARCH_SERVICE_URL is not configured");

	const profileText = await getProfileTextForSearch(env, props).catch(() => "");
	const searchInput = {
		...input,
		intent: combineIntentWithProfile(input.intent, profileText),
	};

	const response = await fetch(buildSearchMentorsUrl(baseUrl, searchInput), {
		headers: {
			Accept: "application/json",
			...(props?.cognitoAccessToken
				? { Authorization: `Bearer ${props.cognitoAccessToken}` }
				: {}),
		},
	});

	if (!response.ok) {
		throw new Error(`search-service returned HTTP ${response.status}`);
	}

	return mapSearchMentorsResponse((await response.json()) as SearchServiceResponse, input);
}

function buildWhyMatch(mentor: SearchServiceMentor, input: SearchMentorsInput): string {
	const filters = input.filters ?? {};
	const signals: string[] = [];
	const expertise = mentor.expertise ?? [];

	if (filters.discipline && includesIgnoreCase(mentor.disciplines, filters.discipline)) {
		signals.push(`matches ${filters.discipline}`);
	}
	if (filters.language) signals.push(`matches requested ${filters.language} language filter`);
	if (expertise.length > 0) signals.push(`strong in ${expertise.slice(0, 2).join(" and ")}`);
	if (mentor.title) signals.push(`relevant ${mentor.title} background`);
	if (mentor.employer) signals.push(`experience at ${mentor.employer}`);
	if (numberOrZero(mentor.next_7_day_slots_count) > 0) signals.push("has availability this week");
	if (signals.length === 0) return "Ranked by ADPList Explore for this career intent.";
	return `${capitalize(signals.slice(0, 2).join("; "))}.`;
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

function includesIgnoreCase(values: string[] | undefined, expected: string): boolean {
	return (values ?? []).some((value) => value.toLowerCase() === expected.toLowerCase());
}

function capitalize(value: string): string {
	return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}
