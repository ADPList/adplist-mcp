import { z } from "zod";
import { buildMentorStatisticsUrl, mentorSlugFromInput } from "../mentorProfile.ts";
import { asRecord, textOf } from "../profile.ts";
import {
	buildSearchMentorsUrl,
	employerCandidate,
	employerTokens,
	literalNameCandidate,
	mapSearchMentorsResponse,
	nameContainsEveryWord,
	slugifyLiteralName,
	type SearchMentorsInput,
	type SearchServiceMentor,
} from "../searchMentors.ts";
import {
	companyConfirmedByEmployers,
	companyNamedByEmployers,
	currentEmployerGivenTitle,
	isCurrentEmployer,
	knownCompanyIn,
} from "./company.ts";
import { PublicError } from "./errors.ts";
import {
	mapPublicProfile,
	mapPublicSearchMentor,
	type PublicMentor,
	type PublicSearchOutput,
	type PublicStats,
	type WhyMatchContext,
} from "./mapper.ts";
import type { PublicSource } from "./source.ts";
import { checkMentorVisibility, VISIBILITY_TIMEOUT_MS } from "./visibility.ts";

export const DEFAULT_PUBLIC_LIMIT = 5;
export const MAX_PUBLIC_LIMIT = 9;
const SEARCH_TIMEOUT_MS = 5000;

