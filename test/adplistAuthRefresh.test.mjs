import assert from "node:assert/strict";
import test from "node:test";
import {
	AuthExpiredError,
	UpstreamRefreshError,
	refreshAdplistPropsOnTokenExchange,
	refreshAdplistToken,
	tokenRefreshErrorResponse,
} from "../src/adplistTokenRefresh.ts";
import { formatToolError } from "../src/errors.ts";

const originalFetch = globalThis.fetch;

function jwtWithExp(exp) {
	const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
	return `header.${payload}.signature`;
}

function testEnv() {
	const kv = new Map();
	return {
		AUTH_SERVICE_URL: "https://auth.example.com",
		_kv: kv,
		OAUTH_KV: {
			get: async (key) => kv.get(key) ?? null,
			put: async (key, value) => kv.set(key, value),
			delete: async (key) => kv.delete(key),
		},
	};
}

test.afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("refreshAdplistToken calls auth-service refresh with body and refresh cookie", async () => {
	let captured;
	globalThis.fetch = async (url, init) => {
		captured = { url, init };
		return Response.json({ accessToken: "new-oid", refreshToken: "rotated-refresh" });
	};

	const result = await refreshAdplistToken(
		{ AUTH_SERVICE_URL: "https://auth.example.com/" },
		"old-refresh",
	);

	assert.deepEqual(result, { accessToken: "new-oid", refreshToken: "rotated-refresh" });
	assert.equal(captured.url, "https://auth.example.com/auth/refresh");
	assert.equal(captured.init.method, "POST");
	assert.equal(captured.init.headers.Cookie, "ort=old-refresh");
	assert.deepEqual(JSON.parse(captured.init.body), { refreshToken: "old-refresh" });
});

test("refreshAdplistToken persists refresh token rotated through ort Set-Cookie", async () => {
	globalThis.fetch = async () =>
		Response.json(
			{ accessToken: "new-oid" },
			{ headers: { "Set-Cookie": "ort=cookie-rotated-refresh; Path=/; HttpOnly; Secure" } },
		);

	const result = await refreshAdplistToken(
		{ AUTH_SERVICE_URL: "https://auth.example.com/" },
		"old-refresh",
	);

	assert.deepEqual(result, { accessToken: "new-oid", refreshToken: "cookie-rotated-refresh" });
});

test("refreshAdplistToken reads split Set-Cookie values from Workers headers", async () => {
	globalThis.fetch = async () => ({
		ok: true,
		json: async () => ({ accessToken: "new-oid" }),
		headers: {
			getSetCookie: () => [
				"other=value; Expires=Mon, 01 Jan 2026 00:00:00 GMT; Path=/",
				"ort=worker-rotated-refresh; Path=/; HttpOnly; Secure",
			],
			get: () => null,
		},
	});

	const result = await refreshAdplistToken(
		{ AUTH_SERVICE_URL: "https://auth.example.com/" },
		"old-refresh",
	);

	assert.deepEqual(result, { accessToken: "new-oid", refreshToken: "worker-rotated-refresh" });
});

test("refreshAdplistToken ignores empty JSON refreshToken and falls back to cookie", async () => {
	globalThis.fetch = async () =>
		Response.json(
			{ accessToken: "new-oid", refreshToken: "" },
			{ headers: { "Set-Cookie": "ort=cookie-rotated-refresh; Path=/; HttpOnly; Secure" } },
		);

	const result = await refreshAdplistToken(
		{ AUTH_SERVICE_URL: "https://auth.example.com/" },
		"old-refresh",
	);

	assert.deepEqual(result, { accessToken: "new-oid", refreshToken: "cookie-rotated-refresh" });
});

test("refreshAdplistToken prefers JSON refreshToken when both JSON and cookie rotate", async () => {
	globalThis.fetch = async () =>
		Response.json(
			{ accessToken: "new-oid", refreshToken: "json-rotated-refresh" },
			{ headers: { "Set-Cookie": "ort=cookie-rotated-refresh; Path=/; HttpOnly; Secure" } },
		);

	const result = await refreshAdplistToken(
		{ AUTH_SERVICE_URL: "https://auth.example.com/" },
		"old-refresh",
	);

	assert.deepEqual(result, { accessToken: "new-oid", refreshToken: "json-rotated-refresh" });
});

