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
 *   /split-height <n>           band height in rows (6-40)
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
import {
	MIN_DOCK_COLS,
	appendStreamTail,
	bandToolsColsFor,
	capDisplayLine,
	capToolText,
	dockColsFor,
	formatDuration,
	lastImageBlock,
	outputPreview,
	sanitizeText,
	transcriptVisibility,
	truncateInline,
	type ImageBlock,
	type TranscriptVisibility,
} from "./helpers.ts";
import {
	CONFIG_FILE,
	loadUiPanelsConfig,
	normalizeConfig,
	saveUiPanelsConfig,
	type ToolMode,
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
/** Rows the transcript + editor need; shorter terminals hide the band. */
const MIN_ROWS_BELOW_BAND = 18;
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
let toolsWidthPct = 35;
let filesWidth: number | null = null;

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
			this.blocks.push(this.current);
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
	image?: ImageBlock;
	diff?: string;
	startedAt?: number;
	endedAt?: number;
}

let toolsVersionCounter = 0;
const toolsBy = new Map<string, ToolEntry>();
const toolOrder: string[] = [];

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

function resultText(result: unknown): string {
	if (typeof result === "string") return capToolText(result);
	if (!isRecord(result)) return "";
	const content = result.content;
	if (typeof content === "string") return capToolText(sanitizeText(content));
	if (!Array.isArray(content)) return "";
	const text: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		text.push(block.text);
	}
	return capToolText(sanitizeText(text.join("")));
}

function argsJson(args: unknown): string {
	try {
		return capToolText(sanitizeText(JSON.stringify(args ?? {})));
	} catch {
		return "";
	}
}

