import { Hono } from "hono";
import type { Context } from "hono";
import { html, raw } from "hono/html";
import { MCP_SCOPES } from "./config.ts";
import { sendOtp, verifyOtp } from "./adplistAuth.ts";
import { accessTokenExpiresAt, persistRefreshTokenOnSignIn } from "./adplistTokenRefresh.ts";
import { recordMcpConnectionSuccess, sendWelcomeEmailOnce } from "./welcomeEmail.ts";
import type { Bindings, McpUserProps, StoredLogin, StoredRevoke } from "./types";

const LOGIN_TTL_SECONDS = 60 * 60;
const OTP_RATE_LIMIT = 5;
const OTP_RATE_WINDOW_SECONDS = 15 * 60;
// Per-email send throttle (independent of the per-IP limit) so a distributed
// attacker can't mail-bomb a single ADPList user across many IPs.
const OTP_EMAIL_RATE_LIMIT = 5;
const OTP_EMAIL_RATE_WINDOW_SECONDS = 60 * 60;
// Cap OTP guesses per sign-in/revoke session, then burn the session. Defense in
// depth: the app no longer relies on the upstream Cognito challenge session
// becoming single-use to bound brute-forcing of the 6-digit code.
const OTP_VERIFY_MAX_ATTEMPTS = 5;
const TOO_MANY_CODES_MESSAGE =
	"Too many incorrect codes. Close this window and click Connect again to retry.";
