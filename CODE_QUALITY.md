# Code quality — measurements and work queue

Snapshot: 2026-11-02, after the Q1–Q7 structural batch, B7 CI, the split-view
improvement pass, the geometry preset switch (G1), advisor compatibility
(A1), test-suite simplification (T1), code simplification (C1), W6 bash
replay, the R1 review pass, R2 mount-once/auto-height fixes, the R3
tool-preview window, the R4 render-budget/saved-layout batch, the H1 band
hot-path batch, the wide files-first / live-thinking-head batch and the
advisor panel (all landed).
This file is the dispatcher: metrics live here, the ordered queue below is
what to work on next, and every landed item updates the snapshot and ticks
its row.

## Commands (what gates what)

| Command | Measures | Gate |
| --- | --- | --- |
| `bun test` | behaviour + property tests | 168 tests, 0 failures |
| `bun run test:coverage` | line/function coverage from Bun's lcov | lines ≥ 99%, functions ≥ 90% (`scripts/check-coverage.ts`) |
| `bun run lint` | ESLint 10 + typescript-eslint + sonarjs; also the cyclomatic/cognitive/size metrics | 0 errors, 0 warnings |
| `bun run typecheck` | `tsc --noEmit`, strict | clean |
| `bun run check:package` | the shipped tarball: `files` coverage and declared deps via the `omp.extensions` import graph (`scripts/check-package.ts`) | `ok` — 3 shipped modules |
| `bun run ship` | the five gates, then rewrites the measured numbers in README/CODE_QUALITY, commits, repacks and verifies the tarball against `HEAD` | exit 0 only when every step passed; `--check` runs the gates and fails on stale numbers without writing |
| `bun run release <current\|patch\|minor\|major\|x.y.z>` | registry check → version bump (or no bump) → `ship` → annotated `v<version>` tag; `--push` pushes the branch and tag | exit 0 only if every step passed; `--dry-run` changes nothing, and a failed `ship` restores the version and creates no tag |
| `omp --no-extensions -e ./split-view.ts --mode rpc < /dev/null` | the real host loader, which resolves `@oh-my-pi/*` differently from Bun (see the advisor-panel row on host-load) | no `Failed to load extension` line; needs a local `omp`, so CI cannot run it |
| geometry properties (`band properties`, `geometry preset properties`) | 40–300 cols × 6–40 rows with a pinned height, plus 90–420 cols × 24–140 rows for both presets: exact rows/cells, dock offset, no control chars | 0 failures |
| geometry properties (`geometry profiles`) | both curves at 0–2000 rows/cols against literal shares, aspect threshold at every row count | 0 failures |

Test files are excluded from the coverage totals and from the size/complexity
rules; `helpers.ts` is exempt from `no-control-regex` because the sanitizer
targets control characters.

## Snapshot

### Tests and coverage

| File | Lines | Funcs | Test file | Tests |
| --- | --- | --- | --- | --- |
| `split-view.ts` | 99.92% | 98.73% | `test/split-view.test.ts` | 106 |
| `helpers.ts` | 100.00% | 96.43% | `test/helpers.test.ts` | 27 |
| `ui-panels-config.ts` | 100.00% | 88.89% | `test/properties.test.ts` | 35 |
| **overall** | **99.94%** | **97.95%** | | **168** |

59,179 assertions, ~3.9 s wall time. Uncovered:

- `split-view.ts:141` — `themeGetter` default that throws if something renders
  before `session_start` binds a theme. Deliberate, unreachable.
- Functions: 191/195 counted (`FNF`/`FNH` in `coverage/lcov.info`, `test/**`
  excluded as the gate does). The four misses are the throwing `themeGetter`
  default, `BandHub.dispose` (no-op host hook), and the two no-op default
  exports that exist so omp's extension auto-discovery does not report a load
  error (`helpers.ts:444`, `ui-panels-config.ts:174`). Bun 1.4's lcov omits the
  per-function `FN`/`FNDA` records, so those identities come from reading the
  four sites; only the totals come from the report. Every helper extracted by
  Q1–Q7 plus the split-view batches (`capDiffText`, `imageLabel`,
  `retainedEditDiff`, `framedRow`, `resultTextTail`) and the advisor panel's
  probe/store/render helpers is reached by the existing suite.

Property coverage is behavioural, not line-based: helpers (truncation, caps,
config normalization, visibility), band geometry for arbitrary terminal sizes,
cache idempotence, theme invalidation, escape stripping, arbitrary event
streams, advisor/main interleavings, and tally replay. Fixed fast-check seeds
(`20261101`) keep failures reproducible.

H1 added properties for every piece it touched, so the invariants are checked
over input rather than pinned to the examples above: `framedRow` (row width is
`inner + 2` for any width/content, the middle is content plus fill, clipping
never overflows, the fill carries the border colour), `nonEmptyLines` (against a
loop oracle, then idempotence and control-free output), `resultText` (ordered
concatenation checked by scanning, non-text blocks contributing nothing) and
`resultTextTail` (newest window of `resultText`, code-point aligned, invariant
under any block split). On the band: a render that changes nothing builds
nothing, `invalidate()` then render equals the memoised rows for arbitrary state
sequences, one panel's change rebuilds exactly that panel for any
width/height, cumulative streaming renders the same live and settled rows as one
delivery of the same text, and every tracked basename reaches a files row.

`geometry profiles` and `geometry preset properties` cover the preset switch
end to end: both curves against literal shares and bounds at any size, the
aspect threshold and its monotonicity, profile-invariant manual widths, the
composed band (row count and column offsets) for arbitrary sizes with a saved
or aspect-resolved preset, pinned-height invariance with the notify text
checked against the rendered offsets, `auto|4k|wide` as the only accepted
arguments (anything else renders identically), the three literals round-tripping
through `/split-save`, and a remount at a new shape dropping the band memo.
Integration expectations deliberately reuse the module's own helpers for the
*composition* — the settled placement is what is under test — while the
documented shares and the aspect cutoff are asserted as literals, so a drifted
constant cannot pass.

`command arguments and saved layout` covers the reject/clamp paths that the
layout tests never exercised (empty and non-numeric arguments must not move the
split; `/split-tools-width` clamps 20–60, asserted through the composed column
offsets) and the disk → live direction of the config: one `session_start` with
a saved layout that differs on every field.

The `complex renderers` suite targets the five highest-`cc` functions branch by
branch: tool output preview tail and `+N earlier lines`, image fallback vs base64, a
tool-row diff block, compact entry separators, the sub-one-second timer gate,
directory grouping and its indented children, list truncation counts, the
`×N` badge and merged op letters, `~`/absolute path shortening, the empty and
truncated diff subpanel, bash flag/operator/quoted-token filtering, custom-tool
path-key dedupe, replay diff + pathless-diff fallback, and delta coalescing
(one flush render, not one per delta). Each assertion was mutation-checked:
breaking the branch it names fails that test (12/12 + the flush version bump).

