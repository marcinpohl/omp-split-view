import { beforeAll, describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { Settings, settings, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import "@oh-my-pi/pi-coding-agent/session/settings";
import "@oh-my-pi/pi-coding-agent/modes/settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import splitView from "../split-view.ts";

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

interface Harness {
	emit: (event: string, payload?: unknown) => Promise<void>;
	command: (name: string, args?: string) => Promise<void>;
	widget: () => { render(width: number): readonly string[] } | undefined;
	/** Swap the theme `ctx.ui.theme` returns (cache-invalidation tests). */
	setTheme: (theme: unknown) => void;
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

	const tui = {
		terminal: { columns, rows },
		requestRender: () => {},
		getMutableViewport: () => ({ top: 0, length: tui.terminal.rows - 4 }),
	};

	let currentTheme: unknown = flatTheme;
	const ctx = {
		mode: "tui",
		cwd: "/tmp",
		sessionManager: { getBranch: () => [] },
		ui: {
			get theme() {
				return currentTheme;
			},
			notify: () => {},
			setWidget: (key: string, content: WidgetFactory | undefined) => {
				widgets.set(key, content);
				// omp invokes the factory synchronously while mounting.
				if (content) content(tui, flatTheme);
			},
		},
	};

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
		pi: { settings },
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

	test("the band hides exactly when the transcript and editor need the rows", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 18, max: 60 }),
				fc.integer({ min: 6, max: 40 }),
				async (rows, height) => {
					h.setSize(120, rows);
					await h.command("split-height", String(height));
					const expected = rows - height >= 18;
					const lines = h.widget()!.render(120);
					expect(lines.length).toBe(expected ? height : 0);
					if (expected) assertExactWidth(lines, 120);
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
	});
});
