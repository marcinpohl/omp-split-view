/**
 * ship.ts — one command for the local release loop.
 *
 *   test → refresh documented numbers → commit → repack → verify
 *
 * The semantic steps stay human: this script cannot write the prose in
 * README/CODE_QUALITY or review code comments. It owns everything that is
 * derived from a command's output, and it refuses to commit when the numbers
 * it just measured disagree with what the docs claim (unless it is rewriting
 * them, which is the point).
 *
 * Usage:
 *   bun run ship --check          gates + doc-drift check; writes nothing
 *   bun run ship --dry-run        show the doc refresh; commits nothing
 *   bun run ship -m "<subject>"   gates, refresh, commit, repack, verify
 *   bun run ship --no-commit      refresh and repack without committing
 *
 * Flags: --no-pack, --no-host, --allow-untracked, --skip-bun-check.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { isTestFile, parseLcov, pct, ratio, sumCoverage, type CoverageRecord, type CoverageTotals } from "./lib/coverage.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const EXPECTED_BUN = "1.4.3";
const CODE_QUALITY = path.join(ROOT, "CODE_QUALITY.md");
const README = path.join(ROOT, "README.md");
const SNAPSHOT_MODULES = [
	{ source: "split-view.ts", testFile: "test/split-view.test.ts" },
	{ source: "helpers.ts", testFile: "test/helpers.test.ts" },
	{ source: "ui-panels-config.ts", testFile: "test/properties.test.ts" },
] as const;

interface Options {
	check: boolean;
	dryRun: boolean;
	commit: boolean;
	pack: boolean;
	host: boolean;
	allowUntracked: boolean;
	skipBunCheck: boolean;
	message?: string;
}

interface TestMetrics {
	tests: number;
	failures: number;
	assertions: number;
	seconds: number;
	perFile: Map<string, number>;
}

interface Metrics {
	tests: TestMetrics;
	records: CoverageRecord[];
	totals: CoverageTotals;
}

interface DocUpdate {
	file: string;
	line: number;
	before: string;
	after: string;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

const HELP = `ship — one command for the local release loop

  test → refresh documented numbers → commit → repack → verify

Usage:
  bun run ship --check          gates + doc-drift check; writes nothing
  bun run ship --dry-run        show the doc refresh; commits nothing
  bun run ship -m "<subject>"   gates, refresh, commit, repack, verify
  bun run ship --no-commit      refresh and repack without committing

Flags:
  -m, --message <subject>  commit subject (prompted when omitted on a TTY)
  --no-pack                stop after the commit
  --no-host                skip loading the packed entry in omp
  --allow-untracked        let untracked files into the commit
  --skip-bun-check         bypass the Bun 1.4.3 pin
  -h, --help               show this help

The prose (README claims, code comments) stays human; the script owns the
measured values and refuses to commit when they disagree with the docs.
`;

export function fail(message: string): never {
	console.error(`\nship: ${message}`);
	process.exit(1);
}

export function run(cmd: string[]): RunResult {
	const proc = Bun.spawnSync({ cmd, cwd: ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	return {
		code: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

export function step(label: string): void {
	console.log(`\n▸ ${label}`);
}

export function printFailure(result: RunResult): void {
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
}

const TRUE_FLAGS = {
	"--check": "check",
	"--dry-run": "dryRun",
	"--allow-untracked": "allowUntracked",
	"--skip-bun-check": "skipBunCheck",
} as const;

const FALSE_FLAGS = {
	"--no-commit": "commit",
	"--no-pack": "pack",
	"--no-host": "host",
} as const;

function applyBooleanFlag(options: Options, arg: string): boolean {
	const truthy = TRUE_FLAGS[arg as keyof typeof TRUE_FLAGS];
	if (truthy) {
		options[truthy] = true;
		return true;
	}
	const falsy = FALSE_FLAGS[arg as keyof typeof FALSE_FLAGS];
	if (falsy) {
		options[falsy] = false;
		return true;
	}
	return false;
}

function parseArgs(argv: readonly string[]): Options {
	const options: Options = {
		check: false,
		dryRun: false,
		commit: true,
		pack: true,
		host: true,
		allowUntracked: false,
		skipBunCheck: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (applyBooleanFlag(options, arg)) continue;
		if (arg === "-m" || arg === "--message") {
			const value = argv[++i];
			if (!value?.trim()) fail(`${arg} needs a non-empty commit subject`);
			options.message = value;
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			process.stdout.write(HELP);
			process.exit(0);
		}
		fail(`unknown argument: ${arg}`);
	}
	if (options.check) {
		options.commit = false;
		options.pack = false;
	}
	if (options.dryRun) {
		options.commit = false;
		options.pack = false;
	}
	return options;
}

function preflight(options: Options): void {
	step("preflight");
	const bun = run(["bun", "--version"]).stdout.trim();
	if (!options.skipBunCheck && bun !== EXPECTED_BUN) {
		fail(
			`Bun ${bun} is not the pinned ${EXPECTED_BUN}; coverage line attribution differs on other versions. ` +
				"Pass --skip-bun-check to override.",
		);
	}
	if (run(["git", "rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true") {
		fail("not inside a git worktree");
	}
	const branch = run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (options.commit && branch.code !== 0) fail("detached HEAD; check out a branch before shipping");
	const untracked = run(["git", "ls-files", "--others", "--exclude-standard"]).stdout.trim();
	if (options.commit && untracked && !options.allowUntracked) {
		fail(`untracked files would be committed:\n  ${untracked.split("\n").join("\n  ")}\n(re-run with --allow-untracked)`);
	}
	const location = branch.code === 0 ? `branch ${branch.stdout.trim()}` : "detached HEAD";
	console.log(`  bun ${bun} · ${location}`);
}

function enforceThresholds(totals: CoverageTotals): void {
	const thresholds = {
		lines: Number(process.env.COVERAGE_LINES ?? 0.99),
		functions: Number(process.env.COVERAGE_FUNCTIONS ?? 0.9),
	};
	const lines = ratio(totals.linesHit, totals.lines);
	const functions = ratio(totals.functionsHit, totals.functions);
	const failures: string[] = [];
	if (lines < thresholds.lines) failures.push(`lines ${pct(lines)} < ${pct(thresholds.lines)} required`);
	if (functions < thresholds.functions) failures.push(`functions ${pct(functions)} < ${pct(thresholds.functions)} required`);
	if (failures.length > 0) fail(`coverage gate failed:\n  ${failures.join("\n  ")}`);
}

function attr(tag: string, name: string): number {
	const match = new RegExp(`\\b${name}="([^"]+)"`).exec(tag);
	return match ? Number(match[1]) : 0;
}

function parseJunit(xml: string): TestMetrics {
	const root = /<testsuites\b[^>]*>/.exec(xml)?.[0];
	if (!root) fail("junit report has no <testsuites> root");
	const perFile = new Map<string, number>();
	for (const match of xml.matchAll(/^ {2}<testsuite name="(test\/[^"]+\.test\.ts)"[^>]*\btests="(\d+)"/gm)) {
		perFile.set(match[1], Number(match[2]));
	}
	return {
		tests: attr(root, "tests"),
		failures: attr(root, "failures"),
		assertions: attr(root, "assertions"),
		seconds: attr(root, "time"),
		perFile,
	};
}

function runTestGate(): Metrics {
	step("tests + coverage");
	const dir = mkdtempSync(path.join(tmpdir(), "omp-ship-"));
	const junit = path.join(dir, "junit.xml");
	try {
		const result = run([
			"bun",
			"test",
			"--coverage",
			"--coverage-reporter=lcov",
			"--reporter=junit",
			`--reporter-outfile=${junit}`,
		]);
		if (result.code !== 0) {
			printFailure(result);
			fail("tests failed");
		}
		const tests = parseJunit(readFileSync(junit, "utf8"));
		const records = parseLcov(readFileSync(path.join(ROOT, "coverage/lcov.info"), "utf8")).filter(
			r => !isTestFile(r.file),
		);
		const totals = sumCoverage(records);
		enforceThresholds(totals);
		const lines = pct(ratio(totals.linesHit, totals.lines));
		const functions = pct(ratio(totals.functionsHit, totals.functions));
		console.log(
			`  ${tests.tests} pass, ${tests.failures} fail, ${tests.assertions} assertions, ${lines} lines / ${functions} functions`,
		);
		return { tests, records, totals };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function runGate(label: string, cmd: string[]): void {
	step(label);
	const result = run(cmd);
	if (result.code !== 0) {
		printFailure(result);
		fail(`${label} failed (exit ${result.code})`);
	}
	console.log("  ok");
}

function runLintGate(): void {
	step("lint");
	const result = run(["bun", "run", "lint"]);
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	if (result.code !== 0) fail(`lint failed (exit ${result.code})`);
	const summary = /\((\d+) errors?, (\d+) warnings?\)/.exec(`${result.stdout}${result.stderr}`);
	if (summary && Number(summary[2]) > 0) fail(`lint produced ${summary[2]} warning(s); the repo gate is 0 errors / 0 warnings`);
	console.log("  ok");
}

function runGates(): Metrics {
	const metrics = runTestGate();
	runGate("typecheck", ["bun", "run", "typecheck"]);
	runLintGate();
	runGate("package manifest", ["bun", "run", "check:package"]);
	return metrics;
}

function sectionRange(lines: readonly string[], heading: string): { start: number; end: number } {
	const start = lines.indexOf(heading);
	if (start < 0) fail(`cannot find "${heading}"`);
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i].startsWith("## ")) return { start, end: i };
	}
	return { start, end: lines.length };
}

interface ReplaceOptions {
	file: string;
	label: string;
	range?: { start: number; end: number };
	updates: DocUpdate[];
}

function replaceLine(
	lines: string[],
	predicate: (line: string) => boolean,
	build: (line: string) => string,
	options: ReplaceOptions,
): void {
	const start = options.range?.start ?? 0;
	const end = options.range?.end ?? lines.length;
	for (let i = start; i < end; i++) {
		if (!predicate(lines[i])) continue;
		const after = build(lines[i]);
		if (after !== lines[i]) {
			options.updates.push({ file: options.file, line: i + 1, before: lines[i], after });
		}
		lines[i] = after;
		return;
	}
	fail(`${options.file}: cannot find ${options.label}`);
}

function formatCount(value: number): string {
	return value.toLocaleString("en-US");
}

function assertSnapshotCoverage(metrics: Metrics): void {
	const listed = new Set<string>(SNAPSHOT_MODULES.map(module => module.source));
	for (const record of metrics.records) {
		if (!listed.has(record.file)) {
			fail(`coverage has a record for ${record.file}; add it to SNAPSHOT_MODULES and the snapshot table`);
		}
		if (record.file !== "split-view.ts" && record.uncoveredLines.length > 0) {
			fail(
				`${record.file} now has uncovered lines (${record.uncoveredLines.join(", ")}); ` +
					"document them in CODE_QUALITY.md and teach this script where",
			);
		}
	}
	for (const testFile of metrics.tests.perFile.keys()) {
		if (!SNAPSHOT_MODULES.some(module => module.testFile === testFile)) {
			fail(`junit has a suite for ${testFile}; add it to SNAPSHOT_MODULES`);
		}
	}
}

function refreshCodeQuality(metrics: Metrics): { text: string; updates: DocUpdate[] } {
	const updates: DocUpdate[] = [];
	const lines = readFileSync(CODE_QUALITY, "utf8").split("\n");
	const snapshot = sectionRange(lines, "## Snapshot");
	const linesPct = pct(ratio(metrics.totals.linesHit, metrics.totals.lines));
	const functionsPct = pct(ratio(metrics.totals.functionsHit, metrics.totals.functions));

	assertSnapshotCoverage(metrics);

	replaceLine(
		lines,
		line => line.startsWith("| `bun test` |"),
		line => line.replace(/\| \d+ tests, \d+ failures \|$/, `| ${metrics.tests.tests} tests, ${metrics.tests.failures} failures |`),
		{ file: "CODE_QUALITY.md", label: "the `bun test` gate row", updates },
	);

	for (const module of SNAPSHOT_MODULES) {
		const record = metrics.records.find(r => r.file === module.source);
		if (!record) fail(`coverage has no record for ${module.source}`);
		const count = metrics.tests.perFile.get(module.testFile);
		if (count === undefined) fail(`junit has no suite for ${module.testFile}`);
		replaceLine(
			lines,
			line => line.startsWith(`| \`${module.source}\` |`),
			() =>
				`| \`${module.source}\` | ${pct(ratio(record.linesHit, record.lines))} | ${pct(ratio(record.functionsHit, record.functions))} | \`${module.testFile}\` | ${count} |`,
			{ file: "CODE_QUALITY.md", label: `${module.source} snapshot row`, range: snapshot, updates },
		);
	}

	replaceLine(
		lines,
		line => line.startsWith("| **overall** |"),
		() => `| **overall** | **${linesPct}** | **${functionsPct}** | | **${metrics.tests.tests}** |`,
		{ file: "CODE_QUALITY.md", label: "the overall snapshot row", range: snapshot, updates },
	);

	replaceLine(
		lines,
		line => /^\d[\d,]* assertions, ~[\d.]+ s wall time\./.test(line),
		line => line.replace(/^\d[\d,]*/, formatCount(metrics.tests.assertions)),
		{ file: "CODE_QUALITY.md", label: "the assertion count", range: snapshot, updates },
	);

	replaceLine(
		lines,
		line => /Functions: \d+\/\d+ counted/.test(line),
		line => line.replace(/Functions: \d+\/\d+ counted/, `Functions: ${metrics.totals.functionsHit}/${metrics.totals.functions} counted`),
		{ file: "CODE_QUALITY.md", label: "the counted-functions line", range: snapshot, updates },
	);

	const split = metrics.records.find(r => r.file === "split-view.ts");
	const uncovered = split?.uncoveredLines ?? [];
	replaceLine(
		lines,
		line => line.includes("`themeGetter` default") && /split-view\.ts:\d+/.test(line),
		line => {
			if (uncovered.length !== 1) {
				fail(
					`split-view.ts has ${uncovered.length} uncovered lines (${uncovered.join(", ")}); ` +
						"update the Uncovered bullets in CODE_QUALITY.md by hand",
				);
			}
			return line.replace(/split-view\.ts:\d+/, `split-view.ts:${uncovered[0]}`);
		},
		{ file: "CODE_QUALITY.md", label: "the uncovered-line bullet", range: snapshot, updates },
	);

	if (updates.length > 0) {
		const today = new Date().toISOString().slice(0, 10);
		replaceLine(
			lines,
			line => /^Snapshot: \d{4}-\d{2}-\d{2},/.test(line),
			line => line.replace(/^Snapshot: \d{4}-\d{2}-\d{2},/, `Snapshot: ${today},`),
			{ file: "CODE_QUALITY.md", label: "the snapshot date", updates },
		);
	}

	return { text: lines.join("\n"), updates };
}

