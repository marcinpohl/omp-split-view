# PLAN — omp-split-view follow-ups

Source of this list: analysis of 2026-11-01 against omp `@oh-my-pi/*` 18.14.2
(lock-pinned). Every claim below was verified by running the suite, the type
checker, and throwaway probe scripts; none are inferred.

`CODE_QUALITY.md` owns the measured snapshot (tests/coverage/lint) and the
ranked queue; this file owns the behaviour descriptions and acceptance text.
Status below is reconciled against `CODE_QUALITY.md` as of commit `bc86769`.

## Verified baseline (re-check after any change)

The metric snapshot and the ranked work queue live in `CODE_QUALITY.md`; keep
its numbers in sync with these commands.

| Command | Expected |
| --- | --- |
| `bun test` | 62 pass, 0 fail, 29607 expect() calls |
| `bun run test:coverage` | gate passes: lines ≥ 99%, functions ≥ 90% (currently 99.91% / 96.36%) |
| `bun run lint` | 0 errors, 15 warnings (the cyclomatic/cognitive report) |
| `bun run typecheck` | clean (`tsc --noEmit`, strict) |
| geometry sweep (probe below) | 0 failures (40–300 cols × 6–40 rows), rows == height, every row exactly `width` cells, no control chars |

Files: `split-view.ts` 1337 L, `helpers.ts` 212 L, `ui-panels-config.ts` 144 L,
`test/split-view.test.ts` 727 L, `test/properties.test.ts` 310 L,
`test/helpers.test.ts` 172 L, `test/setup.ts` 7 L, `scripts/check-coverage.ts`
90 L, `CODE_QUALITY.md`, `eslint.config.js`. Git repository; no CI yet
(W7/B7).
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
| W2 zero-line thinking blocks | open | B5 |
| W3 `capToolText` tiny caps | done | — |
| W4 files-only blank < 90 cols | open | B1 |
| W5 diff follows tool name | open | B2 |
| W6 `reconstruct` bash replay | open (fold into Q3) | Q3 |
| W7 repository hygiene | partial (CI open) | B7 |
| T1 `/split-trim-response` | open | B4 |
| T2 theme invalidation | done | — |
| T3 empty thinking blocks | open (with W2) | B5 |
| T4 `/split` + `/split-save` round-trip | partial | — |
| T5 resume/reconstruct | done | — |
| T6 command argument handling | partial | — |
| T7 tool panel extras | open | B6 |

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

### W2 — Zero-line thinking blocks accumulate (low) — **open (B5)**

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

### W4 — Files-only layout is silently blank below 90 columns (low) — **open (B1)**

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

### W5 — Diff subpanel only follows `toolName === "edit"` (low) — **open (B2)**

- Where: `tool_result` handler, `split-view.ts:1092`.
- Problem: custom tools that emit `details.diff` show the diff inside the tool
  row (`ingestToolResult` already stores `entry.diff`) but never update the
  files-pane diff.
- Change: accept any tool result with a non-empty string `details.diff` and a
  resolvable path (`event.input.path` → `details.path`), keyed off the payload
  rather than the tool name.
- Acceptance: T4-style event with `toolName: "patch"` updates the files pane.

### W6 — `reconstruct` replays every bash token through `fs` (low-med) — **open, do it with Q3**

- Where: `reconstruct` (`split-view.ts:888`), `pathsFrom` bash branch.
- Problem: resume replays all branch bash commands and calls
  `existsSync`+`statSync` per token, re-deriving "seen" files from the current
  filesystem; cost grows with branch length and deleted/moved files disappear.
- Change options (pick one, note the choice):
  - (a) no replay for bash: only live `tool_call` events populate "seen";
  - (b) cap replay to the last N bash calls in the branch;
  - (c) replay but skip `stat` (accept tokens with a path separator only).
- Acceptance: a `session_start` test with 3 branch bash calls asserts the files
  list is deterministic and no `stat` runs for tokens that cannot be paths
  (assert via resulting list, not by spying on `fs`).

### W7 — Repository hygiene — **partial (B7)**

**Partly done** — `git init` + first commit landed 2026-11-01 (15 files;
`node_modules/` ignored) and the README now notes the ~1 GB install. CI is not
set up yet.

- `git init`, first commit of the current tree (respect the existing
  `.gitignore`, which already ignores `node_modules/`).
- Add CI (single job): `bun install`, `bun test`, `bun run typecheck`.
- Note in README that `bun install` pulls the whole omp runtime through
  auto-installed peers (~1.0 GB `node_modules`), so the cache is expected.
- Acceptance: CI green on the same 25/0 baseline.

## Test gaps (open items in CODE_QUALITY queue order)

Harness notes: `test/split-view.test.ts` is one shared `h` harness because the
extension keeps module-level state. `flatTheme` ignores colours, so colour
assertions use the harness `setTheme` hook. `test/setup.ts` redirects
`PI_CODING_AGENT_DIR` to a temp dir before module import, and
`scripts/check-coverage.ts` excludes `test/**` from the coverage gate.

- [ ] **T1 — `/split-trim-response` (highest value).** No suite test; the only
  feature that depends on host setting IDs. Gate on `lookup("hideThinkingBlock")`
  and `lookup("display.hideToolActivity")` being defined; call
  `await Settings.init({ agentDir: process.env.PI_CODING_AGENT_DIR, inMemory: true })`
  from `@oh-my-pi/pi-coding-agent`, pass the real `settings` singleton as
  `api.pi.settings`, then assert: on → both handles read `true`; off → `false`;
  `off`/`on` arg forms; unknown switch (handles absent) → warning notify, no
  throw, `trimResponse` unchanged. Verified manually already: on→`true,true`,
  off→`false,false`, message "Panel C: response only/full transcript".
- [x] **T2 — Theme invalidation.** Done: "every theme colour the band uses
  invalidates the row cache" uses a mutable theme; covers W1 and exposed the
  `bandMemo` staleness fixed in `renderBand`.
- [ ] **T3 — Empty thinking blocks.** Covers W2; see acceptance there.
- [ ] **T4 — `/split` toggle pair + `/split-save` round-trip (partial).** Done:
  config load tolerates garbage, `/split-save` persists the live layout and
  reports a write failure, and the toggle pair was verified live. Missing: a
  fresh `session_start` in a new harness reading the saved layout back.
- [x] **T5 — Resume/reconstruct.** Done: "session_start, session_tree and
  session_switch replay the branch once" asserts the thinking text, the `read`
  tool row and the `replay.ts` files entry, with no duplicate rows after either
  branch event.
- [ ] **T6 — Command argument handling (partial).** Done: `/split-height`
  clamping and its usage message (via the geometry property), plus
  `/split-tools-width` and `/split-tools-view` in the layout/save tests.
  Missing: empty/non-numeric `/split-tools-width` errors and both explicit
  `/split-tools-view` states.
- [ ] **T7 — Tool panel extras.** Image result renders the one-line fallback and
  not the base64 payload; duration formatting appears for ended calls and not
  for reconstructed ones; `MAX_TOOLS` eviction keeps the newest 60.

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
