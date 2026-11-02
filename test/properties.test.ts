/**
 * Property-based tests (fast-check) for the observable helpers — text
 * pipelines, capped windows, framed rows — and the config normalizer: their
 * invariants hold for arbitrary input, not just pinned examples. This is the
 * only home for property tests; `helpers.test.ts` pins concrete examples.
 * Fixed seeds keep failures reproducible.
 */
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import {
	AUTO_DOCK_MAX_COLS,
	AUTO_DOCK_MIN_COLS,
	AUTO_DOCK_PCT,
	DOCK_LEFT_RESERVE,
	GEOMETRY_PROFILES,
	MAX_BAND_HEIGHT,
	MIN_BAND_HEIGHT,
	MIN_DOCK_COLS,
	appendStreamTail,
	autoGeometryMode,
	bandToolsColsFor,
	capDisplayLine,
	capToolText,
	defaultBandHeight,
	dockColsFor,
	formatDuration,
	framedRow,
	isHighSurrogate,
	isLowSurrogate,
	lastImageBlock,
	nonEmptyLines,
	resultText,
	resultTextTail,
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

/** 4k/wide are ordered: `wide` trades band rows for dock columns. */
describe("geometry profiles", () => {
	const PRESETS = ["4k", "wide"] as const;
	const rows = fc.integer({ min: 0, max: 2000 });
	const cols = fc.integer({ min: 0, max: 2000 });
	const rank = (mode: string) => (mode === "wide" ? 1 : 0);

	test("the band never shrinks as the terminal grows", () => {
		fc.assert(
			fc.property(rows, rows, fc.constantFrom(...PRESETS), (a, b, preset) => {
				const [lo, hi] = a <= b ? [a, b] : [b, a];
				const profile = GEOMETRY_PROFILES[preset];
				expect(defaultBandHeight(lo, profile)).toBeLessThanOrEqual(defaultBandHeight(hi, profile));
			}),
			{ numRuns: 300, seed: SEED },
		);
	});

	test("the auto dock never shrinks as the terminal widens", () => {
		fc.assert(
			fc.property(cols, cols, fc.constantFrom(...PRESETS), (a, b, preset) => {
				const [narrow, wide] = a <= b ? [a, b] : [b, a];
				const profile = GEOMETRY_PROFILES[preset];
				expect(dockColsFor(narrow, null, profile)).toBeLessThanOrEqual(
					dockColsFor(wide, null, profile),
				);
			}),
			{ numRuns: 300, seed: SEED },
		);
	});

	test("a manual dock width ignores the preset and is idempotent", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 40, max: 2000 }),
				fc.option(fc.integer({ min: -100, max: 2000 }), { nil: null }),
				(width, manual) => {
					if (manual === null) return;
					const preset = dockColsFor(width, manual, GEOMETRY_PROFILES.wide);
					expect(preset).toBe(dockColsFor(width, manual, GEOMETRY_PROFILES["4k"]));
					expect(preset).toBe(dockColsFor(width, manual));
					expect(preset).toBeGreaterThanOrEqual(MIN_DOCK_COLS);
					expect(preset).toBeLessThanOrEqual(Math.max(MIN_DOCK_COLS, width - DOCK_LEFT_RESERVE));
					// Re-clamping an already clamped width cannot move it.
					expect(dockColsFor(width, preset, GEOMETRY_PROFILES.wide)).toBe(preset);
				},
			),
			{ numRuns: 500, seed: SEED },
		);
	});

	test("wide always spends fewer rows and buys more columns", () => {
		fc.assert(
			fc.property(rows, cols, (n, width) => {
				const fourK = GEOMETRY_PROFILES["4k"];
				const wide = GEOMETRY_PROFILES.wide;
				const fourKBand = defaultBandHeight(n, fourK);
				const wideBand = defaultBandHeight(n, wide);
				expect(wideBand).toBeLessThanOrEqual(fourKBand);
				// Strict while the 4k band has not hit the ceiling (below ~178 rows).
				if (fourKBand < MAX_BAND_HEIGHT) expect(wideBand).toBeLessThan(fourKBand);
				expect(dockColsFor(width, null, wide)).toBeGreaterThan(dockColsFor(width, null, fourK));
			}),
			{ numRuns: 500, seed: SEED },
		);
	});

	test("each preset matches its documented curve at every size", () => {
		// Literal shares, not the module's own constants: a drifted `bandPct`
		// or `dockPct` must fail here, which is why the other geometry
		// properties (they derive expectations from the profiles) cannot.
		const DOCUMENTED = {
			"4k": { bandPct: 0.45, minBand: 20, dockPct: 0.25, minDock: 34, maxDock: 120 },
			wide: { bandPct: 0.35, minBand: 14, dockPct: 0.32, minDock: 40, maxDock: 200 },
		} as const;
		fc.assert(
			fc.property(rows, cols, fc.constantFrom(...PRESETS), (n, width, preset) => {
				const spec = DOCUMENTED[preset];
				expect(defaultBandHeight(n, GEOMETRY_PROFILES[preset])).toBe(
					Math.max(spec.minBand, Math.min(MAX_BAND_HEIGHT, Math.floor(n * spec.bandPct))),
				);
				expect(dockColsFor(width, null, GEOMETRY_PROFILES[preset])).toBe(
					Math.max(spec.minDock, Math.min(spec.maxDock, Math.floor(width * spec.dockPct))),
				);
			}),
			{ numRuns: 500, seed: SEED },
		);
	});

	test("autoGeometryMode matches the exact aspect threshold", () => {
		// Literal 8: the documented ultrawide cutoff, not `AUTO_WIDE_ASPECT`.
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 500 }),
				fc.integer({ min: 0, max: 10_000 }),
				(rows, cols) => {
					expect(autoGeometryMode(cols, rows)).toBe(cols >= 8 * rows ? "wide" : "4k");
					// Both sides of the boundary, exactly.
					expect(autoGeometryMode(8 * rows, rows)).toBe("wide");
					expect(autoGeometryMode(8 * rows - 1, rows)).toBe("4k");
				},
			),
			{ numRuns: 400, seed: SEED },
		);
	});

	test("autoGeometryMode only ever narrows as the pane gets taller", () => {
		// From one reported row up: at zero rows there is no shape to read, and
		// the fallback (`4k`) is deliberately not part of the ordering.
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 500 }),
				fc.integer({ min: 1, max: 500 }),
				fc.integer({ min: 0, max: 5000 }),
				(a, b, cols) => {
					const [shorter, taller] = a <= b ? [a, b] : [b, a];
					expect(rank(autoGeometryMode(cols, shorter))).toBeGreaterThanOrEqual(
						rank(autoGeometryMode(cols, taller)),
					);
				},
			),
			{ numRuns: 300, seed: SEED },
		);
	});

	test("a pane with no reported rows never counts as wide", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 5000 }), fc.integer({ min: -50, max: 0 }), (cols, rows) => {
				expect(autoGeometryMode(cols, rows)).toBe("4k");
			}),
			{ numRuns: 100, seed: SEED },
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

	test("geometry keeps only the three literals and defaults to auto", () => {
		const SETTINGS = ["auto", "4k", "wide"] as const;
		fc.assert(
			fc.property(
				fc.oneof(fc.string(), fc.constantFrom(...SETTINGS), fc.anything()),
				raw => {
					const cfg = normalizeConfig({ geometry: raw as never });
					expect(SETTINGS).toContain(cfg.geometry);
					const expected = raw === "4k" || raw === "wide" ? raw : "auto";
					expect(cfg.geometry).toBe(expected);
					// A normalized value must survive another round trip unchanged.
					expect(normalizeConfig({ geometry: cfg.geometry }).geometry).toBe(cfg.geometry);
				},
			),
			{ numRuns: 400, seed: SEED },
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

/** Text a frame actually receives: the extension sanitizes before a row, so no
 * escapes or controls (they would be width-invisible across the pad). */
const FRAME_CONTENT = fc
	.array(
		fc.constantFrom("", " ", "a", "word", "📂 Files (12)", "漢字", "e\u0301", "-".repeat(37), "x y z", "  pad  "),
		{ maxLength: 8 },
	)
	.map(parts => parts.join(""));

/** Identity colorizer: frame geometry is measurable without a live theme. */
const flatFrameTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;

describe("framedRow", () => {
	test("every row is exactly inner + 2 cells and never wraps", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 80 }), FRAME_CONTENT, (inner, content) => {
				const row = framedRow(flatFrameTheme, inner, content);
				expect(visibleWidth(row)).toBe(inner + 2);
				expect(row).not.toContain("\n");
				expect(row.startsWith("│")).toBe(true);
				expect(row.endsWith("│")).toBe(true);
			}),
			{ numRuns: 300, seed: SEED },
		);
	});

	test("a rule is its content plus fill, and clipping never overflows", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 40 }),
				FRAME_CONTENT,
				fc.record({
					fill: fc.constantFrom("─", "·", " "),
					left: fc.constantFrom("╭", "├", "│", "╰"),
					right: fc.constantFrom("╮", "┤", "│", "╯"),
				}),
				(inner, content, { fill, left, right }) => {
					const row = framedRow(flatFrameTheme, inner, content, { fill, left, right });
					const middle = row.slice(1, -1);
					expect(visibleWidth(row)).toBe(inner + 2);
					expect(visibleWidth(middle)).toBe(inner);
					const contentWidth = visibleWidth(content);
					// Within the frame the content is kept verbatim; past it, clipped.
					if (contentWidth <= inner) expect(middle).toBe(content + fill.repeat(inner - contentWidth));
					else expect(middle).not.toBe(content);
				},
			),
			{ numRuns: 300, seed: SEED },
		);
	});

	test("the borders and a non-space fill carry the border colour", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 30 }), fc.constantFrom("─", "━", "·"), (inner, fill) => {
				const colors: string[] = [];
				const theme = {
					fg: (color: string, text: string) => {
						colors.push(color);
						return `<${text}>`;
					},
				} as unknown as Theme;
				const row = framedRow(theme, inner, "", { fill, left: "├", right: "┤" });
				// A bare rule would leave the dashes uncoloured with a real theme.
				expect(row).toBe(`<├><${fill.repeat(inner)}><┤>`);
				expect(colors).toEqual(["border", "border", "border"]);
			}),
			{ numRuns: 100, seed: SEED },
		);
	});
});

