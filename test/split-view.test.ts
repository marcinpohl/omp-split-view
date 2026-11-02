import { afterAll, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fc from "fast-check";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { Settings, settings, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import "@oh-my-pi/pi-coding-agent/session/settings";
import "@oh-my-pi/pi-coding-agent/modes/settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import splitView, {
	panelRenderCounts,
	retainedEditDiff,
	retainedThinkingBlocks,
	retainedToolEntries,
} from "../split-view.ts";
import {
	GEOMETRY_PROFILES,
	MAX_BAND_HEIGHT,
	MAX_DIFF_CHARS,
	MAX_DIFF_LINES,
	MIN_BAND_HEIGHT,
	MIN_DOCK_COLS,
	MIN_ROWS_BELOW_BAND,
	autoGeometryMode,
	bandToolsColsFor,
	defaultBandHeight,
	dockColsFor,
	maxBandHeight,
	sanitizeText,
	type GeometryProfile,
} from "../helpers.ts";
import { CONFIG_FILE, loadUiPanelsConfig, normalizeConfig, saveUiPanelsConfig } from "../ui-panels-config.ts";

/** Identity colorizer: keeps row geometry measurable without a live theme. */
const flatTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	inverse: (text: string) => text,
};

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): readonly string[] };
/** What the host holds for the band: a Component with the optional invalidate. */
interface BandComponent {
	render(width: number): readonly string[];
	invalidate(): void;
}

type AgentIdentity = { kind: "main" | "sub"; id: string; name: string };

const MAIN_AGENT: AgentIdentity = { kind: "main", id: "Main", name: "main" };
const ADVISOR_AGENT: AgentIdentity = { kind: "sub", id: "advisor", name: "advisor" };

interface Harness {
	emit: (event: string, payload?: unknown, agent?: AgentIdentity) => Promise<void>;
	command: (name: string, args?: string) => Promise<void>;
	widget: () => { render(width: number): readonly string[] } | undefined;
	/** Swap the theme `ctx.ui.theme` returns (cache-invalidation tests). */
	setTheme: (theme: unknown) => void;
	/** Swap the settings singleton the extension writes overrides into. */
	setSettings: (value: unknown) => void;
	/** Branch the session manager replays for resume/branch-switch tests. */
	setBranch: (branch: unknown[]) => void;
	/** The widget instance the host holds, for Component-contract calls. */
	component: () => BandComponent | undefined;
	/** Text of an extension status entry (`ctx.ui.setStatus`). */
	status: (key: string) => string | undefined;
	notifications: { message: string; level: string }[];
	widgets: Map<string, WidgetFactory | undefined>;
	setSize: (columns: number, rows: number) => void;
	/** session_start followed by /split (empty saved layout -> thinking + tools). */
	start: () => Promise<void>;
}

/**
 * One harness for the whole file: the extension keeps process-global state
 * because omp has one interactive TUI per process. A single mounted instance
 * models that; each test drives it through commands/events.
 */
function createHarness(columns = 120, rows = 45): Harness {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const widgets = new Map<string, WidgetFactory | undefined>();
	// omp calls a widget factory once at mount and keeps the component; the
	// harness must do the same or mount-only derivations (auto band height,
	// geometry resolution) are silently re-run on every render.
	const components = new Map<string, BandComponent>();

	const notifications: { message: string; level: string }[] = [];
	const statuses = new Map<string, string>();
	let branch: unknown[] = [];

	const tui = {
		terminal: { columns, rows },
		requestRender: () => {},
		getMutableViewport: () => ({ top: 0, length: tui.terminal.rows - 4 }),
	};

	let currentTheme: unknown = flatTheme;
	const ctx = {
		mode: "tui",
		cwd: "/tmp",
		agent: MAIN_AGENT,
		sessionManager: { getBranch: () => branch },
		ui: {
			get theme() {
				return currentTheme;
			},
			notify: (message: string, level: string) => {
				notifications.push({ message, level });
			},
			setStatus: (key: string, text: string | undefined) => {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			setWidget: (key: string, content: WidgetFactory | undefined) => {
				widgets.set(key, content);
				// omp invokes the factory synchronously at mount and holds the
				// returned component; unmounting clears it.
				if (content) components.set(key, content(tui, flatTheme) as BandComponent);
				else components.delete(key);
			},
		},
	};

	// Swappable so a test can model a build/settings object that throws.
	const pi: { settings: unknown } = { settings };
	const api = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		registerCommand: (name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			commands.set(name, definition.handler);
		},
		registerFlag: () => {},
		getFlag: () => false,
		setLabel: () => {},
		pi,
		events: { on: () => () => {} },
	};

	splitView(api as unknown as ExtensionAPI);

	const emit = async (event: string, payload: unknown = {}, agent: AgentIdentity = MAIN_AGENT) => {
		ctx.agent = agent;
		const handler = handlers.get(event);
		if (handler) await handler(payload, ctx as unknown as ExtensionContext);
	};
	const command = async (name: string, args = "") => {
		ctx.agent = MAIN_AGENT;
		const handler = commands.get(name);
		if (!handler) throw new Error(`command not registered: ${name}`);
		await handler(args, ctx as unknown as ExtensionContext);
	};

	return {
		emit,
		command,
		widget: () => components.get("split-view"),
		setTheme: theme => {
			currentTheme = theme;
		},
		setSettings: value => {
			pi.settings = value;
		},
		setBranch: next => {
			branch = next;
		},
		component: () => components.get("split-view"),
		status: key => statuses.get(key),
		notifications,
		widgets,
		setSize: (nextColumns, nextRows) => {
			tui.terminal.columns = nextColumns;
			tui.terminal.rows = nextRows;
		},
		start: async () => {
			await emit("session_start");
			await command("split");
		},
	};
}

function assertExactWidth(lines: readonly string[], width: number): void {
	lines.forEach((line, index) => {
		expect({ index, width: visibleWidth(line) }).toEqual({ index, width });
	});
}

/** Cell offsets of each panel's top-left corner in a composed row, so a test
 * can pin the width allocation rather than just the total row width. */
function columnStarts(line: string): number[] {
	const starts: number[] = [];
	let width = 0;
	for (const ch of line) {
		if (ch === "╭") starts.push(width);
		width += visibleWidth(ch);
	}
	return starts;
}

function effective(id: string): unknown {
	const handle = lookup(id);
	expect(handle).toBeDefined();
	return handle!.get(settings);
}

const tick = () => new Promise(resolve => setTimeout(resolve, 10));

const h = createHarness();

const writeConfig = (cfg: unknown) => writeFileSync(CONFIG_FILE, JSON.stringify(cfg));
/** Full layout used by the geometry suites; every panel on, diff on. */
const fullLayout = { split: true, thinking: true, tools: true, files: true, diff: true };

/** Toggle-style commands announce the new state; drive them to a known one. */
const setToggle = async (command: string, message: RegExp) => {
	await h.command(command);
	if (!message.test(h.notifications.at(-1)?.message ?? "")) await h.command(command);
};

/** `session_tree` rebuilds every buffer from the branch, leaving layout alone;
 * the default empty branch clears the panels and bumps every version. */
const resetBuffers = async (branch: unknown[] = []) => {
	h.setBranch(branch);
	await h.emit("session_tree");
};

/** Mount a panel when its header is absent (label-based, for plain toggles). */
const ensurePanel = async (label: string, command: string) => {
	if (h.widget()?.render(120).join("\n").includes(label)) return;
	await h.command(command);
};

describe("band widget", () => {
	beforeAll(async () => {
		await Settings.init();
		await h.start();
	});

	test("mounts and composes thinking | tools at exact width", () => {
		const lines = h.widget()!.render(120);
		expect(lines.length).toBe(20);
		assertExactWidth(lines, 120);
		expect(lines[0]).toContain("Thinking");
		expect(lines[0]).toContain("Tool Usage");
		expect(lines[0].startsWith("╭")).toBe(true);
		expect(lines.at(-1)!.startsWith("╰")).toBe(true);
	});

	test("streamed thinking and tool results reach the panels", async () => {
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "pondering the port" } });
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_end", content: "pondering the port" } });
		await h.emit("tool_execution_start", {
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "echo hello" },
		});
		await h.emit("tool_execution_end", {
			toolCallId: "t1",
			result: { content: [{ type: "text", text: "hello world" }] },
			isError: false,
		});
		const compact = h.widget()!.render(120);
		assertExactWidth(compact, 120);
		expect(compact.join("\n")).toContain("pondering the port");
		expect(compact.join("\n")).toContain("bash");
		expect(compact.join("\n")).not.toContain("hello world");

		await h.command("split-tools-view");
		const full = h.widget()!.render(120).join("\n");
		expect(full).toContain("hello world");
		await h.command("split-tools-view");
	});

	test("short terminals hide the band and give transcript thinking back", async () => {
		h.setSize(120, 24);
		expect(h.widget()!.render(120)).toEqual([]);
		await tick();
		expect(effective("hideThinkingBlock")).toBe(false);
		h.setSize(120, 45);
		h.widget()!.render(120);
		await tick();
		expect(effective("hideThinkingBlock")).toBe(true);
	});

	test("/split-thinking off leaves only the tools panel", async () => {
		await h.command("split-thinking");
		const lines = h.widget()!.render(120);
		assertExactWidth(lines, 120);
		expect(lines[0]).not.toContain("Thinking");
		expect(lines[0]).toContain("Tool Usage");
		// Thinking blocks come back to the transcript with the panel gone.
		expect(effective("hideThinkingBlock")).toBe(false);
		await h.command("split-thinking");
		expect(effective("hideThinkingBlock")).toBe(true);
	});

	test("response-only hides both, and turning it off restores the panel policy", async () => {
		await h.command("split-trim-response", "on");
		expect(effective("hideThinkingBlock")).toBe(true);
		expect(effective("display.hideToolActivity")).toBe(true);
		await h.command("split-trim-response", "off");
		expect(effective("hideThinkingBlock")).toBe(true);
		expect(effective("display.hideToolActivity")).toBe(false);
		await h.command("split-thinking");
		expect(effective("hideThinkingBlock")).toBe(false);
		await h.command("split-thinking");
		await tick();
		expect(effective("hideThinkingBlock")).toBe(true);
	});
});

describe("files panel", () => {
	test("adds a files column beside thinking | tools", async () => {
		await h.command("files");
		const lines = h.widget()!.render(120);
		assertExactWidth(lines, 120);
		const joined = lines.join("\n");
		expect(joined).toContain("Thinking");
		expect(joined).toContain("Tool Usage");
		expect(joined).toContain("📂 Files (0)");
		expect(joined).toContain("No files touched yet");
	});

	test("tracks files touched by tool calls and shows the edit diff", async () => {
		await h.emit("tool_call", { toolName: "read", input: { path: "/tmp/omp-split-view/split-view.ts" } });
		await h.emit("tool_execution_start", { toolCallId: "e1", toolName: "edit", args: { path: "a.ts" } });
		await h.emit("tool_result", {
			toolName: "edit",
			toolCallId: "e1",
			input: { path: "/tmp/omp-split-view/split-view.ts" },
			details: { diff: "@@ -1 +1 @@\n-old line\n+new line" },
		});
		const lines = h.widget()!.render(120);
		assertExactWidth(lines, 120);
		const joined = lines.join("\n");
		expect(joined).toContain("Files (1)");
		expect(joined).toContain("split-view.ts");
		expect(joined).toContain("✎ omp-split-view/split-view.ts");
		expect(joined).toContain("new line");
	});

	test("edit diff can be hidden while the list stays", async () => {
		await h.command("split-diff");
		const joined = h.widget()!.render(120).join("\n");
		expect(joined).toContain("Files (1)");
		expect(joined).not.toContain("Last Edit");
		await h.command("split-diff");
	});

	test("a compact band still renders the tracked file", async () => {
		// Regression: heights 10–13 gave the list zero rows, rendering only
		// "… +1 more" instead of the tracked filename.
		for (const height of [12, 6]) {
			await h.command("split-height", String(height));
			const lines = h.widget()!.render(120);
			expect(lines.length).toBe(height);
			assertExactWidth(lines, 120);
			// A list row, not the diff title ("✎ omp-split-view/split-view.ts").
			expect(lines.join("\n")).toMatch(/│\s*[a-z]+(?:×\d+)?\s+split-view\.ts/);
		}
		await h.command("split-height", "20");
	});

	test("a files-only layout renders the files panel alone", async () => {
		await h.command("split-thinking");
		await h.command("split-tools");
		const lines = h.widget()!.render(120);
		expect(lines.length).toBe(20);
		assertExactWidth(lines, 120);
		const joined = lines.join("\n");
		expect(joined).toContain("📂 Files (1)");
		expect(joined).not.toContain("Tool Usage");
		await h.command("split-thinking");
		await h.command("split-tools");
	});

	test("a short band keeps the files list without the diff section", async () => {
		await h.command("split-height", "6");
		const lines = h.widget()!.render(120);
		expect(lines.length).toBe(6);
		assertExactWidth(lines, 120);
		const joined = lines.join("\n");
		expect(joined).toContain("📂 Files (1)");
		expect(joined).not.toContain("Last Edit");
		await h.command("split-height", "20");
	});

	test("the files column hides below the minimum terminal width", async () => {
		h.setSize(80, 45);
		const joined = h.widget()!.render(80).join("\n");
		expect(joined).not.toContain("📂 Files");
		assertExactWidth(h.widget()!.render(80), 80);
		h.setSize(120, 45);
		await h.command("files");
	});
});

