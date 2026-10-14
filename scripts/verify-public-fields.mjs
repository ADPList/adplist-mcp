#!/usr/bin/env node
/**
 * Public-field verification for the no-login MCP tier (ADPLIST-4479).
 *
 * For at least --count mentors (default 50), compares every allowlisted value
 * the public mapper returns against the logged-out profile page
 * https://adplist.org/mentors/{slug}. The search_mentors card and the
 * get_mentor_profile output are checked independently — each emits its own
 * values (search stats come from the search index, profile stats from the
 * statistics service), so neither may stand in for the other.
 *
 * A text value only counts as public if it is visible in the page text; values
 * found only inside embedded script data are reported as "script-only" and
 * treated as failures. photo_url counts if the S3 object path appears in the
 * page markup (an img src/srcset, raw or URL-encoded).
 *
 * Exception: the page renders rating, review count, country and languages
 * client-side, so the server HTML may carry them only in its embedded page
 * data. Those four are reported as "embedded" (not a failure) when found
 * there: average_rating must equal reviewStats.avg rounded to one decimal, as
 * the page displays it; total_reviews must equal reviewStats.count; country and
 * languages must appear in __NEXT_DATA__ or the script carrying reviewStats.
 *
 * Session totals are not checked or emitted: the public page does not show
 * them (ADPLIST-4360).
 *
 * The mapper output comes from a running public endpoint — `npm run dev`
 * (http://localhost:8787/public/mcp, the default) or the preview Worker — so
 * this checks the real code path, not a copy of it. Mentor slugs come from the
 * same public search_mentors tool over several queries.
 *
 * Usage (Node >= 20):
 *   node scripts/verify-public-fields.mjs [--endpoint URL] [--count 50] [--delay-ms 2100]
 *
 * The public tier allows 30 tools/call per minute per IP; the default delay
 * stays under it. Exit code 1 if any field fails, 2 if too few mentors.
 */
import { pathToFileURL } from "node:url";

const QUERIES = [
	"product design portfolio review",
	"product manager career growth",
	"UX research",
	"software engineering leadership",
	"data science career",
	"growth marketing",
	"first-time manager",
	"brand design",
	"frontend engineering",
	"career switch into tech",
	"startup founder",
	"content design",
	"design systems",
	"machine learning engineer",
	"product marketing",
];

// Every emitted mentor key except slug, profile_url and why_match, which are
// ours (the slug is the page's own URL; the rest is link and explanation text).
export const FIELDS = [
	"name",
	"title",
	"company",
	"country",
	"bio",
	"average_rating",
	"total_reviews",
	"expertise",
	"disciplines",
	"languages",
	"photo_url",
];
const LIST_FIELDS = new Set(["expertise", "disciplines", "languages"]);
// Rendered client-side by the page; an embedded-data match is not a failure.
const EMBEDDED_FIELDS = new Set(["average_rating", "total_reviews", "country", "languages"]);
const SOURCES = ["search", "profile"];
const STATUSES = ["ok", "embedded", "absent", "missing", "script-only"];
const FAILING = new Set(["missing", "script-only"]);

