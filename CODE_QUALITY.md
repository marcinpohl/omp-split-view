# Code quality — measurements and work queue

Snapshot: 2026-11-01, after the T1/W2/W4/W5 behaviour batch (base commit
`36c125f`; the batch itself is uncommitted). This file is the dispatcher:
metrics live here, the ordered queue below is what to work on next, and every
landed item updates the snapshot and ticks its row.

## Commands (what gates what)

| Command | Measures | Gate |
| --- | --- | --- |
| `bun test` | behaviour + property tests | 81 tests, 0 failures |
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
| `split-view.ts` | 99.90% | 97.83% | `test/split-view.test.ts` | 48 |
| `helpers.ts` | 100.00% | 93.33% | `test/helpers.test.ts` | 16 |
| `ui-panels-config.ts` | 100.00% | 80.00% | `test/properties.test.ts` | 17 |
| **overall** | **99.91%** | **96.43%** | | **81** |

29,753 assertions, ~3.9 s wall time. Uncovered:

- `split-view.ts:118` — `themeGetter` default that throws if something renders
  before `session_start` binds a theme. Deliberate, unreachable.
- Functions: 108/112 counted (`FNF`/`FNH` in `coverage/lcov.info`, `test/**`
  excluded as the gate does). The four misses are the throwing `themeGetter`
  default, `BandHub.dispose` (no-op host hook), and the two no-op default
  exports that exist so omp's extension auto-discovery does not report a load
  error (`helpers.ts:210`, `ui-panels-config.ts:142`). Bun 1.4's lcov omits the
  per-function `FN`/`FNDA` records, so those identities come from reading the
  four sites; only the totals come from the report.

Property coverage is behavioural, not line-based: helpers (truncation, caps,
config normalization, visibility), band geometry for arbitrary terminal sizes,
cache idempotence, theme invalidation, escape stripping, arbitrary event
streams. Fixed fast-check seeds (`20261101`) keep failures reproducible.

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

15 warnings, 0 errors. Limits: cyclomatic 12, cognitive 15, depth 4, params 4,
function length 100 lines.

| Function | cc | cognitive | other | Location |
| --- | --- | --- | --- | --- |
| `filesPanelLines` | 31 | 50 | — | `split-view.ts:804` |
| `toolLines` | 21 | 39 | — | `split-view.ts:425` |
| `reconstruct` | 20 | 36 | — | `split-view.ts:1019` |
| `renderBand` | 23 | 29 | — | `split-view.ts:691` |
| `pathsFrom` | 18 | 24 | — | `split-view.ts:484` |
| `syncTranscriptVisibility` | 15 | — | — | `split-view.ts:974` |
| `normalizeConfig` | 14 | — | — | `ui-panels-config.ts:58` |
| `splitView` | — | — | 273 lines | `split-view.ts:1067` |
| `newestRows` | — | — | 6 params | `split-view.ts:608` |
| `renderPanel` | — | — | 5 params | `split-view.ts:634` |

`filesPanelLines` sits exactly at the 4-parameter limit after taking the hint
row as `notice?`; the Q1 split must not add a fifth, or extract an options
object (Q7's pattern) as part of the extraction.

File sizes: `split-view.ts` 1366 L, `helpers.ts` 212 L,
`ui-panels-config.ts` 144 L, `scripts/check-coverage.ts` 90 L, tests 1652 L.

## Work queue

Ordered. Priority is about risk and leverage, not effort. A row is done only
when its acceptance metric is met and the snapshot above is updated.

### P1 — complexity hotspots (they shape every future edit)

| ID | Evidence | Work | Acceptance |
| --- | --- | --- | --- |
| Q1 | `filesPanelLines` cc 31 / ccog 50 | Split into `fileRows()` (grouping/newest-first), `filesBody()` (slot budget, `… more`, legend) and `filesDiffBody()`. Keep `filesPanelLines` as composition only. | cc ≤ 12, ccog ≤ 15; all files tests + property geometry unchanged |
| Q2 | `toolLines` cc 21 / ccog 39 | Extract `toolEntryLines(entry, width, full)` and `toolDiffLines(entry)`. | cc ≤ 12, ccog ≤ 15 |
| Q3 | `reconstruct` cc 20 / ccog 36 | Extract `replayAssistant(msg)` / `replayToolResult(msg)`; fold the bash-replay policy (PLAN W6) into `replayToolResult` while it is open. | cc ≤ 12, ccog ≤ 15; branch-replay test still passes |

### P2 — structure and missing behaviour

| ID | Evidence | Work | Acceptance |
| --- | --- | --- | --- |
| Q4 | `renderBand` cc 23 / ccog 29 | Extract `allocateWidths(ids, width)` and `composePanels(...)`; keep the cache/fingerprint logic in `renderBand`. | cc ≤ 12, ccog ≤ 15 |
| Q5 | `splitView` 273 lines | Move command registration into `registerCommands(pi)` and event wiring into `registerEvents(pi)`; the factory then only orchestrates. | function ≤ 100 lines;
`bun run lint` has one warning fewer |
| B7 | No CI (PLAN W7) | Single job: `bun install`, `bun test`, `bun run test:coverage`, `bun run lint`, `bun run typecheck`. | green on the snapshot numbers |

### P3 — small or deferred

| ID | Evidence | Work | Acceptance |
| --- | --- | --- | --- |
| Q6 | `pathsFrom` cc 18 / ccog 24 | Data-driven table for the path keys; one loop. | cc ≤ 12 |
| Q7 | `newestRows` 6 params, `renderPanel` 5 params | Options objects (`{ items, textWidth, maxRows, style, memo, panel }`). | both under 5 params |
| Q8 | `syncTranscriptVisibility` cc 15, `normalizeConfig` cc 14 | Just over the limit; touch only if the function changes for another reason. Rule: no new warnings. | — |

### Landed (was B1, B2, B4, B5, B6)

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

1. **Q1** — `filesPanelLines` is the most complex function (now cc 31 / ccog 50
   after the hint row) and already had one geometry bug; splitting it makes the
   budget logic reviewable.
2. **Q2**, then **Q3** (with W6 bash replay), then **Q4**/**Q5**.
3. **B7** last: CI should lock in the state after the structural work, not
   before it.

## Keeping this file honest

- Numbers are produced, never estimated: run the four commands above; the
  coverage gate itself is validated by forcing a failure (`COVERAGE_LINES=1`).
- Update the snapshot and tick/rewrite the affected rows in the same commit as
  the change; delete rows instead of leaving stale metrics.
- Cross-references: `PLAN.md` holds the full backlog text for the behaviour
  items (W1–W7, T1–T7); this file holds the ranking and the metric targets.
