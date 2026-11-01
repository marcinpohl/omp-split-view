# Code quality — measurements and work queue

Snapshot: 2026-11-01, commit `e1092b7`. This file is the dispatcher: metrics
live here, the ordered queue below is what to work on next, and every landed
item updates the snapshot and ticks its row.

## Commands (what gates what)

| Command | Measures | Gate |
| --- | --- | --- |
| `bun test` | behaviour + property tests | 62 tests, 0 failures |
| `bun run test:coverage` | line/function coverage from Bun's lcov | lines ≥ 99%, functions ≥ 90% (`scripts/check-coverage.ts`) |
| `bun run lint` | ESLint 10 + typescript-eslint + sonarjs; also the cyclomatic/cognitive/size metrics | 0 errors (warnings are the metric report) |
| `bun run typecheck` | `tsc --noEmit`, strict | clean |
| geometry sweep (throwaway probe) | 40–300 cols × 6–40 rows: exact rows/cells, no control chars | 0 failures |

Test files are excluded from the coverage totals and from the size/complexity
rules; `helpers.ts` is exempt from `no-control-regex` because the sanitizer
targets control characters.

## Snapshot

### Tests and coverage

| File | Lines | Funcs | Test file | Tests |
| --- | --- | --- | --- | --- |
| `split-view.ts` | 99.90% | 97.78% | `test/split-view.test.ts` | 29 |
| `helpers.ts` | 100.00% | 93.33% | `test/helpers.test.ts` | 16 |
| `ui-panels-config.ts` | 100.00% | 80.00% | `test/properties.test.ts` | 17 |
| **overall** | **99.91%** | **96.36%** | | **62** |

29,607 assertions, ~3.9 s wall time. Uncovered:

- `split-view.ts:118` — `themeGetter` default that throws if something renders
  before `session_start` binds a theme. Deliberate, unreachable.
- Functions (106/110): the throwing `themeGetter` default, `BandHub.dispose`
  (no-op host hook), and the two no-op default exports that exist so omp's
  extension auto-discovery does not report a load error (`helpers.ts:210`,
  `ui-panels-config.ts:142`). Bun 1.4's lcov omits `FN`/`FNDA` records, so the
  function list comes from reading the four sites, not from the report.

Property coverage is behavioural, not line-based: helpers (truncation, caps,
config normalization, visibility), band geometry for arbitrary terminal sizes,
cache idempotence, theme invalidation, escape stripping, arbitrary event
streams. Fixed fast-check seeds (`20261101`) keep failures reproducible.

### Lint and complexity (radon `cc` / `raw` equivalents)

15 warnings, 0 errors. Limits: cyclomatic 12, cognitive 15, depth 4, params 4,
function length 100 lines.

| Function | cc | cognitive | other | Location |
| --- | --- | --- | --- | --- |
| `filesPanelLines` | 30 | 45 | — | `split-view.ts:780` |
| `toolLines` | 21 | 39 | — | `split-view.ts:411` |
| `reconstruct` | 20 | 36 | — | `split-view.ts:991` |
| `renderBand` | 20 | 26 | — | `split-view.ts:677` |
| `pathsFrom` | 18 | 24 | — | `split-view.ts:470` |
| `syncTranscriptVisibility` | 15 | — | — | `split-view.ts:946` |
| `normalizeConfig` | 14 | — | — | `ui-panels-config.ts:58` |
| `splitView` | — | — | 271 lines | `split-view.ts:1039` |
| `newestRows` | — | — | 6 params | `split-view.ts:594` |
| `renderPanel` | — | — | 5 params | `split-view.ts:620` |

File sizes: `split-view.ts` 1337 L, `helpers.ts` 212 L,
`ui-panels-config.ts` 144 L, `scripts/check-coverage.ts` 90 L, tests 1209 L.

## Work queue

Ordered. Priority is about risk and leverage, not effort. A row is done only
when its acceptance metric is met and the snapshot above is updated.

### P1 — complexity hotspots (they shape every future edit)

