# SHE-15 — Running smaller models: Groq cost/reliability evaluation

- **Issue:** [SHE-15](https://linear.app/sheet-llm/issue/SHE-15) — "(investigate) Running smaller models"
- **Date:** 2026-06-09
- **Status:** Design approved; implementation in progress
- **Budget ceiling:** **$15** total live API spend (Anthropic baseline + all Groq runs). Hard stop at a **$12** safety line.

## 1. Problem

Hosted sheetllm.com runs every `/api/chat` turn through Anthropic (Sonnet 4.6 for the
dispatcher + edit handlers, Haiku 4.5 for the legacy classifier). We want to know the
**cheapest Groq-hosted model that can reliably handle typical user requests** — to cut
inference cost on the hosted demo without degrading the product.

## 2. Goal & success criterion

Produce a **cost × reliability comparison** of candidate Groq models against the current
Sonnet 4.6 baseline, run through the existing eval harness, and recommend the cheapest
model that meets the reliability bar (or report that none do, with the failure profile).

**Reliability bar (locked): per-case parity.** A model is "ready" only if it passes
**every** eval case the Sonnet 4.6 baseline passes — zero regressions on the shared set.
Scoring is the harness's existing **deterministic** assertions; there is no LLM judge.

**Deliverable:** a per-model table — cases passed (vs Sonnet), $/case, $/full-run, median
latency — plus a written "where each model breaks" analysis and a recommendation.

## 3. Locked decisions (from the design interview)

1. **Candidate models — cheapest-first:** `llama-3.1-8b-instant`, `openai/gpt-oss-20b`,
   and a small Qwen. Exact live model IDs **and current Groq prices verified before any
   spend**. Add one rung up (e.g. `gpt-oss-120b` / `llama-3.3-70b`) only if all three fail
   badly, to locate where reliability begins.
2. **Routing — full Groq stack, isolated:** `PROVIDER_SMALL/MEDIUM/LARGE=groq` and
   `PROVIDER_FALLBACK=groq` so a Groq failure is **not** silently rescued by Anthropic
   (which would contaminate the reliability numbers).
3. **Reliability bar — per-case parity** vs the measured Sonnet 4.6 baseline.
4. **Scope — full parity:** the experiment must exercise score-edits **and** converse
   (music-theory Q&A) **and** multi-turn refinement on Groq. This requires building out the
   OpenAI-compatible provider's streaming and history support (today it is single-shot
   tool-call only).

## 4. Non-goals

- Ollama/local models (the abstraction supports it; out of scope for this pass).
- Changing production provider routing — production stays Anthropic. All Groq routing is
  experiment-only (env-driven) and inert by default.
- Replacing the deterministic eval scoring with an LLM judge.
- Tuning prompts per model. We measure the models as the orchestrator drives them today.

## 5. Current-state findings (grounding for the work)

Verified against the codebase (file:line current as of `origin/main` `90d4c2f`):

- **Provider abstraction** (`src/lib/providers/`): `selectProvider(tier, chatId)`
  (`select.ts`) routes `small|medium|large` → `anthropic|groq|ollama` via
  `PROVIDER_SMALL/MEDIUM/LARGE` (+ `PROVIDER_FALLBACK`); `registry.ts` maps Groq
  small→`openai/gpt-oss-20b`, medium/large→`openai/gpt-oss-120b`. Selection is the only
  switch — there is **no** `SL_PROVIDER`/`SL_MODEL`/`GROQ_MODEL` flag.
- **Dispatcher is a single forced tool.** `toolDispatch.ts:356-438` issues one tool
  `dispatch_to_handler` (flat schema: a `tool` enum + hoisted optional args) via
  `callWithFailover(... toolChoice:'required' ...)`. The docstring at `toolDispatch.ts:328-343`
  is **stale** — it narrates an abandoned `tool_choice:'auto'` design. Because it is a
  single forced tool, `OpenAICompatibleProvider.toolCall`
  (`tool_choice:{type:'function',function:{name}}`, `openaiCompatible.ts:93`) can serve it.
  **→ Groq can drive the dispatcher.**
