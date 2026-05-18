import { cognitoBaseUrl, cognitoRedirectUri, cognitoScopes, optionalEnv, requiredEnv } from "./config";
import type { CognitoTokenResponse, CognitoUserInfo } from "./types";

export function buildCognitoAuthorizeUrl(env: Env, requestUrl: string, state: string): string {
	const authorizeUrl = new URL(`${cognitoBaseUrl(env)}/oauth2/authorize`);
	authorizeUrl.searchParams.set("client_id", requiredEnv(env, "COGNITO_CLIENT_ID"));
	authorizeUrl.searchParams.set("redirect_uri", cognitoRedirectUri(env, requestUrl));
	authorizeUrl.searchParams.set("response_type", "code");
	authorizeUrl.searchParams.set("scope", cognitoScopes(env));
	authorizeUrl.searchParams.set("state", state);
	return authorizeUrl.toString();
}

export async function exchangeCognitoCode(env: Env, requestUrl: string, code: string): Promise<CognitoTokenResponse> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: requiredEnv(env, "COGNITO_CLIENT_ID"),
		code,
		redirect_uri: cognitoRedirectUri(env, requestUrl),
	});

	const response = await fetch(`${cognitoBaseUrl(env)}/oauth2/token`, {
		method: "POST",
		headers: tokenHeaders(env),
		body,
	});

	if (!response.ok) {
		throw new Error(`Cognito code exchange failed: ${response.status} ${await response.text()}`);
	}

	return response.json<CognitoTokenResponse>();
}

export async function fetchCognitoUserInfo(env: Env, accessToken: string): Promise<CognitoUserInfo> {
	const response = await fetch(`${cognitoBaseUrl(env)}/oauth2/userInfo`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	if (!response.ok) {
		throw new Error(`Cognito userinfo failed: ${response.status} ${await response.text()}`);
	}

	return response.json<CognitoUserInfo>();
}

function tokenHeaders(env: Env): HeadersInit {
	const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
	const clientSecret = optionalEnv(env, "COGNITO_CLIENT_SECRET");
	if (clientSecret) {
		const credentials = btoa(`${requiredEnv(env, "COGNITO_CLIENT_ID")}:${clientSecret}`);
		headers.set("Authorization", `Basic ${credentials}`);
	}
	return headers;
}