describe("nonEmptyLines", () => {
	/** Independent formulation: normalize CRLF, then keep trimmed non-blanks. */
	const oracle = (text: string): string[] => {
		const out: string[] = [];
		for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
			const trimmed = line.trim();
			if (trimmed !== "") out.push(trimmed);
		}
		return out;
	};

	test("equals the trimmed, non-blank lines of the text", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary" }), text => {
				expect(nonEmptyLines(text)).toEqual(oracle(text));
			}),
			{ numRuns: 300, seed: SEED },
		);
	});

	test("is idempotent and yields only trimmed, non-blank, control-free lines", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary" }), text => {
				const lines = nonEmptyLines(sanitizeText(text));
				for (const line of lines) {
					expect(line).toBe(line.trim());
					expect(line.length).toBeGreaterThan(0);
					expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
				}
				expect(nonEmptyLines(lines.join("\n"))).toEqual(lines);
			}),
			{ numRuns: 300, seed: SEED },
		);
	});
});

/** One tool-result content block: well-formed text, a non-text block, or junk. */
const CONTENT_BLOCK = fc.oneof(
	fc.record({ type: fc.constant("text"), text: fc.string({ unit: "binary" }) }),
	fc.record({ type: fc.constantFrom("image", "toolCall", "thinking"), data: fc.string({ unit: "binary" }) }),
	fc.record({ type: fc.constant("text") }),
	fc.string({ unit: "binary" }),
	fc.constant(null),
	fc.constant(42),
);

