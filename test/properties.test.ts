/**
 * Property-based tests (fast-check) for the pure helpers and the config
 * normalizer: invariants hold for arbitrary input, not just pinned examples.
 * Fixed seeds keep failures reproducible.
 */
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import {
	AUTO_DOCK_MAX_COLS,
	AUTO_DOCK_MIN_COLS,
	AUTO_DOCK_PCT,
	MAX_BAND_HEIGHT,
	MIN_BAND_HEIGHT,
	MIN_DOCK_COLS,
	appendStreamTail,
	bandToolsColsFor,
	capDisplayLine,
	capToolText,
	dockColsFor,
	formatDuration,
	isHighSurrogate,
	isLowSurrogate,
	lastImageBlock,
	outputPreview,
	sanitizeText,
	transcriptVisibility,
	truncateInline,
} from "../helpers.ts";
import { normalizeConfig } from "../ui-panels-config.ts";

const SEED = 20261101;

/** Marker capToolText prepends when it truncates. */
const MARKER = /^\[truncated: newest \d+ of \d+ chars\]\n/;

describe("sanitizeText", () => {
	test("removes escape sequences and controls, keeping only line breaks", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary" }), s => {
				const out = sanitizeText(s);
				expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
				expect(out.split("\n").length).toBe(s.replace(/\r\n?/g, "\n").split("\n").length);
			}),
			{ numRuns: 500, seed: SEED },
		);
	});

	test("strips complete CSI/OSC sequences instead of leaking their tail", () => {
		const hostile = "a\u001b[31mred\u001b[0m b\u001b]0;title\u0007 c\u001b[2J";
		expect(sanitizeText(hostile)).toBe("ared b c");
	});
});

describe("truncateInline", () => {
	test("never exceeds max, never doubles whitespace, never splits a surrogate", () => {
		fc.assert(
			fc.property(fc.string(), fc.integer({ min: 1, max: 120 }), (s, max) => {
				const out = truncateInline(s, max);
				expect(out.length).toBeLessThanOrEqual(max);
				expect(out.trim()).toBe(out);
				expect(/\s{2}|\n|\t/.test(out)).toBe(false);
				if (out.length > 0) {
					expect(isHighSurrogate(out.charCodeAt(out.length - 1))).toBe(false);
					expect(isLowSurrogate(out.charCodeAt(0))).toBe(false);
				}
			}),
			{ numRuns: 500, seed: SEED },
		);
	});
});

describe("capToolText", () => {
	test("always fits the cap, even below the marker length", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary" }), fc.integer({ min: 1, max: 400 }), (s, cap) => {
				const out = capToolText(s, cap);
				expect(out.length).toBeLessThanOrEqual(cap);
			}),
			{ numRuns: 500, seed: SEED },
		);
	});

	test("keeps the newest suffix, code-point aligned", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary" }), fc.integer({ min: 1, max: 400 }), (s, cap) => {
				const out = capToolText(s, cap);
				if (s.length <= cap) {
					expect(out).toBe(s);
					return;
				}
				const payload = out.replace(MARKER, "");
				// Whatever survives is the tail of the input, never a palindrome of it.
				expect(s.endsWith(payload)).toBe(true);
				if (payload.length > 0) expect(isLowSurrogate(payload.charCodeAt(0))).toBe(false);
			}),
			{ numRuns: 500, seed: SEED },
		);
	});
});

describe("bandToolsColsFor", () => {
	test("honours both panel minimums for any ratio", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 44, max: 400 }),
				fc.integer({ min: 0, max: 100 }),
				(total, pct) => {
					const tools = bandToolsColsFor(total, pct);
					expect(tools).toBeGreaterThanOrEqual(20);
					expect(tools).toBeLessThanOrEqual(total - 24);
				},
			),
			{ numRuns: 500, seed: SEED },
		);
	});

	test("is monotone in the tools percentage", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 44, max: 400 }),
				fc.integer({ min: 0, max: 100 }),
				fc.integer({ min: 0, max: 100 }),
				(total, a, b) => {
					const [lo, hi] = a <= b ? [a, b] : [b, a];
					expect(bandToolsColsFor(total, lo)).toBeLessThanOrEqual(bandToolsColsFor(total, hi));
				},
			),
			{ numRuns: 300, seed: SEED },
		);
	});
});

