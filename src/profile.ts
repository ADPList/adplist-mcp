import type { McpUserProps } from "./types";

export type UserMcpProfile = Record<string, unknown>;

export type ManageMyContextAction = "read" | "merge" | "clear";

export type ManageMyContextInput = {
	action?: ManageMyContextAction;
	updates?: UserMcpProfile;
};

export type ManageMyContextOutput = {
	action: ManageMyContextAction;
	profile: UserMcpProfile | null;
	updated_at: number | null;
	message: string;
	profile_text?: string;
	warning?: string;
};

type ProfileRow = {
	profile_json: string;
	updated_at: number;
};

const PROFILE_TEXT_SOFT_LIMIT = 1000;
const ADPLIST_PROFILE_TEXT_LIMIT = 600;
const ADPLIST_PROFILE_FETCH_TIMEOUT_MS = 2000;

export async function manageMyContext(
	env: Env,
	props: McpUserProps | undefined,
	input: ManageMyContextInput = {},
): Promise<ManageMyContextOutput> {
	const userId = requireUserId(props);
	const action = input.action ?? "read";

	if (action === "clear") {
		await env.PROFILE_DB.prepare("DELETE FROM user_mcp_profile WHERE user_id = ?")
			.bind(userId)
			.run();
		return {
			action,
			profile: null,
			updated_at: null,
			message: "Your stored ADPList career context has been cleared.",
		};
	}

	if (action === "merge") {
		const updates = sanitizeUpdates(input.updates);
		const existing = await readUserProfile(env, userId);
		const nextProfile = { ...(existing?.profile ?? {}), ...updates };
		const updatedAt = Math.floor(Date.now() / 1000);
		await env.PROFILE_DB.prepare(
			`INSERT INTO user_mcp_profile (user_id, profile_json, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
			 profile_json = excluded.profile_json,
			 updated_at = excluded.updated_at`,
		)
			.bind(userId, JSON.stringify(nextProfile), updatedAt)
			.run();
		return profileOutput(
			action,
			nextProfile,
			updatedAt,
			"Your stored ADPList career context has been updated.",
		);
	}

	if (action !== "read") {
		throw new Error("manage_my_context action must be read, merge, or clear");
	}

	const existing = await readUserProfile(env, userId);
	if (!existing) {
		return {
			action,
			profile: null,
			updated_at: null,
			message: "No ADPList career context is currently stored for you.",
		};
	}
	return profileOutput(
		action,
		existing.profile,
		existing.updated_at,
		"Here is your stored ADPList career context.",
	);
}

export async function getProfileTextForSearch(
	env: Env,
	props: McpUserProps | undefined,
): Promise<string> {
	// Each source fails open independently so a D1 hiccup can't discard a
	// successfully-fetched ADPList profile (and vice versa).
	const [adplistProfile, storedContext] = await Promise.all([
		fetchAdplistProfileText(env, props),
		getStoredContextText(env, props).catch((error) => {
			console.warn(
				JSON.stringify({ event: "stored_context_read_error", error: String(error) }),
			);
			return "";
		}),
	]);
	if (adplistProfile.length > 0 || storedContext.length > 0) {
		console.log(
			JSON.stringify({
				event: "search_profile_merge",
				profile_chars: adplistProfile.length,
				stored_chars: storedContext.length,
			}),
		);
	}
	return [adplistProfile, storedContext].filter(Boolean).join(". ");
}

async function getStoredContextText(env: Env, props: McpUserProps | undefined): Promise<string> {
	const userId = props?.userId;
	if (!userId) return "";
	const existing = await readUserProfile(env, userId);
	if (!existing) return "";
	return synthesizeProfileText(existing.profile).text;
}