test("refreshAdplistPropsOnTokenExchange refreshes oid and persists rotated refresh token", async () => {
	const env = testEnv();
	globalThis.fetch = async () =>
		Response.json({ accessToken: "fresh-oid", refreshToken: "fresh-refresh" });

	const result = await refreshAdplistPropsOnTokenExchange(
		{
			grantType: "refresh_token",
			clientId: "client",
			userId: "user-1",
			scope: ["adplist.read"],
			requestedScope: ["adplist.read"],
			props: {
				userId: "user-1",
				email: "user@example.com",
				scopes: ["adplist.read"],
				cognitoAccessToken: "stale-oid",
				adplistRefreshToken: "old-refresh",
			},
		},
		env,
	);

	assert.equal(result.newProps.cognitoAccessToken, "fresh-oid");
	assert.equal(result.newProps.adplistRefreshToken, "fresh-refresh");
	assert.equal(result.newProps.email, "user@example.com");
	assert.equal(result.newProps.mcpClientId, "client");
	assert.equal(env._kv.get("adplist_refresh_token:client:user-1"), "fresh-refresh");
});

test("ensureFreshAdplistProps refreshes an access token before it expires", async () => {
	const { ensureFreshAdplistProps } = await import("../src/adplistTokenRefresh.ts");
	const env = testEnv();
	let refreshCalls = 0;
	const freshToken = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
	globalThis.fetch = async () => {
		refreshCalls += 1;
		return Response.json({ accessToken: freshToken, refreshToken: "rotated-refresh" });
	};

	const props = {
		userId: "user-1",
		email: "user@example.com",
		scopes: ["adplist.read"],
		cognitoAccessToken: jwtWithExp(Math.floor(Date.now() / 1000) + 60),
		adplistRefreshToken: "old-refresh",
	};

	const result = await ensureFreshAdplistProps(env, props);

	assert.equal(refreshCalls, 1);
	assert.equal(result, props);
	assert.equal(props.cognitoAccessToken, freshToken);
	assert.equal(props.adplistRefreshToken, "rotated-refresh");
	assert.equal(env._kv.get("adplist_refresh_token:unknown:user-1"), "rotated-refresh");
	assert.ok(props.cognitoAccessTokenExpiresAt > Math.floor(Date.now() / 1000));
});

test("ensureFreshAdplistProps refreshes opaque tokens without fallback freshness", async () => {
	const { ensureFreshAdplistProps } = await import("../src/adplistTokenRefresh.ts");
	let refreshCalls = 0;
	globalThis.fetch = async () => {
		refreshCalls += 1;
		return Response.json({ accessToken: "fresh-opaque" });
	};

	const props = {
		userId: "user-1",
		email: "user@example.com",
		scopes: ["adplist.read"],
		cognitoAccessToken: "opaque-token",
		adplistRefreshToken: "old-refresh",
	};

	await ensureFreshAdplistProps(testEnv(), props);

	assert.equal(refreshCalls, 1);
	assert.equal(props.cognitoAccessToken, "fresh-opaque");
	assert.ok(props.cognitoAccessTokenRefreshedAt <= Math.floor(Date.now() / 1000));
});

test("ensureFreshAdplistProps leaves recently refreshed opaque tokens alone", async () => {
	const { ensureFreshAdplistProps } = await import("../src/adplistTokenRefresh.ts");
	let refreshCalls = 0;
	globalThis.fetch = async () => {
		refreshCalls += 1;
		return Response.json({ accessToken: "unexpected" });
	};

	const props = {
		userId: "user-1",
		email: "user@example.com",
		scopes: ["adplist.read"],
		cognitoAccessToken: "opaque-token",
		cognitoAccessTokenRefreshedAt: Math.floor(Date.now() / 1000),
		adplistRefreshToken: "old-refresh",
	};

	await ensureFreshAdplistProps(testEnv(), props);

	assert.equal(refreshCalls, 0);
	assert.equal(props.cognitoAccessToken, "opaque-token");
});

