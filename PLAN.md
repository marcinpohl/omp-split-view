# PLAN — omp-split-view follow-ups

Source of this list: analysis of 2026-11-01 against omp `@oh-my-pi/*` 18.14.2
(lock-pinned). Every claim below was verified by running the suite, the type
checker, and throwaway probe scripts; none are inferred.

`CODE_QUALITY.md` owns the measured snapshot (tests/coverage/lint) and the
ranked queue; this file owns the behaviour descriptions and acceptance text.
Status below is reconciled against `CODE_QUALITY.md` as of the Q1–Q7/B7
structural batch (the commit that added `.github/workflows/ci.yml`).

## Verified baseline (re-check after any change)

The metric snapshot and the ranked work queue live in `CODE_QUALITY.md`; keep
its numbers in sync with these commands.

| Command | Expected |
| --- | --- |
| `bun test` | 93 pass, 0 fail, 32410 expect() calls |
| `bun run test:coverage` | gate passes: lines ≥ 99%, functions ≥ 90% (currently 99.92% / 97.01%) |
| `bun run lint` | 0 errors, 2 warnings (the parked Q8 pair) |
| `bun run typecheck` | clean (`tsc --noEmit`, strict) |
| geometry sweep (probe below) | 0 failures (40–300 cols × 6–40 rows), rows == height, every row exactly `width` cells, no control chars |

Files: `split-view.ts` 1514 L, `helpers.ts` 244 L, `ui-panels-config.ts` 146 L,
`test/split-view.test.ts` 1378 L, `test/properties.test.ts` 318 L,
`test/helpers.test.ts` 207 L, `test/setup.ts` 7 L, `scripts/check-coverage.ts`
90 L, `.github/workflows/ci.yml` 17 L, `CODE_QUALITY.md`, `eslint.config.js`.
Git repository with CI (W7/B7 done); no remote, so the workflow is inert until
one is added.
`fast-check` 4.x is the dev dependency behind the property tests.
`eslint`/`typescript-eslint`/`sonarjs` back `bun run lint`; coverage comes from
Bun's built-in instrumentation plus the lcov gate in `scripts/check-coverage.ts`
(Bun 1.4 does not enforce `coverageThreshold` from `bunfig.toml`).

Fixed during the 2026-11-01 passes (not planned, found by testing):

- Files list reserved both footer rows unconditionally, so band heights 10–13
  rendered a single tracked file as `… +1 more` with no filename
  (`filesPanelLines`). The "… more" row is now budgeted only when the list is
  really truncated and `listRows` floors at 3 with the diff panel.
  Regression: "a compact band still renders the tracked file".
- `renderPanel` padded but did not clip body rows and the title, so terminals
  below ~80 columns overran their width (60 cols → 61-cell rows). Both are now
  clipped with `truncateToWidth`. Property: "every terminal width and band
  height renders exact geometry" (40–300 cols).
- The wrapped-row memo was keyed by text only, so a live theme switch kept
  stale SGR codes even after the band cache invalidated. `renderBand` now
  clears `bandMemo` when the theme fingerprint changes.
- Model/tool text reached rows raw: a thinking delta or tool result containing
  CSI/OSC sequences could drive the terminal. `sanitizeText` strips escape
  sequences and C0/C1 controls at every ingestion point (thinking, tool name,
  args, output, diff, image MIME, displayed paths). Properties: "model and
  tool text can never reach a row as terminal escapes", plus the sanitizeText
  unit properties.

## Decision before W1 (resolved)

Fresh-install behaviour stays **bare** (`normalizeConfig({})` → `split:false`).

**Option A taken**: the machine default stays off and the README Install
section now says "First run is bare; `/split` turns the band on and
`/split-save` makes it the default". Option B (default `split:true`) was
rejected because it would make `--no-split` the only bare start and contradict
the documented flag semantics.

## Work items

Execution order comes from the `CODE_QUALITY.md` queue (Q1–Q8 structural,
B1–B7 behaviour); the items below are the behaviour/architecture definitions in
that order's terms. After every item run `bun test`, `bun run test:coverage`,
`bun run lint` and `bun run typecheck`, then update both documents.

