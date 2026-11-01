import { describe, expect, test } from "bun:test";
import {
	MAX_BAND_HEIGHT,
	MAX_DIFF_CHARS,
	MAX_DIFF_LINES,
	MIN_BAND_HEIGHT,
	appendStreamTail,
	bandToolsColsFor,
	capDiffText,
	capDisplayLine,
	capToolText,
	defaultBandHeight,
	dockColsFor,
	formatDuration,
	isHighSurrogate,
	lastImageBlock,
	maxBandHeight,
	outputPreview,
	transcriptVisibility,
	truncateInline,
} from "../helpers.ts";
import { normalizeConfig } from "../ui-panels-config.ts";

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
	test("default follows the terminal, pinned at the classic 20 on a 45-row screen", () => {
		expect(defaultBandHeight(45)).toBe(20); // unchanged for existing users
		expect(defaultBandHeight(40)).toBe(20); // floor wins on short terminals
		expect(defaultBandHeight(60)).toBe(27);
		expect(defaultBandHeight(100)).toBe(45); // 4K: a third of the screen
		expect(defaultBandHeight(200)).toBe(MAX_BAND_HEIGHT); // ceiling
	});

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

describe("capDisplayLine", () => {
	test("keeps the newest chars with an ellipsis", () => {
		expect(capDisplayLine("short", 10)).toBe("short");
		expect(capDisplayLine("0123456789abc", 8)).toBe("… 789abc");
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
	test("returns the last well-formed image block", () => {
		expect(lastImageBlock("plain text")).toBeUndefined();
		expect(lastImageBlock(undefined)).toBeUndefined();
		expect(lastImageBlock({})).toBeUndefined();
		expect(lastImageBlock([{ type: "text", text: "hi" }])).toBeUndefined();
		expect(
			lastImageBlock([
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: "aGk=", mimeType: "image/png" },
			]),
		).toEqual({ data: "aGk=", mimeType: "image/png" });
		expect(
			lastImageBlock([
				{ type: "image", data: "aGk=" },
				{ type: "image", mimeType: "image/png" },
			]),
		).toBeUndefined();
		expect(
			lastImageBlock([
				{ type: "image", data: "MQ==", mimeType: "image/png" },
				{ type: "image", data: "Mg==", mimeType: "image/jpeg" },
			]),
		).toEqual({ data: "Mg==", mimeType: "image/jpeg" });
	});
});

describe("transcriptVisibility", () => {
	test("a visible thinking panel owns the reasoning stream", () => {
		expect(transcriptVisibility(true, false, true)).toEqual({ hideThinking: true, hideTools: false });
		expect(transcriptVisibility(false, false, true)).toEqual({ hideThinking: false, hideTools: false });
	});
	test("a hidden band returns thinking to the transcript", () => {
		expect(transcriptVisibility(true, false, false)).toEqual({ hideThinking: false, hideTools: false });
	});
	test("response-only hides thinking and tool activity regardless of the band", () => {
		expect(transcriptVisibility(true, true, false)).toEqual({ hideThinking: true, hideTools: true });
		expect(transcriptVisibility(false, true, true)).toEqual({ hideThinking: true, hideTools: true });
	});
});

describe("outputPreview", () => {
	test("shows the first `cap` lines and counts the hidden rest", () => {
		expect(outputPreview([], 2)).toEqual({ shown: [], hidden: 0 });
		expect(outputPreview(["a", "b"], 2)).toEqual({ shown: ["a", "b"], hidden: 0 });
		expect(outputPreview(["a", "b", "c"], 2)).toEqual({ shown: ["a", "b"], hidden: 1 });
		expect(outputPreview(["a", "b"], 0)).toEqual({ shown: [], hidden: 2 });
		expect(outputPreview(["a"], 20)).toEqual({ shown: ["a"], hidden: 0 });
	});
});
