---
title: LLM Providers & Failover
subsystem: providers-llm
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-10
verified_against: 6de9175
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
  - src/lib/llm/wrapper.ts
  - src/lib/llm/messages.ts
related:
  - orchestrator
  - music-score-model
---

`src/lib/providers/*` is a multi-provider tool-call abstraction that lets each
orchestrator handler route a single tool-use call to Anthropic, Groq, or a
local Ollama model based on a per-tier env config, with **sticky-per-chat**
selection so a conversation doesn't drift between provider "voices", and a
**schema-failure-driven degradation ladder** that auto-routes a chat to a
fallback provider after repeated malformed tool inputs. It coexists with an
older, single-Anthropic `src/lib/llm/*` path (`getLLMClient` → `realClient` /
`stubClient`) that still drives the legacy `render_score` flow.

## Entry points

| Symbol | File | Use |
| --- | --- | --- |
| `selectProvider(tier, chatId)` | `src/lib/providers/select.ts` | Resolve `{ provider, providerName, model, tier }` for a tier in a chat. The routing core. |
| `callWithFailover(args, tool, options)` | `src/lib/providers/callWithFailover.ts` | Single-attempt `provider.toolCall` + degradation telemetry. |
| `LLMProvider` interface | `src/lib/providers/types.ts` | The provider contract (`toolCall`, optional `textStream`, optional `multiToolCall`). |
| `getLLMClient()` | `src/lib/llm/index.ts` | Legacy path: returns `realClient` (key present) or `stubClient`. |

A handler typically does:

```ts
const selected = selectProvider('medium', chatId)
const result = await callWithFailover(
  { ...selected, chatId },
  { name, description, inputSchema, inputSchemaJson },
  { systemPrompt, userText, toolChoice: 'required', maxTokens, temperature: 0 },
)
// result: ProviderToolResult<T> = { input, toolUseId, model, introText?, usage? }
```

See `runEditIntraMeasure` in `src/lib/orchestrator/handlers/editIntraMeasure.ts`
(the `selectProvider('medium', input.chatId)` call) for the canonical live
consumer (medium tier).

## Key files

