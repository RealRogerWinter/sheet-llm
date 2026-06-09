# PR1 — Groq provider correctness & cost plumbing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline; chosen per "proceed autonomously"). Steps use `- [ ]` for tracking.

**Goal:** Make the OpenAI-compatible (Groq) provider report truncation and refusals honestly and meter its spend, and add verified Groq pricing — so the SHE-15 cost/reliability comparison is faithful.

**Architecture:** Surgical edits to `src/lib/providers/openaiCompatible.ts` (mirror the Anthropic provider's truncation + metering pattern) and additive rows in `src/lib/billing/pricing.ts`. No registry edits — the matrix driver (PR3) forces each candidate model via per-call `modelOverride`, which `OpenAICompatibleProvider` already honors. Pure TDD against mocked `fetch`; zero live calls.

**Tech Stack:** TypeScript, vitest, zod.

**Verified Groq pricing (groq.com/pricing, 2026-06-09):** llama-3.1-8b-instant 0.05/0.08; openai/gpt-oss-20b 0.075/0.30 (cached-in 0.0375); openai/gpt-oss-120b 0.15/0.60 (cached-in 0.075); qwen/qwen3-32b 0.29/0.59 (preview); llama-3.3-70b-versatile 0.59/0.79. Groq has no cache-WRITE premium → `cacheWrite5mPerM = inputPerM`. Models without a listed cached rate → `cachedInputPerM = inputPerM` (conservative, no phantom discount).

---

### Task 1: Add Groq pricing rows

**Files:** Modify `src/lib/billing/pricing.ts:46` (append to `PRICING`); Test `tests/unit/billing/pricing.test.ts` (create if absent).

- [ ] **Step 1 — failing test.** Add cases asserting `estimateCostUsd('openai/gpt-oss-20b', 1_000_000, 1_000_000)` ≈ `0.075 + 0.30 = 0.375` and `estimateCostUsd('llama-3.1-8b-instant', 1_000_000, 0)` ≈ `0.05`, and that the gpt-oss-20b cached bucket bills at 0.0375 (`estimateCostUsd('openai/gpt-oss-20b', 1_000_000, 0, 1_000_000)` ≈ `0.0375`). Use `toBeCloseTo`.
- [ ] **Step 2 — run, expect FAIL** (`unknown model` → 0). `pnpm vitest run tests/unit/billing/pricing.test.ts`.
- [ ] **Step 3 — implement.** Append the 5 Groq rows to `PRICING` with the verified rates; `cacheWrite5mPerM = inputPerM`; `cachedInputPerM` = the verified cached rate for gpt-oss, else `inputPerM`.
- [ ] **Step 4 — run, expect PASS.**

### Task 2: `finish_reason: 'length'` → `OutputTruncatedError`

**Files:** Modify `src/lib/providers/openaiCompatible.ts` (response type ~33; `toolCall` body 126-176; imports 10); Test `tests/unit/providers/openaiCompatible.test.ts`.

- [ ] **Step 1 — failing test.** A response with `choices[0].finish_reason='length'` (truncated args) → `provider.toolCall(...)` rejects with `OutputTruncatedError` (import from `@/lib/providers/types`), and the error carries `maxTokens` when `options.maxTokens` is set.
- [ ] **Step 2 — run, expect FAIL** (currently throws `ProviderSchemaError` on the unparseable JSON, or succeeds).
- [ ] **Step 3 — implement.** Add `finish_reason?: string` to the choice type; in `toolCall`, after extracting `const choice = data.choices?.[0]` and `message`, hoist usage mapping, then: `if (choice?.finish_reason === 'length') { recordProviderCall(data.model ?? model, usage); throw new OutputTruncatedError(\`${this.name}: "${tool.name}" hit the max_tokens ceiling (${options.maxTokens ?? 'default'}) before completing\`, { ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}), ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}) }) }`. Import `OutputTruncatedError`.
- [ ] **Step 4 — run, expect PASS.**

### Task 3: structured refusal → `ProviderRefusalError`

**Files:** same as Task 2.

- [ ] **Step 1 — failing test.** A response with `choices[0].message.refusal='I can't help with that'` and no tool_call → rejects with `ProviderRefusalError`. Keep the existing "no tool_call, content only, NO refusal field → ProviderSchemaError" test (that is a genuine tool-contract failure, not a refusal).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** Add `refusal?: string | null` to the message type; before the tool_call extraction (and after the truncation check): `if (typeof message.refusal === 'string' && message.refusal.length > 0) { recordProviderCall(data.model ?? model, usage); throw new ProviderRefusalError(\`${this.name}: model refused\`, message.refusal) }`. Import `ProviderRefusalError`.
- [ ] **Step 4 — run, expect PASS.**

### Task 4: meter Groq usage + surface `stopReason`

**Files:** `src/lib/providers/openaiCompatible.ts` (import `recordProviderCall` from `@/lib/billing/usageMeter`; success path); Test as above.

- [ ] **Step 1 — failing test.** Wrap a successful `toolCall` in `runWithUsageMeter('t', async () => ...)` and assert `currentMeterTotals()` shows `callCount===1`, `outputTokens===30`, and `costUsd > 0` for model `openai/gpt-oss-20b`. Also assert the returned result has `stopReason` set from `finish_reason` (set the mock's `finish_reason:'tool_calls'`).
- [ ] **Step 2 — run, expect FAIL** (no metering today; `stopReason` undefined).
- [ ] **Step 3 — implement.** On the success path, set `stopReason: choice?.finish_reason` in the returned object and call `recordProviderCall(data.model ?? model, usage)` just before `return`. (No-op outside a meter scope, never throws — confirmed in `usageMeter.ts:68`.)
- [ ] **Step 4 — run, expect PASS.**

### Task 5: full verification

- [ ] `pnpm vitest run tests/unit/providers/openaiCompatible.test.ts tests/unit/billing/pricing.test.ts` → all green (incl. the unchanged existing cases).
- [ ] `pnpm typecheck` → clean.
- [ ] Sanity: the existing "maps OpenAI usage shape" test still passes (usage hoist preserves `{inputTokens, cachedInputTokens, outputTokens}`).

### Task 6: ship

- [ ] Commit (`feat(providers): Groq truncation/refusal classification, usage metering, pricing`).
- [ ] Push `feat/she-15-provider-correctness`; open PR vs `main` with a body explaining the SHE-15 context + the 4 changes.
- [ ] Run code-review + security-review on the PR; post findings; fix; CI green; merge.

**Spec coverage check:** PR1 section of the design spec → Tasks 1-4 cover finish_reason, refusal, metering, pricing. Registry edits intentionally dropped (modelOverride mechanism). No placeholders. Types consistent (`OutputTruncatedError`/`ProviderRefusalError` from `./types`, `recordProviderCall` from `usageMeter`).
