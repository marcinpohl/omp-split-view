# PLAN — omp-split-view follow-ups

Source of this list: analysis of 2026-11-01 against omp `@oh-my-pi/*` 18.14.2
(lock-pinned). Every claim below was verified by running the suite, the type
checker, and throwaway probe scripts; none are inferred.

`CODE_QUALITY.md` owns the measured snapshot (tests/coverage/lint) and the
ranked queue; this file owns the behaviour descriptions and acceptance text.
Status below is reconciled against `CODE_QUALITY.md` as of the tool-preview
window (R3); before it: R2 mount-once harness/auto height, R1 visibility
mutation coverage, W6 bash replay, C1 code simplification, T1 test-suite
simplification, A1 advisor compatibility, G1 geometry presets, Q1–Q7
structural, B7 CI.

## Verified baseline (re-check after any change)

The metric snapshot and the ranked work queue live in `CODE_QUALITY.md`; keep
its numbers in sync with these commands.

| Command | Expected |
| --- | --- |
| `bun test` | 129 pass, 0 fail, 45752 expect() calls |
| `bun run test:coverage` | gate passes: lines ≥ 99%, functions ≥ 90% (currently 99.93% / 97.55%) |
| `bun run lint` | 0 errors, 0 warnings |
| `bun run typecheck` | clean (`tsc --noEmit`, strict) |
| `bun run check:package` | `check-package: ok — 3 shipped modules (@marcinpohl/omp-split-view@0.1.0)` |
| geometry sweep (probe below) | 0 failures (40–300 cols × 6–40 rows), rows == height, every row exactly `width` cells, no control chars |
| geometry preset properties | 0 failures (90–420 cols × 24–140 rows × saved/auto preset; both curves at 0–2000 rows/cols against literal shares) |
| `bun run demo` | prints frames; section 5 shows 120×45 `4k` 20 │ 56│30│34, 400×100 `4k` 45 │ 195│105│100, 500×60 `wide` 21 │ 221│119│160 |

Files: `split-view.ts` 1854 L, `helpers.ts` 312 L, `ui-panels-config.ts` 176 L,
`test/split-view.test.ts` 2351 L, `test/properties.test.ts` 458 L,
`test/helpers.test.ts` 202 L, `test/setup.ts` 7 L, `scripts/check-coverage.ts`
90 L, `scripts/check-package.ts` 169 L, `.github/workflows/ci.yml` 18 L,
`.github/workflows/publish.yml` 39 L, `CODE_QUALITY.md`, `eslint.config.js`.
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
  args, output, image MIME, displayed paths) and now on branch replay too;
  tool diffs reach the pane only through `renderDiff`, which sanitizes what it
  renders. Properties: "model and tool text can never reach a row as terminal
  escapes", plus the sanitizeText unit properties and the two row-level tests
  for replayed thinking and a hostile `details.diff`.
- **A saved geometry preset was never armed (G1).** The mount factory resolved
  `geometryMode` only for `auto`, while `session_start` reset it to `4k`, so a
  saved `wide`/`4k` was overwritten before it could size the band. The factory
  now resolves the mode unconditionally through `resolveGeometryMode()`.
  Regressions: "a saved preset overrides the aspect ratio in both directions",
  "the preset is saved and drives the next session's layout".
- **A session switch dropped an ultrawide pane to `4k` (G1).** Resolution
  lived only in the widget factory, which the host calls on first mount;
  switching sessions in one process left `geometryMode` at the reset value
  until the next mount. `resolveGeometryMode()` now also runs on session load.
  Regression: "a session switch keeps the auto preset without a remount"
  (asserted through the no-arg `/split-geometry` message, because rendering
  would re-enter the factory and mask it).

Fixed during the 2026-11-01 improvement pass (S1–S6 in `CODE_QUALITY.md`;
same-day probe numbers before → after):

- **Replay sanitization (S1).** Branch thinking is sanitized in
  `replayAssistant`, so a resumed session can no longer render OSC/CSI from
  stored text. Acceptance: the hostile block
  `safe\u001b]0;PWNED\u0007\u001b[31mred` reaches no row (no `PWNED`, no
  control char); reverting the `sanitizeText` call fails that test.
- **Bounded tool panel (S2).** `toolLines` builds newest-first and stops at the
  row budget instead of styling and diffing every entry. 60 tools × a 150-line
  diff at a 12-row band: 14.5 ms → 1.1 ms per invalidated render, unchanged
  rows (the built array is an exact suffix of the old one).