| Path | Role |
| --- | --- |
| `src/lib/providers/types.ts` | Type spine: `ProviderName`, `Tier`, `Effort` (`'low'..'max'`), `ProviderCapabilities`, `ModelEntry`, `ProviderTool<T>` (now with optional `strict` for grammar-constrained tool use), `SystemBlock`, `ProviderCallOptions` (now also `effort`, `thinking`, `abortSignal`, `outputTokenBudget`, `streamDeadlineAt`), `ProviderToolResult<T>`, `TextStreamEvent`, `LLMProvider`, the model-output errors `ProviderSchemaError` / `ProviderRefusalError` / `OutputTruncatedError`, and (SHE-19 PR2) the optional `multiToolCall` member + `MultiToolResult` (`{kind:'tool'...}` \| `{kind:'text'...}`) + `MultiToolUnsupportedError` for the Anthropic-only `tool_choice:'auto'` multi-tool path. |
| `src/lib/providers/registry.ts` | Declarative `REGISTRY[provider][tier] → ModelEntry`. `getModelEntry`, `PROVIDER_API_KEY_ENV`, `isProviderConfigured`. |
| `src/lib/providers/select.ts` | Resolution + routing. `selectProvider`, module-level `instances` memo, `instantiate`. Reads `PROVIDER_<TIER>` and `PROVIDER_FALLBACK`. |
| `src/lib/providers/callWithFailover.ts` | Single-attempt `toolCall` wrapper; on `ProviderSchemaError` (with `chatId`) calls `reportProviderFailure`, then re-throws. |
| `src/lib/providers/degradation.ts` | In-memory failure tracker keyed `${chatId}:${tier}:${provider}`. `DEGRADATION_THRESHOLD = 2`. `reportProviderFailure`, `isProviderDegraded`, `clearDegradationForChat`, `_resetDegradation`. |
| `src/lib/providers/sticky.ts` | In-memory per-chat per-tier provider memory. `getSticky`, `setSticky`, `clearStickyForChat` (lazily clears degradation in lockstep), `_resetSticky`. |
| `src/lib/providers/anthropic.ts` | `AnthropicProvider`: native `tool_use` (pre-parsed `input`), per-block ephemeral `cache_control`, memoized SDK client keyed on env key with `apiKeyOverride` escape hatch, `maxRetries: 2`, `DEFAULT_MAX_TOKENS = 8000` fallback. Implements `toolCall` + `textStream`. Per-model tuning via `tuningParams`: forwards `temperature` only where accepted (`modelAcceptsTemperature` — dropped on Opus 4.7+), `effort` via `output_config.effort` (`modelSupportsEffort` — Sonnet 4.6 / Opus 4.5+ only), and `thinking` (`'disabled'`/`'adaptive'`); forwards `strict: true` for grammar-constrained tools. M26 PR-2 streaming kill-switch: `abortSignal` + `makeOutputBudgetGuard` (from `streamGuard.ts`) abort mid-stream on `outputTokenBudget`/`streamDeadlineAt`, surfaced as a clean `message-stop` (`stopReason 'max_tokens'`); an `APIUserAbortError` maps to `OutputTruncatedError`, NOT `UpstreamError`. SHE-19 PR2 adds `multiToolCall(tools, options)`: a single `tool_choice:'auto'` call over many tools, caching the (static) tool prefix via `cache_control` on the LAST tool def, returning `{kind:'tool', name, input, toolUseId}` when the model picks a tool or `{kind:'text', text}` for a prose reply (`max_tokens` overflow → `OutputTruncatedError`). It is the only Anthropic-specific method; non-Anthropic providers omit it (callers throw `MultiToolUnsupportedError`). |
| `src/lib/providers/openaiCompatible.ts` | `OpenAICompatibleProvider`: raw `fetch` to `${baseUrl}/chat/completions`; `tool_calls[0].function.arguments` is a JSON **string**, `JSON.parse`d then zod-validated. Base for Groq/Ollama. |
| `src/lib/providers/groq.ts` | `GroqProvider` (subclass): `https://api.groq.com/openai/v1`, `GROQ_API_KEY`, default `openai/gpt-oss-20b`. Exports `GROQ_CAPABILITIES`. |
| `src/lib/providers/ollama.ts` | `OllamaProvider` (subclass): keyless, `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`), default `qwen2.5:14b-instruct`. `extendRequestBody` sets `body.format = tool.inputSchemaJson` (grammar-constrained sampling). |
| `src/lib/providers/systemBlocks.ts` | `toSystemBlocks` (normalize → `SystemBlock[]`) and `flattenSystemPrompt` (→ blank-line-joined string). |
| `src/lib/llm/errors.ts` | Transport error taxonomy: `RateLimitedError` (429) and `UpstreamError(status = 502)`. Shared by **both** stacks. |
| `src/lib/llm/index.ts` | `getLLMClient()`: `realClient` when `ANTHROPIC_API_KEY` set, else `stubClient` (checked per call). |
| `src/lib/llm/client.ts` | Legacy `realClient`: hardcoded `claude-sonnet-4-6` + `render_score` tool, `maxRetries: 3`; `max_tokens` is `req.maxTokens ?? MAX_TOKENS` (per-request cap for the free-tier legacy bound, else default); text-only response → `UpstreamError(500)`. |
| `src/lib/llm/wrapper.ts` | Legacy types: `ChatMessage` (native Anthropic content-block shape — reused by the providers layer via `ProviderCallOptions.history`), `LLMCompleteRequest` (now with optional `maxTokens` for the free-tier ceiling), `LLMResponse`, `LLMClient`. |
| `src/lib/llm/messages.ts` | `completeWithRetry`: semantic-retry loop for the legacy client — on `ValidationError` appends `tool_result(is_error)` and retries (default 2; the route passes `maxRetries: 1` on the free tier). Forwards `request.maxTokens` to the client. |

