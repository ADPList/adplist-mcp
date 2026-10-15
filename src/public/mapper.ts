import { asRecord, labelsOf, textOf } from "../profile.ts";
import { employerTokens, type SearchServiceMentor } from "../searchMentors.ts";
import { currentEmployer } from "./company.ts";
import type { PublicSource } from "./source.ts";

// Public mapper (ADPLIST-4479). Every public object is built field by field
// from this allowlist; upstream objects are never spread or passed through.
// Adding a key here is a privacy decision — see docs/public-mcp.md. Session
// totals are deliberately absent: the public profile page does not show them.
export const PUBLIC_MENTOR_KEYS = [
	"name",
	"slug",
	"title",
	"company",
	"expertise",
	"disciplines",
	"languages",
	"country",
	"bio",
	"photo_url",
	"average_rating",
	"total_reviews",
	"profile_url",
	"why_match",
] as const;

export type PublicMentor = {
	name: string;
	slug: string;
	title?: string;
	company?: string;
	expertise: string[];
	disciplines: string[];
	languages: string[];
	country?: string;
	bio?: string;
	photo_url?: string;
	average_rating?: number;
	total_reviews?: number;
	profile_url: string;
	why_match?: string;
};

export type PublicSearchOutput = { mentors: PublicMentor[] };

export type PublicStats = {
	average_rating?: number;
	total_reviews?: number;
};

export type WhyMatchContext = {
	query: string;
	company?: string;
	discipline?: string;
	language?: string;
	nameMatch?: boolean;
};

const BIO_MAX_CHARS = 300;
const TEXT_MAX_CHARS = 160;
const LABEL_MAX_CHARS = 80;
const MAX_LABELS = 10;

export function publicProfileUrl(slug: string, source: PublicSource): string {
	const url = new URL(`https://adplist.org/mentors/${encodeURIComponent(slug)}`);
	url.searchParams.set("utm_source", source);
	url.searchParams.set("utm_medium", "ai_assistant");
	url.searchParams.set("utm_campaign", "mentor_search");
	url.searchParams.set("ref", `ai_${source}`);
	return url.toString();
}

// Only ADPList's own S3 bucket, https, no credentials, port or query string
// (presigned URLs carry signing material in the query).
export function publicPhotoUrl(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) return "";
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return "";
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
	if (!/^adplist-bucket\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)) return "";
	if (url.pathname.length <= 1) return "";
	return `https://adplist-bucket.s3.amazonaws.com${url.pathname}`;
}

// Search result row + the visible identity record → public card.
export function mapPublicSearchMentor(
	row: SearchServiceMentor | null,
	slug: string,
	record: Record<string, unknown>,
	source: PublicSource,
	why: WhyMatchContext,
): PublicMentor {
	const searchRow = asRecord(row);
	const identity = identityFields(record);
	const rowExpertise = cleanLabels(searchRow.expertise);
	const rowDisciplines = cleanLabels(searchRow.disciplines);
	const rowLanguages = cleanLabels(searchRow.languages);
	const rowCountry = asRecord(searchRow.country);
	const mentor = buildMentor({
		name: identity.name || cleanText(searchRow.name),
		slug,
		// Current employment comes from the public profile alone: the search
		// index can be stale, and the company filter reads these two fields. No
		// organization on the profile means no current employer.
		title: identity.title,
		company: identity.company,
		expertise: identity.expertise.length > 0 ? identity.expertise : rowExpertise,
		disciplines: identity.disciplines.length > 0 ? identity.disciplines : rowDisciplines,
		languages: identity.languages.length > 0 ? identity.languages : rowLanguages,
		country:
			identity.country ||
			cleanText(rowCountry.name) ||
			countryDisplayName(
				textOf(searchRow.countryISO) || textOf(searchRow.country_iso) || textOf(rowCountry.iso),
			),
		photo_url: identity.photo_url || publicPhotoUrl(firstRowPhoto(searchRow)),
		stats: {
			average_rating: rating(searchRow.average_rating),
			total_reviews: count(
				searchRow.total_reviews ?? searchRow.reviews_count ?? searchRow.reviewsCount,
			),
		},
		source,
	});
	mentor.why_match = buildPublicWhyMatch(mentor, why);
	return mentor;
}

