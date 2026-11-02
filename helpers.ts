/**
 * helpers.ts — helpers for split-view.ts: examples in test/helpers.test.ts,
 * invariants over arbitrary input in test/properties.test.ts. The only runtime
 * import is the TUI's width primitives, which framed rows must match exactly.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme";

/** A non-null object; host payloads arrive untyped and every reader narrows
 * before touching a field. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** True if c is a UTF-16 high (lead) surrogate. */
export function isHighSurrogate(c: number): boolean {
	return c >= 0xd800 && c <= 0xdbff;
}

/** True if c is a UTF-16 low (trail) surrogate. */
export function isLowSurrogate(c: number): boolean {
	return c >= 0xdc00 && c <= 0xdfff;
}

const ANSI_ESCAPES =
	/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\t]/g;

/** Strip terminal escape sequences and other C0/C1 controls (newlines are
 * kept for line splitting) from model- or tool-supplied text before it can
 * reach a rendered row. Without this, a tool result or thinking delta
 * containing CSI/OSC would drive the user's terminal. */
export function sanitizeText(s: string): string {
	return s.replace(/\r\n?/g, "\n").replace(ANSI_ESCAPES, "").replace(CONTROL_CHARS, " ");
}

/** Collapse whitespace and cut to `max` UTF-16 units with an ellipsis,
 * never ending mid surrogate pair. */
export function truncateInline(s: string, max = 40): string {
	const flat = s.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	let end = max - 1;
	if (end >= 1 && isHighSurrogate(flat.charCodeAt(end - 1))) end--;
	return `${flat.slice(0, end)}…`;
}

/**
 * One framed row: left border, content clipped to `inner` cells, padded to
 * exactly `inner`, right border. `fill`/`left`/`right` swap the frame
 * characters so a titled rule and a plain body row come from one primitive.
 * The whole frame — borders and fill — is drawn in the theme's border colour,
 * which is what keeps `╭────╮` a border span rather than a bare rule.
 * Invariant: `visibleWidth(result) === inner + 2` for any content and
 * `inner >= 0`; content is clipped, never wrapped.
 */
export function framedRow(
	theme: Theme,
	inner: number,
	content: string,
	options?: { fill?: string; left?: string; right?: string },
): string {
	const fill = options?.fill ?? " ";
	const clipped = truncateToWidth(content, Math.max(0, inner));
	const pad = Math.max(0, inner - visibleWidth(clipped));
	// A space fill needs no colour of its own: wrapping it would only grow the
	// escape stream without changing a single cell.
	let padding = "";
	if (pad > 0) padding = fill === " " ? " ".repeat(pad) : theme.fg("border", fill.repeat(pad));
	return theme.fg("border", options?.left ?? "│") + clipped + padding + theme.fg("border", options?.right ?? "│");
}

/** Storage cap for one tool's text (args JSON or result output). */
export const MAX_TOOL_TEXT_CHARS = 32 * 1024;

/** Newest whole code points of `s` that fit in `budget` UTF-16 units: the
 * suffix never starts on an orphan low surrogate, and text within `budget` is
 * returned unchanged. Every "keep the newest part of a string" site goes through
 * it (the storage cap, the streamed tail, the display-line cap and the stream
 * tail), so those windows cannot drift apart. */
function newestUnits(s: string, budget: number): string {
	if (s.length <= budget) return s;
	const kept = s.slice(s.length - budget);
	return isLowSurrogate(kept.charCodeAt(0)) ? kept.slice(1) : kept;
}

/** Keep the NEWEST suffix within the cap, prefixed by a truncation marker;
 * the cut is code-point aligned. Text within the cap is unchanged. */
export function capToolText(s: string, cap = MAX_TOOL_TEXT_CHARS): string {
	if (s.length <= cap) return s;
	const marker = `[truncated: newest ${cap} of ${s.length} chars]\n`;
	// A marker longer than the cap would defeat the cap: drop it instead.
	if (marker.length >= cap) return newestUnits(s, cap);
	return marker + newestUnits(s, cap - marker.length);
}

/** Non-empty, whitespace-trimmed lines of `text` for a row preview. */
export function nonEmptyLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);
}

