import { Hono } from "hono";
import { MCP_SCOPES } from "./config";
import { buildCognitoAuthorizeUrl, exchangeCognitoCode, fetchCognitoUserInfo } from "./cognito";
import type { Bindings, McpUserProps, StoredOAuthRequest } from "./types";

const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const COGNITO_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => c.json({ name: "adplist-mcp", status: "ok" }));
app.get("/health", (c) => c.json({ ok: true }));

app.get("/oauth/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const state = crypto.randomUUID();
	const storedRequest: StoredOAuthRequest = { oauthReqInfo, createdAt: Date.now() };

	await c.env.OAUTH_KV.put(`oauth_state:${state}`, JSON.stringify(storedRequest), {
		expirationTtl: OAUTH_STATE_TTL_SECONDS,
	});

	return c.redirect(buildCognitoAuthorizeUrl(c.env, c.req.url, state), 302);
});

app.get("/oauth/callback", async (c) => {
	const code = c.req.query("code");
	const state = c.req.query("state");
	if (!code || !state) {
		return c.json({ error: "Missing Cognito callback code or state" }, 400);
	}

	const storedValue = await c.env.OAUTH_KV.get(`oauth_state:${state}`);
	if (!storedValue) {
		return c.json({ error: "OAuth state expired or invalid" }, 400);
	}
	await c.env.OAUTH_KV.delete(`oauth_state:${state}`);

	const storedRequest = JSON.parse(storedValue) as StoredOAuthRequest;
	const tokens = await exchangeCognitoCode(c.env, c.req.url, code);
	const userInfo = await fetchCognitoUserInfo(c.env, tokens.access_token);
	const email = userInfo.email ?? null;
	const refreshTokenKey = `cognito_refresh:${userInfo.sub}`;

	if (tokens.refresh_token) {
		await c.env.OAUTH_KV.put(refreshTokenKey, tokens.refresh_token, {
			expirationTtl: COGNITO_REFRESH_TTL_SECONDS,
		});
	}

	const props: McpUserProps = {
		userId: userInfo.sub,
		email,
		scopes: [...MCP_SCOPES],
		cognitoRefreshTokenKey: tokens.refresh_token ? refreshTokenKey : undefined,
	};

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		request: storedRequest.oauthReqInfo,
		userId: userInfo.sub,
		metadata: { label: email ?? userInfo.username ?? userInfo.sub },
		scope: storedRequest.oauthReqInfo.scope.length > 0 ? storedRequest.oauthReqInfo.scope : [...MCP_SCOPES],
		props,
	});

	return c.redirect(redirectTo, 302);
});

export default app;