test("ensureFreshAdplistProps leaves a healthy access token alone", async () => {
	const { ensureFreshAdplistProps } = await import("../src/adplistTokenRefresh.ts");
	let refreshCalls = 0;
	globalThis.fetch = async () => {
		refreshCalls += 1;
		return Response.json({ accessToken: "unexpected" });
	};

	const props = {
		userId: "user-1",
		email: "user@example.com",
		scopes: ["adplist.read"],
		cognitoAccessToken: jwtWithExp(Math.floor(Date.now() / 1000) + 3600),
		cognitoAccessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
		adplistRefreshToken: "old-refresh",
	};

	const result = await ensureFreshAdplistProps(testEnv(), props);

	assert.equal(refreshCalls, 0);
	assert.equal(result, props);
	assert.equal(props.adplistRefreshToken, "old-refresh");
});

test("refresh callback keeps existing refresh token when auth-service does not rotate it", async () => {
	globalThis.fetch = async () => Response.json({ accessToken: "fresh-oid" });

	const result = await refreshAdplistPropsOnTokenExchange(
		{
			grantType: "refresh_token",
			clientId: "client",
			userId: "user-1",
			scope: [],
			requestedScope: [],
			props: {
				userId: "user-1",
				email: null,
				scopes: [],
				cognitoAccessToken: "stale-oid",
				adplistRefreshToken: "old-refresh",
			},
		},
		testEnv(),
	);

	assert.equal(result.newProps.cognitoAccessToken, "fresh-oid");
	assert.equal(result.newProps.adplistRefreshToken, "old-refresh");
});

test("invalid or missing ADPList refresh tokens surface as AUTH_EXPIRED", async () => {
	await assert.rejects(
		() =>
			refreshAdplistPropsOnTokenExchange(
				{
					grantType: "refresh_token",
					clientId: "client",
					userId: "user-1",
					scope: [],
					requestedScope: [],
					props: { userId: "user-1", email: null, scopes: [] },
				},
				testEnv(),
			),
		AuthExpiredError,
	);

	globalThis.fetch = async () => new Response("expired", { status: 400 });
	await assert.rejects(
		() =>
			refreshAdplistPropsOnTokenExchange(
				{
					grantType: "refresh_token",
					clientId: "client",
					userId: "user-1",
					scope: [],
					requestedScope: [],
					props: {
						userId: "user-1",
						email: null,
						scopes: [],
						adplistRefreshToken: "expired-refresh",
					},
				},
				testEnv(),
			),
		AuthExpiredError,
	);

	assert.equal(formatToolError(new Error("AUTH_EXPIRED: reconnect")).error.code, "AUTH_EXPIRED");
});

test("transient ADPList refresh failures stay retryable", async () => {
	globalThis.fetch = async () => new Response("temporary", { status: 503 });

	await assert.rejects(
		() =>
			refreshAdplistPropsOnTokenExchange(
				{
					grantType: "refresh_token",
					clientId: "client",
					userId: "user-1",
					scope: [],
					requestedScope: [],
					props: {
						userId: "user-1",
						email: null,
						scopes: [],
						adplistRefreshToken: "still-valid-refresh",
					},
				},
				testEnv(),
			),
		UpstreamRefreshError,
	);

	const authExpired = await tokenRefreshErrorResponse(new AuthExpiredError()).json();
	assert.equal(authExpired.error, "invalid_grant");

	const upstream = tokenRefreshErrorResponse(new UpstreamRefreshError());
	assert.equal(upstream.status, 503);
	assert.equal((await upstream.json()).error, "temporarily_unavailable");
});