- **Bounded stored diff (S3).** `setEditDiff` keeps the first 400 lines /
  64 KiB with a `… +N more diff lines` / `… [truncated: …]` marker, exposed
  through `retainedEditDiff()`. A 20 000-line `details.diff` retains 401 lines
  and renders under 1 ms (24 ms in `renderDiff` alone before). The cap is
  applied without a `sanitizeText` pre-pass: `renderDiff` sanitizes, and
  pre-sanitizing collapsed tab indentation (3 cells) to one space.
- **Atomic config save (S4).** `saveUiPanelsConfig` creates the agent directory
  and writes `<config>.<pid>.tmp` → rename, so a fresh agent dir saves instead
  of failing and an interrupted write cannot leave truncated JSON (which used
  to load silently as defaults). Acceptance: save into a missing directory
  leaves only the config file; a directory at the config path returns `false`
  with no `.tmp` residue.
- **Image label instead of payload (S5).** `ToolEntry.imageLabel` stores the
  rendered `imageFallback` line, not the base64: the `1x1` dimension assertion
  proves the label is computed at ingest, and retained heap after an 8 MB
  image result is 0.06 MB (was 7.7 MB).
- **Text and bound fixes (S6).** `/split-height` help says 6–80 (matching the
  README), the `/split-trim-response` notify says `Transcript:` instead of the
  pre-port `Panel C:`, and the `normalizeConfig` property asserts
  `MIN_BAND_HEIGHT`/`MAX_BAND_HEIGHT` with explicit clamp cases at both ends.

Fixed during the advisor-compatibility pass (A1 in `CODE_QUALITY.md`):

- **Advisor/subagent tool activity (A1).** omp emits `tool_call`/`tool_result`
  for the advisor's wrapped builtins (`read`/`grep`/…, identity
  `ctx.agent.kind === "sub"`); the advisor's own `advise` tool is constructed
  unwrapped and emits nothing. The files/diff panes used to ingest every
  `tool_call`/`tool_result` regardless of identity, so a review's reads showed
  as primary work and then disappeared on resume (replay walks the primary
  branch only). `isMainAgent` gates `tool_call`, `tool_result` and the three
  `tool_execution_*` hooks; a missing identity is treated as main for older
  hosts. Acceptance: advisor-attributed events leave `Files (0)` and Last-Edit
  untouched while main-agent events still populate both.
- **Advisor tally status line (A1).** Advisor cards are `custom` messages
  (`customType: "advisor"`, `details.notes`) delivered live on both paths
  (turn-less recording emits `message_start`/`message_end`; steered batches
  pass through the same pair when the loop injects them). `message_end` counts
  severities since the last real user prompt and mirrors them through
  `ctx.ui.setStatus("split-view.advisor", "Advisor: 1 blocker · 2 concerns")`;
  `reconstruct` rebuilds the tally from `custom_message` branch entries. It is
  cleared on the next real prompt, when every panel is off, and at shutdown.
  A fourth band column was rejected: notes are prose in a fixed-height band and
  the transcript card already renders them at full width. Acceptance: live
  text and reset, agent-attributed synthetic user messages do not reset, branch
  rebuild after `session_tree`, and `/split` off clears while `/split` on
  restores. Properties (seed `20261101`): advisor-only tool streams leave the
  band byte-identical, the band equals the main-only subsequence of any
  interleaving, and the tally matches an independent model live and replayed.

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
| W6 `reconstruct` bash replay | done (policy a) | W6 |
| W7 repository hygiene | done | B7 |
| T1 `/split-trim-response` | done | B4 |
| T2 theme invalidation | done | — |
| T3 empty thinking blocks | done (with W2) | B5 |
| T4 `/split` + `/split-save` round-trip | done | — |
| T5 resume/reconstruct | done | — |
| T6 command argument handling | done | — |
| T7 tool panel extras | done | B6 |
| W8 large-terminal geometry | done | — |
| W9 geometry preset switch (`4k`/`wide`) | done | G1 |

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
editor, and the tool preview depth follows the band (2–6 lines). Those are now
the `4k` preset's numbers — W9 adds `wide` and the aspect-based choice on top.
Helpers (`defaultBandHeight`, `maxBandHeight`, `dockColsFor`) are unit- and
property-tested, the composed band is asserted at 400×100 (45 rows, columns
at 0/195/300), `/split-height` clamping is a property, and an explicitly saved
height is proven to survive the terminal-derived default. `bun run demo`
section 5 prints the resulting table for 120×45, 200×60, 400×100 and 500×60.

