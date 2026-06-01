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

test("refreshAdplistPropsOnTokenExchange refreshes oid and persists rotated refresh token", async () => {
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
		{ AUTH_SERVICE_URL: "https://auth.example.com" },
	);

	assert.equal(result.newProps.cognitoAccessToken, "fresh-oid");
	assert.equal(result.newProps.adplistRefreshToken, "fresh-refresh");
	assert.equal(result.newProps.email, "user@example.com");
});

test("ensureFreshAdplistProps refreshes an access token before it expires", async () => {
	const { ensureFreshAdplistProps } = await import("../src/adplistTokenRefresh.ts");
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

	const result = await ensureFreshAdplistProps(
		{ AUTH_SERVICE_URL: "https://auth.example.com" },
		props,
	);

	assert.equal(refreshCalls, 1);
	assert.equal(result, props);
	assert.equal(props.cognitoAccessToken, freshToken);
	assert.equal(props.adplistRefreshToken, "rotated-refresh");
	assert.ok(props.cognitoAccessTokenExpiresAt > Math.floor(Date.now() / 1000));
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

	const result = await ensureFreshAdplistProps(
		{ AUTH_SERVICE_URL: "https://auth.example.com" },
		props,
	);

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
		{ AUTH_SERVICE_URL: "https://auth.example.com" },
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
				{ AUTH_SERVICE_URL: "https://auth.example.com" },
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
				{ AUTH_SERVICE_URL: "https://auth.example.com" },
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
				{ AUTH_SERVICE_URL: "https://auth.example.com" },
			),
		UpstreamRefreshError,
	);

	const authExpired = await tokenRefreshErrorResponse(new AuthExpiredError()).json();
	assert.equal(authExpired.error, "invalid_grant");

	const upstream = tokenRefreshErrorResponse(new UpstreamRefreshError());
	assert.equal(upstream.status, 503);
	assert.equal((await upstream.json()).error, "temporarily_unavailable");
});