## Core concepts & data flow

### Tiers and the registry

`Tier = 'small' | 'medium' | 'large'` maps an orchestrator-classified
scope/complexity to a model size. `REGISTRY` (`registry.ts`) is the single
source of truth for tier → model id:

| Provider | small | medium | large |
| --- | --- | --- | --- |
| anthropic | `claude-haiku-4-5-20251001` | `claude-sonnet-4-6` | `claude-opus-4-7` |
| groq | `openai/gpt-oss-20b` | `openai/gpt-oss-120b` | `openai/gpt-oss-120b` |
| ollama | `qwen2.5:7b-instruct` | `qwen2.5:14b-instruct` | `qwen2.5:14b-instruct` |

Each entry also carries `ProviderCapabilities` (`promptCaching`,
`nativeToolUse`, `strictJsonSchema`, `estimatedCallMs`). **These are mostly
declarative** — `select.ts` / `callWithFailover.ts` do not branch on them
today (see Invariants). `isProviderConfigured(provider)` is `true` for
`ollama` unconditionally (local, no key) and otherwise requires the
`PROVIDER_API_KEY_ENV` var to be present.

### `selectProvider` resolution order

```
selectProvider(tier, chatId)
  │
  ├─ desired = sticky(chatId,tier)  ??  PROVIDER_<TIER>  ??  'anthropic'
  │
  ├─ if chatId && isProviderDegraded(chatId,tier,desired):
  │      fb = PROVIDER_FALLBACK ?? 'anthropic'
  │      if fb !== desired && isProviderConfigured(fb):  chosen = fb
  │
  ├─ if !isProviderConfigured(chosen):
  │      if isProviderConfigured(PROVIDER_FALLBACK):     chosen = fallback
  │
  ├─ if !getModelEntry(chosen,tier):  chosen = 'anthropic'   (hard default)
  │
  ├─ if chatId && !stickyName:  setSticky(chatId,tier,chosen)   ← first turn only
  │
  └─ return { provider: instantiate(chosen), providerName: chosen,
             model: finalEntry.modelId, tier }
```

`instantiate(name)` lazily constructs and caches one `LLMProvider` instance
per provider name in a module-level `instances` map (`select.ts:33`), so all
chats share a single provider object and its memoized SDK client.

### The call: `callWithFailover` and degradation telemetry

```
handler ── selectProvider(tier, chatId) ──▶ SelectedProvider
   │
   └─ callWithFailover({...selected, chatId}, tool, options)
          │
          └─ provider.toolCall(tool, options)
                ├─ success → ProviderToolResult<T>
                └─ throw ProviderSchemaError
                       └─ if chatId: reportProviderFailure(chatId,tier,providerName)
                          re-throw  ← NO retry, NO re-select here
```

`reportProviderFailure` increments `failureCounts[${chatId}:${tier}:${provider}]`.
Once that counter reaches `DEGRADATION_THRESHOLD` (= 2), the **next**
`selectProvider(chatId, tier)` swaps to `PROVIDER_FALLBACK` for the rest of the
conversation. Degradation thus changes routing across calls, never mid-flight.

### `toolCall` shape differences (Anthropic vs OpenAI-compatible)

