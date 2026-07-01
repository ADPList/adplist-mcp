import {
	asRecord,
	combineIntentWithProfile,
	getProfileTextForSearch,
	labelsOf,
	textOf,
} from "./profile.ts";
import type { McpUserProps } from "./types";

export type SearchMentorsFilters = {
	discipline?: string;
	country?: string;
	language?: string;
	experience_level?: string;
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
	experience_level?: string;
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
	sessions_count: number | null;
	next_7_day_slots_count: number | null;
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
const LITERAL_NAME_LOOKUP_TIMEOUT_MS = 2000;
const LITERAL_NAME_STOP_WORDS = new Set([
	"find",
	"show",
	"get",
	"book",
	"with",
	"mentor",
	"mentors",
	"profile",
	"adplist",
]);
const LITERAL_NAME_BLOCKLIST = new Set([
	"product",
	"designer",
	"design",
	"engineering",
	"engineer",
	"marketing",
	"growth",
	"manager",
	"director",
	"executive",
	"senior",
	"lead",
	"coach",
	"career",
]);
const GROWTH_MARKETING_EXPANSION =
	"growth marketing acquisition lifecycle marketing retention activation experimentation conversion optimization demand generation go-to-market marketing analytics";
const SPECIALIST_MARKETING_INTENT =
	/\b(growth marketing|growth marketer|go-to-market|gtm|customer acquisition|user acquisition|retention|lifecycle|activation|demand generation|demand gen|paid media|paid social|performance marketing|seo|sem|conversion|experimentation|marketing analytics|funnel|product growth)\b/i;
const SPECIALIST_MARKETING_SIGNAL =
	/\b(growth marketing|growth marketer|go-to-market|gtm|customer acquisition|user acquisition|retention|lifecycle|activation|demand generation|demand gen|paid media|paid social|performance marketing|seo|sem|conversion|experimentation|marketing analytics|funnel|product growth|growth hacking|account-based marketing|abm)\b/i;
const GROWTH_MARKETING_TOP_UP_INTENT =
	/\b(growth marketing|growth marketer|go-to-market|gtm|customer acquisition|user acquisition|retention|lifecycle|activation|demand generation|demand gen|conversion|experimentation|funnel|product growth)\b/i;

const EXPERIENCE_LEVELS = ["Senior", "Lead", "Director", "Executive"] as const;
type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

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
	if (filters.experience_level) {
		const normalizedLevel = normalizeExperienceLevel(filters.experience_level);
		if (normalizedLevel) url.searchParams.set("level", normalizedLevel.toLowerCase());
	}
	return url.toString();
}

function searchPageSize(input: SearchMentorsInput): number {
	const filters = input.filters ?? {};
	if (
		filters.country ||
		filters.language ||
		filters.experience_level ||
		domainFitRuleFor(input)
	) {
		return FILTERED_CANDIDATE_PAGE_SIZE;
	}
	return normalizeMaxResults(filters.max_results);
}

