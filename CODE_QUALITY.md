# Code quality — measurements and work queue

Snapshot: 2026-11-01, after the Q1–Q7 structural batch, B7 CI, the split-view
improvement pass and the geometry preset switch (G1) (base commit `b80a002`;
these batches are uncommitted). This file is the dispatcher:
metrics live here, the ordered queue below is what to work on next, and every
landed item updates the snapshot and ticks its row.

## Commands (what gates what)

| Command | Measures | Gate |
| --- | --- | --- |
| `bun test` | behaviour + property tests | 133 tests, 0 failures |
| `bun run test:coverage` | line/function coverage from Bun's lcov | lines ≥ 99%, functions ≥ 90% (`scripts/check-coverage.ts`) |
| `bun run lint` | ESLint 10 + typescript-eslint + sonarjs; also the cyclomatic/cognitive/size metrics | 0 errors (warnings are the metric report) |
| `bun run typecheck` | `tsc --noEmit`, strict | clean |
| `bun run check:package` | the shipped tarball: `files` coverage and declared deps via the `omp.extensions` import graph (`scripts/check-package.ts`) | `ok` — 3 shipped modules |
| geometry properties (`band properties`, `geometry preset properties`) | 40–300 cols × 6–40 rows with a pinned height, plus 90–420 cols × 24–140 rows for both presets: exact rows/cells, dock offset, no control chars | 0 failures |
| geometry properties (`geometry profiles`) | both curves at 0–2000 rows/cols against literal shares, aspect threshold at every row count | 0 failures |

Test files are excluded from the coverage totals and from the size/complexity
rules; `helpers.ts` is exempt from `no-control-regex` because the sanitizer
targets control characters.

## Snapshot

### Tests and coverage

| File | Lines | Funcs | Test file | Tests |
| --- | --- | --- | --- | --- |
| `split-view.ts` | 99.91% | 98.32% | `test/split-view.test.ts` | 76 |
| `helpers.ts` | 100.00% | 94.74% | `test/helpers.test.ts` | 28 |
| `ui-panels-config.ts` | 100.00% | 80.00% | `test/properties.test.ts` | 29 |
| **overall** | **99.92%** | **97.20%** | | **133** |

49,019 assertions, ~3.8 s wall time. Uncovered:

- `split-view.ts:127` — `themeGetter` default that throws if something renders
  before `session_start` binds a theme. Deliberate, unreachable.
- Functions: 139/143 counted (`FNF`/`FNH` in `coverage/lcov.info`, `test/**`
  excluded as the gate does). The four misses are the throwing `themeGetter`
  default, `BandHub.dispose` (no-op host hook), and the two no-op default
  exports that exist so omp's extension auto-discovery does not report a load
  error (`helpers.ts:321`, `ui-panels-config.ts:163`). Bun 1.4's lcov omits the
  per-function `FN`/`FNDA` records, so those identities come from reading the
  four sites; only the totals come from the report. Every helper extracted by
  Q1–Q7 plus the split-view batch (`capDiffText`, `imageLabel`,
  `retainedEditDiff`) is reached by the existing suite.

Property coverage is behavioural, not line-based: helpers (truncation, caps,
config normalization, visibility), band geometry for arbitrary terminal sizes,
cache idempotence, theme invalidation, escape stripping, arbitrary event
streams. Fixed fast-check seeds (`20261101`) keep failures reproducible.

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
branch: tool output preview cap and `+N more`, image fallback vs base64, a
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

### Lint and complexity (radon `cc` / `raw` equivalents)

2 warnings, 0 errors. Limits: cyclomatic 12, cognitive 15, depth 4, params 4,
function length 100 lines.

| Function | cc | cognitive | other | Location |
| --- | --- | --- | --- | --- |
| `syncTranscriptVisibility` | 15 | — | — | `split-view.ts:1153` |
| `normalizeConfig` | 16 | — | — | `ui-panels-config.ts:64` |

