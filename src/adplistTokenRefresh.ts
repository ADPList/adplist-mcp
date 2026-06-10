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
const OPAQUE_ACCESS_TOKEN_HARD_EXPIRY_SECONDS = 24 * 60 * 60;
const TRANSIENT_REFRESH_RETRY_DELAY_MS = 250;

type RefreshPath = "tool_call" | "token_exchange";

// Staging/testing escape hatch: forces "near expired" without waiting out the
// real 24h Cognito token lifetime. Unset in production.
function refreshSkewSeconds(env: Env): number {
	const raw = (env as unknown as Record<string, unknown>).ADPLIST_REFRESH_SKEW_SECONDS;
	const parsed = typeof raw === "string" ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : ACCESS_TOKEN_REFRESH_SKEW_SECONDS;
}

export class AuthExpiredError extends Error {
	constructor(message = "ADPList refresh token is invalid or expired. Reconnect ADPList.") {
		super(`AUTH_EXPIRED: ${message}`);
		this.name = "AuthExpiredError";
	}
}

export class UpstreamRefreshError extends Error {
	// auth-service returns HTTP 200 with status:"Failed" and no accessToken for BOTH
	// transient Cognito throttles and permanent refresh-token rejections. That shape is
	// "ambiguous": after a failed retry on an already-expired token we treat it as
	// auth-expired. Plain 5xx/network failures are never escalated.
	readonly ambiguousAuthFailure: boolean;

