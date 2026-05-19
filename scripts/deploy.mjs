import { spawnSync } from "node:child_process";

const allowDeploy = process.env.ALLOW_WORKER_DEPLOY === "1";
const args = allowDeploy ? ["wrangler", "deploy"] : ["wrangler", "deploy", "--dry-run"];

if (!allowDeploy) {
	console.log("Deployment guard active: running wrangler deploy --dry-run. Set ALLOW_WORKER_DEPLOY=1 to deploy intentionally.");
}

const result = spawnSync("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
