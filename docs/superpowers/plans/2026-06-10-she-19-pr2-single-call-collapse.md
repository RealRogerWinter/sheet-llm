# SHE-19 PR2 — Free-tier all-6 single-call collapse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove (Phase A) then ship (Phase B) a free-tier-only mode that collapses the orchestrator's 2-call edit path (dispatch → handler) into ONE Haiku tool-use call emitting final operations for any of the 6 actions.

**Architecture:** Phase A is a **throwaway measurement spike** — its "tests" are eval-parity + cost numbers from `she15:matrix`, not shipped unit tests. It (1) measures the real dispatch-call cost, (2) builds a unified single-call prototype behind an eval-only flag using `tool_choice:'auto'` over the 5 structural emit-tools (answer = plain-text response), and (3) A/Bs it (Haiku on both arms) against the current 2-call path on the 12 live cases. Phase A ends at a STOP for Roger's review. **Phase B (gated on greenlight)** promotes the winner to a real `SL_*`-flagged, free-tier-only mode with the 3 hard constraints re-inserted, a 2-call hard-failure fallback, caching re-measured, and the standard review→merge.

**Tech Stack:** TypeScript, Next.js (vendored — read `node_modules/next/dist/docs/` before touching Next APIs), Anthropic SDK, vitest eval harness (`vitest.evals.live.config.ts`), `tsx` scripts, pnpm. Worktree `/home/claudeuser/sl-wt/she-19-pr2` off `origin/main` 41cbc09.

**Spec:** `docs/superpowers/specs/2026-06-10-she19-pr2-single-call-collapse-design.md`

---

## Reference — emit-tool inventory (what the unified call assembles)

| Action | Handler entry | Emit tool name | Tool input shape | Apply (`transformScore` kind) |
|---|---|---|---|---|
| edit_intra_measure | `runEditIntraMeasure` | `edit_score` | `{ ops: unknown[] }`, dynamic `inputSchemaJson` via `buildEditScoreSchemaJson(score)` | per-op `transformScore(score, op)`, tolerant |
| region_replace | `runRegionReplace` | `emit_replacement_bars` | `{ measures: Measure[], perVoiceContent? }` | `{ kind:'regionReplace', startMeasureIdx, endMeasureIdx, measures, perVoiceContent }` |
| insert_measures | `runInsertMeasures` | `emit_inserted_bars` | `{ measures: Measure[], perVoiceContent? }` | `{ kind:'insertMeasuresAfter', afterMeasureIdx, measures, perVoiceContent }` |
| extend_composition | `runExtendComposition` | `emit_appended_bars` | `{ measures: Measure[], perVoiceContent? }` | `{ kind:'appendMeasures', measures, perVoiceContent }` |
| regenerate_all | `runCompose` | `render_score` | full `Score` (`renderScoreTool`) | `validateScore` + id backfill |
| answer_question | `runConverse` | (none — text stream) | n/a | n/a (prose) |

**Provider gap:** `callWithFailover`/`anthropic.ts` only support a single tool + `tool_choice:{type:'tool',name}`. The unified call needs `tool_choice:'auto'` over multiple tools → Task A2 adds a minimal Anthropic-only multi-tool path. Under `'auto'`, a text response (no tool call) = the answer_question case.

**Hard constraints (re-applied AFTER the single call, Phase B):** measure-hash preservation (`preservationVerifier.ts`), replacement-as-confirmation gate (`index.ts maybeApplyReplacementGate` ~L109–142 → `replacementDetect.ts`), per-action zod validation + one-shot retry.

---

# PHASE A — Spike + A/B (throwaway; ends at STOP)

## Task A1: Measure the real dispatch-call cost

**Files:**
- Create: `scripts/_spike-dispatch-cost.ts` (throwaway; `_spike-` prefix, never committed to the PR)

**Goal:** Confirm/kill the ~$2.5/1k premise by isolating the dispatcher round-trip cost (cold vs warm, Sonnet vs Haiku).

