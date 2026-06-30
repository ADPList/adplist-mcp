import assert from "node:assert/strict";
import test from "node:test";
import { sendWelcomeEmailOnce } from "../src/welcomeEmail.ts";

test("sendWelcomeEmailOnce sends the SendGrid welcome email and marks the user welcomed", async () => {
	const env = createEnv();
	const calls = await withFetch(async () => {
		await sendWelcomeEmailOnce(env, {
			userId: "user-1",
			email: "ada@example.com",
			firstName: "Ada",
			origin: "https://mcp.adplist.org",
			nowSeconds: 1_000,
		});
	});

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://api.sendgrid.com/v3/mail/send");
	assert.equal(calls[0].headers.Authorization, "Bearer sendgrid-key");
	const body = JSON.parse(calls[0].body);
	assert.deepEqual(body.personalizations, [{ to: [{ email: "ada@example.com" }] }]);
	assert.deepEqual(body.from, { email: "felix@adplist.org", name: "Felix Lee" });
	assert.deepEqual(body.reply_to, { email: "felix@adplist.org", name: "Felix Lee" });
	assert.equal(body.subject, "You're in. ADPList is connected to Claude.");
	assert.match(body.content[0].value, /Hey Ada,/);
	assert.match(body.content[0].value, /40K\+ mentors/);
	assert.match(body.content[1].value, /It'll find the right expert from 40K\+ mentors/);
	assert.match(body.content[1].value, /https:\/\/mcp\.adplist\.org\/assets\/claude-mcp\.gif/);
	assert.equal(env.rows.get("user-1").welcome_email_sent_at > 0, true);
	assert.equal(env.rows.get("user-1").welcome_email_in_flight_at, null);
});

test("sendWelcomeEmailOnce skips users who were already welcomed", async () => {
	const env = createEnv();
	env.rows.set("user-1", {
		user_id: "user-1",
		profile_json: "{}",
		updated_at: 900,
		welcome_email_sent_at: 950,
		welcome_email_in_flight_at: null,
	});

	const calls = await withFetch(async () => {
		await sendWelcomeEmailOnce(env, {
			userId: "user-1",
			email: "ada@example.com",
			nowSeconds: 1_000,
		});
	});

	assert.equal(calls.length, 0);
	assert.equal(env.rows.get("user-1").welcome_email_sent_at, 950);
});

test("sendWelcomeEmailOnce prefers first name from the ADPList profile", async () => {
	const env = { ...createEnv(), AUTH_SERVICE_URL: "https://api.adplist.org" };
	const calls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), headers: init.headers, body: init.body });
		if (String(url) === "https://api.adplist.org/users/profile/me") {
			return Response.json({ data: { fullName: "Grace Hopper" } });
		}
		return { ok: true, status: 202 };
	};
	try {
		await sendWelcomeEmailOnce(env, {
			userId: "user-1",
			email: "grace@example.com",
			firstName: "",
			accessToken: "access-token",
			nowSeconds: 1_000,
		});
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.equal(calls.length, 2);
	assert.equal(calls[0].url, "https://api.adplist.org/users/profile/me");
	assert.equal(calls[0].headers.Authorization, "Bearer access-token");
	const sendGridBody = JSON.parse(calls[1].body);
	assert.match(sendGridBody.content[0].value, /Hey Grace,/);
	assert.match(sendGridBody.content[1].value, /Hey Grace,/);
});

test("sendWelcomeEmailOnce does not mark welcomed when SendGrid fails", async () => {
	const env = createEnv();

	const calls = await withFetch(
		async () => {
			await sendWelcomeEmailOnce(env, {
				userId: "user-1",
				email: "ada@example.com",
				nowSeconds: 1_000,
			});
		},
		{ ok: false, status: 500 },
	);

	assert.equal(calls.length, 1);
	assert.equal(env.rows.get("user-1").welcome_email_sent_at, null);
	assert.equal(env.rows.get("user-1").welcome_email_in_flight_at, null);
});