function refreshReadme(metrics: Metrics): { text: string; updates: DocUpdate[] } {
	const updates: DocUpdate[] = [];
	const lines = readFileSync(README, "utf8").split("\n");
	const linesPct = pct(ratio(metrics.totals.linesHit, metrics.totals.lines));
	const functionsPct = pct(ratio(metrics.totals.functionsHit, metrics.totals.functions));
	replaceLine(
		lines,
		line => /Current: [\d.]+% lines \/ [\d.]+% functions/.test(line),
		line => line.replace(/Current: [\d.]+% lines \/ [\d.]+% functions/, `Current: ${linesPct} lines / ${functionsPct} functions`),
		{ file: "README.md", label: "the coverage line", updates },
	);
	return { text: lines.join("\n"), updates };
}

function reportUpdates(updates: readonly DocUpdate[]): void {
	for (const update of updates) {
		console.log(`\n  ${update.file}:${update.line}`);
		console.log(`  - ${update.before}`);
		console.log(`  + ${update.after}`);
	}
}

function writeDocs(codeQuality: string, readme: string, updates: readonly DocUpdate[]): void {
	if (updates.length === 0) {
		console.log("\n  docs already match the measured snapshot");
		return;
	}
	if (updates.some(u => u.file === "CODE_QUALITY.md")) writeFileSync(CODE_QUALITY, codeQuality);
	if (updates.some(u => u.file === "README.md")) writeFileSync(README, readme);
	console.log(`\n  rewrote ${updates.length} line(s)`);
}