- [ ] **Step 1: Port the WIP probe.** Read `/home/claudeuser/sl-wt/she-15/scripts/she15-dispatch-cost.ts` (read-only — concurrent SHE-15 session). Recreate it as `scripts/_spike-dispatch-cost.ts`. It calls `run as dispatchRun` from `@/lib/orchestrator/toolDispatch`, loops MODELS=[Sonnet `claude-sonnet-4-6`, Haiku `claude-haiku-4-5-20251001`] × PROMPTS=[edit/generate/question] × 3 reps (cold/warm), printing per-call in/cached/out tokens + USD via `estimateCostUsd`.

- [ ] **Step 2: Fix the pricing import for origin/main.** The WIP imports `@/lib/metering/pricing`. Verify the path on this branch:

Run: `ls src/lib/metering/pricing.ts src/lib/billing/pricing.ts 2>&1`
Use whichever exists; confirm `estimateCostUsd(model, inTok, outTok, cachedTok)` is exported there (`grep -n "export function estimateCostUsd" src/lib/*/pricing.ts`).

- [ ] **Step 3: Typecheck the script.**

Run: `NODE_OPTIONS=--max-old-space-size=3500 npx tsc --noEmit 2>&1 | grep _spike-dispatch-cost || echo "clean"`
Expected: `clean`

- [ ] **Step 4: Run it live** (needs the key; inline, never written to a tracked file).

Run: `ANTHROPIC_API_KEY=<key> npx tsx scripts/_spike-dispatch-cost.ts`
Expected: per-model warm avg `$/call`. Record the warm Sonnet dispatch $/call → ×1000 = real dispatch tax/1k. Compare to the ~$2.5/1k estimate.

- [ ] **Step 5: Capture the number** in a scratch note (`evals/results/_spike-dispatch-cost.txt`, throwaway). This feeds the A4 synthesis. No commit.

## Task A2: Build the unified single-call prototype (eval-only, throwaway)

**Files:**
- Modify: `src/lib/providers/anthropic.ts` — add `multiToolCall` (Anthropic-only, `tool_choice:'auto'`, returns either a tool-use `{name,input,usage}` or `{text,usage}`)
- Create: `src/lib/orchestrator/_spikeUnifiedCall.ts` — assembles the 5 emit-tools + combined system prompt, runs the single call, routes the result to the matching apply path, returns an `OrchestratorResult`
- Modify: `src/lib/orchestrator/index.ts` — in the `editedScore`-present edit branch, `if (process.env.SL_HAIKU_SINGLE_CALL === '1') return runSpikeUnifiedCall(input)` BEFORE `toolDispatchRun`
- Modify: `src/lib/orchestrator/flags.ts` — add `isHaikuSingleCallEnabled()` (read-fresh, house style)

**Goal:** A faithful prototype that the matrix can grade. Throwaway — fidelity over polish. All files `_spike`-named or clearly reverted before Phase B.

- [ ] **Step 1: Add the read-fresh flag.** In `flags.ts`, mirror the existing `readBool` pattern:

```ts
/** SPIKE (SHE-19 PR2 A/B): collapse the edit path to one Haiku tool-use call. Eval-only. */
export function isHaikuSingleCallEnabled(): boolean {
  return readBool('SL_HAIKU_SINGLE_CALL')
}
```

- [ ] **Step 2: Add `multiToolCall` to AnthropicProvider.** Model it on the existing `toolCall` (`anthropic.ts` ~L137), but accept `tools: ProviderTool<unknown>[]` and send `tools: toolDefs, tool_choice: { type: 'auto' }`. Parse the response: if a `tool_use` block → return `{ kind:'tool', name, input, toolUseId, model, usage }`; if only text → return `{ kind:'text', text, model, usage }`. Reuse the existing `tuningParams`, system-block, and usage-extraction helpers. Spike scope: Anthropic only, no failover.

```ts
async multiToolCall(
  tools: ReadonlyArray<ProviderTool<unknown>>,
  options: ProviderCallOptions,
): Promise<
  | { kind: 'tool'; name: string; input: unknown; toolUseId: string; model: string; usage?: ProviderUsage }
  | { kind: 'text'; text: string; model: string; usage?: ProviderUsage }
> { /* body mirrors toolCall, tools: tools.map(toToolDef), tool_choice: { type: 'auto' } */ }
```