// Duplicate-submit handling for /oauth/verify. The in-flight marker covers a slow
// upstream verify (KV's minimum TTL is 60 s); the completion record lets a
// duplicate replay the first request's redirect.
const VERIFY_INFLIGHT_TTL_SECONDS = 60;
const VERIFY_DONE_TTL_SECONDS = 10 * 60;
const VERIFY_DUPLICATE_WAIT_MS = 8000;
const VERIFY_DONE_POLL_INTERVAL_MS = 250;

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
	"search_journal_learnings",
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
	const email = emailField(body.email);
	if (!email) {
		return c.html(renderErrorPage("Please enter your email address."), 400);
	}

	const ip = c.req.header("cf-connecting-ip") ?? "unknown";
	if (await otpSendThrottled(c.env, ip, email)) {
		return c.html(
			renderErrorPage("Too many sign-in attempts. Please wait a few minutes and retry."),
			429,
		);
	}

	// Never reveal whether the account exists: render the same code-entry page
	// whether or not sendOtp succeeded. A missing session just surfaces as
	// "session expired" at the verify step.
	const revokeId = crypto.randomUUID();
	try {
		const otp = await sendOtp(c.env, email);
		await putRevoke(c.env, revokeId, {
			createdAt: Date.now(),
			email,
			cognitoSession: otp.session,
			cognitoUserId: otp.cognitoUserId,
		});
	} catch {
		await putRevoke(c.env, revokeId, { createdAt: Date.now(), email });
	}

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
	if (!stored?.cognitoSession || !stored.cognitoUserId) {
		return c.html(renderErrorPage("Your revoke session expired. Please start again."), 400);
	}

	const attemptsKey = `oauth_revoke_attempts:${revokeId}`;
	if (await otpAttemptsExhausted(c.env, attemptsKey)) {
		await c.env.OAUTH_KV.delete(`oauth_revoke:${revokeId}`);
		await c.env.OAUTH_KV.delete(attemptsKey);
		return c.html(
			renderErrorPage("Too many incorrect codes. Please start again to retry."),
			429,
		);
	}

	const verified = await verifyOtp(c.env, {
		code,
		cognitoUserId: stored.cognitoUserId,
		session: stored.cognitoSession,
	});
	if (verified.kind !== "verified") {
		if ((await registerFailedOtpAttempt(c.env, attemptsKey)) >= OTP_VERIFY_MAX_ATTEMPTS) {
			await c.env.OAUTH_KV.delete(`oauth_revoke:${revokeId}`);
			await c.env.OAUTH_KV.delete(attemptsKey);
		}
		return c.html(
			renderErrorPage("That code was incorrect or expired. Please start again to retry."),
			400,
		);
	}
	await c.env.OAUTH_KV.delete(attemptsKey);

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
	const email = emailField(body.email);
	if (!loginId || !email) {
		return c.html(renderErrorPage("Please enter your email address."), 400);
	}

	const stored = await getLogin(c.env, loginId);
	if (!stored) {
		return c.html(renderErrorPage("Your sign-in session expired. Please start again."), 400);
	}

	const ip = c.req.header("cf-connecting-ip") ?? "unknown";
	if (await otpSendThrottled(c.env, ip, email)) {
		return c.html(
			renderErrorPage("Too many sign-in attempts. Please wait a few minutes and retry."),
			429,
		);
	}

	// Never reveal whether the account exists: render the same code-entry page
	// whether or not sendOtp succeeded. A missing session just surfaces as
	// "session expired" at the verify step.
	try {
		const otp = await sendOtp(c.env, email);
		await putLogin(c.env, loginId, {
			...stored,
			email,
			cognitoSession: otp.session,
			cognitoUserId: otp.cognitoUserId,
		});
	} catch {
		// Clear any Cognito session from a prior successful send on this loginId so a
		// failed resend can't leave the old code verifiable against a new email address.
		await putLogin(c.env, loginId, {
			...stored,
			email,
			cognitoSession: undefined,
			cognitoUserId: undefined,
		});
	}
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

	// Duplicate submits (a second click or Enter while the first POST is still
	// running) are common: the browser cancels the first request, losing its
	// redirect, and the second finds the Cognito session already consumed. Answer
	// duplicates with the first request's redirect instead of an error. The
	// completion record is bound to the code, so replaying it still needs both
	// the loginId and the correct code, and a wrong code deletes it (see getVerifyDone).
	const codeDigest = await verifyCodeDigest(loginId, code);
	const done = await getVerifyDone(c.env, loginId, codeDigest);
	if (done === "mismatch") {
		return c.html(renderErrorPage("Your sign-in session expired. Please start again."), 400);
	}
	if (done) return c.redirect(done.redirectTo, 302);

	const inflightKey = `oauth_verify_inflight:${loginId}`;
	let waitedForDuplicate = false;
	const awaitDuplicate = async () => {
		if (waitedForDuplicate) return null;
		waitedForDuplicate = true;
		return waitForVerifyDone(c.env, loginId, codeDigest);
	};
	if (await c.env.OAUTH_KV.get(inflightKey)) {
		const redirectTo = await awaitDuplicate();
		if (redirectTo) return c.redirect(redirectTo, 302);
	}

	const stored = await getLogin(c.env, loginId);
	if (!stored?.cognitoSession || !stored.cognitoUserId) {
		const redirectTo = await awaitDuplicate();
		if (redirectTo) return c.redirect(redirectTo, 302);
		return c.html(renderErrorPage("Your sign-in session expired. Please start again."), 400);
	}

	const attemptsKey = `oauth_verify_attempts:${loginId}`;
	if (await otpAttemptsExhausted(c.env, attemptsKey)) {
		await c.env.OAUTH_KV.delete(`oauth_login:${loginId}`);
		await c.env.OAUTH_KV.delete(attemptsKey);
		return c.html(renderErrorPage(TOO_MANY_CODES_MESSAGE), 429);
	}

	// Run the upstream verify and everything after it under waitUntil as well as
	// awaiting it, so a request the browser cancels still finishes and records its
	// redirect for the duplicate that replaced it.
	await c.env.OAUTH_KV.put(inflightKey, "1", { expirationTtl: VERIFY_INFLIGHT_TTL_SECONDS });
	const attempt = verifyAndCompleteLogin(c, loginId, code, codeDigest, stored, {
		session: stored.cognitoSession,
		userId: stored.cognitoUserId,
	}).finally(() => c.env.OAUTH_KV.delete(inflightKey));
	keepAlive(c, attempt);
	const result = await attempt;

	if (result.kind === "verified") return c.redirect(result.redirectTo, 302);
	if (result.kind === "wrong_code") {
		if (result.exhausted) return c.html(renderErrorPage(TOO_MANY_CODES_MESSAGE), 429);
		return c.html(
			renderOtpPage(
				loginId,
				stored.email ?? "",
				stored.clientName,
				"That code is incorrect. Check the latest email and try again.",
			),
			400,
		);
	}
	if (result.kind === "expired") {
		const redirectTo = await awaitDuplicate();
		if (redirectTo) return c.redirect(redirectTo, 302);
		return c.html(
			renderErrorPage(
				"This code has expired. Close this window and click Connect again to get a new code.",
			),
			400,
		);
	}
	return c.html(
		renderErrorPage(
			"That code was incorrect or expired. Close this window and click Connect again to retry.",
		),
		400,
	);
});

