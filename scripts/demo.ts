/**
 * scripts/demo.ts — print the frames this extension renders, without a TUI.
 *
 * omp composites the band inside its own terminal frame, so there is no way to
 * screenshot it headlessly. This drives the extension with a fake host (the
 * same shape `test/split-view.test.ts` uses) and prints exactly the rows omp
 * would receive from `Component.render(width)`.
 *
 * Run: `bun run demo`
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The extension resolves its config path when the module loads, so point it at
// a scratch dir before importing. `bun run demo` must never touch real config.
// A static import cannot work here: it would hoist above this assignment and
// capture the real agent directory (the test suite gets the same ordering from
// bunfig.toml's `preload`).
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "omp-split-view-demo-"));

const { default: splitView, retainedThinkingBlocks, retainedToolEntries } = await import("../split-view.ts");
const { autoGeometryMode } = await import("../helpers.ts");
const { visibleWidth } = await import("@oh-my-pi/pi-tui");

/** Identity colorizer: rows print as plain text with real cell geometry. */
const flatTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	inverse: (text: string) => text,
};

// ─── minimal host ───────────────────────────────────────────────────────────

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
/** What omp stores for a widget: a factory invoked synchronously on mount. */
type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): readonly string[] };

const handlers = new Map<string, Handler>();
const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
const notifications: { message: string; level: string }[] = [];
const widgets = new Map<string, WidgetFactory | undefined>();
let branch: unknown[] = [];

const tui = {
	terminal: { columns: 120, rows: 45 },
	requestRender: () => {},
	getMutableViewport: () => ({ top: 0, length: 41 }),
};

const ctx = {
	mode: "tui",
	cwd: "/home/marcin/project",
	sessionManager: { getBranch: () => branch },
	ui: {
		theme: flatTheme,
		notify: (message: string, level: string) => notifications.push({ message, level }),
		setWidget: (key: string, factory: WidgetFactory | undefined) => {
			widgets.set(key, factory);
			if (factory) factory(tui, flatTheme);
		},
	},
};

splitView({
	on: (event: string, handler: Handler) => handlers.set(event, handler),
	registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
		commands.set(name, definition.handler),
	registerFlag: () => {},
	getFlag: () => false,
	setLabel: () => {},
	pi: { settings: {} },
	events: { on: () => () => {} },
} as never);

const emit = async (event: string, payload: Record<string, unknown> = {}) => {
	await handlers.get(event)?.(payload, ctx);
};
const command = async (name: string, args = "") => {
	await commands.get(name)?.(args, ctx);
};
const render = (width: number): readonly string[] =>
	widgets.get("split-view")?.(tui, flatTheme)?.render(width) ?? [];
/** Rebuild every buffer from the branch, leaving the layout alone. */
const resetBuffers = async (next: unknown[] = []) => {
	branch = next;
	await emit("session_tree");
};

const heading = (text: string) => {
	console.log(`\n${"─".repeat(78)}\n${text}\n${"─".repeat(78)}`);
};
const frame = (width: number) => {
	for (const line of render(width)) console.log(line);
};

// ─── scenarios ──────────────────────────────────────────────────────────────

await emit("session_start");
await command("split"); // thinking + tools
await command("files");
await command("split-height", "20");
tui.terminal.columns = 120;

heading("1. Default layout at 120x20 — thinking | tool usage | files + live edit diff");
await emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
await emit("message_update", {
	assistantMessageEvent: { type: "thinking_delta", delta: "Reading the render path before touching geometry." },
});
await emit("message_update", {
	assistantMessageEvent: { type: "thinking_end", content: "Reading the render path before touching geometry." },
});
await emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "bun test" } });
await emit("tool_execution_end", {
	toolCallId: "t1",
	result: { content: "81 pass\n0 fail" },
	isError: false,
});
await emit("tool_call", { toolName: "edit", input: { path: "/home/marcin/project/src/band.ts" } });
await emit("tool_result", {
	toolName: "edit",
	input: { path: "/home/marcin/project/src/band.ts" },
	details: { diff: "@@ -12,2 +12,2 @@\n-const rows = compose(a);\n+const rows = compose(a, filesWidth);\n" },
});
frame(120);

