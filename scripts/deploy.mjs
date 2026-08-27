import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Deploys are manual for this Worker. A Cloudflare build that runs this script
 * must not report success, because it does not deploy — see CLAUDE.md for the
 * eight weeks of stale production that convention cost us.
 *
 * Modelled on adplist-client/scripts/productionDeployGuard.mjs, which gets this
 * right: a blocked deploy exits non-zero.
 */

const CI_SIGNALS = ["WORKERS_CI", "CI", "CIRCLECI", "GITHUB_ACTIONS"];

export const resolveDeployMode = (env) => {
	if (env.ALLOW_WORKER_DEPLOY === "1") return "deploy";
	if (CI_SIGNALS.some((key) => env[key])) return "blocked";
	return "dry-run";
};

const run = (command, cwd = process.cwd()) =>
	execSync(command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const fail = (message) => {
	console.error(["", "Worker deploy blocked.", message, ""].join("\n"));
	process.exit(1);
};

export const verifyDeploySource = () => {
	let root;
	try {
		root = run("git rev-parse --show-toplevel");
	} catch {
		fail("Unable to find a git repository.");
	}

	const status = run("git status --porcelain", root);
	if (status) {
		fail(
			[
				"Working tree is not clean, so the deploy cannot prove what it ships.",
				"",
				status,
			].join("\n"),
		);
	}

	try {
		run("git fetch --quiet origin main", root);
	} catch {
		fail("Failed to fetch origin/main, so the deploy cannot prove it is current.");
	}

	const head = run("git rev-parse HEAD", root);
	const originMain = run("git rev-parse origin/main", root);

	if (head !== originMain) {
		fail(
			[
				"HEAD does not match origin/main. Merge first, then pull, then deploy.",
				"",
				`HEAD:        ${run("git log -1 --oneline HEAD", root)}`,
				`origin/main: ${run("git log -1 --oneline origin/main", root)}`,
			].join("\n"),
		);
	}

	console.log(`[deploy-guard] production deploy source verified at ${head}.`);
};

const main = () => {
	const mode = resolveDeployMode(process.env);

	if (mode === "blocked") {
		fail(
			[
				"Deploys of this Worker are manual and this CI run did not deploy anything.",
				"Failing loudly so a green check cannot be mistaken for a release.",
				"",
				"To ship, from a clean checkout of origin/main:",
				"  ALLOW_WORKER_DEPLOY=1 npm run deploy:live",
			].join("\n"),
		);
	}

	if (mode === "dry-run") {
		console.log(
			"Deployment guard active: running wrangler deploy --dry-run. This does NOT deploy. Set ALLOW_WORKER_DEPLOY=1 to deploy intentionally.",
		);
		const dry = spawnSync("npx", ["wrangler", "deploy", "--dry-run"], {
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		process.exit(dry.status ?? 1);
	}

	verifyDeploySource();
	const result = spawnSync("npx", ["wrangler", "deploy"], {
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	process.exit(result.status ?? 1);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
