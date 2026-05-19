import { cognitoBaseUrl, cognitoRedirectUri, cognitoScopes, optionalEnv, requiredEnv } from "./config";
import type { CognitoTokenResponse, CognitoUserInfo } from "./types";

export async function buildCognitoAuthorizeUrl(
	env: Env,
	requestUrl: string,
	state: string,
	pkceVerifier: string,
): Promise<string> {
	const authorizeUrl = new URL(`${cognitoBaseUrl(env)}/oauth2/authorize`);
	authorizeUrl.searchParams.set("client_id", requiredEnv(env, "COGNITO_CLIENT_ID"));
	authorizeUrl.searchParams.set("redirect_uri", cognitoRedirectUri(env, requestUrl));
	authorizeUrl.searchParams.set("response_type", "code");
	authorizeUrl.searchParams.set("scope", cognitoScopes(env));
	authorizeUrl.searchParams.set("state", state);
	if (!optionalEnv(env, "COGNITO_CLIENT_SECRET")) {
		authorizeUrl.searchParams.set("code_challenge_method", "S256");
		authorizeUrl.searchParams.set("code_challenge", await createPkceChallenge(pkceVerifier));
	}
	return authorizeUrl.toString();
}

export async function exchangeCognitoCode(
	env: Env,
	requestUrl: string,
	code: string,
	pkceVerifier?: string,
): Promise<CognitoTokenResponse> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: requiredEnv(env, "COGNITO_CLIENT_ID"),
		code,
		redirect_uri: cognitoRedirectUri(env, requestUrl),
	});
	if (!optionalEnv(env, "COGNITO_CLIENT_SECRET") && pkceVerifier) {
		body.set("code_verifier", pkceVerifier);
	}

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

export function createPkceVerifier(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

async function createPkceChallenge(verifier: string): Promise<string> {
	const data = new TextEncoder().encode(verifier);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
