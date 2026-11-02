/**
 * ui-panels-config.ts — shared persistent config for the unified split-view
 * extension (thinking / tools / files panels). Stored at
 * ~/.omp/agent/ui-panels.json (honoring PI_CODING_AGENT_DIR).
 *
 * Defaults: thinking and tools default ON (when `split` is on); files defaults OFF.
 * `toolMode` defaults to "compact".
 *
 * IMPORTANT: the JSON on disk is a TEMPLATE of startup defaults, NOT live
 * state. Toggle commands only mutate in-process state (session-local); only
 * /split-save writes the current layout back to disk. This keeps concurrent
 * omp windows from clobbering each other's panels.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { MAX_BAND_HEIGHT, MIN_BAND_HEIGHT } from "./helpers.ts";

const CONFIG_PATH = path.join(
	process.env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), ".omp", "agent"),
	"ui-panels.json",
);

export type ToolMode = "compact" | "full";

/** Persisted geometry preset: `4k` (taller band, narrow dock), `wide` (short
 * band, wide dock), or `auto` — the terminal aspect ratio decides. */
export type GeometrySetting = "auto" | "4k" | "wide";

export interface UiPanelsConfig {
	/** Master: is the band (thinking | tools above the editor) active. */
	split?: boolean;
	/** Thinking panel within the band. Defaults to true when absent. */
	thinking?: boolean;
	/** Tools panel within the band. Defaults to true when absent. */
	tools?: boolean;
	/** Files panel inside the band, beside thinking | tools. */
	files?: boolean;
	/** Files panel edit-diff subpanel. Defaults to true when absent. */
	diff?: boolean;
	/** Tool panel detail mode. */
	toolMode?: ToolMode;
	/** Response-only transcript (hides thinking blocks and tool activity). */
	trimResponse?: boolean;
	/** Band height in rows (6–80, default 20, scaled to the terminal height
	 * when absent). */
	bandHeight?: number;
	/** Tools panel's share of the band width in percent (20–60, default 35). */
	toolsWidthPct?: number;
	/** Files panel width in columns. Absent = auto (25% of the terminal, 34–120 cols). */
	filesWidth?: number;
	/** Layout preset; "auto" picks 4k vs wide from the terminal aspect ratio. */
	geometry?: GeometrySetting;
}

/** Strict boolean read — only real booleans count; absent or wrongly-typed
 * values (strings, numbers, objects, null) fall back to the same defaults as
 * a missing field, so bad JSON can never become an accidental truthy flag. */
function boolOr(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/** Optional integer read: a real finite number truncates, anything else
 * (including `null`, which `Number()` would turn into 0) yields null. */
function intOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

/** Tolerate any shape: a null root, an array or a primitive reads as an empty
 * config instead of throwing on property access. */
function plainConfig(raw: unknown): UiPanelsConfig {
	return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as UiPanelsConfig) : {};
}

/** Strict literals: anything else falls back to the documented default. */
function toolModeOf(value: unknown): ToolMode {
	return value === "full" ? "full" : "compact";
}

function geometryOf(value: unknown): GeometrySetting {
	return value === "4k" || value === "wide" ? value : "auto";
}

/** Every field resolved to its documented default. */
export type NormalizedUiPanelsConfig = Required<{
	split: boolean;
	thinking: boolean;
	tools: boolean;
	files: boolean;
	diff: boolean;
	toolMode: ToolMode;
	trimResponse: boolean;
	bandHeight: number;
	toolsWidthPct: number;
	filesWidth: number | null;
	geometry: GeometrySetting;
}>;

/** Normalize raw config with defaults (never throws). */
export function normalizeConfig(raw: UiPanelsConfig): NormalizedUiPanelsConfig {
	const root = plainConfig(raw);
	const split = boolOr(root.split, false);
	// Absent or garbage geometry (including a config written before the key
	// existed) means "auto".
	const geometry = geometryOf(root.geometry);
	// Unusable heights/percentages use the documented defaults; usable ones
	// clamp to their bounds. `Number(null) === 0` must not read as "minimum".
	const bandHeight = Math.max(
		MIN_BAND_HEIGHT,
		Math.min(MAX_BAND_HEIGHT, intOrNull(root.bandHeight) ?? 20),
	);
	const toolsWidthPct = Math.max(20, Math.min(60, intOrNull(root.toolsWidthPct) ?? 35));
	// filesWidth: a real finite number ≥ 24 cols (capped at 200), else auto.
	const rawFw = intOrNull(root.filesWidth);
	const filesWidth = rawFw !== null && rawFw >= 24 ? Math.min(200, rawFw) : null;
	return {
		split,
		thinking: split && boolOr(root.thinking, true),
		tools: split && boolOr(root.tools, true),
		files: boolOr(root.files, false),
		diff: boolOr(root.diff, true),
		toolMode: toolModeOf(root.toolMode),
		trimResponse: boolOr(root.trimResponse, false),
		bandHeight,
		toolsWidthPct,
		filesWidth,
		geometry,
	};
}

export function loadUiPanelsConfig(): UiPanelsConfig {
	try {
		// Validate the parsed root is a plain object before casting; JSON null,
		// arrays or primitives fall back to defaults.
		const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return parsed as UiPanelsConfig;
	} catch {
		return {};
	}
}

/** Persist the config. Returns whether the write actually succeeded instead of
 * swallowing the error, so callers can report the real outcome. The write goes
 * to a pid-scoped temp file and is renamed into place: a crash mid-write cannot
 * leave truncated JSON, and a fresh agent directory is created on demand. */
export function saveUiPanelsConfig(cfg: UiPanelsConfig): boolean {
	const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
	try {
		mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(tmp, JSON.stringify(cfg, null, 2));
		renameSync(tmp, CONFIG_PATH);
		return true;
	} catch {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* best effort: never break the extension on a config write failure */
		}
		return false;
	}
}

/** Path of the config file (referenced by /split-save messaging). */
export const CONFIG_FILE = CONFIG_PATH;

/**
 * This module is a shared utility imported by split-view.ts. omp auto-discovers
 * every *.ts file in an extensions dir as an extension and requires a default
 * factory export, so expose a no-op one here.
 */
export default function (_pi: ExtensionAPI) {
	/* no-op: this is a shared config module, not a real extension */
}