export const publicSearchInputSchema = z.object({
	query: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.describe("What the person is looking for in a mentor, in natural language, or a mentor's name."),
	company: z
		.string()
		.trim()
		.min(1)
		.max(100)
		.optional()
		.describe("Only mentors whose current employer is this company, e.g. Google. Past employers do not count."),
	discipline: z
		.string()
		.trim()
		.min(1)
		.max(100)
		.optional()
		.describe("ADPList discipline, e.g. Product Design or UX Research."),
	country: z
		.string()
		.trim()
		.regex(/^[A-Za-z]{2}$/)
		.optional()
		.describe("ISO 3166-1 alpha-2 country code, e.g. US or SG."),
	language: z
		.string()
		.trim()
		.min(1)
		.max(50)
		.optional()
		.describe("Language the mentor speaks, e.g. Spanish."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(MAX_PUBLIC_LIMIT)
		.optional()
		.describe("Number of mentors to return. Defaults to 5, max 9."),
});

export const publicProfileInputSchema = z.object({
	mentor_slug: z
		.string()
		.trim()
		.min(1)
		.max(300)
		.describe("Mentor slug (e.g. felix-lee) or the mentor's adplist.org/mentors/... profile URL."),
});

export type PublicSearchInput = z.infer<typeof publicSearchInputSchema>;

export type PublicSearchMeta = {
	result_count: number;
	had_company_filter: boolean;
	intent_category: IntentCategory;
};

type Candidate = {
	slug: string;
	row: SearchServiceMentor | null;
	nameMatch?: boolean;
	// Literal slug guesses only count when the record's name is the one asked for.
	requireName?: string;
};

export async function publicSearchMentors(
	env: Env,
	rawInput: unknown,
	source: PublicSource,
): Promise<{ output: PublicSearchOutput; meta: PublicSearchMeta }> {
	const parsed = publicSearchInputSchema.safeParse(rawInput ?? {});
	if (!parsed.success) throw new PublicError("INVALID_INPUT");
	const input = parsed.data;
	const baseUrl = env.SEARCH_SERVICE_URL;
	if (!baseUrl || !env.AUTH_SERVICE_URL) throw new PublicError("UNAVAILABLE");

	const limit = input.limit ?? DEFAULT_PUBLIC_LIMIT;
	const filters = {
		...(input.discipline ? { discipline: input.discipline } : {}),
		...(input.country ? { country: input.country.toUpperCase() } : {}),
		...(input.language ? { language: input.language } : {}),
		max_results: MAX_PUBLIC_LIMIT,
	};
	const searchInput: SearchMentorsInput = { intent: input.query, filters };
	let intentUrl: string;
	try {
		// Also rejects disciplines outside the ADPList taxonomy.
		intentUrl = buildSearchMentorsUrl(baseUrl, searchInput);
	} catch {
		throw new PublicError("INVALID_INPUT");
	}

	// Company = current employer. An explicit `company` always wins. Otherwise a
	// well-known company the query names as the mentor's employer ("PM at Meta",
	// "product manager Google", "google pm") is a filter; tools ("help with
	// Figma") and the requester's own employer ("I work at Google") are not. A
	// query phrase like "mentors at X" or a role-adjacent word becomes one too
	// once a returned mentor's current employer confirms it, or stays one with
	// no current employees when returned mentors name X only as a past
	// employer. A "mentors from X" phrase no row names as an employer at all
	// ("mentors from Canada") only orders, as before.
	let company = input.company ?? knownCompanyIn(input.query);
	let strictCompany = Boolean(company);
	const phrasedCompany = company ? "" : employerCandidate(input.query);
	const nameCandidate = company || phrasedCompany ? "" : literalNameCandidate(input.query);
	const meta = (count: number, byName = false): PublicSearchMeta => ({
		result_count: count,
		had_company_filter: Boolean(company),
		intent_category: intentCategory(input.query, Boolean(company), byName),
	});
	const why: WhyMatchContext = {
		query: input.query,
		discipline: input.discipline,
		language: input.language,
	};

	if (nameCandidate) {
		const nameCandidates: Candidate[] = [];
		if (!input.discipline && !input.country && !input.language) {
			const guess = slugifyLiteralName(nameCandidate);
			if (guess) nameCandidates.push({ slug: guess, row: null, nameMatch: true, requireName: nameCandidate });
		}
		const nameRows = await anonymousSearch(
			buildSearchMentorsUrl(baseUrl, { intent: nameCandidate, filters }),
		).catch(() => null);
		for (const row of nameRows ?? []) {
			if (textOf(row.slug) && nameContainsEveryWord(textOf(row.name), nameCandidate)) {
				nameCandidates.push({ slug: textOf(row.slug), row, nameMatch: true });
			}
		}
		const named = await gateCandidates(env, nameCandidates, source, why, limit);
		if (named.length > 0) return { output: { mentors: named }, meta: meta(named.length, true) };
	}

	const searchCompany = company || phrasedCompany;
	const [firstEmployerSearch, intentRows] = await Promise.all([
		searchCompany ? employerSearch(baseUrl, searchCompany, searchInput, intentUrl) : Promise.resolve(null),
		anonymousSearch(intentUrl)
			.then((rows) => rankRows(rows, searchInput))
			.catch(() => null),
	]);
	let employerRows = searchCompany ? (firstEmployerSearch?.rows ?? null) : [];
	// Every employer the employer search saw, past ones included: evidence that
	// the query names a company even when no row is a current employee.
	const searchedEmployers = firstEmployerSearch?.employers ?? [];
	if (employerRows === null && intentRows === null) throw new PublicError("UNAVAILABLE");
	if (!searchCompany && intentRows === null) throw new PublicError("UNAVAILABLE");

	if (!company) {
		const confirmed = companyConfirmedByEmployers(input.query, [
			...(employerRows ?? []).map(rowCurrentEmployer),
			...(intentRows ?? []).map(rowCurrentEmployer),
		]);
		if (confirmed) {
			company = confirmed;
			strictCompany = true;
			if (employerTokens(confirmed) !== employerTokens(phrasedCompany)) {
				employerRows = (await employerSearch(baseUrl, confirmed, searchInput, intentUrl))?.rows ?? null;
			}
		} else {
			// Every match is a past employer: still a filter, never unfiltered.
			const named = companyNamedByEmployers(input.query, [
				...searchedEmployers,
				...(intentRows ?? []).map(rowEmployer),
			]);
			if (named) {
				company = named;
				strictCompany = true;
			} else if (phrasedCompany) {
				company = phrasedCompany;
			}
		}
	}
	why.company = company || undefined;

	// A company filter, not a hint: rows at other current employers are
	// dropped before gating (so they cannot take the ≤9 slots), and every
	// mapped card is checked again after the identity record has had its say
	// on the company. Past employers never count, including a company field
	// the title marks as past ("Former Director of UX" at Google).
	const atRequiredCompany = (value: string, title: string) =>
		!strictCompany || isCurrentEmployer(value, company, title);
	const candidates: Candidate[] = [...(employerRows ?? []), ...(intentRows ?? [])]
		.filter((row) => atRequiredCompany(rowEmployer(row), textOf(row.title)))
		.filter((row) => textOf(row.slug))
		.map((row) => ({ slug: textOf(row.slug), row }));
	const mentors = (await gateCandidates(env, candidates, source, why, MAX_PUBLIC_LIMIT))
		.filter((mentor) => atRequiredCompany(mentor.company ?? "", mentor.title ?? ""))
		.slice(0, limit);
	return { output: { mentors }, meta: meta(mentors.length) };
}

export async function publicGetMentorProfile(
	env: Env,
	rawInput: unknown,
	source: PublicSource,
): Promise<PublicMentor> {
	const parsed = publicProfileInputSchema.safeParse(rawInput ?? {});
	if (!parsed.success) throw new PublicError("INVALID_INPUT");
	const slug = mentorSlugFromInput(parsed.data.mentor_slug);
	if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,99}$/.test(slug)) throw new PublicError("INVALID_INPUT");
	if (!env.AUTH_SERVICE_URL) throw new PublicError("UNAVAILABLE");

	// Hidden, opted out, on break, missing, and unverifiable all look the same.
	const visibility = await checkMentorVisibility(env, slug);
	if (!visibility.visible) throw new PublicError("NOT_FOUND");
	const userId = textOf(visibility.record.userId);
	const stats = userId ? await fetchPublicStats(env.AUTH_SERVICE_URL, userId) : {};
	return mapPublicProfile(visibility.slug, visibility.record, stats, source);
}