Two fixture notes from that work: the event-stream property's per-run `ensure`
could toggle panels OFF when a generated height hid the band (labels
unrenderable, widget unmounted) — a post-assert restore now re-establishes the
mount point; and `flushThinking` had only ever been covered by a leftover timer
from an earlier test, so delta coalescing is now asserted directly.

The H1 batch added one assertion to that suite — a path with an embedded CSI is
sanitized in the files row — and put its two other renderer checks where they
belong: the panel-confinement and streamed-vs-once examples were folded into the
two `band memo properties`, which assert the same contracts over generated
widths, heights and panel kinds instead of one pinned layout. Property tests
have a single home (`test/properties.test.ts`); the example suites pin concrete
behaviour only.

### Lint and complexity (radon `cc` / `raw` equivalents)

0 warnings, 0 errors. Limits: cyclomatic 12, cognitive 15, depth 4, params 4,
function length 100 lines.

The parked Q8 pair is gone: C1 extracted `pendingVisibilityPolicy` from
`syncTranscriptVisibility` and the field/shape readers from
`normalizeConfig`, taking both under the cyclomatic limit without changing
their behaviour (same tests, demo and package gate). The structural batch
cleared the other thirteen warnings and
introduced none: two helpers needed one extra split each while landing
(`fileRows` → `fileEntryRow` + `fileRunRows`, `renderBand` → `panelLayout` +
`narrowFilesNotice`, then `splitView` → `registerEvents` + `registerCommands`
→ `registerPanelToggles`/`registerGeometryCommand`/`registerBandSettings`),
which is why the extraction count is higher than the Q rows name. The
advisor-panel pass hit the same two limits again and split both sites a second
time (`renderBand` → `bandFrames` + `composeBand` + `sameParts`, and the
`session_start` handler → `adoptSession`), which is how it lands back at
0 warnings.

Band/dock geometry now scales and switches: `GEOMETRY_PROFILES` +
`autoGeometryMode` in `helpers.ts` pick the `4k` curve (45%-height band,
25%-width dock, 20/80 rows, 34/120 cols) or the `wide` one (35%, 32%, 14/80
rows, 40/200 cols) from the aspect ratio, and `/split-geometry` pins either.
`defaultBandHeight`/`dockColsFor` keep `4k` as their default profile, so a
caller that does not pass one gets the pre-switch behavior.

`filesPanelLines` still takes 4 parameters: the Q1 split keeps the hint row as
`notice?` and passes the padded content width to the helpers instead of a
closure, so no fifth parameter (and no options object) was needed.

File sizes: `split-view.ts` 2138 L, `helpers.ts` 446 L,
`ui-panels-config.ts` 176 L, `scripts/check-coverage.ts` 90 L,
`scripts/check-package.ts` 169 L, tests 4348 L (`split-view` 3320,
`properties` 699, `helpers` 323, `setup` 7).

CI: `.github/workflows/ci.yml` runs the five gates plus `bun install
--frozen-lockfile` on Bun 1.4.3 for every push and pull request;
`.github/workflows/publish.yml` publishes `v*` tags through `bun publish`. The
repo has no remote yet, so both are inert until one is added; the CI steps were
run locally in order and all gate on the numbers above.

The Bun pin is load-bearing: 1.4.4 changed lcov line attribution and marks
executed multi-line statements as missed. Measured on the pre-G1 tree, the same
tests gave `split-view.ts` 983 counted lines / 933 hit on 1.4.4 versus
1034 / 1033 on 1.4.3, so the coverage gate fails there. Every number above is
a 1.4.3 measurement of the current tree.

## Work queue

Ordered. Priority is about risk and leverage, not effort. A row is done only
when its acceptance metric is met and the snapshot above is updated.

### P3 — small or deferred

| ID | Evidence | Work | Acceptance |
| --- | --- | --- | --- |
| Q8 | ~~`syncTranscriptVisibility` cc 15, `normalizeConfig` cc 16~~ — **done (C1)** | Extracted `pendingVisibilityPolicy` and the config field readers. | 0 warnings |
| W10 | Live `tool_result` applies any `details.diff` with a resolvable path (`split-view.ts:1641`); replay applies it only when `msg.toolName === "edit"` (`split-view.ts:1442`). Probe: the same branch entry renders the diff live and `No edit yet` after `session_start`, so README's custom-tool claim holds for live turns only. | Make replay apply the same payload-keyed rule as the live handler (or narrow the README claim to live turns). | A custom tool's `details.diff` is visible after branch replay; live and replay share one diff rule; README matches both paths. |
| W11 | `auto` geometry and auto height resolve only at mount and session start. Probe: mounted at 120×45 (20 band rows), a resize to 300×35 renders 0 rows — the 4k height no longer fits — while `autoGeometryMode(300,35)` is `wide` (14 rows, fits). | Re-resolve `auto` on a terminal-size change, or on render when the shape changes, without overriding a pinned height. | Resize probe: after shrinking to 300×35 the band renders the `wide` curve at 14 rows; a pinned `/split-height` is unchanged; gates green. |

W10 and W11 are open; W6 landed with policy (a) and Q8 closed with C1.

### Landed — wide files-first order, live thinking head

Delta: 155 → 159 tests (97 in `split-view.test.ts`, 27 in
`helpers.test.ts`, 35 in `properties.test.ts`: +2 thinking-head tests, +2
`withoutLiveThinking` examples), assertions 59,014 → 59,047, coverage 99.93%
lines / 97.73% functions (FNF 172 → 176, FNH 168 → 172: the same four
deliberate misses), lint 0/0, typecheck clean, package gate ok (3 modules).
`split-view.ts` 1853 → 1898 L, `helpers.ts` 411 → 446 L,
`test/split-view.test.ts` 2982 → 3071 L, `test/helpers.test.ts` 301 → 323 L.

- **`wide` puts the files panel first.** `panelLayout` orders
  files | thinking | tools when the preset is `wide` and the dock is wide
  enough; widths stay keyed by panel, so `allocateWidths` is unchanged. The
  README table and `demo` label columns in that order.
- **The live thinking head is suppressed with the panel.** `hideThinkingBlock`
  leaves the `omp.thinking.live` section visible; `installThinkingHeadGate`
  wraps `AssistantMessageComponent.prototype.describe` and
  `withoutLiveThinking` drops that direct child while the extension owns
  thinking. The gate lives on `globalThis` (`Symbol.for`) so a `/reload`
  generation cannot stack wrappers, and `session_shutdown` clears it.
- **The files toggle is `/split-files`.** Renamed from `/files` so all eleven
  commands carry the prefix; README, PLAN, demo and tests updated. No saved
  config key changes.