type TextBlock = { type: "text"; text: string };

const isTextBlock = (block: unknown): block is TextBlock =>
	typeof block === "object" &&
	block !== null &&
	(block as { type?: unknown }).type === "text" &&
	typeof (block as { text?: unknown }).text === "string";

describe("resultText", () => {
	test("joins the text blocks in order and ignores every other block", () => {
		fc.assert(
			fc.property(fc.array(CONTENT_BLOCK, { maxLength: 8 }), blocks => {
				const text = resultText({ content: blocks });
				const texts = blocks.filter(isTextBlock).map(block => block.text);
				// Non-text blocks contribute nothing: dropping them changes no byte.
				expect(resultText({ content: texts.map(t => ({ type: "text", text: t })) })).toBe(text);
				expect(text.length).toBe(texts.reduce((sum, t) => sum + t.length, 0));
				// Ordered concatenation, checked by scanning rather than joining.
				let at = 0;
				for (const t of texts) {
					expect(text.indexOf(t, at)).toBe(at);
					at += t.length;
				}
			}),
			{ numRuns: 300, seed: SEED },
		);
	});

	test("a string is itself, and a missing, non-string or non-array content is empty", () => {
		fc.assert(
			fc.property(
				fc.string({ unit: "binary" }),
				fc.oneof(fc.constant(undefined), fc.integer(), fc.constant(null), fc.record({ a: fc.integer() })),
				(text, content) => {
					expect(resultText(text)).toBe(text);
					expect(resultText({ content: text })).toBe(text);
					expect(resultText({ content: [{ type: "text", text }] })).toBe(text);
					expect(resultText({ content })).toBe("");
				},
			),
			{ numRuns: 300, seed: SEED },
		);
	});
});