- **Typical request = 2 live calls:** dispatcher (medium, `max_tokens:300`) + one handler
  (medium, `max_tokens:8000`), occasionally +1 on a `ValidationError` retry. Converse =
  dispatcher + one streaming call. The 5 score-mutating handlers do **not** pass `history`;
  converse + refinement do.
- **Eval harness** (`evals/`): live cases call the **real orchestrator**
  (`buildLiveCase`→`liveRunner.ts:107`→`run`), so `PROVIDER_*` env routes the in-eval path.
  Scoring is deterministic (`assertScoreInvariants`, `evals/lib/assertions.ts:82` +
  preservation + `dispatchTool` checks). Baselines ledger
  (`evals/baselines/eval-scores.json`) is `{}`, keyed by effective model id. ~12 live cases
  (10 default + 2 `expensive`). README claims Sonnet ≈ 6/10 hard cases (to be measured).
- **Groq path is incomplete (PR-C scaffolding):**
  - No Groq rows in `src/lib/billing/pricing.ts:35-46` → `estimateCostUsd` returns **$0**
    for Groq → cost half of the deliverable is dead until fixed.
  - `openaiCompatible.ts` never reads `finish_reason` → a `max_tokens` cut → invalid JSON →
    `ProviderSchemaError` (should be `OutputTruncatedError`). Groq default `max_tokens` is
    only **2000** (`:81`) vs Anthropic 8000.
  - Refusals (text, no tool_call) → `ProviderSchemaError` (`:133-138`), not
    `ProviderRefusalError`.
  - `buildMessages` **throws** on `options.history` (`:194-199`) — multi-turn refinement
    hard-fails on Groq.
  - **No `textStream`** → converse (`answer_question`, `converse.ts`) is unservable on Groq.
  - `recordProviderCall` is never called by the OpenAI-compatible path → Groq spend is
    invisible to the request usage meter.
  - The eval gate (`buildLiveCase.ts:79-81`) hard-requires `ANTHROPIC_API_KEY`, even for a
    Groq-only run.

## 6. Architecture & data flow (experiment)

```
live eval case (PROVIDER_*=groq, GROQ_API_KEY, isolated fallback)
  → buildLiveCase → liveRunner.runLiveCase → run() (real orchestrator)
      → selectProvider(tier) → GroqProvider (OpenAICompatibleProvider)
          → POST api.groq.com/openai/v1/chat/completions
      → deterministic assertions (preservation + invariants + dispatchTool)
      → telemetry { model, usage } → estimateCostUsd (now Groq-aware)
  → model-matrix driver aggregates per-case pass/fail + cost
  → cost × reliability report
```

## 7. Work breakdown — 3 reviewed PRs

Each PR: scoped, off latest `main`, **code-review + security-review** (findings posted to
the PR, fixed), CI (typecheck/test) green, then merge. All verified via unit tests + mock
evals — **zero API spend** during engineering.

### PR1 — Provider correctness & cost plumbing (`feat/she-15-provider-correctness`)
- `openaiCompatible.ts`: read `finish_reason`; on `length` throw `OutputTruncatedError`
  (carrying `maxTokens`/`outputTokens`) so truncation does **not** masquerade as a schema
  failure or trip the degradation ladder. Add `finish_reason` to the response type.
- `openaiCompatible.ts`: classify an OpenAI/Groq `message.refusal` (or content-only, no
  tool_call, recognizable refusal) as `ProviderRefusalError`.
- `openaiCompatible.ts`: call `recordProviderCall(model, usage)` on success + truncation so
  Groq spend lands in the request usage meter (parity with `anthropic.ts:203,240`).
- `src/lib/billing/pricing.ts`: add rows for the candidate Groq models (verified live
  prices). Inert for production billing (production is Anthropic-only).
- `registry.ts`: add registry entries for the cheapest-first candidate models.
- Tests: extend `tests/unit/providers/openaiCompatible.test.ts` — truncation→`OutputTruncatedError`,
  refusal→`ProviderRefusalError`, usage metering, pricing lookups. Fix the existing
  refusal-misclassification test that codified the bug.