- **Imports use the host's subpath modules** (`pi-tui/utils`,
  `/terminal-capabilities`, `/chrome`, `/chat/assistant-message`,
  `/native/node`); the installed 18.14.2 package exports `./*`, and
  `check-package` still passes (it requires declared package names, not
  subpaths).
- Acceptance: the thinking-head suite covers gate filtering, node-cache reuse
  and shutdown reset; `helpers.test.ts` covers the node filter; the full gate
  set above is green on this tree. It landed in the same commit as the advisor
  panel below, because the two batches share `split-view.ts`, `README.md` and
  this file; the snapshot measures the combined tree.

### Landed — band hot path: bounded streaming, per-panel memo, ingest precompute (H1)

Delta: 134 → 155 tests (95 in `split-view.test.ts`, 25 in
`helpers.test.ts`, 35 in `properties.test.ts`: +6 helper examples, +1 renderer
example, +4 split-view properties, +10 property tests for the new/moved
helpers), assertions 47,004 → 59,011. Coverage 99.93% lines / 97.66% functions
(gate 99/90); lint 0/0; typecheck and package gate unchanged (3 shipped
modules). `split-view.ts` 1859 → 1853 L, `helpers.ts` 312 → 411 L,
`test/split-view.test.ts` 2672 → 2982 L, `test/helpers.test.ts` 202 → 301 L,
`test/properties.test.ts` 458 → 699 L.

- **Streaming is O(retained window), not O(stream).** `tool_execution_update`
  passed the *whole* cumulative partial to `setToolOutput`, which sanitized and
  capped it again on every update. `resultTextTail` walks a result's text
  blocks backwards and keeps only the last `STREAM_RAW_CAP` (32 KiB + 4 KiB
  slack) UTF-16 units without joining the cumulative string, so an update's
  input is bounded by construction. Probe (200 updates of 5 000 chars, 1 MB
  cumulative, flat cumulative strings pre-built outside the timed loop, warm,
  median of 5, ingest pipeline only): 24.4 ms → **14.1 ms**, 36 864 units
  maximum per update. Building the partial by `+=` inside the loop instead
  inflates *both* columns (rope flattening) — the first run of the probe read
  34 → 23.9 ms for that reason, which is the probe's cost, not the extension's.
  The final result still counts the whole sanitized text once per tool call.
- **A panel rebuild is confined to the panel whose data changed.** One
  whole-band key meant any thinking flush or tool tick rebuilt the files column
  too, including `renderDiff(400 lines)` (1.12 ms) and the 500-entry list
  (0.76 ms). `panelMemos` keys each panel on its own inputs (`width`,
  `bodyRows`/`bandHeight`, and the version counters plus `toolMode`/`showDiff`),
  `composedCache` reuses the composed band while every panel returns the same
  arrays, and the seven manual `bandCacheKey = ""` invalidations are gone:
  every input they covered (mode, height, geometry, widths, content versions)
  is now part of a panel key or of its width. `panelRenderCounts()` is the test
  seam; the new property asserts a thinking flush adds exactly one thinking
  build and no tools/files build, and likewise for a tool call and a file.
- **Files rows are precomputed at ingest.** `FileEntry` carries `dir` and
  `base`, so grouping compares strings instead of `path.dirname` per comparison
  and `sanitizeText(path.basename())` no longer runs per row per frame; a
  500-entry micro-probe of the removed work drops 0.20 ms → 0.01 ms per build.
  `path.dirname`/`path.basename` now appear only on the `record` ingest line.
- **One framing primitive.** `filesRow`, the two hand-built rules in
  `filesDiffBody`, the border rows in `filesPanelLines` and `renderPanel`'s
  `bodyRow`/top/bottom collapsed into `helpers.framedRow` (unit-tested
  invariant: `visibleWidth(row) === inner + 2`, content clipped never wrapped).
  The fill is drawn in the theme's border colour, so `╭────╮` stays one
  border-coloured rule; a space fill skips the SGR wrapper, so body rows cost
  no extra escapes. This is `helpers.ts`'s first runtime import — the TUI's
  width primitives, which the frame has to match exactly — and the header
  invariant line says so.
- **The block-shaped tail keeps the surrogate rule too.** The string path
  dropped an orphan low surrogate, but a cut *inside* a text block produced a
  suffix of exactly `cap` units, which the early return left untouched. A
  per-block "was anything sliced" flag is still wrong: the block-split property
  found a text cut at a *block boundary* that also splits a pair (blocks
  `["\ud800", "\udc00…"]`, cap 5). `tailBlocks` now sums the text-block lengths
  in its backwards pass and drops the leading orphan only when the window is a
  proper suffix (`total > joined.length`), which is exactly the string path's
  rule; inside the cap it returns the whole text untouched. The property that
  found it stays: `resultTextTail` is asserted independent of the block split.
- **Also moved into `helpers.ts`** (no behaviour change): `isRecord` (one
  canonical guard for the package) and `resultText`, which the folding above
  made shared, plus `nonEmptyLines` for the two line pipelines in
  `setToolOutput`.
- **The theme-invalidation test measures its own colour, for all ten.** It only
  passed for a colour if the *previous* iteration's colour was still in the last
  fingerprint (that residue forced the rebuild), it silently relied on earlier
  suites leaving a file row behind (`text` is only used by the files row), and
  it only ever exercised seven of the ten colours `themeFingerprint` samples —
  `error`, `warning` and `toolOutput` were never checked. It now seeds one row
  per colour (a finished tool, an errored tool with output in full mode, a
  tracked file, an open thinking block for the `warning` dot) and re-warms with
  the palette cleared between iterations. Dropping any of `text`, `error`,
  `warning` or `toolOutput` from the fingerprint fails it; before this change
  all four removals passed.
- **Properties, not just examples.** Four split-view properties and ten helper
  properties cover the invariants above (listed under "Tests and coverage").
  Each was mutation-checked: dropping `${filesVersion}` from the files key
  fails both memo properties; forcing every panel to rebuild fails the
  confinement property; appending instead of replacing the stored output fails
  the streaming property; and rendering the directory instead of `entry.base`
  fails the files-row property. The first draft of the memo property was
  worthless — it compared two cold builds — so it now warms the memo before the
  steps.
- **Mutation-checked**: dropping `thinking.version` from the thinking memo key
  fails 7 tests — `streamed thinking and tool results reach the panels`,
  `streamed thinking is coalesced`, both replay tests, `empty thinking blocks
  are not retained`, and both band-memo properties; dropping the geometry
  preset from the dock width fails 6, the remount-preset test among them.

### Landed — render budget, saved-layout restore, cap count, visibility retry (R4)

