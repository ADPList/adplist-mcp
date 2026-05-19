import { Hono } from "hono";
import { html } from "hono/html";
import { MCP_SCOPES } from "./config";
import { buildCognitoAuthorizeUrl, exchangeCognitoCode, fetchCognitoUserInfo } from "./cognito";
import type { Bindings, McpUserProps, PendingConsent, StoredOAuthRequest } from "./types";

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
	const consentId = crypto.randomUUID();
	const pendingConsent: PendingConsent = { ...storedRequest, tokens, userInfo };

	await c.env.OAUTH_KV.put(`oauth_consent:${consentId}`, JSON.stringify(pendingConsent), {
		expirationTtl: OAUTH_STATE_TTL_SECONDS,
	});

	const client = await c.env.OAUTH_PROVIDER.lookupClient(storedRequest.oauthReqInfo.clientId);
	return c.html(renderConsentPage({ consentId, clientName: client?.clientName, scopes: storedRequest.oauthReqInfo.scope }));
});

app.post("/oauth/consent", async (c) => {
	const body = await c.req.parseBody();
	const consentId = typeof body.consentId === "string" ? body.consentId : undefined;
	const action = typeof body.action === "string" ? body.action : undefined;
	if (!consentId || !action) {
		return c.json({ error: "Missing consent action" }, 400);
	}

	const pendingValue = await c.env.OAUTH_KV.get(`oauth_consent:${consentId}`);
	if (!pendingValue) {
		return c.json({ error: "Consent request expired or invalid" }, 400);
	}
	await c.env.OAUTH_KV.delete(`oauth_consent:${consentId}`);

	const pending = JSON.parse(pendingValue) as PendingConsent;
	if (action !== "approve") {
		return c.redirect(oauthErrorRedirect(pending.oauthReqInfo.redirectUri, pending.oauthReqInfo.state), 302);
	}

	const { userInfo, tokens, oauthReqInfo } = pending;
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
		cognitoAccessToken: tokens.access_token,
	};

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		request: oauthReqInfo,
		userId: userInfo.sub,
		metadata: { label: email ?? userInfo.username ?? userInfo.sub },
		scope: oauthReqInfo.scope.length > 0 ? oauthReqInfo.scope : [...MCP_SCOPES],
		props,
	});

	return c.redirect(redirectTo, 302);
});

function renderConsentPage(options: { consentId: string; clientName?: string; scopes: string[] }) {
	const clientName = options.clientName ?? "MCP client";
	const scopes = options.scopes.length > 0 ? options.scopes : [...MCP_SCOPES];
	return html`<!doctype html>
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>Authorize ADPList MCP</title>
				<style>
					body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem; color: #111827; }
					button { border: 0; border-radius: 0.5rem; padding: 0.75rem 1rem; font-weight: 600; cursor: pointer; }
					.approve { background: #111827; color: white; }
					.deny { background: #e5e7eb; color: #111827; margin-left: 0.5rem; }
				</style>
			</head>
			<body>
				<h1>Authorize ADPList MCP</h1>
				<p><strong>${clientName}</strong> is requesting access to ADPList MCP.</p>
				<ul>${scopes.map((scope) => html`<li>${scope}</li>`)}</ul>
				<form method="post" action="/oauth/consent">
					<input type="hidden" name="consentId" value="${options.consentId}" />
					<button class="approve" type="submit" name="action" value="approve">Approve</button>
					<button class="deny" type="submit" name="action" value="deny">Deny</button>
				</form>
			</body>
		</html>`;
}

function oauthErrorRedirect(redirectUri: string, state: string): string {
	const url = new URL(redirectUri);
	url.searchParams.set("error", "access_denied");
	url.searchParams.set("error_description", "User denied ADPList MCP access");
	url.searchParams.set("state", state);
	return url.toString();
}

export default app;