// Visible identity record + best-effort stats → public profile.
export function mapPublicProfile(
	slug: string,
	record: Record<string, unknown>,
	stats: PublicStats,
	source: PublicSource,
): PublicMentor {
	const identity = identityFields(record);
	return buildMentor({
		...identity,
		slug,
		bio: truncate(cleanText(record.bio, Number.POSITIVE_INFINITY), BIO_MAX_CHARS),
		stats: {
			average_rating: rating(stats.average_rating),
			total_reviews: count(stats.total_reviews),
		},
		source,
	});
}

// why_match only ever cites allowlisted, public fields of the mentor. It never
// mentions availability, sessions, ratings, or ranking.
export function buildPublicWhyMatch(mentor: PublicMentor, context: WhyMatchContext): string {
	if (context.nameMatch) return "Name matches your search.";
	const signals: string[] = [];
	if (mentor.company && context.company && sameWords(mentor.company, context.company)) {
		signals.push(`Works at ${mentor.company}`);
	}
	const terms = queryTerms(context.query);
	if (mentor.title && mentionsAny(mentor.title, terms)) signals.push(`Title: ${mentor.title}`);
	if (
		mentor.company &&
		!signals.some((signal) => signal.startsWith("Works at")) &&
		mentionsAny(mentor.company, terms)
	) {
		signals.push(`Works at ${mentor.company}`);
	}
	const expertise = mentor.expertise.filter((item) => mentionsAny(item, terms)).slice(0, 2);
	if (expertise.length > 0) signals.push(`Expertise in ${expertise.join(" and ")}`);
	const discipline =
		mentor.disciplines.find(
			(item) => context.discipline && item.toLowerCase() === context.discipline.toLowerCase(),
		) ?? mentor.disciplines.find((item) => mentionsAny(item, terms));
	if (discipline) signals.push(`Discipline: ${discipline}`);
	const language = context.language
		? mentor.languages.find((item) => item.toLowerCase() === context.language?.toLowerCase())
		: undefined;
	if (language) signals.push(`Speaks ${language}`);
	if (signals.length > 0) return `${signals.slice(0, 2).join("; ")}.`;
	if (mentor.title && mentor.company) return `${mentor.title} at ${mentor.company}.`;
	if (mentor.title) return `${mentor.title}.`;
	return "Matches your search on ADPList.";
}

function buildMentor(fields: {
	name: string;
	slug: string;
	title: string;
	company: string;
	expertise: string[];
	disciplines: string[];
	languages: string[];
	country: string;
	photo_url: string;
	bio?: string;
	stats: PublicStats;
	source: PublicSource;
}): PublicMentor {
	const mentor: PublicMentor = {
		name: fields.name,
		slug: fields.slug,
		expertise: fields.expertise,
		disciplines: fields.disciplines,
		languages: fields.languages,
		profile_url: publicProfileUrl(fields.slug, fields.source),
	};
	if (fields.title) mentor.title = fields.title;
	// Current employer only: "Google | previously at Meta" is shown as Google.
	const company = currentEmployer(fields.company);
	if (company) mentor.company = company;
	if (fields.country) mentor.country = fields.country;
	if (fields.bio) mentor.bio = fields.bio;
	if (fields.photo_url) mentor.photo_url = fields.photo_url;
	if (fields.stats.average_rating !== undefined)
		mentor.average_rating = fields.stats.average_rating;
	if (fields.stats.total_reviews !== undefined) mentor.total_reviews = fields.stats.total_reviews;
	return mentor;
}

