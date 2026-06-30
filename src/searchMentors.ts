import { combineIntentWithProfile, getProfileTextForSearch } from "./profile.ts";
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
	bio?: string;
	countryISO?: string;
	country_iso?: string;
	country?: {
		iso?: string;
		name?: string;
	};
	profile?: {
		image?: string;
		imageUrl?: string;
		image_url?: string;
		profileImage?: string;
		profileImageUrl?: string;
		profile_photo_url?: string;
		avatarUrl?: string;
		avatar_url?: string;
		photoUrl?: string;
		photo_url?: string;
		picture?: string;
	};
	image?: string;
	imageUrl?: string;
	image_url?: string;
	profileImage?: string;
	profileImageUrl?: string;
	profile_photo_url?: string;
	avatarUrl?: string;
	avatar_url?: string;
	photoUrl?: string;
	photo_url?: string;
	picture?: string;
	expertise?: string[];
	disciplines?: string[];
	languages?: string[];
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
	country_iso: string;
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
	relaxed_filters?: string[];
};

const DEFAULT_MAX_RESULTS = 6;
const MAX_RESULTS = 9;
const MIN_RESULTS = 3;
const ROW_SIZE = 3;
const FILTERED_CANDIDATE_PAGE_SIZE = 36;
const ALGOLIA_QUERY_MAX_BYTES = 500;

const TAXONOMY_EXPANSIONS: Array<{ pattern: RegExp; expansion: string }> = [
	{
		pattern: /\b(growth marketing|growth marketer|growth)\b/i,
		expansion:
			"growth marketing acquisition lifecycle marketing retention activation experimentation conversion optimization demand generation go-to-market marketing analytics",
	},
	{
		pattern:
			/\b(digital marketing|performance marketing|paid marketing|paid social|sem|seo)\b/i,
		expansion:
			"digital marketing performance marketing paid media paid social SEO SEM content marketing lifecycle marketing demand generation marketing analytics",
	},
	{
		pattern:
			/\b(career coach|career coaching|returnship|returnships|re-entry|reentry|return to work)\b/i,
		expansion:
			"career coaching career transition returnship re-entry return to work job search interview preparation resume LinkedIn confidence after career break",
	},
];

const BROAD_DISCIPLINE_TERMS = [
	"growth marketing",
	"digital marketing",
	"performance marketing",
	"career coaching",
	"career coach",
	"returnship",
	"re-entry",
	"reentry",
];

const DOMAIN_FIT_RULES: Array<{
	name: "marketing" | "career coaching";
	pattern: RegExp;
	strongTerms: string[];
	supportingTerms: string[];
}> = [
	{
		name: "marketing",
		pattern:
			/\b(growth marketing|digital marketing|performance marketing|paid marketing|paid social|sem|seo|lifecycle marketing|retention|acquisition|demand generation)\b/i,
		strongTerms: [
			"growth marketing",
			"digital marketing",
			"performance marketing",
			"marketing",
			"lifecycle",
			"retention",
			"acquisition",
			"demand generation",
			"paid media",
			"paid social",
			"seo",
			"sem",
			"conversion",
			"crm",
			"go-to-market",
		],
		supportingTerms: ["growth", "activation", "experimentation", "analytics", "funnel"],
	},
	{
		name: "career coaching",
		pattern:
			/\b(career coach|career coaching|returnship|returnships|re-entry|reentry|return to work|career break|job search|interview preparation)\b/i,
		strongTerms: [
			"career coach",
			"career coaching",
			"returnship",
			"return to work",
			"career transition",
			"job search",
			"interview",
			"resume",
			"recruiting",
			"recruiter",
			"talent acquisition",
		],
		supportingTerms: ["coach", "coaching", "hiring", "re-entry", "reentry", "career break"],
	},
];

// Results render in a 3-column card grid, so counts snap to full rows (3/6/9).
// Floors rather than rounds so max_results stays an upper bound for callers.
export function normalizeMaxResults(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
	const clamped = Math.min(MAX_RESULTS, Math.max(MIN_RESULTS, Math.trunc(value)));
	return Math.max(MIN_RESULTS, Math.floor(clamped / ROW_SIZE) * ROW_SIZE);
}