| Step | `AnthropicProvider` | `OpenAICompatibleProvider` |
| --- | --- | --- |
| Transport | `@anthropic-ai/sdk` `messages.create` | raw `fetch` `POST ${baseUrl}/chat/completions` |
| Tool input | `tool_use.input` already an object | `tool_calls[0].function.arguments` is a JSON **string** → `JSON.parse` |
| Validation | `tool.inputSchema.safeParse(input)` | `tool.inputSchema.safeParse(JSON.parse(args))` |
| System prompt | `buildSystemBlocks` → `TextBlockParam[]` with per-block `cache_control` | `flattenSystemPrompt` → single string in `{ role:'system' }` |
| History | `buildMessages` uses `options.history` directly | `buildMessages` **throws** if `history` is set |
| Wrong/missing tool | `ProviderSchemaError` | `ProviderSchemaError` |
| `stop_reason: max_tokens` | `OutputTruncatedError` (thrown **before** zod parse) | _(not implemented)_ |
| Per-model tuning | `tuningParams`: `temperature` dropped on Opus 4.7+, `effort` (`output_config.effort`) only Sonnet 4.6 / Opus 4.5+, `thinking` `disabled`/`adaptive`; `strict` tool forwarded | _(none — flat body)_ |
| Caller abort (`abortSignal` / kill-switch) | `APIUserAbortError` → `OutputTruncatedError` (NOT degradation); precedes the generic `APIError` branch | _(not implemented)_ |
| `max_tokens` default when caller omits | `DEFAULT_MAX_TOKENS = 8000` | provider default |
| 429 | `RateLimitedError` | `RateLimitedError` |
| Other non-ok / network | `UpstreamError(status ?? 502)` | `UpstreamError(status)` / `UpstreamError(..., 502)` |

Both return `ProviderToolResult<T> = { input, toolUseId, model, introText?, usage?, stopReason? }`.
`OpenAICompatibleProvider` mints a synthetic `toolUseId` when the upstream
omits one (`openaiCompatible.ts:163`).

### Per-block prompt caching

`ProviderCallOptions.systemPrompt` is `string | SystemBlock[]`.
A `cache_control` breakpoint caches the cumulative **prefix**, so the
`buildSystemBlocks` helper in `anthropic.ts` marks the **last** `cache: true`
block — that single breakpoint caches the whole static system prefix (all
reference blocks; the whole system prompt is byte-frozen, with dynamic data in
the user message). The tool definition takes a second breakpoint (Anthropic
allows 4 per request). Non-caching providers flatten via `flattenSystemPrompt`.

### Two-layer error taxonomy

| Layer | Errors | Source | Counts toward degradation? |
| --- | --- | --- | --- |
| Transport | `RateLimitedError` (429), `UpstreamError(status)` | `src/lib/llm/errors.ts` | **No** |
| Model output | `ProviderSchemaError`, `ProviderRefusalError`, `OutputTruncatedError` | `src/lib/providers/types.ts` | Only `ProviderSchemaError` (`OutputTruncatedError` does **not** trip it) |

### Legacy `src/lib/llm/*` path (still live)

`getLLMClient()` returns `realClient` when `ANTHROPIC_API_KEY` is set, else the
`stubClient` (canned fixture Scores; used in keyless dev / stub-mode). `realClient`
(`client.ts`) hardcodes `claude-sonnet-4-6` and the `render_score` tool, with
ephemeral cache on system + tool and `maxRetries: 3`; a text-only response is
treated as a refusal → `UpstreamError(500)`. `realClient` now honors a
per-request `max_tokens` (`req.maxTokens ?? MAX_TOKENS`); `LLMCompleteRequest`
and `completeWithRetry` thread it through so the chat route can bound the
free-tier legacy fall-through (`BOUNDED_EMIT_CEILING`, `maxRetries: 1`).
`completeWithRetry` (`messages.ts`) wraps the client with a semantic-retry loop
that, on a `validateScore` `ValidationError`, appends an assistant turn +
`tool_result(is_error:true)` referencing `toolUseId` and retries (default 2
extra attempts), persisting only the final successful exchange.

## Invariants & gotchas

- **`callWithFailover` does not fail over.** Despite the name it is
  single-attempt: it records telemetry on `ProviderSchemaError` and re-throws.
  Active fallback requires the *caller* to catch and re-invoke `selectProvider`;
  degradation only changes routing on the **subsequent** call. The live
  consumer `runEditIntraMeasure` wraps `ProviderSchemaError` into
  `EditIntraMeasureError` and propagates (the `catch` after its
  `callWithFailover`) — it does **not** re-select a provider.
