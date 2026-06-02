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
