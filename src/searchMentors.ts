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

const DEFAULT_MAX_RESULTS = 9;
const MAX_RESULTS = 9;
const MIN_RESULTS = 3;
const ROW_SIZE = 3;
const FILTERED_CANDIDATE_PAGE_SIZE = 72;
const ALGOLIA_QUERY_MAX_BYTES = 500;
const MIN_MARKETING_DOMAIN_SCORE = 8;
const GROWTH_MARKETING_EXPANSION =
	"growth marketing acquisition lifecycle marketing retention activation experimentation conversion optimization demand generation go-to-market marketing analytics";
const SPECIALIST_MARKETING_INTENT =
	/\b(growth marketing|growth marketer|go-to-market|gtm|customer acquisition|user acquisition|retention|lifecycle|activation|demand generation|demand gen|paid media|paid social|performance marketing|seo|sem|conversion|experimentation|marketing analytics|funnel|product growth)\b/i;
const SPECIALIST_MARKETING_SIGNAL =
	/\b(growth marketing|growth marketer|go-to-market|gtm|customer acquisition|user acquisition|retention|lifecycle|activation|demand generation|demand gen|paid media|paid social|performance marketing|seo|sem|conversion|experimentation|marketing analytics|funnel|product growth|growth hacking|account-based marketing|abm)\b/i;

