import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import {
	MAX_BAND_HEIGHT,
	MAX_DIFF_CHARS,
	MAX_DIFF_LINES,
	MIN_BAND_HEIGHT,
	appendStreamTail,
	bandToolsColsFor,
	capDiffText,
	capToolText,
	dockColsFor,
	formatDuration,
	framedRow,
	isHighSurrogate,
	lastImageBlock,
	maxBandHeight,
	nonEmptyLines,
	resultText,
	resultTextTail,
	sanitizeText,
	truncateInline,
	withoutLiveThinking,
} from "../helpers.ts";
import { normalizeConfig } from "../ui-panels-config.ts";

/** Identity colorizer: a framed row's geometry is measurable without a theme. */
const flat = { fg: (_color: string, text: string) => text } as unknown as Theme;

describe("truncateInline", () => {
	test("collapses whitespace and never splits a surrogate pair", () => {
		expect(truncateInline("  a\n  b\tc  ")).toBe("a b c");
		expect(truncateInline("abcdefghij", 5)).toBe("abcd…");
		// The cut would land between the emoji's surrogates → drop it.
		expect(truncateInline("abc😀defgh", 5)).toBe("abc…");
	});
});

describe("capToolText", () => {
	test("keeps the newest suffix with a marker, within the cap", () => {
		expect(capToolText("short", 100)).toBe("short");
		const input = `${"x".repeat(500)}TAIL`;
		const out = capToolText(input, 100);
		expect(out.length).toBeLessThanOrEqual(100);
		expect(out.startsWith("[truncated: newest 100 of 504 chars]\n")).toBe(true);
		expect(out.endsWith("TAIL")).toBe(true);
	});
	test("never starts the kept suffix on a lone low surrogate", () => {
		const kept = capToolText("😀".repeat(200), 101).split("\n")[1];
		expect(kept.length % 2).toBe(0);
		expect(kept.startsWith("😀")).toBe(true);
	});
});

describe("framedRow", () => {
	test("pads every row to its inner width and clips long content", () => {
		for (const inner of [1, 3, 6, 12, 40]) {
			for (const content of ["", "x", "a".repeat(80), "📂 Files (12)"]) {
				const row = framedRow(flat, inner, content);
				expect({ inner, content, width: visibleWidth(row) }).toEqual({ inner, content, width: inner + 2 });
				expect(visibleWidth(row.slice(1, -1))).toBe(inner);
			}
		}
	});

	test("a dash fill produces a titled rule", () => {
		expect(framedRow(flat, 14, " Last Edit ", { fill: "─" })).toBe("│ Last Edit ───│");
		expect(framedRow(flat, 6, "", { fill: "─", left: "├", right: "┤" })).toBe("├──────┤");
		// A title wider than the frame is clipped, never pushed past it.
		const clipped = framedRow(flat, 6, "a very long title", { fill: "─" });
		expect(visibleWidth(clipped)).toBe(8);
		expect(clipped.endsWith("│")).toBe(true);
		expect(clipped).not.toContain("title");
	});

	test("the fill carries the border colour, like the borders it joins", () => {
		const themed = {
			fg: (color: string, text: string) => (color === "border" ? `<${text}>` : text),
		} as unknown as Theme;
		// A bare `─` run would leave the rule uncoloured with a real theme.
		expect(framedRow(themed, 6, "", { fill: "─", left: "├", right: "┤" })).toBe("<├><──────><┤>");
		// The default space fill stays coloured-free (no escape growth per row).
		expect(framedRow(themed, 4, "x")).toBe("<│>x   <│>");
		expect(framedRow(themed, 0, "")).toBe("<│><│>");
	});
});

describe("nonEmptyLines", () => {
	test("trims lines, drops blank and whitespace-only ones", () => {
		expect(nonEmptyLines("a\r\nb\r\nc\n\n \t \n d ")).toEqual(["a", "b", "c", "d"]);
		// The ingest path sanitizes first, so a lone CR is already a break.
		expect(nonEmptyLines(sanitizeText("\u001b[31ma\u001b[0m\r\n\tb\r\u001b[2mc\u001b[0m"))).toEqual([
			"a",
			"b",
			"c",
		]);
	});
});

