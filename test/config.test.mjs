import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const configSource = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
const cognitoSource = readFileSync(new URL("../src/cognito.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("M1 exposes OAuth and SSE routes without demo tool code", () => {
	assert.match(indexSource, /authorizeEndpoint:\s*"\/oauth\/authorize"/);
	assert.match(indexSource, /tokenEndpoint:\s*"\/oauth\/token"/);
	assert.match(indexSource, /clientRegistrationEndpoint:\s*"\/oauth\/register"/);
	assert.match(indexSource, /apiRoute:\s*"\/sse"/);
	assert.doesNotMatch(indexSource, /server\.tool\(/);
});

test("Cognito callback defaults to the Worker origin", () => {
	assert.match(configSource, /new URL\(requestUrl\)\.origin/);
	assert.match(configSource, /\/oauth\/callback/);
});

test("Cognito auth uses authorization-code flow", () => {
	assert.match(cognitoSource, /response_type", "code"/);
	assert.match(cognitoSource, /grant_type:\s*"authorization_code"/);
	assert.match(cognitoSource, /\/oauth2\/authorize/);
	assert.match(cognitoSource, /\/oauth2\/token/);
	assert.match(cognitoSource, /\/oauth2\/userInfo/);
});
