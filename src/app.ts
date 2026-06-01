import { Hono } from "hono";
import { html, raw } from "hono/html";
import { MCP_SCOPES } from "./config";
import { sendOtp, verifyOtp } from "./adplistAuth";
import { accessTokenExpiresAt } from "./adplistTokenRefresh";
import type { Bindings, McpUserProps, StoredLogin, StoredRevoke } from "./types";

const LOGIN_TTL_SECONDS = 60 * 60;
const OTP_RATE_LIMIT = 5;
const OTP_RATE_WINDOW_SECONDS = 15 * 60;

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) =>
	c.html(
		renderInfoPage(
			"ADPList MCP",
			"Connect ADPList to supported AI clients at https://mcp.adplist.org/sse.",
			"Manage access",
			"/account/revoke",
		),
	),
);
const DEPLOYED_TOOL_NAMES = [
	"manage_my_context",
	"search_mentors",
	"list_availability",
	"book_session",
	"list_my_sessions",
	"list_journals",
	"read_journal",
	"list_mentor_requests",
	"respond_to_mentor_request",
	"reschedule_as_mentor",
	"list_my_mentees",
	"cancel_session",
] as const;

app.get("/health", (c) => c.json({ ok: true }));
app.get("/debug/tools", (c) =>
	c.json({
		version: "mentor-mode-v2-2026-05-26",
		toolCount: DEPLOYED_TOOL_NAMES.length,
		tools: DEPLOYED_TOOL_NAMES,
	}),
);

app.get("/account/revoke", (c) => c.html(renderRevokeEmailPage()));

app.post("/account/revoke/login", async (c) => {
	const body = await c.req.parseBody();
	const email = stringField(body.email)?.trim().toLowerCase();
	if (!email) {
		return c.html(renderErrorPage("Please enter your email address."), 400);
	}

	const ip = c.req.header("cf-connecting-ip") ?? "unknown";
	if (await consumeRateLimit(c.env, `otp_rate:${ip}`)) {
		return c.html(
			renderErrorPage("Too many sign-in attempts. Please wait a few minutes and retry."),
			429,
		);
	}

	let otp;
	try {
		otp = await sendOtp(c.env, email);
	} catch {
		return c.html(
			renderErrorPage("We couldn't email a sign-in code. Check the address and try again."),
			502,
		);
	}

	const revokeId = crypto.randomUUID();
	await putRevoke(c.env, revokeId, {
		createdAt: Date.now(),
		email,
		cognitoSession: otp.session,
		cognitoUserId: otp.cognitoUserId,
	});

	return c.html(renderRevokeOtpPage(revokeId, email));
});

app.post("/account/revoke/verify", async (c) => {
	const body = await c.req.parseBody();
	const revokeId = stringField(body.revokeId);
	const code = stringField(body.code)?.trim();
	if (!revokeId || !code) {
		return c.html(renderErrorPage("Please enter the 6-digit code."), 400);
	}

	const stored = await getRevoke(c.env, revokeId);
	if (!stored) {
		return c.html(renderErrorPage("Your revoke session expired. Please start again."), 400);
	}

	let verified;
	try {
		verified = await verifyOtp(c.env, {
			code,
			cognitoUserId: stored.cognitoUserId,
			session: stored.cognitoSession,
		});
	} catch {
		return c.html(
			renderErrorPage("That code was incorrect or expired. Please start again to retry."),
			400,
		);
	}

	let revokedCount = 0;
	let cursor: string | undefined;
	do {
		const result = await c.env.OAUTH_PROVIDER.listUserGrants(verified.userId, {
			limit: 100,
			...(cursor ? { cursor } : {}),
		});
		for (const grant of result.items) {
			await c.env.OAUTH_PROVIDER.revokeGrant(grant.id, verified.userId);
			revokedCount += 1;
		}
		cursor = result.cursor;
	} while (cursor);
	await c.env.OAUTH_KV.delete(`oauth_revoke:${revokeId}`);

	return c.html(renderRevokeDonePage(revokedCount));
});