export function buildSearchMentorsUrl(baseUrl: string, input: SearchMentorsInput): string {
	const url = new URL("/search", baseUrl);
	const filters = input.filters ?? {};
	const expandedIntent = expandIntentForSearch(input.intent);
	url.searchParams.set("provider", "explore");
	url.searchParams.set("q", clampUtf8Bytes(expandedIntent, ALGOLIA_QUERY_MAX_BYTES));
	url.searchParams.set("page", "1");
	url.searchParams.set("pageSize", String(searchPageSize(input)));
	if (filters.discipline && shouldUseDisciplineFilter(filters.discipline))
		url.searchParams.set("disciplines", filters.discipline.trim().toLowerCase());
	if (filters.country) url.searchParams.set("countries", filters.country.trim().toUpperCase());
	if (filters.language) url.searchParams.set("languages", filters.language.trim().toLowerCase());
	return url.toString();
}

function searchPageSize(input: SearchMentorsInput): number {
	const filters = input.filters ?? {};
	if (filters.country || filters.language || domainFitRuleFor(input)) {
		return FILTERED_CANDIDATE_PAGE_SIZE;
	}
	return normalizeMaxResults(filters.max_results);
}

function expandIntentForSearch(intent: string): string {
	const trimmed = intent.trim();
	const expansions = TAXONOMY_EXPANSIONS.filter(({ pattern }) => pattern.test(trimmed)).map(
		({ expansion }) => expansion,
	);
	return expansions.length > 0
		? `${trimmed}. Related search signals: ${expansions.join("; ")}`
		: trimmed;
}

function shouldUseDisciplineFilter(discipline: string): boolean {
	const normalized = discipline.trim().toLowerCase();
	return !BROAD_DISCIPLINE_TERMS.some((term) => normalized.includes(term));
}

function clampUtf8Bytes(value: string, maxBytes: number): string {
	const encoder = new TextEncoder();
	const encoded = encoder.encode(value);
	if (encoded.length <= maxBytes) return value;

	let bytes = 0;
	let output = "";
	for (const char of value) {
		const codePoint = char.codePointAt(0) ?? 0;
		const charBytes =
			codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
		if (bytes + charBytes > maxBytes) break;
		output += char;
		bytes += charBytes;
	}
	return output.trimEnd();
}

export function mapSearchMentorsResponse(
	response: SearchServiceResponse,
	input: SearchMentorsInput,
): SearchMentorsOutput {
	const maxResults = normalizeMaxResults(input.filters?.max_results);
	const domainRule = domainFitRuleFor(input);
	const candidates = (response.results ?? [])
		.filter((mentor) => matchesRequestedCountry(mentor, input.filters?.country))
		.filter((mentor) => matchesDomainFit(mentor, domainRule));
	const mentors = candidates
		.slice(0, maxResults)
		.map((mentor) => {
			const expertise = Array.isArray(mentor.expertise)
				? mentor.expertise.filter(Boolean).slice(0, 3)
				: [];
			const company = mentor.employer ?? mentor.company ?? "";
			const sessions = numberOrZero(mentor.total_sessions);
			const slots = numberOrZero(mentor.next_7_day_slots_count);
			const countryIso = getMentorCountryIso(mentor);
			const profilePhotoUrl = normalizeImageUrl(
				mentor.profile?.image ??
					mentor.profile?.imageUrl ??
					mentor.profile?.image_url ??
					mentor.profile?.profileImage ??
					mentor.profile?.profileImageUrl ??
					mentor.profile?.profile_photo_url ??
					mentor.profile?.avatarUrl ??
					mentor.profile?.avatar_url ??
					mentor.profile?.photoUrl ??
					mentor.profile?.photo_url ??
					mentor.profile?.picture ??
					mentor.profile_photo_url ??
					mentor.profileImage ??
					mentor.profileImageUrl ??
					mentor.image ??
					mentor.imageUrl ??
					mentor.image_url ??
					mentor.avatarUrl ??
					mentor.avatar_url ??
					mentor.photoUrl ??
					mentor.photo_url ??
					mentor.picture,
			);
			return {
				name: mentor.name ?? "",
				slug: mentor.slug ?? "",
				title: mentor.title ?? "",
				company,
				expertise,
				rating:
					typeof mentor.average_rating === "number" &&
					Number.isFinite(mentor.average_rating)
						? mentor.average_rating
						: null,
				sessions_count: sessions,
				next_7_day_slots_count: slots,
				country_iso: countryIso,
				profile_url: mentor.slug
					? `https://adplist.org/mentors/${mentor.slug}`
					: "https://adplist.org/explore",
				profile_photo_url: profilePhotoUrl,
				why_match: buildWhyMatch(mentor, input),
				queryID: response.queryID,
				position: mentor.position,
			};
		});
	// Drop a partial trailing row so the 3-up grid never renders with gaps;
	// below one full row there is nothing to trim against, so keep what exists.
	const fullRowCount =
		mentors.length > ROW_SIZE
			? Math.floor(mentors.length / ROW_SIZE) * ROW_SIZE
			: mentors.length;
	return {
		mentors: mentors.slice(0, fullRowCount),
		queryID: response.queryID,
		indexUsed: response.indexUsed,
	};
}