- Where: `helpers.ts` (`dockColsFor`, `defaultBandHeight`, `maxBandHeight`),
  `split-view.ts` (`bandHeightAuto` at first mount, `/split-height` clamp,
  `previewLinesFor`), `ui-panels-config.ts` (height clamp 6–80).
- Acceptance: no fixed geometric cap below the terminal size; a chosen height
  is never overridden; a request that would hide the band is clamped instead.

### W9 — One geometry curve for every terminal shape (med) — **done**

**Done** — W8's single auto curve is right for a 4K cell grid (~400×100) but
spends scarce rows and leaves columns unused on a 21:9/32:9 pane. Two presets
now exist: `4k` (45 % of rows, 25 % of columns — W8's curve, and still the
default the helpers return) and `wide` (35 % of rows, 32 % of columns, floors
20/14 rows, dock 40–200). `auto` picks by aspect ratio (≥ 8 columns per row =
ultrawide, which separates 21:9 ≈ 10.8 and 32:9 ≈ 12.5 from 16:9 ≈ 6 and 4K
≈ 4). `/split-geometry [auto|4k|wide]` pins it (no argument flips to the other
preset), `/split-save` persists it, and a manual `/split-height` or a saved
`filesWidth` still wins over the preset's curve.

- Acceptance, all asserted: `auto` → `wide` on 500×40 (14 rows,
  `[0, 221, 340]`) and `4k` on 400×100 (45 rows, unchanged); a saved preset
  overrides the ratio both ways (500×40 pinned `4k` → 20 rows,
  `[0, 247, 380]`); an unknown argument errors and moves nothing; a pinned
  height survives a preset switch (`30 rows (pinned)`, dock follows the
  preset); `/split-save` writes `geometry` and the next session applies it
  (400×100 + `wide`, no saved height → 35 rows, `[0, 177, 272]`).
- Property coverage (fast-check, seed `20261101`): documented curve vs literal
  shares at any size, bounds/monotonicity of both curves, the exact aspect
  boundary and its monotonicity, profile-invariant manual widths, the composed
  band (rows + column offsets) for arbitrary terminal sizes and saved/auto
  presets, pinned-height invariance with the message checked against the
  rendered offsets, `auto|4k|wide` as the only accepted arguments (anything
  else renders identically), `auto|4k|wide` round-tripping through
  `/split-save`, and a remount at a new shape dropping the band memo.

### W6 — `reconstruct` replays every bash token through `fs` (low-med) — **done (policy a)**

- Where: `replayToolResult`/`record` → `pathsFrom` → `bashPathHits`
  (`split-view.ts`).
- Problem: resume replays all branch bash commands and calls
  `existsSync`+`statSync` per token, re-deriving "seen" files from the current
  filesystem; cost grows with branch length and deleted/moved files disappear.
- Note: Q3 split `reconstruct` into `replayAssistant`/`replayToolResult` and
  left this policy alone on purpose (the structural batch was not allowed to
  change behaviour), so the decision lived in one function
  (`replayAssistant` → `record`).
- Choice taken: **(a) no replay for bash** — `replayAssistant` still rebuilds
  the tool row but skips `record()` for `bash`, so "seen" entries are live
  observation only. Rejected (b) as still filesystem-dependent and (c) as
  accepting non-files into the panel. Regression: "replay never re-derives
  bash-seen files from the filesystem" (three bash calls naming real files,
  one read → `Files (1)`; rebuild byte-identical; mutation-checked).
- Options considered:
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
  gate exit 0, `0 errors, 0 warnings`, typecheck clean.

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
  absolute, not toggles), `banana` toggles, and the `Transcript:` notify fires.
  The lowercase parse and the idempotent explicit arg are both load-bearing
  (dropping `.toLowerCase()` fails the test). `unsupported settings warn and
  do not apply an override` swaps in a `Proxy` whose every read throws, so the
  existing `catch` sets `visibilityUnsupported`: `warning` notify, no override
  applied. The flag latches for the session only — `session_start` clears it
  and retries, covered by "session_start retries transcript visibility after a
  settings failure" — so the test no longer has to stay last in the file.
  Missing-ID detection is not simulated — both handles exist,
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
