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

Published on npm; install it into omp's plugin directory:

```sh
omp plugin install @marcinpohl/omp-split-view
```

Pin a version (`@0.1.0`) to stay off future releases. Verify with
`omp plugin list` or `omp plugin doctor`, remove with
`omp plugin uninstall @marcinpohl/omp-split-view`, and start a new omp session
to load it.

Or copy the three TypeScript files into omp's extension directory (no build
step; omp loads `.ts` directly):

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

Requires oh-my-pi ≥18.14.2 <19 and Bun ≥1.4.4 (the host's own floor). The
plugin declares the host packages as optional peers and omp resolves
`@oh-my-pi/*` to its own copy, so installing it never downloads a second omp
runtime.

First run is bare; `/split` turns the band on and `/split-save` makes it the
default. Start bare regardless of saved defaults with `--no-split`.

## Commands

| Command | Effect |
| --- | --- |
| `/split` | Full toggle pair: OFF = all panels off, ON = the layout saved by `/split-save` (falls back to thinking + tools when nothing was saved) |
| `/split-thinking` | Toggle the thinking panel within the band (on = transcript thinking hidden) |
| `/split-tools` | Toggle the tool panel within the band |
| `/files` | Toggle the files panel within the band |
| `/split-tools-view` | Compact ↔ full tool detail (full shows output previews) |
| `/split-tools-width <pct>` | Tools panel width as % of the band (20–60, default 35) |
| `/split-height <n>` | Band height in rows (6–80; clamped to leave 18 rows for the transcript, default the geometry preset's share of the terminal height) |
| `/split-geometry [auto\|4k\|wide]` | Geometry preset: `4k` = taller band, narrower dock; `wide` = shorter band, wider dock; no argument flips to the other preset; `auto` (default) derives it from the terminal aspect ratio |
| `/split-diff` | Toggle the files panel's edit-diff subpanel |
| `/split-trim-response [on\|off]` | Full transcript ↔ response-only |
| `/split-save` | Persist the current layout as startup defaults for new windows |

Toggles are session-local; only `/split-save` writes
`~/.omp/agent/ui-panels.json` (honoring `PI_CODING_AGENT_DIR`). The save
creates the directory when it is missing and goes through a temp file, so an
interrupted write cannot leave truncated JSON that would load as defaults.
`/split` then toggles between bare omp and that saved layout.

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
  `edit`, `ast_edit`, plus paths mentioned on a `bash` command line. The diff
  subpanel follows any tool result that reports `details.diff` plus a path —
  built-in `edit` as well as custom tools that emit the same payload. The
  stored diff is bounded to its first 400 lines (at most 64 KiB) with a
  `… +N more diff lines` marker, so one huge diff cannot slow the band.
- **Response-only mode** — sets omp's native `hideThinkingBlock` and
  `display.hideToolActivity` switches as runtime overrides, so the transcript
  shows user + assistant text only. Turning it off clears the overrides and
  restores whatever the user configured.
- **Untrusted text** — escape sequences and other C0/C1 control characters in
  model or tool text are stripped at ingestion and on branch replay, so a tool
  result, thinking delta or resumed session cannot drive the terminal.
- **Geometry** — scales with the window instead of clamping at laptop sizes,
  and picks a preset from the terminal shape: `4k` (the taller, narrower
  curve) unless the pane is at least 8 columns per row, i.e. 21:9 or wider,
  where `wide` trades band rows for dock columns. `/split-geometry` pins
  either preset and `auto` gives the choice back to the aspect ratio. Each
  tool's output preview grows from 2 to 6 lines as the band gets taller.

  | terminal | preset | band rows | thinking │ tools │ files |
  | --- | --- | --- | --- |
  | 120×45 | `4k` | 20 | 56 │ 30 │ 34 |
  | 240×40 (16:9 1440p) | `4k` | 20 | 117 │ 63 │ 60 |
  | 400×100 (4K) | `4k` | 45 | 195 │ 105 │ 100 |
  | 400×100 (4K) | `wide` | 35 | 177 │ 95 │ 128 |
  | 500×40 (32:9) | `4k` | 20 | 247 │ 133 │ 120 |
  | 500×40 (32:9) | `wide` | 14 | 221 │ 119 │ 160 |

  Both curves derive from the same shape: the band takes the preset's share
  of the rows (45 % or 35 %, floors 20/14, ceiling 80) when no height is
  saved, and the files dock takes its share of the columns (25 % clamped to
  34–120, or 32 % clamped to 40–200). A `/split-height` or a saved `bandHeight`
  always wins over the preset's own curve, and a saved `filesWidth` overrides
  the dock share. `/split-height` clamps to leave 18 rows for the transcript
  and editor, the band hides itself entirely on terminals too short for it,
  the files column drops out below 90 columns (a files-only layout keeps its
  frame and says so rather than rendering blank), and every rendered row is
  exactly the terminal width from 40 columns up (tested).

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
bun run demo      # print real band frames (no TUI required)
bun run typecheck # tsc --noEmit against @oh-my-pi/pi-tui / pi-coding-agent
bun run check:package # verify the published tarball is self-contained
```

`bun run demo` (`scripts/demo.ts`) drives the extension with a fake host and
prints the exact rows omp would receive from `render(width)`: the three-column
layout with a live edit diff, a custom tool's diff reaching the files pane, a
files-only layout on a too-narrow terminal, directory grouping/badges/
truncation, and the retained-state bounds. The band is editor chrome inside
omp's own frame, so there is no screenshot path; this is the reviewable
equivalent.

Property tests (`test/properties.test.ts`, fast-check) cover the helper
invariants and, through the widget factory, band geometry for any terminal
size, the geometry presets (both curves against literal shares, the aspect
cutoff, pinned-height invariance, argument acceptance and the `/split-save`
round-trip), cache idempotence, theme invalidation, escape-stripping, and
arbitrary event streams. Seeds are fixed, so failures reproduce.

`bun install` pulls the whole omp runtime through the host packages pinned in
`devDependencies`: `node_modules` is ~1 GB, so the first install is slow and the
cache is expected. Consumers do not pay that cost — the same packages are
optional peers, resolved to the omp copy that installs the plugin.

### CI

`.github/workflows/ci.yml` runs one `gates` job on Bun 1.4.3 for every push and
pull request, in this order — the same sequence as the local gates:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:coverage
bun run lint
bun run check:package
```

The repository has no remote yet, so the workflow stays inert until one is
added; running the five commands above locally is the equivalent check.

The Bun pin is deliberate: 1.4.4 changed lcov line attribution and reports
executed multi-line statements as missed — on the pre-preset tree it gave
`split-view.ts` 983 counted / 933 hit instead of 1034 / 1033 on the same tests
— which fails the coverage gate. Every coverage number in this repo was
measured on 1.4.3.

### Publishing

`.github/workflows/publish.yml` runs on `v*` tags: it re-runs the gates, fails
unless the tag equals `v<version>` from `package.json`, then runs
`bun publish --access public` with the `NPM_TOKEN` repository secret. A release
is `git tag -a v<version> -m "omp-split-view <version>" && git push origin
v<version>` once that secret exists; everything before the publish step can be
checked locally, but the step itself cannot (`bun publish --dry-run` packs the
tarball and then exits with `missing authentication`).

### Coverage

Metrics, thresholds and the ranked work queue live in
[`CODE_QUALITY.md`](CODE_QUALITY.md).

```sh
bun run test:coverage
```

Bun instruments TypeScript directly (no istanbul/nyc/`--experimental` flags)
and writes an lcov report; `scripts/check-coverage.ts` parses it and fails the
command below `lines = 99%` / `functions = 90%` (override with
`COVERAGE_LINES` / `COVERAGE_FUNCTIONS`). Test fixtures are excluded from the
totals. Current: 99.92% lines / 97.20% functions — the only uncovered line is
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

The baseline is 0 errors and 2 warnings, both parked by design
(`syncTranscriptVisibility` cc 15, `normalizeConfig` cc 14): they sit one step
over the cyclomatic limit and are only touched when another change touches
them. The Q1–Q7 structural batch cleared the previous hotspots
(`filesPanelLines`, `toolLines`, `reconstruct`, `renderBand`, `pathsFrom`,
`splitView`, and the `newestRows`/`renderPanel` parameter counts). Tests are
exempt from the size/complexity rules. Tests assert behaviour, not lint
cleanliness.

Tests drive the extension through its registered handlers, commands, and the
widget factory omp calls, asserting panel content and exact row widths. The
config path is redirected to a temp directory by `test/setup.ts` (bun
preload), so tests never touch the real agent directory.

## License

MIT. Portions derived from `pi-split-view` by Hugo-W (MIT).
