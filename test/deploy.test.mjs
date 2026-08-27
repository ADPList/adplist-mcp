import assert from "node:assert/strict";
import test from "node:test";

import { resolveDeployMode } from "../scripts/deploy.mjs";

test("a local run without the flag dry-runs instead of deploying", () => {
	assert.equal(resolveDeployMode({}), "dry-run");
});

test("CI without the flag is blocked, never a silent success", () => {
	// The whole point: a Cloudflare build that deploys nothing must not exit 0.
	// Production served eight-week-old code because this returned success.
	for (const key of ["WORKERS_CI", "CI", "CIRCLECI", "GITHUB_ACTIONS"]) {
		assert.equal(resolveDeployMode({ [key]: "1" }), "blocked", `${key} must block`);
	}
});

test("an explicit ALLOW_WORKER_DEPLOY deploys, in CI or locally", () => {
	assert.equal(resolveDeployMode({ ALLOW_WORKER_DEPLOY: "1" }), "deploy");
	assert.equal(resolveDeployMode({ ALLOW_WORKER_DEPLOY: "1", CI: "true" }), "deploy");
});

test("only the exact opt-in value deploys", () => {
	for (const value of ["", "0", "true", "yes"]) {
		assert.notEqual(resolveDeployMode({ ALLOW_WORKER_DEPLOY: value }), "deploy");
	}
});