function expandIntentForSearch(input: SearchMentorsInput): string {
	const trimmed = stripResultCountLanguage(input.intent).trim();
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

function stripResultCountLanguage(intent: string): string {
	return intent
		.replace(/\btop\s+(?:3|three|6|six|9|nine|a few|few)\b/gi, "")
		.replace(
			/\s*(?:and\s+)?\b(?:only|just|exactly)?\s*(?:return|show|give|find|list)\s+(?:me\s+)?(?:only|just|exactly)?\s*(?:3|three|6|six|9|nine|a few|few)\s+(?:mentors?|results?|candidates?)\b/gi,
			"",
		)
		.replace(
			/\s*(?:and\s+)?\b(?:only|just|exactly)\s+(?:3|three|6|six|9|nine|a few|few)\s+(?:mentors?|results?|candidates?)\b/gi,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();
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
		.filter((mentor) => matchesProductManagementFit(mentor, input))
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
	const requestedLevel = requestedExperienceLevel(input);
	const productManagementIntent = hasProductManagementIntent(input);
	if (!rule && !requestedLevel && !productManagementIntent) return mentors;
	return mentors
		.map((mentor, index) => ({
			mentor,
			index,
			score:
				(rule ? domainFitScore(mentor, rule, input) : 0) +
				seniorityFitScore(mentor, requestedLevel) +
				(productManagementIntent ? productManagementFitScore(mentor) : 0),
		}))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map(({ mentor }) => mentor);
}

function requestedExperienceLevel(input: SearchMentorsInput): ExperienceLevel | undefined {
	return normalizeExperienceLevel(input.filters?.experience_level);
}

function normalizeExperienceLevel(value: string | undefined): ExperienceLevel | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return undefined;
	if (/\b(senior|sr\.?|staff|principal)\b/.test(normalized)) return "Senior";
	if (/\b(lead|group)\b/.test(normalized)) return "Lead";
	if (/\b(director|head)\b/.test(normalized)) return "Director";
	if (/\b(executive|vp|vice president|svp|evp|cpo|chief)\b/.test(normalized)) return "Executive";
	return EXPERIENCE_LEVELS.find((level) => level.toLowerCase() === normalized);
}

function seniorityFitScore(
	mentor: SearchServiceMentor,
	requestedLevel: ExperienceLevel | undefined,
): number {
	if (!requestedLevel) return 0;
	const actualLevel = normalizeExperienceLevel(mentor.experience_level);
	const title = (mentor.title ?? "").toLowerCase();
	const bio = (mentor.bio ?? "").toLowerCase();
	const roleText = `${title} ${bio}`;
	let score = 0;
	if (actualLevel === requestedLevel) score += 50;
	if (requestedLevel === "Executive") {
		if (
			/\b(cpo|chief product officer|chief|vp|vice president|svp|evp|head of product|executive)\b/i.test(
				roleText,
			)
		)
			score += 40;
		if (/\b(product manager|pm|designer|engineer|developer)\b/i.test(title)) score -= 12;
	}
	if (requestedLevel === "Director") {
		if (/\b(director|head of|group product manager|gpm)\b/i.test(roleText)) score += 35;
		if (/\b(vp|vice president|cpo|chief product officer)\b/i.test(roleText)) score += 20;
	}
	if (requestedLevel === "Lead") {
		if (/\b(lead|group product manager|gpm|staff|principal)\b/i.test(roleText)) score += 30;
	}
	if (requestedLevel === "Senior") {
		if (
			/\b(senior|sr\.?|staff|principal|lead|director|head of|vp|vice president|cpo)\b/i.test(
				roleText,
			)
		)
			score += 25;
	}
	return score;
}

function hasProductManagementIntent(input: SearchMentorsInput): boolean {
	const haystack = [input.intent, input.filters?.discipline].filter(Boolean).join(" ");
	if (/\b(product design|product marketing)\b/i.test(haystack)) return false;
	return /\b(product management|product managers?|product leaders?|vp of product|head of product|director of product|chief product officer|cpo|group product manager|gpm|technical product manager|product strategy|roadmap|roadmapping)\b/i.test(
		haystack,
	);
}

function matchesProductManagementFit(
	mentor: SearchServiceMentor,
	input: SearchMentorsInput,
): boolean {
	if (!hasProductManagementIntent(input)) return true;
	const text = mentorDomainText(mentor);
	if (hasProductManagementRoleSignal(text) || hasProductManagementDiscipline(text)) return true;
	return !(
		hasGenericProductExpertise(text) &&
		/\b(designer|design|engineer|engineering|developer|data scientist|data analyst|researcher|writer|marketer|marketing|sales|customer success)\b/i.test(
			text.title,
		)
	);
}

function productManagementFitScore(mentor: SearchServiceMentor): number {
	const text = mentorDomainText(mentor);
	let score = 0;
	if (hasProductManagementRoleSignal(text)) score += 30;
	if (hasProductManagementDiscipline(text)) score += 24;
	if (/\b(product strategy|roadmap|roadmapping|prioritization|product discovery)\b/i.test(text.expertise)) {
		score += 8;
	}
	if (hasGenericProductExpertise(text) && !hasProductManagementRoleSignal(text)) score -= 8;
	return score;
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
	if (/\btop\s+(?:3|three|6|six|9|nine|a few|few)\b/i.test(currentRequest)) {
		return false;
	}
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

function hasProductManagementRoleSignal(text: ReturnType<typeof mentorDomainText>): boolean {
	return /\b(product manager|product management|group product manager|gpm|technical product manager|head of product|director of product|vp of product|chief product officer|cpo)\b/i.test(
		text.titleBio,
	);
}

function hasProductManagementDiscipline(text: ReturnType<typeof mentorDomainText>): boolean {
	return /\b(generalist product management|technical product management|growth product management|data product management|platform product management|group product management|ai product management)\b/i.test(
		text.disciplines,
	);
}

function hasGenericProductExpertise(text: ReturnType<typeof mentorDomainText>): boolean {
	return /\bproduct\b/i.test(text.expertise);
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

	const literalNameResult = await searchMentorByLiteralName(env, input);
	if (literalNameResult) return literalNameResult;

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
		bestResult = await topUpWithCanonicalMarketing(
			baseUrl,
			props,
			input,
			bestResult,
			targetResultCount,
		);
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

	bestResult = await topUpWithCanonicalMarketing(
		baseUrl,
		props,
		input,
		bestResult,
		targetResultCount,
	);
	if (bestResult.mentors.length >= targetResultCount) return bestResult;

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

async function searchMentorByLiteralName(
	env: Env,
	input: SearchMentorsInput,
): Promise<SearchMentorsOutput | null> {
	if (!env.AUTH_SERVICE_URL) return null;
	const candidateName = literalNameCandidate(input.intent);
	if (!candidateName) return null;

	const slug = slugifyLiteralName(candidateName);
	if (!slug) return null;

	try {
		const response = await fetch(
			new URL(
				`/users/profile/mentor/${encodeURIComponent(slug)}`,
				env.AUTH_SERVICE_URL,
			).toString(),
			{
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(LITERAL_NAME_LOOKUP_TIMEOUT_MS),
			},
		);
		if (response.status === 404) return null;
		if (!response.ok) return null;

		const profile = asRecord(asRecord(await response.json()).data);
		if (Object.keys(profile).length === 0) return null;
		const returnedName = textOf(profile.fullName);
		if (!isSameLiteralName(candidateName, returnedName)) return null;
		if (!literalProfileMatchesFilters(profile, input.filters)) return null;

		return {
			mentors: [mapLiteralProfileToSearchResult(profile, slug)],
			indexUsed: "profile_lookup",
		};
	} catch {
		return null;
	}
}

function literalNameCandidate(intent: string): string {
	const requestIntent = currentRequestIntent(intent)
		.replace(/[“”]/g, '"')
		.replace(/[’]/g, "'")
		.trim();
	if (!requestIntent) return "";

	const quoted = requestIntent.match(/"([A-Za-z][A-Za-z' -]+ [A-Za-z][A-Za-z' -]+)"/);
	const candidate = quoted?.[1] ?? stripLiteralNameFiller(requestIntent);
	const words = candidate.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
	if (words.length < 2 || words.length > 4) return "";
	if (words.some((word) => LITERAL_NAME_BLOCKLIST.has(word.toLowerCase()))) return "";
	return words.join(" ");
}

function currentRequestIntent(intent: string): string {
	return intent.includes("Current request:")
		? (intent.split("Current request:").pop() ?? intent)
		: intent;
}

function stripLiteralNameFiller(value: string): string {
	const words = value.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
	return words.filter((word) => !LITERAL_NAME_STOP_WORDS.has(word.toLowerCase())).join(" ");
}

function slugifyLiteralName(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function isSameLiteralName(requested: string, returned: string): boolean {
	return slugifyLiteralName(requested) === slugifyLiteralName(returned);
}

function literalProfileMatchesFilters(
	profile: Record<string, unknown>,
	filters: SearchMentorsFilters | undefined,
): boolean {
	if (!filters) return true;
	const experiences = asRecord(profile.experiences);
	const preferences = asRecord(profile.preferences);
	const country = asRecord(profile.country);
	if (filters.country && textOf(country.iso).toUpperCase() !== filters.country.trim().toUpperCase()) {
		return false;
	}
	if (filters.language && !includesIgnoreCase(splitLabels(labelsOf(preferences.languages)), filters.language)) {
		return false;
	}
	if (
		filters.discipline &&
		shouldUseDisciplineFilter(filters.discipline) &&
		!includesIgnoreCase(splitLabels(labelsOf(experiences.disciplines)), filters.discipline)
	) {
		return false;
	}
	const expectedLevel = normalizeExperienceLevel(filters.experience_level);
	if (expectedLevel && normalizeExperienceLevel(labelsOf(experiences.experienceLevel)) !== expectedLevel) {
		return false;
	}
	return true;
}

function mapLiteralProfileToSearchResult(
	profile: Record<string, unknown>,
	slug: string,
): SearchMentorResult {
	const profileDetails = asRecord(profile.profile);
	const experiences = asRecord(profile.experiences);
	const country = asRecord(profile.country);
	const expertise = splitLabels(labelsOf(experiences.expertise)).slice(0, 3);
	return {
		name: textOf(profile.fullName),
		slug,
		title: textOf(profileDetails.title),
		company: textOf(profileDetails.organization),
		expertise,
		rating: null,
		sessions_count: null,
		next_7_day_slots_count: null,
		country_iso: textOf(country.iso).toUpperCase(),
		profile_url: `https://adplist.org/mentors/${encodeURIComponent(slug)}`,
		profile_photo_url: normalizeImageUrl(profileDetails.image),
		why_match: "Exact ADPList mentor profile name match.",
	};
}

function splitLabels(labels: string): string[] {
	return labels ? labels.split(", ").filter(Boolean) : [];
}

async function topUpWithCanonicalMarketing(
	baseUrl: string,
	props: McpUserProps | undefined,
	input: SearchMentorsInput,
	bestResult: SearchMentorsOutput,
	targetResultCount: number,
): Promise<SearchMentorsOutput> {
	const canonicalMarketingInput = marketingTopUpInput(input);
	if (!canonicalMarketingInput || bestResult.mentors.length >= targetResultCount) {
		return bestResult;
	}

	const canonicalMarketingResult = await fetchAndMapSearchMentors(
		baseUrl,
		props,
		canonicalMarketingInput,
		canonicalMarketingInput,
	);
	if (canonicalMarketingResult.mentors.length === 0) return bestResult;

	return mergeSearchMentorOutputs(input, [
		bestResult,
		{
			...canonicalMarketingResult,
			relaxed_filters: [...(input.filters?.discipline ? ["discipline"] : []), "query"],
		},
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
				(mentor.name || mentor.title
					? `${mentor.name}:${mentor.title}`
					: mentor.profile_url);
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
	const inferredExperienceLevel =
		input.filters?.experience_level ?? inferExperienceLevelFromIntent(input.intent);
	if (!inferredCountry && !inferredExperienceLevel) return input;
	return {
		...input,
		filters: {
			...input.filters,
			...(inferredCountry ? { country: inferredCountry } : {}),
			...(inferredExperienceLevel ? { experience_level: inferredExperienceLevel } : {}),
		},
	};
}

function inferExperienceLevelFromIntent(intent: string): ExperienceLevel | undefined {
	const requestIntent = intent.includes("Current request:")
		? (intent.split("Current request:").pop() ?? intent)
		: intent;
	if (
		/\b(cpo|chief product officer|chief .+ officer|vp|vice president|svp|evp|executive)\b/i.test(
			requestIntent,
		)
	)
		return "Executive";
	if (/\b(director|head of product|head of .+)\b/i.test(requestIntent)) return "Director";
	const leadTitleTerms = [
		"lead product",
		"lead designer",
		"lead design",
		"lead engineer",
		"lead engineering",
		"lead marketing",
		"lead growth",
		"tech lead",
		"team lead",
		"product lead",
		"design lead",
		"engineering lead",
		"marketing lead",
		"growth lead",
	];
	if (leadTitleTerms.some((term) => requestIntent.toLowerCase().includes(term))) return "Lead";
	if (/\b(group product manager|gpm)\b/i.test(requestIntent)) return "Lead";
	if (/\b(senior|sr\.?|staff|principal)\b/i.test(requestIntent)) return "Senior";
	return undefined;
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

function marketingTopUpInput(input: SearchMentorsInput): SearchMentorsInput | null {
	const rule = domainFitRuleFor(input);
	if (rule?.name !== "marketing") return null;
	if (!GROWTH_MARKETING_TOP_UP_INTENT.test(input.intent)) return null;
	const inferredInput = withInferredFilters(input);
	const { discipline: _discipline, ...filtersWithoutDiscipline } =
		inferredInput.filters ?? {};
	return {
		...inferredInput,
		intent:
			"growth marketing acquisition retention lifecycle product marketing go-to-market demand generation",
		filters:
			Object.keys(filtersWithoutDiscipline).length > 0 ? filtersWithoutDiscipline : undefined,
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
