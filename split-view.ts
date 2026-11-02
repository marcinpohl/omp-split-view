/**
 * split-view.ts — omp split-view extension
 *
 * Port of pi-split-view (https://github.com/Hugo-W/pi-split-view) to
 * oh-my-pi's TUI. Same feature set, rebuilt on the surfaces omp actually
 * exposes:
 *
 *   thinking panel   live reasoning stream, newest-window view; while it is
 *                    visible the transcript hides thinking blocks, so
 *                    reasoning is never shown twice
 *   tool usage panel every tool call, status, duration, output preview
 *   files panel      touched files + edit diff, alongside the other panels
 *   response-only    hides thinking blocks and tool activity through omp's
 *                    own display settings (see /split-trim-response)
 *
 * Mount point: ONE widget above the editor.
 *
 *   ctx.ui.setWidget(key, factory, { placement: "aboveEditor" })
 *
 * The composer renders it full-width just above the editor. The component
 * composes the enabled columns side by side — thinking | tools | files —
 * by direct row composition (omp has no fullscreen layout root to wrap, and
 * its Stack/Row components are not needed for a fixed-height band). It is
 * the same region omp's own HUD widgets use, so it never overlaps the
 * editor or the transcript.
 *
 * omp's transcript is inline (history + viewport), not a layout tree, so this
 * port deliberately differs from the pi original:
 *   - the band sits above the editor instead of above the transcript;
 *   - the files panel is a band column, not a right dock spanning the
 *     transcript (an overlay would cover the band and editor, because omp
 *     composites overlays over the whole viewport);
 *   - mouse drag-resize / header buttons are not wired (widgets receive no
 *     pointer events in omp); geometry commands replace them;
 *   - response-only reuses omp's native hide-thinking / hide-tool-activity
 *     switches instead of an extension-owned ScrollView, so the original's
 *     answer divider and scroll-offset plumbing do not apply;
 *   - a visible thinking panel applies the same hide-thinking switch, which
 *     the pi original did not do (it kept both copies of the stream).
 *
 * Commands:
 *   /split                      full toggle pair: OFF = all panels off,
 *                               ON = the layout saved by /split-save
 *   /split-thinking             toggle the thinking panel within the band
 *   /split-tools                toggle the tools panel within the band
 *   /files                      toggle the files panel within the band
 *   /split-tools-view           compact <-> full tool detail
 *   /split-tools-width <pct>    tools share of the band width (20-60)
 *   /split-height <n>           band height in rows (6-80, clamped to fit)
 *   /split-diff                 toggle the files edit-diff subpanel
 *   /split-trim-response        full transcript <-> response-only
 *   /split-save                 persist the current layout as startup defaults
 */

import type { Component, TUI } from "@oh-my-pi/pi-tui";
import {
	getImageDimensions,
	imageFallback,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { renderDiff } from "@oh-my-pi/pi-tui/chrome/diff";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	GEOMETRY_PROFILES,
	MAX_BAND_HEIGHT,
	MIN_BAND_HEIGHT,
	MIN_DOCK_COLS,
	MIN_ROWS_BELOW_BAND,
	appendStreamTail,
	autoGeometryMode,
	bandToolsColsFor,
	capDiffText,
	capDisplayLine,
	capToolText,
	defaultBandHeight,
	dockColsFor,
	formatDuration,
	lastImageBlock,
	maxBandHeight,
	sanitizeText,
	transcriptVisibility,
	truncateInline,
	type GeometryMode,
	type ImageBlock,
	type TranscriptVisibility,
} from "./helpers.ts";
import {
	CONFIG_FILE,
	loadUiPanelsConfig,
	normalizeConfig,
	saveUiPanelsConfig,
	type GeometrySetting,
	type NormalizedUiPanelsConfig,
	type ToolMode,
	type UiPanelsConfig,
} from "./ui-panels-config.ts";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

const WIDGET_KEY = "split-view";
const MAX_TOOLS = 60;
const MAX_LINES = 400;
const MAX_TAIL_CHARS = 16000;
const MAX_FILES = 500;
const MIN_TERM_WIDTH = 90;
const MAX_TOOL_OUTPUT_LINES = 20;
const MAX_TOOL_DIFF_LINES = 150;
const MAX_BODY_ROWS = 400;
const MAX_LINE_CHARS = MAX_TAIL_CHARS;
const THINK_RAF_MS = 50;
const TOOLS_FLUSH_MS = 100;

type PanelId = "thinking" | "tools" | "files";

const EMPTY: readonly string[] = [];
const LEGEND = "r read · w write · s seen(bash)";

// ─── module-lifetime state ───────────────────────────────────────────────────

let tuiRef: TUI | null = null;
let widgetMounted = false;
let themeGetter: () => Theme = () => {
	throw new Error("split-view: theme not bound yet");
};
let notifyFn: ((message: string, level: "info" | "warning" | "error") => void) | null = null;
let api: ExtensionAPI | null = null;
let sessionCwd = process.cwd();

let thinkingOn = true;
let toolsOn = true;
let filesOn = false;
let showDiff = true;
let toolMode: ToolMode = "compact";
let trimResponse = false;
let bandHeight = 20;
/** No explicit band height: re-derive it from the current preset at every
 * mount and on every preset switch, instead of pinning the default on a 4K —
 * or an ultrawide — display. `/split-height` pins it and clears this. */
let bandHeightAuto = true;
let toolsWidthPct = 35;
let filesWidth: number | null = null;
/** Persisted preset choice; `auto` derives it from the terminal aspect. */
let geometrySetting: GeometrySetting = "auto";
/** Preset in force for this session (resolved from `geometrySetting`). */
let geometryMode: GeometryMode = "4k";

// ─── advisor status line ─────────────────────────────────────────────────────

// Advisor mode delivers batched notes as `custom` messages (customType
// "advisor") that omp already renders as a full-width transcript card. The
// card is the content; this one-line status only keeps the tally visible once
// the card scrolls away, so it costs no band column and repeats no prose.
const ADVISOR_STATUS_KEY = "split-view.advisor";

interface AdvisorTally {
	blocker: number;
	concern: number;
	nit: number;
	note: number;
}

const advisorTally: AdvisorTally = { blocker: 0, concern: 0, nit: 0, note: 0 };

function resetAdvisorTally(): void {
	advisorTally.blocker = 0;
	advisorTally.concern = 0;
	advisorTally.nit = 0;
	advisorTally.note = 0;
}

/** The advisor card carries its notes in `details.notes`; severity is optional. */
function addAdvisorNotes(details: unknown): void {
	if (!isRecord(details) || !Array.isArray(details.notes)) return;
	for (const note of details.notes) {
		if (!isRecord(note)) continue;
		const severity = note.severity;
		if (severity === "blocker" || severity === "concern" || severity === "nit") advisorTally[severity]++;
		else advisorTally.note++;
	}
}

function advisorStatusText(): string | undefined {
	const parts: string[] = [];
	const push = (count: number, one: string, many: string): void => {
		if (count > 0) parts.push(`${count} ${count === 1 ? one : many}`);
	};
	push(advisorTally.blocker, "blocker", "blockers");
	push(advisorTally.concern, "concern", "concerns");
	push(advisorTally.nit, "nit", "nits");
	push(advisorTally.note, "note", "notes");
	return parts.length > 0 ? `Advisor: ${parts.join(" · ")}` : undefined;
}

/** Details of a delivered advisor card, or undefined for any other message. */
function advisorNoteDetails(message: unknown): { details: unknown } | undefined {
	if (!isRecord(message) || message.role !== "custom" || message.customType !== "advisor") return undefined;
	return { details: message.details };
}

/** A prompt the user typed: not a synthetic continuation, not advisor steering.
 * Shared by live delivery and branch replay so both read the same turn boundary. */
function isUserPrompt(message: unknown): boolean {
	if (!isRecord(message) || message.role !== "user") return false;
	return message.synthetic !== true && message.attribution !== "agent";
}

function syncAdvisorStatus(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	// The tally belongs to the band: with every panel off the extension is
	// hidden, so leaving its status line up would be stale chrome.
	const visible = thinkingOn || toolsOn || filesOn;
	try {
		ctx.ui.setStatus(ADVISOR_STATUS_KEY, visible ? advisorStatusText() : undefined);
	} catch {
		/* the status line is decorative: never break an event handler */
	}
}

/** Advisor tool calls reach extension `tool_call`/`tool_result` hooks with a
 * `sub` identity; the band renders the session the user watches, so only the
 * top-level agent may feed it. Missing identity (older host) is treated as main. */
const isMainAgent = (ctx: ExtensionContext): boolean => ctx.agent?.kind !== "sub";

