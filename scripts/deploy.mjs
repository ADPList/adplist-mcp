import { spawnSync } from "node:child_process";

const isCi = process.env.CI === "true" || process.env.CI === "1" || Boolean(process.env.CF_BUILD_ID);
const allowDeploy = process.env.ALLOW_WORKER_DEPLOY === "1";
const args = isCi && !allowDeploy ? ["wrangler", "deploy", "--dry-run"] : ["wrangler", "deploy"];

if (isCi && !allowDeploy) {
	console.log("CI deployment guard active: running wrangler deploy --dry-run. Set ALLOW_WORKER_DEPLOY=1 to deploy.");
}

const result = spawnSync("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