- [ ] **Step 3: Build the combined system prompt** in `_spikeUnifiedCall.ts`. Concatenate (a) the dispatcher's DECISION RULES (which action when — lift the rule/example block from `toolDispatch.ts TOOL_DISPATCH_SYSTEM_PROMPT`) with (b) a short per-tool "emit final ops" instruction for each of the 5 tools, plus (c) "If the user is only ASKING a question, reply in prose — do NOT call a tool." Keep the real per-tool emit semantics by importing each handler's emit guidance where exported; otherwise inline a 1–2 line summary per tool.

- [ ] **Step 4: Assemble the 5 tools with their exact schemas.** Import/recreate each emit-tool's `{ name, inputSchema, inputSchemaJson }`: `edit_score` (dynamic `buildEditScoreSchemaJson(editedScore)`), `emit_replacement_bars`, `emit_inserted_bars`, `emit_appended_bars`, `render_score` (`renderScoreTool`). Build the score summary (reuse `toolDispatch.ts buildScoreSummary`) into the user text.

- [ ] **Step 5: Route the result to the apply path.** On `{kind:'tool', name}`: switch on the tool name → call the corresponding `transformScore(...)` with the right op kind (see inventory table) + per-tool zod validation; build an `OrchestratorResult` ({ score, appliedOps, dispatchTool: <action>, usage }). On `{kind:'text'}`: return a converse-style result (prose answer, no score change). Keep per-tool validation; on validation failure in the spike, log and let the case fail (the A/B should see real failures).

- [ ] **Step 6: Wire the flag into the orchestrator.** In `index.ts`, at the top of the `editedScore`-present edit branch (just before `toolDispatchRun`), add:

```ts
if (isHaikuSingleCallEnabled()) {
  return runSpikeUnifiedCall({ userText: input.userText, editedScore: input.editedScore, chatId: input.chatId, modelOverride: input.modelOverride })
}
```

- [ ] **Step 7: Typecheck.**

Run: `NODE_OPTIONS=--max-old-space-size=3500 npx tsc --noEmit 2>&1 | tail -20`
Expected: no new errors in the touched files.

- [ ] **Step 8: Smoke one case offline-ish.** Run a single live edit case with the flag on to confirm the path executes end-to-end and produces a score (not a crash):