// ─── thinking buffer ─────────────────────────────────────────────────────────

interface ThinkingBlock {
	lines: string[];
	tail: string;
}

let thinkFlushTimer: NodeJS.Timeout | null = null;
let thinkDirty = false;

function requestRender(): void {
	try {
		tuiRef?.requestRender();
	} catch {
		/* render scheduling must never break an event handler */
	}
}

function notify(message: string, level: "info" | "warning" | "error" = "info"): void {
	try {
		notifyFn?.(message, level);
	} catch {
		/* ignore */
	}
}

function flushThinking(): void {
	thinkFlushTimer = null;
	if (!thinkDirty) return;
	thinkDirty = false;
	thinking.version++;
	requestRender();
}

const thinking = {
	blocks: [] as ThinkingBlock[],
	current: null as ThinkingBlock | null,
	streaming: false,
	version: 0,
	start() {
		if (this.current && (this.current.lines.length || this.current.tail)) {
			this.blocks.push(this.current);
		}
		this.current = { lines: [], tail: "" };
		this.streaming = true;
		this.version++;
	},
	append(delta: string) {
		if (!this.current) this.current = { lines: [], tail: "" };
		const before = this.current.lines.length;
		this.current.tail = appendStreamTail(
			this.current.lines,
			this.current.tail,
			sanitizeText(delta),
			MAX_TAIL_CHARS,
		);
		if (this.current.lines.length !== before) this.trim();
		thinkDirty = true;
		if (!thinkFlushTimer) thinkFlushTimer = setTimeout(flushThinking, THINK_RAF_MS);
	},
	end(text: string) {
		if (thinkFlushTimer) {
			clearTimeout(thinkFlushTimer);
			thinkFlushTimer = null;
		}
		thinkDirty = false;
		if (this.current) {
			if (text) {
				// Authoritative final content replaces the streamed buffer.
				this.current.lines = sanitizeText(text).split("\n");
				this.current.tail = "";
			} else if (this.current.tail) {
				this.current.lines.push(this.current.tail);
				this.current.tail = "";
			}
			// Same guard as start(): an empty start/end pair must not leave a
			// block that no row ever consumes but the session keeps forever.
			if (this.current.lines.length || this.current.tail) this.blocks.push(this.current);
			this.current = null;
			this.trim();
		}
		this.streaming = false;
		this.version++;
	},
	trim() {
		// Hard-bound the display buffer, splicing into the oldest block so a
		// giant block trims instead of vanishing.
		let total = 0;
		for (const b of this.blocks) total += b.lines.length;
		if (this.current) total += this.current.lines.length;
		let excess = total - MAX_LINES;
		while (excess > 0) {
			const b = this.blocks[0];
			if (!b) {
				if (this.current)
					this.current.lines.splice(0, Math.min(excess, this.current.lines.length));
				break;
			}
			if (b.lines.length <= excess) {
				this.blocks.shift();
				excess -= b.lines.length;
			} else {
				b.lines.splice(0, excess);
				break;
			}
		}
	},
	reset() {
		if (thinkFlushTimer) {
			clearTimeout(thinkFlushTimer);
			thinkFlushTimer = null;
		}
		thinkDirty = false;
		this.blocks = [];
		this.current = null;
		this.streaming = false;
		this.version++;
	},
};

/** Test seam: blocks retained for rendering (empty blocks must not count). */
export function retainedThinkingBlocks(): number {
	return thinking.blocks.length + (thinking.current ? 1 : 0);
}

/** Raw thinking lines, oldest first, blocks separated by a blank line. */
function thinkingLines(): string[] {
	const out: string[] = [];
	for (const b of thinking.blocks) {
		if (out.length) out.push("");
		out.push(...b.lines);
	}
	if (thinking.current) {
		if (out.length) out.push("");
		out.push(...thinking.current.lines);
		if (thinking.current.tail) out.push(thinking.current.tail);
	}
	return out;
}

// ─── tool buffer ─────────────────────────────────────────────────────────────

interface ToolEntry {
	id: string;
	name: string;
	args: string;
	output: string;
	active: boolean;
	isError: boolean;
	/** Render-ready one-line description, computed once at ingest so the
	 * base64 payload is not retained (an 8 MB result used to live in the
	 * entry for the whole session while only this label was ever shown). */
	imageLabel?: string;
	/** Full non-empty line count seen for the output; the display keeps only
	 * a tail window, so this is what the "+N earlier" marker reports. */
	outputLineCount?: number;
	diff?: string;
	startedAt?: number;
	endedAt?: number;
}

let toolsVersionCounter = 0;
const toolsBy = new Map<string, ToolEntry>();
const toolOrder: string[] = [];

/** Test seam: live tool entries. `MAX_TOOLS` eviction must bound this; the
 * band only renders the newest rows, so the cap has no render-observable
 * signature of its own. */
export function retainedToolEntries(): number {
	return toolsBy.size;
}

let toolsFlushTimer: NodeJS.Timeout | null = null;
let toolsDirty = false;

function flushTools(): void {
	toolsFlushTimer = null;
	if (!toolsDirty) return;
	toolsDirty = false;
	toolsVersionCounter++;
	requestRender();
}

function markToolsDirty(): void {
	toolsDirty = true;
	if (!toolsFlushTimer) toolsFlushTimer = setTimeout(flushTools, TOOLS_FLUSH_MS);
}

let toolTicker: NodeJS.Timeout | null = null;

function ensureToolTicker(): void {
	if (toolTicker) return;
	toolTicker = setInterval(() => {
		let running = false;
		for (const e of toolsBy.values()) if (e.active && e.startedAt !== undefined) running = true;
		if (!running) {
			stopToolTicker();
			return;
		}
		toolsVersionCounter++;
		if (toolsOn) requestRender();
	}, 1000);
	toolTicker.unref?.();
}

