import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const configSource = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
const cognitoSource = readFileSync(new URL("../src/cognito.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

const appSource = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");

test("MCP exposes OAuth and SSE routes", () => {
	assert.match(indexSource, /authorizeEndpoint:\s*"\/oauth\/authorize"/);
	assert.match(indexSource, /tokenEndpoint:\s*"\/oauth\/token"/);
	assert.match(indexSource, /clientRegistrationEndpoint:\s*"\/oauth\/register"/);
	assert.match(indexSource, /apiRoute:\s*"\/sse"/);
});

test("Cognito callback defaults to the Worker origin", () => {
	assert.match(configSource, /new URL\(requestUrl\)\.origin/);
	assert.match(configSource, /\/oauth\/callback/);
});

test("Cognito auth uses authorization-code flow with PKCE fallback for public clients", () => {
	assert.match(cognitoSource, /response_type", "code"/);
	assert.match(cognitoSource, /grant_type:\s*"authorization_code"/);
	assert.match(cognitoSource, /code_challenge_method", "S256"/);
	assert.match(cognitoSource, /code_verifier/);
	assert.match(cognitoSource, /\/oauth2\/authorize/);
	assert.match(cognitoSource, /\/oauth2\/token/);
	assert.match(cognitoSource, /\/oauth2\/userInfo/);
});

test("Cognito callback requires explicit user consent before completing MCP authorization", () => {
	assert.match(appSource, /oauth_consent:/);
	assert.match(appSource, /app\.post\("\/oauth\/consent"/);
	assert.match(appSource, /completeAuthorization/);
});
