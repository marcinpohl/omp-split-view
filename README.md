# omp-split-view

Split-view TUI extension for [oh-my-pi](https://github.com/can1357/oh-my-pi):
a band of live panels above the editor — thinking, tool usage, and files with an
edit diff — plus a response-only transcript mode.

Port of [`Hugo-W/pi-split-view`](https://github.com/Hugo-W/pi-split-view) (MIT)
to omp's TUI. The feature set is the same; the mount points are not (see
[Differences](#differences-from-the-pi-original)).

```
╭ Thinking ───────────────────────────╮╭ Tool Usage ──────────────╮╭─ 📂 Files (3) ───────╮
│ …live reasoning stream…             ││ ✓ bash echo hello        ││ r src/panel.ts       │
│                                     ││ ✓ read split-view.ts     ││ w src/layout.ts      │
╰─────────────────────────────────────╯╰──────────────────────────╯├─ ✎ src/layout.ts ────┤
╭────────────────────────────────────────────────────────────────╮│ @@ -1 +1 @@          │
│ transcript                                                      ││ -old                  │
╰────────────────────────────────────────────────────────────────╯│ +new                  │
╭─ π > model > cwd > cost ───────────────────────────────────────╮╰───────────────────────╯
╰─ … ─╯
```

## Install

Copy the three TypeScript files into omp's extension directory (no build step;
omp loads `.ts` directly):

```sh
mkdir -p ~/.omp/agent/extensions
cp split-view.ts helpers.ts ui-panels-config.ts ~/.omp/agent/extensions/
```

Or load it for one run:

```sh
omp -e /path/to/split-view.ts
```

Or install as an omp package (the manifest declares `omp.extensions`):

```sh
omp plugin install /path/to/omp-split-view
```

Requires oh-my-pi 18.x (`@oh-my-pi/pi-tui` / `@oh-my-pi/pi-coding-agent` 18+).

Start bare regardless of saved defaults with `--no-split`.

## Commands

| Command | Effect |
| --- | --- |
| `/split` | Full toggle pair: OFF = all panels off, ON = the layout saved by `/split-save` (falls back to thinking + tools when nothing was saved) |
| `/split-thinking` | Toggle the thinking panel within the band (on = transcript thinking hidden) |
| `/split-tools` | Toggle the tool panel within the band |
| `/files` | Toggle the files panel within the band |
| `/split-tools-view` | Compact ↔ full tool detail (full shows output previews) |
| `/split-tools-width <pct>` | Tools panel width as % of the band (20–60, default 35) |
| `/split-height <n>` | Band height in rows (6–40, default 20) |
| `/split-diff` | Toggle the files panel's edit-diff subpanel |
| `/split-trim-response [on\|off]` | Full transcript ↔ response-only |
| `/split-save` | Persist the current layout as startup defaults for new windows |

Toggles are session-local; only `/split-save` writes
`~/.omp/agent/ui-panels.json` (honoring `PI_CODING_AGENT_DIR`). `/split` then
toggles between bare omp and that saved layout.

## Features

- **Thinking panel** — live reasoning stream, coalesced flushes (≤20/s),
  newest-window view. While the panel is visible, thinking blocks are hidden
  from the transcript (omp's `hideThinkingBlock` switch), so reasoning is
  never shown twice. Removing the panel — or a terminal too short for the band
  — restores them. Only live/future transcript output is affected: rows
  already committed to scrollback are not rewritten (omp exposes no hook for
  that), so enable the panel at startup (`/split-save`) to keep it clean from
  the first paint.
- **Tool Usage panel** — every tool call with status, duration (live elapsed
  counter while running), compact or full detail, and its output preview.
  History is rebuilt from the session branch on resume/branch switch. Image
  results (e.g. `read` on a PNG) render as a one-line text fallback in the
  band; omp's transcript still renders them inline.
- **Files panel** — read/written/seen files newest-first, grouped by
  directory, with a live edit-diff subpanel (`/split-diff` hides the diff and
  keeps the list). File tracking comes from tool calls: `read`, `write`,
  `edit`, `ast_edit`, plus paths mentioned on a `bash` command line.
- **Response-only mode** — sets omp's native `hideThinkingBlock` and
  `display.hideToolActivity` switches as runtime overrides, so the transcript
  shows user + assistant text only. Turning it off clears the overrides and
  restores whatever the user configured.
- **Untrusted text** — escape sequences and other C0/C1 control characters in
  model or tool text are stripped at ingestion, so a tool result or thinking
  delta cannot drive the terminal.
- **Geometry** — the band hides itself on terminals too short for
  transcript + editor; the files column drops out below 90 columns; every
  rendered row is exactly the terminal width from 40 columns up (tested).

## Differences from the pi original

omp's TUI is an inline transcript composed by a `TerminalFrameProvider`
(history + viewport) with extension widgets above/below the editor. pi 1.2 had
a fullscreen layout root that an extension could wrap in HStack/VStack. That
root does not exist here, so:

| pi original | this port |
| --- | --- |
| Band above the transcript via the fullscreen layout root | Band above the editor via `ctx.ui.setWidget(..., { placement: "aboveEditor" })` |
| Files right dock spanning the transcript | Files band column (omp composites overlays over the whole viewport, so a floating dock would cover the band and editor) |
| Response-only built from pi's message components and a private ScrollView | omp's own hide-thinking / hide-tool-activity settings |
| Thinking shown in both the panel and the transcript | A visible thinking panel hides transcript thinking (restored when the panel or band is gone) |
| Mouse: drag band height, drag the tools split, drag the dock width, header `[↗]`/`[×]` buttons, wheel scrolling | Not wired — omp widgets receive no pointer events; use `/split-height`, `/split-tools-width`, `/files` |
| Answer divider between successive answers (`/split-divider`) | Not applicable — omp's transcript owns spacing |
| Subagent tool calls shown in the tool panel | Not wired — omp exposes no subagent tool-call event bus channel |
| Zoom a panel over the whole area above the editor | Not applicable — the band is editor chrome; `/split-height` grows it |

## Development

```sh
bun install
bun test          # helpers + component/integration + fast-check property tests
bun run typecheck # tsc --noEmit against @oh-my-pi/pi-tui / pi-coding-agent
```

Property tests (`test/properties.test.ts`, fast-check) cover the helper
invariants and, through the widget factory, band geometry for any terminal
size, cache idempotence, theme invalidation, escape-stripping, and arbitrary
event streams. Seeds are fixed, so failures reproduce.

`bun install` pulls the whole omp runtime through the auto-installed peer
dependencies: `node_modules` is ~1 GB, so the first install is slow and the
cache is expected.

### Coverage

```sh
bun run test:coverage
```

Bun instruments TypeScript directly (no istanbul/nyc/`--experimental` flags)
and writes an lcov report; `scripts/check-coverage.ts` parses it and fails the
command below `lines = 99%` / `functions = 90%` (override with
`COVERAGE_LINES` / `COVERAGE_FUNCTIONS`). Test fixtures are excluded from the
totals. Current: 99.91% lines / 96.36% functions — the only uncovered line is
the `themeGetter` default that throws before `session_start` binds a theme; the
uncovered functions are no-op extension exports.

### Linting and complexity metrics

Python's pylint/radon have no maintained TypeScript port; the equivalents here
are ESLint plugins and rules:

| Python | Here | Command |
| --- | --- | --- |
| pylint | ESLint 10 flat config: `@eslint/js` + `typescript-eslint` + `eslint-plugin-sonarjs` (bug patterns, unused code, suspicious logic) | `bun run lint` (`bun run lint:fix` to autofix) |
| `radon cc` | `complexity` (cyclomatic) and `sonarjs/cognitive-complexity` per function | `bun run lint` |
| `radon raw` / size | `max-lines-per-function`, `max-depth`, `max-params` | `bun run lint` |
| `radon mi` / Halstead | no maintained TS implementation; treated as out of scope | — |

The baseline is 0 errors and 15 warnings; the warnings are the complexity
report for the known hotspots (`filesPanelLines`, `reconstruct`, `renderBand`,
`splitView`). Tests are exempt from the size/complexity rules. Tests assert
behaviour, not lint cleanliness.

Tests drive the extension through its registered handlers, commands, and the
widget factory omp calls, asserting panel content and exact row widths. The
config path is redirected to a temp directory by `test/setup.ts` (bun
preload), so tests never touch the real agent directory.

## License

MIT. Portions derived from `pi-split-view` by Hugo-W (MIT).
