---
title: Testing & Eval Harness
subsystem: evals-testing
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - evals/README.md
  - evals/lib/assertions.ts
  - evals/lib/buildLiveCase.ts
  - evals/lib/liveRunner.ts
  - evals/lib/mockProvider.ts
  - evals/lib/baselines.ts
  - evals/lib/pricing.ts
  - evals/lib/svgPathDistance.ts
  - evals/lib/renderScoreSvg.ts
  - evals/lib/jsdomShim.ts
  - evals/cases/visual/bach-invention-1.visual.eval.ts
  - evals/cases/additive/triplet-demo-extend.mock.eval.ts
  - tests/setup.ts
  - tests/factories/db.ts
  - tests/factories/testEnv.ts
  - tests/e2e/fixtures.ts
  - playwright.config.ts
  - vitest.config.ts
  - vitest.evals.config.ts
  - vitest.evals.smoke.config.ts
  - vitest.evals.visual.config.ts
  - vitest.evals.live.config.ts
  - vitest.eval.config.ts
related:
  - orchestrator
  - score-data-model
  - score-to-abc
  - abcjs-render
---

The eval harness is a four-tier system (mock / smoke / visual / live) that pins
**orchestrator contract behavior** against the Score domain — it asserts on the
*applied Score the user sees*, never on the JSON the LLM emitted. It exists to
lock the M3.5 "add 4 more bars → silent wholesale replacement" incident forward
and to give every future PR a place to land a failing repro before the fix. The
harness sits alongside the broader `tests/` surface: vitest unit + integration
suites and Playwright e2e. The eval tiers are run locally / on demand. The
canonical narrative reference is `evals/README.md`; this doc is the structural
map of the code under `evals/lib/` and the configs, and flags the points where
the README has drifted from the code.

## Entry points

| You want to…                                  | Start at                                                  |
| --------------------------------------------- | --------------------------------------------------------- |
| Understand the tiers / cases / pass-rate      | `evals/README.md`                                         |
| Author a live case                            | `evals/lib/buildLiveCase.ts:buildLiveCase`               |
| Author a mock case                            | `evals/lib/mockProvider.ts` + `evals/cases/additive/triplet-demo-extend.mock.eval.ts` |
| Add an invariant predicate                    | `evals/lib/assertions.ts:ScoreInvariants`               |
| Add a visual baseline                         | `scripts/capture-visual-baselines.ts` + `evals/cases/visual/*` |
| Run anything                                  | `package.json` scripts: `eval:mock` / `eval:smoke` / `eval:visual` / `eval:live` |

## Key files

### Harness library (`evals/lib/`)