describe("band properties", () => {
	beforeAll(async () => {
		h.setSize(120, 45);
		await h.command("split-height", "20");
		await ensurePanel("Thinking", "split-thinking");
		await ensurePanel("Tool Usage", "split-tools");
		await ensurePanel("📂 Files", "files");
		const joined = h.widget()!.render(120).join("\n");
		expect(joined).toContain("Thinking");
		expect(joined).toContain("Tool Usage");
		expect(joined).toContain("📂 Files");
	});

	test("every terminal width and band height renders exact geometry", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 40, max: 300 }),
				fc.integer({ min: 6, max: 40 }),
				async (width, height) => {
					h.setSize(width, 60);
					await h.command("split-height", String(height));
					const lines = h.widget()!.render(width);
					expect(lines.length).toBe(height);
					lines.forEach(line => {
						expect(visibleWidth(line)).toBe(width);
						expect(line).not.toContain("\n");
						expect(line).not.toContain("\r");
					});
					expect(lines.join("\n").includes("📂 Files")).toBe(width >= 90);
				},
			),
			{ numRuns: 80, seed: 20261101 },
		);
		h.setSize(120, 45);
		await h.command("split-height", "20");
	});

	test("/split-height fits the band to the terminal and never hides it silently", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 18, max: 120 }),
				fc.integer({ min: 1, max: 200 }),
				async (rows, requested) => {
					h.setSize(120, rows);
					await h.command("split-height", String(requested));
					// The command clamps to what still leaves the transcript and
					// editor their rows (and caps at MAX_BAND_HEIGHT).
					const limit = Math.max(6, Math.min(80, rows - 18));
					const applied = Math.max(6, Math.min(limit, requested));
					const fits = rows - applied >= 18;
					const lines = h.widget()!.render(120);
					expect(lines.length).toBe(fits ? applied : 0);
					if (fits) assertExactWidth(lines, 120);
				},
			),
			{ numRuns: 60, seed: 20261101 },
		);
		h.setSize(120, 45);
		await h.command("split-height", "20");
	});

	test("re-rendering any width sequence reuses identical rows", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.integer({ min: 40, max: 240 }), { minLength: 2, maxLength: 6 }).map(ws => [
					120,
					60,
					120,
					...ws,
				]),
				async widths => {
					const seen = new Map<number, readonly string[]>();
					for (const width of [...widths, ...widths]) {
						const lines = h.widget()!.render(width);
						const prior = seen.get(width);
						if (prior) expect(lines).toEqual(prior);
						else seen.set(width, lines);
					}
				},
			),
			{ numRuns: 25, seed: 20261101 },
		);
	});

	test("every theme colour the band samples invalidates every memo", async () => {
		// One row per sampled colour: a thought (thinkingText), a finished tool
		// (success, muted), an errored tool with output (error, and `toolOutput`
		// in full mode), a tracked file (`text` is only used by the files row) and
		// an open thinking block (the `warning` title dot). An empty band would
		// leave some of them unrendered, and the loop below would then pass or
		// fail on leftovers from an earlier suite.
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "theme seed" } });
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_end", content: "theme seed" } });
		await h.emit("tool_execution_start", { toolCallId: "thm", toolName: "bash", args: { command: "true" } });
		await h.emit("tool_execution_end", { toolCallId: "thm", result: { content: "ok" }, isError: false });
		await h.emit("tool_execution_start", { toolCallId: "thm-err", toolName: "bash", args: { command: "false" } });
		await h.emit("tool_execution_end", {
			toolCallId: "thm-err",
			result: { content: "detail line" },
			isError: true,
		});
		await h.emit("tool_call", { toolName: "read", input: { path: "/tmp/omp-split-view/split-view.ts" } });
		// Full mode paints the detail row with `toolOutput`. Nothing is left
		// running: an active tool would start the one-second ticker and re-render
		// in the middle of the loop, while an open thinking block only paints the
		// title dot.
		await setToggle("split-tools-view", /full/);
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });

		const palette: Record<string, string> = {};
		const themed = {
			...flatTheme,
			fg: (color: string, text: string) => `${palette[color] ?? ""}${text}`,
		};
		h.setTheme(themed);
		try {
			const render = () => h.widget()!.render(120);
			// Warm with an empty palette; `before` is what a re-warmed render after
			// each iteration must match.
			const before = render();
			const sampled = [
				"border",
				"accent",
				"text",
				"muted",
				"dim",
				"success",
				"error",
				"warning",
				"toolOutput",
				"thinkingText",
			];
			for (const color of sampled) {
				palette[color] = `\u0001${color}`;
				const changed = render();
				delete palette[color];
				// Re-warm with the colour removed: without this, the previous
				// iteration's colour is still in the last fingerprint and forces the
				// rebuild, so a colour missing from the fingerprint would pass on
				// somebody else's invalidation.
				render();
				expect({ color, changed }).not.toEqual({ color, changed: before });
			}
		} finally {
			h.setTheme(flatTheme);
			await h.emit("message_update", { assistantMessageEvent: { type: "thinking_end", content: "theme seed" } });
			await setToggle("split-tools-view", /compact/);
		}
	});

	test("model and tool text can never reach a row as terminal escapes", async () => {
		const hostile = "\u001b[31mred\u001b[0m\u001b]0;title\u0007\u0000\u0007\u009b";
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: hostile } });
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_end", content: hostile } });
		await h.emit("tool_execution_start", {
			toolCallId: "esc",
			toolName: `ba${hostile}sh`,
			args: { command: hostile },
		});
		await h.emit("tool_execution_end", {
			toolCallId: "esc",
			result: { content: [{ type: "text", text: hostile }] },
			isError: false,
		});
		const joined = h.widget()!.render(120).join("\n");
		expect(joined).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
	});

	test("arbitrary event streams never break the band", async () => {
		const step = fc.record({
			kind: fc.constantFrom(
				"think-start",
				"think-delta",
				"think-end",
				"tool-start",
				"tool-end",
				"result",
				"command",
				"height",
			),
			text: fc.string({ maxLength: 120 }),
			diff: fc.option(fc.string({ maxLength: 120 }), { nil: null }),
			isError: fc.boolean(),
			command: fc.constantFrom(
				"split-thinking",
				"split-tools",
				"files",
				"split-diff",
				"split-tools-view",
				"split-trim-response",
			),
			height: fc.integer({ min: 1, max: 60 }),
		});
		await fc.assert(
			fc.asyncProperty(fc.array(step, { maxLength: 10 }), async steps => {
				for (const s of steps) {
					switch (s.kind) {
						case "think-start":
							await h.emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
							break;
						case "think-delta":
							await h.emit("message_update", {
								assistantMessageEvent: { type: "thinking_delta", delta: s.text },
							});
							break;
						case "think-end":
							await h.emit("message_update", {
								assistantMessageEvent: { type: "thinking_end", content: s.text },
							});
							break;
						case "tool-start":
							await h.emit("tool_execution_start", {
								toolCallId: "fz",
								toolName: s.text || "bash",
								args: { command: s.text },
							});
							break;
						case "tool-end":
							await h.emit("tool_execution_end", {
								toolCallId: "fz",
								result: { content: s.text },
								isError: s.isError,
							});
							break;
						case "result":
							await h.emit("tool_result", {
								toolName: "edit",
								toolCallId: "fz",
								input: { path: "/tmp/prop.ts" },
								details: s.diff === null ? {} : { diff: s.diff },
							});
							break;
						case "command":
							await h.command(s.command, s.text.length % 2 === 0 ? "on" : "");
							break;
						case "height":
							await h.command("split-height", String(s.height));
							break;
					}
					const widget = h.widget();
					if (!widget) continue;
					for (const line of widget.render(120)) {
						expect(line).not.toContain("\n");
						if (s.kind !== "command" || s.command !== "split-trim-response")
							expect(line).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
					}
				}
				await ensurePanel("Thinking", "split-thinking");
				await ensurePanel("Tool Usage", "split-tools");
				await ensurePanel("📂 Files", "files");
				await h.command("split-height", "20");
			}),
			{ numRuns: 20, seed: 20261101 },
		);
		// A generated run can leave the band too tall to fit, which makes every
		// label unrenderable and makes the per-run `ensure` above toggle panels
		// OFF instead of on. Restore the mount point the later suites assume.
		h.setSize(120, 45);
		await h.command("split-height", "20");
		await ensurePanel("Thinking", "split-thinking");
		await ensurePanel("Tool Usage", "split-tools");
		await ensurePanel("📂 Files", "files");
		expect(h.widget()).toBeDefined();
	});
});

/**
 * Targeted at the four highest-complexity functions (`filesPanelLines` cc 31,
 * `renderBand` cc 23, `toolLines` cc 21, `reconstruct` cc 20, `pathsFrom` cc 18):
 * each test drives a branch that line coverage already counted as "hit" only
 * because a sibling branch ran, and asserts the user-visible result.
 */