test("sendWelcomeEmailOnce uses the D1 lease to avoid duplicate concurrent sends", async () => {
	const env = createEnv();
	env.rows.set("user-1", {
		user_id: "user-1",
		profile_json: "{}",
		updated_at: 900,
		welcome_email_sent_at: null,
		welcome_email_in_flight_at: 995,
	});

	const calls = await withFetch(async () => {
		await sendWelcomeEmailOnce(env, {
			userId: "user-1",
			email: "ada@example.com",
			nowSeconds: 1_000,
		});
	});

	assert.equal(calls.length, 0);
	assert.equal(env.rows.get("user-1").welcome_email_sent_at, null);
	assert.equal(env.rows.get("user-1").welcome_email_in_flight_at, 995);
});

test("sendWelcomeEmailOnce skips when email or SendGrid config is missing", async () => {
	const env = createEnv();
	const calls = await withFetch(async () => {
		await sendWelcomeEmailOnce(env, { userId: "user-1", email: "", nowSeconds: 1_000 });
		await sendWelcomeEmailOnce(
			{ ...env, SENDGRID_API_KEY: undefined },
			{ userId: "user-1", email: "ada@example.com", nowSeconds: 1_000 },
		);
	});

	assert.equal(calls.length, 0);
	assert.equal(env.rows.has("user-1"), false);
});

function createEnv() {
	const rows = new Map();
	return {
		SENDGRID_API_KEY: "sendgrid-key",
		rows,
		PROFILE_DB: {
			prepare(sql) {
				return new Statement(rows, sql);
			},
		},
	};
}

class Statement {
	constructor(rows, sql) {
		this.rows = rows;
		this.sql = sql;
		this.values = [];
	}

	bind(...values) {
		this.values = values;
		return this;
	}

	async first() {
		if (/SELECT welcome_email_sent_at/.test(this.sql)) {
			const [userId] = this.values;
			const row = this.rows.get(userId);
			return row ? { welcome_email_sent_at: row.welcome_email_sent_at } : null;
		}
		throw new Error(`Unhandled first SQL: ${this.sql}`);
	}

	async run() {
		if (/INSERT OR IGNORE INTO user_mcp_profile/.test(this.sql)) {
			throw new Error("welcome email state should not write user_mcp_profile");
		}
		if (/INSERT OR IGNORE INTO user_mcp_welcome/.test(this.sql)) {
			const [userId] = this.values;
			if (!this.rows.has(userId)) {
				this.rows.set(userId, {
					user_id: userId,
					welcome_email_sent_at: null,
					welcome_email_in_flight_at: null,
				});
				return { meta: { changes: 1 } };
			}
			return { meta: { changes: 0 } };
		}
		if (/SET welcome_email_in_flight_at = \?/.test(this.sql)) {
			const [nowSeconds, userId, staleBefore] = this.values;
			const row = this.rows.get(userId);
			if (
				row &&
				row.welcome_email_sent_at === null &&
				(row.welcome_email_in_flight_at === null ||
					row.welcome_email_in_flight_at < staleBefore)
			) {
				row.welcome_email_in_flight_at = nowSeconds;
				return { meta: { changes: 1 } };
			}
			return { meta: { changes: 0 } };
		}
		if (/SET welcome_email_sent_at = \?/.test(this.sql)) {
			const [sentAt, userId] = this.values;
			const row = this.rows.get(userId);
			if (row) {
				row.welcome_email_sent_at = sentAt;
				row.welcome_email_in_flight_at = null;
				return { meta: { changes: 1 } };
			}
			return { meta: { changes: 0 } };
		}
		if (/SET welcome_email_in_flight_at = NULL/.test(this.sql)) {
			const [userId] = this.values;
			const row = this.rows.get(userId);
			if (row && row.welcome_email_sent_at === null) {
				row.welcome_email_in_flight_at = null;
				return { meta: { changes: 1 } };
			}
			return { meta: { changes: 0 } };
		}
		throw new Error(`Unhandled run SQL: ${this.sql}`);
	}
}

async function withFetch(fn, response = { ok: true, status: 200 }) {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), headers: init.headers, body: init.body });
		return response;
	};
	try {
		await fn();
		return calls;
	} finally {
		globalThis.fetch = originalFetch;
	}
}
