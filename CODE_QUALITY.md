# Code quality — measurements and work queue

Snapshot: 2026-11-01, after the Q1–Q7 structural batch plus B7 CI (base commit
`b80a002`; the batch itself is uncommitted). This file is the dispatcher:
metrics live here, the ordered queue below is what to work on next, and every
landed item updates the snapshot and ticks its row.

## Commands (what gates what)

| Command | Measures | Gate |
| --- | --- | --- |
| `bun test` | behaviour + property tests | 93 tests, 0 failures |
| `bun run test:coverage` | line/function coverage from Bun's lcov | lines ≥ 99%, functions ≥ 90% (`scripts/check-coverage.ts`) |
| `bun run lint` | ESLint 10 + typescript-eslint + sonarjs; also the cyclomatic/cognitive/size metrics | 0 errors (warnings are the metric report) |
| `bun run typecheck` | `tsc --noEmit`, strict | clean |
| geometry property (`band properties`) | 40–300 cols × 6–40 rows: exact rows/cells, no control chars | 0 failures |

Test files are excluded from the coverage totals and from the size/complexity
rules; `helpers.ts` is exempt from `no-control-regex` because the sanitizer
targets control characters.

## Snapshot

### Tests and coverage

| File | Lines | Funcs | Test file | Tests |
| --- | --- | --- | --- | --- |
| `split-view.ts` | 99.90% | 98.21% | `test/split-view.test.ts` | 57 |
| `helpers.ts` | 100.00% | 94.12% | `test/helpers.test.ts` | 19 |
| `ui-panels-config.ts` | 100.00% | 80.00% | `test/properties.test.ts` | 17 |
| **overall** | **99.92%** | **97.01%** | | **93** |

32,410 assertions, ~3.9 s wall time. Uncovered:

- `split-view.ts:122` — `themeGetter` default that throws if something renders
  before `session_start` binds a theme. Deliberate, unreachable.
- Functions: 130/134 counted (`FNF`/`FNH` in `coverage/lcov.info`, `test/**`
  excluded as the gate does). The four misses are the throwing `themeGetter`
  default, `BandHub.dispose` (no-op host hook), and the two no-op default
  exports that exist so omp's extension auto-discovery does not report a load
  error (`helpers.ts:210`, `ui-panels-config.ts:142`). Bun 1.4's lcov omits the
  per-function `FN`/`FNDA` records, so those identities come from reading the
  four sites; only the totals come from the report. Every helper extracted by
  Q1–Q7 is reached by the existing suite, so the denominator grew by 19 while
  the miss list stayed at four.

Property coverage is behavioural, not line-based: helpers (truncation, caps,
config normalization, visibility), band geometry for arbitrary terminal sizes,
cache idempotence, theme invalidation, escape stripping, arbitrary event
streams. Fixed fast-check seeds (`20261101`) keep failures reproducible.

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
| `syncTranscriptVisibility` | 15 | — | — | `split-view.ts:1092` |
| `normalizeConfig` | 14 | — | — | `ui-panels-config.ts:60` |

Both are the deliberately parked Q8 pair (just over the limit, untouched). The
structural batch cleared the other thirteen warnings and introduced none: two
helpers needed one extra split each while landing (`fileRows` → `fileEntryRow`
+ `fileRunRows`, `renderBand` → `panelLayout` + `narrowFilesNotice`, then
`splitView` → `registerEvents` + `registerCommands` →
`registerPanelToggles`/`registerBandSettings`), which is why the extraction
count is higher than the Q rows name.

Band/dock geometry now scales (`defaultBandHeight`, `maxBandHeight`,
`AUTO_DOCK_*` in `helpers.ts`), so 4K and ultrawide terminals get a 45%-height
band and a 25%-width dock instead of the 48-col/40-row ceilings.

`filesPanelLines` still takes 4 parameters: the Q1 split keeps the hint row as
`notice?` and passes the padded content width to the helpers instead of a
closure, so no fifth parameter (and no options object) was needed.

File sizes: `split-view.ts` 1514 L, `helpers.ts` 244 L,
`ui-panels-config.ts` 146 L, `scripts/check-coverage.ts` 90 L, tests 1910 L.

CI: `.github/workflows/ci.yml` runs the four gates plus `bun install
--frozen-lockfile` on Bun 1.4.3 for every push and pull request. The repo has no
remote yet, so the workflow is inert until one is added; its steps were run
locally in order and all gate on the numbers above.

## Work queue

Ordered. Priority is about risk and leverage, not effort. A row is done only
when its acceptance metric is met and the snapshot above is updated.

### P3 — small or deferred

| ID | Evidence | Work | Acceptance |
| --- | --- | --- | --- |
| Q8 | `syncTranscriptVisibility` cc 15, `normalizeConfig` cc 14 | Just over the limit; touch only if the function changes for another reason. Rule: no new warnings. | — |

Nothing else is queued. The remaining open item is behavioural, not
structural: PLAN W6 (bash replay in `reconstruct`) — Q3 extracted the replay
without folding a policy choice, so its three options are still open in
`PLAN.md`.

### Landed — Q1–Q7 + B7 (structural batch)

Delta: 93 tests unchanged, no test file edited; coverage lines 99.91% →
99.92%, functions 96.52% → 97.01% (19 extracted helpers, still four misses);
lint 15 → 2 warnings (both Q8, untouched), 0 errors throughout;
`split-view.ts` 1389 → 1514 L (more, not less: each extraction carries its own
signature and doc comment, and three functions needed a second split to clear a
fresh warning). Rendering is byte-identical step by step: `bun run demo` diffed
against the pre-batch output after every step with only the tool duration cell
normalised.

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
  ten `pi.on` hooks, factory body now 12 lines.
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

## Next up

1. **W6** — the only open item (bash replay in `reconstruct`); pick one of the
   three policies in `PLAN.md` before touching the replay path again.
2. **Q8** — parked by design: the two functions sit one step over the limit and
   the rule is to touch them only when another change touches them.
3. Nothing structural is left: keep the four gates green and update this
   snapshot in the same commit as any future change.

## Keeping this file honest

- Numbers are produced, never estimated: run the four commands above; the
  coverage gate itself is validated by forcing a failure (`COVERAGE_LINES=1`).
- Update the snapshot and tick/rewrite the affected rows in the same commit as
  the change; delete rows instead of leaving stale metrics.
- Cross-references: `PLAN.md` holds the full backlog text for the behaviour
  items (W1–W7, T1–T7); this file holds the ranking and the metric targets.