describe("dockColsFor", () => {
	test("auto tracks the terminal within 34–120, manual stays inside it", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 40, max: 800 }),
				fc.option(fc.integer({ min: -100, max: 800 }), { nil: null }),
				(cols, manual) => {
					const width = dockColsFor(cols, manual);
					if (manual === null) {
						expect(width).toBeGreaterThanOrEqual(AUTO_DOCK_MIN_COLS);
						expect(width).toBeLessThanOrEqual(AUTO_DOCK_MAX_COLS);
						// On a terminal wide enough for the ratio to apply, the dock
						// must keep growing with it, never flat-cap mid-range.
						if (cols >= 200 && width < AUTO_DOCK_MAX_COLS)
							expect(width).toBe(Math.floor(cols * AUTO_DOCK_PCT));
					} else {
						expect(width).toBeGreaterThanOrEqual(MIN_DOCK_COLS);
						expect(width).toBeLessThanOrEqual(Math.max(MIN_DOCK_COLS, cols - 50));
					}
				},
			),
			{ numRuns: 500, seed: SEED },
		);
	});
});

describe("formatDuration", () => {
	test("only ever emits the documented shapes", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 200_000_000 }), fc.boolean(), (ms, live) => {
				expect(formatDuration(ms, live)).toMatch(/^(?:\d+\.\ds|\d+s|\d+m\d\ds|\d+h\d\dm)$/);
			}),
			{ numRuns: 300, seed: SEED },
		);
	});

	test("live mode ticks in whole seconds below a minute", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 59_999 }), ms => {
				expect(formatDuration(ms, true)).toMatch(/^\d+s$/);
			}),
			{ numRuns: 300, seed: SEED },
		);
	});
});

describe("appendStreamTail", () => {
	test("moves every completed line and keeps a bounded, suffix-shaped tail", () => {
		fc.assert(
			fc.property(
				fc.string({ unit: "binary", maxLength: 200 }),
				fc.integer({ min: 1, max: 200 }),
				(delta, maxTail) => {
					const lines: string[] = [];
					const tail = appendStreamTail(lines, "", delta, maxTail);
					const expectedLines = delta.split("\n").length - 1;
					expect(lines.length).toBe(expectedLines);
					expect(tail).not.toContain("\n");
					expect(tail.length).toBeLessThanOrEqual(maxTail);
					expect(delta.endsWith(tail)).toBe(true);
					if (tail.length > 0) expect(isLowSurrogate(tail.charCodeAt(0))).toBe(false);
					for (const line of lines) expect(line).not.toContain("\n");
				},
			),
			{ numRuns: 500, seed: SEED },
		);
	});
});

describe("capDisplayLine", () => {
	test("caps to the newest chars with an ellipsis and no split surrogate", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary" }), fc.integer({ min: 3, max: 200 }), (line, max) => {
				const out = capDisplayLine(line, max);
				if (line.length <= max) {
					expect(out).toBe(line);
					return;
				}
				expect(out.startsWith("… ")).toBe(true);
				expect(out.length).toBeLessThanOrEqual(max);
				const payload = out.slice(2);
				expect(line.endsWith(payload)).toBe(true);
				expect(isLowSurrogate(payload.charCodeAt(0))).toBe(false);
			}),
			{ numRuns: 500, seed: SEED },
		);
	});
});