export default app;

type VerifyAttemptResult =
	| { kind: "verified"; redirectTo: string }
	| { kind: "wrong_code"; exhausted: boolean }
	| { kind: "expired" }
	| { kind: "failed" };

async function verifyAndCompleteLogin(
	c: Context<{ Bindings: Bindings }>,
	loginId: string,
	code: string,
	codeDigest: string,
	stored: StoredLogin,
	cognito: { session: string; userId: string },
): Promise<VerifyAttemptResult> {
	const attemptsKey = `oauth_verify_attempts:${loginId}`;
	const verified = await verifyOtp(c.env, {
		code,
		cognitoUserId: cognito.userId,
		session: cognito.session,
	});
	if (verified.kind === "expired") return verified;
	if (verified.kind !== "verified") {
		if ((await registerFailedOtpAttempt(c.env, attemptsKey)) >= OTP_VERIFY_MAX_ATTEMPTS) {
			await c.env.OAUTH_KV.delete(`oauth_login:${loginId}`);
			await c.env.OAUTH_KV.delete(attemptsKey);
			return verified.kind === "wrong_code" ? { kind: "wrong_code", exhausted: true } : verified;
		}
		if (verified.kind === "failed") return verified;
		// auth-service rotated the challenge session; the emailed code stays valid on
		// the replacement, so keep it for the retry. A concurrent request may have
		// burned or completed the login while this one waited on upstream; re-read
		// right before writing so a stale write can't bring it back. KV has no
		// compare-and-set, so this narrows the window rather than closing it.
		const current = await getLogin(c.env, loginId);
		if (!current || (await c.env.OAUTH_KV.get(`oauth_verify_done:${loginId}`))) {
			return { kind: "failed" };
		}
		await putLogin(c.env, loginId, { ...current, cognitoSession: verified.session });
		return { kind: "wrong_code", exhausted: false };
	}
	await c.env.OAUTH_KV.delete(attemptsKey);

	await recordMcpConnectionSuccess(c.env, {
		userId: verified.userId,
		email: stored.email,
	});
	if (stored.email) {
		keepAlive(
			c,
			sendWelcomeEmailOnce(c.env, {
				userId: verified.userId,
				email: stored.email,
				firstName: "",
				accessToken: verified.accessToken,
				origin: new URL(c.req.url).origin,
			}),
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

	await persistRefreshTokenOnSignIn(
		c.env,
		verified.userId,
		stored.oauthReqInfo.clientId,
		verified.refreshToken,
	);

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		request: stored.oauthReqInfo,
		userId: verified.userId,
		metadata: { label: stored.email ?? verified.userId },
		scope: stored.oauthReqInfo.scope.length > 0 ? stored.oauthReqInfo.scope : [...MCP_SCOPES],
		props,
	});
	await c.env.OAUTH_KV.put(
		`oauth_verify_done:${loginId}`,
		JSON.stringify({ redirectTo, codeDigest }),
		{ expirationTtl: VERIFY_DONE_TTL_SECONDS },
	);

	return { kind: "verified", redirectTo };
}