// The user's own ADPList profile (identity-service /users/profile/me). v1 D1
// memory is explicit-only and empty for nearly everyone, so this is what makes
// search queries personal for most users. Always fails open to "".
export async function fetchAdplistProfileText(
	env: Env,
	props: McpUserProps | undefined,
): Promise<string> {
	if (!props?.cognitoAccessToken || !env.AUTH_SERVICE_URL) return "";
	try {
		const response = await fetch(new URL("/users/profile/me", env.AUTH_SERVICE_URL).toString(), {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${props.cognitoAccessToken}`,
			},
			signal: AbortSignal.timeout(ADPLIST_PROFILE_FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return "";
		return adplistProfileToSearchText(await response.json());
	} catch {
		return "";
	}
}

export function adplistProfileToSearchText(response: unknown): string {
	const data = (response as { data?: Record<string, unknown> } | undefined)?.data;
	if (!data || typeof data !== "object") return "";

	const profile = asRecord(data.profile);
	const experiences = asRecord(data.experiences);
	const preferences = asRecord(data.preferences);
	const country = asRecord(data.country);

	const parts: string[] = [];
	const title = textOf(profile.title);
	const organization = textOf(profile.organization);
	if (title && organization) parts.push(`Role: ${title} at ${organization}`);
	else if (title) parts.push(`Role: ${title}`);
	else if (organization) parts.push(`Works at ${organization}`);

	const sections: Array<[string, unknown]> = [
		["Experience level", experiences.experienceLevel],
		["Disciplines", experiences.disciplines],
		["Expertise", experiences.expertise],
		["Goals", preferences.motivations],
		["Interests", preferences.interests],
	];
	for (const [label, value] of sections) {
		const text = labelsOf(value);
		if (text) parts.push(`${label}: ${text}`);
	}

	const countryName = textOf(country.countryName);
	if (countryName) parts.push(`Based in ${countryName}`);

	const fullText = parts.join(". ");
	if (fullText.length <= ADPLIST_PROFILE_TEXT_LIMIT) return fullText;
	return `${fullText.slice(0, ADPLIST_PROFILE_TEXT_LIMIT - 1).trimEnd()}…`;
}

export function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function textOf(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

// Identity-service lists arrive as strings or objects whose label key varies
// by entity (Expertise.expertise, Discipline.discipline, Motivation.motivation,
// Interest.interest, ExperienceLevel.seniority, Language.language, ...); pick
// the first string we find. Shared with mentorProfile.ts.
export function labelsOf(value: unknown): string {
	const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
	const labels = items
		.map((item) => {
			if (typeof item === "string") return item.trim();
			const record = asRecord(item);
			for (const key of [
				"name",
				"expertise",
				"discipline",
				"motivation",
				"interest",
				"language",
				"seniority",
				"skill",
				"title",
				"label",
				"value",
			]) {
				const text = textOf(record[key]);
				if (text) return text;
			}
			return "";
		})
		.filter(Boolean);
	return labels.join(", ");
}

export function combineIntentWithProfile(intent: string, profileText: string): string {
	const cleanIntent = intent.trim();
	const cleanProfile = profileText.trim();
	if (!cleanProfile) return cleanIntent;
	return `Stored ADPList career context: ${cleanProfile}\nCurrent request: ${cleanIntent}`;
}

export function synthesizeProfileText(profile: UserMcpProfile): { text: string; warning?: string } {
	const parts: string[] = [];
	const knownLabels: Record<string, string> = {
		career_stage: "Career stage",
		current_focus: "Current focus",
		skills_wanted: "Wants help with",
		recent_context_notes: "Recent context notes",
	};

	for (const [key, label] of Object.entries(knownLabels)) {
		const text = valueToText(profile[key]);
		if (text) parts.push(`${label}: ${text}`);
	}

	for (const [key, value] of Object.entries(profile)) {
		if (key in knownLabels) continue;
		const text = valueToText(value);
		if (text) parts.push(`${humanizeKey(key)}: ${text}`);
	}

	const fullText = parts.join(". ");
	if (fullText.length <= PROFILE_TEXT_SOFT_LIMIT) return { text: fullText };
	return {
		text: `${fullText.slice(0, PROFILE_TEXT_SOFT_LIMIT - 1).trimEnd()}…`,
		warning: "Your stored context is getting large; consider clearing old notes.",
	};
}

async function readUserProfile(
	env: Env,
	userId: string,
): Promise<{ profile: UserMcpProfile; updated_at: number } | null> {
	const row = await env.PROFILE_DB.prepare(
		"SELECT profile_json, updated_at FROM user_mcp_profile WHERE user_id = ?",
	)
		.bind(userId)
		.first<ProfileRow>();
	if (!row) return null;
	return { profile: parseProfileJson(row.profile_json), updated_at: row.updated_at };
}

function profileOutput(
	action: ManageMyContextAction,
	profile: UserMcpProfile,
	updatedAt: number,
	message: string,
): ManageMyContextOutput {
	const synthesized = synthesizeProfileText(profile);
	return {
		action,
		profile,
		updated_at: updatedAt,
		message,
		profile_text: synthesized.text,
		...(synthesized.warning ? { warning: synthesized.warning } : {}),
	};
}

function requireUserId(props: McpUserProps | undefined): string {
	if (!props?.userId) throw new Error("manage_my_context requires an authenticated ADPList user");
	return props.userId;
}

function sanitizeUpdates(updates: UserMcpProfile | undefined): UserMcpProfile {
	if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
		throw new Error("manage_my_context merge requires an updates object");
	}
	return Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined));
}

function parseProfileJson(value: string): UserMcpProfile {
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as UserMcpProfile)
			: {};
	} catch {
		return {};
	}
}

function valueToText(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (Array.isArray(value)) return value.map(valueToText).filter(Boolean).join(", ");
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

function humanizeKey(key: string): string {
	return key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
