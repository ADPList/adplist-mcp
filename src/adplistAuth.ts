import { requiredEnv } from "./config.ts";

export type SendOtpResult = {
	session: string;
	cognitoUserId: string;
	challengeName?: string;
};

// auth-service answers /auth/verify-challenge with distinct shapes, and the
// sign-in page needs to tell them apart:
// - 401 with a `session`: wrong code. Cognito rotates the challenge session but the
//   emailed code stays valid on the replacement, so the user can simply retry.
// - `code: "CODE_EXPIRED"`: the session is dead (15-minute expiry, or already consumed
//   by an earlier successful verify).
// - anything else (network, 5xx, 403 blocked, 401 without session after 3 wrong codes).
export type VerifyOtpResult =
	| { kind: "verified"; accessToken: string; refreshToken?: string; userId: string }
	| { kind: "wrong_code"; session: string }
	| { kind: "expired" }
	| { kind: "failed" };

function authBaseUrl(env: Env): string {
	return requiredEnv(env, "AUTH_SERVICE_URL").replace(/\/$/, "");
}

async function postJson(url: string, body: unknown): Promise<unknown> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(`ADPList auth request failed: ${url} -> HTTP ${response.status}`);
	}
	return response.json();
}

// Step 1 of ADPList's email-OTP login: ask auth-service to email a code.
export async function sendOtp(env: Env, email: string): Promise<SendOtpResult> {
	const data = (await postJson(`${authBaseUrl(env)}/auth/login`, { username: email })) as {
		session?: unknown;
		userId?: unknown;
		challengeName?: unknown;
	};
	if (typeof data.session !== "string" || typeof data.userId !== "string") {
		throw new Error("ADPList /auth/login did not return a challenge session");
	}
	return {
		session: data.session,
		cognitoUserId: data.userId,
		challengeName: typeof data.challengeName === "string" ? data.challengeName : undefined,
	};
}

// Step 2: verify the code. On success returns the ADPList token (oid) used as the
// API bearer. Never throws; never logs the code, session or tokens.
export async function verifyOtp(
	env: Env,
	params: { code: string; cognitoUserId: string; session: string },
): Promise<VerifyOtpResult> {
	let response: Response;
	let data: {
		accessToken?: unknown;
		refreshToken?: unknown;
		id?: unknown;
		session?: unknown;
		code?: unknown;
	};
	try {
		response = await fetch(`${authBaseUrl(env)}/auth/verify-challenge`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({
				challengeAnswer: params.code,
				userId: params.cognitoUserId,
				session: params.session,
			}),
		});
		const parsed: unknown = await response.json().catch(() => null);
		data = (parsed && typeof parsed === "object" ? parsed : {}) as typeof data;
	} catch {
		return { kind: "failed" };
	}

	if (!response.ok) {
		if (data.code === "CODE_EXPIRED") return { kind: "expired" };
		if (response.status === 401 && typeof data.session === "string" && data.session.length > 0) {
			return { kind: "wrong_code", session: data.session };
		}
		return { kind: "failed" };
	}
	if (typeof data.accessToken !== "string" || data.accessToken.length === 0) {
		return { kind: "failed" };
	}
	return {
		kind: "verified",
		accessToken: data.accessToken,
		refreshToken: typeof data.refreshToken === "string" ? data.refreshToken : undefined,
		userId: typeof data.id === "string" && data.id.length > 0 ? data.id : params.cognitoUserId,
	};
}