/** Text a tool reported, unsanitized and uncapped. Sanitization and the
 * character cap both live in `setToolOutput`, so the final result pays for one
 * pass instead of two, and the cap applies to what is stored — never to what
 * is counted. */
export function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!isRecord(result)) return "";
	const content = result.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const text: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		text.push(block.text);
	}
	return text.join("");
}

/** Newest `cap` units of a block list: one backwards pass that counts every
 * text block and keeps only the newest `cap` units, so a cumulative partial
 * costs O(blocks + cap) instead of O(its whole length). */
function tailBlocks(content: unknown[], cap: number): string {
	const kept: string[] = [];
	let total = 0;
	let need = cap;
	for (let i = content.length - 1; i >= 0; i--) {
		const block = content[i];
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		const text: string = block.text;
		// Counted even past `need`: the total is what says whether the kept
		// suffix is the whole text (and so must be returned untouched).
		total += text.length;
		if (need <= 0) continue;
		if (text.length > need) {
			kept.push(text.slice(-need));
			need = 0;
		} else {
			kept.push(text);
			need -= text.length;
		}
	}
	const joined = kept.reverse().join("");
	// Inside the cap this is byte-identical to `resultText`, even for text that
	// starts on a lone surrogate.
	if (total <= cap) return joined;
	// A block boundary can split a pair just as a slice can, so the check runs
	// on the joined suffix rather than on the per-block cut.
	return isLowSurrogate(joined.charCodeAt(0)) ? joined.slice(1) : joined;
}

/** The last `cap` UTF-16 units of what `resultText` would return, without
 * materializing the whole text: a streamed partial is cumulative, so joining it
 * to keep the newest window would cost O(stream) on every update. Within `cap`
 * this is byte-identical to `resultText`; past it the kept suffix never starts
 * on an orphan low surrogate (same rule as `capToolText`). */
export function resultTextTail(result: unknown, cap: number): string {
	if (cap <= 0) return "";
	if (typeof result === "string") return newestUnits(result, cap);
	if (!isRecord(result)) return "";
	const content = result.content;
	if (typeof content === "string") return newestUnits(content, cap);
	if (!Array.isArray(content)) return "";
	return tailBlocks(content, cap);
}

/** Display and storage cap for one edit diff: the first `maxLines` lines and at
 * most `maxChars` UTF-16 units, with a trailing marker naming the cut. */
export const MAX_DIFF_LINES = 400;
export const MAX_DIFF_CHARS = 64 * 1024;

/** Keep the HEAD of a diff within `maxLines`/`maxChars` (diffs are read from
 * the top, unlike tool output); the cut is code-point aligned and marked.
 * Text within both caps is returned unchanged. */
export function capDiffText(
	text: string,
	maxLines = MAX_DIFF_LINES,
	maxChars = MAX_DIFF_CHARS,
): string {
	let head = text;
	let hiddenChars = 0;
	if (head.length > maxChars) {
		let end = Math.max(0, maxChars);
		// Never end the head on a lone high surrogate; the marker reports the
		// units actually kept, not the requested budget.
		if (end > 0 && isHighSurrogate(head.charCodeAt(end - 1))) end--;
		hiddenChars = text.length - end;
		head = head.slice(0, end);
	}
	const lines = head.split("\n");
	if (lines.length <= maxLines && hiddenChars === 0) return text;
	const kept = lines.slice(0, maxLines);
	// One marker line, never counted against `maxLines`: a char cut is the
	// more informative of the two, so it wins when both caps bind.
	const marker = hiddenChars
		? `… [truncated: first ${head.length} of ${text.length} chars]`
		: `… +${lines.length - kept.length} more diff lines`;
	return `${kept.join("\n")}\n${marker}`;
}

/** Band split minimums (cols) below which the tools ratio clamps. */
export const MIN_THINK_COLS = 24;
export const MIN_TOOLS_COLS = 20;

/** Tools panel width (cols) for a band of `total` cols at `pct` percent,
 * with minimum clamps; falls back to the raw ratio when both minimums
 * cannot hold. */