describe("complex renderers", () => {
	const rows = () => h.widget()!.render(120);
	const joined = () => rows().join("\n");
	/** Toggle-style commands announce the new state; read it, don't guess. */
	const setToolMode = (full: boolean) => setToggle("split-tools-view", full ? /full/ : /compact/);
	const setDiff = (on: boolean) => setToggle("split-diff", on ? /\bon$/ : /\boff$/);
	/** Rendered rows, or "" when the band is unmounted/hidden. */
	const visible = () => h.widget()?.render(120).join("\n") ?? "";

	beforeAll(async () => {
		h.setSize(120, 45);
		await h.command("split-height", "20");
		await setToggle("split-thinking", /Thinking on/);
		await setToggle("split-tools", /Tools on/);
		await setToggle("files", /Files panel on/);
		await setDiff(true);
		await setToolMode(false);
		// The band must be mounted and complete before any test reads rows.
		expect(visible()).toContain("Thinking");
		expect(visible()).toContain("Tool Usage");
		expect(visible()).toContain("📂 Files");
	});

	afterAll(async () => {
		await resetBuffers();
		await setToolMode(false);
		await setDiff(true);
		await h.command("split-trim-response", "off");
		h.setSize(120, 45);
		await h.command("split-height", "20");
		await h.command("split-tools-width", "35");
	});

	test("a long tool result previews the newest lines and counts the rest", async () => {
		await resetBuffers();
		await setToolMode(true);
		await h.emit("tool_execution_start", { toolCallId: "out1", toolName: "bash", args: { command: "seq 5" } });
		await h.emit("tool_execution_end", {
			toolCallId: "out1",
			result: { content: [{ type: "text", text: "lineA\nlineB\nlineC\nlineD\nlineE" }] },
			isError: false,
		});
		const text = joined();
		expect(text).toContain("lineD");
		expect(text).toContain("lineE");
		expect(text).toContain("· +3 earlier lines");
		// The preview is capped: the older lines must not leak into the panel.
		expect(text).not.toContain("lineC");
	});

	test("property: tool output previews its newest lines and counts earlier ones", async () => {
		// Terminal tall enough for every generated band (rows up to 60).
		h.setSize(120, 100);
		const scenario = fc.record({
			// Counts, not sparse booleans: the head-vs-tail window only differs
			// past MAX_TOOL_OUTPUT_LINES (20), so every length must be reachable.
			partialCount: fc.integer({ min: 0, max: 80 }),
			finalCount: fc.integer({ min: 0, max: 80 }),
			// A non-empty whitespace payload reaches `setToolOutput` (unlike ""),
			// so this is the only way to exercise the no-content guard.
			finalBlank: fc.boolean(),
			rows: fc.integer({ min: 18, max: 60 }),
		});
		try {
			await fc.assert(
				fc.asyncProperty(scenario, async ({ partialCount, finalCount, finalBlank, rows }) => {
					await resetBuffers();
					await h.command("split-height", String(rows));
					await setToolMode(true);
					// Blank lines and padded tokens exercise trim/filter, which must
					// not change the counted total.
					const textOf = (prefix: string, count: number) =>
						Array.from({ length: count }, (_, i) => ` ${prefix}-${i}-end `).join("\n\n");
					const partialText = textOf("old", partialCount);
					const finalText = finalBlank ? " \n\t \n" : textOf("line", finalCount);
					await h.emit("tool_execution_start", {
						toolCallId: "preview-prop",
						toolName: "bash",
						args: { command: "x" },
					});
					await h.emit("tool_execution_update", {
						toolCallId: "preview-prop",
						partialResult: { content: [{ type: "text", text: partialText }] },
					});
					await h.emit("tool_execution_end", {
						toolCallId: "preview-prop",
						result: { content: [{ type: "text", text: finalText }] },
						isError: false,
					});
					const band = joined();
					const lines = band.split("\n");
					const finalIndices = finalBlank ? [] : Array.from({ length: finalCount }, (_, i) => i);
					const partialIndices = Array.from({ length: partialCount }, (_, i) => i);
					// An empty final result keeps the streamed partial text.
					const fromFinal = finalIndices.length > 0;
					const effective = fromFinal ? finalIndices : partialIndices;
					const token = (i: number) => `${fromFinal ? "line" : "old"}-${i}-end`;
					// The stored window is a tail, so the newest `cap` lines show.
					const cap = Math.max(2, Math.min(6, Math.floor((rows - 2) / 8)));
					const shown = Math.min(cap, effective.length);
					const visible = shown > 0 ? effective.slice(-shown) : [];
					const hidden = Math.max(partialIndices.length, finalIndices.length) - shown;
					for (const i of visible) expect(band).toContain(token(i));
					for (const i of effective.slice(0, Math.max(0, effective.length - shown)))
						expect(band).not.toContain(token(i));
					if (fromFinal) for (const i of partialIndices) expect(band).not.toContain(`old-${i}-end`);
					if (hidden > 0) {
						expect(band).toContain(`+${hidden} earlier lines`);
						const markerRow = lines.findIndex(line => line.includes(`+${hidden} earlier lines`));
						const newestRow = lines.findIndex(line => line.includes(token(effective.at(-1)!)));
						expect(markerRow).toBeLessThan(newestRow);
					} else {
						expect(band).not.toMatch(/\+\d+ earlier lines/);
					}
					await h.command("split-height", "20");
					await setToolMode(false);
				}),
				{ numRuns: 40, seed: 20261101 },
			);
		} finally {
			h.setSize(120, 45);
			await h.command("split-height", "20");
			await setToolMode(false);
		}
	});

	test("the earlier-lines marker counts output past the character cap", async () => {
		await resetBuffers();
		await setToolMode(true);
		// ~440 KB of text: far past MAX_TOOL_TEXT_CHARS (32 KiB), so the stored
		// window is a small tail while the reported total must be the whole
		// result. Band 20 -> 18 body rows -> preview cap 2.
		const text = Array.from({ length: 40000 }, (_, i) => `v${i}-end`).join("\n");
		await h.emit("tool_execution_start", { toolCallId: "huge1", toolName: "bash", args: { command: "seq" } });
		await h.emit("tool_execution_end", {
			toolCallId: "huge1",
			result: { content: [{ type: "text", text }] },
			isError: false,
		});
		const band = joined();
		expect(band).toContain("v39999-end");
		expect(band).toContain("+39998 earlier lines");
	});

	test("property: the earlier-lines marker counts output past the character cap", async () => {
		// Tall enough for every generated band (rows up to 60).
		h.setSize(120, 100);
		const scenario = fc.record({
			// Past MAX_TOOL_TEXT_CHARS (32 KiB) the retained window is a tail, so
			// only a whole-result count can produce the marker's number.
			count: fc.integer({ min: 0, max: 25000 }),
			rows: fc.integer({ min: 18, max: 60 }),
		});
		try {
			await fc.assert(
				fc.asyncProperty(scenario, async ({ count, rows }) => {
					await resetBuffers();
					await h.command("split-height", String(rows));
					await setToolMode(true);
					const body = Array.from({ length: count }, (_, i) => `w${i}-end`).join("\n");
					await h.emit("tool_execution_start", {
						toolCallId: "past-cap",
						toolName: "bash",
						args: { command: "x" },
					});
					await h.emit("tool_execution_end", {
						toolCallId: "past-cap",
						result: { content: [{ type: "text", text: body }] },
						isError: false,
					});
					const band = joined();
					// A band of `rows` renders `rows - 2` body rows, and the preview
					// depth follows that body: max(2, min(6, floor(body / 8))).
					const cap = Math.max(2, Math.min(6, Math.floor((rows - 2) / 8)));
					const shown = Math.min(cap, count);
					const hidden = count - shown;
					const newest = Array.from({ length: shown }, (_, k) => count - shown + k);
					for (const i of newest) expect(band).toContain(`w${i}-end`);
					// The oldest lines are past the retained window entirely; the
					// boundary line is stored but never previewed.
					const oldestHidden = Math.min(3, hidden);
					for (const i of Array.from({ length: oldestHidden }, (_, k) => k))
						expect(band).not.toContain(`w${i}-end`);
					if (hidden > 0) expect(band).not.toContain(`w${hidden - 1}-end`);
					if (hidden > 0) expect(band).toContain(`+${hidden} earlier lines`);
					else expect(band).not.toMatch(/\+\d+ earlier lines/);
					await h.command("split-height", "20");
					await setToolMode(false);
				}),
				{ numRuns: 20, seed: 20261101 },
			);
		} finally {
			h.setSize(120, 45);
			await h.command("split-height", "20");
			await setToolMode(false);
		}
	});

	test("property: the reported line count is shape independent and describes the sanitized text", async () => {
		h.setSize(120, 100);
		const scenario = fc.record({
			// One hostile payload per line: CR, C0/C1 controls, OSC/CSI escapes and
			// lone surrogates all reach sanitizeText, and the count must describe what
			// survives it. Each line keeps a `Ln:` token, so the count is always a real
			// number instead of collapsing to 0 for whitespace-only input.
			parts: fc.array(fc.string({ unit: "binary", maxLength: 30 }), { minLength: 3, maxLength: 14 }),
			shape: fc.constantFrom("string", "content", "blocks"),
			other: fc.constantFrom("string", "content", "blocks"),
			split: fc.nat(),
			rows: fc.integer({ min: 18, max: 60 }),
			// Past the character cap only a tail is stored, so the count must come
			// from the whole text rather than from the retained window.
			pastCap: fc.boolean(),
		});
		// Trimmed non-empty lines of the sanitized text: the contract the marker
		// number is measured against.
		const nonEmpty = (text: string) =>
			sanitizeText(text)
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(Boolean).length;
		const payload = (shape: string, text: string, split: number): unknown => {
			if (shape === "string") return text;
			if (shape === "content") return { content: text };
			const cut = split % (text.length + 1);
			return {
				content: [
					{ type: "text", text: text.slice(0, cut) },
					{ type: "text", text: text.slice(cut) },
				],
			};
		};
		// Only the first detail row can be the marker (toolDetailLines pushes it
		// before the newest lines), so arbitrary content that happens to spell
		// "+N earlier lines" cannot be mistaken for it.
		const markerOf = (band: string) => {
			const lines = band.split("\n");
			const rowOf = lines.findIndex(line => line.includes("bash"));
			// -1 never equals an oracle value, so a missing tool row fails loudly
			// instead of reading as "no marker".
			if (rowOf < 0) return -1;
			const found = /· \+(\d+) earlier lines/.exec(lines[rowOf + 1] ?? "");
			return found ? Number(found[1]) : 0;
		};
		const emit = async (result: unknown) => {
			await h.emit("tool_execution_start", { toolCallId: "shape", toolName: "bash", args: { command: "x" } });
			await h.emit("tool_execution_end", { toolCallId: "shape", result, isError: false });
			return joined();
		};
		try {
			await fc.assert(
				fc.asyncProperty(scenario, async ({ parts, shape, other, split, rows, pastCap }) => {
					await resetBuffers();
					await h.command("split-height", String(rows));
					await setToolMode(true);
					const text = parts.map((part, i) => `L${i}:${part}`).join("\n");
					const cap = Math.max(2, Math.min(6, Math.floor((rows - 2) / 8)));
					// Past the character cap only a tail is stored. A dense suffix keeps
					// the retained window at or above `cap` lines, and `p0` is far enough
					// ahead of the window that the sanitized text always holds one counted
					// line the window does not: the oracle stays exact.
					const head = pastCap ? text.repeat(Math.ceil(66000 / Math.max(1, text.length))) : text;
					const tail = Array.from({ length: cap }, (_, i) => `z${i}`).join("\n");
					const body = pastCap ? `p0\n${head}\n${tail}` : head;
					const band = await emit(payload(shape, body, split));
					const total = nonEmpty(body);
					expect(markerOf(band)).toBe(Math.max(0, total - Math.min(cap, total)));
					// The count must not depend on how the same text was packaged.
					await resetBuffers();
					expect(markerOf(await emit(payload(other, body, split)))).toBe(markerOf(band));
					// Nothing sanitized away may reach a row.
					expect(band).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
					await h.command("split-height", "20");
					await setToolMode(false);
				}),
				{ numRuns: 20, seed: 20261101 },
			);
		} finally {
			h.setSize(120, 45);
			await h.command("split-height", "20");
			await setToolMode(false);
		}
	});

	test("property: the newest full-mode card keeps its row and reports its withheld detail", async () => {
		h.setSize(120, 100);
		const card = fc.record({ output: fc.integer({ min: 0, max: 40 }), diff: fc.integer({ min: 0, max: 200 }) });
		const scenario = fc.record({
			cards: fc.array(card, { minLength: 1, maxLength: 6 }),
			rows: fc.integer({ min: 6, max: 40 }),
		});
		try {
			await fc.assert(
				fc.asyncProperty(scenario, async ({ cards, rows }) => {
					await resetBuffers();
					await h.command("split-height", String(rows));
					await setToolMode(true);
					for (const [i, spec] of cards.entries()) {
						await h.emit("tool_execution_start", { toolCallId: `n${i}`, toolName: `tool-${i}`, args: {} });
						const text = Array.from({ length: spec.output }, (_, k) => `o${i}-${k}`).join("\n");
						const diff = Array.from({ length: spec.diff }, (_, k) => (k % 2 === 0 ? `-a${k}` : `+b${k}`)).join(
							"\n",
						);
						await h.emit("tool_execution_end", {
							toolCallId: `n${i}`,
							result: {
								...(spec.output > 0 ? { content: text } : {}),
								...(spec.diff > 0 ? { details: { diff } } : {}),
							},
							isError: false,
						});
					}
					const band = h.widget()!.render(120);
					const bodyRows = rows - 2;
					const cap = Math.max(2, Math.min(6, Math.floor(bodyRows / 8)));
					const newest = cards[cards.length - 1];
					const newestName = `tool-${cards.length - 1}`;
					// Cards are composed oldest-first, so the newest one is the last card
					// and owns the whole body budget: everything after its row is its own
					// detail, which is what the marker arithmetic below describes.
					const rowOf = band.findIndex(row => row.includes(newestName));
					expect(rowOf).toBeGreaterThanOrEqual(0);
					expect(band.length).toBe(rows);
					assertExactWidth(band, 120);
					const shown = Math.min(cap, newest.output);
					const outputRows = shown + (newest.output > shown ? 1 : 0);
					// `MAX_TOOL_DIFF_LINES` (150) plus its own "more diff lines" row.
					const cappedDiff = Math.min(newest.diff, 150) + (newest.diff > 150 ? 1 : 0);
					// The diff block carries a leading blank row, so an empty diff adds none.
					const diffRows = newest.diff === 0 ? 0 : cappedDiff + 1;
					const expectedDetail = outputRows + diffRows;
					const room = bodyRows - 1;
					const tail = band.slice(rowOf + 1).join("\n");
					if (expectedDetail > room) {
						expect(tail).toContain(`+${expectedDetail - Math.max(0, room - 1)} more detail rows`);
					} else {
						expect(tail).not.toMatch(/\+\d+ more detail rows/);
					}
					await h.command("split-height", "20");
					await setToolMode(false);
				}),
				{ numRuns: 20, seed: 20261101 },
			);
		} finally {
			h.setSize(120, 45);
			await h.command("split-height", "20");
			await setToolMode(false);
		}
	});

	test("property: compact cards cost one row each and separators only when a row is free", async () => {
		h.setSize(120, 100);
		const scenario = fc.record({
			counts: fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 10 }),
			rows: fc.integer({ min: 6, max: 40 }),
		});
		try {
			await fc.assert(
				fc.asyncProperty(scenario, async ({ counts, rows }) => {
					await resetBuffers();
					await h.command("split-height", String(rows));
					await setToolMode(false);
					for (const [i, lines] of counts.entries()) {
						await h.emit("tool_execution_start", { toolCallId: `k${i}`, toolName: `entry-${i}`, args: {} });
						await h.emit("tool_execution_end", {
							toolCallId: `k${i}`,
							result:
								lines > 0
									? { content: Array.from({ length: lines }, (_, k) => `e${i}-${k}`).join("\n") }
									: {},
							isError: false,
						});
					}
					// Independent model: newest first, one row per entry, one blank row
					// before an entry only while a row is still free.
					const maxRows = rows - 2;
					const visible: string[] = [];
					let items = 0;
					for (let i = counts.length - 1; i >= 0 && items < maxRows; i--) {
						const separator = i > 0 && maxRows - items > 1 ? 1 : 0;
						if (maxRows - items - separator < 1) break;
						items += separator + 1;
						visible.push(`entry-${i}`);
					}
					const band = h.widget()!.render(120);
					const text = band.join("\n");
					expect(band.length).toBe(rows);
					assertExactWidth(band, 120);
					for (const name of visible) expect(text).toContain(name);
					// No other entry leaked into the band.
					for (let i = 0; i < counts.length; i++)
						if (!visible.includes(`entry-${i}`)) expect(text).not.toContain(`entry-${i}`);
					await h.command("split-height", "20");
				}),
				{ numRuns: 25, seed: 20261101 },
			);
		} finally {
			h.setSize(120, 45);
			await h.command("split-height", "20");
			await setToolMode(false);
		}
	});

	test("an image result renders a one-line fallback, never the base64 payload", async () => {
		await resetBuffers();
		await setToolMode(true);
		// 1x1 transparent PNG; the panel must show a description, not the payload.
		const png =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
		await h.emit("tool_execution_start", { toolCallId: "img1", toolName: "read", args: { path: "shot.png" } });
		await h.emit("tool_execution_end", {
			toolCallId: "img1",
			result: { content: [{ type: "image", data: png, mimeType: "image/png" }] },
			isError: false,
		});
		// Wide enough that the label does not wrap in the tools column.
		const text = h.widget()!.render(200).join("\n");
		// Dimensions are computed at ingest, so a missing `1x1` means the
		// stored label lost them.
		expect(text).toContain("[Image: [image/png] 1x1]");
		expect(text).not.toContain("iVBORw0KGgo");
	});

	test("a tool result diff renders under its own tool row in full mode", async () => {
		await resetBuffers();
		await setToolMode(true);
		await h.emit("tool_execution_start", { toolCallId: "d1", toolName: "patch", args: { path: "x.ts" } });
		await h.emit("tool_execution_end", {
			toolCallId: "d1",
			result: { content: "applied", details: { diff: "-gone\n+kept" } },
			isError: false,
		});
		// Only `tool_execution_end` ran, so the files-pane diff stays empty: the
		// rows below belong to the tool entry itself.
		const text = joined();
		expect(text).toContain("-gone");
		expect(text).toContain("+kept");
		expect(text).toContain("Last Edit");
	});

	test("a tall diff keeps its own tool row inside the band", async () => {
		await resetBuffers();
		await setToolMode(true);
		// 200 diff lines cap at MAX_TOOL_DIFF_LINES (150) plus a "more diff
		// lines" marker: 152 detail rows against the 17 the band can spare.
		const diff = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? `-old ${i}` : `+new ${i}`)).join("\n");
		await h.emit("tool_execution_start", { toolCallId: "tall1", toolName: "edit", args: { path: "x.ts" } });
		await h.emit("tool_execution_end", { toolCallId: "tall1", result: { details: { diff } }, isError: false });
		const lines = rows();
		const band = joined();
		// The identity row survives and the omitted rows are reported.
		expect(band).toContain("edit");
		expect(band).toMatch(/\+136 more detail rows/);
		expect(lines.length).toBe(20);
		assertExactWidth(lines, 120);
	});

	test("a card smaller than its detail reports the rows it withheld", async () => {
		await resetBuffers();
		await h.command("split-height", "6");
		await setToolMode(true);
		await h.emit("tool_execution_start", { toolCallId: "small1", toolName: "bash", args: { command: "x" } });
		await h.emit("tool_execution_end", {
			toolCallId: "small1",
			result: { content: "l1\nl2\nl3\nl4\nl5", details: { diff: "-a\n+b\n-c\n+d" } },
			isError: false,
		});
		// Band 6 -> 4 body rows: the row itself, then 2 of the 8 detail rows
		// (earlier-lines marker + newest output line) and the omission marker.
		const lines = rows();
		const band = joined();
		expect(band).toContain("bash");
		expect(band).toContain("+3 earlier lines");
		expect(band).toMatch(/\+6 more detail rows/);
		expect(lines.length).toBe(6);
		await h.command("split-height", "20");
	});

	test("property: a tall tool card always keeps its row inside the band", async () => {
		// Tall enough for every generated band (rows up to 40).
		h.setSize(120, 100);
		const scenario = fc.record({
			diffLines: fc.integer({ min: 0, max: 200 }),
			bandRows: fc.integer({ min: 6, max: 40 }),
		});
		try {
			await fc.assert(
				fc.asyncProperty(scenario, async ({ diffLines, bandRows }) => {
					await resetBuffers();
					await h.command("split-height", String(bandRows));
					await setToolMode(true);
					const diff = Array.from({ length: diffLines }, (_, i) => (i % 2 === 0 ? `-a${i}` : `+b${i}`)).join("\n");
					await h.emit("tool_execution_start", {
						toolCallId: "tall-prop",
						toolName: "edit",
						args: { path: "x.ts" },
					});
					await h.emit("tool_execution_end", {
						toolCallId: "tall-prop",
						result: diffLines > 0 ? { details: { diff } } : {},
						isError: false,
					});
					const lines = rows();
					const band = lines.join("\n");
					expect(band).toContain("edit");
					// The band keeps its height and every composed row its width.
					expect(lines.length).toBe(bandRows);
					assertExactWidth(lines, 120);
					// Detail rows the entry produced: the capped diff lines plus the
					// "more diff lines" marker, behind the block's leading blank row.
					const cappedDiff = Math.min(diffLines, 150) + (diffLines > 150 ? 1 : 0);
					const expectedDetail = diffLines === 0 ? 0 : cappedDiff + 1;
					// A body is `rows - 2`; one row of it belongs to the tool row.
					if (expectedDetail > bandRows - 2 - 1) expect(band).toMatch(/\+\d+ more detail rows/);
					else expect(band).not.toMatch(/\+\d+ more detail rows/);
					await h.command("split-height", "20");
					await setToolMode(false);
				}),
				{ numRuns: 25, seed: 20261101 },
			);
		} finally {
			h.setSize(120, 45);
			await h.command("split-height", "20");
			await setToolMode(false);
		}
	});

	test("compact mode separates entries and withholds the timer for one second", async () => {
		await resetBuffers();
		await setToolMode(false);
		await h.emit("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "true" } });
		await h.emit("tool_execution_end", { toolCallId: "c1", result: { content: "ok" }, isError: false });
		await h.emit("tool_execution_start", { toolCallId: "c2", toolName: "read", args: { path: "a.ts" } });
		await h.emit("tool_execution_end", { toolCallId: "c2", result: { content: "ok" }, isError: false });
		const lines = rows();
		const bashRow = lines.findIndex(line => line.includes("bash"));
		const readRow = lines.findIndex(line => line.includes("read"));
		// One blank body row between two compact entries, newest last. The row
		// itself is a composite of every column, so it is checked for the
		// absence of tool content rather than for being empty.
		expect(bashRow).toBeGreaterThan(-1);
		expect(readRow).toBe(bashRow + 2);
		expect(lines[bashRow + 1]).not.toMatch(/[✓●✗]|bash|read/);

		// A finished call carries its elapsed time; one that just started must
		// stay untimed until the one-second gate (a sub-second live counter
		// would re-render on every frame). The >=1s live form is covered by
		// "the live tool ticker refreshes while a call runs and stops after".
		expect(lines[bashRow]).toMatch(/✓ bash \d+\.\d+s \{/);
		await h.emit("tool_execution_start", { toolCallId: "c3", toolName: "sleep", args: { command: "sleep 2" } });
		expect(joined()).toMatch(/● sleep \{/);
		await h.emit("tool_execution_end", { toolCallId: "c3", result: { content: "" }, isError: false });
	});

	test("streamed thinking is coalesced: one frame per flush, not per delta", async () => {
		await resetBuffers();
		vi.useFakeTimers();
		try {
			await h.emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
			// Prime the composed band for the current version, as a frame would.
			const primed = joined();
			expect(primed).not.toContain("live tail");
			// Deltas only mark the buffer dirty: the interval is the flush gate,
			// so a frame rendered inside that window still sees the old rows.
			await h.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "live tail" } });
			expect(joined()).toBe(primed);
			vi.advanceTimersByTime(100);
			// The flush bumps the version, which invalidates the thinking panel's
			// memo.
			expect(joined()).toContain("live tail");
		} finally {
			vi.useRealTimers();
		}
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_end", content: "live tail" } });
	});

	test("a hostile path is sanitized in the files row", async () => {
		await resetBuffers();
		await h.emit("tool_call", { toolName: "read", input: { path: "/tmp/omp-split-view/ev\u001b[31mil.ts" } });
		const band = rows();
		assertExactWidth(band, 120);
		const text = band.join("\n");
		expect(text).toContain("Files (1)");
		expect(text).toContain("evil.ts");
		expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
	});

	test("the tool panel keeps only the newest entries past its cap", async () => {
		await resetBuffers();
		await setToolMode(false);
		// One past MAX_TOOLS (60): the oldest entry must be dropped, not the newest.
		for (let i = 0; i < 65; i++) {
			// A short key keeps the id inside the narrow panel's arg column.
			await h.emit("tool_execution_start", { toolCallId: `ev${i}`, toolName: "bash", args: { c: `n${i}` } });
			await h.emit("tool_execution_end", { toolCallId: `ev${i}`, result: { content: "" }, isError: false });
		}
		expect(retainedToolEntries()).toBe(60);
		// The newest call still has a row; evicting the wrong end would drop it.
		expect(joined()).toContain("n64");
	});

	test("files sharing a directory collapse under one indented group header", async () => {
		await resetBuffers();
		for (const name of ["a", "b", "c", "d"])
			await h.emit("tool_call", { toolName: "read", input: { path: `/tmp/grp/${name}.ts` } });
		const text = joined();
		expect(text).toContain("grp/");
		// Children carry an extra indent so the header groups them visually:
		// the header row is `│ grp/` and its files are `│   r d.ts`.
		expect(text).toMatch(/│ {3}r d\.ts/);
		expect(text).not.toContain("… +");
	});

	test("a long file list counts what it hides and keeps the newest rows", async () => {
		await resetBuffers();
		for (let i = 0; i < 8; i++) await h.emit("tool_call", { toolName: "read", input: { path: `/tmp/tr${i}.ts` } });
		const text = joined();
		expect(text).toContain("/tmp/");
		expect(text).toContain("tr7.ts"); // newest first
		expect(text).not.toContain("tr0.ts"); // oldest dropped from the list
		expect(text).toContain("… +5 more");
	});

	test("touching one file twice shows a count badge and merged operation letters", async () => {
		await resetBuffers();
		await h.emit("tool_call", { toolName: "read", input: { path: "/tmp/badge.ts" } });
		await h.emit("tool_call", { toolName: "edit", input: { path: "/tmp/badge.ts" } });
		expect(joined()).toContain("Files (1)");
		expect(joined()).toMatch(/rw×2 badge\.ts/);
	});

	test("group headers shorten home paths with ~ and keep outside paths absolute", async () => {
		await resetBuffers();
		for (const name of ["a", "b", "c", "d"])
			await h.emit("tool_call", { toolName: "read", input: { path: `${homedir()}/omp-probe/${name}.ts` } });
		expect(joined()).toContain("~/omp-probe/");

		await resetBuffers();
		for (const name of ["a", "b", "c", "d"])
			await h.emit("tool_call", { toolName: "read", input: { path: `/etc/omp-probe/${name}.ts` } });
		// Outside both cwd and home: no "~" or "../" rewriting.
		expect(joined()).toContain("/etc/omp-probe/");
	});

	test("the diff subpanel explains an empty state and marks a truncated diff", async () => {
		await resetBuffers();
		await setDiff(true);
		let text = joined();
		expect(text).toContain("Last Edit");
		expect(text).toContain("No edit yet");
		expect(text).toContain("No files touched yet");
		expect(text).toContain("r read · w write · s seen(bash)");

		const long = Array.from({ length: 40 }, (_, i) => `-old${i}\n+new${i}`).join("\n");
		await h.emit("tool_result", { toolName: "edit", input: { path: "/tmp/trunc.ts" }, details: { diff: long } });
		text = joined();
		expect(text).toContain("✎ trunc.ts");
		expect(text).toMatch(/… \+\d+ more/);

		// A short diff fits whole: the marker must disappear with it.
		await h.emit("tool_result", { toolName: "edit", input: { path: "/tmp/short.ts" }, details: { diff: "-a\n+b" } });
		text = joined();
		expect(text).toContain("✎ short.ts");
		expect(text).toContain("+b");
		expect(text).not.toContain(" more");
	});

	test("bash contributes only real files, not flags, operators or redirects", async () => {
		await resetBuffers();
		writeFileSync("/tmp/omp-sv-probe.txt", "x");
		// A file literally named `-n` exists, so flag rejection cannot lean on
		// the existence check alone: the `-` prefix must be rejected on sight.
		writeFileSync("/tmp/-n", "x");
		try {
			await h.emit("tool_call", {
				toolName: "bash",
				input: {
					// Quoted token: strip the quotes and count it (deduped against
					// the identical path earlier in the line).
					command: 'grep -n probe < /tmp/omp-sv-probe.txt > /tmp/omp-sv-out.txt; echo "omp-sv-probe.txt" | wc -l',
				},
			});
		} finally {
			rmSync("/tmp/omp-sv-probe.txt", { force: true });
			rmSync("/tmp/-n", { force: true });
		}
		const text = joined();
		expect(text).toContain("Files (1)");
		expect(text).toContain("s omp-sv-probe.txt");
		// Neither the redirect target (absent) nor the flag (present) counts.
		expect(text).not.toContain("omp-sv-out.txt");
	});

	test("a custom tool's path keys contribute one deduplicated existing file", async () => {
		await resetBuffers();
		writeFileSync("/tmp/omp-sv-key.txt", "x");
		try {
			await h.emit("tool_call", {
				toolName: "spawn",
				input: {
					filePath: "/tmp/omp-sv-key.txt",
					file_path: "/tmp/omp-sv-key.txt",
					files: ["/tmp/omp-sv-key.txt", "/tmp/omp-sv-missing.txt"],
				},
			});
		} finally {
			rmSync("/tmp/omp-sv-key.txt", { force: true });
		}
		const text = joined();
		expect(text).toContain("Files (1)");
		// Four path fields resolve to one file: no phantom count badge.
		expect(text).toContain("r omp-sv-key.txt");
		expect(text).not.toContain("×");
	});

	test("replayed thinking is sanitized before it reaches a row", async () => {
		await resetBuffers([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "safe\u001b]0;PWNED\u0007\u001b[31mred" }],
				},
			},
		]);
		const text = joined();
		expect(text).toContain("safe");
		expect(text).not.toContain("PWNED");
		expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
	});

	test("a stored edit diff is capped by lines and by chars", async () => {
		await resetBuffers();
		const big = Array.from({ length: 5000 }, (_, i) => `-old ${i}\n+new ${i}`).join("\n");
		await h.emit("tool_result", {
			toolName: "edit",
			input: { path: "/tmp/capped.ts" },
			details: { diff: big },
		});
		expect(retainedEditDiff().lines).toBe(MAX_DIFF_LINES + 1);

		await h.emit("tool_result", {
			toolName: "edit",
			input: { path: "/tmp/capped.ts" },
			details: { diff: "x".repeat(MAX_DIFF_CHARS * 2) },
		});
		expect(retainedEditDiff().chars).toBeLessThanOrEqual(MAX_DIFF_CHARS + 64);
	});

	test("a stored edit diff renders no terminal escapes", async () => {
		await resetBuffers();
		await h.emit("tool_result", {
			toolName: "edit",
			input: { path: "/tmp/hostile.ts" },
			details: { diff: "-keep\u001b]0;PWNED\u0007\u001b[31mred" },
		});
		// The stored diff is only bounded here; renderDiff is what strips
		// escapes, so this guards that no path renders `editDiff.diff` raw.
		const text = joined();
		expect(text).toContain("red");
		expect(text).not.toContain("PWNED");
		expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
	});

	test("replay applies the edit diff and keeps the last path for a pathless diff", async () => {
		await setDiff(true);
		await resetBuffers([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "first thought" },
						{ type: "thinking", thinking: "second thought" },
					],
				},
			},
			// A result with no matching call must not throw or invent a file.
			{ type: "message", message: { role: "toolResult", toolCallId: "ghost", toolName: "bash", content: "orphan" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "e9",
					toolName: "edit",
					details: { path: "/tmp/replay-edit.ts", diff: "-superseded\n+first" },
				},
			},
			// No `details.path`: the previously replayed path must be kept.
			{
				type: "message",
				message: { role: "toolResult", toolCallId: "e9", toolName: "edit", details: { diff: "-ignored\n+second" } },
			},
		]);
		const lines = rows();
		const text = lines.join("\n");
		expect(text).toContain("first thought");
		expect(text).toContain("second thought");
		// Blocks are separated, not concatenated into one paragraph.
		expect(lines.findIndex(line => line.includes("second thought"))).toBeGreaterThan(
			lines.findIndex(line => line.includes("first thought")) + 1,
		);
		expect(text).toContain("Files (0)");
		expect(text).toContain("✎ replay-edit.ts");
		expect(text).toContain("+second");
		expect(text).not.toContain("+first");
	});
});