function identityFields(record: Record<string, unknown>) {
	const profile = asRecord(record.profile);
	const experiences = asRecord(record.experiences);
	const preferences = asRecord(record.preferences);
	const country = asRecord(record.country);
	// Some mentors fill `expertise`, others only the ranked variant whose items
	// nest the expertise object one level down (same as mentorProfile.ts).
	const expertise = cleanLabels(labelsOf(experiences.expertise)).length
		? cleanLabels(labelsOf(experiences.expertise))
		: cleanLabels(
				labelsOf(
					(Array.isArray(experiences.rankedExpertise) ? experiences.rankedExpertise : []).map(
						(item) => asRecord(item).expertise,
					),
				),
			);
	return {
		name: cleanText(record.fullName),
		title: cleanText(profile.title),
		company: cleanText(profile.organization),
		expertise,
		disciplines: cleanLabels(labelsOf(experiences.disciplines)),
		languages: cleanLabels(labelsOf(preferences.languages)),
		country: cleanText(country.countryName) || countryDisplayName(textOf(country.iso)),
		photo_url: publicPhotoUrl(profile.image),
	};
}

const ROW_PHOTO_KEYS = [
	"image",
	"imageUrl",
	"image_url",
	"profileImage",
	"profileImageUrl",
	"profile_photo_url",
	"avatarUrl",
	"avatar_url",
	"photoUrl",
	"photo_url",
	"picture",
];

function firstRowPhoto(row: Record<string, unknown>): unknown {
	const nested = asRecord(row.profile);
	for (const source of [nested, row]) {
		for (const key of ROW_PHOTO_KEYS) {
			if (typeof source[key] === "string" && source[key]) return source[key];
		}
	}
	return undefined;
}

function cleanText(value: unknown, max = TEXT_MAX_CHARS): string {
	if (typeof value !== "string") return "";
	return truncate(value.replace(/\s+/g, " ").trim(), max);
}

// Accepts an array of strings or a ", "-joined label string.
function cleanLabels(value: unknown): string[] {
	const items = Array.isArray(value)
		? value
		: typeof value === "string" && value
			? value.split(", ")
			: [];
	const labels: string[] = [];
	for (const item of items) {
		const label = cleanText(item, LABEL_MAX_CHARS);
		if (label && !labels.includes(label)) labels.push(label);
		if (labels.length >= MAX_LABELS) break;
	}
	return labels;
}

// One decimal, as the public profile page shows it (reviewStats.avg 4.81 → 4.8).
function rating(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 5)
		return undefined;
	return Math.round(value * 10) / 10;
}

function count(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.trunc(value);
}

function countryDisplayName(iso: string): string {
	const code = iso.trim().toUpperCase();
	if (!/^[A-Z]{2}$/.test(code)) return "";
	try {
		const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
		return name && name !== code ? name : "";
	} catch {
		return "";
	}
}

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1).trimEnd()}…`;
}

const QUERY_STOP_WORDS = new Set([
	"and",
	"the",
	"for",
	"with",
	"from",
	"into",
	"who",
	"that",
	"help",
	"mentor",
	"mentors",
	"mentorship",
	"looking",
	"need",
	"want",
	"wants",
	"someone",
	"find",
	"work",
	"works",
	"working",
	"adplist",
]);

function queryTerms(query: string): string[] {
	return Array.from(
		new Set(
			query
				.toLowerCase()
				.match(/[a-z0-9][a-z0-9+#]{2,}/g)
				?.filter((term) => !QUERY_STOP_WORDS.has(term)) ?? [],
		),
	).slice(0, 16);
}

function mentionsAny(value: string, terms: string[]): boolean {
	const words = new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9+#]*/g) ?? []);
	return terms.some((term) => words.has(term) || (term.length >= 5 && words.has(term.replace(/s$/, ""))));
}

function sameWords(a: string, b: string): boolean {
	const wanted = employerTokens(b);
	return Boolean(wanted) && employerTokens(a) === wanted;
}