	constructor(
		message = "ADPList auth refresh is temporarily unavailable.",
		options: { ambiguousAuthFailure?: boolean } = {},
	) {
		super(message);
		this.name = "UpstreamRefreshError";
		this.ambiguousAuthFailure = options.ambiguousAuthFailure ?? false;
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

function shouldRefreshAdplistAccessToken(env: Env, props: McpUserProps): boolean {
	if (!props.cognitoAccessToken) return true;
	if (props.cognitoAccessTokenExpiresAt) {
		return secondsUntil(props.cognitoAccessTokenExpiresAt) <= refreshSkewSeconds(env);
	}
	if (!props.cognitoAccessTokenRefreshedAt) return true;
	return (
		secondsUntil(
			props.cognitoAccessTokenRefreshedAt + OPAQUE_ACCESS_TOKEN_REFRESH_AFTER_SECONDS,
		) <= refreshSkewSeconds(env)
	);
}

// "Hard expired" = the stored access token is no longer usable at all, so failing to
// refresh must surface AUTH_EXPIRED instead of silently continuing with a dead token.
function isAdplistAccessTokenHardExpired(props: McpUserProps): boolean {
	if (!props.cognitoAccessToken) return true;
	if (props.cognitoAccessTokenExpiresAt) return secondsUntil(props.cognitoAccessTokenExpiresAt) <= 0;
	if (props.cognitoAccessTokenRefreshedAt) {
		return (
			secondsUntil(props.cognitoAccessTokenRefreshedAt + OPAQUE_ACCESS_TOKEN_HARD_EXPIRY_SECONDS) <=
			0
		);
	}
	return true;
}

function logRefresh(
	level: "log" | "warn" | "error",
	action: string,
	path: RefreshPath,
	props: McpUserProps,
	details: Record<string, unknown> = {},
): void {
	console[level](
		JSON.stringify({
			event: "adplist_token_refresh",
			action,
			path,
			userId: props.userId,
			accessTokenExpiresInSeconds: props.cognitoAccessTokenExpiresAt
				? secondsUntil(props.cognitoAccessTokenExpiresAt)
				: null,
			...details,
		}),
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

// A fresh sign-in must never be shadowed by a refresh token persisted from a
// previous session. Overwrite the shared overrides with the newly verified token
// (other active grants read the override first, so they pick up the fresh token
// too); only delete when the sign-in somehow produced no refresh token.
export async function persistRefreshTokenOnSignIn(
	env: Env,
	userId: string,
	clientId: string | undefined,
	refreshToken: string | undefined,
): Promise<void> {
	const keys = [refreshTokenOverrideKey(userId, clientId), refreshTokenOverrideKey(userId)];
	await Promise.all(
		keys.map((key) =>
			refreshToken
				? env.OAUTH_KV.put(key, refreshToken, { expirationTtl: 30 * 24 * 60 * 60 })
				: env.OAUTH_KV.delete(key),
		),
	);
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

function setCookieHeaders(headers: Headers): string[] {
	const workerHeaders = headers as Headers & {
		getAll?: (name: string) => string[];
		getSetCookie?: () => string[];
	};

	const splitHeaders = workerHeaders.getSetCookie?.() ?? workerHeaders.getAll?.("Set-Cookie");
	if (splitHeaders?.length) return splitHeaders;

	const setCookie = headers.get("Set-Cookie");
	return setCookie ? [setCookie] : [];
}

function refreshTokenFromSetCookie(headers: Headers): string | undefined {
	for (const setCookie of setCookieHeaders(headers)) {
		const match = setCookie.match(/(?:^|;\s*)ort=([^;]+)/);
		if (!match?.[1]) continue;

		try {
			return decodeURIComponent(match[1]);
		} catch {
			return match[1];
		}
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
		throw new UpstreamRefreshError("ADPList /auth/refresh did not return an access token", {
			ambiguousAuthFailure: true,
		});
	}
	const expiresAt = accessTokenExpiresAt(data.accessToken);
	return {
		accessToken: data.accessToken,
		...(expiresAt ? { accessTokenExpiresAt: expiresAt } : {}),
		refreshToken:
			typeof data.refreshToken === "string" && data.refreshToken.length > 0
				? data.refreshToken
				: cookieRefreshToken,
	};
}

// Refresh with a bounded failure policy:
// - explicit 400/401/403 from auth-service -> AuthExpiredError (permanent, reconnect)
// - anything ambiguous/transient (5xx, network, 200 with no accessToken) -> one retry
// - still failing: keep serving the current token if it is still valid (the next
//   hourly exchange/tool call retries naturally), AUTH_EXPIRED only if it is dead.
async function refreshAdplistTokenWithPolicy(
	env: Env,
	path: RefreshPath,
	props: McpUserProps,
	refreshToken: string | undefined,
): Promise<RefreshAdplistTokenResult | undefined> {
	const hardExpired = isAdplistAccessTokenHardExpired(props);
	if (!refreshToken) {
		if (hardExpired) {
			logRefresh("error", "auth_expired_missing_refresh_token", path, props);
			throw new AuthExpiredError("ADPList refresh token is missing. Reconnect ADPList.");
		}
		logRefresh("warn", "refresh_skipped_missing_refresh_token", path, props);
		return undefined;
	}

	// Definitive 4xx rejection: retrying is pointless, but only fail the session
	// when the current access token is actually unusable — otherwise keep serving
	// it and let a later refresh (or reconnect at hard expiry) settle it.
	const handleAuthExpired = (error: AuthExpiredError, retried: boolean): undefined => {
		if (hardExpired) {
			logRefresh("error", "refresh_auth_expired", path, props, { retried });
			throw error;
		}
		logRefresh("warn", "refresh_rejected_continuing", path, props, { retried });
		return undefined;
	};

	logRefresh("log", "refresh_attempt", path, props);
	try {
		const refreshed = await refreshAdplistToken(env, refreshToken);
		logRefresh("log", "refresh_success", path, props);
		return refreshed;
	} catch (error) {
		if (error instanceof AuthExpiredError) return handleAuthExpired(error, false);
		logRefresh("warn", "refresh_attempt_failed_retrying", path, props, {
			reason: error instanceof Error ? error.message : String(error),
		});
	}

	await new Promise((resolve) => setTimeout(resolve, TRANSIENT_REFRESH_RETRY_DELAY_MS));
	try {
		const refreshed = await refreshAdplistToken(env, refreshToken);
		logRefresh("log", "refresh_success_after_retry", path, props);
		return refreshed;
	} catch (error) {
		if (error instanceof AuthExpiredError) return handleAuthExpired(error, true);
		const reason = error instanceof Error ? error.message : String(error);
		if (!hardExpired) {
			logRefresh("warn", "refresh_transient_failure_continuing", path, props, {
				retried: true,
				reason,
			});
			return undefined;
		}
		if (error instanceof UpstreamRefreshError && error.ambiguousAuthFailure) {
			logRefresh("error", "refresh_rejected_token_expired", path, props, { retried: true, reason });
			throw new AuthExpiredError("ADPList token expired and refresh is failing. Reconnect ADPList.");
		}
		logRefresh("error", "refresh_unavailable_token_expired", path, props, { retried: true, reason });
		throw error;
	}
}

export async function ensureFreshAdplistProps(
	env: Env,
	props: McpUserProps | undefined,
): Promise<McpUserProps | undefined> {
	if (!props) return props;
	props.cognitoAccessTokenExpiresAt ??= props.cognitoAccessToken
		? accessTokenExpiresAt(props.cognitoAccessToken)
		: undefined;
	if (!shouldRefreshAdplistAccessToken(env, props)) return props;

	const refreshToken =
		(await getStoredRefreshToken(env, props.userId, props.mcpClientId)) ??
		props.adplistRefreshToken;
	const refreshed = await refreshAdplistTokenWithPolicy(env, "tool_call", props, refreshToken);
	if (!refreshed) return props;

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
	const normalized: McpUserProps = {
		...props,
		cognitoAccessTokenExpiresAt:
			props.cognitoAccessTokenExpiresAt ??
			(props.cognitoAccessToken ? accessTokenExpiresAt(props.cognitoAccessToken) : undefined),
	};
	if (!shouldRefreshAdplistAccessToken(env, normalized)) {
		logRefresh("log", "refresh_skipped_fresh", "token_exchange", normalized);
		return;
	}

	const refreshToken =
		(await getStoredRefreshToken(env, props.userId, options.clientId)) ??
		props.adplistRefreshToken;
	const refreshed = await refreshAdplistTokenWithPolicy(
		env,
		"token_exchange",
		normalized,
		refreshToken,
	);
	if (!refreshed) return;

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