| PLAN item | Status | CODE_QUALITY row |
| --- | --- | --- |
| W1 theme cache misses `text` | done | — |
| W2 zero-line thinking blocks | done | B5 |
| W3 `capToolText` tiny caps | done | — |
| W4 files-only blank < 90 cols | done | B1 |
| W5 diff follows tool name | done | B2 |
| W6 `reconstruct` bash replay | open (Q3 landed; policy not folded) | Q3 |
| W7 repository hygiene | done | B7 |
| T1 `/split-trim-response` | done | B4 |
| T2 theme invalidation | done | — |
| T3 empty thinking blocks | done (with W2) | B5 |
| T4 `/split` + `/split-save` round-trip | done | — |
| T5 resume/reconstruct | done | — |
| T6 command argument handling | done | — |
| T7 tool panel extras | done | B6 |
| W8 large-terminal geometry | done | — |

### W1 — Theme cache misses `text` (low, one line)

**Done** — `text` added to `themeFingerprint`, and the wrapped-row memo is now
cleared whenever the fingerprint changes (proved by the theme property test).

- Where: `themeFingerprint`, `split-view.ts:642`.
- Problem: the files list styles filenames with `theme.fg("text", …)`
  (`split-view.ts:779`, `:782`) but `"text"` is absent from the fingerprint.
  Probe result: changing only `fg("text")` produced byte-identical output;
  changing `fg("border")` refreshed correctly.
- Change: add `theme.fg("text", "x")` to the joined fingerprint list.
- Acceptance: a test with a mutable theme (see T2) shows the text-colour change
  reaching the rendered rows.
- Note: `"text"` is a valid `ThemeColor` (`node_modules/@oh-my-pi/pi-tui/src/theme/schema.ts:129`).

### W2 — Zero-line thinking blocks accumulate (low) — **done (B5)**

**Done** — `thinking.end` pushes only when `lines.length || tail`. The leak is
proved directly rather than indirectly: `split-view.ts` exports
`retainedThinkingBlocks()`, and the test emits 500 empty start/end pairs (count
unchanged), then one real thought (count +1, text rendered). Verified
load-bearing: reverting the guard fails the test with `Expected 0, Received
500`.

- Where: `thinking.end` (`split-view.ts:198`), `thinking.trim` (`split-view.ts:211`).
- Problem: `end()` pushes `this.current` unconditionally; `trim()` counts only
  `lines.length`, so a `thinking_start`/`thinking_end` pair with no content adds
  a forever-retained empty block.
- Change: push only when `lines.length || tail` (mirroring `start()`).
- Acceptance: T3 counts blocks indirectly — e.g. emit 500 empty start/end pairs,
  then assert `thinkingLines()` separators do not grow the visible output and
  that a subsequent real thought renders on the first body row.
  (`thinking` is module-private; if that is too indirect, export a test-only
  block count or assert via rendered output only and state the limit.)

### W3 — `capToolText` overruns tiny caps (low, unreachable today)

**Done** — `cap <= marker.length` now returns the newest whole code points with
no marker; `newestUnits` is shared with the normal path. Proved by the
capToolText length property (1–400 char caps).

- Where: `helpers.ts:33-58`, marker built at `:35`.
- Problem: when `cap <= marker.length`, `budget` goes negative, the loop never
  runs, and the function returns the marker alone — longer than `cap`.
- Change: when `cap <= marker.length`, return the newest `cap` units with no
  marker (same code-point-aligned walk, empty marker); otherwise keep today's
  behaviour. Do not return the marker alone — it exceeds the cap by design.
- Acceptance: unit test `capToolText("x".repeat(200), 8).length <= 8`.

### W4 — Files-only layout is silently blank below 90 columns (low) — **done (B1)**

**Done** — the empty-ids branch of `renderBand` keeps the frame for a
files-only layout and renders `Files panel needs ≥90 cols` in place of the list
(`filesPanelLines` gained an optional `notice`). The test sweeps 40/60/89 cols:
exactly `bandHeight` rows, every row exactly `width` cells, hint plus
`📂 Files` title present.

- Where: `renderBand`, `split-view.ts:656-683` (`filesWidthCols` gate).
- Problem: with only the files panel on, widths 80 and 89 render 0 rows and no
  hint. `/files` warns on toggle, but a saved layout on a narrow terminal just
  shows nothing.
- Change: when `filesOn` is the only enabled panel and `width < MIN_TERM_WIDTH`,
  render a framed panel with a hint row such as `Files panel needs ≥90 cols`
  instead of returning `[]`. Keep the height contract (`bandHeight` rows) and
  exact width.
- Acceptance: geometry sweep includes files-only at 80/89 → `rows.length ===
  height`, every row exactly `width`, output contains the hint.

### W5 — Diff subpanel only follows `toolName === "edit"` (low) — **done (B2)**

