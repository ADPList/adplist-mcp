import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import app from "../src/app.ts";

// Minimal in-memory KV that ignores the options bag (expirationTtl etc.).
function createKV(seed = {}) {
	const store = new Map(Object.entries(seed));
	return {
		store,
		async get(key) {
			return store.has(key) ? store.get(key) : null;
		},
		async put(key, value) {
			store.set(key, value);
		},
		async delete(key) {
			store.delete(key);
		},
	};
}

function form(fields) {
	return new URLSearchParams(fields).toString();
}

function post(path, fields, env) {
	return app.request(
		path,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: form(fields),
		},
		env,
	);
}

// OTP_VERIFY_DUPLICATE_WAIT_MS: don't sit out the 8 s duplicate-submit poll in tests.
const AUTH_ENV = { AUTH_SERVICE_URL: "https://auth.example", OTP_VERIFY_DUPLICATE_WAIT_MS: "0" };

test("OTP send never reveals whether the account exists (enumeration defense)", async () => {
	const kv = createKV({
		"oauth_login:login-1": JSON.stringify({
			oauthReqInfo: { clientId: "c", scope: [] },
			createdAt: Date.now(),
		}),
	});
	const originalFetch = globalThis.fetch;
	// Simulate a non-existent account: auth-service /auth/login returns non-2xx.
	globalThis.fetch = async () => new Response("nope", { status: 404 });
	try {
		const res = await post(
			"/oauth/login",
			{ loginId: "login-1", email: "ghost@example.com" },
			{ ...AUTH_ENV, OAUTH_KV: kv },
		);
		const body = await res.text();
		assert.equal(res.status, 200);
		// Same code-entry page as a real account; no "couldn't email" tell.
		assert.match(body, /sign-in code/i);
		assert.doesNotMatch(body, /couldn't email/i);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("an IP-throttled OTP send does not drain the victim's per-email budget", async () => {
	const kv = createKV({
		"oauth_login:login-ip": JSON.stringify({
			oauthReqInfo: { clientId: "c", scope: [] },
			createdAt: Date.now(),
		}),
	});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => Response.json({ session: "s", userId: "cog" });
	const env = { ...AUTH_ENV, OAUTH_KV: kv };
	const send = (email) =>
		app.request(
			"/oauth/login",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"cf-connecting-ip": "1.2.3.4",
				},
				body: form({ loginId: "login-ip", email }),
			},
			env,
		);
	try {
		// Exhaust the per-IP budget with attacker-controlled addresses.
		for (let i = 0; i < 5; i += 1) {
			const res = await send(`attacker${i}@example.com`);
			assert.equal(res.status, 200, `warm-up send ${i + 1} should succeed`);
		}
		// A further send from the same IP targeting the victim is IP-blocked...
		const blocked = await send("victim@example.com");
		assert.equal(blocked.status, 429);
		// ...and must NOT have touched the victim's per-email counter.
		assert.equal(kv.store.has("otp_email_rate:victim@example.com"), false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("OTP verify caps failed attempts then burns the login session", async () => {
	const kv = createKV({
		"oauth_login:login-2": JSON.stringify({
			oauthReqInfo: { clientId: "c", scope: [] },
			createdAt: Date.now(),
			email: "user@example.com",
			cognitoSession: "sess",
			cognitoUserId: "cog-1",
		}),
	});
	const originalFetch = globalThis.fetch;
	// Every verify attempt fails upstream (wrong code).
	globalThis.fetch = async () => new Response("bad code", { status: 400 });
	try {
		for (let i = 0; i < 5; i += 1) {
			const res = await post(
				"/oauth/verify",
				{ loginId: "login-2", code: "000000" },
				{ ...AUTH_ENV, OAUTH_KV: kv },
			);
			assert.equal(res.status, 400, `attempt ${i + 1} should be a plain rejection`);
		}
		// Session is burned after MAX attempts; the record is gone.
		assert.equal(kv.store.has("oauth_login:login-2"), false);

		// A further attempt is rejected as exhausted, not retried upstream.
		const blocked = await post(
			"/oauth/verify",
			{ loginId: "login-2", code: "000000" },
			{ ...AUTH_ENV, OAUTH_KV: kv },
		);
		assert.equal(blocked.status, 400);
		assert.match(await blocked.text(), /session expired/i);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

const CLIENT_REDIRECT = "https://client.example/callback?code=auth-code&state=xyz";

function signInEnv(kv, overrides = {}) {
	const completed = [];
	return {
		completed,
		env: {
			...AUTH_ENV,
			OAUTH_KV: kv,
			OAUTH_PROVIDER: {
				async completeAuthorization(options) {
					completed.push(options);
					return { redirectTo: CLIENT_REDIRECT };
				},
			},
			...overrides,
		},
	};
}

function seededLogin(loginId) {
	return createKV({
		[`oauth_login:${loginId}`]: JSON.stringify({
			oauthReqInfo: { clientId: "c", scope: [] },
			createdAt: Date.now(),
			email: "user@example.com",
			cognitoSession: "S1",
			cognitoUserId: "cog-1",
		}),
	});
}

// Records each /auth/verify-challenge call and answers via `respond(body, callIndex)`.
function mockVerifyChallenge(respond) {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		assert.match(String(url), /\/auth\/verify-challenge$/);
		const body = JSON.parse(init.body);
		calls.push(body);
		return respond(body, calls.length - 1);
	};
	return calls;
}

const VERIFIED = { accessToken: "access-token", refreshToken: "refresh-token", id: "user-1" };

// POST /oauth/verify with an ExecutionContext, settling waitUntil work before returning.
async function verifyPost(fields, env) {
	const pending = [];
	const ctx = { waitUntil: (promise) => pending.push(promise), passThroughOnException() {} };
	const res = await app.request(
		"/oauth/verify",
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: form(fields),
		},
		env,
		ctx,
	);
	await Promise.allSettled(pending);
	return res;
}

test("OTP verify: a wrong code keeps the replacement session so the right code then works", async () => {
	const kv = seededLogin("login-wrong");
	const { env } = signInEnv(kv);
	const originalFetch = globalThis.fetch;
	const calls = mockVerifyChallenge((body, index) => {
		if (index === 0) {
			return Response.json(
				{ requestId: "r", challengeName: "CUSTOM_CHALLENGE", session: "S2", userId: "cog-1" },
				{ status: 401 },
			);
		}
		if (body.session === "S2") return Response.json(VERIFIED);
		return Response.json({ code: "CODE_EXPIRED" }, { status: 401 });
	});
	try {
		const wrong = await verifyPost({ loginId: "login-wrong", code: "111111" }, env);
		assert.equal(wrong.status, 400);
		const wrongBody = await wrong.text();
		assert.match(wrongBody, /That code is incorrect\. Check the latest email and try again\./);
		// The code-entry form is shown again, not a dead-end error page.
		assert.match(wrongBody, /action="\/oauth\/verify"/);
		assert.equal(kv.store.get("oauth_verify_attempts:login-wrong"), "1");

		const right = await verifyPost({ loginId: "login-wrong", code: "123456" }, env);
		assert.equal(right.status, 302);
		assert.equal(right.headers.get("location"), CLIENT_REDIRECT);
		assert.equal(calls.length, 2);
		assert.equal(calls[0].session, "S1");
		assert.equal(calls[1].session, "S2");
		assert.equal(kv.store.has("oauth_login:login-wrong"), false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("OTP verify: a duplicate submit after success redirects to the same place without re-verifying", async () => {
	const kv = seededLogin("login-dup");
	const { env, completed } = signInEnv(kv);
	const originalFetch = globalThis.fetch;
	const calls = mockVerifyChallenge(() => Response.json(VERIFIED));
	try {
		const first = await verifyPost({ loginId: "login-dup", code: "123456" }, env);
		assert.equal(first.status, 302);
		assert.equal(first.headers.get("location"), CLIENT_REDIRECT);

		const second = await verifyPost({ loginId: "login-dup", code: "123456" }, env);
		assert.equal(second.status, 302);
		assert.equal(second.headers.get("location"), CLIENT_REDIRECT);
		assert.equal(calls.length, 1);
		assert.equal(completed.length, 1);
		assert.equal(kv.store.has("oauth_login:login-dup"), false);
		assert.equal(kv.store.has("oauth_verify_inflight:login-dup"), false);

		// The completion record only replays for the code that earned it.
		const otherCode = await verifyPost({ loginId: "login-dup", code: "654321" }, env);
		assert.equal(otherCode.status, 400);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("OTP verify: one wrong code against a completed login ends replay for good", async () => {
	const kv = seededLogin("login-guess");
	const { env } = signInEnv(kv);
	const originalFetch = globalThis.fetch;
	const calls = mockVerifyChallenge(() => Response.json(VERIFIED));
	try {
		const first = await verifyPost({ loginId: "login-guess", code: "123456" }, env);
		assert.equal(first.status, 302);
		assert.equal(kv.store.has("oauth_verify_done:login-guess"), true);

		const guess = await verifyPost({ loginId: "login-guess", code: "000000" }, env);
		assert.equal(guess.status, 400);
		assert.equal(kv.store.has("oauth_verify_done:login-guess"), false);

		// Even the correct code no longer replays the redirect.
		const correct = await verifyPost({ loginId: "login-guess", code: "123456" }, env);
		assert.equal(correct.status, 400);
		assert.equal(correct.headers.get("location"), null);
		assert.equal(calls.length, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("OTP verify: a wrong-code response does not recreate a login burned meanwhile", async () => {
	const kv = seededLogin("login-burned");
	const { env } = signInEnv(kv);
	const originalFetch = globalThis.fetch;
	mockVerifyChallenge(() => {
		// A concurrent request burns the login while this one waits on upstream.
		kv.store.delete("oauth_login:login-burned");
		return Response.json(
			{ requestId: "r", challengeName: "CUSTOM_CHALLENGE", session: "S2", userId: "cog-1" },
			{ status: 401 },
		);
	});
	try {
		const res = await verifyPost({ loginId: "login-burned", code: "111111" }, env);
		assert.equal(res.status, 400);
		assert.equal(kv.store.has("oauth_login:login-burned"), false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("OTP verify: a duplicate submit while the first is in flight waits for its redirect", async () => {
	const kv = seededLogin("login-inflight");
	kv.store.set("oauth_verify_inflight:login-inflight", "1");
	const { env } = signInEnv(kv, { OTP_VERIFY_DUPLICATE_WAIT_MS: "2000" });
	const originalFetch = globalThis.fetch;
	// The first request already consumed the Cognito session.
	const calls = mockVerifyChallenge(() =>
		Response.json({ code: "CODE_EXPIRED" }, { status: 401 }),
	);
	const codeDigest = createHash("sha256").update("login-inflight:123456").digest("hex");
	const timer = setTimeout(() => {
		kv.store.set(
			"oauth_verify_done:login-inflight",
			JSON.stringify({ redirectTo: CLIENT_REDIRECT, codeDigest }),
		);
	}, 100);
	try {
		const res = await verifyPost({ loginId: "login-inflight", code: "123456" }, env);
		assert.equal(res.status, 302);
		assert.equal(res.headers.get("location"), CLIENT_REDIRECT);
		assert.equal(calls.length, 0);
	} finally {
		clearTimeout(timer);
		globalThis.fetch = originalFetch;
	}
});

test("OTP verify: an expired code with no completed duplicate says so", async () => {
	const kv = seededLogin("login-expired");
	const { env } = signInEnv(kv, { OTP_VERIFY_DUPLICATE_WAIT_MS: "50" });
	const originalFetch = globalThis.fetch;
	mockVerifyChallenge(() => Response.json({ code: "CODE_EXPIRED" }, { status: 401 }));
	try {
		const res = await verifyPost({ loginId: "login-expired", code: "123456" }, env);
		assert.equal(res.status, 400);
		assert.match(
			await res.text(),
			/This code has expired\. Close this window and click Connect again to get a new code\./,
		);
		assert.equal(kv.store.has("oauth_verify_inflight:login-expired"), false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("OTP page disables the submit button while verifying", async () => {
	const kv = createKV({
		"oauth_login:login-page": JSON.stringify({
			oauthReqInfo: { clientId: "c", scope: [] },
			createdAt: Date.now(),
		}),
	});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => Response.json({ session: "s", userId: "cog" });
	try {
		const res = await post(
			"/oauth/login",
			{ loginId: "login-page", email: "user@example.com" },
			{ ...AUTH_ENV, OAUTH_KV: kv },
		);
		const body = await res.text();
		assert.equal(res.status, 200);
		assert.match(body, /<form id="verify-form" method="post" action="\/oauth\/verify">/);
		assert.match(body, /addEventListener\("submit"/);
		assert.match(body, /b\.disabled=true/);
		assert.match(body, /Verifying\.\.\./);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