async function verifyCodeDigest(loginId: string, code: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`${loginId}:${code}`),
	);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The redirect a completed verify of this loginId recorded, if it was for the same
// code. A genuine duplicate always resubmits the code that succeeded, so a record
// for a different code is deleted on sight: one wrong guess ends replay for this
// loginId, and the record can't serve as a code-guessing oracle.
async function getVerifyDone(
	env: Bindings,
	loginId: string,
	codeDigest: string,
): Promise<{ redirectTo: string } | "mismatch" | null> {
	const doneKey = `oauth_verify_done:${loginId}`;
	const stored = await env.OAUTH_KV.get(doneKey);
	if (!stored) return null;
	let done: { redirectTo?: unknown; codeDigest?: unknown };
	try {
		done = JSON.parse(stored) as typeof done;
	} catch {
		return null;
	}
	if (done.codeDigest !== codeDigest) {
		await env.OAUTH_KV.delete(doneKey);
		return "mismatch";
	}
	return typeof done.redirectTo === "string" ? { redirectTo: done.redirectTo } : null;
}

// Poll for the redirect recorded by a concurrent verify of the same loginId.
async function waitForVerifyDone(
	env: Bindings,
	loginId: string,
	codeDigest: string,
): Promise<string | null> {
	const deadline = Date.now() + duplicateVerifyWaitMs(env);
	for (;;) {
		const done = await getVerifyDone(env, loginId, codeDigest);
		if (done === "mismatch") return null;
		if (done) return done.redirectTo;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return null;
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(VERIFY_DONE_POLL_INTERVAL_MS, remaining)),
		);
	}
}

// Tests shorten the duplicate-submit wait; unset in production.
function duplicateVerifyWaitMs(env: Bindings): number {
	const raw = (env as unknown as Record<string, unknown>).OTP_VERIFY_DUPLICATE_WAIT_MS;
	const parsed = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : VERIFY_DUPLICATE_WAIT_MS;
}

// Keep work running if the browser cancels the request. Under app.request in
// tests there is no ExecutionContext; callers that need the result await it.
function keepAlive(c: Context<{ Bindings: Bindings }>, promise: Promise<unknown>): void {
	try {
		c.executionCtx.waitUntil(promise);
	} catch {
		// No ExecutionContext available.
	}
}

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

// Best-effort fixed-window throttle. Returns true when the caller is over the
// limit (and should be rejected). Used for both per-IP and per-email OTP sends.
async function consumeRateLimit(
	env: Bindings,
	key: string,
	limit = OTP_RATE_LIMIT,
	windowSeconds = OTP_RATE_WINDOW_SECONDS,
): Promise<boolean> {
	const raw = await env.OAUTH_KV.get(key);
	const parsed = Number(raw ?? "0");
	const count = Number.isFinite(parsed) ? parsed : 0;
	if (count >= limit) return true;
	await env.OAUTH_KV.put(key, String(count + 1), { expirationTtl: windowSeconds });
	return false;
}

// Reject any OTP send that trips either the per-IP or the per-email budget.
// Check the IP budget FIRST and bail before touching the email counter — otherwise
// an already-throttled IP (which no longer increments) could still drain any
// victim's per-email budget, locking them out without a single OTP being sent.
async function otpSendThrottled(env: Bindings, ip: string, email: string): Promise<boolean> {
	if (await consumeRateLimit(env, `otp_rate:${ip}`)) return true;
	return consumeRateLimit(
		env,
		`otp_email_rate:${email}`,
		OTP_EMAIL_RATE_LIMIT,
		OTP_EMAIL_RATE_WINDOW_SECONDS,
	);
}