function domainFitRuleFor(input: SearchMentorsInput): (typeof DOMAIN_FIT_RULES)[number] | undefined {
	const haystack = [input.intent, input.filters?.discipline].filter(Boolean).join(" ");
	return DOMAIN_FIT_RULES.find((rule) => rule.pattern.test(haystack));
}

function matchesDomainFit(
	mentor: SearchServiceMentor,
	rule: (typeof DOMAIN_FIT_RULES)[number] | undefined,
): boolean {
	if (!rule) return true;
	const text = mentorDomainText(mentor);
	const roleStrongMatches = rule.strongTerms.filter((term) => includesTerm(text.role, term));
	if (roleStrongMatches.length > 0) return true;

	if (rule.name === "marketing") {
		const companyStrongMatches = rule.strongTerms.filter((term) =>
			includesTerm(text.company, term)
		);
		const roleSupportingMatches = rule.supportingTerms.filter((term) =>
			includesTerm(text.role, term)
		);
		return companyStrongMatches.length > 0 && roleSupportingMatches.length > 0;
	}

	const roleHasCoach = ["coach", "coaching"].some((term) => includesTerm(text.role, term));
	const roleHasCareerSignal = ["career", "job search", "interview", "resume", "hiring"].some(
		(term) => includesTerm(text.role, term),
	);
	const companyHasSearchSignal = ["search", "recruiting", "staffing"].some((term) =>
		includesTerm(text.company, term)
	);
	return roleHasCoach && (roleHasCareerSignal || companyHasSearchSignal);
}

function mentorDomainText(mentor: SearchServiceMentor): { role: string; company: string } {
	const role = [
		mentor.title,
		mentor.bio,
		...(mentor.expertise ?? []),
	].join(" ").toLowerCase();
	const company = [mentor.employer, mentor.company].join(" ").toLowerCase();
	return { role, company };
}

function includesTerm(haystack: string, term: string): boolean {
	return haystack.includes(term.toLowerCase());
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

	const firstResult = await fetchAndMapSearchMentors(baseUrl, props, searchInput, input);
	if (firstResult.mentors.length > 0 || !input.filters?.discipline) return firstResult;

	const { discipline: _discipline, ...relaxedFilters } = input.filters;
	const relaxedInput = {
		...input,
		filters: Object.keys(relaxedFilters).length > 0 ? relaxedFilters : undefined,
	};
	const relaxedSearchInput = {
		...searchInput,
		filters: relaxedInput.filters,
	};
	const relaxedResult = await fetchAndMapSearchMentors(
		baseUrl,
		props,
		relaxedSearchInput,
		relaxedInput,
	);
	return {
		...relaxedResult,
		relaxed_filters: ["discipline"],
	};
}

async function fetchAndMapSearchMentors(
	baseUrl: string,
	props: McpUserProps | undefined,
	searchInput: SearchMentorsInput,
	resultInput: SearchMentorsInput,
): Promise<SearchMentorsOutput> {
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

	return mapSearchMentorsResponse((await response.json()) as SearchServiceResponse, resultInput);
}