describe("large terminals (4K / ultrawide)", () => {
	/** Toggle-style commands announce the new state; drive to a known one. */

	afterAll(async () => {
		rmSync(CONFIG_FILE, { recursive: true, force: true });
		h.setSize(120, 45);
		await h.emit("session_start"); // no config -> bare, 20-row default
		await h.command("split");
		await setToggle("files", /Files panel on/);
		await h.command("split-height", "20");
	});

	test("with no saved height the band is 45% of the rows and the dock 25% of the columns", async () => {
		// No `bandHeight` key: the height must come from the terminal, not the
		// 20-row default that suit a 45-row screen.
		writeConfig({ split: true, thinking: true, tools: true, files: true, diff: true });
		h.setSize(400, 100); // ~4K at a small font
		await h.emit("session_start");
		const lines = h.widget()!.render(400);
		expect(lines.length).toBe(45);
		assertExactWidth(lines, 400);
		// 400 cols: files dock = 25% (100), thinking | tools split the other 300.
		expect(columnStarts(lines[0])).toEqual([0, 195, 300]);
	});

	test("an explicitly saved height is never overridden by the terminal default", async () => {
		writeConfig({ split: true, thinking: true, tools: true, files: true, bandHeight: 24 });
		h.setSize(400, 100);
		await h.emit("session_start");
		expect(h.widget()!.render(400).length).toBe(24);
	});

	test("/split-height uses most of a tall screen, still leaving the transcript room", async () => {
		writeConfig({ split: true, thinking: true, tools: true, files: true });
		h.setSize(400, 100);
		await h.emit("session_start");
		await h.command("split-height", "200"); // clamped: 100 rows - 18 kept
		expect(h.notifications.at(-1)?.message).toContain("80");
		const lines = h.widget()!.render(400);
		expect(lines.length).toBe(80);
		assertExactWidth(lines, 400);
	});

	test("a session load re-derives the auto band height without a remount", async () => {
		// The widget factory already ran (mount-once harness): a height-less
		// config must not fall back to the 20-row default on a 4K pane.
		writeConfig({ split: true, thinking: true, tools: true, files: true });
		h.setSize(400, 100);
		await h.emit("session_start");
		const lines = h.widget()!.render(400);
		expect(lines.length).toBe(45); // 45% of 100 rows
		assertExactWidth(lines, 400);
	});

	test("a taller band previews more of each tool's output", async () => {
		writeConfig({ split: true, thinking: true, tools: true, files: true, bandHeight: 40 });
		h.setSize(400, 100);
		await h.emit("session_start");
		await setToggle("split-tools-view", /full/);
		const output = Array.from({ length: 12 }, (_, i) => `L${i}`).join("\n");
		await h.emit("tool_execution_start", { toolCallId: "tall", toolName: "bash", args: { command: "seq 12" } });
		await h.emit("tool_execution_end", {
			toolCallId: "tall",
			result: { content: [{ type: "text", text: output }] },
			isError: false,
		});
		const joined = h.widget()!.render(400).join("\n");
		// 40-row band -> 38 body rows -> 4 preview lines (not the classic 2),
		// showing the newest lines of the output.
		expect(joined).toContain("· L8");
		expect(joined).toContain("· L11");
		expect(joined).toContain("· +8 earlier lines");
		expect(joined).not.toContain("· L7");
		await setToggle("split-tools-view", /compact/);
	});
});

