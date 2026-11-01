import { afterAll, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fc from "fast-check";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { Settings, settings, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import "@oh-my-pi/pi-coding-agent/session/settings";
import "@oh-my-pi/pi-coding-agent/modes/settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import splitView, { retainedThinkingBlocks, retainedToolEntries } from "../split-view.ts";
import { CONFIG_FILE, loadUiPanelsConfig, saveUiPanelsConfig } from "../ui-panels-config.ts";

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

interface Harness {
	emit: (event: string, payload?: unknown) => Promise<void>;
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

	const notifications: { message: string; level: string }[] = [];
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
		sessionManager: { getBranch: () => branch },
		ui: {
			get theme() {
				return currentTheme;
			},
			notify: (message: string, level: string) => {
				notifications.push({ message, level });
			},
			setWidget: (key: string, content: WidgetFactory | undefined) => {
				widgets.set(key, content);
				// omp invokes the factory synchronously while mounting.
				if (content) content(tui, flatTheme);
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

	const emit = async (event: string, payload: unknown = {}) => {
		const handler = handlers.get(event);
		if (handler) await handler(payload, ctx as unknown as ExtensionContext);
	};
	const command = async (name: string, args = "") => {
		const handler = commands.get(name);
		if (!handler) throw new Error(`command not registered: ${name}`);
		await handler(args, ctx as unknown as ExtensionContext);
	};

	return {
		emit,
		command,
		widget: () => {
			const factory = widgets.get("split-view");
			if (!factory) return undefined;
			return factory(tui, flatTheme);
		},
		setTheme: theme => {
			currentTheme = theme;
		},
		setSettings: value => {
			pi.settings = value;
		},
		setBranch: next => {
			branch = next;
		},
		component: () => {
			const factory = widgets.get("split-view");
			return factory ? (factory(tui, flatTheme) as BandComponent) : undefined;
		},
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

	test("band height and width split are configurable", async () => {
		await h.command("split-height", "8");
		expect(h.widget()!.render(120).length).toBe(8);
		await h.command("split-tools-width", "50");
		assertExactWidth(h.widget()!.render(100), 100);
		await h.command("split-tools-width", "35");
		await h.command("split-height", "20");
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

	test("re-rendering at another width re-wraps instead of reusing stale rows", async () => {
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
		await h.emit("message_update", {
			assistantMessageEvent: { type: "thinking_delta", delta: "wrap ".repeat(40) },
		});
		await h.emit("message_update", {
			assistantMessageEvent: { type: "thinking_end", content: "wrap ".repeat(40) },
		});
		const wide = h.widget()!.render(120);
		assertExactWidth(wide, 120);
		const narrow = h.widget()!.render(60);
		assertExactWidth(narrow, 60);
		// A stale wrap cache keyed only on text would reuse the 60-col rows here.
		expect(h.widget()!.render(120)).toEqual(wide);
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

	test("a visible thinking panel hides transcript thinking", () => {
		expect(effective("hideThinkingBlock")).toBe(true);
		// Tool activity stays untouched: the tool panel does not replace it.
		expect(effective("display.hideToolActivity")).toBe(false);
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
	const ensure = async (label: string, command: string) => {
		if (h.widget()?.render(120).join("\n").includes(label)) return;
		await h.command(command);
	};

	beforeAll(async () => {
		h.setSize(120, 45);
		await h.command("split-height", "20");
		await ensure("Thinking", "split-thinking");
		await ensure("Tool Usage", "split-tools");
		await ensure("📂 Files", "files");
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
				fc.array(fc.integer({ min: 40, max: 240 }), { minLength: 2, maxLength: 6 }),
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

	test("every theme colour the band uses invalidates the row cache", async () => {
		const palette: Record<string, string> = {};
		const themed = {
			...flatTheme,
			fg: (color: string, text: string) => `${palette[color] ?? ""}${text}`,
		};
		h.setTheme(themed);
		try {
			const before = h.widget()!.render(120);
			for (const color of ["border", "accent", "text", "muted", "dim", "success", "thinkingText"]) {
				palette[color] = `\u0001${color}`;
				expect({ color, changed: h.widget()!.render(120) }).not.toEqual({ color, changed: before });
				delete palette[color];
			}
		} finally {
			h.setTheme(flatTheme);
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
				await ensure("Thinking", "split-thinking");
				await ensure("Tool Usage", "split-tools");
				await ensure("📂 Files", "files");
				await h.command("split-height", "20");
			}),
			{ numRuns: 20, seed: 20261101 },
		);
		// A generated run can leave the band too tall to fit, which makes every
		// label unrenderable and makes the per-run `ensure` above toggle panels
		// OFF instead of on. Restore the mount point the later suites assume.
		h.setSize(120, 45);
		await h.command("split-height", "20");
		await ensure("Thinking", "split-thinking");
		await ensure("Tool Usage", "split-tools");
		await ensure("📂 Files", "files");
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
	const setToggle = async (command: string, message: RegExp) => {
		await h.command(command);
		if (!message.test(h.notifications.at(-1)?.message ?? "")) await h.command(command);
	};
	const setToolMode = (full: boolean) => setToggle("split-tools-view", full ? /full/ : /compact/);
	const setDiff = (on: boolean) => setToggle("split-diff", on ? /\bon$/ : /\boff$/);
	/** `session_tree` rebuilds every buffer from the branch, leaving layout alone. */
	const resetBuffers = async (branch: unknown[] = []) => {
		h.setBranch(branch);
		await h.emit("session_tree");
	};
	/** Rendered rows, or "" when the band is unmounted/hidden. */
	const visible = () => h.widget()?.render(120).join("\n") ?? "";
	/** Panel toggles announce the new state; drive them to a known state. */
	const setPanel = async (command: string, on: RegExp) => {
		await h.command(command);
		if (!on.test(h.notifications.at(-1)?.message ?? "")) await h.command(command);
	};

	beforeAll(async () => {
		h.setSize(120, 45);
		await h.command("split-height", "20");
		await setPanel("split-thinking", /Thinking on/);
		await setPanel("split-tools", /Tools on/);
		await setPanel("files", /Files panel on/);
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

	test("a long tool result previews two lines and counts the rest", async () => {
		await resetBuffers();
		await setToolMode(true);
		await h.emit("tool_execution_start", { toolCallId: "out1", toolName: "bash", args: { command: "seq 5" } });
		await h.emit("tool_execution_end", {
			toolCallId: "out1",
			result: { content: [{ type: "text", text: "lineA\nlineB\nlineC\nlineD\nlineE" }] },
			isError: false,
		});
		const text = joined();
		expect(text).toContain("lineA");
		expect(text).toContain("lineB");
		expect(text).toContain("· +3 more");
		// The preview is capped: the third line must not leak into the panel.
		expect(text).not.toContain("lineC");
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
		const text = joined();
		expect(text).toContain("[Image: [image/png]");
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
			// The flush bumps the version, which invalidates the band cache.
			expect(joined()).toContain("live tail");
		} finally {
			vi.useRealTimers();
		}
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_end", content: "live tail" } });
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
	const writeConfig = (cfg: unknown) => writeFileSync(CONFIG_FILE, JSON.stringify(cfg));
	/** Toggle-style commands announce the new state; drive to a known one. */
	const setToggle = async (command: string, message: RegExp) => {
		await h.command(command);
		if (!message.test(h.notifications.at(-1)?.message ?? "")) await h.command(command);
	};

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
		// 40-row band -> 38 body rows -> 4 preview lines (not the classic 2).
		expect(joined).toContain("· L0");
		expect(joined).toContain("· L3");
		expect(joined).toContain("· +8 more");
		expect(joined).not.toContain("· L4");
		await setToggle("split-tools-view", /compact/);
	});
});

/**
 * Command argument handling and the disk -> live direction of the config: bad
 * or out-of-range arguments must not move the layout, and a saved layout must
 * be applied in full on the next `session_start` (one field per assertion, all
 * deliberately different from the live layout so nothing passes by default).
 */
describe("command arguments and saved layout", () => {
	const setToggle = async (command: string, message: RegExp) => {
		await h.command(command);
		if (!message.test(h.notifications.at(-1)?.message ?? "")) await h.command(command);
	};
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
});

describe("persistence and lifecycle", () => {
	const resetConfig = () => rmSync(CONFIG_FILE, { recursive: true, force: true });
	const ensure = async (label: string, command: string) => {
		if (h.widget()?.render(120).join("\n").includes(label)) return;
		await h.command(command);
	};

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

	test("save reports a write failure instead of throwing", () => {
		resetConfig();
		expect(saveUiPanelsConfig({ split: true })).toBe(true);
		expect(JSON.parse(readFileSync(CONFIG_FILE, "utf8"))).toEqual({ split: true });
		resetConfig();
		// A directory at the config path makes writeFileSync fail.
		mkdirSync(CONFIG_FILE, { recursive: true });
		expect(saveUiPanelsConfig({ split: true })).toBe(false);
		resetConfig();
	});

	test("/split-save persists the live layout, and reports a failed write", async () => {
		resetConfig();
		await ensure("Thinking", "split-thinking");
		await ensure("Tool Usage", "split-tools");
		await ensure("📂 Files", "files");
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
		await ensure("Thinking", "split-thinking");
		await ensure("Tool Usage", "split-tools");
		await ensure("📂 Files", "files");
		for (const event of ["session_tree", "session_switch"]) {
			await h.emit(event);
			const joined = h.widget()!.render(120).join("\n");
			expect(joined).toContain("replayed reasoning");
			expect(joined).toContain("replay.ts");
			expect((joined.match(/replayed reasoning/g) ?? []).length).toBe(1);
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
		expect(h.notifications.at(-1)?.message).toContain("Panel C:");
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

	test("session_shutdown unmounts the widget and clears timers", async () => {
		expect(h.widgets.get("split-view")).toBeDefined();
		await h.emit("session_shutdown");
		expect(h.widgets.get("split-view")).toBeUndefined();
	});
});