export function bandToolsColsFor(total: number, pct: number): number {
	const raw = Math.round((total * pct) / 100);
	let toolsW = raw;
	let thinkW = total - toolsW;
	if (toolsW < MIN_TOOLS_COLS) {
		toolsW = MIN_TOOLS_COLS;
		thinkW = total - toolsW;
	}
	if (thinkW < MIN_THINK_COLS) {
		thinkW = MIN_THINK_COLS;
		toolsW = total - thinkW;
	}
	if (toolsW < MIN_TOOLS_COLS) toolsW = raw;
	return toolsW;
}

export const MIN_DOCK_COLS = 24;
/** Columns the transcript side keeps when the files panel is resized. */
export const DOCK_LEFT_RESERVE = 50;
/** Auto dock width: 25% of the terminal. The ceiling is a guard against absurd
 * widths, not a design target — it used to be 48, which left a 4K or ultrawide
 * terminal with a 48-col slot and ~350 unused columns beside it. */
export const AUTO_DOCK_PCT = 0.25;
export const AUTO_DOCK_MIN_COLS = 34;
export const AUTO_DOCK_MAX_COLS = 120;

/** Layout presets: `4k` is the taller, narrower curve; `wide` trades band rows
 * for columns, which is what a 21:9-or-wider pane actually has. */
export type GeometryMode = "4k" | "wide";

export interface GeometryProfile {
	/** Band height as a share of the terminal rows. */
	bandPct: number;
	/** Floor for the auto band height, in rows. */
	minBandRows: number;
	/** Files dock share of the terminal columns (auto width only). */
	dockPct: number;
	minDockCols: number;
	maxDockCols: number;
}

export const GEOMETRY_PROFILES: Readonly<Record<GeometryMode, GeometryProfile>> = {
	"4k": {
		bandPct: 0.45,
		minBandRows: 20,
		dockPct: AUTO_DOCK_PCT,
		minDockCols: AUTO_DOCK_MIN_COLS,
		maxDockCols: AUTO_DOCK_MAX_COLS,
	},
	wide: { bandPct: 0.35, minBandRows: 14, dockPct: 0.32, minDockCols: 40, maxDockCols: 200 },
};

/** Columns per row at which a pane counts as wide-screen. 21:9 (3440×1440 at a
 * normal font ≈ 430×40 cells) is ~10.8, 32:9 is ~12.5, 16:9 1440p is ~6 and a
 * 4K cell grid is ~4, so 8 separates ultrawide from both. */
export const AUTO_WIDE_ASPECT = 8;

/** Preset implied by the terminal shape; unknown/short geometry falls back to
 * `4k`, which is also the pre-switch behavior. */
export function autoGeometryMode(columns: number, rows: number): GeometryMode {
	return rows > 0 && columns / rows >= AUTO_WIDE_ASPECT ? "wide" : "4k";
}

/** Files panel width: auto = the profile's share of the terminal clamped to its
 * floor/ceiling, so the column keeps growing on wide terminals; a manual width
 * is clamped to [MIN_DOCK_COLS, cols - DOCK_LEFT_RESERVE]. */
export function dockColsFor(
	cols: number,
	manual: number | null = null,
	profile: GeometryProfile = GEOMETRY_PROFILES["4k"],
): number {
	if (manual === null) {
		const auto = Math.floor(cols * profile.dockPct);
		return Math.max(profile.minDockCols, Math.min(profile.maxDockCols, auto));
	}
	const max = Math.max(MIN_DOCK_COLS, cols - DOCK_LEFT_RESERVE);
	return Math.max(MIN_DOCK_COLS, Math.min(max, Math.trunc(manual)));
}

export const MIN_BAND_HEIGHT = 6;
/** Ceiling for the band: tall terminals (4K, portrait, large-font splits) may
 * spend far more than the old 40-row cap on the panels. */
export const MAX_BAND_HEIGHT = 80;
/** Rows the transcript + editor keep; a band that would eat into them hides. */
export const MIN_ROWS_BELOW_BAND = 18;

/** Startup band height for a terminal of `rows`: the profile's share of the
 * height, never below its row floor and never above MAX_BAND_HEIGHT. Evaluated
 * only when the saved config has no explicit height, so a chosen height is
 * never overridden: `4k` gives 45 rows -> 20 (the old default), 100 -> 45,
 * 200 -> 80; `wide` gives 40 -> 14, 100 -> 35, 600 -> 80. */
