import assert from "node:assert/strict";
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

const AUTH_ENV = { AUTH_SERVICE_URL: "https://auth.example" };

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