describe("outputPreview", () => {
	test("shows a prefix and accounts for every hidden line", () => {
		fc.assert(
			fc.property(
				fc.array(fc.string(), { maxLength: 50 }),
				fc.integer({ min: -5, max: 50 }),
				(lines, cap) => {
					const { shown, hidden } = outputPreview(lines, cap);
					expect(shown.length).toBe(Math.min(Math.max(0, cap), lines.length));
					expect(shown).toEqual(lines.slice(0, shown.length));
					expect(shown.length + hidden).toBe(lines.length);
				},
			),
			{ numRuns: 500, seed: SEED },
		);
	});
});

describe("lastImageBlock", () => {
	test("returns exactly the last well-formed image block", () => {
		const block = fc.record({
			type: fc.constantFrom("image", "text", "audio"),
			data: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
			mimeType: fc.oneof(fc.string(), fc.constant(undefined)),
		});
		fc.assert(
			fc.property(fc.array(block, { maxLength: 12 }), blocks => {
				const expected = [...blocks]
					.reverse()
					.find(
						b =>
							b.type === "image" &&
							typeof b.data === "string" &&
							typeof b.mimeType === "string",
					);
				const actual = lastImageBlock(blocks);
				if (!expected) expect(actual).toBeUndefined();
				else expect(actual).toEqual({ data: expected.data as string, mimeType: expected.mimeType as string });
			}),
			{ numRuns: 500, seed: SEED },
		);
	});
});

describe("transcriptVisibility", () => {
	test("response-only always wins; otherwise the thinking panel owns thinking", () => {
		fc.assert(
			fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (thinkingPanel, responseOnly, visible) => {
				const v = transcriptVisibility(thinkingPanel, responseOnly, visible);
				expect(v.hideTools).toBe(responseOnly);
				expect(v.hideThinking).toBe(responseOnly || (thinkingPanel && visible));
			}),
			{ numRuns: 200, seed: SEED },
		);
	});
});

describe("normalizeConfig", () => {
	test("any input yields a valid, idempotent config", () => {
		fc.assert(
			fc.property(fc.anything(), raw => {
				const cfg = normalizeConfig(raw as never);
				expect(typeof cfg.split).toBe("boolean");
				expect(typeof cfg.thinking).toBe("boolean");
				expect(typeof cfg.tools).toBe("boolean");
				expect(typeof cfg.files).toBe("boolean");
				expect(typeof cfg.diff).toBe("boolean");
				expect(typeof cfg.trimResponse).toBe("boolean");
				expect(["compact", "full"]).toContain(cfg.toolMode);
				expect(Number.isInteger(cfg.bandHeight)).toBe(true);
				expect(cfg.bandHeight).toBeGreaterThanOrEqual(MIN_BAND_HEIGHT);
				expect(cfg.bandHeight).toBeLessThanOrEqual(MAX_BAND_HEIGHT);
				expect(Number.isInteger(cfg.toolsWidthPct)).toBe(true);
				expect(cfg.toolsWidthPct).toBeGreaterThanOrEqual(20);
				expect(cfg.toolsWidthPct).toBeLessThanOrEqual(60);
				if (cfg.filesWidth !== null) {
					expect(Number.isInteger(cfg.filesWidth)).toBe(true);
					expect(cfg.filesWidth).toBeGreaterThanOrEqual(24);
					expect(cfg.filesWidth).toBeLessThanOrEqual(200);
				}
				if (!cfg.split) {
					expect(cfg.thinking).toBe(false);
					expect(cfg.tools).toBe(false);
				}
				expect(normalizeConfig(cfg as never)).toEqual(cfg);
			}),
			{ numRuns: 500, seed: SEED },
		);
	});

	test("non-finite numbers fall back to the documented defaults", () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const cfg = normalizeConfig({ bandHeight: bad, toolsWidthPct: bad, filesWidth: bad });
			expect(cfg.bandHeight).toBe(20);
			expect(cfg.toolsWidthPct).toBe(35);
			expect(cfg.filesWidth).toBeNull();
		}
	});
});