### PR2 — Groq parity transport (`feat/she-15-groq-parity`)
- `openaiCompatible.ts`: implement `textStream` (Groq streaming chat-completions → the
  `TextStreamEvent` union: `message-start` / `text-delta` / `message-stop` with `finalText`,
  `stopReason`, `usage`). Honor `abortSignal`/`outputTokenBudget`/`streamDeadlineAt` as the
  Anthropic path does. → unblocks **converse** on Groq.
- `openaiCompatible.ts`: implement `buildMessages` history-mode — convert `ChatMessage[]`
  (incl. tool_use/tool_result blocks) to OpenAI `messages[]`. → unblocks **multi-turn
  refinement** on Groq.
- Tests: streaming event sequence, abort/deadline, history conversion round-trips
  (mock fetch; no live calls).

### PR3 — Eval harness extension & spend-guarded driver (`feat/she-15-eval-matrix`)
- `buildLiveCase.ts`: relax the gate — allow a run when the routed provider's key is present
  (Groq-only runs no longer require `ANTHROPIC_API_KEY`).
- New **model-matrix driver** (`scripts/` + `evals/lib/`): run the live suite once per
  candidate config, capture per-case pass/fail + telemetry, emit the cost × reliability
  table (markdown + JSON).
- **Spend guard:** pre-run cost estimate from token counts; a cumulative cross-run tracker;
  a **hard stop** that aborts before total estimated spend crosses **$12** and alerts.
- Add converse + multi-turn refinement eval cases so full parity is actually exercised.

## 8. Eval methodology

- **Baseline first:** run the suite on Sonnet 4.6 (current stack), record per-case pass/fail
  into `evals/baselines/eval-scores.json` and capture cost/latency.
- **Per model (full Groq stack, isolated):** run the same suite; a case "passes" iff its
  failures array is empty (existing semantics). Compare **per-case** to the Sonnet baseline.
- **Parity verdict:** model is "ready" iff it passes every case Sonnet passes.
- **Cost:** from per-call `usage` × the (now Groq-aware) pricing table. Note Anthropic gets
  a warm prompt-cache discount (0.1× input on hits) that Groq does not — the report
  normalizes for this so the comparison is honest.

## 9. Run plan & sequencing (front-load signal)

1. Merge PR1 (correctness + pricing).
2. **Ping user for API keys.** Run Sonnet baseline → record. Then run the **score-edits
   subset** on the cheapest models (fast, pennies) for an early reliability signal.
3. Build/merge PR2 (streaming + history) and PR3 (driver + new cases).
4. Full-parity runs across all candidates → report.
5. If the cheapest models fail the basic score-edits, report immediately and reassess
   before spending on full-parity runs.

Spend is tracked after every run; halt + alert if a run would cross the $12 line.

## 10. Budget & spend control

- Sonnet full live run ≈ $0.10 warm / $0.25 cold (README). Groq gpt-oss/8B are ~1–2 orders
  of magnitude cheaper. Even ~4 models × repeated runs stays well under $2 of the $15 cap.
- Controls: per-run pre-estimate, cumulative tracker, hard stop at $12, and a running-spend
  report after each model. No live call before the user provides keys.

## 11. Risks & mitigations

- **Cheap models fail many cases** (expected) → that *is* a finding; per-case parity makes
  it explicit. Front-loaded score-edits run surfaces it early.
- **Silent Anthropic failover masking Groq failures** → `PROVIDER_FALLBACK=groq` isolates.
- **Truncation read as unreliability** → PR1 `finish_reason` handling + explicit `maxTokens`.
- **Editing shared billing `pricing.ts`** → additive Groq rows only; `billableCostUsd` stays
  correct; security-review on the PR.
- **gpt-oss reasoning channel** quirks (tool call in a non-standard slot) → watch first runs;
  handle in PR2 if observed.

## 12. Deliverables

1. Three merged, reviewed PRs (provider correctness, parity transport, eval driver).
2. A committed cost × reliability report + recommendation.
3. SHE-15 updated with the verdict (cheapest reliable model, or the failure profile).
