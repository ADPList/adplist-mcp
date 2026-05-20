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
	const userId = props?.userId;
	if (!userId) return "";
	const existing = await readUserProfile(env, userId);
	if (!existing) return "";
	return synthesizeProfileText(existing.profile).text;
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