const TAXONOMY_EXPANSIONS: Array<{ pattern: RegExp; expansion: string }> = [
	{
		pattern: /\b(growth marketing|growth marketer)\b/i,
		expansion: GROWTH_MARKETING_EXPANSION,
	},
	{
		pattern: /\b(go-to-market|gtm)\b/i,
		expansion:
			"go-to-market GTM product marketing launch strategy positioning demand generation customer acquisition growth marketing product growth",
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
	"growth",
	"growth marketing",
	"digital marketing",
	"performance marketing",
	"career coaching",
	"career coach",
	"returnship",
	"re-entry",
	"reentry",
];

// Source-of-truth taxonomy snapshot from identity-service production discipline mapper.
// Keep broad non-taxonomy prompts (for example "growth marketing") on the existing
// keyword-expansion path, but reject specific unknown discipline facets before search.
const VALID_DISCIPLINES = [
	"Graphic Design",
	"UX Design",
	"UI/ Visual Design",
	"Industrial Design",
	"Motion Design",
	"Game Design",
	"Branding and Identity Design",
	"Multimedia Design",
	"XR Design",
	"3D Design",
	"Design Operations",
	"Service Design",
	"Content Design",
	"Product Design",
	"Interaction Design",
	"Growth Design",
	"Customer Experience (CX)",
	"Generalist Product Management",
	"Technical Product Management",
	"Growth Product Management",
	"Data Product Management",
	"Platform Product Management",
	"Group Product Management",
	"Program Management",
	"Project Management",
	"UX Testing",
	"UX Research",
	"Service Design Research",
	"Front-end",
	"Back-end",
	"Full stack",
	"UX Engineering",
	"AI/ML Engineering",
	"iOS Engineering",
	"Android Engineering",
	"Development Operations",
	"QA Engineer",
	"Architectural Engineering",
	"Security Engineering",
	"Site Reliability",
	"Data Engineering",
	"Data Analysis",
	"Data Scientist",
	"Creative writing",
	"Technical writing",
	"Scriptwriting",
	"Content Strategy",
	"Copywriting",
	"Social media writing",
	"UX writing",
	"Marketing",
	"Branding",
	"Digital Marketing",
	"Content Marketing",
	"Event Marketing",
	"Guerilla Marketing",
	"Growth Hacking",
	"Sales",
	"Business Development",
	"Offline Marketing",
	"Direct Marketing",
	"Account-based Marketing (ABM)",
	"Customer Success Management",
	"Community Management",
	"Product Marketing",
	"Content Creation",
	"Hardware Design",
	"Business Transformation",
	"OutSystems",
	"General Writing",
	"AI Design",
	"Design Systems",
	"Systems Design",
	"Game Development",
	"Natural Language Processing",
	"Computer Vision",
	"Generative AI",
	"AI Product Management",
	"AI Ethics",
];

const VALID_DISCIPLINE_SET = new Set(VALID_DISCIPLINES.map(normalizeDiscipline));

const DOMAIN_FIT_RULES: Array<{
	name: "marketing" | "career coaching";
	pattern: RegExp;
	strongTerms: string[];
	supportingTerms: string[];
}> = [
	{
		name: "marketing",
		pattern:
			/\b(growth marketing|digital marketing|performance marketing|paid marketing|paid social|sem|seo|lifecycle marketing|retention|customer acquisition|user acquisition|demand generation)\b/i,
		strongTerms: [
			"growth marketing",
			"digital marketing",
			"performance marketing",
			"lifecycle",
			"retention",
			"customer acquisition",
			"user acquisition",
			"demand generation",
			"product marketing",
			"growth product management",
			"growth hacking",
			"account-based marketing",
			"paid media",
			"paid social",
			"seo",
			"sem",
			"conversion",
			"crm",
			"go-to-market",
			"product growth",
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
	validateDisciplineFilter(input);
	input = withInferredFilters(input);
	const url = new URL("/search", baseUrl);
	const filters = input.filters ?? {};
	const expandedIntent = expandIntentForSearch(input);
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

function expandIntentForSearch(input: SearchMentorsInput): string {
	const trimmed = input.intent.trim();
	let expansions = TAXONOMY_EXPANSIONS.filter(({ pattern }) => pattern.test(trimmed)).map(
		({ expansion }) => expansion,
	);
	if (input.filters?.discipline?.trim().toLowerCase() === "growth") {
		expansions.push(GROWTH_MARKETING_EXPANSION);
	}
	expansions = Array.from(new Set(expansions));
	return expansions.length > 0
		? `${trimmed}. Related search signals: ${expansions.join("; ")}`
		: trimmed;
}

function shouldUseDisciplineFilter(discipline: string): boolean {
	const normalized = normalizeDiscipline(discipline);
	return !BROAD_DISCIPLINE_TERMS.some((term) => normalized.includes(term));
}

function validateDisciplineFilter(input: SearchMentorsInput): void {
	const discipline = input.filters?.discipline?.trim();
	if (!discipline || !shouldUseDisciplineFilter(discipline)) return;
	if (VALID_DISCIPLINE_SET.has(normalizeDiscipline(discipline))) return;
	const suggestions = suggestedDisciplines(discipline);
	throw new Error(`Unknown discipline "${discipline}". Try: ${suggestions.join(", ")}.`);
}

function suggestedDisciplines(discipline: string): string[] {
	const normalized = normalizeDiscipline(discipline);
	if (normalized === "product management") {
		return [
			"Generalist Product Management",
			"Group Product Management",
			"Technical Product Management",
			"Growth Product Management",
			"Data Product Management",
			"Platform Product Management",
		];
	}
	const tokens = normalized.split(" ").filter((token) => token.length > 2);
	const scored = VALID_DISCIPLINES.map((value) => {
		const candidate = normalizeDiscipline(value);
		let score = 0;
		if (candidate.includes(normalized) || normalized.includes(candidate)) score += 8;
		for (const token of tokens) {
			if (candidate.includes(token)) score += 2;
		}
		return { value, score };
	})
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || a.value.localeCompare(b.value))
		.map(({ value }) => value);
	if (scored.length > 0) return scored.slice(0, 6);
	return [
		"Product Design",
		"Generalist Product Management",
		"Front-end",
		"Data Analysis",
		"Product Marketing",
		"Customer Success Management",
	];
}

function normalizeDiscipline(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
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
	input = withInferredFilters(input);
	const domainRule = domainFitRuleFor(input);
	const resultCount = resultMaxResults(input, domainRule);
	const candidates = (response.results ?? [])
		.filter((mentor) => matchesRequestedCountry(mentor, input.filters?.country))
		.filter((mentor) => matchesDomainFit(mentor, domainRule, input));
	const mentors = rankMentorCandidates(candidates, domainRule, input)
		.slice(0, resultCount)
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

function rankMentorCandidates(
	mentors: SearchServiceMentor[],
	rule: (typeof DOMAIN_FIT_RULES)[number] | undefined,
	input: SearchMentorsInput,
): SearchServiceMentor[] {
	if (!rule) return mentors;
	return mentors
		.map((mentor, index) => ({
			mentor,
			index,
			score: domainFitScore(mentor, rule, input),
		}))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map(({ mentor }) => mentor);
}

function resultMaxResults(
	input: SearchMentorsInput,
	rule: (typeof DOMAIN_FIT_RULES)[number] | undefined = domainFitRuleFor(input),
): number {
	if (rule?.name === "marketing" && !mentionsExplicitResultLimit(input.intent)) {
		return MAX_RESULTS;
	}
	return normalizeMaxResults(input.filters?.max_results);
}

function mentionsExplicitResultLimit(intent: string): boolean {
	const currentRequest = intent.match(/(?:^|\n)Current request:\s*(.+)$/i)?.[1] ?? intent;
	return (
		/\b(?:show|give|find|return|list)\s+(?:me\s+)?(?:exactly|only|just)\s+(?:3|three|6|six|9|nine|a few|few)\b/i.test(
			currentRequest,
		) ||
		/\b(?:exactly|only|just)\s+(?:3|three|6|six|9|nine|a few|few)\s+(?:growth|marketing|mentors?|results?|candidates?)\b/i.test(
			currentRequest,
		) ||
		/\b(?:exactly|only|just)\s+(?:3|three|6|six|9|nine|a few|few)\b/i.test(
			currentRequest,
		)
	);
}

function domainFitScore(
	mentor: SearchServiceMentor,
	rule: (typeof DOMAIN_FIT_RULES)[number],
	input: SearchMentorsInput,
): number {
	const text = mentorDomainText(mentor);
	if (rule.name !== "marketing") {
		return rule.strongTerms.filter((term) => includesTerm(text.role, term)).length * 4;
	}

	return marketingDomainFitScore(text, rule, input);
}

function marketingDomainFitScore(
	text: ReturnType<typeof mentorDomainText>,
	rule: (typeof DOMAIN_FIT_RULES)[number],
	input: SearchMentorsInput,
): number {
	let score = 0;
	for (const term of rule.strongTerms) {
		if (includesTerm(text.title, term)) score += 8;
		if (includesTerm(text.bio, term)) score += 4;
		if (includesTerm(text.expertise, term)) score += 5;
		if (includesTerm(text.disciplines, term)) score += 2;
		if (includesTerm(text.company, term)) score += 1;
	}
	for (const term of rule.supportingTerms) {
		if (includesTerm(text.title, term)) score += 3;
		if (includesTerm(text.bio, term)) score += 1;
		if (includesTerm(text.expertise, term)) score += 2;
		if (includesTerm(text.disciplines, term)) score += 1;
	}
	if (/\bcmo\b/i.test(text.title)) score += 8;
	if (isClearlyNonMarketingTitle(text.title)) score -= 10;
	if (includesTerm(text.title, "marketing")) score += 2;
	if (includesTerm(text.expertise, "marketing")) score += 1;
	if (includesTerm(text.disciplines, "marketing")) score += 1;
	if (hasGrowthRoleSignal(text)) score += 6;
	if (hasSpecialistMarketingIntent(input)) {
		score += specialistMarketingScore(text);
	}
	return score;
}

function isClearlyNonMarketingTitle(title: string): boolean {
	if (
		/\b(marketing|growth|cmo|go-to-market|gtm|demand generation|digital|performance|b2b)\b/i.test(
			title,
		)
	) {
		return false;
	}
	return /\b(architect|engineer|engineering|developer|data scientist|designer|design|infrastructure|head of product|director of product|product manager|product management|customer success|business development|sales|founder|chief executive|ceo|cio|creative|storyteller|ai|expert in residence|coach|mentor|advisor|consultant)\b/i.test(
		title,
	);
}

function domainFitRuleFor(
	input: SearchMentorsInput,
): (typeof DOMAIN_FIT_RULES)[number] | undefined {
	if (input.filters?.discipline?.trim().toLowerCase() === "growth") {
		return DOMAIN_FIT_RULES.find((rule) => rule.name === "marketing");
	}
	if (hasSpecialistMarketingIntent(input)) {
		return DOMAIN_FIT_RULES.find((rule) => rule.name === "marketing");
	}
	const haystack = [input.intent, input.filters?.discipline].filter(Boolean).join(" ");
	return DOMAIN_FIT_RULES.find((rule) => rule.pattern.test(haystack));
}

function matchesDomainFit(
	mentor: SearchServiceMentor,
	rule: (typeof DOMAIN_FIT_RULES)[number] | undefined,
	input: SearchMentorsInput,
): boolean {
	if (!rule) return true;
	const text = mentorDomainText(mentor);

	if (rule.name === "marketing") {
		return matchesMarketingDomainFit(text, rule, input);
	}

	const roleStrongMatches = rule.strongTerms.filter((term) => includesTerm(text.role, term));
	if (roleStrongMatches.length > 0) return true;

	const roleHasCoach = ["coach", "coaching"].some((term) => includesTerm(text.role, term));
	const roleHasCareerSignal = ["career", "job search", "interview", "resume", "hiring"].some(
		(term) => includesTerm(text.role, term),
	);
	const companyHasSearchSignal = ["search", "recruiting", "staffing"].some((term) =>
		includesTerm(text.company, term),
	);
	return roleHasCoach && (roleHasCareerSignal || companyHasSearchSignal);
}

function matchesMarketingDomainFit(
	text: ReturnType<typeof mentorDomainText>,
	rule: (typeof DOMAIN_FIT_RULES)[number],
	input: SearchMentorsInput,
): boolean {
	if (
		hasTalentAcquisitionPollution(text.role) &&
		!hasMarketingCraftSignal(text.titleBio) &&
		!hasMarketingCraftSignal(text.expertise)
	) {
		return false;
	}
	if (
		hasSpecialistMarketingIntent(input) &&
		!hasSpecialistMarketingSignal(text.role) &&
		!(hasProductMarketingIntent(input) && includesTerm(text.role, "product marketing")) &&
		!hasGrowthRoleSignal(text)
	) {
		return false;
	}

	const titleBioStrongMatches = rule.strongTerms.filter((term) =>
		includesTerm(text.titleBio, term),
	);
	if (titleBioStrongMatches.length > 0) {
		return marketingDomainFitScore(text, rule, { intent: "" }) >= MIN_MARKETING_DOMAIN_SCORE;
	}

	const expertiseStrongMatches = rule.strongTerms.filter((term) =>
		includesTerm(text.expertise, term),
	);
	if (expertiseStrongMatches.length > 0) {
		return marketingDomainFitScore(text, rule, { intent: "" }) >= MIN_MARKETING_DOMAIN_SCORE;
	}

	const disciplineStrongMatches = rule.strongTerms.filter((term) =>
		includesTerm(text.disciplines, term),
	);
	if (disciplineStrongMatches.length > 0) {
		return marketingDomainFitScore(text, rule, { intent: "" }) >= MIN_MARKETING_DOMAIN_SCORE;
	}

	if (hasGrowthRoleSignal(text)) {
		return marketingDomainFitScore(text, rule, { intent: "" }) >= MIN_MARKETING_DOMAIN_SCORE;
	}

	const expertiseHasGenericMarketing = includesTerm(text.expertise, "marketing");
	if (expertiseHasGenericMarketing && hasMarketingCraftSignal(text.titleBio)) {
		return marketingDomainFitScore(text, rule, { intent: "" }) >= MIN_MARKETING_DOMAIN_SCORE;
	}

	const companyStrongMatches = rule.strongTerms.filter((term) =>
		includesTerm(text.company, term),
	);
	const titleBioSupportingMatches = rule.supportingTerms.filter((term) =>
		includesTerm(text.titleBio, term),
	);
	return (
		companyStrongMatches.length > 0 &&
		titleBioSupportingMatches.length > 0 &&
		marketingDomainFitScore(text, rule, { intent: "" }) >= MIN_MARKETING_DOMAIN_SCORE
	);
}

function mentorDomainText(mentor: SearchServiceMentor): {
	role: string;
	title: string;
	bio: string;
	titleBio: string;
	expertise: string;
	disciplines: string;
	company: string;
} {
	const title = (mentor.title ?? "").toLowerCase();
	const bio = (mentor.bio ?? "").toLowerCase();
	const titleBio = [title, bio].join(" ").toLowerCase();
	const expertise = (mentor.expertise ?? []).join(" ").toLowerCase();
	const disciplines = (mentor.disciplines ?? []).join(" ").toLowerCase();
	const role = [titleBio, expertise, disciplines].join(" ").toLowerCase();
	const company = [mentor.employer, mentor.company].join(" ").toLowerCase();
	return { role, title, bio, titleBio, expertise, disciplines, company };
}

function includesTerm(haystack: string, term: string): boolean {
	return haystack.includes(term.toLowerCase());
}

function hasTalentAcquisitionPollution(value: string): boolean {
	return /\b(talent acquisition|recruiter|recruiting|sourcing|staffing)\b/i.test(value);
}

function hasMarketingCraftSignal(value: string): boolean {
	return /\b(growth|marketing|lifecycle|retention|customer acquisition|user acquisition|demand generation|paid media|paid social|seo|sem|conversion|crm|go-to-market|activation|funnel|experimentation)\b/i.test(
		value,
	);
}

function hasGrowthRoleSignal(text: ReturnType<typeof mentorDomainText>): boolean {
	return (
		/\bgrowth\b/i.test(text.title) ||
		/\b(product growth|growth product management|growth marketing|growth strategy|growth hacking|platform growth|user growth|growth loops|growth analytics)\b/i.test(
			text.expertise,
		) ||
		/\b(product growth|growth product management|growth marketing|growth hacking|platform growth)\b/i.test(
			text.disciplines,
		)
	);
}

function hasSpecialistMarketingIntent(input: SearchMentorsInput): boolean {
	const haystack = [input.intent, input.filters?.discipline].filter(Boolean).join(" ");
	return SPECIALIST_MARKETING_INTENT.test(haystack);
}

function specialistMarketingScore(text: ReturnType<typeof mentorDomainText>): number {
	let score = 0;
	if (hasSpecialistMarketingSignal(text.title)) score += 14;
	if (hasSpecialistMarketingSignal(text.expertise)) score += 10;
	if (hasSpecialistMarketingSignal(text.bio)) score += 8;
	if (hasSpecialistMarketingSignal(text.disciplines)) score += 5;
	return score;
}

function hasSpecialistMarketingSignal(value: string): boolean {
	return SPECIALIST_MARKETING_SIGNAL.test(value);
}

function hasProductMarketingIntent(input: SearchMentorsInput): boolean {
	const haystack = [input.intent, input.filters?.discipline].filter(Boolean).join(" ");
	return /\bproduct marketing\b/i.test(haystack);
}

export async function searchMentors(
	env: Env,
	props: McpUserProps | undefined,
	input: SearchMentorsInput,
): Promise<SearchMentorsOutput> {
	const baseUrl = env.SEARCH_SERVICE_URL;
	if (!baseUrl) throw new Error("SEARCH_SERVICE_URL is not configured");
	validateDisciplineFilter(input);

	const profileText = await getProfileTextForSearch(env, props).catch(() => "");
	const searchInput = {
		...input,
		intent: combineIntentWithProfile(input.intent, profileText),
	};

	const firstResult = await fetchAndMapSearchMentors(baseUrl, props, searchInput, input);
	let bestResult = firstResult;
	const targetResultCount = resultMaxResults(input);
	const shouldTopUpSparseResults = Boolean(domainFitRuleFor(input));
	if (
		firstResult.mentors.length > 0 &&
		(firstResult.mentors.length >= targetResultCount || !shouldTopUpSparseResults)
	) {
		return firstResult;
	}

	const relaxedInput = inputWithoutDiscipline(input);
	let emptyRelaxedResult: SearchMentorsOutput | null = null;
	if (relaxedInput) {
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
		if (relaxedResult.mentors.length > 0) {
			bestResult = mergeSearchMentorOutputs(input, [
				bestResult,
				{ ...relaxedResult, relaxed_filters: ["discipline"] },
			]);
			if (bestResult.mentors.length >= targetResultCount) return bestResult;
		} else {
			emptyRelaxedResult = relaxedResult;
		}
	}

	if (!profileText.trim()) {
		if (bestResult.mentors.length > 0) return bestResult;
		return emptyRelaxedResult
			? { ...emptyRelaxedResult, relaxed_filters: ["discipline"] }
			: firstResult;
	}

	const bareResult = await fetchAndMapSearchMentors(baseUrl, props, input, input);
	if (bareResult.mentors.length > 0) {
		bestResult = mergeSearchMentorOutputs(input, [
			bestResult,
			{ ...bareResult, relaxed_filters: ["profile_context"] },
		]);
		if (bestResult.mentors.length >= targetResultCount) return bestResult;
	}

	if (!relaxedInput) {
		return bestResult.mentors.length > 0
			? bestResult
			: { ...bareResult, relaxed_filters: ["profile_context"] };
	}

	const bareRelaxedResult = await fetchAndMapSearchMentors(
		baseUrl,
		props,
		relaxedInput,
		relaxedInput,
	);
	return mergeSearchMentorOutputs(input, [
		bestResult,
		{ ...bareRelaxedResult, relaxed_filters: ["profile_context", "discipline"] },
	]);
}

function mergeSearchMentorOutputs(
	input: SearchMentorsInput,
	outputs: SearchMentorsOutput[],
): SearchMentorsOutput {
	const mentors: SearchMentorResult[] = [];
	const seen = new Set<string>();
	const relaxedFilters = new Set<string>();

	for (const output of outputs) {
		for (const filter of output.relaxed_filters ?? []) relaxedFilters.add(filter);
		for (const mentor of output.mentors) {
			const key =
				mentor.slug ||
				(mentor.name || mentor.title ? `${mentor.name}:${mentor.title}` : mentor.profile_url);
			if (seen.has(key)) continue;
			seen.add(key);
			mentors.push(mentor);
		}
	}

	const maxResults = resultMaxResults(input);
	const limitedMentors = mentors.slice(0, maxResults);
	const fullRowCount =
		limitedMentors.length > ROW_SIZE
			? Math.floor(limitedMentors.length / ROW_SIZE) * ROW_SIZE
			: limitedMentors.length;
	const returnedMentors = limitedMentors.slice(0, fullRowCount);
	const queryIDs = new Set(returnedMentors.map((mentor) => mentor.queryID).filter(Boolean));
	const indexUsedValues = new Set(outputs.map((output) => output.indexUsed).filter(Boolean));
	const firstOutput = outputs.find((output) => output.mentors.length > 0) ?? outputs[0] ?? {};
	return {
		mentors: returnedMentors,
		...(queryIDs.size === 1 ? { queryID: Array.from(queryIDs)[0] } : {}),
		...(indexUsedValues.size === 1
			? { indexUsed: Array.from(indexUsedValues)[0] }
			: firstOutput.indexUsed
				? { indexUsed: firstOutput.indexUsed }
				: {}),
		...(relaxedFilters.size > 0 ? { relaxed_filters: Array.from(relaxedFilters) } : {}),
	};
}

function withInferredFilters(input: SearchMentorsInput): SearchMentorsInput {
	const inferredCountry = input.filters?.country ?? inferCountryFromIntent(input.intent);
	if (!inferredCountry) return input;
	return {
		...input,
		filters: {
			...input.filters,
			country: inferredCountry,
		},
	};
}

function inferCountryFromIntent(intent: string): string | undefined {
	const requestIntent = intent.includes("Current request:")
		? (intent.split("Current request:").pop() ?? intent)
		: intent;
	if (mentionsNonUsIntent(requestIntent)) return undefined;
	if (/\bUS\b/.test(requestIntent)) return "US";
	if (/\bU\.S\.?\b/i.test(requestIntent)) return "US";
	if (/\bU\.S\.A\.?\b/i.test(requestIntent)) return "US";
	if (/\bUSA\b/i.test(requestIntent)) return "US";
	if (/\bUnited States\b/i.test(requestIntent)) return "US";
	return undefined;
}

function mentionsNonUsIntent(intent: string): boolean {
	const usPattern = String.raw`(?:US|U\.S\.?|U\.S\.A\.?|USA|United States)`;
	return new RegExp(
		String.raw`\b(?:not|outside|except|excluding|exclude|non[-\s]?|not based in|outside of)\b.{0,40}\b${usPattern}\b`,
		"i",
	).test(intent);
}

function inputWithoutDiscipline(input: SearchMentorsInput): SearchMentorsInput | null {
	if (!input.filters?.discipline) return null;
	const { discipline: _discipline, ...relaxedFilters } = input.filters;
	return {
		...input,
		filters: Object.keys(relaxedFilters).length > 0 ? relaxedFilters : undefined,
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
	const intentTerms = intentSignalTerms(expandIntentForSearch(input));
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
	"related",
	"signal",
	"signals",
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