**Done** — the handler now keys off `details.diff` plus a resolvable path
(`input.path` → `details.path`). Behaviour change to note: a result with a diff
but no resolvable path returns early instead of reusing the previous diff path.
The test covers all three branches with `toolName: "patch"` and is load-bearing
(restoring the `toolName` gate fails it).

- Where: `tool_result` handler, `split-view.ts:1092`.
- Problem: custom tools that emit `details.diff` show the diff inside the tool
  row (`ingestToolResult` already stores `entry.diff`) but never update the
  files-pane diff.
- Change: accept any tool result with a non-empty string `details.diff` and a
  resolvable path (`event.input.path` → `details.path`), keyed off the payload
  rather than the tool name.
- Acceptance: T4-style event with `toolName: "patch"` updates the files pane.

### W8 — Geometry clamped at laptop sizes (med) — **done**

**Done** — three fixed caps made 4K/ultrawide terminals waste most of their
space: the files dock topped out at 48 cols, the band at 40 rows, and each
tool preview at 2 output lines. Now the dock is 25% of the width (34–120), the
band defaults to 45% of the terminal height when no height is saved (20–80,
so a 45-row screen keeps the classic 20) and may be set up to
`maxBandHeight(rows)`, which always leaves 18 rows for the transcript and
editor, and the tool preview depth follows the band (2–6 lines). Helpers
(`defaultBandHeight`, `maxBandHeight`, `dockColsFor`) are unit- and
property-tested, the composed band is asserted at 400×100 (45 rows, columns
at 0/195/300), `/split-height` clamping is a property, and an explicitly saved
height is proven to survive the terminal-derived default. `bun run demo`
section 5 prints the resulting table for 120×45, 200×60, 400×100 and 500×60.

- Where: `helpers.ts` (`dockColsFor`, `defaultBandHeight`, `maxBandHeight`),
  `split-view.ts` (`bandHeightAuto` at first mount, `/split-height` clamp,
  `previewLinesFor`), `ui-panels-config.ts` (height clamp 6–80).
- Acceptance: no fixed geometric cap below the terminal size; a chosen height
  is never overridden; a request that would hide the band is clamped instead.

### W6 — `reconstruct` replays every bash token through `fs` (low-med) — **open (Q3 landed without folding it)**

- Where: `replayToolResult`/`record` → `pathsFrom` → `bashPathHits`
  (`split-view.ts`).
- Problem: resume replays all branch bash commands and calls
  `existsSync`+`statSync` per token, re-deriving "seen" files from the current
  filesystem; cost grows with branch length and deleted/moved files disappear.
- Note: Q3 split `reconstruct` into `replayAssistant`/`replayToolResult` and
  left this policy alone on purpose (the structural batch was not allowed to
  change behaviour), so the decision is still open and now lives in one
  function (`replayToolResult` → `record`).
- Change options (pick one, note the choice):
  - (a) no replay for bash: only live `tool_call` events populate "seen";
  - (b) cap replay to the last N bash calls in the branch;
  - (c) replay but skip `stat` (accept tokens with a path separator only).
- Acceptance: a `session_start` test with 3 branch bash calls asserts the files
  list is deterministic and no `stat` runs for tokens that cannot be paths
  (assert via resulting list, not by spying on `fs`).

### W7 — Repository hygiene — **done (B7)**

**Done** — `git init` + first commit landed 2026-11-01 (15 files;
`node_modules/` ignored) and the README notes the ~1 GB install. B7 added
`.github/workflows/ci.yml`: one `gates` job on Bun 1.4.3 running `bun install
--frozen-lockfile`, `bun run typecheck`, `bun test`, `bun run test:coverage` and
`bun run lint`.

- Where: `.github/workflows/ci.yml`; install note in `README.md`.
- Note: the repo still has no remote, so the workflow is inert until one is
  added; the same sequence was run locally in order.
- Acceptance: met locally on the current snapshot — 93 pass / 0 fail, coverage
  gate exit 0, `0 errors, 2 warnings`, typecheck clean.

## Test gaps (open items in CODE_QUALITY queue order)

Harness notes: `test/split-view.test.ts` is one shared `h` harness because the
extension keeps module-level state. `flatTheme` ignores colours, so colour
assertions use the harness `setTheme` hook. `test/setup.ts` redirects
`PI_CODING_AGENT_DIR` to a temp dir before module import, and
`scripts/check-coverage.ts` excludes `test/**` from the coverage gate.