// Step 1 — an MCP client (e.g. Claude) starts the OAuth flow. Render the email page.
app.get("/oauth/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
	const loginId = crypto.randomUUID();
	await putLogin(c.env, loginId, {
		oauthReqInfo,
		clientName: client?.clientName,
		createdAt: Date.now(),
	});
	return c.html(renderEmailPage(loginId, client?.clientName));
});

// Step 2 — the user submits their email. Ask ADPList to email a sign-in code.
app.post("/oauth/login", async (c) => {
	const body = await c.req.parseBody();
	const loginId = stringField(body.loginId);
	const email = stringField(body.email)?.trim().toLowerCase();
	if (!loginId || !email) {
		return c.html(renderErrorPage("Please enter your email address."), 400);
	}

	const stored = await getLogin(c.env, loginId);
	if (!stored) {
		return c.html(renderErrorPage("Your sign-in session expired. Please start again."), 400);
	}

	const ip = c.req.header("cf-connecting-ip") ?? "unknown";
	if (await consumeRateLimit(c.env, `otp_rate:${ip}`)) {
		return c.html(
			renderErrorPage("Too many sign-in attempts. Please wait a few minutes and retry."),
			429,
		);
	}

	let otp;
	try {
		otp = await sendOtp(c.env, email);
	} catch {
		return c.html(
			renderErrorPage("We couldn't email a sign-in code. Check the address and try again."),
			502,
		);
	}

	await putLogin(c.env, loginId, {
		...stored,
		email,
		cognitoSession: otp.session,
		cognitoUserId: otp.cognitoUserId,
	});
	return c.html(renderOtpPage(loginId, email, stored.clientName));
});

// Step 3 — the user submits the code. Verify it, then complete the MCP authorization.
app.post("/oauth/verify", async (c) => {
	const body = await c.req.parseBody();
	const loginId = stringField(body.loginId);
	const code = stringField(body.code)?.trim();
	if (!loginId || !code) {
		return c.html(renderErrorPage("Please enter the 6-digit code."), 400);
	}

	const stored = await getLogin(c.env, loginId);
	if (!stored?.cognitoSession || !stored.cognitoUserId) {
		return c.html(renderErrorPage("Your sign-in session expired. Please start again."), 400);
	}

	let verified;
	try {
		verified = await verifyOtp(c.env, {
			code,
			cognitoUserId: stored.cognitoUserId,
			session: stored.cognitoSession,
		});
	} catch {
		return c.html(
			renderErrorPage(
				"That code was incorrect or expired. Close this window and click Connect again to retry.",
			),
			400,
		);
	}

	await c.env.OAUTH_KV.delete(`oauth_login:${loginId}`);

	const props: McpUserProps = {
		userId: verified.userId,
		email: stored.email ?? null,
		scopes: [...MCP_SCOPES],
		mcpClientId: stored.oauthReqInfo.clientId,
		cognitoAccessToken: verified.accessToken,
		cognitoAccessTokenExpiresAt: accessTokenExpiresAt(verified.accessToken),
		cognitoAccessTokenRefreshedAt: Math.floor(Date.now() / 1000),
		adplistRefreshToken: verified.refreshToken,
	};

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		request: stored.oauthReqInfo,
		userId: verified.userId,
		metadata: { label: stored.email ?? verified.userId },
		scope: stored.oauthReqInfo.scope.length > 0 ? stored.oauthReqInfo.scope : [...MCP_SCOPES],
		props,
	});

	return c.redirect(redirectTo, 302);
});

export default app;

async function putLogin(env: Bindings, loginId: string, value: StoredLogin): Promise<void> {
	await env.OAUTH_KV.put(`oauth_login:${loginId}`, JSON.stringify(value), {
		expirationTtl: LOGIN_TTL_SECONDS,
	});
}

async function getLogin(env: Bindings, loginId: string): Promise<StoredLogin | null> {
	const stored = await env.OAUTH_KV.get(`oauth_login:${loginId}`);
	if (!stored) return null;
	try {
		return JSON.parse(stored) as StoredLogin;
	} catch {
		return null;
	}
}

