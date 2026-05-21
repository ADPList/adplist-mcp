export const MCP_SCOPES = ["profile:read", "tools:read"] as const;

export function requiredEnv(env: Env, key: keyof Env): string {
	const value = env[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Missing required environment variable: ${String(key)}`);
	}
	return value;
}