| Path | Role |
| ---- | ---- |
| `evals/lib/assertions.ts` | `ScoreInvariants` interface + `assertScoreInvariants(actual, expected, initialScore): InvariantFailure[]`. Asserts on the **applied** Score. Predicates: `measureCount`, `keyPreserved`, `meterPreserved`, `titlePreserved`, `firstNMeasuresIdentical` (per-measure `hashMeasure` compare), `appliedOpsContain`, `replacementBlocked`. Accumulates *all* failures into an array (callers do `expect(...).toEqual([])`) rather than throwing on first. |
| `evals/lib/buildLiveCase.ts` | `buildLiveCase(spec: LiveCaseSpec)` — the skeleton every `*.live.eval.ts` calls. Owns `describe.skipIf` gating, forces `SL_NEW_TOOL_DISPATCH=1` in `beforeAll` (restores in `afterAll`), runs `assertScoreInvariants` + `spec.extraAssertions`, does per-model-SHA baseline bookkeeping, throws `[REGRESSION] …` for regressions vs a plain error for new failures, and emits a per-case summary row. Re-exports `summarizeLiveResults`. |
| `evals/lib/liveRunner.ts` | `runLiveCase(input, options)` hits the **real** orchestrator (`run` from `@/lib/orchestrator`). Retries `UpstreamError` / `RateLimitedError` with exponential backoff (default 3 attempts, 250 ms base). Returns `kind:'ok'` vs `kind:'infra'`. Emits a stderr cache-hit warning when ratio < 0.8. `extractTelemetry` pulls `model`/`usage` off the outcome union permissively. `summarizeLiveResults` aggregates. `SKIP_LIVE_EVAL_TOKEN='[skip-live-eval]'` + `isSkippedByCommitMessage()`. |
| `evals/lib/mockProvider.ts` | Canned Anthropic SDK response builders: `toolUseResponse(score, opts)` (single `tool_use` block + `usage`) and `classifyResponse(classification, opts)`. The eval file owns the hoisted `vi.mock('@anthropic-ai/sdk')`; this only produces payloads. Mirrors the production **wire** shape — `AnthropicProvider.toolCall` reads `id`/`name`/`input` off the first `tool_use` block and `usage.cached_input_tokens`. |
| `evals/lib/baselines.ts` | Per-model-SHA regression ledger at `evals/baselines/eval-scores.json` (ships `{}`). `loadBaselines` / `saveBaselines` / `detectRegression` / `recordLiveResult`. `EvalCaseStatus = new \| still-passing \| still-failing \| regression \| recovery`. `detectRegression` does **not** mutate; `recordLiveResult` mutates in memory (caller persists). `DEFAULT_BASELINES_PATH='evals/baselines/eval-scores.json'`. |
| `evals/lib/pricing.ts` | `PRICING` table (USD per 1M tokens) + `estimateCostUsd(model, input, output, cached?)`. Cached billed at ~0.1× input. Unknown model → returns `0` + stderr warning (never blocks). Known: `claude-haiku-4-5` ($1/$5), `claude-sonnet-4-6` ($3/$15), `claude-opus-4-7` ($5/$25), plus dated aliases. |
| `evals/lib/svgPathDistance.ts` | Pure visual metric. `pathDistance(svgA, svgB): PathDistanceResult{metric ∈ [0,1]}`. `extractPathDs` / `extractSvgSize` / `walkPath`. Normalizes coords to each SVG's own viewBox (falls back to width/height, then 1.0). Walks **pen positions only** — bezier control points are ignored. Tested by `tests/unit/eval-lib/svgPathDistance.test.ts`. |
| `evals/lib/renderScoreSvg.ts` | `renderScoreSvg(score): Promise<string>` → `scoreToAbc` then `renderAbcSvg` via abcjs into a jsdom `<div>`, returns `svg.outerHTML`. `renderAbcSvg(abc)` is the raw-ABC entry. Requires a DOM. |
| `evals/lib/jsdomShim.ts` | Shared `getBBox` polyfill (jsdom has no SVG layout). `installGetBBoxPolyfill()` patches ambient globals (called by `tests/setup.ts`); `installGetBBoxPolyfillOn(win)` patches a window-local jsdom (called by `scripts/capture-visual-baselines.ts`). `makeBBox()` returns a stable `{width:100, height:20}`. Kept in **one** place so the two callers can't drift. |

### Configs & scripts

