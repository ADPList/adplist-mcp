import { employerTokens } from "../searchMentors.ts";
import { withoutRequesterEmployment } from "./company.ts";

// Role relevance for the public search (ADPLIST-4479). A company search returns
// the right employer but every role there ("UX at Google" brought back network
// and hardware engineers), so the role the query asks for is parsed into
// families and each card is scored on its title first, then its disciplines
// and expertise. Terms are matched as whole words on lowercased text with
// punctuation as spaces ("UX/UI" → "ux ui", "Front-end" → "front end").

export type RoleFamily = "design" | "product" | "engineering" | "data" | "marketing";

type FamilyTerms = { terms: string[]; not?: string[] };

// Families a query can ask for. `not` phrases never count for the family
// ("Hardware Design" is not UX).
const ROLE_FAMILIES: Record<RoleFamily, FamilyTerms> = {
	design: {
		terms: [
			"design", "designer", "designers", "ux", "ui", "uxr", "user experience", "user research",
			"user researcher", "researcher", "researchers", "interaction", "visual", "creative director",
			"art director", "illustrator",
		],
		not: ["hardware design", "system design", "systems design", "chip design", "circuit design"],
	},
	product: {
		terms: [
			"product manager", "product managers", "product management", "pm", "pms", "apm", "gpm", "group pm",
			"product lead", "product owner", "head of product", "vp product", "vp of product",
			"director of product", "product director", "cpo", "chief product officer", "tpm",
			"technical program manager",
		],
	},
	engineering: {
		terms: [
			"engineer", "engineers", "engineering", "software", "swe", "sde", "developer", "developers",
			"programmer", "frontend", "front end", "backend", "back end", "fullstack", "full stack", "devops",
			"sre", "ios", "android", "cto", "tech lead",
		],
	},
	data: {
		terms: [
			"data", "scientist", "scientists", "analyst", "analysts", "analytics", "machine learning", "ml",
			"business intelligence",
		],
	},
	marketing: {
		terms: [
			"marketing", "marketer", "marketers", "seo", "cmo", "growth marketing", "growth marketer",
			"head of growth", "brand manager", "go to market", "gtm",
		],
	},
};

// Roles nobody searches for here but that still place a title clearly
// outside the requested family ("Cyber Security Instructor", "Knowledge
// Strategist"). Titles with none of these and no family term ("Director",
// "Founder") are ambiguous, never a clear mismatch.
const OTHER_ROLE_TERMS = [
	"security", "cybersecurity", "infosec", "operations", "instructor", "teacher", "professor", "lecturer",
	"educator", "trainer", "strategist", "sales", "account executive", "business development", "recruiter",
	"recruiting", "talent acquisition", "hr", "human resources", "finance", "accountant", "banker", "lawyer",
	"attorney", "counsel", "program manager", "project manager", "writer", "copywriter", "customer success",
	"community manager",
];

const FAMILY_NAMES = Object.keys(ROLE_FAMILIES) as RoleFamily[];

const normalize = (value: string) => ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
const hasTerm = (text: string, terms: string[]) => terms.some((term) => text.includes(` ${term} `));

function inFamily(family: RoleFamily, value: string): boolean {
	const { terms, not = [] } = ROLE_FAMILIES[family];
	let text = normalize(value);
	for (const phrase of not) text = text.replaceAll(` ${phrase} `, " ");
	return hasTerm(text, terms);
}

// Families the request asks for: the query without the requester's own
// employment ("I'm a designer at Stripe") or the company, plus the explicit
// discipline. Empty means no role was requested.
export function requestedRoleFamilies(query: string, company = "", discipline = ""): RoleFamily[] {
	let text = normalize(withoutRequesterEmployment(query));
	for (const token of employerTokens(company).split(" ").filter(Boolean)) {
		text = text.replaceAll(` ${token} `, " ");
	}
	return FAMILY_NAMES.filter((family) => inFamily(family, text) || (discipline && inFamily(family, discipline)));
}

export type RoleFit = {
	// 2 for a title in a requested family, +1 for a matching discipline or
	// expertise; higher sorts first.
	score: number;
	// Nothing matches and the title belongs to another role, or the title is
	// ambiguous ("Director") and the disciplines/expertise belong to another.
	mismatch: boolean;
};

export function roleFit(
	families: RoleFamily[],
	card: { title?: string; disciplines?: string[]; expertise?: string[] },
): RoleFit {
	const title = card.title ?? "";
	const labels = [...(card.disciplines ?? []), ...(card.expertise ?? [])];
	const titleMatch = families.some((family) => inFamily(family, title));
	const labelMatch = labels.some((label) => families.some((family) => inFamily(family, label)));
	const elsewhere = (value: string) =>
		FAMILY_NAMES.some((family) => inFamily(family, value)) || hasTerm(normalize(value), OTHER_ROLE_TERMS);
	return {
		score: (titleMatch ? 2 : 0) + (labelMatch ? 1 : 0),
		mismatch: !titleMatch && !labelMatch && (elsewhere(title) || labels.some(elsewhere)),
	};
}
