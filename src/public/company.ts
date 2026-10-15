import { employerCandidate, employerTokens } from "../searchMentors.ts";

// Company handling for the public search (ADPLIST-4479). Company always means
// the mentor's CURRENT employer: the search row's employer or the identity
// record's profile.organization, cut before any "previously"/"formerly"/"ex-"
// tail. Work history and bio never count.

// A separator (or the start) followed by a past-employer marker. A bare "Ex "
// needs punctuation before it, so "Design Ex Machina" stays whole.
const PAST_EMPLOYER_MARKER =
	/(?:^|[\s|,;/·•([–—-])\s*(?:previously|formerly|former\b|prev\b\.?|past\b|retired\b|ex[-–])|[|,;/·•([–—-]\s*ex\s/i;

// Text that opens as past: "Former Director of UX", "Ex Google PM", "- Retired
// VP". Checked only at the start of a title, company, or title segment, so
// "Executive", "Pastry" and "Design Ex Machina" never match. The match takes
// any connecting words after the marker ("Retired from", "Formerly at", "Ex @")
// so stripping it leaves just the company.
const PAST_START =
	/^[\s\p{P}\p{S}]*(?:(?:former(?:ly)?|previously|prev|past|retired)\b|ex(?=[\s.\-–—]))(?:\s*(?:(?:from|at|of|with)(?=\s)|[@:\-–—]))*/iu;

// Title segments: "Advisor | Former Director at Google", "PM (Ex-Google)".
const TITLE_SEGMENT = /[|,;/·•()[\]]|\s[–—-]\s/;

// "Google | previously at Meta" → "Google"; "ex-Databricks" → ""; "Former
// Google" → "".
export function currentEmployer(value: string): string {
	if (PAST_START.test(value)) return "";
	const cut = value.search(PAST_EMPLOYER_MARKER);
	const head = cut >= 0 ? value.slice(0, cut) : value;
	return head.replace(/[\s|,;/·•([–—-]+$/, "").trim();
}

// The company a past-marked title segment names, as tokens, or "" when it
// names none: "Former Director at Acme" → "acme", "Ex-Google PM" → "google",
// "Retired from Google" → "google", "Former Google PM" → "google", "Former
// Director of UX" and "Past President" → "". Right after "ex" or a connecting
// word the leading non-role words are the company; after "Former", "Past" and
// the like only a well-known company is.
function pastSegmentCompany(segment: string): string {
	const marker = segment.match(PAST_START)?.[0] ?? "";
	const role = segment.slice(marker.length).trim();
	const at = role.match(/(?:\s(?:at|with)\s+|@\s*)(.+)$/i);
	if (at) return employerTokens(at[1]);
	if (/^[\s\p{P}\p{S}]*ex\b|(?:\b(?:from|at|with)|@)\s*$/iu.test(marker)) {
		const words = role.match(WORD) ?? [];
		const lead = words.findIndex((word) => NON_COMPANY_WORDS.has(bare(word)));
		return employerTokens(words.slice(0, lead < 0 ? words.length : lead).join(" "));
	}
	return employerTokens(knownCompanyPrefix(role));
}

// One employer contains the other on whole leading tokens ("Google" and
// "Google DeepMind").
const sameEmployer = (a: string, b: string) => a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);

// True when the title says the company field is a past employer: the title
// opens as a past role that names that company or no company at all ("Former
// Director of UX", "Ex-Google PM" at Google), or a later segment is past and
// names that company ("Advisor | Former Director at Google"). A past role at
// another company ("Ex-Google PM | Design Lead at Meta", "Former Director at
// Acme" at Google) leaves the company field current.
export function titleMarksEmployerPast(title: string, companyText: string): boolean {
	const employer = employerTokens(currentEmployer(companyText));
	const segments = title.split(TITLE_SEGMENT).filter((segment) => segment.trim());
	if (PAST_START.test(title) && segments.length > 0) {
		const named = pastSegmentCompany(segments[0]);
		if (!named || !employer || sameEmployer(named, employer)) return true;
	}
	if (!employer) return false;
	return segments.slice(1).some(
		(segment) => PAST_START.test(segment) && ` ${employerTokens(segment)} `.includes(` ${employer} `),
	);
}

// The company field as a current employer, or "" when the title marks it past.
export function currentEmployerGivenTitle(companyText: string, title: string): string {
	return titleMarksEmployerPast(title, companyText) ? "" : currentEmployer(companyText);
}

// Current-employer match on whole tokens, with the signed-in search's token
// rule: the employer must start with every company token. "Google" matches
// "Google DeepMind"; "Google DeepMind" matches neither "Google" nor
// "Google Cloud"; "Snap" never matches "Snapchat". A past-marked title
// ("Former Director of UX") means the company field is not current.
export function isCurrentEmployer(companyText: string, company: string, title = ""): boolean {
	const wanted = employerTokens(company);
	if (!wanted) return false;
	const have = employerTokens(currentEmployerGivenTitle(companyText, title));
	return have === wanted || have.startsWith(`${wanted} `);
}

// A well-known company the phrase starts with, in display form: "Google" for
// "google", "Google DeepMind" for "Google DeepMind" (the full phrase is kept;
// only an exact match takes the canonical spelling).
function knownCompanyPrefix(phrase: string): string {
	const tokens = employerTokens(phrase).split(" ");
	for (let n = tokens.length; n >= 1; n -= 1) {
		const known = KNOWN_COMPANIES.get(tokens.slice(0, n).join(" "));
		if (known) return n === tokens.length ? known : phrase;
	}
	return "";
}

// Well-known employers that may be named bare in a query ("google pm"). Keyed
// by employerTokens; the value is the display / search form.
const KNOWN_COMPANIES = new Map(
	[
		"Google", "Meta", "Facebook", "Apple", "Amazon", "AWS", "Microsoft", "Netflix", "Airbnb", "Uber",
		"Lyft", "Stripe", "Spotify", "Shopify", "LinkedIn", "Salesforce", "Adobe", "Figma", "Atlassian",
		"Canva", "Grab", "Shopee", "Gojek", "Tokopedia", "TikTok", "ByteDance", "OpenAI", "Anthropic",
		"Nvidia", "Intel", "IBM", "Oracle", "PayPal", "Pinterest", "Snap", "Dropbox", "Slack", "Notion",
		"Booking.com", "Expedia", "Deloitte", "McKinsey", "Accenture", "IDEO", "Revolut", "Wise", "Klarna",
		"Coinbase", "Databricks", "Snowflake", "Twilio", "Zendesk", "HubSpot", "Intuit", "Samsung",
		"Visa", "Mastercard", "Goldman Sachs", "JPMorgan", "Duolingo", "Instacart", "DoorDash",
	].map((name) => [employerTokens(name), name]),
);

// Words that describe a role, level, field, or request, never an employer.
// A candidate made of any of them is not a company ("product manager" alone).
const NON_COMPANY_WORDS = new Set(
	`a an the and or of for to with in on at from by about as my me i im someone anyone people person
	who that which works work working worked currently looking find finding need needs want wants help
	advice mentor mentors mentorship mentoring coach coaching career careers job jobs interview interviews
	product products manager managers management pm pms apm tpm gpm owner design designer designers
	ux ui uxr research researcher researchers engineer engineers engineering developer developers dev
	software data scientist scientists science analyst analysts analytics marketing marketer growth
	sales founder founders cofounder ceo cto cpo cmo coo vp head director directors lead leads leader
	leaders leadership senior sr junior jr staff principal mid entry level intern interns associate
	executive startup startups fintech ai ml frontend backend fullstack mobile web app apps ios android
	content brand visual graphic interaction user users experience strategy strategic b2b b2c saas
	remote big tech company companies ex former previously transition switch switching portfolio
	review resume cv hiring recruiter recruiting operations ops program project consultant consulting
	using use uses via tool tools skill skills learn learning based located living near around area
region city country`.split(
		/\s+/,
	),
);

// Role words that make a neighbouring company an employer: "google pm",
// "product manager Google", "ux designer Initech".
const ROLE_WORDS = new Set(
	`pm pms apm tpm gpm manager managers designer designers engineer engineers developer developers dev
	devs swe sde researcher researchers scientist scientists analyst analysts marketer marketers founder
	founders lead leads leader leaders director directors recruiter recruiters mentor mentors product
	design engineering ux ui uxr`.split(/\s+/),
);

// Products and skills people learn, not employers: "help with Figma", "Figma
// designer", "Canva designer". Some are also companies; only an explicit
// at/from/@ phrase makes one of these a company.
const TOOL_WORDS = new Set(
	`figma canva notion miro webflow framer airtable salesforce hubspot tableau excel jira python sql
	sketch photoshop illustrator invision zeplin asana trello confluence javascript typescript react`.split(/\s+/),
);

// The requester's own employment, as a whole first-person clause: "I work at
// Google", "I'm PM at Meta", "Im currently a designer with Acme", "we are at
// Stripe", "my team is at Airbnb", "my company is Acme". The company there is
// who is asking, never who they want. The clause ends at punctuation or a
// clause word ("and", "but", "need", "looking"), so "I'm at Stripe, looking
// for a PM at Google" still wants Google. Past employment counts the same:
// "I was at Google", "I used to work at Google", "I worked at Google", "I'm a
// designer, previously at Google", or a query that opens "Previously at
// Google, …" — the requester's history, never a mentor-employer filter.
const CLAUSE_STOP = String.raw`(?:and|but|so|need|needs|looking|seeking|want|wants|hoping|trying|interested|find|finding|talk|speak|connect|meet|reach|who|that|which|mentor|mentors|someone|anyone|people)\b`;
const CLAUSE_WORD = String.raw`[A-Za-z0-9&'-]+(?:\.[A-Za-z0-9&'-]+)*`;
const CLAUSE_WORDS = String.raw`(?:\s+(?!${CLAUSE_STOP})${CLAUSE_WORD})`;
const SELF_ADVERB = String.raw`(?:\s+(?:currently|now|previously|formerly|once|recently|also))?`;
const SELF_SUBJECT = String.raw`(?:i\s*'\s*m|i\s+am|im|we\s*'\s*re|we\s+are|(?:my|our)\s+team\s+is|(?:i|we)(?:\s*'\s*ve|\s+have)?(?:\s+been)?${SELF_ADVERB}\s+(?:work|works|working|worked|employed)|(?:i|we)${SELF_ADVERB}\s+(?:was|were|used\s+to(?:\s+(?:work|be))?))`;
const SELF_COMPANY = String.raw`(?:the\s+)?${CLAUSE_WORD}${CLAUSE_WORDS}*`;
const SELF_EMPLOYMENT = new RegExp(
	[
		String.raw`\b${SELF_SUBJECT}${CLAUSE_WORDS}*?(?:\s*[,(]?\s*(?:previously|formerly))?(?:\s+(?:at|for|with|by)\s+|\s*@\s*)${SELF_COMPANY}`,
		String.raw`\b(?:my|our)\s+(?:current\s+)?(?:company|employer|workplace|org|organization|organisation)(?:\s+is|\s*[:,])?\s+${SELF_COMPANY}`,
		String.raw`^\s*(?:previously|formerly)\s+(?:(?:at|with)\s+|@\s*)${SELF_COMPANY}`,
	].join("|"),
	"gi",
);

// Skill or proficiency phrasing: "get better at Figma", "good at Google Ads",
// "experience at Stripe", "skilled with SQL". What follows is something the
// requester wants to learn or has done, never the mentor's employer.
const SKILL_PHRASE = new RegExp(
	String.raw`\b(?:better|best|good|great|bad|worse|stronger|skilled|skillful|proficient|expert|experienced|competent|confident|comfortable|fluent|improve|improving|skills?|experience|expertise|proficiency|background)\s+(?:at|with|in)\s+(?:the\s+)?[A-Za-z0-9][A-Za-z0-9&.'-]*(?:\s+[A-Za-z0-9][A-Za-z0-9&.'-]*){0,2}`,
	"gi",
);

// Words before a bare at/from that make a tool-named company an employer:
// "designers at Figma", "people at Notion". Anything else ("help at Figma")
// leaves the tool a tool.
const EMPLOYEE_WORDS = new Set(
	`people folks someone anyone employees staff team experts professionals`.split(/\s+/),
);

// The signed-in search's employer phrase ("mentors at Acme"), cut before a
// tool clause: "mentors at Acme using Figma" → "Acme", not "Acme using Figma".
// A place is never one: "mentors from Canada" → "".
export function employerPhrase(query: string): string {
	const phrase = employerCandidate(query).split(/(?:^|\s+)(?:using|via)\b/i)[0].trim();
	return isPlacePhrase(phrase) ? "" : phrase;
}

// Typographic apostrophes and quotes to ASCII, so "I’m a PM at Google" reads
// like "I'm a PM at Google".
const asciiQuotes = (value: string) => value.replace(/[’‘ʼ‛′`]/g, "'").replace(/[“”„‟″]/g, '"');

// The query with the requester's own employment clauses blanked out: "I'm a
// designer at Stripe, looking for a PM" is a request for a PM.
export function withoutRequesterEmployment(query: string): string {
	return asciiQuotes(query).replace(SELF_EMPLOYMENT, " | ");
}

const WORD = /[A-Za-z0-9][A-Za-z0-9&.'-]*/g;
const bare = (word: string) => word.toLowerCase().replace(/[.']+$/, "");

// Words ignored when the whole query may be a company: "mentors Google",
// "people at Google DeepMind".
const QUERY_FILLER_WORDS = new Set(["mentors", "mentor", "people", "at"]);

// The whole query, fillers dropped, when it is or starts with a well-known
// company that is not also a tool: "Google", "Google DeepMind", "mentors
// Google". "Canva" alone stays something to learn.
function wholeQueryCompany(query: string): string {
	const words = (query.match(WORD) ?? []).filter((word) => !QUERY_FILLER_WORDS.has(bare(word)));
	if (words.length === 0 || TOOL_WORDS.has(bare(words[0]))) return "";
	return knownCompanyPrefix(words.join(" ")) ? words.join(" ") : "";
}

// The phrases in the query that could name the mentor's employer, most
// explicit first. `explicit`: a whole query that is a well-known company
// ("Google DeepMind"), the employer phrase ("mentors at Google") and
// at/from/@ phrases ("PM at Meta", "designer from Airbnb"). `implied`: 1–3
// words at either end next to a role word ("product manager Google", "google
// pm"), never a tool. The requester's own employer is removed first. Phrases
// containing a role or filler word are dropped.
function companyPhrases(query: string): { explicit: string[]; implied: string[] } {
	const text = asciiQuotes(query).replace(SELF_EMPLOYMENT, " | ").replace(SKILL_PHRASE, " | ");
	const seen: string[] = [];
	// True when the value is a usable company phrase (even if already seen).
	const collect = (into: string[], value: string, allowTools: boolean): boolean => {
		const words = value.match(WORD) ?? [];
		if (words.length === 0 || words.length > 3) return false;
		if (words.some((word) => NON_COMPANY_WORDS.has(bare(word)))) return false;
		if (!allowTools && words.some((word) => TOOL_WORDS.has(bare(word)))) return false;
		const phrase = words.join(" ");
		// A place is where the mentor is, never who employs them; it also ends
		// the shrinking, so "from New York" never yields "New".
		if (isPlacePhrase(phrase)) return true;
		if (!seen.some((existing) => employerTokens(existing) === employerTokens(phrase))) {
			seen.push(phrase);
			into.push(phrase);
		}
		return true;
	};
	const explicit: string[] = [];
	collect(explicit, wholeQueryCompany(text), false);
	collect(explicit, employerPhrase(text), true);
	for (const match of text.matchAll(/(?:\b(?:at|from)\s+|@\s*)([A-Za-z0-9][A-Za-z0-9&.'-]*(?:\s+[A-Za-z0-9][A-Za-z0-9&.'-]*){0,2})/gi)) {
		// Shrink from the right only past clause words: "Meta in London" → "Meta",
		// but "Google DeepMind" stays whole and never also yields "Google".
		// A tool after a bare at/from is an employer only after a role or people
		// word: "designers at Figma", not "help at Figma". "@ Figma" always is.
		const preceding = text.slice(0, match.index).match(WORD) ?? [];
		const before = bare(preceding[preceding.length - 1] ?? "");
		const allowTools = match[0].startsWith("@") || ROLE_WORDS.has(before) || EMPLOYEE_WORDS.has(before);
		const words = match[1].match(WORD) ?? [];
		for (let n = words.length; n >= 1; n -= 1) {
			if (collect(explicit, words.slice(0, n).join(" "), allowTools)) break;
		}
	}
	const implied: string[] = [];
	const words = text.match(WORD) ?? [];
	const isRole = (word: string | undefined) => word !== undefined && ROLE_WORDS.has(bare(word));
	for (let n = Math.min(3, words.length - 1); n >= 1; n -= 1) {
		if (isRole(words[words.length - n - 1])) collect(implied, words.slice(words.length - n).join(" "), false);
		if (isRole(words[n])) collect(implied, words.slice(0, n).join(" "), false);
	}
	return { explicit, implied };
}

export function companyCandidates(query: string): string[] {
	const { explicit, implied } = companyPhrases(query);
	return [...explicit, ...implied];
}

// A company the query names as the mentor's employer that is, or starts with,
// a well-known company: "Google", or the full "Google DeepMind". An explicit
// at/from phrase wins: when there is one, role-adjacent words are not
// consulted ("mentors at Acme using Figma" is about Acme).
export function knownCompanyIn(query: string): string {
	const { explicit, implied } = companyPhrases(query);
	for (const candidate of explicit.length > 0 ? explicit : implied) {
		const known = knownCompanyPrefix(candidate);
		if (known) return known;
	}
	return "";
}

// A candidate that some returned mentor's current employer starts with. An
// exact match takes that mentor's spelling; a prefix match keeps the query's
// phrase, so "Acme" confirmed by an "Acme Labs" mentor still means all of
// Acme. "product manager" never becomes a company.
export function companyConfirmedByEmployers(query: string, employers: string[]): string {
	const current = employers.map(currentEmployer).filter(Boolean);
	for (const candidate of companyCandidates(query)) {
		const wanted = employerTokens(candidate);
		const exact = current.find((employer) => employerTokens(employer) === wanted);
		if (exact) return exact;
		if (current.some((employer) => isCurrentEmployer(employer, candidate))) return candidate;
	}
	return "";
}

// Employer text splits in two levels. Segments are whole entries: "Stripe |
// Former Acme (Europe)" → "Stripe", "Former Acme (Europe)"; a past marker also
// opens a new segment ("Stripe previously at Google"). Fragments split a
// segment further on brackets and a standalone "at": "Designer at Initech" →
// "Designer", "Initech". Connecting words count only as standalone tokens, so
// "AT&T", "At Home" and "Atlassian" stay whole; a bare "ex" mid-segment never
// splits, so "Design Ex Machina" does too.
const EMPLOYER_SEGMENTS = /[|,;/·•]|\s[–—-]\s|(?=\b(?:previously|formerly|former|prev|past|retired)\b|\bex[-–])/i;
const EMPLOYER_FRAGMENTS = /[()[\]]|\sat\s/i;

// Places that appear as an office or region next to an employer ("Acme
// (Canada)", "Stripe | Remote", "Grab (APAC)"): every country name and ISO
// code, regions, and common office cities. As a separate segment or fragment
// they never name an employer, so "mentors from Canada" stays a place.
const LOCATION_NAMES = new Set(
	[
		"usa", "uk", "uae", "eu", "europe", "emea", "apac", "asia", "asia pacific", "southeast asia",
		"latam", "latin america", "north america", "south america", "americas", "africa", "middle east", "mena",
		"anz", "nordics", "dach", "benelux", "remote", "global", "worldwide", "international", "hq", "hong kong",
		"london", "new york", "nyc", "san francisco", "sf", "bay area", "silicon valley", "seattle", "austin",
		"boston", "chicago", "los angeles", "toronto", "vancouver", "montreal", "berlin", "paris", "amsterdam",
		"dublin", "lisbon", "madrid", "barcelona", "stockholm", "zurich", "munich", "tokyo", "seoul", "beijing",
		"shanghai", "shenzhen", "jakarta", "kuala lumpur", "bangkok", "manila", "ho chi minh city", "bangalore",
		"bengaluru", "mumbai", "delhi", "new delhi", "hyderabad", "pune", "chennai", "gurgaon", "gurugram", "noida",
		"dubai", "lagos", "nairobi", "cape town", "sydney", "melbourne", "auckland", "sao paulo", "mexico city",
		"bogota", "buenos aires",
	].map(employerTokens),
);
// Everyday country names ICU spells differently or not at all, as ISO codes.
const COUNTRY_ALIASES: [string, string][] = [
	["uk", "GB"], ["britain", "GB"], ["great britain", "GB"], ["england", "GB"], ["scotland", "GB"],
	["wales", "GB"], ["us", "US"], ["usa", "US"], ["america", "US"], ["united states of america", "US"],
	["uae", "AE"], ["korea", "KR"], ["south korea", "KR"], ["turkey", "TR"], ["russia", "RU"],
	["vietnam", "VN"], ["czech republic", "CZ"], ["holland", "NL"], ["ivory coast", "CI"], ["macau", "MO"],
];
// Region codes ICU names that are not countries.
const NON_COUNTRY_CODES = new Set(["EU", "EZ", "UN", "QO", "XA", "XB", "ZZ"]);
let countryCodes: Map<string, string> | undefined;

// The ISO code for a country name, code or alias in employerTokens form
// ("canada", "ca", "united kingdom", "uk" → "GB"), else "".
function countryCodeOf(tokens: string): string {
	if (!countryCodes) {
		countryCodes = new Map();
		const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
		let displayNames: Intl.DisplayNames | undefined;
		try {
			displayNames = new Intl.DisplayNames(["en"], { type: "region" });
		} catch {
			// No ICU region names: the aliases and fixed list still apply.
		}
		for (const a of letters) {
			for (const b of letters) {
				const code = `${a}${b}`;
				const name = displayNames?.of(code);
				if (!name || name === code || NON_COUNTRY_CODES.has(code)) continue;
				for (const key of [employerTokens(code), employerTokens(name)]) {
					if (key && !countryCodes.has(key)) countryCodes.set(key, code);
				}
			}
		}
		for (const [alias, code] of COUNTRY_ALIASES) countryCodes.set(employerTokens(alias), code);
	}
	return countryCodes.get(tokens) ?? "";
}

function isLocationName(tokens: string): boolean {
	return LOCATION_NAMES.has(tokens) || Boolean(countryCodeOf(tokens));
}

// Two-letter codes that are more often a field than a country in a query
// ("mentors in IT", "PM from AI startups"). Lowercase two-letter words ("in",
// "us", "me") are never codes; "uk" is the one exception.
const AMBIGUOUS_CODES = new Set(["ai", "ar", "bi", "hr", "id", "it", "ml", "pm", "qa"]);

// True when a query phrase, as written, is only a place: a country name, code
// or alias, a region, or an office city ("Canada", "the UK", "New York").
export function isPlacePhrase(phrase: string): boolean {
	// Punctuation is stripped first, so "IT." meets the same guards as "IT".
	const text = phrase
		.trim()
		.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
		.replace(/^the\s+/i, "");
	const tokens = employerTokens(text);
	if (!tokens || !isLocationName(tokens)) return false;
	if (/^[A-Za-z]{2}$/.test(text)) {
		return tokens === "uk" || (text === text.toUpperCase() && !AMBIGUOUS_CODES.has(tokens));
	}
	return true;
}

// A place the query asks mentors to be in: "from", "in", "based in", "located
// in", "living in" or "out of" followed by a country, region or city. Returns
// the place as written, longest match first ("from New York" → "New York").
// The words are read in a lookahead, so "from Google in London" still reaches
// "in London". The place must end the phrase: followed by punctuation, the
// end, or a clause word ("from Canada who…", "in the UK at Google"). Followed
// by anything else it starts an employer ("from Canada Life") and is no place.
const PLACE_PREPOSITION =
	/\b(?:from|in|based\s+(?:in|out\s+of)|located\s+in|living\s+in|out\s+of)\s+(?=((?:the\s+)?[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}))/gi;
// A negation shortly before the place, within its clause: "not based in US",
// "who aren't in Canada", "anywhere but in the UK", "excluding those from
// Canada". Read after apostrophes are made ASCII, so "aren’t" is "aren't".
const PLACE_NEGATION =
	/(?:\b(?:not|no|never|without|outside|except|excluding|exclude|non|other\s+than|anywhere\s+but)\b|[a-z]n't\b)[^,.;:!?]{0,40}$/i;

function placeMatches(rawQuery: string): { place: string; negated: boolean }[] {
	const query = asciiQuotes(rawQuery);
	const places: { place: string; negated: boolean }[] = [];
	for (const match of query.matchAll(PLACE_PREPOSITION)) {
		const words = match[1].split(/\s+/);
		for (let n = words.length; n >= 1; n -= 1) {
			const phrase = words.slice(0, n).join(" ");
			if (!isPlacePhrase(phrase)) continue;
			const next = words[n];
			const ends = next === undefined || /\.$/.test(words[n - 1]) || NON_COMPANY_WORDS.has(bare(next));
			if (ends) {
				const negated = PLACE_NEGATION.test(query.slice(0, match.index));
				places.push({ place: phrase.replace(/^the\s+/i, ""), negated });
			}
			break;
		}
	}
	return places;
}

// The first place the query names after a place preposition, negated or not.
export function placeIn(query: string): string {
	return placeMatches(query)[0]?.place ?? "";
}

// The ISO country code of the place the query asks for ("mentors from Canada"
// → "CA", "PM based in UK" → "GB"), or "" when there is none, the place is a
// region or city, or the query excludes it ("mentors not based in US").
export function countryIntentIn(query: string): string {
	const place = placeMatches(query).find((match) => !match.negated)?.place;
	return place ? countryCodeOf(employerTokens(place)) : "";
}

// The companies employer text names, current or past, each normalized to
// tokens with its past marker and connecting words stripped ("Former Google",
// "Retired from Google", "Ex @ Google" → "google"). Each whole segment is
// kept, so "Former Acme (Europe)" still names "acme europe", then its
// fragments. The whole text is kept too, for names with separators in them.
// A segment or fragment that is only a place ("Canada" in "Acme (Canada)") is
// an office, not an employer, and is dropped.
function employerNames(employer: string): string[] {
	const normalize = (part: string) => employerTokens(part.replace(PAST_START, ""));
	const segments = employer.split(EMPLOYER_SEGMENTS).map((segment) => segment.replace(PAST_START, "").trim());
	const parts = [...segments, ...segments.flatMap((segment) => segment.split(EMPLOYER_FRAGMENTS))]
		.map(normalize)
		.filter((part) => part && !isLocationName(part));
	return [normalize(employer), ...parts].filter(Boolean);
}

// A candidate that some returned row names as an employer at all, past
// included. When every match is past-marked ("Former Director of UX" at
// Initech) the query is still about that company, so it stays a strict filter
// with no current employees rather than falling back to unfiltered results.
export function companyNamedByEmployers(query: string, employers: string[]): string {
	const named = employers.flatMap(employerNames);
	for (const candidate of companyCandidates(query)) {
		const wanted = employerTokens(candidate);
		if (wanted && named.some((have) => have === wanted || have.startsWith(`${wanted} `))) return candidate;
	}
	return "";
}