async function putRevoke(env: Bindings, revokeId: string, value: StoredRevoke): Promise<void> {
	await env.OAUTH_KV.put(`oauth_revoke:${revokeId}`, JSON.stringify(value), {
		expirationTtl: LOGIN_TTL_SECONDS,
	});
}

async function getRevoke(env: Bindings, revokeId: string): Promise<StoredRevoke | null> {
	const stored = await env.OAUTH_KV.get(`oauth_revoke:${revokeId}`);
	if (!stored) return null;
	try {
		return JSON.parse(stored) as StoredRevoke;
	} catch {
		return null;
	}
}

// Best-effort per-IP throttle so the OTP email endpoint can't be abused as a mailer.
async function consumeRateLimit(env: Bindings, key: string): Promise<boolean> {
	const raw = await env.OAUTH_KV.get(key);
	const parsed = Number(raw ?? "0");
	const count = Number.isFinite(parsed) ? parsed : 0;
	if (count >= OTP_RATE_LIMIT) return true;
	await env.OAUTH_KV.put(key, String(count + 1), { expirationTtl: OTP_RATE_WINDOW_SECONDS });
	return false;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

const STYLES = `:root{color-scheme:light}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#f3f4f6;color:#111827;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem}.card{background:#fff;max-width:25rem;width:100%;border-radius:.875rem;box-shadow:0 1px 3px rgba(0,0,0,.08),0 12px 28px rgba(0,0,0,.07);padding:2rem;box-sizing:border-box}.brand{font-weight:700;font-size:1.05rem;letter-spacing:-.01em}h1{font-size:1.3rem;margin:1.1rem 0 .35rem}p{color:#4b5563;line-height:1.55;margin:.35rem 0;font-size:.95rem}label{display:block;font-weight:600;font-size:.85rem;margin:1.2rem 0 .4rem}input{width:100%;box-sizing:border-box;padding:.7rem .8rem;border:1px solid #d1d5db;border-radius:.55rem;font-size:1rem}input:focus{outline:2px solid #111827;outline-offset:0;border-color:#111827}button,.button{display:block;text-align:center;text-decoration:none;box-sizing:border-box;width:100%;margin-top:1.3rem;border:0;border-radius:.55rem;padding:.8rem 1rem;font-weight:600;font-size:1rem;background:#111827;color:#fff;cursor:pointer}button:hover,.button:hover{background:#1f2937}.scopes{background:#f9fafb;border:1px solid #e5e7eb;border-radius:.55rem;padding:.7rem .85rem;margin-top:1.1rem;font-size:.85rem;color:#4b5563}.scopes div{margin-top:.25rem}.muted{font-size:.82rem;color:#6b7280;margin-top:1.1rem}`;

function renderInfoPage(title: string, message: string, linkText: string, href: string) {
	return html`<!doctype html>
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>${title}</title>
				<style>
					${raw(STYLES)}
				</style>
			</head>
			<body>
				<div class="card">
					<div class="brand">ADPList</div>
					<h1>${title}</h1>
					<p>${message}</p>
					<a class="button" href="${href}">${linkText}</a>
				</div>
			</body>
		</html>`;
}

function renderRevokeEmailPage() {
	return html`<!doctype html>
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>Manage ADPList MCP access</title>
				<style>
					${raw(STYLES)}
				</style>
			</head>
			<body>
				<div class="card">
					<div class="brand">ADPList</div>
					<h1>Disconnect ADPList MCP</h1>
					<p>
						Enter your ADPList email. We'll send a one-time code, then revoke all active
						AI client connections for this MCP server.
					</p>
					<form method="post" action="/account/revoke/login">
						<label for="email">Email address</label>
						<input
							id="email"
							name="email"
							type="email"
							inputmode="email"
							autocomplete="email"
							placeholder="you@example.com"
							required
							autofocus
						/>
						<button type="submit">Email me a code</button>
					</form>
					<p class="muted">You can reconnect later from Claude Desktop or Claude Code.</p>
				</div>
			</body>
		</html>`;
}

function renderRevokeOtpPage(revokeId: string, email: string) {
	return html`<!doctype html>
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>Confirm disconnect</title>
				<style>
					${raw(STYLES)}
				</style>
			</head>
			<body>
				<div class="card">
					<div class="brand">ADPList</div>
					<h1>Confirm disconnect</h1>
					<p>We emailed a 6-digit code to <strong>${email}</strong>.</p>
					<form method="post" action="/account/revoke/verify">
						<input type="hidden" name="revokeId" value="${revokeId}" />
						<label for="code">6-digit code</label>
						<input
							id="code"
							name="code"
							type="text"
							inputmode="numeric"
							autocomplete="one-time-code"
							pattern="[0-9]*"
							maxlength="6"
							placeholder="123456"
							required
							autofocus
						/>
						<button type="submit">Disconnect AI clients</button>
					</form>
				</div>
			</body>
		</html>`;
}

function renderRevokeDonePage(revokedCount: number) {
	const connectionText = revokedCount === 1 ? "connection" : "connections";
	return html`<!doctype html>
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>ADPList MCP disconnected</title>
				<style>
					${raw(STYLES)}
				</style>
			</head>
			<body>
				<div class="card">
					<div class="brand">ADPList</div>
					<h1>Disconnected</h1>
					<p>Revoked ${revokedCount} active ADPList MCP ${connectionText}.</p>
					<p class="muted">
						If an AI client still shows ADPList, remove it from that client too. You can
						reconnect any time.
					</p>
				</div>
			</body>
		</html>`;
}

function renderEmailPage(loginId: string, clientName?: string) {
	const client = clientName ?? "an AI client";
	return html`<!doctype html>
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>Sign in to ADPList</title>
				<style>
					${raw(STYLES)}
				</style>
			</head>
			<body>
				<div class="card">
					<div class="brand">ADPList</div>
					<h1>Sign in to continue</h1>
					<p>
						Connect <strong>${client}</strong> to your ADPList account. We'll email you
						a one-time sign-in code.
					</p>
					<form method="post" action="/oauth/login">
						<input type="hidden" name="loginId" value="${loginId}" />
						<label for="email">Email address</label>
						<input
							id="email"
							name="email"
							type="email"
							inputmode="email"
							autocomplete="email"
							placeholder="you@example.com"
							required
							autofocus
						/>
						<button type="submit">Email me a code</button>
					</form>
					<p class="muted">Use the same email as your ADPList account.</p>
				</div>
			</body>
		</html>`;
}

function renderOtpPage(loginId: string, email: string, clientName?: string) {
	const client = clientName ?? "an AI client";
	return html`<!doctype html>
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>Enter your code</title>
				<style>
					${raw(STYLES)}
				</style>
			</head>
			<body>
				<div class="card">
					<div class="brand">ADPList</div>
					<h1>Enter your sign-in code</h1>
					<p>We emailed a 6-digit code to <strong>${email}</strong>.</p>
					<form method="post" action="/oauth/verify">
						<input type="hidden" name="loginId" value="${loginId}" />
						<label for="code">6-digit code</label>
						<input
							id="code"
							name="code"
							type="text"
							inputmode="numeric"
							autocomplete="one-time-code"
							pattern="[0-9]*"
							maxlength="6"
							placeholder="123456"
							required
							autofocus
						/>
						<div class="scopes">
							Continuing authorizes <strong>${client}</strong> to access your ADPList
							account: ${MCP_SCOPES.map((scope) => html`<div>• ${scope}</div>`)}
						</div>
						<button type="submit">Verify and connect</button>
					</form>
					<p class="muted">
						Didn't get the email? Close this window and click Connect again.
					</p>
				</div>
			</body>
		</html>`;
}

function renderErrorPage(message: string) {
	return html`<!doctype html>
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>Sign-in problem</title>
				<style>
					${raw(STYLES)}
				</style>
			</head>
			<body>
				<div class="card">
					<div class="brand">ADPList</div>
					<h1>Sign-in couldn't continue</h1>
					<p>${message}</p>
					<p class="muted">
						Close this window and click Connect again in your app to retry.
					</p>
				</div>
			</body>
		</html>`;
}