/** Arbitrary text cut into the blocks a tool result may arrive in. */
const SPLIT_TEXT = fc
	.tuple(fc.string({ unit: "binary" }), fc.array(fc.nat({ max: 8 }), { maxLength: 4 }))
	.map(([text, cuts]) => {
		const points = [...new Set(cuts.map(cut => cut % (text.length + 1)))].sort((a, b) => a - b);
		const blocks: string[] = [];
		let at = 0;
		for (const point of [...points, text.length]) {
			const part = text.slice(at, point);
			if (part !== "") blocks.push(part);
			at = point;
		}
		return { text, blocks };
	});

describe("resultTextTail", () => {
	test("is the newest window of resultText, code-point aligned", () => {
		fc.assert(
			fc.property(SPLIT_TEXT, fc.integer({ min: 0, max: 60 }), ({ text, blocks }, cap) => {
				const content = blocks.map(t => ({ type: "text", text: t }));
				const full = resultText({ content });
				const tail = resultTextTail({ content }, cap);
				expect(full).toBe(text);
				expect(tail.length).toBeLessThanOrEqual(cap);
				if (cap >= full.length) {
					// Inside the cap the two helpers are interchangeable.
					expect(tail).toBe(full);
				} else {
					expect(full.endsWith(tail)).toBe(true);
					// A cut never leaves an orphan low surrogate at the front.
					if (tail.length > 0) expect(isLowSurrogate(tail.charCodeAt(0))).toBe(false);
				}
			}),
			{ numRuns: 400, seed: SEED },
		);
	});

	test("does not depend on how the text is split into blocks", () => {
		fc.assert(
			fc.property(SPLIT_TEXT, fc.integer({ min: 0, max: 60 }), ({ text, blocks }, cap) => {
				const blockTail = resultTextTail({ content: blocks.map(t => ({ type: "text", text: t })) }, cap);
				expect(blockTail).toBe(resultTextTail(text, cap));
				expect(blockTail).toBe(resultTextTail({ content: [{ type: "text", text }] }, cap));
			}),
			{ numRuns: 400, seed: SEED },
		);
	});

	test("a non-positive cap and junk shapes yield nothing", () => {
		fc.assert(
			fc.property(
				fc.oneof(fc.string({ unit: "binary" }), fc.constant(null), fc.integer()),
				fc.integer({ min: -50, max: 0 }),
				(result, cap) => {
					expect(resultTextTail(result, cap)).toBe("");
				},
			),
			{ numRuns: 200, seed: SEED },
		);
		fc.assert(
			fc.property(
				fc.oneof(fc.constant(undefined), fc.integer(), fc.constant(null), fc.record({ a: fc.integer() })),
				content => {
					expect(resultTextTail({ content }, 40)).toBe("");
				},
			),
			{ numRuns: 100, seed: SEED },
		);
	});
});