Both are the deliberately parked Q8 pair (just over the limit, untouched). G1
moved `normalizeConfig` from 14 to 16: the geometry read is a strict
two-literal match (`"4k" || "wide"` → the value, else `"auto"`), which costs
two decisions. It stays under the arms-length rule — Q8 is only touched when
another change already rewrites the function, and this one added a field
rather than restructuring — but the next change to it should extract the field
readers. The structural batch cleared the other thirteen warnings and
introduced none: two helpers needed one extra split each while landing
(`fileRows` → `fileEntryRow` + `fileRunRows`, `renderBand` → `panelLayout` +
`narrowFilesNotice`, then `splitView` → `registerEvents` + `registerCommands`
→ `registerPanelToggles`/`registerGeometryCommand`/`registerBandSettings`),
which is why the extraction count is higher than the Q rows name.

Band/dock geometry now scales and switches: `GEOMETRY_PROFILES` +
`autoGeometryMode` in `helpers.ts` pick the `4k` curve (45%-height band,
25%-width dock, 20/80 rows, 34/120 cols) or the `wide` one (35%, 32%, 14/80
rows, 40/200 cols) from the aspect ratio, and `/split-geometry` pins either.
`defaultBandHeight`/`dockColsFor` keep `4k` as their default profile, so a
caller that does not pass one gets the pre-switch behavior.

`filesPanelLines` still takes 4 parameters: the Q1 split keeps the hint row as
`notice?` and passes the padded content width to the helpers instead of a
closure, so no fifth parameter (and no options object) was needed.

File sizes: `split-view.ts` 1643 L, `helpers.ts` 323 L,
`ui-panels-config.ts` 165 L, `scripts/check-coverage.ts` 90 L,
`scripts/check-package.ts` 169 L, tests 2613 L (`split-view` 1779,
`properties` 533, `helpers` 294, `setup` 7).

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
| Q8 | `syncTranscriptVisibility` cc 15, `normalizeConfig` cc 16 (was 14; G1 added the geometry read) | `syncTranscriptVisibility` is untouched; `normalizeConfig` already changed for G1, so the next touch should extract its field readers instead of letting cc climb. Rule: no new warnings. | 0 warnings, or the two functions under the limit |

Nothing else is queued. The remaining open item is behavioural, not
structural: PLAN W6 (bash replay in `reconstruct`) — Q3 extracted the replay
without folding a policy choice, so its three options are still open in
`PLAN.md`.

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
0 errors. Two permanent-example blocks (`geometry presets` in both files) plus
a property suite (`geometry profiles` here, `geometry preset properties` in
`test/split-view.test.ts`).

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
  defects that the permanent-example tests alone had missed: (a) the mount
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
  pinned-example tests use absolute sizes (320/319, 500×40, 400×100).
- **Mutation-checked** (each reverted after the run): `wide.bandPct` 0.35 →
  0.42 fails the documented-curve property; `AUTO_WIDE_ASPECT` 8 → 7 fails the
  threshold property *and* the 320/319 example; dropping `geometryMode` from
  the band cache key fails the remount test (the memo outlives an unmount, and
  a pinned height leaves nothing else in the key to change); letting the manual
  dock path honour `profile.maxDockCols` fails the manual-width property; a
  wrong dock in the `/split-geometry` message fails the pinned-height property,
  which compares the message against the rendered column offsets; forcing the
  resolver to `4k` fails eight tests; reverting the session-load resolution
  fails the session-switch test.

## Next up

1. **W6** — the only open item (bash replay in `reconstruct`); pick one of the
   three policies in `PLAN.md` before touching the replay path again.
2. **Q8** — parked by design: `syncTranscriptVisibility` cc 15 and
   `normalizeConfig` cc 16 against a limit of 12, and the rule is to touch them
   only when another change touches them.
3. Nothing structural is left: keep all five gates green and update this
   snapshot in the same commit as any future change.

## Keeping this file honest

- Numbers are produced, never estimated: run the five commands above; the
  coverage gate itself is validated by forcing a failure (`COVERAGE_LINES=1`).
- Update the snapshot and tick/rewrite the affected rows in the same commit as
  the change; delete rows instead of leaving stale metrics.
- Cross-references: `PLAN.md` holds the full backlog text for the behaviour
  items (W1–W9, T1–T7); this file holds the ranking and the metric targets.
