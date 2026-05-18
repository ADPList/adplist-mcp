export const MCP_SCOPES = ["profile:read", "tools:read"] as const;

export function requiredEnv(env: Env, key: keyof Env): string {
	const value = env[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Missing required environment variable: ${String(key)}`);
	}
	return value;
}

export function optionalEnv(env: Env, key: keyof Env): string | undefined {
	const value = env[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function cognitoBaseUrl(env: Env): string {
	return requiredEnv(env, "COGNITO_DOMAIN").replace(/\/$/, "");
}

export function cognitoRedirectUri(env: Env, requestUrl: string): string {
	return optionalEnv(env, "COGNITO_REDIRECT_URI") ?? `${new URL(requestUrl).origin}/oauth/callback`;
}

export function cognitoScopes(env: Env): string {
	return optionalEnv(env, "COGNITO_SCOPES") ?? "openid email profile";
}