Delta: 122 → 129 tests (85 in `split-view.test.ts`, +3 examples and +2
properties there, +1 each for the saved layout and the visibility retry),
assertions 44,883 → 45,752. Coverage 99.93% lines / 97.55% functions (gate
99/90); lint 0/0; typecheck and package gate unchanged.
`split-view.ts` 1796 → 1854 L, `ui-panels-config.ts` 173 → 176 L,
`test/split-view.test.ts` 2134 → 2351 L.

- **The tool row survives its own detail.** `toolLines` built every card's
  rows and then let `newestRows` keep the newest `maxRows` wrapped rows, so a
  long diff pushed the card's identity row off the top (band 20, 200-line
  diff: no `edit` row at all). Cards are now budgeted newest-first against the
  rows left (`toolCardBody`), the row is always taken from the budget, and
  detail that does not fit closes with `+N more detail rows`. `toolPrefix` and
  `toolDiffLines` truncate to the column, which is what makes a card's row
  count knowable before it is placed.
- **`+N earlier lines` counts the whole result.** `resultText` returned
  `capToolText(...)`, so the count described the retained 32 KiB window: a
  40,000-line result reported `+4675`. It now returns the reported text
  unsanitized and uncapped, and `setToolOutput(entry, text, countAll)`
  sanitizes it once and takes the full line count at ingest; a streaming
  update still counts only the retained window. Per streaming update, only the
  cap, the window count and the tail are O(retained): the sanitize pass stays
  linear in the cumulative partial (one pass, as before R4 — sanitizing in both
  `resultText` and `setToolOutput` would have made it two, and capping first is
  not an option because a cut escape sequence would survive the sanitizer). The
  final result's full-text count is linear in the result, paid once per call.
- **`/split` ON restores the saved size and geometry.** Only panel booleans
  were applied, so a layout saved at 30 rows / 45 % / 60 cols / `wide` came
  back at 8 rows / 60 %. `applySavedMetrics` (shared with `session_start`)
  adopts `toolMode`, `bandHeight` (and whether it is auto), `geometry`,
  `toolsWidthPct` and `filesWidth`; the fallback branch — nothing saved —
  still keeps the live size and enables thinking + tools.
- **A settings failure no longer disables transcript hiding forever.**
  `visibilityUnsupported` latched for the process, so one throwing settings
  object stopped every later session from hiding thinking/tool activity.
  `session_start` clears it and the forced sync retries; the in-session latch
  (which is what stops repeated throwing) is unchanged.
- **Property** (`property: a tall tool card always keeps its row inside the
  band`): 0–200 diff lines × band heights 6–40, asserting the `edit` row
  renders, the band keeps its height, every row its width, and the omission
  marker appears exactly when the expected detail exceeds the body rows left.
  **Properties** (`property: the earlier-lines marker counts output past the
  character cap`): 0–25,000 lines × band heights 18–60, asserting exactly the
  newest `min(cap, total)` lines render, the oldest (and the boundary) do not,
  and the marker equals `total − shown`.
- **Mutation-checked** (each reverted after the run): restoring `capToolText`
  in `resultText` fails both cap-count tests (`+3386` for 3388 lines); the
  unbudgeted `rows.push(...detail)` fails the three card tests (the band starts
  mid-diff, no `edit` row); dropping `applySavedMetrics` from the `/split` ON
  branch fails the restore test (8 rows, not 24); dropping the
  `visibilityUnsupported` reset fails the retry test.

### Landed — tool output preview window (R3)

Delta: 122 tests unchanged — one preview property added, one property for the
now-dead `outputPreview` helper removed; assertions 44,530 → 44,883; overall
functions 97.52% → 97.50% (the deleted helper was covered); lines 99.93% and
lint 0/0 unchanged. `split-view.ts` 1785 → 1796 L, `helpers.ts` 323 → 312 L,
`test/split-view.test.ts` 2057 → 2134 L, `test/properties.test.ts` 477 → 458 L.

- **Wrong slice, wrong count.** Retention was already a tail (`capToolText`
  keeps the newest chars, `setToolOutput` the last 20 lines), but the renderer
  took the *first* `previewCap` lines of that window: a 25-line result showed
  `L5, L6` and claimed `+18 more`. It now shows the newest `previewCap` lines,
  with `+N earlier lines` above them, where N counts every non-empty line seen
  (`outputLineCount`, a max across cumulative updates).
- **Whitespace-only finals no longer blank the panel.** A final result of
  `"\n"` used to overwrite streamed output with nothing; `setToolOutput` now
  ignores inputs with no non-empty lines, matching the empty-string path.
- **Property** (`property: tool output previews its newest lines and counts
  earlier ones`): arbitrary partial/final counts 0–80, band heights 18–60 (so
  the cap is 2–6), blank lines and padded tokens between every line, and a
  cumulative partial followed by a final. Oracles: exactly the newest
  `min(cap, total)` lines render, older lines do not, the marker equals
  `max(partial, final) − shown`, and the marker row precedes the newest line.
  Mutation-checked: retaining the head instead of the tail, slicing the head of
  the window, counting only the retained window, and letting a whitespace final
  wipe the output each fail it.
- **Dead helper removed.** With the preview slicing directly, `outputPreview`
  had no product caller; the helper and its property test were deleted rather
  than left exported for tests only.

### Landed — mount-once harness + auto height lifecycle (R2)

Delta: 120 → 122 tests, assertions 44,482 → 44,530; coverage (99.93% /
97.52%) and lint (0/0) unchanged. `split-view.ts` 1775 → 1785 L,
`test/split-view.test.ts` 2026 → 2057 L.

- **Harness mount contract.** `createHarness` re-invoked the widget factory on
  every `widget()` call, while omp calls it once at mount and keeps the
  component. That silently re-ran auto-height derivation and geometry
  resolution in tests, which is why the defect below was invisible. The
  harness now caches the component from `setWidget` and clears it on unmount;
  the full suite passed unchanged once the factory was no longer re-entered.
- **Auto height on session load.** `session_start` assigned the config height
  (20 by default) and left an already-mounted widget at it: on a 400×100 pane
  the band collapsed 45 → 20 rows on the second session. It now re-derives
  `defaultBandHeight(tuiRef.terminal.rows, profile)` whenever `bandHeightAuto`
  is set; a pinned height still wins. Regression: mount once at 400×100,
  reload a height-less config, expect 45 rows (mutation-checked).
- **`/split-save` no longer pins an auto height.** It persisted the live
  derived number, so a layout saved on a tall pane hid the band at next
  startup on a shorter one (`rows - bandHeight < 18`). A saved payload omits
  `bandHeight` while the height is auto, matching the existing `filesWidth:
  null` omission. Regression: save at 400×100 (auto 45), load at 120×45,
  expect a 20-row band rather than `[]` (mutation-checked).

### Landed — review pass: visibility mutation coverage (R1)

Delta: 119 → 120 tests, assertions 44,476 → 44,482; coverage (99.93% / 97.52%)
and lint (0/0) unchanged. `test/split-view.test.ts` 2004 → 2026 L. No product
code changed.

