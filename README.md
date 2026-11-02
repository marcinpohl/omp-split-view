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
| `/split` | Full toggle pair: OFF = all panels off; ON = the layout saved by `/split-save`, size and geometry preset included (falls back to thinking + tools at the live size when nothing was saved) |
| `/split-thinking` | Toggle the thinking panel within the band (on = transcript thinking hidden) |
| `/split-tools` | Toggle the tool panel within the band |
| `/split-files` | Toggle the files panel within the band |
| `/split-tools-view` | Compact ↔ full tool detail (full shows output previews) |
| `/split-tools-width <pct>` | Tools panel width as % of the band (20–60, default 35) |
| `/split-height <n>` | Band height in rows (6–80; clamped to leave 18 rows for the transcript, default the geometry preset's share of the terminal height) |
| `/split-geometry [auto\|4k\|wide]` | Geometry preset: `4k` = taller band, narrower dock, thinking → tools → files; `wide` = shorter band, wider dock, files on the left of thinking and tools; no argument flips to the other preset; `auto` (default) derives it from the terminal aspect ratio |
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
  newest-window view. While the panel is visible, the transcript shows no
  reasoning at all: finished blocks are hidden through omp's
  `hideThinkingBlock` switch, and the panel also suppresses the live
  `Thinking…` head the transcript would otherwise stream. Removing the panel
  — or a terminal too short for the band — restores both. Only live/future
  transcript output is affected: rows already committed to scrollback are not
  rewritten (omp exposes no hook for that), so enable the panel at startup
  (`/split-save`) to keep it clean from the first paint.
- **Tool Usage panel** — every tool call with status, duration (live elapsed
  counter while running), compact or full detail, and its output preview
  (the newest lines, with a `+N earlier lines` count above them). The
  earlier-lines count covers the whole result, not just the retained window.
  Full-mode detail is budgeted to the band: the card keeps its own row and
  closes with `+N more detail rows` — the card rows the band withheld — instead
  of pushing that row off the top.
  History is rebuilt from the session branch on resume/branch switch. Image
  results (e.g. `read` on a PNG) render as a one-line text fallback in the
  band; omp's transcript still renders them inline.
- **Files panel** — read/written/seen files newest-first, grouped by
  directory, with a live edit-diff subpanel (`/split-diff` hides the diff and
  keeps the list). File tracking comes from tool calls: `read`, `write`,
  `edit`, `ast_edit`, plus paths mentioned on a `bash` command line. `s`
  (seen) entries are live observations: a resume or branch switch replays only
  the direct path tools and never re-probes a bash command line against the
  current filesystem. The diff
  subpanel follows any tool result that reports `details.diff` plus a path —
  built-in `edit` as well as custom tools that emit the same payload. The
  stored diff is bounded to its first 400 lines (at most 64 KiB) with a
  `… +N more diff lines` marker, so one huge diff cannot slow the band.
- **Response-only mode** — sets omp's native `hideThinkingBlock` and
  `display.hideToolActivity` switches as runtime overrides, so the transcript
  shows user + assistant text only. Turning it off clears the overrides and
  restores whatever the user configured.
- **Advisor panel** — the panel appears on its own while advisor mode is on
  (`/advisor on`, session-local) and disappears with it; nothing is written to
  `advisor.enabled`. Advisor mode emits no extension event, so the band polls
  the live session's `isAdvisorEnabled()` (400 ms, one boolean) and falls back
  to the `advisor.enabled` setting when no live session matches. The title
  carries the running tally — `Advisor · 1 blocker · 2 concerns` — and the body
  shows the newest notes of the current turn. Notes and tally reset on a real
  user prompt and rebuild from the session branch on resume. When the thinking
  panel is on, the advisor stacks above it inside that column; otherwise it is
  a full-width strip above whatever columns remain. With no other panel on, it
  takes the whole band. `--no-split` still starts bare, and `/split` off hides
  the band even when the advisor is its only panel; a new advisor activation
  re-opens it. The native transcript card is untouched: the panel is a window
  on the newest notes, not a replacement. Advisor and subagent tool calls never
  reach the thinking, tools, files or diff panes: those hooks accept only the
  top-level agent, so a review's `read`/`grep` cannot contaminate the band.
  Response-only leaves advisor cards and omp's collapsed synthetic steering
  blocks visible — the advice is the feature, and omp's two display switches
  only cover thinking and tool activity.
- **Untrusted text** — escape sequences and other C0/C1 control characters in
  model or tool text are stripped at ingestion and on branch replay, so a tool
  result, thinking delta or resumed session cannot drive the terminal.
- **Geometry** — scales with the window instead of clamping at laptop sizes,
  and picks a preset from the terminal shape: `4k` (the taller, narrower
  curve) unless the pane is at least 8 columns per row, i.e. 21:9 or wider,
  where `wide` trades band rows for dock columns and also moves the files
  panel to the left of the thinking and tool boxes (the files panel is the
  main panel of that layout; omp 18.x only places widgets full-width, so the
  transcript itself cannot be narrowed beside them). `/split-geometry` pins
  either preset and `auto` gives the choice back to the aspect ratio. Each
  tool's output preview grows from 2 to 6 lines as the band gets taller.

  | terminal | preset | band rows | files │ thinking │ tools |
  | --- | --- | --- | --- |
  | 120×45 | `4k` | 20 | 34 │ 56 │ 30 |
  | 240×40 (16:9 1440p) | `4k` | 20 | 60 │ 117 │ 63 |
  | 400×100 (4K) | `4k` | 45 | 100 │ 195 │ 105 |
  | 400×100 (4K) | `wide` | 35 | 128 │ 177 │ 95 |
  | 500×40 (32:9) | `4k` | 20 | 120 │ 247 │ 133 |
  | 500×40 (32:9) | `wide` | 14 | 160 │ 221 │ 119 |

  The table lists panel widths; `4k` renders thinking │ tools │ files, while
  `wide` renders files │ thinking │ tools (the main files panel on the left,
  the two live boxes on the right).

  Both curves derive from the same shape: the band takes the preset's share
  of the rows (45 % or 35 %, floors 20/14, ceiling 80) when no height is
  saved, and the files dock takes its share of the columns (25 % clamped to
  34–120, or 32 % clamped to 40–200). A `/split-height` or a saved `bandHeight`
  always wins over the preset's own curve; `/split-save` records a height only
  when `/split-height` pinned one, so an auto height follows each session's
  terminal instead of freezing today's number. A saved `filesWidth` overrides
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
| Mouse: drag band height, drag the tools split, drag the dock width, header `[↗]`/`[×]` buttons, wheel scrolling | Not wired — omp widgets receive no pointer events; use `/split-height`, `/split-tools-width`, `/split-files` |
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
omp --no-extensions -e ./split-view.ts --mode rpc < /dev/null  # must print no "Failed to load extension"
```

`bun run ship` is this loop end to end: it runs the gates, rewrites the
measured numbers in this README and `CODE_QUALITY.md`, commits every tracked
change with the snapshot in the message, then repacks and compares the
tarball with `HEAD` (host-loading the packed entry when `omp` is on `PATH`,
and skipping that step when the host itself refuses the pinned Bun).
The prose — feature claims, code comments, the snapshot's "after …" batch
list — is not generated; the script only owns values a command produced.

```sh
bun run ship --check   # gates + doc-drift check, no writes (CI-safe)
bun run ship --dry-run # print the doc refresh, commit/pack nothing
bun run ship -m "..."  # gates → refresh → commit → repack → verify
```

`--no-commit` refreshes and repacks without a commit (the tarball is then
checked against the working tree), `--no-pack` stops after the commit,
`--allow-untracked` admits new files to the commit, and `--skip-bun-check`
bypasses the 1.4.3 pin. A dirty tree is expected: the commit is the step that
captures it, so `ship` is meant to be the last command of a change, not a
pre-commit hook.

The last line is the host-load check: `bun test` resolves `@oh-my-pi/*`
imports the way Bun does, but omp's extension loader only answers those
specifiers for the extension's own files. An import that reaches a host module
which in turn imports a bare `@oh-my-pi/pi-*` from inside `node_modules` loads
in tests and fails in omp (`Cannot find package '@oh-my-pi/pi-tui' imported
from …/pi-coding-agent/src/…`), so run it after touching the import list. It
needs a local `omp`; CI cannot run it.

`bun run demo` (`scripts/demo.ts`) drives the extension with a fake host and
prints the exact rows omp would receive from `render(width)`: the three-column
layout with a live edit diff, a custom tool's diff reaching the files pane, a
files-only layout on a too-narrow terminal, directory grouping/badges/
truncation, both geometry presets rendered on the same pane, the auto preset
the aspect ratio picks (band rows and panel order), and the retained-state
bounds. The band is editor chrome inside
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
`bun publish --access public` with the `NPM_TOKEN` repository secret.

Everything up to the tag is automated:

```sh
bun run release current               # tag today's 0.1.0 (first publish)
bun run release patch                 # 0.1.0 → 0.1.1, commit + local tag
bun run release minor --push          # also push branch + tag → the workflow
bun run release 0.2.0 --dry-run       # print the plan, change nothing
```

`release` verifies the target version is free in the npm registry, bumps
`package.json`, runs `ship` (all gates, doc refresh, commit, pack verification),
then creates the annotated `v<version>` tag. `--push` pushes the current branch
and the tag, which starts this workflow; `--skip-registry-check` is for an
offline or private registry. A failed `ship` restores the version field and
leaves no tag. The `NPM_TOKEN` secret and its publish rights cannot be checked
locally, and `bun publish --dry-run` still stops at `missing authentication`
after packing, so the workflow is the first real publish.

Release prerequisites, in order: add the remote, push `main`, add the
`NPM_TOKEN` secret to the repository, then push the tag. The registry has no
`@marcinpohl/omp-split-view` version yet (checked 2026-11-01), so `v0.1.0` is
the initial publish and the npm install line in [Install](#install) only starts
working once that tag's workflow has completed.

The packed file set is installable as published — verified for this tree. The
tarball is not tracked: pack from a clean tree after the last commit, or the
artifact ships a README/manifest that no longer matches HEAD (copying the
extracted files back over the tree is what catches it):

```sh
bun pm pack                              # runs check:package (scripts.prepack),
                                         # then packs 6 files: package.json,
                                         # LICENSE, README, 3 modules
mkdir -p /tmp/omp-pkg && tar -xzf *.tgz -C /tmp/omp-pkg
omp plugin install /tmp/omp-pkg/package  # a .tgz path is read as a directory (ENOTDIR)
omp plugin list && omp plugin doctor     # lists @marcinpohl/omp-split-view, v0.1.0, status ok
```

On a development tree the plugin is usually installed as a symlink to the repo
(`~/.omp/plugins/node_modules/@marcinpohl/omp-split-view -> ~/omp-split-view`),
which already tracks live edits; `omp plugin install` would replace that link
with a copy and decouple the two. Skip the install step there and verify the
artifact by loading the extracted entry instead — it has no `node_modules`,
so any host import the package graph cannot resolve shows up immediately:

```sh
omp --no-extensions -e /tmp/omp-pkg/package/split-view.ts --mode rpc < /dev/null
```

The packed entry itself was loaded against the host API surface as well: importing
`./split-view.ts` from the extracted package registers 11 event handlers and 11
slash commands and re-exports the four state seams. `check-package` (and therefore
`bun pm pack`) fails if any module reachable from `omp.extensions` is missing from
`files`, or if a bare import is not declared as a dependency or peer.

`omp plugin install` links a local directory and a published install copies
files into `~/.omp/plugins/node_modules`, so the extracted tarball is the
closest local stand-in for what npm serves. Discovery loads the packaged entry
point from either: appending a throwaway `throw` to the installed
`split-view.ts` surfaces as `Failed to load extension
~/.omp/plugins/node_modules/@marcinpohl/omp-split-view/split-view.ts`, and the
unmodified file loads silently.

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
totals. Current: 99.94% lines / 97.95% functions — the only uncovered line is
the `themeGetter` default that throws before `session_start` binds a theme, and
of 196 counted functions four are missed: that same throwing default,
`BandHub.dispose`, and the two no-op default exports that exist so omp's
extension auto-discovery does not report a load error.

### Linting and complexity metrics

Python's pylint/radon have no maintained TypeScript port; the equivalents here
are ESLint plugins and rules:

| Python | Here | Command |
| --- | --- | --- |
| pylint | ESLint 10 flat config: `@eslint/js` + `typescript-eslint` + `eslint-plugin-sonarjs` (bug patterns, unused code, suspicious logic) | `bun run lint` (`bun run lint:fix` to autofix) |
| `radon cc` | `complexity` (cyclomatic) and `sonarjs/cognitive-complexity` per function | `bun run lint` |
| `radon raw` / size | `max-lines-per-function`, `max-depth`, `max-params` | `bun run lint` |
| `radon mi` / Halstead | no maintained TS implementation; treated as out of scope | — |

The baseline is 0 errors and 0 warnings: C1 extracted
`pendingVisibilityPolicy` from `syncTranscriptVisibility` and the field
readers from `normalizeConfig`, taking both under the cyclomatic limit. The
Q1–Q7 structural batch cleared the previous hotspots
(`filesPanelLines`, `toolLines`, `reconstruct`, `renderBand`, `pathsFrom`,
`splitView`, and the `newestRows`/`renderPanel` parameter counts). Tests are
exempt from the size/complexity rules. Tests assert behaviour, not lint
cleanliness.

Tests drive the extension through its registered handlers, commands, and the
widget the host mounts once (the harness caches the factory result, like omp,
so mount-only derivations are not re-run on every render), asserting panel
content and exact row widths. The
config path is redirected to a temp directory by `test/setup.ts` (bun
preload), so tests never touch the real agent directory.

## License

MIT. Portions derived from `pi-split-view` by Hugo-W (MIT).