function stopToolTicker(): void {
	if (!toolTicker) return;
	clearInterval(toolTicker);
	toolTicker = null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Text a tool reported, unsanitized and uncapped. Sanitization and the
 * character cap both live in `setToolOutput`, so a streaming update pays for
 * one pass over the cumulative partial instead of two, and the cap applies to
 * what is stored — never to what is counted. */
function resultText(result: unknown): string {
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

function argsJson(args: unknown): string {
	try {
		return capToolText(sanitizeText(JSON.stringify(args ?? {})));
	} catch {
		return "";
	}
}

/** Replace the stored output window with `text`'s sanitized tail and raise the
 * reported line count. `countAll` counts every non-empty line of the full text
 * (final results); a streaming update counts only the retained window. Both
 * paths sanitize the whole text once — one linear pass over the cumulative
 * partial, unavoidable if the stored tail is to be free of control characters.
 * Beyond that pass, a streaming update is O(retained) (cap, count, tail); the
 * final-result count is linear in the full text, paid once per tool call. */
function setToolOutput(entry: ToolEntry, text: string, countAll = false): void {
	const sanitized = sanitizeText(text);
	const lines = capToolText(sanitized)
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);
	// A whitespace-only final result carries no content: keep whatever the
	// stream already reported instead of blanking the panel.
	if (lines.length === 0) return;
	const total = countAll
		? sanitized
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(Boolean).length
		: lines.length;
	// Updates are cumulative; the max survives a shorter final result.
	entry.outputLineCount = Math.max(entry.outputLineCount ?? 0, total);
	entry.output = lines.slice(-MAX_TOOL_OUTPUT_LINES).join("\n");
}

function ingestToolCall(id: string, name: string, args: unknown, startedAt?: number): void {
	toolOrder.push(id);
	toolsBy.set(id, {
		id,
		name: sanitizeText(name),
		args: argsJson(args),
		output: "",
		active: true,
		isError: false,
		startedAt,
	});
	if (startedAt !== undefined) ensureToolTicker();
	toolsVersionCounter++;
	if (toolOrder.length > MAX_TOOLS) {
		const evict = toolOrder.shift();
		if (evict !== undefined) toolsBy.delete(evict);
	}
}

/** One-line render label for a tool result's last image, computed at ingest so
 * the base64 payload itself is never retained. `getImageDimensions` returns
 * null for empty or unrecognised payloads, so a bad image degrades to the
 * MIME-only label instead of throwing. */
function imageLabel(image: ImageBlock | undefined): string | undefined {
	if (!image) return undefined;
	const mimeType = sanitizeText(image.mimeType);
	return imageFallback(mimeType, getImageDimensions(image.data, mimeType) ?? undefined);
}

function ingestToolResult(id: string, result: unknown, isError: boolean, endedAt?: number): void {
	const entry = toolsBy.get(id);
	if (!entry) return;
	if (endedAt !== undefined && entry.startedAt !== undefined) entry.endedAt = endedAt;
	const text = resultText(result);
	if (text) setToolOutput(entry, text, true);
	const fields = isRecord(result) ? result : {};
	// Computed at ingest: the base64 payload is never retained.
	entry.imageLabel = imageLabel(lastImageBlock(fields.content));
	const details = isRecord(fields.details) ? fields.details : {};
	const diff = details.diff;
	if (typeof diff === "string" && diff) {
		const lines = capToolText(sanitizeText(diff)).split(/\r?\n/);
		entry.diff = lines.slice(0, MAX_TOOL_DIFF_LINES).join("\n");
		if (lines.length > MAX_TOOL_DIFF_LINES)
			entry.diff += `\n… +${lines.length - MAX_TOOL_DIFF_LINES} more diff lines`;
	}
	entry.active = false;
	entry.isError = isError;
	if (toolsFlushTimer) {
		clearTimeout(toolsFlushTimer);
		toolsFlushTimer = null;
	}
	toolsDirty = false;
	toolsVersionCounter++;
}

/** Status tone and glyph for one tool row. */
function toolState(entry: ToolEntry): { tone: "warning" | "error" | "success"; glyph: string } {
	if (entry.active) return { tone: "warning", glyph: "●" };
	if (entry.isError) return { tone: "error", glyph: "✗" };
	return { tone: "success", glyph: "✓" };
}

/** Output lines previewed per tool. A tall panel (4K-height terminal) has the
 * rows to show more than the classic two, so the depth follows the band. */
function previewLinesFor(rows: number): number {
	return Math.max(2, Math.min(6, Math.floor(rows / 8)));
}

/** Status row for one tool: glyph, name, elapsed time, fitted args tail. */
function toolPrefix(theme: Theme, entry: ToolEntry, textWidth: number): string {
	const { tone, glyph } = toolState(entry);
	const mark = theme.fg(tone, glyph);
	const name = theme.fg(entry.active ? "accent" : tone, entry.name);
	let duration = "";
	if (entry.startedAt !== undefined) {
		if (entry.endedAt !== undefined)
			duration = theme.fg("dim", ` ${formatDuration(entry.endedAt - entry.startedAt)}`);
		else if (entry.active && Date.now() - entry.startedAt >= 1000)
			duration = theme.fg("warning", ` ${formatDuration(Date.now() - entry.startedAt, true)}`);
	}
	const prefix = `${mark} ${name}${duration}`;
	const room = textWidth - visibleWidth(prefix) - 1;
	const args = entry.args && room >= 8 ? theme.fg("muted", ` ${truncateInline(entry.args, room)}`) : "";
	// A long tool name must never wrap: a card's row count has to be knowable
	// before it is budgeted.
	return truncateToWidth(prefix + args, textWidth);
}

/** Full-mode detail rows: the newest output lines (+earlier count) and image
 * fallback. The stored window is a tail, so the preview shows its newest
 * `previewCap` lines and reports everything older. */
function toolDetailLines(theme: Theme, entry: ToolEntry, textWidth: number, previewCap: number): string[] {
	const out: string[] = [];
	const content = (entry.output || "").split(/\r?\n/).filter(Boolean);
	if (content.length === 0) {
		if (entry.active) out.push(theme.fg("dim", "  · …"));
	} else {
		const total = Math.max(entry.outputLineCount ?? content.length, content.length);
		const shown = content.slice(-previewCap);
		const hidden = total - shown.length;
		if (hidden > 0) out.push(theme.fg("dim", `  · +${hidden} earlier lines`));
		for (const line of shown) out.push(theme.fg("toolOutput", `  · ${truncateInline(line, textWidth - 4)}`));
	}
	if (entry.imageLabel) out.push(theme.fg("toolOutput", `  · ${entry.imageLabel}`));
	return out;
}

/** Full-mode diff block under a tool row; empty when the result had no diff.
 * Every row is truncated to the column so it occupies exactly one row. */
function toolDiffLines(theme: Theme, diff: string | undefined, textWidth: number): string[] {
	if (!diff) return [];
	const out = [""];
	for (const line of renderDiff(diff, { theme }).split(/\r?\n/))
		out.push(truncateToWidth(`    ${line}`, textWidth));
	return out;
}

/** One full-mode card to fit: which entry, how wide, how deep, how many rows
 * the band has left for it. */
interface ToolCardOptions {
	theme: Theme;
	entry: ToolEntry;
	textWidth: number;
	previewCap: number;
	budget: number;
}

/** Body rows of one full-mode card, fitted to `budget` rows (its own row is
 * already counted by the caller). Detail that does not fit is summarized,
 * never dropped silently. */
function toolCardBody({ theme, entry, textWidth, previewCap, budget }: ToolCardOptions): string[] {
	const detail = [
		...toolDetailLines(theme, entry, textWidth, previewCap),
		...toolDiffLines(theme, entry.diff, textWidth),
	];
	const room = budget - 1;
	if (detail.length === 0 || room <= 0) return [];
	if (detail.length <= room) return detail;
	// One of the remaining rows reports the omission.
	const keep = room - 1;
	const kept = keep > 0 ? detail.slice(0, keep) : [];
	return [...kept, theme.fg("dim", `  · +${detail.length - keep} more detail rows`)];
}

/** Panel rows for the tools view, styled, oldest first. Cards are built
 * newest-first and each one is budgeted against the rows left: the card's own
 * row always survives, and detail that does not fit is reported instead of
 * pushing the row out of the band. */
function toolLines(theme: Theme, width: number, previewCap: number, maxRows: number): string[] {
	const full = toolMode === "full";
	const textWidth = Math.max(8, width - 3);
	const blocks: string[][] = [];
	let items = 0;
	for (let i = toolOrder.length - 1; i >= 0 && items < maxRows; i--) {
		const entry = toolsBy.get(toolOrder[i]);
		if (!entry) continue;
		// Compact mode puts one blank row before every entry except the oldest;
		// this reproduces the current `out.length > 1` splice exactly.
		const separator = !full && i > 0 && maxRows - items > 1 ? [""] : [];
		const budget = maxRows - items - separator.length;
		if (budget < 1) break;
		const rows = [toolPrefix(theme, entry, textWidth)];
		if (full) rows.push(...toolCardBody({ theme, entry, textWidth, previewCap, budget }));
		blocks.push([...separator, ...rows]);
		items += separator.length + rows.length;
	}
	return blocks.reverse().flat();
}

// ─── files buffer ────────────────────────────────────────────────────────────

interface FileEntry {
	path: string;
	ops: string;
	count: number;
}

const files = new Map<string, FileEntry>();
let filesVersion = 0;

/** One file a tool call touched. */
interface PathHit {
	abs: string;
	op: string;
}

/** Every tool whose input names its single target under a fixed key, with the
 * op letter recorded for it; the file need not exist (the tool acted on it). */
const EXACT_PATH_TOOLS: Record<string, { key: string; op: string } | undefined> = {
	read: { key: "path", op: "r" },
	write: { key: "path", op: "w" },
	edit: { key: "path", op: "w" },
	ast_edit: { key: "path", op: "w" },
};
/** Single-value keys of a tool with no fixed contract: the file must exist. */
const GENERIC_PATH_KEYS = ["path", "filePath", "file_path", "imagePath"];
/** List-valued spellings of the same idea. */
const GENERIC_LIST_KEYS = ["paths", "files", "filePaths"];

/** Resolve one candidate value against the session cwd and record it; a
 * non-string, empty or (unless `unconditional`) non-existent path is skipped. */
function addPathHit(out: PathHit[], value: unknown, op: string, unconditional: boolean): void {
	if (typeof value !== "string" || !value) return;
	try {
		const abs = path.resolve(sessionCwd, value);
		if (!unconditional && (!existsSync(abs) || !statSync(abs).isFile())) return;
		out.push({ abs, op });
	} catch {
		/* skip */
	}
}

/** Files named by a bash command line: its word tokens that resolve to files. */
function bashPathHits(command: string): PathHit[] {
	const out: PathHit[] = [];
	for (const raw of command.split(/\s+/)) {
		// Both classes are anchored and single-width; sonarjs flags the `+$`
		// suffix as super-linear, which does not apply to a one-character class.
		// eslint-disable-next-line sonarjs/super-linear-regex
		const token = raw.replace(/^[("'`]+/, "").replace(/[)"'`;:,]+$/, "");
		if (!token || token.startsWith("-") || /[|&><`$*?]/.test(token)) continue;
		addPathHit(out, token, "s", false);
	}
	return out;
}

/** Files one tool call touched: bash word tokens, a fixed-key tool's single
 * target, or a custom tool's generic path keys. */
function pathsFrom(toolName: string, input: Record<string, unknown>): PathHit[] {
	if (toolName === "bash") return bashPathHits(typeof input.command === "string" ? input.command : "");
	const out: PathHit[] = [];
	const exact = EXACT_PATH_TOOLS[toolName];
	if (exact) {
		addPathHit(out, input[exact.key], exact.op, true);
		return out;
	}
	for (const key of GENERIC_PATH_KEYS) addPathHit(out, input[key], "r", false);
	for (const key of GENERIC_LIST_KEYS) {
		const value = input[key];
		if (Array.isArray(value)) for (const item of value) addPathHit(out, item, "r", false);
	}
	return out;
}

function record(toolName: string, input: Record<string, unknown>): void {
	const seen = new Set<string>();
	for (const { abs, op } of pathsFrom(toolName, input)) {
		if (seen.has(abs)) continue;
		seen.add(abs);
		const prev = files.get(abs);
		if (prev) {
			files.delete(abs);
			prev.count++;
			if (!prev.ops.includes(op)) prev.ops += op;
			files.set(abs, prev);
		} else {
			if (files.size >= MAX_FILES) files.delete(files.keys().next().value as string);
			files.set(abs, { path: abs, ops: op, count: 1 });
		}
	}
	filesVersion++;
}

const recentEntries = (): FileEntry[] => [...files.values()].reverse();

function displayPath(abs: string): string {
	const rel = path.relative(sessionCwd, abs);
	if (rel && !rel.startsWith("..")) return rel;
	const home = homedir();
	if (abs.startsWith(`${home}${path.sep}`)) return `~${abs.slice(home.length)}`;
	return abs;
}

// ─── edit-diff state ─────────────────────────────────────────────────────────

const editDiff = { path: "", diff: "", version: 0 };

function setEditDiff(filePath: string, diff: string): void {
	editDiff.path = filePath;
	// Bounded, not pre-sanitized: `renderDiff` sanitizes (escapes included) and
	// expands tabs itself, so running sanitizeText here would turn tab
	// indentation into a single space and change the rendered diff.
	editDiff.diff = capDiffText(diff);
	editDiff.version++;
}

/** Test seam: stored edit-diff size after the ingest cap. */
export function retainedEditDiff(): { lines: number; chars: number } {
	return { lines: editDiff.diff ? editDiff.diff.split("\n").length : 0, chars: editDiff.diff.length };
}

function clearEditDiff(): void {
	editDiff.path = "";
	editDiff.diff = "";
	editDiff.version++;
}

// ─── band rendering ──────────────────────────────────────────────────────────

interface BandDef {
	title: string;
	color: "accent" | "muted";
	streaming: () => boolean;
	style: (line: string) => string;
	lines: (width: number, rows: number) => string[];
	empty: string;
}

function bandDef(theme: Theme, id: "thinking" | "tools"): BandDef {
	if (id === "thinking")
		return {
			title: "Thinking",
			color: "accent",
			streaming: () => thinking.streaming,
			style: line => theme.fg("thinkingText", line),
			lines: () => thinkingLines(),
			empty: "Thinking idle",
		};
	return {
		title: "Tool Usage",
		color: "muted",
		streaming: () => toolOrder.some(id => toolsBy.get(id)?.active),
		style: line => line,
		lines: (width: number, rows: number) => toolLines(theme, width, previewLinesFor(rows), rows),
		empty: "No tools called yet",
	};
}

/** Everything `newestRows` needs about one panel: its items, the wrapping
 * width, the row budget and the memo it caches wrapped fragments in. */
interface NewestRowsOptions {
	items: string[];
	textWidth: number;
	maxRows: number;
	style: (line: string) => string;
	memo: Map<string, string[]>;
	panel: string;
}

/**
 * Newest-first line wrapping: only the items that fill `maxRows` are wrapped,
 * so a long history costs nothing per frame. Returns rows oldest-first.
 */
function newestRows(options: NewestRowsOptions): string[] {
	const { items, textWidth, maxRows, style, memo, panel } = options;
	const rows: string[] = [];
	for (let i = items.length - 1; i >= 0 && rows.length < maxRows; i--) {
		const item = items[i];
		// Wrap fragments depend on the panel (styling) and its current width.
		const memoKey = `${panel}|${textWidth}|${item}`;
		let frags = memo.get(memoKey);
		if (!frags) {
			frags = wrapTextWithAnsi(style(capDisplayLine(item, MAX_LINE_CHARS)), Math.max(1, textWidth));
			if (memo.size > MAX_BODY_ROWS * 4) memo.clear();
			memo.set(memoKey, frags);
		}
		for (let j = frags.length - 1; j >= 0 && rows.length < maxRows; j--) rows.push(frags[j]);
	}
	return rows.reverse();
}

/** One framed panel's inputs: which band, how wide, how tall, what to memo. */
interface PanelOptions {
	theme: Theme;
	def: BandDef;
	width: number;
	bodyRows: number;
	memo: Map<string, string[]>;
}

/** One framed panel: top border with title, exactly `bodyRows` body rows,
 * bottom border. Every line is exactly `width` display cells wide. */
function renderPanel(options: PanelOptions): string[] {
	const { theme, def, width, bodyRows, memo } = options;
	const inner = Math.max(1, width - 2);
	const label = truncateToWidth(
		theme.fg(def.color, ` ${def.title} `) + (def.streaming() ? theme.fg("warning", "●") : ""),
		inner,
	);
	const top =
		theme.fg("border", "╭") +
		label +
		theme.fg("border", "─".repeat(Math.max(0, inner - visibleWidth(label)))) +
		theme.fg("border", "╮");
	const bottom = theme.fg("border", `╰${"─".repeat(inner)}╯`);
	const textWidth = Math.max(1, width - 3);
	const visible = newestRows({
		items: def.lines(width, bodyRows),
		textWidth,
		maxRows: bodyRows,
		style: def.style,
		memo,
		panel: def.title,
	});
	const bodyRow = (text: string) => {
		// Clip, don't just pad: wrapped lines and empty-state hints can be
		// wider than a narrow panel, and an over-wide row corrupts the frame.
		const clipped = truncateToWidth(text, textWidth);
		return `${theme.fg("border", "│")} ${clipped}${" ".repeat(Math.max(0, textWidth - visibleWidth(clipped)))}${theme.fg("border", "│")}`;
	};
	const out = [top];
	for (let i = 0; i < bodyRows; i++)
		out.push(bodyRow(visible[i] ?? (i === 0 ? theme.fg("dim", def.empty) : "")));
	out.push(bottom);
	return out;
}

let bandCacheKey = "";
let bandCache: string[] = [];
const bandMemo = new Map<string, string[]>();
let bandFingerprint = "";

function themeFingerprint(theme: Theme): string {
	return [
		theme.fg("border", "x"),
		theme.fg("accent", "x"),
		theme.fg("muted", "x"),
		theme.fg("text", "x"),
		theme.fg("thinkingText", "x"),
		theme.fg("toolOutput", "x"),
		theme.fg("success", "x"),
		theme.fg("error", "x"),
		theme.fg("warning", "x"),
		theme.fg("dim", "x"),
	].join("|");
}

/** Panel widths: files keeps its dock, then thinking | tools split the
 * remainder right-to-left; a lone panel takes the whole width. */
function allocateWidths(width: number, ids: PanelId[], filesCols: number): Map<PanelId, number> {
	const widths = new Map<PanelId, number>();
	if (ids.length === 1) {
		widths.set(ids[0], width);
		return widths;
	}
	let remaining = width;
	if (filesCols > 0) {
		widths.set("files", filesCols);
		remaining -= filesCols;
	}
	if (thinkingOn && toolsOn) {
		const toolsWidth = bandToolsColsFor(remaining, toolsWidthPct);
		widths.set("thinking", remaining - toolsWidth);
		widths.set("tools", toolsWidth);
	} else {
		const only = thinkingOn ? "thinking" : "tools";
		widths.set(only, remaining);
	}
	return widths;
}

/** Render the enabled panels and join them row by row into one band. */
function composeColumns(theme: Theme, ids: PanelId[], widths: Map<PanelId, number>, bodyRows: number): string[] {
	const parts = ids.map(id => {
		// Every id has a width: allocateWidths sets each one it was given.
		const panelWidth = widths.get(id) ?? 0;
		if (id === "files") return filesPanelLines(theme, panelWidth, bandHeight);
		return renderPanel({ theme, def: bandDef(theme, id), width: panelWidth, bodyRows, memo: bandMemo });
	});
	if (parts.length === 1) return parts[0];
	return parts[0].map((line, index) => line + parts.slice(1).map(part => part[index] ?? "").join(""));
}

/** Files dock width for a band of `cols`: the preset's auto share or the
 * manual width, clamped so the frame plus a little transcript still fits.
 * `/split-geometry` reports this same number, so the message cannot drift. */
function clampedDockCols(cols: number): number {
	return Math.max(MIN_DOCK_COLS, Math.min(dockColsFor(cols, filesWidth, GEOMETRY_PROFILES[geometryMode]), cols - 40));
}

/** Enabled panel ids for this width, plus the files dock width (0 = no dock). */
function panelLayout(width: number): { ids: PanelId[]; filesWidthCols: number } {
	const ids: PanelId[] = [];
	if (thinkingOn) ids.push("thinking");
	if (toolsOn) ids.push("tools");
	// A files column needs room for its frame plus something beside it.
	const filesWidthCols = filesOn && width >= MIN_TERM_WIDTH ? clampedDockCols(width) : 0;
	if (filesWidthCols > 0) ids.push("files");
	return { ids, filesWidthCols };
}

/** Files-only on a narrow terminal: keep the frame and say why. */
function narrowFilesNotice(theme: Theme, width: number): string[] {
	if (filesOn && !thinkingOn && !toolsOn)
		return filesPanelLines(theme, width, bandHeight, `Files panel needs ≥${MIN_TERM_WIDTH} cols`);
	return [];
}

function renderBand(theme: Theme, width: number, bodyRows: number, rows: number): string[] {
	// Short terminals hide the band instead of squeezing the transcript.
	if (rows - bandHeight < MIN_ROWS_BELOW_BAND) return [];
	const fingerprint = themeFingerprint(theme);
	// Wrapped fragments carry the theme's SGR codes, so a theme switch must
	// drop the memo as well as the composed band.
	if (fingerprint !== bandFingerprint) {
		bandMemo.clear();
		bandFingerprint = fingerprint;
	}
	const key = [
		width,
		bandHeight,
		toolsWidthPct,
		thinkingOn ? 1 : 0,
		toolsOn ? 1 : 0,
		filesOn ? 1 : 0,
		showDiff ? 1 : 0,
		filesWidth,
		// The dock width depends on the preset. `/split-geometry` and a session
		// load also clear the memo, but an unmount/remount at a new shape with a
		// pinned height changes nothing else in this key.
		geometryMode,
		filesVersion,
		editDiff.version,
		toolMode,
		thinking.version,
		toolsVersionCounter,
		fingerprint,
	].join(":");
	if (key === bandCacheKey) return bandCache;

	const { ids, filesWidthCols } = panelLayout(width);
	if (ids.length === 0) return narrowFilesNotice(theme, width);

	const widths = allocateWidths(width, ids, filesWidthCols);
	const lines = composeColumns(theme, ids, widths, bodyRows);
	bandCacheKey = key;
	bandCache = lines;
	return lines;
}

class BandHub implements Component {
	constructor(private readonly tui: TUI) {}

	render(width: number): readonly string[] {
		if (!thinkingOn && !toolsOn && !filesOn) return EMPTY;
		scheduleVisibilitySync();
		// eslint-disable-next-line sonarjs/no-use-of-empty-return-value -- the default getter throws
		const theme = themeGetter();
		return renderBand(theme, width, Math.max(0, bandHeight - 2), this.tui.terminal.rows);
	}

	invalidate(): void {
		bandCacheKey = "";
	}

	dispose(): void {
		/* nothing owned */
	}
}

// ─── files panel (band column) ──────────────────────────────────────────────

/** Framed files-panel row: border, right-padded content, border. */
function filesRow(theme: Theme, inner: number, content: string): string {
	const clipped = truncateToWidth(content, inner);
	return (
		theme.fg("border", "│") +
		clipped +
		" ".repeat(Math.max(0, inner - visibleWidth(clipped))) +
		theme.fg("border", "│")
	);
}

/** One file row (indented under a group header, or at list level) plus count. */
function fileEntryRow(
	theme: Theme,
	inner: number,
	entry: FileEntry,
	indent: string,
): { line: string; files: number } {
	const count = entry.count > 1 ? `×${entry.count}` : "";
	const meta = theme.fg("muted", `${entry.ops}${count}`);
	return {
		line: filesRow(theme, inner, `${indent}${meta} ${theme.fg("text", sanitizeText(path.basename(entry.path)))}`),
		files: 1,
	};
}

/** Rows for one contiguous directory run: a header row when the run is long
 * enough to group (`files: 0`), then its indented files (`files: 1`). */
function fileRunRows(
	theme: Theme,
	inner: number,
	dir: string,
	run: FileEntry[],
): { line: string; files: number }[] {
	if (run.length <= 3) return run.map(entry => fileEntryRow(theme, inner, entry, " "));
	const label = sanitizeText(displayPath(dir));
	const groupTitle = label === "." ? "./" : `${label}/`;
	return [
		{ line: filesRow(theme, inner, ` ${theme.fg("accent", groupTitle)}`), files: 0 },
		...run.map(entry => fileEntryRow(theme, inner, entry, "   ")),
	];
}

/** Grouped file rows, newest first. */
function fileRows(theme: Theme, inner: number, entries: FileEntry[]): { line: string; files: number }[] {
	const rows: { line: string; files: number }[] = [];
	let i = 0;
	while (i < entries.length) {
		const dir = path.dirname(entries[i].path);
		let j = i;
		while (j < entries.length && path.dirname(entries[j].path) === dir) j++;
		rows.push(...fileRunRows(theme, inner, dir, entries.slice(i, j)));
		i = j;
	}
	return rows;
}

/** List body: slot budget, "… +N more" marker, legend. Not padded. */
function filesBody(theme: Theme, inner: number, listRows: number, entries: FileEntry[]): string[] {
	const rows = fileRows(theme, inner, entries);
	// One row is kept back for the legend; the "… more" marker only costs a row
	// when the list really is truncated, so a short band still shows its files.
	const entrySlots = Math.max(1, listRows - 1);
	const truncated = rows.length > entrySlots;
	let take = truncated ? Math.max(0, entrySlots - 1) : rows.length;
	if (truncated && take === 0) take = entrySlots;
	const shown = rows.slice(0, take);
	// Never end the list on a directory header whose files were cut off.
	while (shown.length > 0 && shown[shown.length - 1].files === 0) shown.pop();

	const body: string[] = [];
	let filesShown = 0;
	for (const entry of shown) {
		body.push(entry.line);
		filesShown += entry.files;
	}
	if (entries.length === 0) body.push(filesRow(theme, inner, ` ${theme.fg("dim", "No files touched yet")}`));
	else if (entries.length > filesShown && body.length < listRows) {
		const hiddenFiles = `… +${entries.length - filesShown} more`;
		body.push(filesRow(theme, inner, ` ${theme.fg("dim", hiddenFiles)}`));
	}
	if (body.length < listRows) body.push(filesRow(theme, inner, ` ${theme.fg("dim", LEGEND)}`));
	return body;
}

/** Diff subpanel: separator, title, rendered diff (or "No edit yet"), padded to
 * `diffRows + 2`. Returns `[]` when `enabled` is false. */
function filesDiffBody(theme: Theme, inner: number, diffRows: number, enabled: boolean): string[] {
	if (!enabled) return [];
	const body: string[] = [];
	body.push(theme.fg("border", `├${"─".repeat(inner)}┤`));
	const title = editDiff.path
		? theme.fg("accent", ` ✎ ${truncateToWidth(sanitizeText(displayPath(editDiff.path)), inner - 4)} `)
		: theme.fg("dim", " Last Edit ");
	body.push(
		theme.fg("border", "│") +
			title +
			theme.fg("border", "─".repeat(Math.max(0, inner - visibleWidth(title)))) +
			theme.fg("border", "│"),
	);
	if (editDiff.diff) {
		const rendered = renderDiff(editDiff.diff, { theme, filePath: editDiff.path }).split(/\r?\n/);
		const shown = rendered.slice(0, Math.max(0, diffRows - 1));
		for (const line of shown) body.push(filesRow(theme, inner, ` ${line}`));
		if (rendered.length > shown.length && diffRows > 0) {
			const hiddenLines = `… +${rendered.length - shown.length} more`;
			body.push(filesRow(theme, inner, ` ${theme.fg("dim", hiddenLines)}`));
		}
	} else if (diffRows > 0) {
		body.push(filesRow(theme, inner, ` ${theme.fg("dim", "No edit yet")}`));
	}
	while (body.length < diffRows + 2) body.push(filesRow(theme, inner, ""));
	return body;
}

/**
 * Framed files panel: touched files plus the edit-diff subpanel, sized to the
 * band. It is a band column rather than a floating dock: omp composites
 * overlays over the whole viewport (band and editor included), so an overlay
 * dock would cover the band instead of sitting beside the transcript.
 *
 * `notice` replaces the file list with one hint row (keeping the frame, the
 * title, the diff subpanel and the height contract) for the cases where there
 * is nothing to list but silence would look like a bug — the files-only
 * layout on a terminal too narrow to dock the column.
 */
function filesPanelLines(theme: Theme, width: number, height: number, notice?: string): string[] {
	const inner = Math.max(1, width - 2);
	const entries = recentEntries();
	// A tall enough panel splits into list and diff; a short one keeps the list.
	const withDiff = showDiff && height >= 10;
	const listRows = withDiff ? Math.max(3, Math.floor(height / 2) - 4) : Math.max(1, height - 4);
	const diffRows = withDiff ? Math.max(0, height - listRows - 6) : 0;

	const body: string[] = notice
		? [filesRow(theme, inner, ` ${theme.fg("dim", truncateInline(notice, Math.max(1, inner - 2)))}`)]
		: filesBody(theme, inner, listRows, entries);
	while (body.length < listRows) body.push(filesRow(theme, inner, ""));

	const title = `📂 Files (${entries.length})`;
	return [
		theme.fg("border", `╭${"─".repeat(inner)}╮`),
		filesRow(theme, inner, ` ${theme.fg("accent", title)}`),
		theme.fg("border", `├${"─".repeat(inner)}┤`),
		...body,
		...filesDiffBody(theme, inner, diffRows, withDiff),
		theme.fg("border", `╰${"─".repeat(inner)}╯`),
	];
}

// ─── mount / unmount ─────────────────────────────────────────────────────────

/** Preset in force for the live terminal: a pinned setting wins, `auto` reads
 * the aspect ratio. Called wherever the setting or the terminal may have
 * changed (mount, session load, `/split-geometry`), because the widget is
 * mounted once per process and does not re-enter its factory on a session
 * switch. With no terminal bound yet, `auto` resolves to `4k` until the mount
 * reports the real size. */
function resolveGeometryMode(): GeometryMode {
	if (geometrySetting !== "auto") return geometrySetting;
	const cols = tuiRef?.terminal.columns ?? 0;
	const rows = tuiRef?.terminal.rows ?? 0;
	return autoGeometryMode(cols, rows);
}

function mountWidget(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || widgetMounted) return;
	widgetMounted = true;
	ctx.ui.setWidget(
		WIDGET_KEY,
		tui => {
			tuiRef = tui;
			geometryMode = resolveGeometryMode();
			if (bandHeightAuto) {
				bandHeight = defaultBandHeight(tui.terminal.rows, GEOMETRY_PROFILES[geometryMode]);
				bandCacheKey = "";
			}
			return new BandHub(tui);
		},
		{ placement: "aboveEditor" },
	);
}

function unmountWidget(ctx: ExtensionContext): void {
	if (!widgetMounted) return;
	widgetMounted = false;
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

function reconcile(ctx: ExtensionContext): void {
	if (thinkingOn || toolsOn || filesOn) mountWidget(ctx);
	else unmountWidget(ctx);
	syncAdvisorStatus(ctx);
	requestRender();
}

/** Apply a panel/geometry change: reconcile the widget and mirror the layout
 * onto omp's transcript switches. */
function applyLayout(ctx: ExtensionContext): void {
	reconcile(ctx);
	syncTranscriptVisibility();
}

/** Adopt the saved size and geometry fields. Panel visibility stays
 * caller-owned: `/split` decides it from the same config, and `--no-split`
 * overrides it. */
function applySavedMetrics(raw: UiPanelsConfig, cfg: NormalizedUiPanelsConfig): void {
	toolMode = cfg.toolMode;
	bandHeight = cfg.bandHeight;
	const rawHeight: unknown = isRecord(raw) ? raw.bandHeight : undefined;
	bandHeightAuto = typeof rawHeight !== "number";
	geometrySetting = cfg.geometry;
	// The widget is mounted once, so its factory does not run again on a
	// session switch: resolve here as well, or an ultrawide pane would drop
	// back to the 4k curve until the next mount.
	geometryMode = resolveGeometryMode();
	// An auto height belongs to the terminal, not the session: adopt it again
	// even when the host does not remount the widget (the factory is the only
	// other place that can). A pinned height keeps winning.
	if (bandHeightAuto && tuiRef) {
		bandHeight = defaultBandHeight(tuiRef.terminal.rows, GEOMETRY_PROFILES[geometryMode]);
	}
	toolsWidthPct = cfg.toolsWidthPct;
	filesWidth = cfg.filesWidth;
	bandCacheKey = "";
}

// ─── transcript visibility (native omp display switches) ────────────────────

const HIDE_THINKING_ID = "hideThinkingBlock";
const HIDE_TOOLS_ID = "display.hideToolActivity";

/** The band renders only when the transcript + editor still fit below it. */
function bandFits(): boolean {
	const rows = tuiRef?.terminal.rows;
	return rows === undefined || rows - bandHeight >= MIN_ROWS_BELOW_BAND;
}

function desiredVisibility(): TranscriptVisibility {
	return transcriptVisibility(thinkingOn, trimResponse, bandFits());
}

/**
 * Last policy this extension applied. Process-global so a /reload (fresh
 * module generation, same settings instance) can still clear a stale override.
 */
const VISIBILITY_KEY = Symbol.for("omp.split-view.visibility");
const visibilityRegistry: { applied: TranscriptVisibility | null } = (
	globalThis as Record<symbol, { applied: TranscriptVisibility | null } | undefined>
)[VISIBILITY_KEY] ?? { applied: null };
(globalThis as Record<symbol, { applied: TranscriptVisibility | null }>)[VISIBILITY_KEY] = visibilityRegistry;
/** omp build lacks one of the switches; stop trying. */
let visibilityUnsupported = false;
let visibilitySyncPending = false;

function sameVisibility(left: TranscriptVisibility, right: TranscriptVisibility): boolean {
	return left.hideThinking === right.hideThinking && left.hideTools === right.hideTools;
}

/**
 * Policy that still needs applying, or null when the transcript already
 * matches. `force` re-applies an equal policy (fresh session, new generation).
 * Nothing owned yet and nothing to hide leaves the user's settings alone.
 */
function pendingVisibilityPolicy(force: boolean): TranscriptVisibility | null {
	if (!api || visibilityUnsupported) return null;
	const applied = visibilityRegistry.applied;
	const policy = desiredVisibility();
	if (!force && applied && sameVisibility(applied, policy)) return null;
	if (!policy.hideThinking && !policy.hideTools && applied === null) return null;
	return policy;
}

/**
 * Mirror the panel layout onto omp's transcript switches: a visible thinking
 * panel hides thinking blocks, response-only hides thinking and tool activity.
 * Overrides are runtime-only; turning a switch off clears the override so the
 * user's own configured value applies again.
 */
function syncTranscriptVisibility(force = false): void {
	const policy = pendingVisibilityPolicy(force);
	if (!policy || !api) return;

	const hideThinking = lookup(HIDE_THINKING_ID);
	const hideTools = lookup(HIDE_TOOLS_ID);
	if (!hideThinking || !hideTools) {
		visibilityUnsupported = true;
		return;
	}
	try {
		if (policy.hideThinking) hideThinking.override(api.pi.settings, true);
		else hideThinking.clearOverride(api.pi.settings);
		if (policy.hideTools) hideTools.override(api.pi.settings, true);
		else hideTools.clearOverride(api.pi.settings);
		visibilityRegistry.applied = policy;
	} catch {
		visibilityUnsupported = true;
	}
}

/**
 * Render-time self-heal: the band auto-hides on short terminals, and the
 * transcript must get its thinking back when it does. Scheduled (never applied
 * inside render) so a settings change cannot re-enter the frame being built.
 */
function scheduleVisibilitySync(): void {
	if (visibilitySyncPending || !pendingVisibilityPolicy(false)) return;
	visibilitySyncPending = true;
	setTimeout(() => {
		visibilitySyncPending = false;
		syncTranscriptVisibility();
	}, 0);
}

// ─── branch reconstruction ───────────────────────────────────────────────────

// Narrowed views of the session branch's message union: the replay split needs
// the assistant and tool-result shapes, not the whole agent message type.
type BranchMessage = SessionMessageEntry["message"];
type AssistantBranchMessage = Extract<BranchMessage, { role: "assistant" }>;
type ToolResultBranchMessage = Extract<BranchMessage, { role: "toolResult" }>;

/** Replay one assistant message: collect thinking text, rebuild its tool calls. */
function replayAssistant(msg: AssistantBranchMessage, thoughts: string[]): void {
	for (const block of msg.content) {
		// Live ingestion sanitizes; replay must too, or a resumed session can
		// render raw escape sequences from the stored branch.
		if (block.type === "thinking" && typeof block.thinking === "string")
			thoughts.push(sanitizeText(block.thinking));
		if (block.type !== "toolCall") continue;
		try {
			// Rebuild through the same ingest path live events use.
			ingestToolCall(block.id, block.name, block.arguments);
			// W6(a): bash "seen" files are a live observation. Replaying a bash
			// command re-probes every word token against today's filesystem
			// (cost grows with the branch, results drift as files move), so
			// replay lists only the paths a tool named directly.
			if (block.name !== "bash") record(block.name, block.arguments ?? {});
		} catch {
			/* skip malformed call */
		}
	}
}

/** Replay one tool result through the live ingest path, and apply an edit diff. */
function replayToolResult(msg: ToolResultBranchMessage): void {
	try {
		ingestToolResult(msg.toolCallId, msg, msg.isError);
		const details = isRecord(msg.details) ? msg.details : {};
		if (msg.toolName === "edit" && typeof details.diff === "string" && details.diff)
			setEditDiff(typeof details.path === "string" ? details.path : editDiff.path, details.diff);
	} catch {
		/* skip malformed result */
	}
}

/** Replay branch entries: advisor cards feed the tally, assistant/tool results
 * rebuild the panels, and a real user prompt is the turn boundary. */
function replayBranch(ctx: ExtensionContext, thoughts: string[]): void {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom_message") {
			if (entry.customType === "advisor") addAdvisorNotes(entry.details);
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (isUserPrompt(msg)) resetAdvisorTally();
		if (msg.role === "assistant") replayAssistant(msg, thoughts);
		else if (msg.role === "toolResult") replayToolResult(msg);
	}
}

/** Rebuild panel state from the session branch (resume, tree switch, session
 * switch), replaying it through the same ingest path live events use. */
function reconstruct(ctx: ExtensionContext): void {
	thinking.reset();
	toolsBy.clear();
	toolOrder.length = 0;
	toolsVersionCounter++;
	files.clear();
	filesVersion++;
	clearEditDiff();
	resetAdvisorTally();
	sessionCwd = ctx.cwd || process.cwd();

	const thoughts: string[] = [];
	replayBranch(ctx, thoughts);
	if (thoughts.length) {
		for (const text of thoughts) thinking.blocks.push({ lines: text.split(/\r?\n/), tail: "" });
		thinking.trim();
		thinking.version++;
	}
	bandCacheKey = "";
}

// ─── extension ───────────────────────────────────────────────────────────────

export default function splitView(pi: ExtensionAPI): void {
	api = pi;
	pi.setLabel("Split View");

	pi.registerFlag("no-split", {
		description: "Start bare: skip the split-view panels (thinking/tools/files)",
		type: "boolean",
		default: false,
	});

	registerEvents(pi);
	registerCommands(pi);
}

/** Every command is TUI-only: refuse with one notify in any other mode. */
function requireTui(ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui") {
		notify("Split view requires the interactive TUI", "error");
		return false;
	}
	return true;
}

/** Wire the omp lifecycle: session load/resume, live thinking and tool deltas. */
function registerEvents(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		notifyFn = (message, level) => ctx.ui.notify(message, level);
		themeGetter = () => ctx.ui.theme;
		// A settings failure latched the last session; a new one may run against
		// a different settings object, so let the transcript switches be retried.
		visibilityUnsupported = false;

		const raw = loadUiPanelsConfig();
		let cfg = normalizeConfig(raw);
		if (pi.getFlag("no-split")) {
			cfg = { ...cfg, split: false, thinking: false, tools: false, files: false, trimResponse: false };
		}
		thinkingOn = cfg.thinking;
		toolsOn = cfg.tools;
		applySavedMetrics(raw, cfg);
		filesOn = cfg.files;
		showDiff = cfg.diff;
		trimResponse = cfg.trimResponse;

		reconstruct(ctx);
		if (ctx.mode === "tui") {
			if (thinkingOn || toolsOn || filesOn) mountWidget(ctx);
			// Forced: a fresh session must not trust a previous generation's
			// recorded override state.
			syncTranscriptVisibility(true);
			syncAdvisorStatus(ctx);
			requestRender();
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		reconstruct(ctx);
		syncAdvisorStatus(ctx);
		requestRender();
	});
	pi.on("session_switch", (_event, ctx) => {
		reconstruct(ctx);
		syncAdvisorStatus(ctx);
		requestRender();
	});

	pi.on("message_update", (event, ctx) => {
		if (!isMainAgent(ctx)) return;
		const delta = event.assistantMessageEvent;
		if (delta) {
			if (delta.type === "thinking_start") thinking.start();
			else if (delta.type === "thinking_delta") thinking.append(delta.delta ?? "");
			else if (delta.type === "thinking_end") thinking.end(delta.content ?? "");
		}
		if (thinkingOn) requestRender();
	});

	// Advisor batches arrive as `custom` messages, live on both delivery paths
	// (cards recorded without a turn and steered batches both pass through the
	// agent's message_start/message_end pair). Reset on a real user prompt so
	// the tally describes the turn in progress.
	pi.on("message_end", (event, ctx) => {
		const advisor = advisorNoteDetails(event.message);
		if (advisor) {
			addAdvisorNotes(advisor.details);
			syncAdvisorStatus(ctx);
			return;
		}
		if (isUserPrompt(event.message)) {
			resetAdvisorTally();
			syncAdvisorStatus(ctx);
		}
	});

	registerToolEvents(pi);

	pi.on("session_shutdown", (_event, ctx) => {
		stopToolTicker();
		if (thinkFlushTimer) {
			clearTimeout(thinkFlushTimer);
			thinkFlushTimer = null;
		}
		if (toolsFlushTimer) {
			clearTimeout(toolsFlushTimer);
			toolsFlushTimer = null;
		}
		try {
			if (ctx.mode === "tui") ctx.ui.setStatus(ADVISOR_STATUS_KEY, undefined);
		} catch {
			/* status is decorative */
		}
		resetAdvisorTally();
		unmountWidget(ctx);
		notifyFn = null;
	});
}

/** Tool activity feeds the band: execution streams rows, tool_call fills the
 * files column, tool_result applies any reported diff. Only the top-level
 * agent may contribute — advisor tools arrive through the same hooks. */
function registerToolEvents(pi: ExtensionAPI): void {
	pi.on("tool_execution_start", (event, ctx) => {
		if (!isMainAgent(ctx)) return;
		ingestToolCall(event.toolCallId, event.toolName, event.args, Date.now());
		if (toolsOn) requestRender();
	});
	pi.on("tool_execution_update", (event, ctx) => {
		if (!isMainAgent(ctx)) return;
		const entry = toolsBy.get(event.toolCallId);
		if (entry) {
			setToolOutput(entry, resultText(event.partialResult));
			markToolsDirty();
		}
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (!isMainAgent(ctx)) return;
		ingestToolResult(event.toolCallId, event.result, event.isError, Date.now());
		if (toolsOn) requestRender();
	});

	pi.on("tool_call", (event, ctx) => {
		if (!isMainAgent(ctx)) return;
		try {
			record(event.toolName, (event.input ?? {}) as Record<string, unknown>);
		} catch {
			/* skip */
		}
		if (filesOn) requestRender();
	});

	pi.on("tool_result", (event, ctx) => {
		if (!isMainAgent(ctx)) return;
		// Any tool may report a diff; key off the payload, not the discriminant.
		if (!isRecord(event.details)) return;
		const { details } = event;
		const diff = details.diff;
		if (typeof diff !== "string" || !diff) return;
		const input = isRecord(event.input) ? event.input : {};
		let filePath: string | undefined;
		if (typeof input.path === "string") filePath = input.path;
		else if (typeof details.path === "string") filePath = details.path;
		if (!filePath) return; // no resolvable path: keep the tool row's own diff
		setEditDiff(filePath, diff);
		requestRender();
	});
}

/** All eleven slash commands: toggles first, then band settings and
 * persistence. */
function registerCommands(pi: ExtensionAPI): void {
	registerPanelToggles(pi);
	registerGeometryCommand(pi);
	registerBandSettings(pi);
}

/** Panel on/off toggles: `/split`, the two band panels, the files column and
 * the diff subpanel. */
function registerPanelToggles(pi: ExtensionAPI): void {
	// ── panel toggles ──

	pi.registerCommand("split", {
		description: "Toggle all panels: off = bare layout, on = saved startup defaults",
		handler: async (_args, ctx) => {
			if (!requireTui(ctx)) return;
			if (thinkingOn || toolsOn || filesOn || trimResponse) {
				thinkingOn = false;
				toolsOn = false;
				filesOn = false;
				trimResponse = false;
				reconcile(ctx);
				syncTranscriptVisibility();
				notify("Split view off (all panels) · /split-save saves defaults");
				return;
			}
			const raw = loadUiPanelsConfig();
			const cfg = normalizeConfig(raw);
			if (!cfg.thinking && !cfg.tools && !cfg.files && !cfg.trimResponse) {
				thinkingOn = true;
				toolsOn = true;
			} else {
				// ON means the saved layout, size and geometry included.
				applySavedMetrics(raw, cfg);
				thinkingOn = cfg.thinking;
				toolsOn = cfg.tools;
				filesOn = cfg.files;
				showDiff = cfg.diff;
				trimResponse = cfg.trimResponse;
			}
			applyLayout(ctx);
			notify("Split view on (saved layout) · /split-save saves defaults");
		},
	});

	pi.registerCommand("split-thinking", {
		description: "Toggle the thinking panel within the band",
		handler: async (_args, ctx) => {
			if (!requireTui(ctx)) return;
			thinkingOn = !thinkingOn;
			applyLayout(ctx);
			const thinkingState = thinkingOn ? "on (transcript hidden)" : "off (transcript shown)";
			notify(thinkingOn || toolsOn ? `Thinking ${thinkingState}` : "Band off (no panels)");
		},
	});

	pi.registerCommand("split-tools", {
		description: "Toggle the tools panel within the band",
		handler: async (_args, ctx) => {
			if (!requireTui(ctx)) return;
			toolsOn = !toolsOn;
			reconcile(ctx);
			notify(`Tools ${toolsOn ? "on" : "off"}`);
		},
	});

	pi.registerCommand("files", {
		description: "Toggle the files panel within the band",
		handler: async (_args, ctx) => {
			if (!requireTui(ctx)) return;
			filesOn = !filesOn;
			reconcile(ctx);
			if (!filesOn) {
				notify("Files panel off");
				return;
			}
			const cols = tuiRef?.terminal.columns ?? 0;
			notify(
				cols > 0 && cols < MIN_TERM_WIDTH
					? `Files panel on — hidden below ${MIN_TERM_WIDTH} cols (now ${cols})`
					: "Files panel on",
				cols > 0 && cols < MIN_TERM_WIDTH ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("split-diff", {
		description: "Toggle the files panel's edit-diff subpanel",
		handler: async (_args, ctx) => {
			if (!requireTui(ctx)) return;
			showDiff = !showDiff;
			filesVersion++;
			requestRender();
			notify(`Edit diff ${showDiff ? "on" : "off"}`);
		},
	});
}

/** Accepted `/split-geometry` arguments; any other non-empty arg is rejected. */
function isGeometrySetting(value: string): value is GeometrySetting {
	return value === "auto" || value === "4k" || value === "wide";
}

/** Resolve the preset for the current terminal, re-derive an auto band height
 * from it, and report the geometry that resulted. */
function applyGeometry(ctx: ExtensionContext): void {
	const cols = tuiRef?.terminal.columns ?? 0;
	const rows = tuiRef?.terminal.rows ?? 0;
	geometryMode = resolveGeometryMode();
	if (bandHeightAuto && rows > 0)
		bandHeight = defaultBandHeight(rows, GEOMETRY_PROFILES[geometryMode]);
	bandCacheKey = "";
	applyLayout(ctx);
	const dock = clampedDockCols(cols);
	const label = geometrySetting === "auto" ? `auto (${geometryMode})` : geometryMode;
	notify(
		bandHeightAuto
			? `Geometry: ${label} — band ${bandHeight} rows, dock ${dock} cols`
			: `Geometry: ${label} — dock ${dock} cols, band height ${bandHeight} rows (pinned)`,
	);
}

/** `/split-geometry`: pin a preset, or hand the choice back to the terminal. */
function registerGeometryCommand(pi: ExtensionAPI): void {
	pi.registerCommand("split-geometry", {
		description: "Switch band/dock geometry preset: 4k ↔ wide (/split-geometry auto restores aspect-ratio detection)",
		handler: async (args, ctx) => {
			if (!requireTui(ctx)) return;
			const arg = String(args ?? "").trim().toLowerCase();
			if (arg !== "" && !isGeometrySetting(arg)) {
				notify("Invalid geometry (usage: /split-geometry auto|4k|wide)", "error");
				return;
			}
			// No argument pins the preset the layout is not using, so the
			// switch visibly flips the band even when `auto` picked it.
			const other: GeometrySetting = geometryMode === "4k" ? "wide" : "4k";
			geometrySetting = isGeometrySetting(arg) ? arg : other;
			applyGeometry(ctx);
		},
	});
}

/** Band geometry, tool-view depth, response-only and `/split-save`. */
function registerBandSettings(pi: ExtensionAPI): void {
	pi.registerCommand("split-tools-view", {
		description: "Toggle tool panel compact ↔ full detail",
		handler: async (_args, ctx) => {
			if (!requireTui(ctx)) return;
			toolMode = toolMode === "compact" ? "full" : "compact";
			toolsVersionCounter++;
			bandCacheKey = "";
			requestRender();
			notify(`Tool panel: ${toolMode}`);
		},
	});

	pi.registerCommand("split-height", {
		description: "Set the band height in rows (6-80, clamped to fit)",
		handler: async (args, ctx) => {
			if (!requireTui(ctx)) return;
			const limit =
				tuiRef?.terminal.rows === undefined ? MAX_BAND_HEIGHT : maxBandHeight(tuiRef.terminal.rows);
			const height = Number.parseInt(String(args ?? "").trim(), 10);
			if (Number.isNaN(height)) {
				notify(`Band height: ${bandHeight} rows (usage: /split-height ${MIN_BAND_HEIGHT}-${limit})`);
				return;
			}
			bandHeight = Math.max(MIN_BAND_HEIGHT, Math.min(limit, height));
			bandHeightAuto = false;
			bandCacheKey = "";
			applyLayout(ctx);
			notify(`Band height: ${bandHeight} rows`);
		},
	});

	pi.registerCommand("split-tools-width", {
		description: "Set tools panel width as % of the band (20-60, default 35)",
		handler: async (args, ctx) => {
			if (!requireTui(ctx)) return;
			const arg = String(args ?? "").trim();
			if (!arg) {
				notify(`Tools panel width: ${toolsWidthPct}% of the band (usage: /split-tools-width 20-60)`);
				return;
			}
			const pct = Number.parseInt(arg, 10);
			if (Number.isNaN(pct)) {
				notify("Invalid percentage (usage: /split-tools-width 20-60)", "error");
				return;
			}
			toolsWidthPct = Math.max(20, Math.min(60, pct));
			bandCacheKey = "";
			reconcile(ctx);
			notify(`Tools panel width: ${toolsWidthPct}%`);
		},
	});

	pi.registerCommand("split-trim-response", {
		description: "Full transcript ↔ response-only (hides thinking blocks and tool activity)",
		handler: async (args, ctx) => {
			if (!requireTui(ctx)) return;
			const arg = String(args ?? "").trim().toLowerCase();
			let next = !trimResponse;
			if (arg === "on") next = true;
			else if (arg === "off") next = false;
			trimResponse = next;
			syncTranscriptVisibility();
			if (visibilityUnsupported) {
				trimResponse = !next;
				notify("Response-only needs omp's hideThinkingBlock / display.hideToolActivity settings", "warning");
				return;
			}
			requestRender();
			notify(`Transcript: ${trimResponse ? "response only" : "full transcript"}`);
		},
	});

	pi.registerCommand("split-save", {
		description: "Save the current panel layout as the startup defaults",
		handler: async (_args, ctx) => {
			if (!requireTui(ctx)) return;
			const saved = saveUiPanelsConfig({
				split: thinkingOn || toolsOn,
				thinking: thinkingOn,
				tools: toolsOn,
				files: filesOn,
				toolMode,
				trimResponse,
				// An auto height belongs to the terminal; pinning today's derived
				// number would hide the band on a shorter screen at next startup.
				...(bandHeightAuto ? {} : { bandHeight }),
				toolsWidthPct,
				geometry: geometrySetting,
				...(filesWidth === null ? {} : { filesWidth }),
				diff: showDiff,
			});
			notify(
				saved
					? `Panel layout saved as startup defaults (${CONFIG_FILE})`
					: "Could not save panel layout (config write failed)",
				saved ? "info" : "error",
			);
		},
	});
}