// Track failed OTP guesses per sign-in/revoke session so the code can't be
// brute-forced. Returns the running failure count.
async function registerFailedOtpAttempt(env: Bindings, key: string): Promise<number> {
	const raw = await env.OAUTH_KV.get(key);
	const parsed = Number(raw ?? "0");
	const count = (Number.isFinite(parsed) ? parsed : 0) + 1;
	await env.OAUTH_KV.put(key, String(count), { expirationTtl: LOGIN_TTL_SECONDS });
	return count;
}

async function otpAttemptsExhausted(env: Bindings, key: string): Promise<boolean> {
	const raw = await env.OAUTH_KV.get(key);
	const parsed = Number(raw ?? "0");
	const count = Number.isFinite(parsed) ? parsed : 0;
	return count >= OTP_VERIFY_MAX_ATTEMPTS;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Normalize and bound an email before it is ever used (notably as an `otp_email_rate:`
// KV key). RFC 5321 caps addresses at 254 chars; rejecting longer input keeps the key
// under Cloudflare KV's 512-byte limit so a direct POST can't turn the throttle into a 500.
const MAX_EMAIL_LENGTH = 254;
function emailField(value: unknown): string | undefined {
	const email = stringField(value)?.trim().toLowerCase();
	if (!email || email.length > MAX_EMAIL_LENGTH) return undefined;
	return email;
}

const STYLES = `:root{color-scheme:light}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#f3f4f6;color:#111827;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem}.card{background:#fff;max-width:25rem;width:100%;border-radius:.875rem;box-shadow:0 1px 3px rgba(0,0,0,.08),0 12px 28px rgba(0,0,0,.07);padding:2rem;box-sizing:border-box}.brand{font-weight:700;font-size:1.05rem;letter-spacing:-.01em}h1{font-size:1.3rem;margin:1.1rem 0 .35rem}p{color:#4b5563;line-height:1.55;margin:.35rem 0;font-size:.95rem}label{display:block;font-weight:600;font-size:.85rem;margin:1.2rem 0 .4rem}input{width:100%;box-sizing:border-box;padding:.7rem .8rem;border:1px solid #d1d5db;border-radius:.55rem;font-size:1rem}input:focus{outline:2px solid #111827;outline-offset:0;border-color:#111827}button,.button{display:block;text-align:center;text-decoration:none;box-sizing:border-box;width:100%;margin-top:1.3rem;border:0;border-radius:.55rem;padding:.8rem 1rem;font-weight:600;font-size:1rem;background:#111827;color:#fff;cursor:pointer}button:hover,.button:hover{background:#1f2937}.scopes{background:#f9fafb;border:1px solid #e5e7eb;border-radius:.55rem;padding:.7rem .85rem;margin-top:1.1rem;font-size:.85rem;color:#4b5563}.scopes div{margin-top:.25rem}.muted{font-size:.82rem;color:#6b7280;margin-top:1.1rem}.error{color:#b91c1c;font-size:.88rem;margin:0 0 .5rem}button:disabled{background:#6b7280;cursor:default}`;

// Verifying a code takes seconds. Disable the button on submit so a second click or
// Enter can't send a duplicate POST; re-enable if the page is restored from the
// back/forward cache. The form still works without JS.
const OTP_SUBMIT_ONCE_SCRIPT = `(function(){var f=document.getElementById("verify-form");var b=f.querySelector("button[type=submit]");var t=b.textContent;f.addEventListener("submit",function(e){if(b.disabled){e.preventDefault();return}b.disabled=true;b.textContent="Verifying..."});window.addEventListener("pageshow",function(e){if(e.persisted){b.disabled=false;b.textContent=t}})})();`;

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

function renderOtpPage(loginId: string, email: string, clientName?: string, error?: string) {
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
					<form id="verify-form" method="post" action="/oauth/verify">
						<input type="hidden" name="loginId" value="${loginId}" />
						<label for="code">6-digit code</label>
						${error ? html`<p class="error" role="alert">${error}</p>` : ""}
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
				<script>
					${raw(OTP_SUBMIT_ONCE_SCRIPT)}
				</script>
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