Run: `ANTHROPIC_API_KEY=<key> RUN_LIVE_EVALS=1 SL_HAIKU_SINGLE_CALL=1 SL_EVAL_MODEL_OVERRIDE=claude-haiku-4-5-20251001 pnpm exec vitest run -c vitest.evals.live.config.ts -t "triplet-demo-extend-turnaround" 2>&1 | tail -30`
Expected: the case runs (pass or fail is fine — we're confirming the unified path executes and emits a gradeable score).

## Task A3: Run the A/B (Haiku 2-call vs Haiku unified)

**Files:**
- Modify: `scripts/she15-eval-matrix.ts` — add two candidate rows (temporary; reverted before Phase B): `haiku-2call` (baseline arm pinned to Haiku, flag off) and `haiku-unified` (`env: { SL_HAIKU_SINGLE_CALL: '1', SL_EVAL_MODEL_OVERRIDE: 'claude-haiku-4-5-20251001' }`). NOTE: the matrix requires exactly one `isBaseline` row for per-case parity — make `haiku-2call` the baseline.

**Goal:** One report with per-case parity + per-case cost, both arms Haiku (isolating the collapse, not the model).

- [ ] **Step 1: Add the two candidate rows** to `ALL_CANDIDATES`:

```ts
{ label: 'haiku-2call',  env: { SL_EVAL_MODEL_OVERRIDE: 'claude-haiku-4-5-20251001' }, estPerCaseUsd: 0.02, isBaseline: true },
{ label: 'haiku-unified', env: { SL_HAIKU_SINGLE_CALL: '1', SL_EVAL_MODEL_OVERRIDE: 'claude-haiku-4-5-20251001' }, estPerCaseUsd: 0.015 },
```

- [ ] **Step 2: Dry-run the plan** (no spend):

Run: `pnpm she15:matrix -- --dry-run --models=haiku-2call,haiku-unified`
Expected: prints both rows + a conservative total estimate, spends nothing.

- [ ] **Step 3: Run the A/B live** under the spend cap (start with the 10 non-expensive cases):

Run: `ANTHROPIC_API_KEY=<key> pnpm she15:matrix -- --models=haiku-2call,haiku-unified --cap=6`
Expected: `evals/results/she15-report.md` with a per-case parity table (haiku-unified vs haiku-2call baseline) + per-row cost; cumulative spend under cap.

- [ ] **Step 4: Read the report.**

Run: `cat evals/results/she15-report.md`
Capture: per-case parity (which cases the unified arm passes/fails vs baseline), total cost delta, and any cases where preservation/replacement-gate invariants (`firstNMeasuresIdentical`, `replacementBlocked`) regressed under the unified arm.

- [ ] **Step 5: If parity is borderline, try shape (A) or prompt tweaks** — only if needed, time-boxed. Otherwise proceed to A4. Record whichever shape was used.

## Task A4: Synthesize + STOP for review

- [ ] **Step 1: Write the findings summary** — real dispatch $/1k (A1), per-suite accuracy parity + cost delta (A3), whether the 3 hard constraints held, regenerate_all free-tier reachability observed, and a go/no-go recommendation with the chosen prototype shape.

- [ ] **Step 2: Post to Linear SHE-19** as a comment (mirror the brief's style). Also report inline to Roger.

- [ ] **Step 3: STOP.** Do not start Phase B until Roger greenlights. Leave all `_spike` files uncommitted/clearly marked; they are NOT part of the eventual PR.

---

# PHASE B — Shippable PR (greenlit 2026-06-10; approach = (2) HYBRID)

**Decision:** proceed with **approach (2)** — single call, but the unified system prompt carries each action's FULL focused emit guidance (not diluted summaries), which is what closes the lone `turnaround-after-PAC` cadence regression. A/B (retry-fair) showed 5/6 parity, ~3.4× faster, ~$2.8/1k saved; (2) adds only a marginal, cached, static-prompt token delta (INTRA already dominates the prefix).

## Task B1: Promote `multiToolCall` into the provider layer (properly)
**Files:** `src/lib/providers/anthropic.ts`, `src/lib/providers/types.ts`, `src/lib/providers/callWithFailover.ts` (as needed); test `src/lib/providers/anthropic.multiToolCall.test.ts`.
- Move the spike's Anthropic-only `multiToolCall` into a proper provider method: accept `ReadonlyArray<ProviderTool<unknown>>`, send `tool_choice:{type:'auto'}`, return the `{kind:'tool'|'text', ...}` union. Reuse `buildSystemBlocks`/`tuningParams`/usage mapping.
- Non-Anthropic providers (Groq/Ollama/openaiCompatible) must throw a clear, typed `MultiToolUnsupportedError` (or equivalent) rather than silently misbehaving — document the Anthropic-only constraint. The free-tier collapse is Anthropic-only by design (pro/other providers keep the 2-call path).
- **TDD:** unit test the tool-vs-text branch + usage extraction with a mocked SDK.

## Task B2: Production `haikuSingleCall.ts` (approach 2 prompt)
**Files:** Create `src/lib/orchestrator/haikuSingleCall.ts`; `src/lib/orchestrator/flags.ts`.
- Port `_spikeUnifiedCall.ts` to production. The unified system prompt = dispatcher DECISION RULES + **each action's FULL focused guidance**: import/reuse the real per-handler prompt content (`EXTEND_SYSTEM_PROMPT` incl. its cadence/ending guidance, `REGION_SYSTEM_PROMPT`, `INSERT_SYSTEM_PROMPT`, `INTRA_SYSTEM_PROMPT`, compose guidance) rather than 1-line summaries. Keep the 5-tool `tool_choice:'auto'` shape + text=answer.
- Per-action zod validation + one-shot validation-retry (already in the spike) + restore the per-handler **warning recovery** the spike dropped (tie-boundary/severed-span/cadence/count-mismatch handling) where it affects graded invariants — at minimum for extend/region (reuse the handlers' helpers).
- Replace the eval-only `SL_HAIKU_SINGLE_CALL` with the real read-fresh flag `isHaikuSingleCallEnabled()` (house style), and gate it to **free tier only** at the call site (B3).

## Task B3: Wire into the orchestrator with free-tier gate + hard-failure fallback
**Files:** `src/lib/orchestrator/index.ts`.
- In the `editedScore`-present edit branch, BEFORE `toolDispatchRun`: `if (getGenerationTier() === 'free' && isHaikuSingleCallEnabled()) { try { return await finalize(runHaikuSingleCall(...)) } catch (e) { /* log + fall through to the 2-call path */ } }`. A malformed single call must NOT drop the turn — it falls back to `toolDispatchRun → runDispatchedHandler`.
- **Critical:** route the unified result through the SAME post-handler finalize used by the 2-call path (`finalizeDispatchResult` / `maybeApplyReplacementGate` ~L109–142 + preservation verify) so the **measure-hash preservation** + **replacement-as-confirmation gate** apply to the single-call output. Do NOT duplicate those checks — reuse the existing finalize seam.

## Task B4: Confirm approach (2) closes the regression (live)
- Re-run `pnpm she15:matrix -- --models=haiku-2call,haiku-unified` with the production prompt. **Gate:** `turnaround-after-PAC` now passes (full parity, or document any residual). Record the report.

## Task B5: Caching re-measure
- `count_tokens` the unified system+tool prefix on `claude-haiku-4-5`; confirm it clears 4096 (cacheable). Note the per-score dynamic `edit_score` schema's effect on cache-hit. Document in the README + a comment.

## Task B6: Tests + docs
- Mock eval cases (`evals/cases/**/*.mock.eval.ts`) for the unified free-tier path: one per action (dispatch+emit in one call), asserting the right `appliedOps`/preservation/replacement-gate. Unit tests for the flag gate + the hard-failure fallback (unified throws → 2-call path runs).
- Update `src/lib/orchestrator/README.md` (architecture + flag reference + the free-tier single-call mode) + any doc whose `source_paths` covers touched files; bump `last_verified`/`verified_against`; `pnpm docs:check` clean.

## Task B7: Spike teardown + review + PR
- Remove all spike artifacts: `scripts/_spike-dispatch-cost.ts`, `src/lib/orchestrator/_spikeUnifiedCall.ts`, the two `she15-eval-matrix.ts` candidate rows + the `needsGroq` tweak, and `evals/results/_spike-*`. Confirm `git status` shows only production changes.
- Typecheck: `NODE_OPTIONS=--max-old-space-size=3500 npx tsc --noEmit` clean. Run the affected unit + mock-eval suites.
- Review: **1 senior code-review subagent + 1 senior security-review subagent** (per [[sheet-llm-she8-review-approach]] — NOT the multi-agent skill). Address blocking findings.
- Pre-PR: `git diff --stat origin/main..HEAD` + `git merge-base --is-ancestor origin/main HEAD` (rebase onto fresh `origin/main` if it moved — see PR1's rebase lesson). Open the PR; squash-merge with `[skip ci]`. Post a merge summary to SHE-19.

---

## Self-review notes

- **Spec coverage:** A1↔dispatch-cost(Q3); A2↔unified prototype shape B; A3↔accuracy+cost A/B(Q1)+constraint check(Q2); B3↔caching(Q4); free-tier gating↔B1; constraints↔B2; conventions↔B5/B6. All spec sections mapped.
- **Spike honesty:** Phase A validation is eval/cost output, not unit tests — explicitly flagged (this is a measurement spike, not shippable code). Phase B carries the TDD/test burden.
- **Throwaway hygiene:** all Phase A code is `_spike`-named or a temporary matrix edit, reverted in B5 — it must not leak into the PR.
- **Key handling:** API key passed inline per-command only; never written to a tracked file. Rotate after session.