function parseArgs(argv) {
	const args = { endpoint: "http://localhost:8787/public/mcp", count: 50, delayMs: 2100 };
	for (let i = 0; i < argv.length; i += 1) {
		const [key, inline] = argv[i].split("=", 2);
		const value = inline ?? argv[i + 1];
		if (key === "--endpoint") args.endpoint = value;
		else if (key === "--count") args.count = Number(value);
		else if (key === "--delay-ms") args.delayMs = Number(value);
		else continue;
		if (inline === undefined) i += 1;
	}
	return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let rpcId = 1;
async function callTool(endpoint, name, args) {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: rpcId++,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
	if (!response.ok) throw new Error(`${name} HTTP ${response.status}`);
	const body = await response.json();
	if (body.error) throw new Error(`${name} JSON-RPC ${body.error.code}`);
	const result = body.result;
	if (result.isError) return { error: result.structuredContent?.error?.code ?? "UNKNOWN" };
	return { value: result.structuredContent };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
function decodeEntities(text) {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
		.replace(/&([a-z0-9#]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

function normalize(text) {
	return decodeEntities(text).replace(/\s+/g, " ").trim().toLowerCase();
}

export function pageTexts(html) {
	const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
	const scripts = scriptTags.map((match) => match[2]).join(" ");
	// The page's own mentor data: __NEXT_DATA__, or the (streamed) script that
	// carries reviewStats. Unrelated script payloads never count as embedded.
	const embedded = scriptTags
		.filter(([, attrs, body]) => /\bid=["']?__NEXT_DATA__/.test(attrs) || body.includes("reviewStats"))
		.map((match) => match[2].replace(/\\"/g, '"'))
		.join(" ");
	const markup = html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
	return {
		visible: normalize(markup.replace(/<[^>]+>/g, " ")),
		markup: decodeEntities(markup),
		scripts: normalize(scripts.replace(/\\"/g, '"')),
		rawScripts: scripts.replace(/\\\//g, "/"),
		embedded: normalize(embedded),
		reviewStats: parseReviewStats(embedded),
	};
}

function parseReviewStats(text) {
	const block = text.match(/"reviewStats"\s*:\s*\{([^{}]*)\}/)?.[1];
	if (!block) return {};
	const number = (key) => {
		const raw = block.match(new RegExp(`"${key}"\\s*:\\s*"?(-?\\d+(?:\\.\\d+)?)`))?.[1];
		return raw === undefined ? undefined : Number(raw);
	};
	return { avg: number("avg"), count: number("count") };
}

// Rating and review count only count as embedded when they equal reviewStats
// as the page displays it (avg rounded to one decimal).
function embeddedMatch(field, item, page, match) {
	if (field === "average_rating") {
		const { avg } = page.reviewStats;
		return typeof avg === "number" && Math.round(avg * 10) / 10 === item;
	}
	if (field === "total_reviews") return page.reviewStats.count === item;
	return match(page.embedded);
}

function numberForms(value) {
	const forms = new Set([String(value), value.toLocaleString("en-US")]);
	if (!Number.isInteger(value)) {
		forms.add(value.toFixed(1));
		forms.add(value.toFixed(2));
	}
	return [...forms].map((form) => form.toLowerCase());
}

function containsWord(haystack, needle) {
	const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^0-9a-z])${escaped}($|[^0-9a-z])`, "i").test(haystack);
}

// The mapper truncates long text with "…"; the page shows the full text, so
// only the part before the ellipsis has to appear.
function textForm(value) {
	return normalize(String(value).replace(/…$/, ""));
}

function photoForms(value) {
	let path;
	try {
		path = new URL(value).pathname;
	} catch {
		return [value];
	}
	return [path, encodeURIComponent(path), decodeURIComponent(path)];
}

// One value against the page: "absent" (not emitted), "ok", "embedded",
// "script-only" or "missing". List fields pass only when every item is on the
// page; the worst item status wins.
export function checkField(field, value, page) {
	if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
		return "absent";
	}
	if (field === "photo_url") {
		const forms = photoForms(String(value));
		if (forms.some((form) => page.markup.includes(form))) return "ok";
		if (forms.some((form) => page.rawScripts.includes(form))) return "script-only";
		return "missing";
	}
	const items = LIST_FIELDS.has(field) ? value : [value];
	const statuses = items.map((item) => {
		const candidates = typeof item === "number" ? numberForms(item) : [textForm(item)];
		const match = (text) =>
			candidates.some((candidate) =>
				typeof item === "number" ? containsWord(text, candidate) : text.includes(candidate),
			);
		if (match(page.visible)) return "ok";
		if (EMBEDDED_FIELDS.has(field) && embeddedMatch(field, item, page, match)) return "embedded";
		if (match(page.scripts)) return "script-only";
		return "missing";
	});
	for (const status of ["missing", "script-only", "embedded"]) {
		if (statuses.includes(status)) return status;
	}
	return "ok";
}

// Checks the search card and the profile output separately against one page.
// Returns one row per (source, field), so a search-only value is never hidden
// behind a different profile value for the same field.
export function verifyMentor({ search, profile }, page) {
	const results = [];
	for (const [source, output] of [
		["search", search],
		["profile", profile],
	]) {
		if (!output) continue;
		for (const field of FIELDS) {
			results.push({ source, field, value: output[field], status: checkField(field, output[field], page) });
		}
	}
	return results;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	console.log(`Endpoint: ${args.endpoint}`);
	const mentors = new Map();
	for (const query of QUERIES) {
		if (mentors.size >= args.count) break;
		const { value, error } = await callTool(args.endpoint, "search_mentors", { query, limit: 9 });
		if (error) console.warn(`search "${query}" → ${error}`);
		for (const mentor of value?.mentors ?? []) {
			if (!mentors.has(mentor.slug)) mentors.set(mentor.slug, mentor);
		}
		await sleep(args.delayMs);
	}
	const selected = [...mentors.values()].slice(0, args.count);
	console.log(`Collected ${selected.length} mentors from ${QUERIES.length} max queries.`);

	const tally = {};
	for (const source of SOURCES) {
		for (const field of FIELDS) {
			tally[`${source}.${field}`] = Object.fromEntries(STATUSES.map((status) => [status, 0]));
		}
	}
	const failures = [];
	for (const [index, fromSearch] of selected.entries()) {
		const { value: profile, error } = await callTool(args.endpoint, "get_mentor_profile", {
			mentor_slug: fromSearch.slug,
		});
		await sleep(args.delayMs);
		if (error) failures.push({ slug: fromSearch.slug, field: "profile", status: error });
		const pageResponse = await fetch(`https://adplist.org/mentors/${encodeURIComponent(fromSearch.slug)}`, {
			headers: { Accept: "text/html", "User-Agent": "adplist-public-field-verifier/1.0" },
			redirect: "follow",
		});
		if (!pageResponse.ok) {
			failures.push({ slug: fromSearch.slug, field: "page", status: `HTTP ${pageResponse.status}` });
			continue;
		}
		const page = pageTexts(await pageResponse.text());
		for (const result of verifyMentor({ search: fromSearch, profile }, page)) {
			const key = `${result.source}.${result.field}`;
			tally[key][result.status] += 1;
			if (FAILING.has(result.status)) {
				failures.push({ slug: fromSearch.slug, field: key, status: result.status, value: result.value });
			}
		}
		process.stdout.write(`\rChecked ${index + 1}/${selected.length}`);
	}
	process.stdout.write("\n\n");

	console.log(`${"field".padEnd(24)} ${STATUSES.map((status) => status.padStart(11)).join(" ")}`);
	for (const [key, t] of Object.entries(tally)) {
		console.log(`${key.padEnd(24)} ${STATUSES.map((status) => String(t[status]).padStart(11)).join(" ")}`);
	}
	console.log('\n"embedded" = only in the page\'s embedded data (rendered client-side); not a failure.');
	if (failures.length > 0) {
		console.log(`\n${failures.length} failure(s):`);
		for (const failure of failures.slice(0, 100)) console.log(JSON.stringify(failure));
	}
	if (selected.length < args.count) {
		console.error(`\nOnly ${selected.length} mentors collected; need ${args.count}.`);
		process.exit(2);
	}
	process.exit(failures.length > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
