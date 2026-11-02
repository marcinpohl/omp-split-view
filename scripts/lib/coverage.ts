/**
 * Shared lcov parsing for the coverage gate and the ship snapshot.
 *
 * Bun writes the report; both callers need the same totals, so the parser
 * lives here instead of being duplicated (or re-invoked as a subprocess).
 */

export interface CoverageRecord {
	file: string;
	lines: number;
	linesHit: number;
	functions: number;
	functionsHit: number;
	/** Line numbers Bun instrumented but no test executed. */
	uncoveredLines: number[];
}

export interface CoverageTotals {
	lines: number;
	linesHit: number;
	functions: number;
	functionsHit: number;
}

function applyField(record: CoverageRecord, tag: string, value: string): void {
	switch (tag) {
		case "LF":
			record.lines = Number(value);
			break;
		case "LH":
			record.linesHit = Number(value);
			break;
		case "FNF":
			record.functions = Number(value);
			break;
		case "FNH":
			record.functionsHit = Number(value);
			break;
		case "DA": {
			const [lineNumber, hits] = value.split(",");
			if (Number(hits) === 0) record.uncoveredLines.push(Number(lineNumber));
			break;
		}
		default:
			break;
	}
}

export function parseLcov(text: string): CoverageRecord[] {
	const out: CoverageRecord[] = [];
	let current: CoverageRecord | undefined;
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
		if (tag === "SF") {
			current = { file: value, lines: 0, linesHit: 0, functions: 0, functionsHit: 0, uncoveredLines: [] };
		} else if (current) {
			applyField(current, tag, value);
		}
	}
	return out;
}

/** Test files are fixtures, not product code; they are excluded from the gate. */
export const isTestFile = (file: string): boolean => /(^|\/)test\//.test(file);

export function sumCoverage(records: readonly CoverageRecord[]): CoverageTotals {
	return records.reduce(
		(acc, r) => ({
			lines: acc.lines + r.lines,
			linesHit: acc.linesHit + r.linesHit,
			functions: acc.functions + r.functions,
			functionsHit: acc.functionsHit + r.functionsHit,
		}),
		{ lines: 0, linesHit: 0, functions: 0, functionsHit: 0 },
	);
}

export const ratio = (hit: number, total: number): number => (total === 0 ? 1 : hit / total);

export const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;