function stagedFiles(): string[] {
	const add = run(["git", "add", "-A"]);
	if (add.code !== 0) {
		printFailure(add);
		fail("git add failed");
	}
	const staged = run(["git", "diff", "--cached", "--name-only"]).stdout.trim();
	return staged ? staged.split("\n") : [];
}

async function resolveSubject(given: string | undefined): Promise<string> {
	if (given?.trim()) return given.trim();
	if (!process.stdin.isTTY) fail('no TTY to prompt with; pass -m "<subject>"');
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question("Commit subject: ")).trim();
		if (!answer) fail("empty commit subject");
		return answer;
	} finally {
		rl.close();
	}
}

async function commitAll(metrics: Metrics, given: string | undefined): Promise<void> {
	step("commit");
	const staged = stagedFiles();
	if (staged.length === 0) {
		console.log("  nothing to commit");
		return;
	}
	const subject = await resolveSubject(given);
	const body = [
		`Snapshot: ${metrics.tests.tests} tests, ${metrics.tests.failures} failures, ${formatCount(metrics.tests.assertions)} assertions`,
		`Coverage: ${pct(ratio(metrics.totals.linesHit, metrics.totals.lines))} lines / ${pct(ratio(metrics.totals.functionsHit, metrics.totals.functions))} functions`,
		"Gates: typecheck, test+coverage, lint, check:package",
		`Files: ${staged.length} changed`,
	].join("\n");
	const result = run(["git", "commit", "-m", subject, "-m", body]);
	if (result.code !== 0) {
		printFailure(result);
		fail("git commit failed");
	}
	const hash = run(["git", "rev-parse", "--short", "HEAD"]).stdout.trim();
	console.log(`  committed ${hash}: ${subject}`);
}

