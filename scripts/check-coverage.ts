/**
 * Coverage gate: parses Bun's lcov report and fails when coverage drops below
 * the thresholds. Bun 1.4 accepts `bunfig.toml` coverage keys but does not
 * enforce a threshold, so the gate lives here.
 *
 * Usage: `bun run test:coverage`
 * Override: `COVERAGE_LINES=0.9 COVERAGE_FUNCTIONS=0.85 bun scripts/check-coverage.ts`
 */
import { readFileSync } from "node:fs";
import { isTestFile, parseLcov, pct, ratio, sumCoverage } from "./lib/coverage.ts";

const THRESHOLDS = {
	lines: Number(process.env.COVERAGE_LINES ?? 0.99),
	functions: Number(process.env.COVERAGE_FUNCTIONS ?? 0.9),
};

const lcovPath = process.argv[2] ?? "coverage/lcov.info";

let text: string;
try {
	text = readFileSync(lcovPath, "utf8");
} catch {
	console.error(`coverage gate: no report at ${lcovPath} (run via \`bun run test:coverage\`)`);
	process.exit(1);
}

const records = parseLcov(text).filter(r => !isTestFile(r.file));
const totals = sumCoverage(records);

const lines = ratio(totals.linesHit, totals.lines);
const functions = ratio(totals.functionsHit, totals.functions);
const failures: string[] = [];
if (lines < THRESHOLDS.lines)
	failures.push(`lines ${pct(lines)} < ${pct(THRESHOLDS.lines)} required`);
if (functions < THRESHOLDS.functions)
	failures.push(`functions ${pct(functions)} < ${pct(THRESHOLDS.functions)} required`);

for (const r of records)
	console.log(
		`${r.file.padEnd(24)} lines ${pct(ratio(r.linesHit, r.lines)).padStart(7)}  funcs ${pct(ratio(r.functionsHit, r.functions)).padStart(7)}`,
	);
console.log(`\noverall               lines ${pct(lines).padStart(7)}  funcs ${pct(functions).padStart(7)}`);
if (failures.length > 0) {
	console.error(`\ncoverage gate failed:\n  ${failures.join("\n  ")}`);
	process.exit(1);
}
