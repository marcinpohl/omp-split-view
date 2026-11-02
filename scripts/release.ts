/**
 * release.ts — bump, ship, tag, optionally push.
 *
 * The publish workflow triggers on `v*` tags, so this script owns everything
 * up to (and with --push, including) that push. The npm token itself lives in
 * the repository secret and cannot be checked from here.
 *
 * Usage:
 *   bun run release patch                 # 0.1.0 → 0.1.1, local commit + tag
 *   bun run release minor --push          # also push branch and tag
 *   bun run release 0.2.0 --dry-run       # print the plan, change nothing
 *   bun run release patch --skip-registry-check   # offline / private registry
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fail, printFailure, run, step } from "./ship.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const PACKAGE = path.join(ROOT, "package.json");

const HELP = `release — bump, ship, tag, optionally push

Usage:
  bun run release current               # tag the version in package.json
  bun run release patch                 # bump patch, run ship, tag locally
  bun run release minor --push          # also push the branch and tag
  bun run release 0.2.0 --dry-run       # print the plan, change nothing
  bun run release patch --skip-registry-check

Steps: bump package.json → ship (gates, docs, commit, pack, verify) →
tag v<version> → optionally push origin <branch> and the tag.

Publishing needs the repository's NPM_TOKEN secret; this script cannot check it.
`;

interface ReleaseOptions {
	bump: string;
	push: boolean;
	dryRun: boolean;
	skipRegistry: boolean;
}

type Semver = [number, number, number];

function parseArgs(argv: readonly string[]): ReleaseOptions {
	let bump: string | undefined;
	const options: ReleaseOptions = { bump: "", push: false, dryRun: false, skipRegistry: false };
	for (const arg of argv) {
		if (arg === "--push") options.push = true;
		else if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--skip-registry-check") options.skipRegistry = true;
		else if (arg === "-h" || arg === "--help") {
			process.stdout.write(HELP);
			process.exit(0);
		} else if (arg.startsWith("-")) fail(`unknown argument: ${arg}`);
		else if (bump) fail(`unexpected second argument: ${arg}`);
		else bump = arg;
	}
	if (!bump) fail("missing version argument (current|patch|minor|major|x.y.z); see --help");
	options.bump = bump;
	return options;
}

function parseSemver(value: string): Semver {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
	if (!match) fail(`"${value}" is not a version or one of patch/minor/major`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: Semver, right: Semver): number {
	for (let i = 0; i < 3; i++) {
		if (left[i] !== right[i]) return left[i] - right[i];
	}
	return 0;
}

function nextVersion(current: string, bump: string): string {
	const [major, minor, patch] = parseSemver(current);
	if (bump === "current") return current;
	if (bump === "major") return `${major + 1}.0.0`;
	if (bump === "minor") return `${major}.${minor + 1}.0`;
	if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
	const explicit = parseSemver(bump);
	if (compareVersions(explicit, [major, minor, patch]) <= 0) {
		fail(`${bump} must be greater than the current ${current}`);
	}
	return `${explicit[0]}.${explicit[1]}.${explicit[2]}`;
}

function assertWorktree(needsRemote: boolean): string {
	if (run(["git", "rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true") {
		fail("not inside a git worktree");
	}
	const branch = run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (branch.code !== 0) fail("detached HEAD; check out a branch before releasing");
	if (needsRemote) {
		const remotes = run(["git", "remote"]).stdout.split("\n");
		if (!remotes.includes("origin")) fail("--push needs an origin remote");
	}
	return branch.stdout.trim();
}

async function assertVersionFree(name: string, version: string): Promise<void> {
	const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
	let response: Response;
	try {
		response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	} catch (error) {
		fail(`could not read the registry (${String(error)}); pass --skip-registry-check to skip`);
	}
	if (response.status === 404) return;
	if (!response.ok) fail(`registry returned ${response.status}; pass --skip-registry-check to skip`);
	const data = (await response.json()) as { versions?: Record<string, unknown> };
	if (data.versions?.[version]) fail(`${name}@${version} already exists in the registry`);
}

function assertTagFree(tag: string, checkRemote: boolean): void {
	if (run(["git", "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]).code === 0) {
		fail(`tag ${tag} already exists locally`);
	}
	if (!checkRemote) return;
	const remote = run(["git", "ls-remote", "--tags", "--exit-code", "origin", `refs/tags/${tag}`]);
	if (remote.code === 0) fail(`tag ${tag} already exists on origin`);
	if (remote.code !== 2) {
		printFailure(remote);
		fail("could not query origin for existing tags");
	}
}

function replaceVersion(text: string, version: string): string {
	const updated = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
	if (updated === text) fail("could not find the version field in package.json");
	return updated;
}

function ship(target: string): number {
	step("ship");
	const proc = Bun.spawnSync({
		cmd: ["bun", path.join(ROOT, "scripts", "ship.ts"), "-m", `Release ${target}`],
		cwd: ROOT,
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
	});
	return proc.exitCode ?? 1;
}

function createTag(tag: string, target: string): void {
	step(`tag ${tag}`);
	const tagged = run(["git", "tag", "-a", tag, "-m", `omp-split-view ${target}`]);
	if (tagged.code !== 0) {
		printFailure(tagged);
		fail(`could not create tag ${tag}`);
	}
	console.log(`  created ${tag}`);
}

function pushRelease(tag: string, branch: string): void {
	step("push");
	// A global push.followTags=true would publish every annotated tag reachable
	// from the branch; force it off for this push, then push exactly one tag.
	const pushedBranch = run(["git", "-c", "push.followTags=false", "push", "origin", branch]);
	if (pushedBranch.code !== 0) {
		printFailure(pushedBranch);
		fail(`could not push ${branch}; the commit and tag stay local`);
	}
	const pushedTag = run(["git", "-c", "push.followTags=false", "push", "origin", tag]);
	if (pushedTag.code !== 0) {
		printFailure(pushedTag);
		fail(`could not push ${tag}; the commit and tag stay local`);
	}
	console.log(`  pushed ${branch} and ${tag} — the Publish workflow is running`);
}

async function main(): Promise<void> {
	const options = parseArgs(Bun.argv.slice(2));
	step("preflight");
	const branch = assertWorktree(options.push);
	const manifestText = readFileSync(PACKAGE, "utf8");
	const manifest = JSON.parse(manifestText) as { name?: string; version?: string };
	if (!manifest.name || !manifest.version) fail("package.json lacks name or version");
	const target = nextVersion(manifest.version, options.bump);
	const tag = `v${target}`;
	const bumped = target !== manifest.version;
	console.log(`  ${manifest.name} ${manifest.version} → ${target} (${tag}) on ${branch}`);
	if (!options.skipRegistry) await assertVersionFree(manifest.name, target);
	assertTagFree(tag, options.push);

	if (options.dryRun) {
		console.log("\n  dry run: nothing bumped, committed, tagged or pushed");
		return;
	}

	step(bumped ? `bump ${manifest.version} → ${target}` : `keep ${target}`);
	if (bumped) writeFileSync(PACKAGE, replaceVersion(manifestText, target));
	const startHead = run(["git", "rev-parse", "HEAD"]).stdout.trim();
	if (ship(target) !== 0) {
		if (bumped && run(["git", "rev-parse", "HEAD"]).stdout.trim() === startHead) {
			writeFileSync(PACKAGE, replaceVersion(readFileSync(PACKAGE, "utf8"), manifest.version));
			console.log("  restored package.json (no commit was made)");
		}
		fail("ship failed; release is not tagged");
	}

	createTag(tag, target);
	if (options.push) pushRelease(tag, branch);
	else console.log(`  next: git push origin ${branch} ${tag}`);
	console.log(`\nrelease: ${target} is ${options.push ? "publishing" : "ready to push"}`);
}

if (import.meta.main) await main();