- **Only `ProviderSchemaError` trips degradation.** `reportProviderFailure` is
  called solely on `ProviderSchemaError`. A provider that is rate-limited,
  5xx-ing (`RateLimitedError` / `UpstreamError`), or truncated
  (`OutputTruncatedError`) **never** trips the ladder, so a fully-down provider
  does not auto-failover via this mechanism.
- **Degradation overrides sticky but the override isn't re-stickied.** In
  `selectProvider` the degradation swap happens after reading sticky; because
  `stickyName` is already set, the `if (chatId && !stickyName) setSticky(...)`
  guard is false, so the fallback is recomputed every call (re-derived from the
  still-degraded sticky provider). Correctness holds only because degradation
  state persists alongside sticky.
- **In-memory, single-process state.** Both `sticky.ts` `store` and
  `degradation.ts` `failureCounts` are module-level `Map`s with no
  eviction/persistence. They leak across requests within a process, reset on
  restart, and are **not** shared across serverless instances.
  `clearStickyForChat(chatId)` must be called on conversation delete; it lazily
  `import('./degradation')` to clear both maps in lockstep (the lazy import
  avoids a circular dependency).
- **OpenAI-compatible providers reject history-mode.**
  `OpenAICompatibleProvider.buildMessages` throws a plain `Error`
  (`'history-mode toolCall not yet implemented'`, not a typed provider error) if
  `options.history` is set. Only Anthropic supports multi-turn history;
  Groq/Ollama are single-shot (`system` + `userText`) only.
- **Capabilities are partly aspirational.** `promptCaching`, `nativeToolUse`,
  `strictJsonSchema`, `estimatedCallMs` are declared but not consumed by
  `select`/`callWithFailover`. `estimatedCallMs` is documented as a deadline
  guard; Groq's comment notes prompt caching exists upstream but is "not wired
  in PR C". Do not assume a capability flag changes routing.
- **`claude-sonnet-4-6` is duplicated in three places.** `client.ts` (`MODEL`),
  `anthropic.ts` (`options.modelOverride ?? 'claude-sonnet-4-6'` fallback in both
  `toolCall` and `textStream`), and `registry.ts` (`anthropic.medium`). These are
  three manual sync points. Note `selectProvider` always passes a concrete
  `model`, and `runEditIntraMeasure` forwards it via `modelOverride`
  (`input.modelOverride ?? selected.model`), so the `anthropic.ts` literal only
  bites if a caller omits both.
- **Per-model capability gating is name-pattern based.** `anthropic.ts`'s
  `modelAcceptsTemperature` (`!/opus-4-[789]/`) and `modelSupportsEffort`
  (`/sonnet-4-6/ || /opus-4-[5-9]/`) decide which tuning params are forwarded by
  matching on the resolved model string. Renaming or adding a model family means
  updating these regexes, not just the `REGISTRY` — a miss silently sends a 400
  param (or drops a supported one). The post-parse zod validation is unaffected.
- **`apiKeyOverride` is a one-shot client.** `AnthropicProvider.getClient(override)`
  builds a throwaway client when `apiKeyOverride` is set, bypassing the memoized
  env-key client, so a long-lived stream isn't broken when the route restores
  `process.env` after a debug-panel key swap. The memoized client is also
  re-created when `ANTHROPIC_API_KEY` changes (`_cachedKey` check).
- **Two parallel LLM stacks coexist.** `src/lib/providers/*` (multi-provider
  tool-call abstraction) and `src/lib/llm/*` (`getLLMClient` → `realClient` /
  `stubClient`, single `render_score` path with `completeWithRetry`). The
  providers layer reuses `llm/wrapper.ts`'s `ChatMessage` and `llm/errors.ts`'s
  transport errors but has its own client lifecycle.