| Path | Role |
| ---- | ---- |
| `vitest.config.ts` | Default unit/integration config (jsdom, globals, `tests/setup.ts`). Excludes `node_modules` / `dist` / `.next` / `tests/e2e` / `.claude`. Does **not** match eval files. |
| `vitest.evals.config.ts` | MOCK tier. `include: evals/**/*.mock.eval.ts`, jsdom, `exclude: ['tests/**']`. Deterministic, zero spend. |
| `vitest.evals.smoke.config.ts` | SMOKE tier. `include: evals/**/*.smoke.eval.ts`, jsdom. Each file self-gates on `RUN_SMOKE_EVALS=1` + `ANTHROPIC_API_KEY`. |
| `vitest.evals.visual.config.ts` | VISUAL tier. `include: evals/**/*.visual.eval.ts`, jsdom (abcjs needs a DOM). Deterministic. |
| `vitest.evals.live.config.ts` | LIVE tier. `include: evals/**/*.live.eval.ts`, `environment:'node'` (Anthropic SDK refuses browser-like envs), `passWithNoTests: true` so `eval:live` without `RUN_LIVE_EVALS=1` is a clean zero-exit no-op. |
| `vitest.eval.config.ts` | LEGACY single-tier surface. `include: tests/eval/**/*.eval.ts` (`classifier`/`copyright`/`local`/`operations`). Run via `pnpm test:eval`. Marked in config comments for migration into `evals/` and retirement — do **not** add new cases here. |
| `playwright.config.ts` | E2E config. `testDir: ./tests/e2e`, chromium only, `retries: 2` when the `CI` env var is set, `webServer` runs `pnpm dev` on `:3000` with `SESSION_SECRET` (32-byte test secret) + `SL_INSECURE_COOKIE_OK=1`. Without the secret, `getRequestUser` (the identity resolver) makes routes return 500. |
| `tests/setup.ts` | Global vitest setup (every config's `setupFiles`). Imports `@testing-library/jest-dom/vitest`, sets `ORCHESTRATOR_LOG_SILENT=1` + `ORCHESTRATOR_ENABLED='false'`, installs the `getBBox` polyfill. |
| `tests/factories/db.ts` | `makeTestDb()` → fresh in-memory better-sqlite3 + drizzle, migrated from `./drizzle`, `foreign_keys = ON`. No shared state. |
| `tests/factories/testEnv.ts` | `TEST_USER_ID`, `installTestDb()` (per-test fresh DB seeded with the test user via `setDbForTesting`), `mockAuthSession()` mocking `@/lib/auth/session` — `getRequestUser`/`getExistingRequestUser` (plus legacy `getOrCreateUserId`/`getExistingUserId`) all resolving to `TEST_USER_ID`. |
| `tests/e2e/fixtures.ts` | Extended Playwright `test` that `goto('/')` + collapses the Debug panel per test. `importAbc(page, abc)` drives the Import modal to seed deterministic scores without the LLM (waits for `data-startchar` tagging). |

## Core concepts & data flow

### The four tiers

File suffix maps 1:1 to a config, so you cannot accidentally run a live case
from `eval:mock`.

| Tier   | Script         | Config                          | Suffix             | Env / spend                          |
| ------ | -------------- | ------------------------------- | ------------------ | ------------------------------------ |
| Mock   | `eval:mock`    | `vitest.evals.config.ts`        | `*.mock.eval.ts`   | jsdom, `vi.mock` SDK, **zero** spend |
| Smoke  | `eval:smoke`   | `vitest.evals.smoke.config.ts`  | `*.smoke.eval.ts`  | jsdom, real Haiku+Sonnet, ~$0.01     |
| Visual | `eval:visual`  | `vitest.evals.visual.config.ts` | `*.visual.eval.ts` | jsdom, deterministic abcjs, **zero** |
| Live   | `eval:live`    | `vitest.evals.live.config.ts`   | `*.live.eval.ts`   | **node**, real Anthropic, on demand  |

Case inventory at this commit (under `evals/cases/`):

- **Mock (2)**: `additive/triplet-demo-extend.mock.eval.ts` (the canonical M3.5
  repro), `destructive/wholesale-replace.mock.eval.ts` (replacement-gate).
- **Smoke (4)**: `classifier-compose` / `classifier-converse` /
  `classifier-edit-score-level` (Haiku `classify()`) +
  `dispatch-extend-composition` (full `run` on the dispatch path).
- **Visual (3)**: `bach-invention-1`, `chopin-nocturne-op9-no2`,
  `mozart-eine-kleine-nachtmusik`.
- **Live (12 files)**: 10 under `additive/` (`triplet-demo-extend-turnaround`,
  `turnaround-after-PAC`, `SATB-countermelody`, `modal-transform`,
  `augmentation-double-duration`, `harmonize-bach-style`,
  `interpolate-mid-phrase`, `extend-across-meter-change`,
  `add-B-section-key-change`, `extend-tied-whole-note-ending`) + 2 under
  `destructive/` (`lowercase-roman-ambiguity`, `multi-voice-piano-hand-division`).
  The README narrates these as "the 12", matching the 12 files on disk.

### Applied-state invariants, not LLM JSON

`assertScoreInvariants` evaluates against `actual.afterScore` — the Score after
the handler and any ops it emitted have run — because that is what the user
sees. `firstNMeasuresIdentical` compares per-measure `hashMeasure` (from
`@/lib/music/scoreDiff`) for byte-identity rather than deep JSON equality, so it
survives event-id reshuffling yet catches silent articulation/accidental drift
on "preserved" bars. `appliedOpsContain` is typed as `string` (not
`Operation['kind']`) so a `.fails` case can reference an op kind that doesn't
exist yet and intentionally fail until it lands.

### Mock tier flow

```
*.mock.eval.ts (hoisted vi.mock('@anthropic-ai/sdk'))
  beforeEach: vi.stubEnv ORCHESTRATOR_ENABLED='true', ANTHROPIC_API_KEY, EVAL_SILENT='1'
  anthropicCreateMock.mockResolvedValueOnce( dispatch tool_use )   ← mockProvider.toolUseResponse / classifyResponse
                     .mockResolvedValueOnce( emit_appended_bars )
  run() from @/lib/orchestrator
  assertScoreInvariants({ afterScore, appliedOps, requiresConfirmation }, expected, initialScore)
  expect(failures).toEqual([])
```

### Live tier flow

```
buildLiveCase(spec)
  describe.skipIf( RUN_LIVE_EVALS!=1 || no ANTHROPIC_API_KEY || (expensive && RUN_LIVE_FULL!=1) )
  beforeAll: stash + force SL_NEW_TOOL_DISPATCH=1; runLiveCase(...)
        └─ runOrchestrator (real Anthropic)  →  retry UpstreamError/RateLimitedError (3×, 250ms·2^n)
        └─ extractTelemetry → estimateCostUsd → cache-hit warn (<0.8)
        └─ returns kind:'ok'{outcome,…tokens} | kind:'infra'{lastError,attempts}
  it: kind==='infra' ? warn + return         (exit 78 via outer driver)
      no score        ? throw / soft-warn
      else assertScoreInvariants + spec.extraAssertions(result, runner)
           detectRegression(baselines, model, id, pass) ── regression? → throw '[REGRESSION] …' (exit 79)
           recordLiveResult(baselines, …)                ── else        → throw '<id> …'         (exit 1)
  afterAll: restore SL_NEW_TOOL_DISPATCH; emit [eval row] summary line
```

### Visual tier flow

```
<name>.score.json ─► renderScoreSvg (scoreToAbc → abcjs into jsdom div, getBBox polyfilled)
                  ─► pathDistance( <name>.baseline.svg , rendered )
                  ─► expect(metric).toBeLessThan(THRESHOLD)   // THRESHOLD = 0.02 in the case
```

`pathDistance` extracts every `<path d>` in order, walks each to a polyline of
absolute pen positions, normalizes both sides to their own viewBox `[0,1]`
space, sums per-vertex euclidean deltas, and divides by the longer path's
length. Unmatched paths count fully as drift. Bezier control points are
**ignored** (only endpoints recorded), so v1 is blind to subtle curve
regressions with identical endpoints — a deliberate limitation documented in
the module header.

### Per-model-SHA regression ledger

`evals/baselines/eval-scores.json` is keyed `{ <model-sha>: { <case-id>:
{ firstSeen, lastPassed, lastResult, failures } } }`. `detectRegression`
classifies a result *before* the entry is updated; `recordLiveResult` then
mutates the in-memory copy (the caller persists it). Exit-code contract the
live driver emits:

| Exit | Meaning                                              | Source                              |
| ---- | --------------------------------------------------- | ----------------------------------- |
| 0    | all cases passed                                    | vitest                              |
| 1    | new failure (no prior pass on this model SHA)        | `buildLiveCase` plain `throw`       |
| 78   | infra-only (`UpstreamError`/`RateLimitedError`)      | `runLiveCase` kind:`'infra'` (outer driver) |
| 79   | regression (previously-passing case now fails)       | `[REGRESSION]` prefix on the throw  |

## Invariants & gotchas

- **DOC DRIFT — visual threshold.** `evals/README.md` header says "Threshold:
  0.05", but the visual case code uses `THRESHOLD = 0.02`
  (`evals/cases/visual/bach-invention-1.visual.eval.ts:24`) and
  `svgPathDistance.ts` confirms the threshold tightened to 0.02 once coords were
  normalized to viewBox space. **Trust the code (0.02).**
- **Live config is `environment:'node'`, not jsdom.** The Anthropic SDK refuses
  to run in a browser-like env. Visual/mock/smoke stay jsdom because abcjs needs
  a DOM. Do not "normalize" the live config to jsdom.
- **`SL_NEW_TOOL_DISPATCH` is forced to `'1'` in two places** as
  defense-in-depth even though it has been default-on since M3.5-PR-6:
  `buildLiveCase` `beforeAll` (restored in `afterAll`) and the
  `dispatch-extend-composition` smoke `beforeAll`.
  `dispatchTool` / `cadenceAtBoundary` only populate when
  `isNewToolDispatchEnabled()` is true.
- **`tests/setup.ts` sets `ORCHESTRATOR_ENABLED='false'` globally.**
  Orchestrator-specific tests/evals must opt in via
  `vi.stubEnv('ORCHESTRATOR_ENABLED','true')` — the mock eval does exactly this
  in `beforeEach`. Forgetting it silently exercises the legacy path.
- **`passWithNoTests:true` is ONLY on the live config.** It makes `eval:live` a
  zero-exit no-op when `RUN_LIVE_EVALS` is unset (all cases `describe.skipIf`
  out). The other tiers do not set it.
- **`mockProvider.toolUseResponse` mirrors the production WIRE format**
  (`content[]` with `tool_use`, `usage.cached_input_tokens`) — `toolCall` reads
  `id`/`name`/`input` off the **first** `tool_use` block. Reorder at your peril.
- **`estimateCostUsd` and the cache-hit warning never fail a test.** They log to
  stderr only (suppressed by `EVAL_SILENT=1`). Unknown models silently cost 0.
  Telemetry is informational: a missing `usage` field means "no signal", not
  "harness broken".
- **Two known-flaky tests** (`tests/integration/api-chat-fork.test.ts` and a
  midiToScore octave-2-vs-4 case) are kept OUT of eval runs by every eval
  config's `exclude: ['tests/**']`, but plain `pnpm test` may still surface them.
- **`pnpm test` excludes `**/eval/**` AND `**/evals/**` AND `**/tests/e2e/**`,**
  so neither the legacy `tests/eval/` nor the new `evals/` dir runs under plain
  `test` — each needs its dedicated config script.
- **Two parallel eval surfaces exist.** The NEW `evals/` tree (4 tiers, this
  subsystem) and the LEGACY `tests/eval/` tree
  (`classifier`/`copyright`/`local`/`operations.eval.ts`, run via
  `vitest.eval.config.ts` + `pnpm test:eval`). The latter is marked for
  migration and retirement; don't add cases there.

## How to extend / common tasks

**Add an invariant.** Add an optional field to `ScoreInvariants`
(`evals/lib/assertions.ts`) and a guarded `failures.push({...})` block in
`assertScoreInvariants`. Missing fields are not checked, so existing cases are
unaffected. Prefer `firstNMeasuresIdentical` over JSON equality for "preserved"
contracts — it survives event-id reshuffling.

**Add a mock case.** Drop `evals/cases/<group>/<case>.mock.eval.ts`. Hoist
`vi.mock('@anthropic-ai/sdk', …)` at module top, dynamic-import
`@/lib/orchestrator` *after* the mock, `vi.stubEnv('ORCHESTRATOR_ENABLED','true')`
in `beforeEach`, queue dispatch + handler payloads via
`mockProvider.toolUseResponse` / `classifyResponse`, then
`expect(assertScoreInvariants(...)).toEqual([])`.

**Add a live case.** Drop `evals/cases/<group>/<case>.live.eval.ts` that calls
`buildLiveCase({ id, title, initialScore, userText, expected, … })`. Set
`expensive:true` for multi-voice/long-context cases (gated additionally behind
`RUN_LIVE_FULL=1`); `softAssertions:true` for diagnostics that should log but
never hard-fail; `extraAssertions(result, runner)` to check
`dispatchTool`/`cadenceAtBoundary`/`warnings`.

**Add a visual baseline.** Add `<name>.score.json` and `<name>.baseline.svg`
under `evals/baselines/visual/`, plus a `<name>.visual.eval.ts` modeled on
`bach-invention-1.visual.eval.ts`. Regenerate after a deliberate renderer change
with `pnpm eval:baselines:capture` (`tsx scripts/capture-visual-baselines.ts`),
then eyeball both SVGs before committing.

**The "first failing repro" pattern.** When a production bug surfaces, the FIRST
PR lands a case marked `it.fails(...)` / `test.fails(...)` so the suite stays
green; the fix-PR flips it to a regular `it(...)`.
`triplet-demo-extend.mock.eval.ts` is the
canonical example.

## Testing

- `tests/unit/eval-lib/svgPathDistance.test.ts` — pins the `pathDistance` metric.
- `tests/unit/**` — abc, auth, chat, components, db, editor, llm, music,
  orchestrator, providers, scripts, shared, transport.
- `tests/integration/**` — `api-chat*`, `api-import*`, `api-sessions*`,
  orchestrator phase0–3, confirm-replacement, fork, versions-chain.
- `tests/e2e/**` — Playwright: chat-history-panel, chord-building, drag-tagging,
  score-reveal, smoke. Seed via `importAbc` from `tests/e2e/fixtures.ts`.
- `tests/eval/**` — LEGACY tier (`classifier`/`copyright`/`local`/`operations`).

Run: `pnpm test` (unit+integration, excludes evals + e2e) · `pnpm test:e2e` ·
`pnpm eval:mock` / `eval:smoke` / `eval:visual` / `eval:live` · `pnpm test:eval`
(legacy).

## Related files / See also

- `evals/README.md` — the canonical narrative (cases, pass-rate, cost, policies).
- `src/lib/orchestrator/README.md` — the system under test; the dispatch /
  preservation-verify / replacement-gate architecture these evals pin.
- `src/lib/music/scoreDiff.ts` — `hashMeasure`, used by `firstNMeasuresIdentical`.
- `src/lib/music/scoreToAbc.ts` — drives the visual tier render.
- `scripts/capture-visual-baselines.ts` — baseline regeneration (the second
  `jsdomShim` consumer).
- `scripts/trim-orchestrator-turns.ts` — `pnpm trim:orchestrator-turns` (90-day
  TTL on `orchestrator_turns`); run on demand.
