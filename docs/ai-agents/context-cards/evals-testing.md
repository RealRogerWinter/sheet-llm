---
title: Evals & Testing — Context Card
subsystem: evals-testing
audience: [ai-agent, contributor]
status: current
last_verified: 2026-06-04
verified_against: 4fcabd9
source_paths:
  - evals/lib/assertions.ts
  - evals/lib/buildLiveCase.ts
  - evals/lib/liveRunner.ts
  - evals/lib/mockProvider.ts
  - evals/lib/baselines.ts
  - evals/lib/pricing.ts
  - src/lib/billing/pricing.ts
  - evals/lib/svgPathDistance.ts
  - evals/lib/renderScoreSvg.ts
  - evals/lib/jsdomShim.ts
  - tests/setup.ts
  - tests/factories/testEnv.ts
  - tests/e2e/fixtures.ts
  - vitest.evals.live.config.ts
  - vitest.evals.visual.config.ts
related:
  - orchestrator
  - score-data-model
  - score-to-abc
  - abcjs-render
---

Four-tier eval harness (mock/smoke/visual/live) pinning orchestrator contracts on the **applied Score**, plus vitest unit+integration and Playwright e2e. Eval tiers run locally / on demand.

## Key files
- `evals/lib/assertions.ts` — `assertScoreInvariants(actual, expected, initialScore): InvariantFailure[]`; accumulates ALL failures.
- `evals/lib/buildLiveCase.ts` — `buildLiveCase(spec)` skeleton; gating, baseline bookkeeping, `[REGRESSION]` throw.
- `evals/lib/liveRunner.ts` — `runLiveCase` hits real `run` from `@/lib/orchestrator`; retry backoff; `kind:'ok'|'infra'`.
- `evals/lib/mockProvider.ts` — `toolUseResponse`/`classifyResponse` canned wire payloads (eval file owns `vi.mock`).
- `evals/lib/baselines.ts` — per-model-SHA ledger `evals/baselines/eval-scores.json`; `detectRegression`/`recordLiveResult`.
- `evals/lib/pricing.ts` — re-exports the canonical cost model in `src/lib/billing/pricing.ts`: `PRICING` (cache-read + cache-write rates, incl. Opus 4.8), the lenient `estimateCostUsd` (unknown model → 0 + warn, never blocks evals), and the strict `billableCostUsd` (throws on an unpriced model so a customer debit never silently bills $0).
- `evals/lib/svgPathDistance.ts` — `pathDistance(a,b)→metric∈[0,1]`; viewBox-normalized, bezier ctrl pts ignored.
- `evals/lib/renderScoreSvg.ts` — `renderScoreSvg(score)` = scoreToAbc→abcjs→jsdom; needs DOM.
- `evals/lib/jsdomShim.ts` — `getBBox` polyfill, ONE place; `installGetBBoxPolyfill()` + `…On(win)`.
- `tests/setup.ts` — global setup; `ORCHESTRATOR_ENABLED='false'`, `ORCHESTRATOR_LOG_SILENT='1'`, polyfill.
- `tests/factories/testEnv.ts` — `TEST_USER_ID`, `installTestDb()`, `mockAuthSession()`.
- `tests/e2e/fixtures.ts` — extended `test` + `importAbc(page, abc)` (no-LLM seeding).

## Tiers (suffix ↔ config, 1:1)
`*.mock.eval.ts`→`vitest.evals.config.ts` (jsdom, vi.mock, $0) · `*.smoke.eval.ts`→smoke (real Haiku+Sonnet ~$0.01) · `*.visual.eval.ts`→visual (jsdom, deterministic) · `*.live.eval.ts`→live (**node**, real Anthropic, on demand).

## Exit codes (live driver)
0 pass · 1 new failure · 78 infra (Upstream/RateLimited after retry) · 79 regression (`[REGRESSION]` prefix).

## Env flags + defaults
- `RUN_LIVE_EVALS` unset → live cases skipIf out. `RUN_LIVE_FULL` unset → `expensive:true` cases skip.
- `RUN_SMOKE_EVALS` unset gates the smoke step; set it yourself to run smoke evals (`pnpm eval:smoke`). `ANTHROPIC_API_KEY` required for smoke/live.
- `SL_NEW_TOOL_DISPATCH` default-ON; forced `'1'` in buildLiveCase/smoke `beforeAll` (defense in depth).
- `ORCHESTRATOR_ENABLED` `'false'` (tests/setup.ts) — orchestrator tests opt in via `vi.stubEnv(...,'true')`.
- `EVAL_SILENT='1'` suppresses all stderr; `EVAL_SUMMARY_ONLY='1'` totals only; `EVAL_DEBUG_SKIP='1'` logs skips.
- `SESSION_SECRET` 32-byte test secret + `SL_INSECURE_COOKIE_OK='1'` for Playwright dev server (else routes 500).

## Gotchas
- DOC DRIFT: README says visual threshold 0.05; **code uses 0.02** (viewBox-normalized). Trust code.
- Live config is `environment:'node'` (SDK refuses browser-like env) — do NOT switch to jsdom.
- `passWithNoTests:true` is ONLY on live config (zero-exit no-op without `RUN_LIVE_EVALS`).
- `pnpm test` excludes `**/eval/**`, `**/evals/**`, `**/tests/e2e/**` — each needs its own script.
- Assertions are on `afterScore` (applied state), NOT LLM JSON; `firstNMeasuresIdentical` uses `hashMeasure`.
- LEGACY `tests/eval/` (classifier/copyright/local/operations) runs via `pnpm test:eval` — marked for retirement; don't extend.

## When editing X, also update Y
- `ScoreInvariants` (assertions.ts) → add the matching `failures.push` block + `ActualOutcome` field.
- `mockProvider.toolUseResponse` wire shape → must match what `AnthropicProvider.toolCall` reads (first `tool_use` block id/name/input).
- abcjs/renderer change → regenerate visual baselines via `pnpm eval:baselines:capture`; if `getBBox` shim changes, both `tests/setup.ts` and `scripts/capture-visual-baselines.ts` consume `jsdomShim.ts`.
- New live case bypassing `buildLiveCase` → set `SL_NEW_TOOL_DISPATCH=1` yourself.
- New model in `pricing.ts:PRICING` when bumping `estimateCostUsd` (else silent $0).

## Related cards
`orchestrator` · `score-data-model` · `score-to-abc` · `abcjs-render`