/**
 * The geometry preset switch: `auto` derives 4k vs wide from the terminal
 * aspect ratio, `/split-geometry` pins either preset, and a pinned band height
 * keeps winning over the preset's own curve.
 */
describe("geometry presets", () => {

	afterAll(async () => {
		rmSync(CONFIG_FILE, { recursive: true, force: true });
		h.setSize(120, 45);
		await h.emit("session_start"); // no config -> bare layout, auto geometry
		await h.command("split");
		await h.command("split-height", "20");
	});

	test("no argument flips the preset in force; `auto` hands it back to the aspect ratio", async () => {
		writeConfig(fullLayout);
		h.setSize(500, 40); // auto -> wide
		await h.emit("session_start");
		await h.command("split-geometry"); // flip: wide -> 4k
		expect(h.notifications.at(-1)?.message).toBe("Geometry: 4k — band 20 rows, dock 120 cols");
		await h.command("split-geometry", "auto");
		expect(h.notifications.at(-1)?.message.startsWith("Geometry: auto (wide)")).toBe(true);
		expect(h.widget()!.render(500).length).toBe(14);
	});

	test("a pinned height survives a preset switch; only the dock follows the preset", async () => {
		h.setSize(500, 60);
		await h.emit("session_start"); // auto -> wide (500 / 60 ≈ 8.3)
		await h.command("split-height", "30");
		await h.command("split-geometry", "4k");
		const message = h.notifications.at(-1)?.message ?? "";
		expect(message).toContain("band height 30 rows (pinned)");
		expect(message).toContain("dock 120 cols");
		expect(h.widget()!.render(500).length).toBe(30);
	});

	test("a session switch keeps the auto preset without a remount", async () => {
		writeConfig(fullLayout);
		h.setSize(500, 40);
		await h.emit("session_start");
		await h.widget(); // the host mounts once and keeps this band
		await h.emit("session_start"); // second session: no factory call
		// The no-arg flip reads the preset the switch left in force, so it
		// reveals whether the auto resolution survived a session load.
		await h.command("split-geometry");
		expect(h.notifications.at(-1)?.message).toBe("Geometry: 4k — band 20 rows, dock 120 cols");
	});

	test("a restart on a differently shaped pane re-lays a pinned band", async () => {
		// Same width, taller pane: the resolved preset flips 4k and only the
		// dock moves, so a stale band memo would keep the old dock.
		writeConfig({ ...fullLayout, bandHeight: 30 });
		h.setSize(500, 60); // 8.3 cols/row -> wide
		await h.emit("session_start");
		const wide = h.widget()!.render(500);
		expect(500 - columnStarts(wide[0])[2]).toBe(160);
		h.setSize(500, 90); // 5.6 cols/row -> 4k, same pinned height
		await h.emit("session_start");
		const fourK = h.widget()!.render(500);
		expect(fourK.length).toBe(30); // the pinned height still wins
		expect(500 - columnStarts(fourK[0])[2]).toBe(120);
	});

	test("a remount after a resize drops the band memo of the old preset", async () => {
		// Unmount/remount (panels off then on) keeps the memo but no height
		// change, so only the preset-derived dock width can force a re-layout.
		writeConfig({ ...fullLayout, bandHeight: 30 });
		h.setSize(500, 60); // 8.3 cols/row -> wide
		await h.emit("session_start");
		const wide = h.widget()!.render(500);
		expect(500 - columnStarts(wide[0])[2]).toBe(160);
		await h.command("split"); // all panels off: the widget unmounts
		h.setSize(500, 90); // 5.6 cols/row -> 4k, same 30-row band
		await h.command("split"); // back on: a fresh mount at the new shape
		const fourK = h.widget()!.render(500);
		expect(fourK.length).toBe(30);
		expect(500 - columnStarts(fourK[0])[2]).toBe(120);
	});
});

/**
 * Property-level geometry: the presets, the aspect resolution and the command
 * surface must hold for arbitrary terminal sizes and arguments, not just the
 * pinned examples in the `geometry presets` block above.
 */
describe("geometry preset properties", () => {
	const columnsArb = fc.integer({ min: 90, max: 700 });
	const rowsArb = fc.integer({ min: 20, max: 200 });
	/** Rows the band must occupy, 0 when the terminal is too short for it. */
	const expectedRows = (rows: number, profile: GeometryProfile): number => {
		const band = defaultBandHeight(rows, profile);
		return rows - band >= MIN_ROWS_BELOW_BAND ? band : 0;
	};
	/** The dock panelLayout settles on at this width, before composition. */
	const expectedDock = (cols: number, profile: GeometryProfile): number =>
		Math.max(MIN_DOCK_COLS, Math.min(dockColsFor(cols, null, profile), cols - 40));

	afterAll(async () => {
		rmSync(CONFIG_FILE, { recursive: true, force: true });
		h.setSize(120, 45);
		await h.emit("session_start");
		await h.command("split");
		await h.command("split-height", "20");
	});

	test("the resolved preset sizes the band and the dock for any terminal", async () => {
		await fc.assert(
			fc.asyncProperty(
				columnsArb,
				rowsArb,
				fc.option(fc.constantFrom("4k", "wide"), { nil: undefined }),
				async (cols, rows, saved) => {
					// No saved preset = `auto`, which must read the aspect ratio.
					writeConfig({
						...fullLayout,
						// toolsWidthPct pinned so the 65/35 band split is the spec's.
						toolsWidthPct: 35,
						...(saved === undefined ? {} : { geometry: saved }),
					});
					h.setSize(cols, rows);
					await h.emit("session_start");
					const preset = saved ?? autoGeometryMode(cols, rows);
					const profile = GEOMETRY_PROFILES[preset];
					const want = expectedRows(rows, profile);
					const lines = h.widget()!.render(cols);
					expect(lines.length).toBe(want);
					if (want === 0) return;
					assertExactWidth(lines, cols);
					// files on and cols >= 90: the dock is always there, and the
					// remaining columns split 65 / 35 between thinking and tools.
					const dock = expectedDock(cols, profile);
					const remaining = cols - dock;
					const tools = bandToolsColsFor(remaining, 35);
					expect(columnStarts(lines[0])).toEqual([0, remaining - tools, cols - dock]);
				},
			),
			{ numRuns: 40, seed: 20261101 },
		);
	});

	test("a pinned height survives any preset switch and the message names the real dock", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 24, max: 140 }),
				fc.integer({ min: 1, max: 200 }),
				fc.constantFrom("4k", "wide"),
				async (rows, pin, preset) => {
					writeConfig(fullLayout); // no saved height: nothing pinned yet
					h.setSize(120, rows);
					await h.emit("session_start");
					await h.command("split-height", String(pin));
					await h.command("split-geometry", preset);
					// The command clamps to what leaves the transcript its rows.
					const applied = Math.max(MIN_BAND_HEIGHT, Math.min(maxBandHeight(rows), pin));
					const fits = rows - applied >= MIN_ROWS_BELOW_BAND;
					const lines = h.widget()!.render(120);
					expect(lines.length).toBe(fits ? applied : 0);
					const message = h.notifications.at(-1)?.message ?? "";
					expect(message).toContain(`band height ${applied} rows (pinned)`);
					if (!fits) return;
					assertExactWidth(lines, 120);
					const dock = Number(/dock (\d+) cols/.exec(message)?.[1]);
					expect(dock).toBe(120 - columnStarts(lines[0])[2]);
				},
			),
			{ numRuns: 40, seed: 20261101 },
		);
	});

	test("a preset switch re-lays the dock even when both presets share a band height", async () => {
		// Above ~229 rows both curves sit on the 80-row ceiling, so the height
		// is identical and only the dock moves: the band memo must still drop.
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 625, max: 900 }),
				fc.integer({ min: 229, max: 400 }),
				async (cols, rows) => {
					writeConfig(fullLayout);
					h.setSize(cols, rows);
					await h.emit("session_start");
					await h.command("split-geometry", "4k");
					const fourK = h.widget()!.render(cols);
					await h.command("split-geometry", "wide");
					const wide = h.widget()!.render(cols);
					expect(fourK.length).toBe(MAX_BAND_HEIGHT);
					expect(wide.length).toBe(MAX_BAND_HEIGHT);
					// Both presets are at their dock ceilings here (120 vs 200).
					expect(cols - columnStarts(fourK[0])[2]).toBe(120);
					expect(cols - columnStarts(wide[0])[2]).toBe(200);
				},
			),
			{ numRuns: 20, seed: 20261101 },
		);
	});

	test("/split-geometry accepts exactly auto|4k|wide and is a no-op otherwise", async () => {
		await fc.assert(
			fc.asyncProperty(fc.string(), fc.constantFrom("auto", "4k", "wide"), async (arg, initial) => {
				writeConfig({ ...fullLayout, geometry: initial });
				h.setSize(500, 40); // ultrawide, so the presets differ visibly
				await h.emit("session_start");
				const before = h.widget()!.render(500);
				const seen = h.notifications.length;
				await h.command("split-geometry", arg);
				expect(h.notifications.length).toBe(seen + 1);
				const last = h.notifications.at(-1)!;
				const normalized = arg.trim().toLowerCase();
				const accepted =
					normalized === "" ||
					normalized === "auto" ||
					normalized === "4k" ||
					normalized === "wide";
				if (!accepted) {
					expect({ level: last.level, message: last.message }).toEqual({
						level: "error",
						message: "Invalid geometry (usage: /split-geometry auto|4k|wide)",
					});
					// A rejected argument must not move a single cell.
					expect(h.widget()!.render(500)).toEqual(before);
					return;
				}
				expect(last.level).toBe("info");
				expect(last.message.startsWith("Geometry: ")).toBe(true);
				const lines = h.widget()!.render(500);
				assertExactWidth(lines, 500);
			}),
			{ numRuns: 80, seed: 20261101 },
		);
	});

	test("every literal round-trips through /split-save and drives the next session", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom("auto", "4k", "wide"),
				columnsArb,
				fc.integer({ min: 40, max: 140 }), // tall enough that the band renders
				async (setting, cols, rows) => {
					writeConfig(fullLayout);
					h.setSize(cols, rows);
					await h.emit("session_start");
					await h.command("split-geometry", setting);
					await h.command("split-save");
					expect(loadUiPanelsConfig().geometry).toBe(setting);
					// Persisted and re-read, the value must not degrade to a default.
					expect(normalizeConfig(loadUiPanelsConfig()).geometry).toBe(setting);
					// Next session: the saved preset still decides the dock width.
					await h.emit("session_start");
					const lines = h.widget()!.render(cols);
					const preset = setting === "auto" ? autoGeometryMode(cols, rows) : setting;
					assertExactWidth(lines, cols);
					expect(cols - columnStarts(lines[0])[2]).toBe(expectedDock(cols, GEOMETRY_PROFILES[preset]));
				},
			),
			{ numRuns: 24, seed: 20261101 },
		);
	});
});

/**
 * Command argument handling and the disk -> live direction of the config: bad
 * or out-of-range arguments must not move the layout, and a saved layout must
 * be applied in full on the next `session_start` (one field per assertion, all
 * deliberately different from the live layout so nothing passes by default).
 */