## How to extend / common tasks

- **Add a new OpenAI-compatible provider** (e.g. xAI): subclass
  `OpenAICompatibleProvider` like `groq.ts`, supplying `name`, `baseUrl`
  (ending `/v1`), `apiKeyEnv`, `defaultModel`, `capabilities`. Add the name to
  the `ProviderName` union in `types.ts`, the `VALID_PROVIDERS` array and the
  `instantiate` switch in `select.ts`, a `REGISTRY` block + `PROVIDER_API_KEY_ENV`
  entry + (if not always-configured) `isProviderConfigured` handling in
  `registry.ts`. TypeScript will flag the missing `instantiate` case and
  `REGISTRY` key for you.
- **Change a tier's model**: edit the `REGISTRY` entry in `registry.ts`. If
  it's `anthropic.medium`, also check the `claude-sonnet-4-6` literals in
  `anthropic.ts` and `client.ts`. If the new model belongs to a different family,
  also revisit the name-pattern gates `modelAcceptsTemperature` /
  `modelSupportsEffort` in `anthropic.ts` so the right tuning params are sent.
- **Cut cost on a deterministic structured-emit call**: pass `effort: 'low'` +
  `thinking: 'disabled'` in `ProviderCallOptions` (silently dropped on models
  that don't support them), and `strict: true` on the `ProviderTool` for a
  small-enough schema (grammar-constrained — Anthropic rejects very large
  schemas, e.g. `render_score`). The post-parse zod stays the backstop.
- **Wire active failover into a handler**: catch `ProviderSchemaError` (or
  `UpstreamError`) from `callWithFailover`, re-invoke `selectProvider(tier, chatId)`
  (which will now return the fallback for `ProviderSchemaError` paths once the
  threshold is hit), and retry. No handler does this today.
- **Constrain output more tightly on a local model**: extend
  `OpenAICompatibleConfig.extendRequestBody` like `ollama.ts` does with
  `body.format = tool.inputSchemaJson`.
- **Share a cacheable system fragment across handlers**: pass `SystemBlock[]`
  with `cache: true` on the shared block(s), keeping ≤ 3 cached blocks so the
  tool definition keeps the 4th Anthropic cache slot.

## Testing

| File | Covers |
| --- | --- |
| `tests/unit/providers/select.test.ts` | sticky, env routing, unconfigured fallback, auto-failover after 2 schema failures |
| `tests/unit/providers/degradation.test.ts` | threshold, per-chat/tier/provider isolation, `DEGRADATION_THRESHOLD = 2` |
| `tests/unit/providers/anthropic.test.ts` | mocked SDK: native `tool_use` parse, error mapping, usage |
| `tests/unit/providers/openaiCompatible.test.ts` | mocked fetch: JSON-string args parse, error mapping |
| `tests/unit/providers/ollama.test.ts` | grammar-constrained `format` extension |
| `tests/unit/providers/systemBlocks.test.ts` | `toSystemBlocks` / `flattenSystemPrompt` |
| `tests/unit/llm/*` | legacy `render_score` path |

Tests must call `_resetSticky()` / `_resetDegradation()` between cases because
the maps are module-level and persist within a process. `AnthropicProvider._reset()`
clears the memoized SDK client.

## Related files / See also

- `src/lib/orchestrator/README.md` — the orchestrator that consumes this layer.
- `src/lib/orchestrator/handlers/editIntraMeasure.ts` — canonical
  `selectProvider` + `callWithFailover` consumer (medium tier).
- `src/lib/llm/renderScoreTool.ts`, `src/lib/llm/systemPrompt.ts`,
  `src/lib/llm/stubClient.ts` — the legacy `render_score` path's tool,
  prompt, and fixture client.
- `src/lib/music/validateScore.ts` — the `validateScore` that
  `completeWithRetry` re-prompts on.
