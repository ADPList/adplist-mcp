import { requiredEnv } from "./config.ts";

export type SendOtpResult = {
	session: string;
	cognitoUserId: string;
	challengeName?: string;
};

export type VerifyOtpResult = {
	accessToken: string;
	refreshToken?: string;
	userId: string;
};

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

// Step 2: verify the code. Returns the ADPList token (oid) used as the API bearer.
export async function verifyOtp(
	env: Env,
	params: { code: string; cognitoUserId: string; session: string },
): Promise<VerifyOtpResult> {
	const data = (await postJson(`${authBaseUrl(env)}/auth/verify-challenge`, {
		challengeAnswer: params.code,
		userId: params.cognitoUserId,
		session: params.session,
	})) as { accessToken?: unknown; refreshToken?: unknown; id?: unknown };
	if (typeof data.accessToken !== "string" || data.accessToken.length === 0) {
		throw new Error("ADPList /auth/verify-challenge did not return an access token");
	}
	return {
		accessToken: data.accessToken,
		refreshToken: typeof data.refreshToken === "string" ? data.refreshToken : undefined,
		userId: typeof data.id === "string" && data.id.length > 0 ? data.id : params.cognitoUserId,
	};
}