test("token exchange skips ADPList refresh while the access token is fresh", async () => {
	let fetchCalls = 0;
	globalThis.fetch = async () => {
		fetchCalls += 1;
		return new Response(JSON.stringify({ accessToken: jwtWithExp(9999999999) }), { status: 200 });
	};

	const result = await refreshAdplistPropsOnTokenExchange(
		{
			grantType: "refresh_token",
			clientId: "client",
			userId: "user-1",
			scope: [],
			requestedScope: [],
			props: {
				userId: "user-1",
				email: null,
				scopes: [],
				cognitoAccessToken: jwtWithExp(Math.floor(Date.now() / 1000) + 6 * 60 * 60),
				adplistRefreshToken: "refresh-1",
			},
		},
		testEnv(),
	);

	assert.equal(result, undefined);
	assert.equal(fetchCalls, 0);
});

test("token exchange keeps existing props when refresh fails transiently and token is still valid", async () => {
	let fetchCalls = 0;
	globalThis.fetch = async () => {
		fetchCalls += 1;
		return new Response("temporary", { status: 503 });
	};

	const result = await refreshAdplistPropsOnTokenExchange(
		{
			grantType: "refresh_token",
			clientId: "client",
			userId: "user-1",
			scope: [],
			requestedScope: [],
			props: {
				userId: "user-1",
				email: null,
				scopes: [],
				// Inside the 5-minute refresh window but not hard-expired yet.
				cognitoAccessToken: jwtWithExp(Math.floor(Date.now() / 1000) + 2 * 60),
				adplistRefreshToken: "refresh-1",
			},
		},
		testEnv(),
	);

	assert.equal(result, undefined);
	assert.equal(fetchCalls, 2);
});

test("ambiguous failed refresh on an expired token becomes AUTH_EXPIRED after one retry", async () => {
	let fetchCalls = 0;
	globalThis.fetch = async () => {
		fetchCalls += 1;
		// auth-service's Cognito-rejection shape: HTTP 200, status Failed, no accessToken.
		return new Response(JSON.stringify({ status: "Failed", requestId: "r" }), { status: 200 });
	};

	await assert.rejects(
		() =>
			refreshAdplistPropsOnTokenExchange(
				{
					grantType: "refresh_token",
					clientId: "client",
					userId: "user-1",
					scope: [],
					requestedScope: [],
					props: {
						userId: "user-1",
						email: null,
						scopes: [],
						cognitoAccessToken: jwtWithExp(Math.floor(Date.now() / 1000) - 60),
						adplistRefreshToken: "refresh-1",
					},
				},
				testEnv(),
			),
		AuthExpiredError,
	);
	assert.equal(fetchCalls, 2);
});

test("plain outage on an expired token stays a retryable 503", async () => {
	let fetchCalls = 0;
	globalThis.fetch = async () => {
		fetchCalls += 1;
		return new Response("down", { status: 502 });
	};

	await assert.rejects(
		() =>
			refreshAdplistPropsOnTokenExchange(
				{
					grantType: "refresh_token",
					clientId: "client",
					userId: "user-1",
					scope: [],
					requestedScope: [],
					props: {
						userId: "user-1",
						email: null,
						scopes: [],
						cognitoAccessToken: jwtWithExp(Math.floor(Date.now() / 1000) - 60),
						adplistRefreshToken: "refresh-1",
					},
				},
				testEnv(),
			),
		UpstreamRefreshError,
	);
	assert.equal(fetchCalls, 2);
});

test("ensureFreshAdplistProps continues with the current token when refresh fails transiently", async () => {
	const { ensureFreshAdplistProps } = await import("../src/adplistTokenRefresh.ts");
	let fetchCalls = 0;
	globalThis.fetch = async () => {
		fetchCalls += 1;
		return new Response("temporary", { status: 503 });
	};

	const currentToken = jwtWithExp(Math.floor(Date.now() / 1000) + 2 * 60);
	const props = {
		userId: "user-1",
		email: null,
		scopes: [],
		cognitoAccessToken: currentToken,
		adplistRefreshToken: "refresh-1",
	};

	const result = await ensureFreshAdplistProps(testEnv(), props);

	assert.equal(result.cognitoAccessToken, currentToken);
	assert.equal(fetchCalls, 2);
});