function setToolOutput(entry: ToolEntry, text: string): void {
	const lines = capToolText(sanitizeText(text)).split(/\r?\n/);
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

function ingestToolResult(id: string, result: unknown, isError: boolean, endedAt?: number): void {
	const entry = toolsBy.get(id);
	if (!entry) return;
	if (endedAt !== undefined && entry.startedAt !== undefined) entry.endedAt = endedAt;
	const text = resultText(result);
	if (text) setToolOutput(entry, text);
	const fields = isRecord(result) ? result : {};
	const image = lastImageBlock(fields.content);
	if (image) entry.image = { data: image.data, mimeType: sanitizeText(image.mimeType) };
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

/** Panel rows for the tools view, styled, oldest first. */
function toolLines(theme: Theme, width: number): string[] {
	const out: string[] = [];
	const full = toolMode === "full";
	const textWidth = Math.max(8, width - 3);
	for (const id of toolOrder) {
		const entry = toolsBy.get(id);
		if (!entry) continue;
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
		out.push(prefix + args);
		if (!full) {
			if (out.length > 1) out.splice(out.length - 1, 0, "");
			continue;
		}
		const content = (entry.output || "")
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(Boolean);
		if (content.length === 0) {
			if (entry.active) out.push(theme.fg("dim", "  · …"));
		} else {
			const { shown, hidden } = outputPreview(content, 2);
			for (const line of shown) out.push(theme.fg("toolOutput", `  · ${truncateInline(line, textWidth - 4)}`));
			if (hidden > 0) out.push(theme.fg("dim", `  · +${hidden} more`));
		}
		if (entry.image) {
			const dims = getImageDimensions(entry.image.data, entry.image.mimeType) ?? undefined;
			out.push(theme.fg("toolOutput", `  · ${imageFallback(entry.image.mimeType, dims)}`));
		}
		if (entry.diff) {
			out.push("");
			for (const line of renderDiff(entry.diff, { theme }).split(/\r?\n/)) out.push(`    ${line}`);
		}
	}
	return out;
}

// ─── files buffer ────────────────────────────────────────────────────────────

interface FileEntry {
	path: string;
	ops: string;
	count: number;
}

const files = new Map<string, FileEntry>();
let filesVersion = 0;

function pathsFrom(toolName: string, input: Record<string, unknown>): { abs: string; op: string }[] {
	const out: { abs: string; op: string }[] = [];
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		for (const raw of command.split(/\s+/)) {
			// Both classes are anchored and single-width; sonarjs flags the `+$`
			// suffix as super-linear, which does not apply to a one-character class.
			// eslint-disable-next-line sonarjs/super-linear-regex
			const token = raw.replace(/^[("'`]+/, "").replace(/[)"'`;:,]+$/, "");
			if (!token || token.startsWith("-") || /[|&><`$*?]/.test(token)) continue;
			try {
				const abs = path.resolve(sessionCwd, token);
				if (existsSync(abs) && statSync(abs).isFile()) out.push({ abs, op: "s" });
			} catch {
				/* skip unreadable tokens */
			}
		}
		return out;
	}
	const add = (value: unknown, op: string, unconditional: boolean) => {
		if (typeof value !== "string" || !value) return;
		try {
			const abs = path.resolve(sessionCwd, value);
			if (!unconditional && (!existsSync(abs) || !statSync(abs).isFile())) return;
			out.push({ abs, op });
		} catch {
			/* skip */
		}
	};
	if (toolName === "read") {
		add(input.path, "r", true);
		return out;
	}
	if (toolName === "write" || toolName === "edit" || toolName === "ast_edit") {
		add(input.path, "w", true);
		return out;
	}
	for (const key of ["path", "filePath", "file_path", "imagePath"]) add(input[key], "r", false);
	for (const key of ["paths", "files", "filePaths"]) {
		if (Array.isArray(input[key])) for (const value of input[key]) add(value, "r", false);
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
	editDiff.diff = diff;
	editDiff.version++;
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
	lines: (width: number) => string[];
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
		lines: (width: number) => toolLines(theme, width),
		empty: "No tools called yet",
	};
}

/**
 * Newest-first line wrapping: only the items that fill `maxRows` are wrapped,
 * so a long history costs nothing per frame. Returns rows oldest-first.
 */
function newestRows(
	items: string[],
	textWidth: number,
	maxRows: number,
	style: (line: string) => string,
	memo: Map<string, string[]>,
	panel: string,
): string[] {
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

/** One framed panel: top border with title, exactly `bodyRows` body rows,
 * bottom border. Every line is exactly `width` display cells wide. */
function renderPanel(
	theme: Theme,
	def: BandDef,
	width: number,
	bodyRows: number,
	memo: Map<string, string[]>,
): string[] {
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
	const visible = newestRows(def.lines(width), textWidth, bodyRows, def.style, memo, def.title);
	const bodyRow = (text: string) => {
		// Clip, don't just pad: wrapped lines and empty-state hints can be
		// wider than a narrow panel, and an over-wide row corrupts the frame.
		const clipped = truncateToWidth(text, textWidth);
		return `${theme.fg("border", "│")} ${clipped}${" ".repeat(Math.max(0, textWidth - visibleWidth(clipped)))}${theme.fg("border", "│")}`;
	};
	const out = [top];
	if (visible.length === 0) {
		out.push(bodyRow(theme.fg("dim", def.empty)));
	} else {
		for (let i = 0; i < bodyRows; i++) out.push(bodyRow(visible[i] ?? ""));
	}
	while (out.length < bodyRows + 1) out.push(bodyRow(""));
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
		filesVersion,
		editDiff.version,
		toolMode,
		thinking.version,
		toolsVersionCounter,
		fingerprint,
	].join(":");
	if (key === bandCacheKey) return bandCache;

	const ids: PanelId[] = [];
	if (thinkingOn) ids.push("thinking");
	if (toolsOn) ids.push("tools");
	// A files column needs room for its frame plus something beside it.
	const filesWidthCols =
		filesOn && width >= MIN_TERM_WIDTH
			? Math.max(MIN_DOCK_COLS, Math.min(dockColsFor(width, filesWidth), width - 40))
			: 0;
	if (filesWidthCols > 0) ids.push("files");
	if (ids.length === 0) return [];

	let lines: string[];
	if (ids.length === 1) {
		const only = ids[0];
		lines =
			only === "files"
				? filesPanelLines(theme, width, bandHeight)
				: renderPanel(theme, bandDef(theme, only), width, bodyRows, bandMemo);
	} else {
		// Widths are allocated right to left: files keeps its dock width, then
		// the thinking | tools split divides the remainder.
		const widths = new Map<PanelId, number>();
		let remaining = width;
		if (filesWidthCols > 0) {
			widths.set("files", filesWidthCols);
			remaining -= filesWidthCols;
		}
		if (thinkingOn && toolsOn) {
			const toolsWidth = bandToolsColsFor(remaining, toolsWidthPct);
			widths.set("thinking", remaining - toolsWidth);
			widths.set("tools", toolsWidth);
		} else {
			const only = thinkingOn ? "thinking" : "tools";
			widths.set(only, remaining);
		}
		const parts = ids.map(id => {
			const panelWidth = widths.get(id) ?? remaining;
			if (id === "files") return filesPanelLines(theme, panelWidth, bandHeight);
			return renderPanel(theme, bandDef(theme, id), panelWidth, bodyRows, bandMemo);
		});
		lines = parts[0].map((line, index) => line + parts.slice(1).map(part => part[index] ?? "").join(""));
	}
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

/**
 * Framed files panel: touched files plus the edit-diff subpanel, sized to the
 * band. It is a band column rather than a floating dock: omp composites
 * overlays over the whole viewport (band and editor included), so an overlay
 * dock would cover the band instead of sitting beside the transcript.
 */
function filesPanelLines(theme: Theme, width: number, height: number): string[] {
	const inner = Math.max(1, width - 2);
	const pad = (text: string) => text + " ".repeat(Math.max(0, inner - visibleWidth(text)));
	const row = (content: string) =>
		theme.fg("border", "│") + pad(truncateToWidth(content, inner)) + theme.fg("border", "│");

	const entries = recentEntries();
	// A tall enough panel splits into list and diff; a short one keeps the list.
	const withDiff = showDiff && height >= 10;
	const listRows = withDiff ? Math.max(3, Math.floor(height / 2) - 4) : Math.max(1, height - 4);
	const diffRows = withDiff ? Math.max(0, height - listRows - 6) : 0;

	const meta = (entry: FileEntry) => {
		const count = entry.count > 1 ? `×${entry.count}` : "";
		return theme.fg("muted", `${entry.ops}${count}`);
	};

	const rows: { line: string; files: number }[] = [];
	let i = 0;
	while (i < entries.length) {
		const dir = path.dirname(entries[i].path);
		let j = i;
		while (j < entries.length && path.dirname(entries[j].path) === dir) j++;
		const run = entries.slice(i, j);
		if (run.length > 3) {
			const label = sanitizeText(displayPath(dir));
			const groupTitle = label === "." ? "./" : `${label}/`;
			rows.push({
				line: row(` ${theme.fg("accent", groupTitle)}`),
				files: 0,
			});
			for (const entry of run)
				rows.push({ line: row(`   ${meta(entry)} ${theme.fg("text", sanitizeText(path.basename(entry.path)))}`), files: 1 });
		} else {
			for (const entry of run)
				rows.push({ line: row(` ${meta(entry)} ${theme.fg("text", sanitizeText(path.basename(entry.path)))}`), files: 1 });
		}
		i = j;
	}

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
	if (entries.length === 0) body.push(row(` ${theme.fg("dim", "No files touched yet")}`));
	else if (entries.length > filesShown && body.length < listRows) {
		const hiddenFiles = `… +${entries.length - filesShown} more`;
		body.push(row(` ${theme.fg("dim", hiddenFiles)}`));
	}
	if (body.length < listRows) body.push(row(` ${theme.fg("dim", LEGEND)}`));
	while (body.length < listRows) body.push(row(""));

	const diffBody: string[] = [];
	if (withDiff) {
		diffBody.push(theme.fg("border", `├${"─".repeat(inner)}┤`));
		const title = editDiff.path
			? theme.fg("accent", ` ✎ ${truncateToWidth(sanitizeText(displayPath(editDiff.path)), inner - 4)} `)
			: theme.fg("dim", " Last Edit ");
		diffBody.push(
			theme.fg("border", "│") +
				title +
				theme.fg("border", "─".repeat(Math.max(0, inner - visibleWidth(title)))) +
				theme.fg("border", "│"),
		);
		if (editDiff.diff) {
			const rendered = renderDiff(editDiff.diff, { theme, filePath: editDiff.path }).split(/\r?\n/);
			const shown = rendered.slice(0, Math.max(0, diffRows - 1));
			for (const line of shown) diffBody.push(row(` ${line}`));
			if (rendered.length > shown.length && diffRows > 0) {
				const hiddenLines = `… +${rendered.length - shown.length} more`;
				diffBody.push(row(` ${theme.fg("dim", hiddenLines)}`));
			}
		} else if (diffRows > 0) {
			diffBody.push(row(` ${theme.fg("dim", "No edit yet")}`));
		}
		while (diffBody.length < diffRows + 2) diffBody.push(row(""));
	}

	const filesTitle = `📂 Files (${entries.length})`;
	return [
		theme.fg("border", `╭${"─".repeat(inner)}╮`),
		row(` ${theme.fg("accent", filesTitle)}`),
		theme.fg("border", `├${"─".repeat(inner)}┤`),
		...body,
		...diffBody,
		theme.fg("border", `╰${"─".repeat(inner)}╯`),
	];
}

// ─── mount / unmount ─────────────────────────────────────────────────────────

function mountWidget(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || widgetMounted) return;
	widgetMounted = true;
	ctx.ui.setWidget(
		WIDGET_KEY,
		tui => {
			tuiRef = tui;
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
	requestRender();
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
 * Mirror the panel layout onto omp's transcript switches: a visible thinking
 * panel hides thinking blocks, response-only hides thinking and tool activity.
 * Overrides are runtime-only; turning a switch off clears the override so the
 * user's own configured value applies again.
 */
function syncTranscriptVisibility(force = false): void {
	if (!api || visibilityUnsupported) return;
	const applied = visibilityRegistry.applied;
	const policy = desiredVisibility();
	if (applied && sameVisibility(applied, policy) && !force) return;
	// Nothing owned yet and nothing to hide: leave the user's settings alone.
	if (!policy.hideThinking && !policy.hideTools && applied === null) return;

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
	if (visibilitySyncPending || visibilityUnsupported || !api) return;
	const applied = visibilityRegistry.applied;
	const policy = desiredVisibility();
	if (applied && sameVisibility(applied, policy)) return;
	if (!policy.hideThinking && !policy.hideTools && applied === null) return;
	visibilitySyncPending = true;
	setTimeout(() => {
		visibilitySyncPending = false;
		syncTranscriptVisibility();
	}, 0);
}

// ─── branch reconstruction ───────────────────────────────────────────────────

function reconstruct(ctx: ExtensionContext): void {
	thinking.reset();
	toolsBy.clear();
	toolOrder.length = 0;
	toolsVersionCounter++;
	files.clear();
	filesVersion++;
	clearEditDiff();
	sessionCwd = ctx.cwd || process.cwd();

	const thoughts: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type === "thinking" && typeof block.thinking === "string") thoughts.push(block.thinking);
				if (block.type !== "toolCall") continue;
				try {
					// Rebuild through the same ingest path live events use.
					ingestToolCall(block.id, block.name, block.arguments);
					record(block.name, block.arguments ?? {});
				} catch {
					/* skip malformed call */
				}
			}
			continue;
		}
		if (msg.role !== "toolResult") continue;
		try {
			ingestToolResult(msg.toolCallId, msg, msg.isError);
			const details = isRecord(msg.details) ? msg.details : {};
			if (msg.toolName === "edit" && typeof details.diff === "string" && details.diff)
				setEditDiff(typeof details.path === "string" ? details.path : editDiff.path, details.diff);
		} catch {
			/* skip malformed result */
		}
	}
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

	const requireTui = (ctx: ExtensionContext): boolean => {
		if (ctx.mode !== "tui") {
			notify("Split view requires the interactive TUI", "error");
			return false;
		}
		return true;
	};

	pi.on("session_start", (_event, ctx) => {
		notifyFn = (message, level) => ctx.ui.notify(message, level);
		themeGetter = () => ctx.ui.theme;

		let cfg = normalizeConfig(loadUiPanelsConfig());
		if (pi.getFlag("no-split")) {
			cfg = { ...cfg, split: false, thinking: false, tools: false, files: false, trimResponse: false };
		}
		thinkingOn = cfg.thinking;
		toolsOn = cfg.tools;
		toolMode = cfg.toolMode;
		bandHeight = cfg.bandHeight;
		toolsWidthPct = cfg.toolsWidthPct;
		filesWidth = cfg.filesWidth;
		filesOn = cfg.files;
		showDiff = cfg.diff;
		trimResponse = cfg.trimResponse;

		reconstruct(ctx);
		if (ctx.mode === "tui") {
			if (thinkingOn || toolsOn || filesOn) mountWidget(ctx);
			// Forced: a fresh session must not trust a previous generation's
			// recorded override state.
			syncTranscriptVisibility(true);
			requestRender();
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		reconstruct(ctx);
		requestRender();
	});
	pi.on("session_switch", (_event, ctx) => {
		reconstruct(ctx);
		requestRender();
	});

	pi.on("message_update", event => {
		const delta = event.assistantMessageEvent;
		if (delta) {
			if (delta.type === "thinking_start") thinking.start();
			else if (delta.type === "thinking_delta") thinking.append(delta.delta ?? "");
			else if (delta.type === "thinking_end") thinking.end(delta.content ?? "");
		}
		if (thinkingOn) requestRender();
	});

	pi.on("tool_execution_start", event => {
		ingestToolCall(event.toolCallId, event.toolName, event.args, Date.now());
		if (toolsOn) requestRender();
	});
	pi.on("tool_execution_update", event => {
		const entry = toolsBy.get(event.toolCallId);
		if (entry) {
			setToolOutput(entry, resultText(event.partialResult));
			markToolsDirty();
		}
	});
	pi.on("tool_execution_end", event => {
		ingestToolResult(event.toolCallId, event.result, event.isError, Date.now());
		if (toolsOn) requestRender();
	});

	pi.on("tool_call", event => {
		try {
			record(event.toolName, (event.input ?? {}) as Record<string, unknown>);
		} catch {
			/* skip */
		}
		if (filesOn) requestRender();
	});

	pi.on("tool_result", event => {
		// Custom tools share this union with a string toolName, so narrow on the
		// payload instead of trusting the discriminant alone.
		if (event.toolName !== "edit" || !isRecord(event.details)) return;
		const { details } = event;
		const diff = details.diff;
		if (typeof diff !== "string" || !diff) return;
		let filePath = editDiff.path;
		if (typeof event.input.path === "string") filePath = event.input.path;
		else if (typeof details.path === "string") filePath = details.path;
		setEditDiff(filePath, diff);
		requestRender();
	});

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
		unmountWidget(ctx);
		notifyFn = null;
	});

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
			const cfg = normalizeConfig(loadUiPanelsConfig());
			if (!cfg.thinking && !cfg.tools && !cfg.files && !cfg.trimResponse) {
				thinkingOn = true;
				toolsOn = true;
			} else {
				thinkingOn = cfg.thinking;
				toolsOn = cfg.tools;
				filesOn = cfg.files;
				showDiff = cfg.diff;
				trimResponse = cfg.trimResponse;
			}
			reconcile(ctx);
			syncTranscriptVisibility();
			notify("Split view on (saved layout) · /split-save saves defaults");
		},
	});

	pi.registerCommand("split-thinking", {
		description: "Toggle the thinking panel within the band",
		handler: async (_args, ctx) => {
			if (!requireTui(ctx)) return;
			thinkingOn = !thinkingOn;
			reconcile(ctx);
			syncTranscriptVisibility();
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
		description: "Set the band height in rows (6-40)",
		handler: async (args, ctx) => {
			if (!requireTui(ctx)) return;
			const height = Number.parseInt(String(args ?? "").trim(), 10);
			if (Number.isNaN(height)) {
				notify(`Band height: ${bandHeight} rows (usage: /split-height 6-40)`);
				return;
			}
			bandHeight = Math.max(6, Math.min(40, height));
			bandCacheKey = "";
			reconcile(ctx);
			syncTranscriptVisibility();
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
			notify(`Panel C: ${trimResponse ? "response only" : "full transcript"}`);
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
				bandHeight,
				toolsWidthPct,
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