export function defaultBandHeight(
	rows: number,
	profile: GeometryProfile = GEOMETRY_PROFILES["4k"],
): number {
	return Math.max(profile.minBandRows, Math.min(MAX_BAND_HEIGHT, Math.floor(rows * profile.bandPct)));
}

/** Tallest band that still leaves MIN_ROWS_BELOW_BAND for the transcript and
 * editor on a terminal of `rows`; used to clamp an explicit `/split-height` so
 * a request cannot make the band silently invisible. */
export function maxBandHeight(rows: number): number {
	return Math.max(MIN_BAND_HEIGHT, Math.min(MAX_BAND_HEIGHT, rows - MIN_ROWS_BELOW_BAND));
}

/** Compact duration: 0.4s · 2.3s · 42s · 3m05s · 1h02m. `live` drops the
 * sub-second digit so a running counter ticks once per second. */
export function formatDuration(ms: number, live = false): string {
	const t = Math.max(0, ms);
	if (t < 10_000 && !live) return `${(Math.floor(t / 100) / 10).toFixed(1)}s`;
	const s = Math.floor(t / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Append a streamed delta to a newline-free tail, moving completed lines
 * into `lines` (mutated). Lines are split BEFORE the tail is capped, so a
 * large delta never loses complete lines. When the tail exceeds `maxTail` it
 * drops its older half (code-point aligned) in one step instead of sliding by
 * a few chars per delta — a sliding cut would re-flow every wrapped row of
 * the visible paragraph on each flush. Returns the new tail.
 */
export function appendStreamTail(
	lines: string[],
	tail: string,
	delta: string,
	maxTail: number,
): string {
	let t = tail + delta;
	let nl = t.indexOf("\n");
	while (nl !== -1) {
		const seg = t.slice(0, nl);
		lines.push(seg.endsWith("\r") ? seg.slice(0, -1) : seg);
		t = t.slice(nl + 1);
		nl = t.indexOf("\n");
	}
	if (t.length > maxTail) t = newestUnits(t, Math.floor(maxTail / 2));
	return t;
}

/** Cap one display line to its newest `max` UTF-16 units ("… " prefix). */
export function capDisplayLine(line: string, max: number): string {
	if (line.length <= max) return line;
	return `… ${newestUnits(line, max - 2)}`;
}

/** One inline-image block of a tool result (base64 data + MIME type). */
export interface ImageBlock {
	data: string;
	mimeType: string;
}

/** The LAST image block of a tool result's content, if any. Content is
 * either a plain string or an array of blocks; only well-formed image blocks
 * (string `data` + `mimeType`) count. Keeping the last one matches how the
 * transcript renders results (one image per `read`; rare multi-image results
 * keep the most recent). */
export function lastImageBlock(content: unknown): ImageBlock | undefined {
	if (!Array.isArray(content)) return undefined;
	for (let i = content.length - 1; i >= 0; i--) {
		const c = content[i] as { type?: string; data?: unknown; mimeType?: unknown };
		if (c?.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string")
			return { data: c.data, mimeType: c.mimeType };
	}
	return undefined;
}

/** Which transcript content omp should hide for the current panel layout. */
export interface TranscriptVisibility {
	hideThinking: boolean;
	hideTools: boolean;
}

/**
 * A visible thinking panel owns the reasoning stream, so the transcript must
 * not repeat it. `panelVisible` is false on terminals too short for the band
 * — then the transcript keeps its thinking, otherwise nothing would show it.
 * Response-only hides thinking and tool activity regardless of the band.
 */
export function transcriptVisibility(
	thinkingPanel: boolean,
	responseOnly: boolean,
	panelVisible: boolean,
): TranscriptVisibility {
	return {
		hideThinking: responseOnly || (thinkingPanel && panelVisible),
		hideTools: responseOnly,
	};
}

/**
 * omp auto-discovers every *.ts in an extensions dir; a file without a
 * factory export is reported as a load error, so expose a no-op one here.
 */
export default function (_pi: ExtensionAPI) {
	/* shared helper module, not a real extension */
}
