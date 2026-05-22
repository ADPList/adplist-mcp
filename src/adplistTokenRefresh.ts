import type {
	TokenExchangeCallbackOptions,
	TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import type { McpUserProps } from "./types";

export type RefreshAdplistTokenResult = {
	accessToken: string;
	refreshToken?: string;
};

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

async function postJson(
	url: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<unknown> {
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
	return response.json();
}

// Refresh the ADPList oid used by api.adplist.org. auth-service primarily refreshes
// from its ort cookie today; the JSON body keeps this compatible if /auth/refresh
// accepts explicit refresh tokens for MCP callers.
export async function refreshAdplistToken(
	env: Env,
	refreshToken: string,
): Promise<RefreshAdplistTokenResult> {
	let data: { accessToken?: unknown; refreshToken?: unknown };
	try {
		data = (await postJson(
			`${authBaseUrl(env)}/auth/refresh`,
			{ refreshToken },
			{ Cookie: `ort=${refreshToken}` },
		)) as { accessToken?: unknown; refreshToken?: unknown };
	} catch (error) {
		if (error instanceof AuthExpiredError || error instanceof UpstreamRefreshError) throw error;
		throw new UpstreamRefreshError();
	}
	if (typeof data.accessToken !== "string" || data.accessToken.length === 0) {
		throw new UpstreamRefreshError("ADPList /auth/refresh did not return an access token");
	}
	return {
		accessToken: data.accessToken,
		refreshToken: typeof data.refreshToken === "string" ? data.refreshToken : undefined,
	};
}

export async function refreshAdplistPropsOnTokenExchange(
	options: TokenExchangeCallbackOptions,
	env: Env,
): Promise<TokenExchangeCallbackResult | void> {
	if (options.grantType !== "refresh_token") return;

	const props = options.props as McpUserProps;
	if (!props.adplistRefreshToken) {
		throw new AuthExpiredError("ADPList refresh token is missing. Reconnect ADPList.");
	}

	const refreshed = await refreshAdplistToken(env, props.adplistRefreshToken);
	const newProps: McpUserProps = {
		...props,
		cognitoAccessToken: refreshed.accessToken,
		adplistRefreshToken: refreshed.refreshToken ?? props.adplistRefreshToken,
	};
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