| ID | Evidence | Work | Acceptance |
| --- | --- | --- | --- |
| Q1 | `filesPanelLines` cc 30 / ccog 45 | Split into `fileRows()` (grouping/newest-first), `filesBody()` (slot budget, `… more`, legend) and `filesDiffBody()`. Keep `filesPanelLines` as composition only. | cc ≤ 12, ccog ≤ 15; all files tests + property geometry unchanged |
| Q2 | `toolLines` cc 21 / ccog 39 | Extract `toolEntryLines(entry, width, full)` and `toolDiffLines(entry)`. | cc ≤ 12, ccog ≤ 15 |
| Q3 | `reconstruct` cc 20 / ccog 36 | Extract `replayAssistant(msg)` / `replayToolResult(msg)`; fold the bash-replay policy (PLAN W6) into `replayToolResult` while it is open. | cc ≤ 12, ccog ≤ 15; branch-replay test still passes |

### P2 — structure and missing behaviour

| ID | Evidence | Work | Acceptance |
| --- | --- | --- | --- |
| Q4 | `renderBand` cc 20 / ccog 26 | Extract `allocateWidths(ids, width)` and `composePanels(...)`; keep the cache/fingerprint logic in `renderBand`. | cc ≤ 12, ccog ≤ 15 |
| Q5 | `splitView` 271 lines | Move command registration into `registerCommands(pi)` and event wiring into `registerEvents(pi)`; the factory then only orchestrates. | function ≤ 100 lines;
`bun run lint` has one warning fewer |
| B4 | `/split-trim-response` is the only feature gated on host setting IDs; no suite test (PLAN T1) | Drive it through the real `settings` singleton: on → both handles `true`, off → `false`, arg forms, unknown switch → warning, no throw. | new test in `test/split-view.test.ts` |
| B1 | Files-only layout renders nothing below 90 cols with no hint (PLAN W4) | Render a framed hint row (`Files panel needs ≥90 cols`) instead of `[]`; keep the height/width contract. | geometry property at 40–89 cols covers it |
| B2 | Diff subpanel only follows `toolName === "edit"` (PLAN W5) | Key off a non-empty `details.diff` + resolvable path, not the tool name. | `patch`-style event updates the diff pane |
| B7 | No CI (PLAN W7) | Single job: `bun install`, `bun test`, `bun run test:coverage`, `bun run lint`, `bun run typecheck`. | green on the snapshot numbers |

### P3 — small or deferred

| ID | Evidence | Work | Acceptance |
| --- | --- | --- | --- |
| Q6 | `pathsFrom` cc 18 / ccog 24 | Data-driven table for the path keys; one loop. | cc ≤ 12 |
| Q7 | `newestRows` 6 params, `renderPanel` 5 params | Options objects (`{ items, textWidth, maxRows, style, memo, panel }`). | both under 5 params |
| Q8 | `syncTranscriptVisibility` cc 15, `normalizeConfig` cc 14 | Just over the limit; touch only if the function changes for another reason. Rule: no new warnings. | — |
| B5 | Zero-line thinking blocks accumulate forever (PLAN W2/T3) | Push only when `lines.length \|\| tail`; count via rendered output (module-private). | test: 500 empty start/end pairs add no rows |
| B6 | Tool panel extras untested (PLAN T7) | Image fallback line (not base64), duration only for ended calls, `MAX_TOOLS` eviction keeps newest 60. | three assertions |

## Next up

1. **Q1** — `filesPanelLines` is the most complex function and already had one
   geometry bug; splitting it makes the budget logic reviewable.
2. **B4** — highest behavioural risk with zero coverage: the only feature that
   depends on host setting IDs.
3. **Q2**, then **Q3** (with W6), then **Q4**/**Q5**.
4. **B7** last: CI should lock in the state after the structural work, not
   before it.

## Keeping this file honest

- Numbers are produced, never estimated: run the four commands above; the
  coverage gate itself is validated by forcing a failure (`COVERAGE_LINES=1`).
- Update the snapshot and tick/rewrite the affected rows in the same commit as
  the change; delete rows instead of leaving stale metrics.
- Cross-references: `PLAN.md` holds the full backlog text for the behaviour
  items (W1–W7, T1–T7); this file holds the ranking and the metric targets.