describe("resultText", () => {
	test("reads a string, a text block list, and nothing else", () => {
		expect(resultText("plain")).toBe("plain");
		expect(resultText({ content: "x" })).toBe("x");
		expect(
			resultText({
				content: [
					{ type: "text", text: "a" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
					{ type: "toolCall", id: "t" },
					{ type: "text", text: "b" },
				],
			}),
		).toBe("ab");
		expect(resultText({ content: 42 })).toBe("");
		expect(resultText(undefined)).toBe("");
	});
});

describe("resultTextTail", () => {
	test("equals the full text inside the cap and keeps a whole code point past it", () => {
		expect(resultTextTail("short", 40)).toBe("short");
		const blocks = { content: [{ type: "text", text: "ab" }, { type: "text", text: "cd" }] };
		expect(resultTextTail(blocks, 40)).toBe("abcd");
		expect(resultTextTail(blocks, 3)).toBe("bcd");
		expect(resultTextTail({}, 10)).toBe("");
		expect(resultTextTail({ content: 7 }, 10)).toBe("");
		expect(resultTextTail("abc", 0)).toBe("");

		// An odd cap lands between the emoji's surrogates: drop the orphan.
		const kept = resultTextTail("😀".repeat(20), 11);
		expect(kept.length).toBe(10);
		expect(kept.startsWith("😀")).toBe(true);
		// Same rule when the cut happens inside a text block, not a plain string.
		const blocksKept = resultTextTail({ content: [{ type: "text", text: "😀".repeat(20) }] }, 11);
		expect(blocksKept.length).toBe(10);
		expect(blocksKept.startsWith("😀")).toBe(true);
		// Inside the cap nothing changes at all.
		expect(resultTextTail({ content: [{ type: "text", text: "😀".repeat(20) }] }, 40)).toBe("😀".repeat(20));
		// A cut that lands on a code-point boundary drops nothing.
		expect(resultTextTail({ content: [{ type: "text", text: "ab" }, { type: "text", text: "😀" }] }, 2)).toBe("😀");
	});
});

describe("capDiffText", () => {
	test("text within both caps is returned unchanged", () => {
		const diff = "@@ -1 +1 @@\n-old\n+new";
		expect(capDiffText(diff)).toBe(diff);
		// Exactly at the line cap: no marker, no copy.
		const atCap = Array.from({ length: MAX_DIFF_LINES }, (_, i) => `+line ${i}`).join("\n");
		expect(capDiffText(atCap)).toBe(atCap);
	});

	test("keeps the head lines and counts the rest", () => {
		const lines = Array.from({ length: 500 }, (_, i) => `+line ${i}`);
		const out = capDiffText(lines.join("\n")).split("\n");
		expect(out.length).toBe(MAX_DIFF_LINES + 1);
		expect(out[0]).toBe("+line 0");
		expect(out[MAX_DIFF_LINES - 1]).toBe(`+line ${MAX_DIFF_LINES - 1}`);
		expect(out[MAX_DIFF_LINES]).toBe(`… +${500 - MAX_DIFF_LINES} more diff lines`);
	});

	test("keeps the head chars and marks the char cut", () => {
		const out = capDiffText("x".repeat(MAX_DIFF_CHARS * 2));
		expect(out.length).toBeLessThanOrEqual(MAX_DIFF_CHARS + 64);
		const lines = out.split("\n");
		expect(lines.length).toBe(2);
		expect(lines[0].length).toBe(MAX_DIFF_CHARS);
		expect(lines[1]).toContain("[truncated: first");
		expect(lines[1]).toContain(`of ${MAX_DIFF_CHARS * 2} chars`);
	});

	test("never cuts through a surrogate pair", () => {
		// Odd budget: the cap lands between the emoji's surrogates.
		const out = capDiffText("😀".repeat(MAX_DIFF_CHARS), MAX_DIFF_LINES, 101);
		const kept = out.split("\n")[0];
		expect(kept.length % 2).toBe(0);
		expect(kept.startsWith("😀")).toBe(true);
		expect(isHighSurrogate(kept.charCodeAt(kept.length - 1))).toBe(false);
	});
});

describe("bandToolsColsFor", () => {
	test("applies the ratio and minimum clamps", () => {
		expect(bandToolsColsFor(200, 35)).toBe(70);
		expect(bandToolsColsFor(60, 20)).toBe(20);
		expect(bandToolsColsFor(50, 60)).toBe(26);
		expect(bandToolsColsFor(30, 50)).toBe(15);
	});
});

describe("dockColsFor", () => {
	test("auto tracks 25% of the terminal up to a 120-col guard", () => {
		// Narrow: the 34-col floor keeps the frame and one word per row.
		expect(dockColsFor(100)).toBe(34);
		expect(dockColsFor(120)).toBe(34); // floor(30) < 34
		expect(dockColsFor(160)).toBe(40);
		// Wide: the dock keeps growing instead of stopping at the old 48.
		expect(dockColsFor(240)).toBe(60);
		expect(dockColsFor(400)).toBe(100); // 4K terminal, ~400 cols
		expect(dockColsFor(480)).toBe(120);
		expect(dockColsFor(600)).toBe(120); // guard, not a target
	});

	test("manual width is clamped to the terminal, not to the auto ceiling", () => {
		expect(dockColsFor(160, 70)).toBe(70);
		expect(dockColsFor(160, 10)).toBe(24);
		expect(dockColsFor(160, 150)).toBe(110);
		// Above the auto guard: an explicit choice wins up to cols - reserve.
		expect(dockColsFor(400, 180)).toBe(180);
		expect(dockColsFor(400, 999)).toBe(350);
	});
});

describe("band height scaling", () => {
	test("max keeps the transcript and editor their rows", () => {
		expect(maxBandHeight(20)).toBe(MIN_BAND_HEIGHT); // 20 - 18 = 2 → floor
		expect(maxBandHeight(24)).toBe(6);
		expect(maxBandHeight(45)).toBe(27);
		expect(maxBandHeight(60)).toBe(42);
		expect(maxBandHeight(100)).toBe(80);
		expect(maxBandHeight(400)).toBe(80); // ceiling still applies
	});
});

describe("formatDuration", () => {
	test("compact units", () => {
		expect(formatDuration(420)).toBe("0.4s");
		expect(formatDuration(2345)).toBe("2.3s");
		expect(formatDuration(42_900)).toBe("42s");
		expect(formatDuration(185_000)).toBe("3m05s");
		expect(formatDuration(3_720_000)).toBe("1h02m");
		expect(formatDuration(2345, true)).toBe("2s");
		expect(formatDuration(-5)).toBe("0.0s");
	});
});

describe("appendStreamTail", () => {
	test("splits lines before capping (no lost lines)", () => {
		const lines: string[] = [];
		let tail = appendStreamTail(lines, "", "ab", 10);
		tail = appendStreamTail(lines, tail, `c\r\nline2\n${"y".repeat(30)}\nend`, 10);
		expect(lines).toEqual(["abc", "line2", "y".repeat(30)]);
		expect(tail).toBe("end");
	});
	test("drops the older half on overflow, not a sliding window", () => {
		const lines: string[] = [];
		let tail = "";
		const lengths = new Set<number>();
		for (let i = 0; i < 100; i++) {
			tail = appendStreamTail(lines, tail, "abcdefghij", 40);
			lengths.add(tail.length);
			expect(tail.length).toBeLessThanOrEqual(40);
		}
		expect(lines.length).toBe(0);
		expect(lengths.has(30)).toBe(true);
		expect(lengths.has(40)).toBe(true);
	});
});

describe("normalizeConfig", () => {
	test("filesWidth is a validated optional number", () => {
		expect(normalizeConfig({}).filesWidth).toBeNull();
		expect(normalizeConfig({ filesWidth: 60 }).filesWidth).toBe(60);
		expect(normalizeConfig({ filesWidth: 10 }).filesWidth).toBeNull();
		expect(normalizeConfig({ filesWidth: "60" as never }).filesWidth).toBeNull();
		expect(normalizeConfig({ filesWidth: 999 }).filesWidth).toBe(200);
		expect(normalizeConfig(null as never).bandHeight).toBe(20);
	});
	test("bandHeight clamps to the documented bounds", () => {
		expect(normalizeConfig({ bandHeight: 5 }).bandHeight).toBe(MIN_BAND_HEIGHT);
		expect(normalizeConfig({ bandHeight: 200 }).bandHeight).toBe(MAX_BAND_HEIGHT);
		// Inside the bounds the saved height is kept verbatim.
		expect(normalizeConfig({ bandHeight: 42 }).bandHeight).toBe(42);
	});
	test("geometry is a strict literal with auto as the default", () => {
		expect(normalizeConfig({}).geometry).toBe("auto");
		expect(normalizeConfig({ geometry: "4k" }).geometry).toBe("4k");
		expect(normalizeConfig({ geometry: "wide" }).geometry).toBe("wide");
		expect(normalizeConfig({ geometry: "auto" }).geometry).toBe("auto");
		// Garbage never becomes a preset: the aspect ratio decides instead.
		expect(normalizeConfig({ geometry: "WIDE" as never }).geometry).toBe("auto");
		expect(normalizeConfig({ geometry: 4 as never }).geometry).toBe("auto");
	});
	test("panel defaults", () => {
		const cfg = normalizeConfig({ split: true });
		expect(cfg.thinking).toBe(true);
		expect(cfg.tools).toBe(true);
		expect(cfg.files).toBe(false);
		expect(cfg.diff).toBe(true);
		expect(cfg.toolMode).toBe("compact");
		expect(normalizeConfig({ split: false, thinking: true }).thinking).toBe(false);
	});
});

describe("lastImageBlock", () => {
	test("rejects non-array input", () => {
		expect(lastImageBlock("plain text")).toBeUndefined();
		expect(lastImageBlock(undefined)).toBeUndefined();
		expect(lastImageBlock({})).toBeUndefined();
	});
});

describe("withoutLiveThinking", () => {
	test("drops only the live thinking section from the root's children", () => {
		const text = { k: "md", p: { text: "answer" }, key: "t0" } as unknown as NativeNode;
		const head = { k: "section", p: { role: "omp.thinking.live" }, key: "k0" } as unknown as NativeNode;
		const root = { k: "col", p: { role: "omp.assistant" }, c: [text, head] } as unknown as NativeNode;
		const filtered = withoutLiveThinking(root);
		expect(filtered).not.toBe(root);
		expect(filtered.c).toEqual([text]);
	});

	test("returns the same node when nothing matches", () => {
		const root = {
			k: "col",
			p: { role: "omp.assistant" },
			c: [{ k: "md", p: { text: "answer" } }],
		} as unknown as NativeNode;
		expect(withoutLiveThinking(root)).toBe(root);
	});
});