describe("command arguments and saved layout", () => {
	const layout = async () => {
		h.setSize(120, 45);
		await h.command("split-height", "20");
		await h.command("split-tools-width", "35");
		await setToggle("split-thinking", /Thinking on/);
		await setToggle("split-tools", /Tools on/);
		await setToggle("files", /Files panel on/);
		await setToggle("split-tools-view", /compact/);
		await setToggle("split-diff", /\bon$/);
	};

	beforeAll(layout);
	afterAll(async () => {
		// `filesWidth` has no command of its own, so only a config-free
		// session_start resets it to auto; leaving 60 behind would squeeze the
		// tools column for every later suite.
		rmSync(CONFIG_FILE, { recursive: true, force: true });
		await h.emit("session_start");
		await layout();
		await h.command("split-trim-response", "off");
	});

	test("/split-tools-width ignores an empty or non-numeric argument", async () => {
		const before = columnStarts(h.widget()!.render(120)[0]);
		for (const [arg, message] of [
			["", "usage: /split-tools-width 20-60"],
			["abc", "Invalid percentage"],
		] as const) {
			h.notifications.length = 0;
			await h.command("split-tools-width", arg);
			expect(h.notifications.at(-1)?.message).toContain(message);
			// The band is untouched: neither call may move the split.
			expect(columnStarts(h.widget()!.render(120)[0])).toEqual(before);
		}
		expect(h.notifications.at(-1)?.level).toBe("error");
	});

	test("/split-tools-width clamps to 20-60 and re-splits the band", async () => {
		// 120 cols: files dock 34, leaving 86 for thinking | tools.
		await h.command("split-tools-width", "5");
		expect(h.notifications.at(-1)?.message).toContain("20%");
		expect(columnStarts(h.widget()!.render(120)[0])).toEqual([0, 66, 86]);
		await h.command("split-tools-width", "99");
		expect(h.notifications.at(-1)?.message).toContain("60%");
		expect(columnStarts(h.widget()!.render(120)[0])).toEqual([0, 34, 86]);
		await h.command("split-tools-width", "35");
	});

	test("/split-height ignores a non-numeric argument", async () => {
		const before = h.widget()!.render(120).length;
		h.notifications.length = 0;
		await h.command("split-height", "tall");
		expect(h.notifications.at(-1)?.message).toContain("usage: /split-height");
		expect(h.widget()!.render(120).length).toBe(before);
	});

	test("/files warns when the panel cannot dock below 90 columns", async () => {
		h.setSize(80, 45);
		h.notifications.length = 0;
		await h.command("files"); // off
		await h.command("files"); // on at 80 cols
		expect(h.notifications.at(-1)).toMatchObject({
			level: "warning",
			message: expect.stringContaining("hidden below 90 cols"),
		});
		h.setSize(120, 45);
		await h.command("files"); // leave it off for the reload test's expectations
		await h.command("files");
	});

	test("session_start applies the layout saved on disk", async () => {
		// A layout that differs from the live one on every field, so nothing can
		// pass by accident: tools off, diff off, full detail, response-only,
		// 24 rows, 45% tools, 60-col dock.
		writeFileSync(
			CONFIG_FILE,
			JSON.stringify({
				split: true,
				thinking: true,
				tools: false,
				files: true,
				diff: false,
				toolMode: "full",
				trimResponse: true,
				bandHeight: 24,
				toolsWidthPct: 45,
				filesWidth: 60,
			}),
		);
		h.setSize(120, 45);
		await h.emit("session_start");
		const lines = h.widget()!.render(120);
		expect(lines.length).toBe(24);
		assertExactWidth(lines, 120);
		const text = lines.join("\n");
		expect(text).toContain("Thinking");
		expect(text).toContain("📂 Files");
		expect(text).not.toContain("Tool Usage");
		expect(text).not.toContain("Last Edit");
		// Explicit 60-col dock (auto would be 34 at this width).
		expect(columnStarts(lines[0])).toEqual([0, 60]);
		expect(effective("display.hideToolActivity")).toBe(true);

		// toolMode "full" and toolsWidthPct 45 land once the panel is shown:
		// 120 - 60 dock = 60 for thinking | tools, 45% of it to tools.
		await h.command("split-tools");
		await h.emit("tool_execution_start", { toolCallId: "saved", toolName: "bash", args: { command: "true" } });
		await h.emit("tool_execution_end", {
			toolCallId: "saved",
			result: { content: [{ type: "text", text: "restored output line" }] },
			isError: false,
		});
		const withTools = h.widget()!.render(120);
		expect(columnStarts(withTools[0])).toEqual([0, 33, 60]);
		expect(withTools.join("\n")).toContain("restored output line");
	});

	test("/split on restores the size and geometry saved with the layout", async () => {
		writeFileSync(
			CONFIG_FILE,
			JSON.stringify({
				split: true,
				thinking: true,
				tools: true,
				files: true,
				diff: false,
				toolMode: "full",
				bandHeight: 24,
				toolsWidthPct: 45,
				filesWidth: 60,
				geometry: "4k",
			}),
		);
		h.setSize(120, 45);
		await h.emit("session_start");
		// Diverge from the saved layout on every size/geometry field it records.
		await h.command("split-height", "8");
		await h.command("split-tools-width", "60");
		await h.command("split-geometry", "wide");
		await setToggle("split-tools-view", /compact/);
		await h.command("split"); // off
		await h.command("split"); // on: the saved layout, not the live one
		const lines = h.widget()!.render(120);
		expect(lines.length).toBe(24);
		assertExactWidth(lines, 120);
		// Saved 60-col dock, and 45% of the remaining 60 cols to the tools column.
		expect(columnStarts(lines[0])).toEqual([0, 33, 60]);
		const text = lines.join("\n");
		expect(text).toContain("Thinking");
		expect(text).toContain("Tool Usage");
		// Saved `diff: false` keeps the edit-diff subpanel closed.
		expect(text).not.toContain("Last Edit");
		// Saved toolMode "full" shows output under the tool row, not compact.
		await h.emit("tool_execution_start", { toolCallId: "restored", toolName: "bash", args: { command: "true" } });
		await h.emit("tool_execution_end", {
			toolCallId: "restored",
			result: { content: [{ type: "text", text: "restored-full" }] },
			isError: false,
		});
		expect(h.widget()!.render(120).join("\n")).toContain("restored-full");
		// The restored preset was 4k, so the argument-less flip goes to wide.
		h.notifications.length = 0;
		await h.command("split-geometry");
		expect(h.notifications.at(-1)?.message).toMatch(/^Geometry: wide\b/);
		rmSync(CONFIG_FILE, { recursive: true, force: true });
	});

	test("property: off/on restores the whole saved layout for any config", async () => {
		h.setSize(120, 100);
		const scenario = fc.record({
			thinking: fc.boolean(),
			tools: fc.boolean(),
			files: fc.boolean(),
			diff: fc.boolean(),
			toolMode: fc.constantFrom("compact", "full"),
			trimResponse: fc.boolean(),
			bandHeight: fc.integer({ min: 6, max: 40 }),
			toolsWidthPct: fc.integer({ min: 20, max: 60 }),
			filesWidth: fc.option(fc.integer({ min: 24, max: 80 }), { nil: null }),
			geometry: fc.constantFrom("auto", "4k", "wide"),
		});
		const emitContent = async () => {
			await h.emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
			await h.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "saved-layout-thought" } });
			await h.emit("message_update", {
				assistantMessageEvent: { type: "thinking_end", content: "saved-layout-thought" },
			});
			// No tool_execution_*: a tool row renders a wall-clock duration, and the
			// two captures are a few commands apart. The files row alone gives the
			// files column content to compare.
			await h.emit("tool_call", { toolName: "read", input: { path: "/tmp/restore.ts" } });
		};
		try {
			await fc.assert(
				fc.asyncProperty(scenario, async cfg => {
					// A fresh branch: session_start rebuilds the panels from it, so the
					// captures below cannot inherit content from an earlier case.
					h.setBranch([]);
					// At least one panel must be saved: with none the band is unmounted and
					// there is no layout to compare (a response-only layout restores the
					// size only, which this oracle cannot see).
					fc.pre(cfg.thinking || cfg.tools || cfg.files);
					writeConfig({ split: true, ...cfg });
					await h.emit("session_start");
					await emitContent();
					const initial = h.widget()!.render(120);
					// Diverge on every size/geometry field the restore owns; the height
					// is always different, so the divergence is always observable.
					await h.command("split-height", cfg.bandHeight === 8 ? "9" : "8");
					await h.command("split-tools-width", cfg.toolsWidthPct === 60 ? "20" : "60");
					await h.command("split-geometry", cfg.geometry === "wide" ? "4k" : "wide");
					await setToggle("split-tools-view", cfg.toolMode === "full" ? /compact/ : /full/);
					const diverged = h.widget()!.render(120);
					expect(diverged).not.toEqual(initial);
					await h.command("split"); // off
					await h.command("split"); // on: the saved layout
					expect(h.widget()!.render(120)).toEqual(initial);
				}),
				{ numRuns: 15, seed: 20261101 },
			);
		} finally {
			h.setSize(120, 45);
			rmSync(CONFIG_FILE, { recursive: true, force: true });
		}
	});
});

