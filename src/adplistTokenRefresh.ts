import type {
	TokenExchangeCallbackOptions,
	TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import type { McpUserProps } from "./types";

export type RefreshAdplistTokenResult = {
	accessToken: string;
	accessTokenExpiresAt?: number;
	refreshToken?: string;
};

const ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 5 * 60;
const OPAQUE_ACCESS_TOKEN_REFRESH_AFTER_SECONDS = 23 * 60 * 60;

export class AuthExpiredError extends Error {
	constructor(message = "ADPList refresh token is invalid or expired. Reconnect ADPList.") {
		super(`AUTH_EXPIRED: ${message}`);
		this.name = "AuthExpiredError";
	}
}

export class UpstreamRefreshError extends Error {
	constructor(message = "ADPList auth refresh is temporarily unavailable.") {
		super(message);
		this.name = "UpstreamRefreshError";
	}
}

function authBaseUrl(env: Env): string {
	const value = env.AUTH_SERVICE_URL;
	if (!value) throw new Error("AUTH_SERVICE_URL is not configured");
	return value.replace(/\/$/, "");
}

function isExpiredRefreshStatus(status: number): boolean {
	return status === 400 || status === 401 || status === 403;
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function secondsUntil(timestampSeconds: number): number {
	return timestampSeconds - nowSeconds();
}

export function accessTokenExpiresAt(accessToken: string): number | undefined {
	const [, payload] = accessToken.split(".");
	if (!payload) return undefined;

	try {
		const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
		const decoded = JSON.parse(atob(padded)) as { exp?: unknown };
		return typeof decoded.exp === "number" && Number.isFinite(decoded.exp)
			? decoded.exp
			: undefined;
	} catch {
		return undefined;
	}
}

function shouldRefreshAdplistAccessToken(props: McpUserProps): boolean {
	if (!props.cognitoAccessToken) return true;
	if (props.cognitoAccessTokenExpiresAt) {
		return secondsUntil(props.cognitoAccessTokenExpiresAt) <= ACCESS_TOKEN_REFRESH_SKEW_SECONDS;
	}
	if (!props.cognitoAccessTokenRefreshedAt) return true;
	return (
		secondsUntil(
			props.cognitoAccessTokenRefreshedAt + OPAQUE_ACCESS_TOKEN_REFRESH_AFTER_SECONDS,
		) <= ACCESS_TOKEN_REFRESH_SKEW_SECONDS
	);
}

function refreshTokenOverrideKey(userId: string, clientId?: string): string {
	return `adplist_refresh_token:${clientId ?? "unknown"}:${userId}`;
}

async function getStoredRefreshToken(
	env: Env,
	userId: string,
	clientId?: string,
): Promise<string | null> {
	if (clientId) {
		const clientToken = await env.OAUTH_KV.get(refreshTokenOverrideKey(userId, clientId));
		if (clientToken) return clientToken;
	}
	return env.OAUTH_KV.get(refreshTokenOverrideKey(userId));
}

async function storeRefreshTokenOverride(
	env: Env,
	props: McpUserProps,
	refreshToken: string,
): Promise<void> {
	await env.OAUTH_KV.put(refreshTokenOverrideKey(props.userId, props.mcpClientId), refreshToken, {
		expirationTtl: 30 * 24 * 60 * 60,
	});
}

type JsonResponse = {
	data: unknown;
	headers: Headers;
};

function refreshTokenFromSetCookie(headers: Headers): string | undefined {
	const setCookie = headers.get("Set-Cookie");
	if (!setCookie) return undefined;

	const match = setCookie.match(/(?:^|[,;]\s*)ort=([^;,]+)/);
	if (!match?.[1]) return undefined;

	try {
		return decodeURIComponent(match[1]);
	} catch {
		return match[1];
	}
}

async function postJson(
	url: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<JsonResponse> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			...headers,
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		if (isExpiredRefreshStatus(response.status)) throw new AuthExpiredError();
		throw new UpstreamRefreshError(`ADPList auth refresh failed: HTTP ${response.status}`);
	}
	return { data: await response.json(), headers: response.headers };
}

// Refresh the ADPList oid used by api.adplist.org. auth-service primarily refreshes
// from its ort cookie today; the JSON body keeps this compatible if /auth/refresh
// accepts explicit refresh tokens for MCP callers.
export async function refreshAdplistToken(
	env: Env,
	refreshToken: string,
): Promise<RefreshAdplistTokenResult> {
	let data: { accessToken?: unknown; refreshToken?: unknown };
	let cookieRefreshToken: string | undefined;
	try {
		const response = await postJson(
			`${authBaseUrl(env)}/auth/refresh`,
			{ refreshToken },
			{ Cookie: `ort=${refreshToken}` },
		);
		data = response.data as { accessToken?: unknown; refreshToken?: unknown };
		cookieRefreshToken = refreshTokenFromSetCookie(response.headers);
	} catch (error) {
		if (error instanceof AuthExpiredError || error instanceof UpstreamRefreshError) throw error;
		throw new UpstreamRefreshError();
	}
	if (typeof data.accessToken !== "string" || data.accessToken.length === 0) {
		throw new UpstreamRefreshError("ADPList /auth/refresh did not return an access token");
	}
	const expiresAt = accessTokenExpiresAt(data.accessToken);
	return {
		accessToken: data.accessToken,
		...(expiresAt ? { accessTokenExpiresAt: expiresAt } : {}),
		refreshToken:
			typeof data.refreshToken === "string" ? data.refreshToken : cookieRefreshToken,
	};
}

export async function ensureFreshAdplistProps(
	env: Env,
	props: McpUserProps | undefined,
): Promise<McpUserProps | undefined> {
	if (!props) return props;
	props.cognitoAccessTokenExpiresAt ??= props.cognitoAccessToken
		? accessTokenExpiresAt(props.cognitoAccessToken)
		: undefined;
	if (!shouldRefreshAdplistAccessToken(props)) return props;

	const refreshToken =
		(await getStoredRefreshToken(env, props.userId, props.mcpClientId)) ??
		props.adplistRefreshToken;
	if (!refreshToken) {
		throw new AuthExpiredError("ADPList refresh token is missing. Reconnect ADPList.");
	}

	const refreshed = await refreshAdplistToken(env, refreshToken);
	props.cognitoAccessToken = refreshed.accessToken;
	props.cognitoAccessTokenExpiresAt = refreshed.accessTokenExpiresAt;
	props.cognitoAccessTokenRefreshedAt = nowSeconds();
	props.adplistRefreshToken = refreshed.refreshToken ?? refreshToken;
	if (refreshed.refreshToken) await storeRefreshTokenOverride(env, props, refreshed.refreshToken);
	return props;
}

export async function refreshAdplistPropsOnTokenExchange(
	options: TokenExchangeCallbackOptions,
	env: Env,
): Promise<TokenExchangeCallbackResult | void> {
	if (options.grantType !== "refresh_token") return;

	const props = options.props as McpUserProps;
	const refreshToken =
		(await getStoredRefreshToken(env, props.userId, options.clientId)) ??
		props.adplistRefreshToken;
	if (!refreshToken) {
		throw new AuthExpiredError("ADPList refresh token is missing. Reconnect ADPList.");
	}

	const refreshed = await refreshAdplistToken(env, refreshToken);
	const newProps: McpUserProps = {
		...props,
		mcpClientId: props.mcpClientId ?? options.clientId,
		cognitoAccessToken: refreshed.accessToken,
		cognitoAccessTokenExpiresAt: refreshed.accessTokenExpiresAt,
		cognitoAccessTokenRefreshedAt: nowSeconds(),
		adplistRefreshToken: refreshed.refreshToken ?? refreshToken,
	};
	if (refreshed.refreshToken)
		await storeRefreshTokenOverride(env, newProps, refreshed.refreshToken);
	return { newProps };
}

export function tokenRefreshErrorResponse(error: unknown): Response | undefined {
	if (error instanceof AuthExpiredError) {
		return new Response(
			JSON.stringify({
				error: "invalid_grant",
				error_description: "ADPList sign-in expired. Reconnect ADPList.",
			}),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}
	if (error instanceof UpstreamRefreshError) {
		return new Response(
			JSON.stringify({
				error: "temporarily_unavailable",
				error_description: "ADPList auth refresh is temporarily unavailable. Try again.",
			}),
			{ status: 503, headers: { "Content-Type": "application/json" } },
		);
	}
}