// Gate up to MAX_PUBLIC_LIMIT unique candidates in parallel and keep the
// visible ones, in order. A failed or hidden check simply drops the mentor.
async function gateCandidates(
	env: Env,
	candidates: Candidate[],
	source: PublicSource,
	why: WhyMatchContext,
	limit: number,
): Promise<PublicMentor[]> {
	const unique: Candidate[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const key = candidate.slug.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(candidate);
		if (unique.length >= MAX_PUBLIC_LIMIT) break;
	}
	const checks = await Promise.all(
		unique.map((candidate) => checkMentorVisibility(env, candidate.slug).catch(() => null)),
	);
	const mentors: PublicMentor[] = [];
	const emitted = new Set<string>();
	unique.forEach((candidate, index) => {
		const check = checks[index];
		if (!check || !check.visible) return;
		if (
			candidate.requireName &&
			slugifyLiteralName(textOf(check.record.fullName)) !== slugifyLiteralName(candidate.requireName)
		) {
			return;
		}
		const key = check.slug.toLowerCase();
		if (emitted.has(key)) return;
		emitted.add(key);
		mentors.push(
			mapPublicSearchMentor(candidate.row, check.slug, check.record, source, {
				...why,
				nameMatch: candidate.nameMatch,
			}),
		);
	});
	return mentors.slice(0, limit);
}

function rowEmployer(row: SearchServiceMentor): string {
	return textOf(row.employer) || textOf(row.company);
}

// The row's employer, or "" when its title marks that employer as past.
function rowCurrentEmployer(row: SearchServiceMentor): string {
	return currentEmployerGivenTitle(rowEmployer(row), textOf(row.title));
}