describe("persistence and lifecycle", () => {
	const resetConfig = () => rmSync(CONFIG_FILE, { recursive: true, force: true });
	test("config load tolerates missing, malformed and non-object files", () => {
		resetConfig();
		expect(loadUiPanelsConfig()).toEqual({});
		for (const garbage of ["not json {", "null", "[]", "42"]) {
			writeFileSync(CONFIG_FILE, garbage);
			expect(loadUiPanelsConfig()).toEqual({});
		}
		writeFileSync(CONFIG_FILE, JSON.stringify({ split: true, bandHeight: 12 }));
		expect(loadUiPanelsConfig()).toEqual({ split: true, bandHeight: 12 });
		resetConfig();
	});

	test("save creates the agent directory and leaves no temp file", () => {
		resetConfig();
		// A fresh agent directory: the first /split-save must not fail.
		rmSync(dirname(CONFIG_FILE), { recursive: true, force: true });
		expect(saveUiPanelsConfig({ split: true })).toBe(true);
		expect(readdirSync(dirname(CONFIG_FILE))).toEqual([basename(CONFIG_FILE)]);
		expect(JSON.parse(readFileSync(CONFIG_FILE, "utf8"))).toEqual({ split: true });
		resetConfig();
	});

	test("save reports a write failure instead of throwing", () => {
		resetConfig();
		expect(saveUiPanelsConfig({ split: true })).toBe(true);
		expect(JSON.parse(readFileSync(CONFIG_FILE, "utf8"))).toEqual({ split: true });
		resetConfig();
		// A directory at the config path makes the rename fail.
		mkdirSync(CONFIG_FILE, { recursive: true });
		expect(saveUiPanelsConfig({ split: true })).toBe(false);
		// The temp file is cleaned up, so a retry cannot pick up a stale write.
		expect(readdirSync(dirname(CONFIG_FILE)).some(entry => entry.endsWith(".tmp"))).toBe(false);
		resetConfig();
	});

	test("/split-save persists the live layout, and reports a failed write", async () => {
		resetConfig();
		await ensurePanel("Thinking", "split-thinking");
		await ensurePanel("Tool Usage", "split-tools");
		await ensurePanel("📂 Files", "files");
		// Other suites leave diff/toolMode/trimResponse in either state; read the
		// saved layout once, then normalize only those three toggles.
		await h.command("split-save");
		const before = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
		if (before.diff !== true) await h.command("split-diff");
		if (before.toolMode !== "compact") await h.command("split-tools-view");
		if (before.trimResponse) await h.command("split-trim-response", "off");
		await h.command("split-height", "12");
		await h.command("split-tools-width", "45");
		h.notifications.length = 0;
		await h.command("split-save");
		expect(h.notifications.at(-1)).toMatchObject({ level: "info" });
		expect(JSON.parse(readFileSync(CONFIG_FILE, "utf8"))).toMatchObject({
			split: true,
			thinking: true,
			tools: true,
			files: true,
			diff: true,
			toolMode: "compact",
			trimResponse: false,
			bandHeight: 12,
			toolsWidthPct: 45,
		});

		resetConfig();
		mkdirSync(CONFIG_FILE, { recursive: true });
		h.notifications.length = 0;
		await h.command("split-save");
		expect(h.notifications.at(-1)).toMatchObject({
			level: "error",
			message: expect.stringContaining("Could not save"),
		});
		resetConfig();
		await h.command("split-height", "20");
		await h.command("split-tools-width", "35");
	});

	test("/split-save omits an auto band height", async () => {
		resetConfig();
		h.setSize(400, 100);
		await h.emit("session_start"); // bare; the mount-once component stays
		await h.command("split");
		await h.command("split-save");
		const saved = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
		// Auto height on a 100-row pane is 45; saving must not pin it.
		expect(saved.bandHeight).toBeUndefined();
		// The same config on a 45-row terminal re-derives 20 and stays visible;
		// a pinned 45 would leave zero transcript rows and hide the band.
		h.setSize(120, 45);
		await h.emit("session_start");
		expect(h.widget()!.render(120).length).toBe(20);
		resetConfig();
	});

	test("tool_execution_update streams partial output into the tool panel", async () => {
		await h.emit("tool_execution_start", {
			toolCallId: "upd",
			toolName: "bash",
			args: { command: "sleep 5" },
		});
		await h.emit("tool_execution_update", {
			toolCallId: "upd",
			partialResult: { content: "partial output line" },
		});
		// A second update reuses the pending flush timer.
		await h.emit("tool_execution_update", {
			toolCallId: "upd",
			partialResult: { content: "partial output line" },
		});
		await new Promise(resolve => setTimeout(resolve, 200));
		// Tool detail mode is whatever earlier suites left; make output visible.
		const outputVisible = () => h.widget()!.render(120).join("\n").includes("partial output line");
		let toggles = 0;
		while (!outputVisible() && toggles < 2) {
			await h.command("split-tools-view");
			toggles++;
		}
		expect(outputVisible()).toBe(true);
		for (; toggles > 0; toggles--) await h.command("split-tools-view");
		await h.emit("tool_execution_end", {
			toolCallId: "upd",
			result: { content: "partial output line" },
			isError: false,
		});
	});

	test("session_start, session_tree and session_switch replay the branch once", async () => {
		h.setBranch([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "replayed reasoning" },
						{ type: "toolCall", id: "b1", name: "read", arguments: { path: "/tmp/replay.ts" } },
					],
				},
			},
			{
				type: "message",
				message: { role: "toolResult", toolCallId: "b1", toolName: "read", content: "ok" },
			},
		]);
		await h.emit("session_start");
		await ensurePanel("Thinking", "split-thinking");
		await ensurePanel("Tool Usage", "split-tools");
		await ensurePanel("📂 Files", "files");
		for (const event of ["session_tree", "session_switch"]) {
			await h.emit(event);
			const joined = h.widget()!.render(120).join("\n");
			expect(joined).toContain("replayed reasoning");
			expect(joined).toContain("replay.ts");
			expect((joined.match(/replayed reasoning/g) ?? []).length).toBe(1);
		}
	});

	// W6(a): replay must not re-derive "seen" files from today's filesystem.
	test("replay never re-derives bash-seen files from the filesystem", async () => {
		const a = "/tmp/omp-sv-w6-a.txt";
		const b = "/tmp/omp-sv-w6-b.txt";
		writeFileSync(a, "x");
		writeFileSync(b, "x");
		try {
			h.setBranch([
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "w6a", name: "bash", arguments: { command: `cat ${a} | grep -v x > /dev/null` } },
							{ type: "toolCall", id: "w6b", name: "bash", arguments: { command: `ls -la ${b}` } },
							{ type: "toolCall", id: "w6c", name: "bash", arguments: { command: "sed -n 1p /etc/hostname" } },
							{ type: "toolCall", id: "w6r", name: "read", arguments: { path: "/tmp/omp-sv-w6-read.ts" } },
						],
					},
				},
			]);
			await h.emit("session_start");
			await ensurePanel("Thinking", "split-thinking");
			await ensurePanel("Tool Usage", "split-tools");
			await ensurePanel("📂 Files", "files");
			const text = () => h.widget()!.render(120).join("\n");
			const first = text();
			// Three real files were named only on bash lines; only the read counts.
			expect(first).toContain("📂 Files (1)");
			expect(first).toContain("omp-sv-w6-read.ts");
			expect(first).not.toMatch(/│\s*s omp-sv-w6-[ab]\.txt/);
			// Delete both bash-named files: a filesystem-dependent replay would
			// change the list, an identical rebuild proves it is not re-probed.
			rmSync(a, { force: true });
			rmSync(b, { force: true });
			await h.emit("session_tree");
			expect(text()).toBe(first);
		} finally {
			rmSync(a, { force: true });
			rmSync(b, { force: true });
		}
	});

	test("the live tool ticker refreshes while a call runs and stops after", async () => {
		await h.emit("tool_execution_start", {
			toolCallId: "tick",
			toolName: "bash",
			args: { command: "sleep 9" },
		});
		await new Promise(resolve => setTimeout(resolve, 1100)); // running tick
		await h.emit("tool_execution_end", {
			toolCallId: "tick",
			result: { content: "" },
			isError: false,
		});
		await new Promise(resolve => setTimeout(resolve, 1100)); // stop tick
		expect(h.widget()!.render(120).length).toBe(20);
	});

	test("host invalidate() keeps the band rendering at the same geometry", () => {
		const component = h.component()!;
		const before = component.render(120);
		component.invalidate();
		expect(component.render(120)).toEqual(before);
		assertExactWidth(before, 120);
	});

	test("empty thinking blocks are not retained", async () => {
		const before = retainedThinkingBlocks();
		for (let i = 0; i < 500; i++) {
			await h.emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
			await h.emit("message_update", { assistantMessageEvent: { type: "thinking_end", content: "" } });
		}
		expect(retainedThinkingBlocks()).toBe(before);
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "real thought" } });
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_end", content: "real thought" } });
		expect(retainedThinkingBlocks()).toBe(before + 1);
		expect(h.widget()!.render(120).join("\n")).toContain("real thought");
	});

	test("a non-edit tool result updates the files-pane diff", async () => {
		// input.path wins.
		await h.emit("tool_result", {
			toolName: "patch",
			input: { path: "/tmp/prop.ts" },
			details: { diff: "@@ -1 +1 @@\n-old\n+patched" },
		});
		let joined = h.widget()!.render(120).join("\n");
		expect(joined).toContain("✎ prop.ts");
		expect(joined).toContain("+patched");

		// No input.path: details.path is the fallback.
		await h.emit("tool_result", {
			toolName: "patch",
			input: {},
			details: { path: "/tmp/prop2.ts", diff: "@@ -1 +1 @@\n-a\n+second" },
		});
		joined = h.widget()!.render(120).join("\n");
		expect(joined).toContain("✎ prop2.ts");
		expect(joined).toContain("+second");

		// No resolvable path: leave the pane untouched (input is not even a record).
		await h.emit("tool_result", {
			toolName: "patch",
			input: "",
			details: { diff: "@@ -1 +1 @@\n-x\n+orphan" },
		});
		joined = h.widget()!.render(120).join("\n");
		expect(joined).toContain("✎ prop2.ts");
		expect(joined).not.toContain("+orphan");
	});

	test("a files-only layout below 90 columns shows why it is hidden", async () => {
		await h.command("split-thinking"); // off
		await h.command("split-tools"); // off
		for (const width of [40, 60, 89]) {
			h.setSize(width, 45);
			const lines = h.widget()!.render(width);
			expect(lines.length).toBe(20);
			assertExactWidth(lines, width);
			expect(lines.join("\n")).toContain("Files panel needs ≥90 cols");
			expect(lines.join("\n")).toContain("📂 Files");
		}
		h.setSize(120, 45);
		await h.command("split-thinking"); // back on
		await h.command("split-tools"); // back on
	});

	// A settings failure latches only until the next session_start retries, so
	// the order of this test and "unsupported settings…" is not load-bearing.
	test("session_start re-applies an equal policy after a reload", async () => {
		// A /reload keeps the process-global `applied` registry but recreates
		// the settings object, so the recorded policy can equal the desired one
		// while the new settings carry no override. Force must re-apply it.
		ensurePanel("Thinking", "split-thinking");
		// The thinking panel owns the transcript stream, so the desired policy
		// hides thinking; write the same layout for the reload to pick up.
		writeConfig({ split: true, thinking: true, tools: true, files: true });
		await h.command("split-trim-response", "off");
		const hideThinking = lookup("hideThinkingBlock");
		expect(hideThinking).toBeDefined();
		hideThinking!.clearOverride(settings);
		const registry = (globalThis as Record<symbol, { applied: unknown } | undefined>)[
			Symbol.for("omp.split-view.visibility")
		];
		expect(registry?.applied).toEqual({ hideThinking: true, hideTools: false });
		expect(effective("hideThinkingBlock")).toBe(false);
		await h.emit("session_start");
		expect(effective("hideThinkingBlock")).toBe(true);
		resetConfig();
	});

	test("/split-trim-response argument forms toggle and report", async () => {
		await h.command("split-trim-response", "off");
		expect(effective("display.hideToolActivity")).toBe(false);
		await h.command("split-trim-response", "ON"); // case-insensitive
		expect(effective("hideThinkingBlock")).toBe(true);
		expect(effective("display.hideToolActivity")).toBe(true);
		// An explicit argument is absolute: "on" again stays on, unlike a toggle.
		await h.command("split-trim-response", "ON");
		expect(effective("display.hideToolActivity")).toBe(true);
		await h.command("split-trim-response", "banana"); // unknown arg toggles
		expect(effective("display.hideToolActivity")).toBe(false);
		expect(h.notifications.at(-1)?.message).toContain("Transcript:");
	});

	test("unsupported settings warn and do not apply an override", async () => {
		// Force the "off" policy first: with the same policy already applied,
		// syncTranscriptVisibility returns early and never reaches the failing call.
		await h.command("split-trim-response", "off");
		const before = effective("display.hideToolActivity");
		h.setSettings(new Proxy({}, { get() { throw new Error("no settings"); } }));
		try {
			await h.command("split-trim-response", "on");
		} finally {
			h.setSettings(settings);
		}
		expect(effective("display.hideToolActivity")).toBe(before);
		expect(h.notifications.at(-1)).toMatchObject({
			level: "warning",
			message: expect.stringContaining("Response-only needs"),
		});
	});

	test("session_start retries transcript visibility after a settings failure", async () => {
		// The failing apply above latched the module flag for the process; a new
		// session may run against a usable settings object and must try again.
		writeConfig({ split: true, thinking: true, tools: true, trimResponse: true });
		await h.emit("session_start");
		expect(effective("display.hideToolActivity")).toBe(true);
		await h.command("split-trim-response", "off");
		resetConfig();
	});

	test("property: a failed settings write never outlives the session that hit it", async () => {
		const scenario = fc.record({
			thinking: fc.boolean(),
			tools: fc.boolean(),
			trimResponse: fc.boolean(),
			bandHeight: fc.integer({ min: 6, max: 26 }),
			fail: fc.boolean(),
		});
		h.setSize(120, 45);
		try {
			await fc.assert(
				fc.asyncProperty(scenario, async ({ thinking, tools, trimResponse, bandHeight, fail }) => {
					// Latch the failure the way a broken host build would. Settle to a
					// known "off" policy first (the latch is clear at this point: the
					// previous run and the preceding example both end in a
					// session_start), then ask for "on" behind a settings object whose
					// every read throws, so the policy change reaches the override call
					// and latches.
					if (fail) {
						await h.command("split-trim-response", "off");
						h.setSettings(
							new Proxy(
								{},
								{
									get() {
										throw new Error("no settings");
									},
								},
							),
						);
						try {
							await h.command("split-trim-response", "on");
						} finally {
							h.setSettings(settings);
						}
					}
					writeConfig({ split: true, thinking, tools, trimResponse, bandHeight });
					await h.emit("session_start");
					// 45 rows and a band of at most 26 rows keep the band on screen, so
					// the policy is the plain one.
					expect(effective("hideThinkingBlock")).toBe(trimResponse || thinking);
					expect(effective("display.hideToolActivity")).toBe(trimResponse);
				}),
				{ numRuns: 12, seed: 20261101 },
			);
		} finally {
			h.setSettings(settings);
			// Leave a mounted, configured session for the shutdown test that follows.
			writeConfig({ split: true, thinking: true, tools: true });
			await h.emit("session_start");
			h.setSize(120, 45);
			await h.command("split-height", "20");
			resetConfig();
		}
	});

	test("session_shutdown unmounts the widget and clears timers", async () => {
		expect(h.widgets.get("split-view")).toBeDefined();
		await h.emit("session_shutdown");
		expect(h.widgets.get("split-view")).toBeUndefined();
	});
});

