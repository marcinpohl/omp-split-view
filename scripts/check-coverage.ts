/**
 * Coverage gate: parses Bun's lcov report and fails when coverage drops below
 * the thresholds. Bun 1.4 accepts `bunfig.toml` coverage keys but does not
 * enforce a threshold, so the gate lives here.
 *
 * Usage: `bun run test:coverage`
 * Override: `COVERAGE_LINES=0.9 COVERAGE_FUNCTIONS=0.85 bun scripts/check-coverage.ts`
 */
import { readFileSync } from "node:fs";

const THRESHOLDS = {
	lines: Number(process.env.COVERAGE_LINES ?? 0.99),
	functions: Number(process.env.COVERAGE_FUNCTIONS ?? 0.9),
};

interface Record {
	file: string;
	lines: number;
	linesHit: number;
	functions: number;
	functionsHit: number;
}

const lcovPath = process.argv[2] ?? "coverage/lcov.info";

function parseLcov(text: string): Record[] {
	const out: Record[] = [];
	let current: Record | undefined;
	for (const line of text.split("\n")) {
		if (line === "end_of_record") {
			if (current) out.push(current);
			current = undefined;
			continue;
		}
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const tag = line.slice(0, colon);
		const value = line.slice(colon + 1);
		if (tag === "SF") current = { file: value, lines: 0, linesHit: 0, functions: 0, functionsHit: 0 };
		else if (!current) continue;
		else if (tag === "LF") current.lines = Number(value);
		else if (tag === "LH") current.linesHit = Number(value);
		else if (tag === "FNF") current.functions = Number(value);
		else if (tag === "FNH") current.functionsHit = Number(value);
	}
	return out;
}

/** Test files are fixtures, not product code; they are excluded from the gate. */
const isTestFile = (file: string) => /(^|\/)test\//.test(file);

let text: string;
try {
	text = readFileSync(lcovPath, "utf8");
} catch {
	console.error(`coverage gate: no report at ${lcovPath} (run via \`bun run test:coverage\`)`);
	process.exit(1);
}

const records = parseLcov(text).filter(r => !isTestFile(r.file));
const totals = records.reduce(
	(acc, r) => ({
		lines: acc.lines + r.lines,
		linesHit: acc.linesHit + r.linesHit,
		functions: acc.functions + r.functions,
		functionsHit: acc.functionsHit + r.functionsHit,
	}),
	{ lines: 0, linesHit: 0, functions: 0, functionsHit: 0 },
);

const ratio = (hit: number, total: number) => (total === 0 ? 1 : hit / total);
const pct = (value: number) => `${(value * 100).toFixed(2)}%`;

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