// Bare company query, keep rows whose current employer carries every company
// token — the signed-in search's rule, minus any "previously …" tail — then
// apply its domain ranking. `employers` is every returned row's employer text,
// past-marked ones included, for confirming the company itself.
async function employerSearch(
	baseUrl: string,
	company: string,
	searchInput: SearchMentorsInput,
	intentUrl: string,
): Promise<{ rows: SearchServiceMentor[]; employers: string[] } | null> {
	const url = new URL(buildSearchMentorsUrl(baseUrl, { intent: company, filters: searchInput.filters }));
	url.searchParams.set("pageSize", new URL(intentUrl).searchParams.get("pageSize") ?? "9");
	const rows = await anonymousSearch(url.toString()).catch(() => null);
	if (!rows) return null;
	const matching = rows.filter((row) => isCurrentEmployer(rowEmployer(row), company, textOf(row.title)));
	return { rows: rankRows(matching, searchInput), employers: rows.map(rowEmployer) };
}

// Reuse the signed-in mapper only for its filtering and ordering; the rows
// themselves go through the public mapper.
function rankRows(rows: SearchServiceMentor[], input: SearchMentorsInput): SearchServiceMentor[] {
	const bySlug = new Map<string, SearchServiceMentor>();
	for (const row of rows) {
		const slug = textOf(row.slug);
		if (slug && !bySlug.has(slug)) bySlug.set(slug, row);
	}
	const ranked = mapSearchMentorsResponse({ results: rows }, input, false).mentors;
	return ranked
		.map((mentor) => bySlug.get(mentor.slug))
		.filter((row): row is SearchServiceMentor => Boolean(row));
}

// Anonymous by construction: no Authorization header is ever attached.
async function anonymousSearch(url: string): Promise<SearchServiceMentor[]> {
	const response = await fetch(url, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
	});
	if (response.status !== 200) throw new Error("search unavailable");
	const body = asRecord(await response.json());
	if (!Array.isArray(body.results)) throw new Error("search unavailable");
	return body.results.filter(
		(row): row is SearchServiceMentor => Boolean(row) && typeof row === "object" && !Array.isArray(row),
	);
}

async function fetchPublicStats(baseUrl: string, userId: string): Promise<PublicStats> {
	try {
		const response = await fetch(buildMentorStatisticsUrl(baseUrl, { userId }), {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(VISIBILITY_TIMEOUT_MS),
		});
		if (response.status !== 200) return {};
		const reviews = asRecord(asRecord(asRecord(await response.json()).data).reviews);
		return {
			...(typeof reviews.averageRating === "number" ? { average_rating: reviews.averageRating } : {}),
			...(typeof reviews.reviewsCount === "number" ? { total_reviews: reviews.reviewsCount } : {}),
		};
	} catch {
		return {};
	}
}

export type IntentCategory =
	| "company"
	| "name"
	| "design"
	| "product"
	| "engineering"
	| "data"
	| "marketing"
	| "career"
	| "leadership"
	| "other";

const INTENT_PATTERNS: Array<[IntentCategory, RegExp]> = [
	["design", /\b(design|designer|ux|ui|research|figma|portfolio)\b/i],
	["product", /\b(product|pm|pms|roadmap)\b/i],
	["engineering", /\b(engineer|engineering|developer|software|frontend|front-end|backend|back-end|devops|ios|android|code|coding)\b/i],
	["data", /\b(data|analytics|analyst|machine learning|ml|ai)\b/i],
	["marketing", /\b(marketing|growth|brand|seo|sales|gtm|go-to-market)\b/i],
	["career", /\b(career|job|interview|resume|switch|transition|coach|coaching)\b/i],
	["leadership", /\b(leader|leadership|manager|management|executive|founder|startup)\b/i],
];

// Coarse bucket only; the raw query never leaves this function.
export function intentCategory(query: string, hasCompany: boolean, hasName: boolean): IntentCategory {
	if (hasCompany) return "company";
	if (hasName) return "name";
	return INTENT_PATTERNS.find(([, pattern]) => pattern.test(query))?.[0] ?? "other";
}
