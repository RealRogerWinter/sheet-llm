---
title: LLM Providers & Failover — Context Card
subsystem: providers-llm
audience: [ai-agent, contributor]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/lib/providers/types.ts
  - src/lib/providers/registry.ts
  - src/lib/providers/select.ts
  - src/lib/providers/callWithFailover.ts
  - src/lib/providers/degradation.ts
  - src/lib/providers/sticky.ts
  - src/lib/providers/anthropic.ts
  - src/lib/providers/openaiCompatible.ts
  - src/lib/providers/groq.ts
  - src/lib/providers/ollama.ts
  - src/lib/providers/systemBlocks.ts
  - src/lib/llm/errors.ts
  - src/lib/llm/index.ts
  - src/lib/llm/client.ts
related:
  - orchestrator
  - music-score-model
---

Multi-provider tool-call abstraction: tier→model routing + sticky-per-chat + schema-failure degradation ladder. Coexists with legacy single-Anthropic `render_score` path (`src/lib/llm/*`).

## Files
- `providers/select.ts` — `selectProvider(tier, chatId)` → `{provider, providerName, model, tier}`. Routing core; memoizes provider instances.
- `providers/callWithFailover.ts` — `callWithFailover(args, tool, options)`. Single-attempt `toolCall` + degradation telemetry. Does NOT retry/re-select.
- `providers/registry.ts` — `REGISTRY[provider][tier]→ModelEntry`; `getModelEntry`, `isProviderConfigured`, `PROVIDER_API_KEY_ENV`.
- `providers/degradation.ts` — failure tracker `${chatId}:${tier}:${provider}`; `DEGRADATION_THRESHOLD=2`; `reportProviderFailure`/`isProviderDegraded`/`clearDegradationForChat`/`_resetDegradation`.
- `providers/sticky.ts` — per-chat per-tier memory; `getSticky`/`setSticky`/`clearStickyForChat`/`_resetSticky`.
- `providers/types.ts` — `LLMProvider`, `ProviderTool<T>` (optional `strict`), `ProviderCallOptions` (+`effort`/`thinking`/`abortSignal`/`outputTokenBudget`/`streamDeadlineAt`), `ProviderToolResult<T>` (carries `stopReason`), `SystemBlock`, `Tier`, `Effort` (`'low'..'max'`), `ProviderName`; errors `ProviderSchemaError`/`ProviderRefusalError`/`OutputTruncatedError`.
- `providers/anthropic.ts` — native `tool_use` (pre-parsed input), per-block ephemeral cache (cap 3), memoized client + `apiKeyOverride`, `maxRetries:2`, `DEFAULT_MAX_TOKENS=8000`; `toolCall`+`textStream`. `tuningParams` forwards per-model: `temperature` (dropped on Opus 4.7+), `effort` via `output_config.effort` (Sonnet 4.6 / Opus 4.5+ only), `thinking` `disabled`/`adaptive`, and `strict` tools. Throws `OutputTruncatedError` (not `ProviderSchemaError`) when `stop_reason==='max_tokens'` before the zod parse; populates `stopReason`. M26 PR-2 kill-switch: `abortSignal` + `makeOutputBudgetGuard` (`streamGuard.ts`) abort mid-stream on `outputTokenBudget`/`streamDeadlineAt` → clean `message-stop`; `APIUserAbortError` → `OutputTruncatedError` (precedes the `APIError` branch, so it does NOT 502 / trip degradation).
- `providers/openaiCompatible.ts` — `fetch` `${baseUrl}/chat/completions`; args are JSON STRING → `JSON.parse` → zod. Base for Groq/Ollama. Throws on `history`.
- `providers/groq.ts` / `providers/ollama.ts` — subclasses; Ollama keyless + `extendRequestBody` sets `body.format=inputSchemaJson`.
- `llm/errors.ts` — `RateLimitedError`(429), `UpstreamError(status=502)`. Shared by both stacks.
- `llm/index.ts` / `llm/client.ts` — legacy `getLLMClient()`→`realClient`(`claude-sonnet-4-6`, `render_score`, `maxRetries:3`, `max_tokens=req.maxTokens ?? MAX_TOKENS`)/`stubClient`. `LLMCompleteRequest`/`completeWithRetry` now thread an optional `maxTokens` so the route bounds the free-tier legacy fall-through.

## Tiers (REGISTRY)
small=haiku-4-5 / medium=sonnet-4-6 / large=opus-4-7 (anthropic); groq gpt-oss-20b/120b; ollama qwen2.5 7b/14b.

## Env flags (all default `anthropic`)
- `PROVIDER_SMALL` / `PROVIDER_MEDIUM` / `PROVIDER_LARGE` — provider per tier (invalid → anthropic).
- `PROVIDER_FALLBACK` — used when chosen is degraded/unconfigured; only if it differs AND is configured.
- `ANTHROPIC_API_KEY` (unset) — configures anthropic + selects realClient vs stubClient; absent → `UpstreamError(500)`.
- `GROQ_API_KEY` (unset) — without it `isProviderConfigured('groq')=false` → fallback.
- `OLLAMA_BASE_URL` (`http://localhost:11434/v1`) — local endpoint; ollama always "configured".

## Gotchas
- `callWithFailover` does NOT fail over — single attempt; only logs telemetry + re-throws. Degradation routes on the NEXT `selectProvider`, never mid-handler. `editIntraMeasure` wraps `ProviderSchemaError` and propagates, no re-select.
- Only `ProviderSchemaError` trips degradation. `OutputTruncatedError` does NOT — it signals a capacity issue, not a model-output defect. Rate-limit / 5xx NEVER auto-failover.
- sticky + degradation are module-level Maps: in-memory, single-process, no eviction, not shared across serverless instances. Must `clearStickyForChat` on chat delete (it lazily clears degradation too).
- OpenAI-compat providers (Groq/Ollama) throw a plain Error on `options.history` — Anthropic only for multi-turn.
- Capabilities (`promptCaching`/`nativeToolUse`/`strictJsonSchema`/`estimatedCallMs`) are declarative; routing ignores them.
- Three error layers: transport (`RateLimitedError`/`UpstreamError`, `llm/errors.ts`), capacity (`OutputTruncatedError`, `providers/types.ts`; thrown pre-parse, no degradation), and model-output (`ProviderSchemaError`/`ProviderRefusalError`, `providers/types.ts`).

## When editing X, also update Y
- Add a provider → `ProviderName` union (`types.ts`) + `VALID_PROVIDERS` + `instantiate` switch (`select.ts`) + `REGISTRY` + `PROVIDER_API_KEY_ENV` (+`isProviderConfigured`) (`registry.ts`) + subclass.
- Change `anthropic.medium` model → also the `claude-sonnet-4-6` literals in `anthropic.ts` (2×) and `client.ts` `MODEL`; if the family changes, also the name-pattern gates `modelAcceptsTemperature`/`modelSupportsEffort` in `anthropic.ts`.
- Touch sticky key shape → keep `degradation.ts` `${chatId}:${tier}:${provider}` key in sync (lockstep clear).

## Related cards
- `orchestrator` — consumes `selectProvider`/`callWithFailover`.
- `music-score-model` — `ProviderTool` zod schema validates Score/op tool inputs.