describe("advisor mode", () => {
	const render = (): string => h.widget()?.render(120).join("\n") ?? "";

	beforeAll(async () => {
		h.setSize(120, 45);
		// Reload so panels and the diff pane start from the branch (empty), not
		// from whatever the preceding suites left behind.
		h.setBranch([]);
		await h.emit("session_start");
		await h.command("split");
		if (!render().includes("📂 Files (")) await h.command("files");
		await h.command("split-height", "20");
	});

	afterAll(async () => {
		h.setBranch([]);
		await h.emit("session_tree");
		if (render().includes("📂 Files (")) await h.command("files");
	});

	test("main-agent activity still feeds the files and diff panes", async () => {
		await h.emit("tool_call", { toolName: "read", input: { path: "/tmp/omp-split-view/split-view.ts" } });
		await h.emit("tool_result", {
			toolName: "edit",
			toolCallId: "main1",
			input: { path: "/tmp/omp-split-view/main.ts" },
			details: { diff: "@@ -1 +1 @@\n-main old\n+main new" },
		});
		const joined = render();
		expect(joined).toContain("📂 Files (1)");
		expect(joined).toContain("split-view.ts");
		expect(joined).toContain("+main new");
		expect(joined).not.toContain("advisor new");
	});

	test("hiding the band clears the tally and showing it restores it", async () => {
		await h.emit("message_end", {
			message: {
				role: "custom",
				customType: "advisor",
				content: "<advisory/>",
				details: { notes: [{ note: "slow path", severity: "concern" }] },
			},
		});
		expect(h.status("split-view.advisor")).toBe("Advisor: 1 concern");
		await h.command("split");
		expect(h.widget()).toBeUndefined();
		expect(h.status("split-view.advisor")).toBeUndefined();
		await h.command("split");
		expect(h.status("split-view.advisor")).toBe("Advisor: 1 concern");
		await h.emit("message_end", { message: { role: "user", content: "next question", timestamp: 5 } });
	});

	// ── properties ──

	const pathFor = (slot: number): string => `/tmp/omp-split-view/f${slot}.ts`;

	/** Mount the band with the files column so a state leak is visible. */
	async function resetBand(): Promise<void> {
		h.setBranch([]);
		await h.emit("session_tree");
		if (!h.widget()) await h.command("split");
		if (!render().includes("📂 Files")) await h.command("files");
	}

	type AgentOp =
		| { agent: "main" | "advisor"; kind: "read"; slot: number }
		| { agent: "main" | "advisor"; kind: "edit"; slot: number; diff: string };

	async function applyAgentOp(op: AgentOp, index: number): Promise<void> {
		const agent = op.agent === "main" ? MAIN_AGENT : ADVISOR_AGENT;
		if (op.kind === "read") {
			await h.emit("tool_call", { toolName: "read", input: { path: pathFor(op.slot) } }, agent);
			return;
		}
		await h.emit(
			"tool_result",
			{
				toolName: "edit",
				toolCallId: `${op.agent}-${index}`,
				input: { path: pathFor(op.slot) },
				details: { diff: op.diff },
			},
			agent,
		);
	}

	interface Tally {
		blocker: number;
		concern: number;
		nit: number;
		note: number;
	}

	type TallyStep =
		| { kind: "card"; notes: { severity?: string; note: string }[] }
		| { kind: "prompt"; real: boolean };

	function tallyOf(steps: readonly TallyStep[]): Tally {
		const tally: Tally = { blocker: 0, concern: 0, nit: 0, note: 0 };
		for (const step of steps) {
			if (step.kind === "prompt") {
				if (step.real) Object.assign(tally, { blocker: 0, concern: 0, nit: 0, note: 0 });
				continue;
			}
			for (const note of step.notes) {
				const severity = note.severity;
				if (severity === "blocker" || severity === "concern" || severity === "nit") tally[severity]++;
				else tally.note++;
			}
		}
		return tally;
	}

	function formatTally(tally: Tally): string | undefined {
		const parts: string[] = [];
		const push = (count: number, one: string, many: string): void => {
			if (count > 0) parts.push(`${count} ${count === 1 ? one : many}`);
		};
		push(tally.blocker, "blocker", "blockers");
		push(tally.concern, "concern", "concerns");
		push(tally.nit, "nit", "nits");
		push(tally.note, "note", "notes");
		return parts.length > 0 ? `Advisor: ${parts.join(" · ")}` : undefined;
	}

	test("property: advisor tool activity cannot change the band", async () => {
		await resetBand();
		const advisorOps = fc.array(
			fc.oneof(
				fc.record({ kind: fc.constant("read" as const), slot: fc.integer({ min: 0, max: 9 }) }),
				fc.record({
					kind: fc.constant("edit" as const),
					slot: fc.integer({ min: 0, max: 9 }),
					diff: fc.string({ maxLength: 20 }),
				}),
				fc.record({ kind: fc.constant("exec" as const), text: fc.string({ maxLength: 20 }) }),
			),
			{ maxLength: 8 },
		);
		await fc.assert(
			fc.asyncProperty(advisorOps, async ops => {
				await resetBand();
				const before = render();
				for (const [index, op] of ops.entries()) {
					if (op.kind === "exec") {
						const toolCallId = `advisor-${index}`;
						const args = { command: "true" };
						await h.emit(
							"tool_execution_start",
							{ toolCallId, toolName: "bash", args },
							ADVISOR_AGENT,
						);
						await h.emit(
							"tool_execution_update",
							{ toolCallId, toolName: "bash", args, partialResult: { content: op.text } },
							ADVISOR_AGENT,
						);
						await h.emit(
							"tool_execution_end",
							{
								toolCallId,
								toolName: "bash",
								result: { content: [{ type: "text", text: op.text }] },
								isError: false,
							},
							ADVISOR_AGENT,
						);
						continue;
					}
					await applyAgentOp({ agent: "advisor", ...op }, index);
				}
				expect(render()).toBe(before);
			}),
			{ numRuns: 25, seed: 20261101 },
		);
	});

	test("property: the band equals the main-only subsequence of any interleaving", async () => {
		await resetBand();
		const interleavings = fc.array(
			fc.record({
				agent: fc.boolean().map(main => (main ? ("main" as const) : ("advisor" as const))),
				kind: fc.constantFrom("read" as const, "edit" as const),
				slot: fc.integer({ min: 0, max: 9 }),
				diff: fc.string({ maxLength: 16 }),
			}),
			{ maxLength: 10 },
		);
		await fc.assert(
			fc.asyncProperty(interleavings, async sequence => {
				await resetBand();
				const mainOnly = sequence.filter(op => op.agent === "main");
				for (const [index, op] of mainOnly.entries()) await applyAgentOp(op, index);
				const expected = render();
				const mainReads = mainOnly.filter(op => op.kind === "read").length;
				const mainEdits = mainOnly.filter(op => op.kind === "edit" && op.diff.length > 0).length;
				if (mainReads > 0) expect(expected).toMatch(/📂 Files \([1-9]/);
				if (mainEdits > 0) expect(expected).not.toContain("No edit yet");
				await resetBand();
				for (const [index, op] of sequence.entries()) await applyAgentOp(op, index);
				expect(render()).toBe(expected);
			}),
			{ numRuns: 30, seed: 20261101 },
		);
	});

	test("property: the tally counts notes since the last real prompt, live and replayed", async () => {
		await resetBand();
		const steps = fc.array(
			fc.oneof(
				fc.record({
					kind: fc.constant("card" as const),
					notes: fc.array(
						fc.record({
							severity: fc.option(
								fc.constantFrom("nit", "concern", "blocker", "weird"),
								{ nil: undefined },
							),
							note: fc.string({ maxLength: 12 }),
						}),
						{ maxLength: 5 },
					),
				}),
				fc.record({ kind: fc.constant("prompt" as const), real: fc.boolean() }),
			),
			{ maxLength: 8 },
		);
		await fc.assert(
			fc.asyncProperty(steps, async sequence => {
				// A real prompt is the turn boundary; start each run from zero.
				await h.emit("message_end", {
					message: { role: "user", content: "start", timestamp: 1 },
				});
				const branch: unknown[] = [];
				for (const [index, step] of sequence.entries()) {
					if (step.kind === "prompt") {
						const message = {
							role: "user",
							content: "prompt",
							timestamp: index + 2,
							synthetic: !step.real,
							attribution: step.real ? "user" : "agent",
						};
						await h.emit("message_end", { message });
						branch.push({ type: "message", message });
						continue;
					}
					const details = { notes: step.notes };
					await h.emit("message_end", {
						message: { role: "custom", customType: "advisor", content: "<advisory/>", details },
					});
					branch.push({ type: "custom_message", customType: "advisor", content: "", details });
				}
				const expected = formatTally(tallyOf(sequence));
				expect(h.status("split-view.advisor")).toBe(expected);
				// Branch replay must reconstruct the same tally.
				h.setBranch(branch);
				await h.emit("session_tree");
				expect(h.status("split-view.advisor")).toBe(expected);
			}),
			{ numRuns: 30, seed: 20261101 },
		);
	});
});

/**
 * The per-panel memo replaced one whole-band key, so its contracts are
 * properties over arbitrary state: a memoised band is byte-identical to one
 * rebuilt from scratch, a change to one panel rebuilds only that panel, and
 * neither the streaming window nor the ingest-time file fields change what a
 * settled panel shows.
 */
describe("band memo properties", () => {
	const render = (width = 200) => h.widget()?.render(width) ?? [];
	/** A known layout: all three panels, compact rows, diff on. */
	beforeAll(async () => {
		writeConfig(fullLayout);
		h.setSize(200, 60);
		await h.emit("session_start");
		await setToggle("split-thinking", /Thinking on/);
		await setToggle("split-tools", /Tools on/);
		await setToggle("files", /Files panel on/);
		await setToggle("split-tools-view", /compact/);
		await setToggle("split-diff", /\bon$/);
		await h.command("split-height", "40");
		expect(render().join("\n")).toContain("📂 Files");
	});

	afterAll(async () => {
		await resetBuffers();
		rmSync(CONFIG_FILE, { recursive: true, force: true });
		h.setSize(120, 45);
		await h.command("split-height", "20");
	});

	test("property: a memoised band equals one rebuilt from scratch", async () => {
		const step = fc.constantFrom("thinking", "tool", "file", "diff", "height", "width", "view");
		await fc.assert(
			fc.asyncProperty(
				fc.array(step, { maxLength: 6 }),
				fc.integer({ min: 90, max: 220 }),
				fc.integer({ min: 20, max: 40 }),
				async (steps, width, height) => {
					// Room for the band plus the transcript it must not eat into, so
					// the comparison is never between two hidden bands.
					h.setSize(width, height + MIN_ROWS_BELOW_BAND);
					await h.command("split-height", String(height));
					await resetBuffers();
					// Warm the memo before the steps, so a step the keys miss leaves a
					// stale panel behind for the comparison below to catch.
					render(width);
					for (const [index, kind] of steps.entries()) {
						const label = `memo${index}`;
						if (kind === "thinking") {
							await h.emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
						} else if (kind === "tool") {
							await h.emit("tool_execution_start", {
								toolCallId: label,
								toolName: "bash",
								args: { command: label },
							});
							await h.emit("tool_execution_end", {
								toolCallId: label,
								result: { content: label },
								isError: false,
							});
						} else if (kind === "file") {
							await h.emit("tool_call", {
								toolName: "read",
								input: { path: `/tmp/omp-split-view/${label}.ts` },
							});
						} else if (kind === "diff") {
							await h.emit("tool_result", {
								toolName: "edit",
								input: { path: `/tmp/omp-split-view/${label}.ts` },
								details: { diff: `@@ -1 +1 @@\n-${label}\n+${label}!` },
							});
						} else if (kind === "height") {
							await h.command("split-height", String(20 + index));
						} else if (kind === "width") {
							h.setSize(90 + index * 10, height + MIN_ROWS_BELOW_BAND);
						} else {
							await h.command("split-tools-view");
						}
					}
					const memoised = render(width);
					expect(memoised.length).toBeGreaterThan(0);
					assertExactWidth(memoised, width);
					// A render that changes nothing builds nothing.
					const settled = panelRenderCounts();
					expect(render(width)).toEqual(memoised);
					expect(panelRenderCounts()).toEqual(settled);
					// Rebuilt from nothing: equal rows mean every key covers its inputs.
					h.component()!.invalidate();
					expect(render(width)).toEqual(memoised);
				},
			),
			{ numRuns: 40, seed: 20261101 },
		);
	});

	test("property: a change to one panel rebuilds only that panel", async () => {
		const changed = fc.constantFrom("thinking", "tools", "files");
		await fc.assert(
			fc.asyncProperty(
				changed,
				fc.integer({ min: 90, max: 220 }),
				fc.integer({ min: 20, max: 40 }),
				async (panel, width, height) => {
					h.setSize(width, height + MIN_ROWS_BELOW_BAND);
					await h.command("split-height", String(height));
					await resetBuffers();
					// Warm every panel: this render is the baseline, not a build wall.
					expect(render(width).join("\n")).toContain("📂 Files");
					const before = panelRenderCounts();
					const expected = { thinking: "a confined thought", tools: "grep", files: "confined.ts" }[panel];
					if (panel === "thinking") {
						await h.emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
						await h.emit("message_update", {
							assistantMessageEvent: { type: "thinking_delta", delta: expected },
						});
						await h.emit("message_update", {
							assistantMessageEvent: { type: "thinking_end", content: expected },
						});
					} else if (panel === "tools") {
						await h.emit("tool_execution_start", {
							toolCallId: "confined",
							toolName: expected,
							args: { pattern: "x" },
						});
						await h.emit("tool_execution_end", {
							toolCallId: "confined",
							result: { content: "hit" },
							isError: false,
						});
					} else {
						await h.emit("tool_call", {
							toolName: "read",
							input: { path: `/tmp/omp-split-view/${expected}` },
						});
					}
					expect(render(width).join("\n")).toContain(expected);
					expect(panelRenderCounts()).toEqual({
						thinking: before.thinking + Number(panel === "thinking"),
						tools: before.tools + Number(panel === "tools"),
						files: before.files + Number(panel === "files"),
					});
				},
			),
			{ numRuns: 18, seed: 20261101 },
		);
	});

	test("property: a cumulative stream renders what one final result renders", async () => {
		const line = fc
			.array(fc.constantFrom("a", "b", "c", "1", "-"), { minLength: 1, maxLength: 10 })
			.map(chars => chars.join(""));
		const scenario = fc.record({
			lines: fc.array(line, { minLength: 1, maxLength: 60 }),
			updates: fc.integer({ min: 1, max: 12 }),
		});
		/** Everything the band shows below the tool's own row. */
		const detail = (band: readonly string[]): string => {
			const at = band.findIndex(row => row.includes("bash"));
			expect(at).toBeGreaterThanOrEqual(0);
			return band.slice(at + 1).join("\n");
		};
		await fc.assert(
			fc.asyncProperty(scenario, async ({ lines, updates }) => {
				h.setSize(200, 100);
				await h.command("split-height", "60");
				const text = lines.join("\n");
				/** Rows while the call runs, and rows once it settled. */
				const deliver = async (streamed: boolean): Promise<{ live: string; settled: string }> => {
					await resetBuffers();
					await h.emit("tool_execution_start", {
						toolCallId: "stream",
						toolName: "bash",
						args: { command: "cat data" },
					});
					if (streamed) {
						// Cumulative partials, as the host sends them: `updates` prefixes
						// of the same output, ending on the whole text.
						for (let step = 1; step < updates; step++) {
							const upto = Math.ceil((lines.length * step) / updates);
							await h.emit("tool_execution_update", {
								toolCallId: "stream",
								partialResult: { content: [{ type: "text", text: lines.slice(0, upto).join("\n") }] },
							});
						}
					}
					// Both paths end on one update carrying the whole text, so the live
					// rows are comparable: any accumulation instead of replacement, or
					// any window that is not the newest suffix, shows up here.
					await h.emit("tool_execution_update", {
						toolCallId: "stream",
						partialResult: { content: [{ type: "text", text }] },
					});
					const live = detail(render(200));
					await h.emit("tool_execution_end", {
						toolCallId: "stream",
						result: { content: text },
						isError: false,
					});
					const settled = detail(render(200));
					assertExactWidth(render(200), 200);
					return { live, settled };
				};
				const streamed = await deliver(true);
				const once = await deliver(false);
				expect(streamed.live).toBe(once.live);
				expect(streamed.settled).toBe(once.settled);
			}),
			{ numRuns: 15, seed: 20261101 },
		);
	});

	test("property: every tracked file shows its ingest-precomputed name under its directory", async () => {
		const name = fc
			.array(fc.constantFrom("a", "b", "c", "-", "_"), { minLength: 1, maxLength: 10 })
			.map(chars => chars.join(""));
		const scenario = fc.record({
			names: fc.array(name, { minLength: 1, maxLength: 8 }),
			nested: fc.boolean(),
		});
		await fc.assert(
			fc.asyncProperty(scenario, async ({ names, nested }) => {
				h.setSize(200, 60);
				await h.command("split-height", "40");
				await resetBuffers();
				const dir = nested ? "/tmp/omp-split-view/deep" : "/tmp";
				// The index keeps every name distinct, so each row is its own file.
				const touched = names.map((stem, index) => `${stem}-${index}.ts`);
				for (const file of touched)
					await h.emit("tool_call", { toolName: "read", input: { path: `${dir}/${file}` } });
				const band = render(200);
				assertExactWidth(band, 200);
				const text = band.join("\n");
				for (const file of touched) expect(text).toContain(file);
				// A run long enough to group gets one header for its directory.
				if (touched.length > 3) expect(text).toContain(nested ? "omp-split-view/deep/" : "/tmp/");
				expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
			}),
			{ numRuns: 15, seed: 20261101 },
		);
	});
});