The C1 refactor of the visibility policy had only been validated by the suite
passing, so it was mutation-checked per the review note:

| Mutation | Result |
| --- | --- |
| thinking panel no longer hides transcript thinking | 4 tests fail |
| render-time self-heal (`scheduleVisibilitySync`) disabled | 8 tests fail |
| `geometryMode` dropped from the band cache key | remount-preset test fails |
| `thinking.version` dropped from the band cache key | coalescing test fails |
| `force` ignored when the recorded policy equals the desired one | **survived → new regression added** |
| "nothing owned" guard dropped (always apply) | survived — behaviourally inert; kept as an optimization that avoids touching user settings |

(The two cache-key rows predate H1, which replaced the single whole-band key.
Re-run against the current tree, their equivalents both fail: dropping
`thinking.version` from the thinking panel's memo key fails 6 tests, and
dropping the geometry preset from the dock width — where the preset now reaches
a panel, through `allocateWidths` — fails 6 including "a remount after a resize
drops the band memo of the old preset".)

- The surviving `force` mutation is the `/reload` case: the process-global
  `applied` registry outlives the settings object, so the recorded policy can
  equal the desired one while the new settings carry no override. New test
  "session_start re-applies an equal policy after a reload" clears the
  override behind the registry's back and asserts `session_start` re-applies
  it; the mutation now fails. Ordering against the unsupported-settings test
  is no longer load-bearing: R4 clears the `visibilityUnsupported` latch on
  every `session_start`, so a latched flag only silences the rest of that
  session.
- The second survivor is not covered by design: `clearOverride` on a settings
  object with no override is a no-op, so the guard changes no observable
  behaviour — it only avoids redundant writes. The guard is documented above
  and stays.

### Landed — W6 bash replay (behaviour batch)

Delta: 118 → 119 tests, assertions 44,472 → 44,476, overall coverage and lint
unchanged (99.93% / 97.52%, 0 warnings). `split-view.ts` 1771 → 1775 L, tests
1961 → 2004 L.

- **W6 → policy (a): no bash "seen" replay.** `replayAssistant` still rebuilds
  the bash tool row, but no longer calls `record()` for it, so a resume does
  not re-probe every command token against today's filesystem. History cost is
  constant instead of growing with the branch, and the files list no longer
  drifts as files are moved or deleted. `s` entries remain a live observation;
  `read`/`write`/`edit`/`ast_edit` and generic path keys still replay.
- Test: a branch with three bash calls (two naming real files, one with flags
  and redirection) plus one read renders `Files (1)` containing only the read,
  and a `session_tree` rebuild is byte-identical. Mutation: restoring the
  unconditional `record()` fails it.

### Landed — code simplification (C1)

Delta: 118 tests unchanged, overall lines unchanged at 99.93%, functions
97.40% → 97.52% (seven extracted helpers, all reached), lint 2 warnings → **0**
(Q8 closed); no product behaviour changed — the same suite, `bun run demo`
and `check-package` pass.

- **Visibility gating has one owner.** `pendingVisibilityPolicy(force)` answers
  "is there anything to apply" for both `syncTranscriptVisibility` and the
  render-time scheduler, so the two copies of the same guard (and their policy
  computation) cannot drift; `syncTranscriptVisibility` is now under the
  cyclomatic limit.
- **One dock-width formula.** `clampedDockCols(cols)` is shared by
  `panelLayout` and the `/split-geometry` message, so the reported dock cannot
  disagree with the rendered one.
- **One layout entry point.** `applyLayout(ctx)` replaces six
  `reconcile(ctx) + syncTranscriptVisibility()` pairs.
- **Config normalization extracted.** `plainConfig`, `intOrNull`,
  `toolModeOf` and `geometryOf` replace the repeated shape/type guards;
  `normalizeConfig` drops from 16 to under the cyclomatic limit and the
  `Number(null) === 0` hazard is named once.
- **Smaller duplications.** `bashPathHits` resolves tokens through
  `addPathHit` (same existence check, no second copy); `EXACT_PATH_TOOLS`
  stores one key per tool; `renderPanel` fills its body in a single loop;
  `/split-height` computes its clamp once.

### Landed — test-suite simplification (T1)

Delta: 141 → 118 tests, test sources 2984 → 2647 L (−11%), assertions 49,151 →
44,472; coverage unchanged at 99.93% / 97.40%, lint unchanged at 2 parked
warnings, 0 errors. No product code changed.

- **Subsumed helper examples removed.** `capDisplayLine`, `outputPreview`,
  `transcriptVisibility`, the `geometry presets` examples and the
  `defaultBandHeight` example were pinned instances of properties that already
  specify the same function (including the aspect boundary, the documented
  curves and the negative/zero caps). `lastImageBlock` kept only its non-array
  rejection cases; the property owns the array semantics.
- **Advisor examples replaced by their properties.** The inertness, live-tally
  and branch-replay examples duplicated the three properties; the
  main-agent-feeds test stayed as the positive control that guards against an
  always-empty band.
- **Geometry preset examples removed after widening the property ranges.**
  `columnsArb`/`rowsArb` now cover 90–700 × 20–200, so the 4K (400×100) and
  32:9 (500×40) panes the deleted examples pinned are exercised by "the
  resolved preset sizes the band and the dock for any terminal". The
  self-contained flip test keeps the exact command message and the
  `auto` hand-back.
- **Near-duplicate geometry properties removed.** Two properties re-derived the
  band/dock formulas from the same profile constants as "each preset matches
  its documented curve" (which uses literals, so drift is still caught);
  "4k reproduces the pre-switch curve" was the same formula with the module's
  own constants.
- **Width cache test folded.** "re-rendering at another width re-wraps instead
  of reusing stale rows" became a fixed `120 → 60 → 120` prefix inside the
  width-sequence property, which already asserts repeat renders are identical.
- **Equivalence property is no longer vacuous.** `band equals the main-only
  subsequence` now asserts the positive direction too: main reads must produce
  a non-zero Files count and a non-empty main diff must replace "No edit yet"
  (mutation-checked by making `isMainAgent` always false).
- **Examples kept where the property cannot replace them**: the
  `capToolText` marker format, `capDiffText` (no property exists), the
  `bandToolsColsFor` both-minimums fallback, `dockColsFor`'s manual-above-auto
  ceiling, `appendStreamTail`'s overflow policy, `normalizeConfig`'s defaults
  and clamps, and `sanitizeText`'s exact stripping.
- **Shared harness helpers.** `writeConfig`, `fullLayout`, `setToggle` and
  `ensurePanel` were defined 2–4 times across suites; they are now defined once
  next to the singleton harness.

### Landed — advisor compatibility (A1)

Delta: 133 → 141 tests, overall lines 99.92% → 99.93%, functions 97.20% →
97.40% (FNF 143 → 155, twelve new function records, all reached; the four
misses are unchanged), lint
unchanged at 2 warnings / 0 errors. No band geometry moved: no new panel, row
or column.

- **A1 → top-level-agent guard.** omp delivers advisor (and subagent) tool
  calls to extension `tool_call`/`tool_result` hooks with
  `ctx.agent.kind === "sub"`; the advisor's builtins are wrapped in
  `ExtensionToolWrapper`, while its `advise` tool is constructed directly and
  emits nothing. The files/diff panes ingested every call, so a review's
  `read`/`grep` showed up as primary activity and then vanished on resume
  (replay reads only the primary branch). `isMainAgent` now gates
  `tool_call`, `tool_result` and the three `tool_execution_*` hooks; a missing
  identity (older host) still counts as main.
- **A1 → advisor tally status line.** (Superseded by the advisor panel pass
  below: the status entry duplicated the panel title and only existed because
  there was no panel.) Advisor cards arrive as `custom`
  messages (`customType: "advisor"`, `details.notes`) on both delivery paths —
  turn-less recording emits `message_start`/`message_end` directly, and a
  steered batch passes through the same pair when the loop injects it. The
  `message_end` handler counts severities delivered since the last real user
  prompt (`synthetic` / agent-attributed user messages are not a boundary) and
  mirrors them via `ctx.ui.setStatus("split-view.advisor", …)`;
  `reconstruct`/`session_tree` rebuild the tally from `custom_message` branch
  entries. A fourth band column was rejected: notes are prose in a fixed-height
  band and the transcript card already renders them at full width. The status
  is cleared on turn reset, when every panel is toggled off (`/split` off
  unmounts the band, so its status chrome goes too), and on `session_shutdown`.
- Tests: advisor-attributed `tool_call`/`tool_execution_*`/`tool_result` leave
  Files and Last-Edit untouched while main-agent events still populate them;
  live tally text and its user-prompt reset; branch rebuild after
  `session_tree`. Properties (fixed seed `20261101`): advisor-only tool streams
  leave the band byte-identical; the band equals the main-only subsequence of
  any main/advisor interleaving; the tally equals an independent count of
  notes since the last real prompt, both live and replayed from the branch.
  Mutations checked: dropping the guard fails both band properties; dropping
  the live or the replay reset fails the tally property.

### Landed — Q1–Q7 + B7 (structural batch)

Delta: 93 tests unchanged, no test file edited; coverage lines 99.91% →
99.92%, functions 96.52% → 97.01% (19 extracted helpers, still four misses);
lint 15 → 2 warnings (both Q8, untouched), 0 errors throughout;
`split-view.ts` 1389 → 1531 L (more, not less: each extraction carries its own
signature and a doc comment, and three functions needed a second split to clear
a fresh warning). Rendering is byte-identical step by step: `bun run demo`
diffed against the pre-batch output after every step with only the tool
duration cell normalised.

- **Q6 → `pathsFrom`.** `EXACT_PATH_TOOLS` table (`read`/`write`/`edit`/
  `ast_edit`, existence check skipped) + `GENERIC_PATH_KEYS` /
  `GENERIC_LIST_KEYS` loops, `addPathHit` and `bashPathHits` extracted. cc 18 /
  ccog 24 → under limit. The `sonarjs/super-linear-regex` disable moved with
  the token regex.
- **Q7 → options objects.** `NewestRowsOptions` and `PanelOptions`; both
  functions destructure in the body (a destructured parameter does not reduce
  the reported parameter count), all three callsites updated. 6 and 5 params →
  1 each.
- **Q2 → `toolLines`.** `toolPrefix`, `toolDetailLines`, `toolDiffLines`; the
  compact-mode blank separator and oldest-first ordering untouched. cc 22 /
  ccog 39 → under limit.
- **Q1 → `filesPanelLines`.** `filesRow`, `fileRows`, `filesBody`,
  `filesDiffBody`; the grouping loop needed a second split (`fileEntryRow` +
  `fileRunRows`) because `fileRows` landed at ccog 16. `filesPanelLines` keeps
  4 parameters and pads only after `filesBody`, which is how the truncated list
  and the notice row share the frame.
- **Q4 → `renderBand`.** `allocateWidths` + `composeColumns` as planned, plus
  `panelLayout` and `narrowFilesNotice`: after the first two the function was
  still cc 17 / ccog 16 (the `? 1 : 0` cache-key ternaries and the id pushes),
  so the id/dock computation and the files-only hint moved out too. The cache
  is still bypassed (not stored) on the notice and empty branches.
- **Q3 → `reconstruct`.** `replayAssistant` / `replayToolResult` typed from
  `SessionMessageEntry` (imported from
  `@oh-my-pi/pi-coding-agent/session/session-entries`); cc 20 / ccog 36 → under
  limit. W6 explicitly not folded.
- **Q5 → `splitView`.** `requireTui` promoted to module scope, event wiring →
  `registerEvents`, commands → `registerCommands` →
  `registerPanelToggles` + `registerBandSettings` (a single registrar was 174
  lines, over the 100 limit). Registration order is unchanged: ten commands,
  ten `pi.on` hooks, factory body now 12 lines. `/split-geometry` later added a
  third registrar (`registerGeometryCommand`) for the same reason: eleven
  commands, and `registerBandSettings` back under the 100-line limit.
- **B7 → CI.** `.github/workflows/ci.yml`: one `gates` job on Bun 1.4.3 running
  `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`,
  `bun run test:coverage`, `bun run lint`. No remote exists yet, so it stays
  inert; the same sequence was run locally against `bun.lock` and exited 0.

### Landed — B1, B2, B4, B5, B6 (behaviour batch)

Delta: 62 → 81 tests, overall functions 96.36% → 96.43% (both count seams are
covered), lines unchanged at 99.91%, lint unchanged at 15 warnings / 0 errors.

- **B4 → PLAN T1.** `/split-trim-response` has suite coverage: `off`/`ON`/
  unknown-arg forms through the real `settings` singleton (case-insensitive
  parse and explicit-arg idempotence both load-bearing), plus a throwing
  settings object driving the existing `catch` → `warning` notify, no override.
  Required a `setSettings` harness seam.
- **B5 → PLAN W2/T3.** `thinking.end` pushes only when `lines.length || tail`;
  proved by the new exported count seam `retainedThinkingBlocks()` (500 empty
  start/end pairs leave it unchanged, the next real thought adds exactly one).
- **B1 → PLAN W4.** Files-only below 90 cols renders the framed hint
  `Files panel needs ≥90 cols` at the exact `bandHeight`/width contract
  (40, 60, 89 covered).
- **B2 → PLAN W5.** The files-pane diff keys off `details.diff` plus a
  resolvable path; a `toolName: "patch"` result updates it, an unresolvable
  path leaves the previous diff alone.
- **B6 → PLAN T7.** Image results render the one-line fallback (never the
  base64), a finished call shows its elapsed time while a fresh one stays
  untimed until the one-second gate, and `MAX_TOOLS` eviction keeps the newest
  60 — asserted through the new `retainedToolEntries()` seam, because the band
  renders only the newest rows. Mutations: dropping the eviction block leaves
  65 entries; evicting `pop()` instead of `shift()` drops the newest call.

### Landed — split-view improvement pass (S1–S6)

Delta: 93 → 102 tests, overall functions 97.01% → 97.08% (three new functions,
all reached), lines unchanged at 99.92%, lint unchanged at 2 warnings / 0
errors. Rendering is byte-identical: `bun run demo` output matches the
pre-batch capture after normalising tool-duration cells.

- **S1 → replay sanitization.** `replayAssistant` now runs branch thinking
  through `sanitizeText`, like live ingestion; a resumed session used to render
  raw OSC/CSI from stored text. Test: a hostile `\u001b]0;PWNED\u0007\u001b[31m`
  thinking block after `session_tree` reaches no row and no control char
  survives.
- **S2 → `toolLines` row budget.** The panel builds newest-first and stops once
  `maxRows` items exist instead of rendering every tool (and every diff) each
  frame. 60 tools × 150-line diff at a 12-row band: 14.5 ms → 1.1 ms per
  invalidated render; cost no longer tracks history depth.
- **S3 → `capDiffText`.** `setEditDiff` stores at most `MAX_DIFF_LINES` (400)
  lines / `MAX_DIFF_CHARS` (64 KiB) with a marker, asserted through the new
  `retainedEditDiff()` seam. A 20 000-line `details.diff` cost 24 ms in
  `renderDiff` alone; it now retains 401 lines and renders under 1 ms. The cap
  is applied without a `sanitizeText` pre-pass: `renderDiff` sanitizes the
  text it renders, and pre-sanitizing collapsed tab indentation (a tab renders
  as three cells) to a single space. A test pins both halves: escapes never
  reach a row, and the stored text stays tab-faithful.
- **S4 → atomic config save.** `saveUiPanelsConfig` writes a pid-scoped temp
  file and renames it, creating the agent directory first; a fresh agent dir
  used to make every `/split-save` fail, and a crash mid-write left truncated
  JSON that loaded as defaults. Tests cover the fresh-directory save (no temp
  file left behind) and the failure path (dir at the config path → `false`, no
  `.tmp` residue).
- **S5 → image label instead of payload.** `ToolEntry.imageLabel` stores the
  already-rendered `imageFallback` line; an 8 MB base64 result used to keep
  7.7 MB of retained heap for the whole session while only that line was ever
  shown. Retained delta is now 0.06 MB; the `1x1` dimension assertion proves
  the label is computed at ingest.
- **S6 → stale text and a stale bound.** `/split-height` help says 6–80 (the
  README already did); the `/split-trim-response` notify says `Transcript:`
  instead of the pre-port `Panel C:`; the `normalizeConfig` property asserts
  `<= MAX_BAND_HEIGHT` instead of a hard-coded 40, with explicit clamp
  assertions at both bounds.

### Landed — geometry preset switch (G1)

Delta: 102 → 133 tests, overall functions 97.08% → 97.20% (five new functions,
all reached), overall lines unchanged at 99.92%, lint unchanged at 2 warnings /
0 errors. Two example blocks (`geometry presets` in both files) plus a
property suite (`geometry profiles` here, `geometry preset properties` in
`test/split-view.test.ts`); T1 later removed the examples whose properties
subsumed them.

- **G1 → `4k` / `wide` presets.** The single auto curve assumed a 4K cell grid;
  on a 21:9-or-wider pane it spent 45 % of the rows on the band and left the
  extra columns unused. `helpers.ts` now carries `GEOMETRY_PROFILES` (`4k` is
  the old curve verbatim — `dockColsFor`/`defaultBandHeight` default to it, so
  no existing call site or test moved) and `autoGeometryMode`, which reads
  ≥ 8 columns per row as ultrawide. `ui-panels-config.ts` stores the choice as
  a strict literal (garbage → `auto`) and `/split-geometry` pins it.
- **Preset resolution is centralized.** `resolveGeometryMode()` is the only
  place that turns `geometrySetting` into a mode, and it runs at mount, on
  session load and from `/split-geometry`. Testing the first draft found two
  defects that the example tests alone had missed: (a) the mount
  factory resolved the mode only for `auto` while `session_start` reset it to
  `4k`, so a *saved* preset was overwritten and never armed; (b) resolution
  lived only in the factory, which the host calls on *first* mount, so a
  session switch in the same process dropped an ultrawide pane back to `4k`.
  Two examples pin the fixed behavior ("a session switch keeps the auto preset
  without a remount", "a restart on a differently shaped pane re-lays a pinned
  band").
- `bandHeightAuto` no longer clears itself at mount: an auto height is
  re-derived per mount and per preset switch, so a re-mounted widget follows
  the terminal instead of a stale size. `/split-height` still pins it, and a
  pinned height ignores the preset's curve (asserted).
- The `wide` band floors at 14 rows, so it fits any terminal ≥ 32 rows and
  hides itself below that exactly as `4k` does — no short-screen special case.
- The band memo outlives an unmount, so `geometryMode` joined its cache key
  alongside `/split-geometry`'s and `reconstruct`'s explicit clears: a remount
  at a new shape with a pinned height changes nothing else in the key.
- `scripts/demo.ts` prints the resolved preset per row and the two curves'
  shares; `README.md`'s geometry table replaces the two hand-written examples.
- **Property oracles, not profiles.** Asserting `defaultBandHeight(rows,
  GEOMETRY_PROFILES.x)` in an integration property is blind to a drifted
  `bandPct` — expectation and behavior move together. The pure suite therefore
  also checks both curves against literal shares (0.45/20 + 0.25/34–120,
  0.35/14 + 0.32/40–200) and `autoGeometryMode` against a literal 8, and the
  integration examples pin absolute panes (500×40 in the flip test, 400×100 in
  the large-terminal test, 500×60/90 in the pinned/remount regressions).
- **Mutation-checked** (each reverted after the run): `wide.bandPct` 0.35 →
  0.42 fails the documented-curve property; `AUTO_WIDE_ASPECT` 8 → 7 fails the
  threshold property (it asserts both sides of `8·rows`); dropping
  `geometryMode` from the band cache key fails the remount test (the memo
  outlives an unmount, and a pinned height leaves nothing else in the key to
  change); letting the manual dock path honour `profile.maxDockCols` fails the
  manual-width property; a wrong dock in the `/split-geometry` message fails
  the pinned-height property, which compares the message against the rendered
  column offsets; forcing the resolver to `4k` fails the preset-facing tests;
  reverting the session-load resolution fails the session-switch test.

### Landed — advisor panel (auto with advisor mode)

Delta: 159 → 168 tests, overall lines 99.93% → 99.94%, functions 97.73% →
97.95% (FNF 176 → 196, twenty new function records, all reached; the four
misses are unchanged), lint unchanged at 0 warnings / 0 errors, `split-view.ts`
1898 → 2138 L. The status entry and its seam are gone (`ADVISOR_STATUS_KEY`,
`advisorStatusText`, `syncAdvisorStatus`, and the harness `status` accessor).
Committed together with the wide-order / live-head batch above, which shares
`split-view.ts`, `README.md` and this file; its message covers both.

- **Mode comes from the live session.** `/advisor on|off` is session-local —
  no extension event, no setting write — so `readAdvisorMode` reads
  `AgentSession.isAdvisorEnabled()` off the `AgentRegistry.global()` ref whose
  `sessionId` matches `ctx.sessionManager.getSessionId()`, and a 400 ms
  `unref`'d poll catches the switch while the band is unmounted. Enabled
  without a resolved model counts as on. No matching ref (older or detached
  host) falls back to the `advisor.enabled` setting, and either path failing
  means "off": the panel is decorative, so it must not break a render or an
  event handler. Subagent `session_start`s re-adopt the config but not the
  advisor flags, which belong to the top-level session that owns the band.
- **Host-load constraint: no host domain modules.** The first version imported
  `cfgAdvisorEnabled` from `@oh-my-pi/pi-coding-agent/advisor/settings`, which
  loads under `bun test` but makes the extension fail to load in the real
  host: `omp -e ./split-view.ts` reports
  `Cannot find package '@oh-my-pi/pi-tui' imported from
  …/node_modules/@oh-my-pi/pi-coding-agent/src/advisor/settings.ts`. The
  importer is OURS, but the failing resolution is a *bare* `@oh-my-pi/pi-tui`
  import from a file inside `node_modules` (the host's loader answers that
  specifier for extension files only; a minimal `node_modules` probe package
  that exports from `@oh-my-pi/pi-tui` reproduces it exactly). Any host module
  whose on-disk graph reaches such an edge breaks the load — `advisor/settings`
  reaches 1789 files including `config/model-resolver.ts`. The fallback now
  reads the setting by id through the already-imported registry
  (`lookup("advisor.enabled")`), so the extension's graph is the pre-change one
  plus `registry/agent-registry` (verified loadable). Root and `node_modules`
  graphs were also probed in the real host: the extension sees the live `Main`
  ref with a matching `sessionId`, and `setAdvisorEnabled(true)` — what
  `/advisor on` calls — flips the same getter the poll reads.
- **Notes are a window on this turn.** `addAdvisorNotes` keeps the severity
  counts it always had, and now also stores one bounded, single-line row per
  note (newest 100, ≤2000 chars each) with its optional advisor tag.
  `resetAdvisorTally` is still the single turn-boundary reset, so notes and
  tally live and die together — live, across `reconstruct`, and on shutdown.
- **Rendering is a normal band panel.** `advisor` joined `PanelId`, the panel
  memo (`a|width|rows|advisorVersion`), the composed cache (an `advisor` array
  compared by identity) and `panelRenderCounts`. Its title is the tally
  (`Advisor · 1 blocker · 2 concerns`), its rows are pre-coloured
  severity-tagged lines, so no new theme colour exists and
  `themeFingerprint` already samples all four tones.
- **Layout: stack, strip, or the whole band.** With thinking on, the advisor
  stacks above the thinking panel *inside that column* (its own memoised
  composite, so the column join still caches on identity); the block is
  `advisorBodyRows()` = clamp(⌊bandHeight/6⌋, 1, 4) rows plus its frame, and
  thinking takes the rest of the same `bandHeight`. Without thinking it is a
  full-width strip over the remaining columns; with no other panel it takes
  the whole band. Totals stay exact in every case: `strip + columns` and
  `advisor + thinking` both equal `bandHeight`.
- **`/split` is the master off.** `splitOff` is now explicit state instead of
  being inferred from the panel flags, which could not express an
  advisor-only band; `--no-split` still starts bare, the individual toggles
  clear it when they turn a panel on, and a new advisor activation clears it
  so the panel can appear on its own.
- **Fixed while landing it.** The first frame dump (120 cols, 3 columns, strip
  path) was 25 rows, not 20: the files column rendered `bandHeight` regardless
  of the strip above it. `panelLines` now sizes the files panel from the body
  rows it is given (`bodyRows + 2`), which is identical when no strip exists.
  The plan's stacked-composite step passed the band width rather than the
  thinking column's width; that overran the row join and was corrected to the
  column width before the first run.
- Tests: a new `advisor panel` suite owns a registered fake ref (released in
  `afterAll`, so the poll cannot leak the panel into later suites): auto
  on/off with no other panels, the stack (3 columns at row 0) becoming a
  full-width strip (`columnStarts(row0) === [0]`) when thinking is hidden and
  back, notes and tally live, the user-prompt boundary, branch replay, a ref
  for another session id not counting, `/split` off/on around an advisor-only
  band, and the `advisor.enabled` setting as the no-ref fallback (that test
  imports the host's advisor settings module only to register the id). The
  tally property now reads the panel title live and replayed; the per-panel
  rebuild property expects `advisor` unchanged.
  Mutations checked (each reverted after the run): matching any ref regardless
  of session id fails the other-session test; letting the files column keep
  `bandHeight` under a strip fails the `wide` files-first test (20 rows → 24);
  dropping `advisorVersion` from the strip's panel key fails its card-rebuild
  assertion, and dropping it from the stacked composite key fails the notes
  test; keeping `splitOff` out of the `/split` guard fails the advisor-only
  hide test; a misspelled fallback setting id fails the fallback test; removing
  the `message_end` sync fails all nine.

## Next up

1. W10 — make replay apply the same payload-keyed diff rule as the live
   handler, or narrow the README claim to live turns.
2. W11 — establish whether the host exposes a resize hook before promising
   live `auto` re-resolution; the fallback is to re-resolve at render time
   when the aspect ratio or fit changes.
3. Keep all five gates green and update this snapshot in the same commit as
   any future change.

## Keeping this file honest

- Numbers are produced, never estimated: run the five commands above; the
  coverage gate itself is validated by forcing a failure (`COVERAGE_LINES=1`).
- Update the snapshot and tick/rewrite the affected rows in the same commit as
  the change; delete rows instead of leaving stale metrics.
- Cross-references: `PLAN.md` holds the full backlog text for the landed
  behaviour items (W1–W9, T1–T7); this file holds the ranking, the open rows
  (W10, W11) and the metric targets.
