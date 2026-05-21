import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
const authSource = readFileSync(new URL("../src/adplistAuth.ts", import.meta.url), "utf8");

test("MCP exposes OAuth and SSE routes", () => {
	assert.match(indexSource, /authorizeEndpoint:\s*"\/oauth\/authorize"/);
	assert.match(indexSource, /tokenEndpoint:\s*"\/oauth\/token"/);
	assert.match(indexSource, /clientRegistrationEndpoint:\s*"\/oauth\/register"/);
	assert.match(indexSource, /apiRoute:\s*"\/sse"/);
});

test("auth uses the ADPList email-OTP endpoints, not the Cognito hosted UI", () => {
	assert.match(authSource, /\/auth\/login/);
	assert.match(authSource, /\/auth\/verify-challenge/);
	assert.doesNotMatch(appSource, /oauth2\/authorize/);
});

test("OAuth flow renders email and OTP steps then completes authorization", () => {
	assert.match(appSource, /app\.get\("\/oauth\/authorize"/);
	assert.match(appSource, /app\.post\("\/oauth\/login"/);
	assert.match(appSource, /app\.post\("\/oauth\/verify"/);
	assert.match(appSource, /completeAuthorization/);
});

test("OTP page names the requesting client and scopes before token issuance", () => {
	assert.match(appSource, /renderOtpPage/);
	assert.match(appSource, /authorizes/i);
	assert.match(appSource, /MCP_SCOPES\.map/);
});