- [x] **T1 — `/split-trim-response` (highest value).** Done, two tests. A new
  harness seam `setSettings` swaps `api.pi.settings` (the file already passes
  the real `settings` singleton and `Settings.init()` runs in `beforeAll`).
  `/split-trim-response argument forms toggle and report`: `off` → `false`,
  `ON` → both handles `true`, a second `ON` stays on (explicit args are
  absolute, not toggles), `banana` toggles, and the `Panel C:` notify fires.
  The lowercase parse and the idempotent explicit arg are both load-bearing
  (dropping `.toLowerCase()` fails the test). `unsupported settings warn and
  do not apply an override` swaps in a `Proxy` whose every read throws, so the
  existing `catch` sets `visibilityUnsupported`: `warning` notify, no override
  applied, and the test must stay last in the file because that flag is
  process-global. Missing-ID detection is not simulated — both handles exist,
  so a throwing settings object is the only reachable route into that branch.
- [x] **T2 — Theme invalidation.** Done: "every theme colour the band uses
  invalidates the row cache" uses a mutable theme; covers W1 and exposed the
  `bandMemo` staleness fixed in `renderBand`.
- [x] **T3 — Empty thinking blocks.** Done with W2: direct block count via
  `retainedThinkingBlocks()` (the "too indirect" fallback was not needed).
- [x] **T4 — `/split` toggle pair + `/split-save` round-trip.** Done: config
  load tolerates garbage, `/split-save` persists the live layout and reports a
  write failure, the toggle pair was verified live, and "session_start applies
  the layout saved on disk" reads it back — every field in the written config
  differs from the live layout (tools off, diff off, `toolMode: "full"`,
  `trimResponse: true`, 24 rows, 45% tools, 60-col dock), then asserts the
  applied band height, dock width, panel set, transcript switches and full-mode
  output. A shared harness suffices because `session_start` re-reads the file;
  the missing piece was a config the live state could not already satisfy.
- [x] **T5 — Resume/reconstruct.** Done: "session_start, session_tree and
  session_switch replay the branch once" asserts the thinking text, the `read`
  tool row and the `replay.ts` files entry, with no duplicate rows after either
  branch event.
- [x] **T6 — Command argument handling.** Done: `/split-height` clamping and
  its usage message (geometry property), `/split-tools-width` empty and
  non-numeric rejections (the split must not move), its 20–60 clamp asserted
  through the composed columns (`[0,66,86]` at 20% and `[0,34,86]` at 60%),
  `/split-height` rejecting a non-numeric argument, `/files` warning on a
  terminal too narrow to dock it, and both `/split-tools-view` states (the
  full-mode assertions in `complex renderers` and the saved-mode read-back).
- [x] **T7 — Tool panel extras.** Done in the `complex renderers` suite: an
  image result renders the one-line fallback and not the base64 payload, a
  finished call shows its elapsed time while a call that just started shows
  none before the one-second gate (the ≥1s live counter stays covered by the
  ticker test), and `MAX_TOOLS` eviction keeps the newest 60 — the cap was not
  row-observable (the band renders only the newest rows), so it is asserted
  through the `retainedToolEntries()` seam. Mutations: removing the eviction
  block leaves 65 entries; `pop()` instead of `shift()` drops the newest call.

Keep every new test deterministic and isolated; do not re-pin incidental text
(legend strings, emoji order) unless it is a stated contract.

## Throwaway probe recipes

Run probes from the repository root (module resolution for `@oh-my-pi/*` fails
from `/tmp`), then delete the file — they are not part of the deliverable.

Geometry sweep skeleton (`probe.tmp.ts`): import `splitView` from
`./split-view.ts` and `visibleWidth` from `@oh-my-pi/pi-tui`; build the same
fake `api`/`ctx`/`tui` as the test harness (flat theme must include `inverse`,
`renderDiff` needs it); drive `session_start`, `/split`, `/files`, one
`tool_call`, one `tool_result` diff, one thinking stream; then loop widths
`40..300` (the tested range; the old probe started at 80) × heights `6..40`, calling
`/split-height` and asserting `lines.length === height` and
`visibleWidth(line) === width` for every row. Use `terminal.rows = 60` so rows
30–40 are not hidden by `MIN_ROWS_BELOW_BAND`.

Settings probe: call `Settings.init({ cwd, agentDir, inMemory: true })` before
`lookup(id)`, otherwise `settings` throws "Settings not initialized".

## Out of scope

- Mouse drag-resize and header buttons (host widgets receive no pointer events).
- Subagent tool calls in the tool panel (no host event channel).
- Answer divider, panel zoom (no layout root in omp).
- Changing the config file from a "startup template" to live state.