heading("2. A custom tool's diff reaches the files pane (no toolName === 'edit' gate)");
console.log("  the list stays empty (this tool name is not a tracked path key) — the diff pane is what changes");
await resetBuffers();
await command("split-thinking"); // off
await command("split-tools"); // off
await emit("tool_result", {
	toolName: "patch",
	input: { path: "/home/marcin/project/src/tools/patch.ts" },
	details: { diff: "@@ -1,1 +1,1 @@\n-const dryRun = true;\n+const dryRun = false;" },
});
frame(120);

heading("3. Files-only layout below 90 cols — framed, with the reason (no silent blank)");
await command("split-height", "12");
for (const width of [60, 89]) {
	console.log(`\n  ${width} cols:`);
	frame(width);
}
await command("split-height", "20");
tui.terminal.columns = 120;

heading("4. Directory grouping, merged ops, touch count and the truncation marker");
console.log("  8 files in one directory: grouped under src/, newest first; a.ts was read + edited");
await resetBuffers();
for (const name of ["b", "c", "d", "e", "f", "g", "h"])
	await emit("tool_call", { toolName: "read", input: { path: `/home/marcin/project/src/${name}.ts` } });
await emit("tool_call", { toolName: "read", input: { path: "/home/marcin/project/src/a.ts" } });
await emit("tool_call", { toolName: "edit", input: { path: "/home/marcin/project/src/a.ts" } });
frame(120);

heading("5. Large screens — geometry follows the window, not a fixed cap");
/** Bare session at a given size: no saved height, so the band sizes itself. */
const measure = async (width: number, rows: number) => {
	const previous = { columns: tui.terminal.columns, rows: tui.terminal.rows };
	tui.terminal.columns = width;
	tui.terminal.rows = rows;
	await emit("session_start");
	await command("split"); // thinking + tools on, which mounts the band
	await command("files");
	const lines = render(width);
	const starts: number[] = [];
	let cell = 0;
	for (const ch of lines[0] ?? "") {
		if (ch === "╭") starts.push(cell);
		cell += visibleWidth(ch);
	}
	tui.terminal.columns = previous.columns;
	tui.terminal.rows = previous.rows;
	return { rows: lines.length, starts };
};

console.log("  terminal    preset   band  thinking | tools | files (cols)");
for (const [width, rows] of [
	[120, 45], // classic
	[200, 60], // 1440p, larger font
	[400, 100], // 4K at a small font
	[500, 60], // ultrawide
] as const) {
	const { rows: band, starts } = await measure(width, rows);
	const thinking = (starts[1] ?? width) - (starts[0] ?? 0);
	const tools = (starts[2] ?? width) - (starts[1] ?? width);
	const files = width - (starts[2] ?? width);
	const size = `${width}x${rows}`;
	const preset = autoGeometryMode(width, rows);
	const columns = `${String(thinking).padStart(8)} | ${String(tools).padStart(5)} | ${String(files).padStart(5)}`;
	console.log(`  ${size.padEnd(11)} ${preset.padEnd(6)} ${String(band).padStart(4)}  ${columns}`);
}
console.log("  preset = auto: wide (≥8 cols/row) takes 35% of the rows and 32% of the cols,");
console.log("  4k takes 45% and 25% (20-row floor, 80-row ceiling; 34/120-col dock bounds).");
console.log("  /split-geometry pins 4k or wide; /split-height keeps 18 rows for the transcript.");

heading("6. State bounds — seams the suite asserts on");
await resetBuffers();
const blocksBefore = retainedThinkingBlocks();
for (let i = 0; i < 500; i++) {
	await emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
	await emit("message_update", { assistantMessageEvent: { type: "thinking_end", content: "" } });
}
console.log(`  retained thinking blocks after 500 empty start/end pairs: ${retainedThinkingBlocks()} (was ${blocksBefore})`);
for (let i = 0; i < 65; i++) {
	await emit("tool_execution_start", { toolCallId: `ev${i}`, toolName: "bash", args: { c: `n${i}` } });
	await emit("tool_execution_end", { toolCallId: `ev${i}`, result: { content: "" }, isError: false });
}
console.log(`  retained tool entries after 65 calls (cap is 60): ${retainedToolEntries()}`);

await emit("session_shutdown");
console.log("\nDone.");