test("ADPLIST_REFRESH_SKEW_SECONDS override forces refresh of an otherwise fresh token", async () => {
	let fetchCalls = 0;
	const freshAccessToken = jwtWithExp(9999999999);
	globalThis.fetch = async () => {
		fetchCalls += 1;
		return new Response(JSON.stringify({ accessToken: freshAccessToken }), { status: 200 });
	};

	const env = { ...testEnv(), ADPLIST_REFRESH_SKEW_SECONDS: String(48 * 60 * 60) };
	const result = await refreshAdplistPropsOnTokenExchange(
		{
			grantType: "refresh_token",
			clientId: "client",
			userId: "user-1",
			scope: [],
			requestedScope: [],
			props: {
				userId: "user-1",
				email: null,
				scopes: [],
				cognitoAccessToken: jwtWithExp(Math.floor(Date.now() / 1000) + 6 * 60 * 60),
				adplistRefreshToken: "refresh-1",
			},
		},
		env,
	);

	assert.equal(fetchCalls, 1);
	assert.equal(result.newProps.cognitoAccessToken, freshAccessToken);
});

test("persistRefreshTokenOnSignIn overwrites stale overrides with the fresh token", async () => {
	const { persistRefreshTokenOnSignIn } = await import("../src/adplistTokenRefresh.ts");
	const env = testEnv();
	env._kv.set("adplist_refresh_token:client:user-1", "old-token");
	env._kv.set("adplist_refresh_token:unknown:user-1", "older-token");

	await persistRefreshTokenOnSignIn(env, "user-1", "client", "fresh-token");

	assert.equal(env._kv.get("adplist_refresh_token:client:user-1"), "fresh-token");
	assert.equal(env._kv.get("adplist_refresh_token:unknown:user-1"), "fresh-token");
});

test("persistRefreshTokenOnSignIn clears overrides when sign-in has no refresh token", async () => {
	const { persistRefreshTokenOnSignIn } = await import("../src/adplistTokenRefresh.ts");
	const env = testEnv();
	env._kv.set("adplist_refresh_token:client:user-1", "old-token");
	env._kv.set("adplist_refresh_token:unknown:user-1", "older-token");

	await persistRefreshTokenOnSignIn(env, "user-1", "client", undefined);

	assert.equal(env._kv.has("adplist_refresh_token:client:user-1"), false);
	assert.equal(env._kv.has("adplist_refresh_token:unknown:user-1"), false);
});

test("definitive 4xx rejection with a still-valid token degrades instead of forcing reconnect", async () => {
	let fetchCalls = 0;
	globalThis.fetch = async () => {
		fetchCalls += 1;
		return new Response("nope", { status: 401 });
	};

	const result = await refreshAdplistPropsOnTokenExchange(
		{
			grantType: "refresh_token",
			clientId: "client",
			userId: "user-1",
			scope: [],
			requestedScope: [],
			props: {
				userId: "user-1",
				email: null,
				scopes: [],
				cognitoAccessToken: jwtWithExp(Math.floor(Date.now() / 1000) + 2 * 60),
				adplistRefreshToken: "rejected-refresh",
			},
		},
		testEnv(),
	);

	assert.equal(result, undefined);
	assert.equal(fetchCalls, 1);
});

test("definitive 4xx rejection with a hard-expired token raises AUTH_EXPIRED without retry", async () => {
	let fetchCalls = 0;
	globalThis.fetch = async () => {
		fetchCalls += 1;
		return new Response("nope", { status: 401 });
	};

	await assert.rejects(
		() =>
			refreshAdplistPropsOnTokenExchange(
				{
					grantType: "refresh_token",
					clientId: "client",
					userId: "user-1",
					scope: [],
					requestedScope: [],
					props: {
						userId: "user-1",
						email: null,
						scopes: [],
						cognitoAccessToken: jwtWithExp(Math.floor(Date.now() / 1000) - 60),
						adplistRefreshToken: "rejected-refresh",
					},
				},
				testEnv(),
			),
		AuthExpiredError,
	);
	assert.equal(fetchCalls, 1);
});
