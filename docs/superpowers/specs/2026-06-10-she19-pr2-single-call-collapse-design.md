# SHE-19 PR2 — Free-tier all-6 single-call collapse

**Status:** design approved (brainstorm) — pending spec review → plan → execute
**Issue:** [SHE-19](https://linear.app/sheet-llm/issue/SHE-19) (PR1 merged as #100 / `41cbc09`)
**Branch:** `she-19-pr2-single-call-collapse` (worktree `/home/claudeuser/sl-wt/she-19-pr2`, off `origin/main` 41cbc09)
**Date:** 2026-06-10

## Goal

On the **free tier only**, collapse the edit path's two LLM calls (dispatch → handler) into **one** Haiku tool-use call that both picks the action AND emits its final operations in a single round-trip. This removes the per-edit-turn dispatch call — the ~$2.5/1k cost lever identified in SHE-15. **Pro tier keeps the existing 2-call routing path unchanged**; all multi-model routing code stays intact behind the mode flag (future: pro routing, cheap-executor split, SHE-20 LoRA).

**Breadth (decided):** the single call carries the **full discriminated union of all 6 actions** — `edit_intra_measure`, `region_replace`, `insert_measures`, `extend_composition`, `regenerate_all`, `answer_question` — each emitting its final operations. Nothing falls back to 2-call on the happy path. (A hard-failure fallback to the 2-call path is retained as a safety net — a malformed single call must not drop the turn.)

## Where the cost actually is (verified)

- **Fresh free-tier generation is already single-call** — `src/lib/orchestrator/index.ts` (~L741, `runGenerateBounded`): free tier + no `editedScore` → no classifier/dispatch. **Out of scope; do not touch.**
- **The 2-call cost is the EDIT path** (`editedScore` present): `toolDispatchRun` (`toolDispatch.ts`, Sonnet, `dispatch_to_handler` flat discriminated-union tool, `maxTokens:300`, picks 1 of 6 actions + high-level args) → `runDispatchedHandler` (`index.ts` ~L408) → a handler (e.g. `editIntraMeasure`) makes a **2nd LLM call** (up to 8000 tokens) to author the precise ops. PR2 = make the single free-tier call emit final operations directly.

## Hard constraints the collapse MUST preserve

All three operate on the before/after `Score`, and today already sit **after** the handler returns — so they re-apply naturally to the single-call result:

1. **Server-side measure-hash preservation verification** (`preservationVerifier.ts`) — the LLM is never trusted to self-report preservation. Re-run on the single-call output.
2. **Replacement-as-confirmation gate** (`index.ts` ~L109–142 `maybeApplyReplacementGate` → `replacementDetect.ts`) — wholesale rewrites gate behind a UI modal unless the user explicitly asked to start over. Re-run on the single-call output.
3. **Per-action validation/retry** — each handler's schema validation + one-shot retry on `ValidationError`. The unified call needs equivalent per-action validation before the result is accepted.

## Phase A — Spike + A/B (ends at a STOP for human review)

Throwaway work to answer Roger's three open questions BEFORE building the shippable PR. No shippable code lands in Phase A.

### A0 — Worktree + harness recon (done)
- Worktree off fresh `origin/main` at `/home/claudeuser/sl-wt/she-19-pr2`, `node_modules` symlinked from `/home/claudeuser/recon-sheet-llm`. ✅
- Confirmed harness reality: `she15:matrix` (`scripts/she15-eval-matrix.ts`) is **on main**. `she15:converse` and `scripts/she15-dispatch-cost.ts` are **uncommitted WIP** in the `she-15` worktree (branch `she15-runner`) — treat that worktree as **read-only** (possible active concurrent SHE-15 session). ✅

### A1 — Measure the REAL dispatch-call cost (open question #3)
Reuse the approach in the WIP `she15-dispatch-cost.ts`: call `toolDispatch.run` in isolation across Sonnet + Haiku and representative prompts (edit / generate / question), cold-vs-warm, report per-call input/cached/output tokens + USD via `estimateCostUsd`. Bring a throwaway copy into the PR2 worktree (verify its `pricing` import path resolves on `origin/main`). **Deliverable:** confirmed $/1k for the dispatch call alone — validates (or kills) the cost premise before further investment.

### A2 — Prototype the unified single-call path (eval-only, throwaway)
Add an **eval-only flag** (e.g. `SL_HAIKU_SINGLE_CALL=1`) that, in the edit branch of `index.ts`, replaces `toolDispatchRun` + `runDispatchedHandler` with a single unified Haiku call. Prototype shape:

- **(B) — six real tools, `tool_choice: auto` [primary].** Register the handlers' actual emit tools (`edit_score`, `emit_appended_bars`, `emit_inserted_bars`, the region-replace emit, the regenerate/`render_score` emit, `answer_question`) as six tools in ONE call. Haiku picks one and fills its real operation schema. This is the natural tool-use shape — what the dispatcher comment "wished" it could do — and preserves each handler's battle-tested per-action schema, so accuracy is most likely held. Risk: six full schemas inflate the system+tool prefix (relevant to the Haiku 4096 cache-floor re-measurement in Phase B).
- **(A) — one mega discriminated-union tool [fallback].** Closer to today's flat dispatcher but now carrying every action's final operations flattened. Hold as fallback if (B)'s combined prefix tanks accuracy or is unworkably large. Discovering (B)-fails-and-(A)-wins is itself a valid A/B output.

### A3 — Run the A/B (Haiku on both arms)
Both arms use Haiku (the model swap was PR1; this A/B isolates the **collapse**, not the model). Use `she15:matrix` with two candidate rows:
- **baseline:** Haiku, 2-call (`SL_EVAL_MODEL_OVERRIDE=claude-haiku-4-5-20251001`, flag off)
- **unified:** same Haiku + `SL_HAIKU_SINGLE_CALL=1`

The matrix harness already captures per-case **parity** (deterministic `assertScoreInvariants`: measure-hash preservation, op-kind, replacement-blocked) and per-case **cost**, under a `SpendGuard` cap. Primary suite = the 12 live additive/destructive cases (the edit/structural target). Converse is secondary (its capture script is WIP/off-main); skip or port read-only if cheap.

**Report per suite:** accuracy/parity delta vs 2-call baseline, cost delta, latency delta, and an explicit check that the 3 hard constraints still hold when re-applied to the single-call result.

### A4 — STOP
Post results to SHE-19 + to Roger. **He greenlights before any Phase B build.** If the A/B shows the collapse tanks accuracy or the saving isn't real, Phase B does not proceed as-is.

## Phase B — Shippable PR (only after greenlight)

1. Promote the winning prototype to a real **`haiku-only` single-call mode** behind an `SL_*` read-fresh env flag (house style per `flags.ts` / `generationTier.ts`), **free tier only** (`getGenerationTier() === 'free'`). Pro path and all routing code untouched behind the flag.
2. Re-insert the 3 hard constraints after the single call returns (preservation verify, replacement gate, per-action validation/retry) + the hard-failure fallback to the 2-call path.
3. **Re-measure caching** on the new unified single-call prefix — it must clear Haiku 4.5's **4096-token** min cacheable prefix to cache (PR1 found the old dispatcher prefix sat below it; that trade-off is superseded by removing the dispatch call). Document the result.
4. Update `src/lib/orchestrator/README.md` + any doc whose `source_paths` covers touched files (`pnpm docs:check`).
5. Review: **1 senior code-review + 1 senior security-review subagent** (per repo convention — NOT the multi-agent skill). Typecheck via `NODE_OPTIONS=--max-old-space-size=3500 npx tsc --noEmit` (OOMs otherwise).
6. Pre-PR: `git diff --stat origin/main..HEAD` + `git merge-base --is-ancestor origin/main HEAD` (rebase if main moved). Open PR, then merge to main with `[skip ci]`.

## Conventions / constraints

- Never run git in the shared checkout `/home/claudeuser/recon-sheet-llm` (mutating); never write to the `she-15` worktree (concurrent-session hazard).
- Live evals / cost checks need a (rotated) `ANTHROPIC_API_KEY` — Roger provides on demand. The `she15:matrix` `SpendGuard` cap bounds spend; always `--dry-run` first.
- Model ids: Haiku `claude-haiku-4-5-20251001`, Sonnet `claude-sonnet-4-6`, Opus `claude-opus-4-7`. `effort` is model-gated in `anthropic.ts` (Haiku-safe).

## Risks / open questions (resolved by the A/B)

1. Can one tool-use call carry all 6 actions + final ops without tanking accuracy vs today's focused per-handler prompts? (A3)
2. Does collapsing break the preservation-check + confirmation-gate flow, and can both be cleanly re-inserted after the single call? (A3 + Phase B)
3. Is the real dispatch-call saving as estimated (~$2.5/1k)? (A1)
4. Does the unified prefix clear Haiku's 4096 cache floor? (Phase B caching re-measure)

## Out of scope

- Fresh free-tier generation (already single-call).
- Any change to pro-tier behavior or the Cheap→Moderate→Expensive ladder.
- Removing/ripping out multi-model routing code (kept behind the flag).