function pack(): string {
	step("pack");
	const result = run(["bun", "pm", "pack"]);
	if (result.code !== 0) {
		printFailure(result);
		fail("bun pm pack failed");
	}
	const tgzName = result.stdout
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.endsWith(".tgz"))
		.pop();
	if (!tgzName) fail("bun pm pack printed no tarball name");
	const tgz = path.resolve(ROOT, tgzName);
	console.log(`  ${path.basename(tgz)}`);
	return tgz;
}

function headFile(rel: string): Buffer {
	const proc = Bun.spawnSync({
		cmd: ["git", "show", `HEAD:${rel}`],
		cwd: ROOT,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) fail(`git show HEAD:${rel} failed`);
	return Buffer.from(proc.stdout);
}

interface PackedCompare {
	tgz: string;
	stage: string;
	label: string;
}

function comparePacked(context: PackedCompare, rel: string, expected: Buffer): void {
	const packedPath = path.join(context.stage, "package", rel);
	if (!existsSync(packedPath)) {
		rmSync(context.stage, { recursive: true, force: true });
		fail(`tarball is missing ${rel}`);
	}
	if (Buffer.compare(readFileSync(packedPath), expected) !== 0) {
		rmSync(context.stage, { recursive: true, force: true });
		fail(`${path.basename(context.tgz)}: ${rel} does not match ${context.label}`);
	}
}

/** Extract the artifact and compare every packed file with HEAD (or the
 * working tree when the caller opted out of committing). */
function verifyTarball(tgz: string, againstHead: boolean): string {
	step("verify tarball");
	const stage = mkdtempSync(path.join(tmpdir(), "omp-ship-tarball-"));
	const extracted = run(["tar", "-xzf", tgz, "-C", stage]);
	if (extracted.code !== 0) {
		printFailure(extracted);
		rmSync(stage, { recursive: true, force: true });
		fail("could not extract the tarball");
	}
	const manifestPath = path.join(stage, "package", "package.json");
	if (!existsSync(manifestPath)) {
		rmSync(stage, { recursive: true, force: true });
		fail("tarball has no package/package.json");
	}
	const packedManifest = readFileSync(manifestPath);
	const label = againstHead ? "HEAD" : "the working tree";
	const compare = { tgz, stage, label };
	const expectedManifest = againstHead ? headFile("package.json") : readFileSync(path.join(ROOT, "package.json"));
	comparePacked(compare, "package.json", expectedManifest);
	const manifest = JSON.parse(packedManifest.toString("utf8")) as { files?: string[] };
	if (!manifest.files?.length) {
		rmSync(stage, { recursive: true, force: true });
		fail("packed manifest has no files list");
	}
	let checked = 1;
	for (const rel of manifest.files) {
		comparePacked(compare, rel, againstHead ? headFile(rel) : readFileSync(path.join(ROOT, rel)));
		checked++;
	}
	console.log(`  ${checked} files match ${label}`);
	return stage;
}

function verifyHostLoad(stage: string): void {
	step("host load");
	const omp = Bun.which("omp");
	if (!omp) {
		console.log("  omp not on PATH; skipped");
		return;
	}
	const entry = path.join(stage, "package", "split-view.ts");
	const timeout = Bun.which("timeout");
	const command = timeout
		? [timeout, "60", omp, "--no-extensions", "-e", entry, "--mode", "rpc"]
		: [omp, "--no-extensions", "-e", entry, "--mode", "rpc"];
	const result = run(command);
	const output = `${result.stdout}${result.stderr}`;
	if (output.includes("Failed to load extension")) {
		printFailure(result);
		fail("the packed entry did not load in the real host");
	}
	// The repo pins Bun 1.4.3 for lcov attribution while the installed host may
	// require a newer runtime; that is an environment mismatch, not a bad package.
	if (result.code !== 0 && /Bun runtime must be >=/.test(output)) {
		console.log(`  skipped: the host refuses Bun ${run(["bun", "--version"]).stdout.trim()}`);
		return;
	}
	if (result.code !== 0) {
		printFailure(result);
		fail(`the host exited ${result.code}`);
	}
	console.log("  packed entry loaded");
}

async function main(): Promise<void> {
	const options = parseArgs(Bun.argv.slice(2));
	preflight(options);
	const metrics = runGates();

	step("docs");
	const codeQuality = refreshCodeQuality(metrics);
	const readme = refreshReadme(metrics);
	const updates = [...codeQuality.updates, ...readme.updates];
	console.log(`  ${updates.length} stale line(s) found`);
	reportUpdates(updates);

	if (options.check) {
		if (updates.length > 0) fail(`${updates.length} stale snapshot line(s); run \`bun run ship\` to rewrite them`);
		console.log("\n  check passed");
		return;
	}
	if (options.dryRun) {
		console.log("\n  dry run: no files written, nothing committed, no tarball");
		return;
	}
	writeDocs(codeQuality.text, readme.text, updates);

	if (options.commit) await commitAll(metrics, options.message);
	const againstHead = run(["git", "status", "--porcelain", "--untracked-files=no"]).stdout.trim() === "";
	if (options.pack) {
		const tgz = pack();
		const stage = verifyTarball(tgz, againstHead);
		try {
			if (options.host) verifyHostLoad(stage);
		} finally {
			rmSync(stage, { recursive: true, force: true });
		}
	}
	const refreshed = updates.length === 0 ? "clean" : `${updates.length} line(s) refreshed`;
	const commitNote = options.commit ? "" : " (not committed)";
	console.log(`\nship: ${refreshed}${commitNote}`);
}

if (import.meta.main) await main();