function buildWhyMatch(mentor: SearchServiceMentor, input: SearchMentorsInput): string {
	const filters = input.filters ?? {};
	const signals: string[] = [];
	const expertise = mentor.expertise ?? [];
	const disciplines = mentor.disciplines ?? [];
	const searchableFields = [
		["title", mentor.title],
		["company", mentor.employer ?? mentor.company],
		["expertise", expertise.join(" ")],
		["discipline", disciplines.join(" ")],
		["bio", mentor.bio],
	] as const;
	const intentTerms = intentSignalTerms(input.intent);
	const matchedFields = searchableFields
		.map(([field, value]) => ({
			field,
			terms: matchedTerms(value, intentTerms).slice(0, 2),
		}))
		.filter((match) => match.terms.length > 0);

	for (const match of matchedFields.slice(0, 2)) {
		signals.push(`${match.field} mentions ${match.terms.join(" and ")}`);
	}

	if (filters.discipline && includesIgnoreCase(mentor.disciplines, filters.discipline)) {
		signals.push(`discipline matches ${filters.discipline}`);
	}
	if (filters.country && matchesRequestedCountry(mentor, filters.country))
		signals.push(`based in ${filters.country.toUpperCase()}`);
	if (filters.language && includesIgnoreCase(mentor.languages, filters.language))
		signals.push(`language matches ${filters.language}`);
	if (signals.length === 0 && mentor.title) signals.push(`relevant ${mentor.title} background`);
	if (signals.length === 0 && expertise.length > 0)
		signals.push(`expertise includes ${expertise.slice(0, 2).join(" and ")}`);
	if (numberOrZero(mentor.next_7_day_slots_count) > 0) signals.push("has availability this week");
	if (signals.length === 0) return "Ranked by ADPList Explore for this career intent.";
	return `${capitalize(signals.slice(0, 2).join("; "))}.`;
}

function getMentorCountryIso(mentor: SearchServiceMentor): string {
	return (mentor.countryISO ?? mentor.country_iso ?? mentor.country?.iso ?? "")
		.trim()
		.toUpperCase();
}

function matchesRequestedCountry(
	mentor: SearchServiceMentor,
	country: string | undefined,
): boolean {
	if (!country) return true;
	return getMentorCountryIso(mentor) === country.trim().toUpperCase();
}

function intentSignalTerms(intent: string): string[] {
	return Array.from(
		new Set(
			intent
				.toLowerCase()
				.match(/[a-z0-9][a-z0-9+#-]{2,}/g)
				?.filter((term) => !STOP_WORDS.has(term)) ?? [],
		),
	).slice(0, 16);
}

const STOP_WORDS = new Set([
	"and",
	"the",
	"for",
	"with",
	"from",
	"into",
	"help",
	"mentor",
	"mentors",
	"mentorship",
	"looking",
	"need",
	"wants",
	"want",
	"someone",
	"career",
]);

function matchedTerms(value: unknown, terms: string[]): string[] {
	if (typeof value !== "string" || !value.trim()) return [];
	const lower = value.toLowerCase();
	return terms.filter((term) => lower.includes(term));
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeImageUrl(value: unknown): string {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (trimmed.startsWith("https://")) return canonicalizeS3Host(trimmed);
	if (trimmed.startsWith("//")) return canonicalizeS3Host(`https:${trimmed}`);
	if (trimmed.startsWith("/")) return `https://adplist.org${trimmed}`;
	return "";
}

// Newer uploads store region-style S3 URLs (adplist-bucket.s3.us-east-2.amazonaws.com),
// but MCP App hosts only allow the global-style host in the widget CSP. The global
// endpoint serves the same objects directly (no redirect), so rewrite to it.
function canonicalizeS3Host(url: string): string {
	return url.replace(
		/^https:\/\/adplist-bucket\.s3\.[a-z0-9-]+\.amazonaws\.com\//,
		"https://adplist-bucket.s3.amazonaws.com/",
	);
}

function includesIgnoreCase(values: string[] | undefined, expected: string): boolean {
	return (values ?? []).some((value) => value.toLowerCase() === expected.toLowerCase());
}

function capitalize(value: string): string {
	return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}
