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
}

/** Strict boolean read — only real booleans count; absent or wrongly-typed
 * values (strings, numbers, objects, null) fall back to the same defaults as
 * a missing field, so bad JSON can never become an accidental truthy flag. */
function boolOr(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/** Normalize raw config with defaults (never throws). */
export function normalizeConfig(raw: UiPanelsConfig): Required<{
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
}> {
	// Tolerate any shape — a null root, an array or a primitive reads as an
	// empty config instead of throwing on property access.
	const root: UiPanelsConfig =
		typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
	const split = boolOr(root.split, false);
	const tm: ToolMode = root.toolMode === "full" ? "full" : "compact";
	// Only a real finite number is usable; Number(null) === 0 would otherwise
	// clamp to 6. Non-numeric/unusable values use the default.
	const rawHeight: unknown = root.bandHeight;
	const usableHeight =
		typeof rawHeight === "number" && Number.isFinite(rawHeight)
			? Math.trunc(rawHeight)
			: 20;
	const bandHeight = Math.max(MIN_BAND_HEIGHT, Math.min(MAX_BAND_HEIGHT, usableHeight));
	// toolsWidthPct — same strict typing as bandHeight (real finite number,
	// default 35 on garbage), clamped to 20–60.
	const rawPct: unknown = root.toolsWidthPct;
	const usablePct =
		typeof rawPct === "number" && Number.isFinite(rawPct) ? Math.trunc(rawPct) : 35;
	const toolsWidthPct = Math.max(20, Math.min(60, usablePct));
	// filesWidth: a real finite number ≥ 24 cols (capped at 200), else auto.
	const rawFw: unknown = root.filesWidth;
	const filesWidth =
		typeof rawFw === "number" && Number.isFinite(rawFw) && rawFw >= 24
			? Math.min(200, Math.trunc(rawFw))
			: null;
	return {
		split,
		thinking: split && boolOr(root.thinking, true),
		tools: split && boolOr(root.tools, true),
		files: boolOr(root.files, false),
		diff: boolOr(root.diff, true),
		toolMode: tm,
		trimResponse: boolOr(root.trimResponse, false),
		bandHeight,
		toolsWidthPct,
		filesWidth,
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
