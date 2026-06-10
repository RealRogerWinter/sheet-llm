---
title: Adding an LLM Provider
subsystem: providers-llm
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-10
verified_against: ccacc19
source_paths:
  - src/lib/providers/types.ts
  - src/lib/providers/registry.ts
  - src/lib/providers/select.ts
  - src/lib/providers/sticky.ts
  - src/lib/providers/degradation.ts
  - src/lib/providers/callWithFailover.ts
  - src/lib/providers/systemBlocks.ts
  - src/lib/providers/openaiCompatible.ts
  - src/lib/providers/groq.ts
  - src/lib/providers/ollama.ts
  - src/lib/providers/anthropic.ts
  - src/lib/orchestrator/keyStatus.ts
  - src/lib/providers/modelClass.ts
  - src/lib/orchestrator/handlers/editIntraMeasure.ts
related:
  - providers-llm
  - orchestrator
  - local-models
---

A step-by-step recipe for adding a new LLM provider to `src/lib/providers/*` so
that orchestrator handlers can route a tier's tool-use call to it. For the
architecture, error taxonomy, and routing internals see
[`../subsystems/providers-llm.md`](../subsystems/providers-llm.md) — this guide
is the procedural counterpart and assumes that mental model.

There are two shapes of provider:

| Shape | When | Base to reuse |
| --- | --- | --- |
| **OpenAI Chat-Completions-compatible** | Endpoint speaks `POST /v1/chat/completions` with `tools[].function` + `tool_calls[].function.arguments` (Groq, xAI, OpenAI, Together, Fireworks, local Ollama/LM Studio) | `OpenAICompatibleProvider` (`src/lib/providers/openaiCompatible.ts`) — subclass it, supply config only |
| **Bespoke SDK** | Native SDK with a non-OpenAI tool shape (e.g. Anthropic, Google) | Implement the `LLMProvider` interface from scratch like `src/lib/providers/anthropic.ts` |

The OpenAI-compatible path is by far the common case and needs **no new class
logic** — `groq.ts` (29 lines) and `ollama.ts` (40 lines) are the templates.

---

## The interface you implement

A provider satisfies `LLMProvider` (`src/lib/providers/types.ts:176`):

```ts
interface LLMProvider {
  name: ProviderName
  toolCall<T>(tool: ProviderTool<T>, options: ProviderCallOptions): Promise<ProviderToolResult<T>>
  textStream?(options: ProviderCallOptions): AsyncIterable<TextStreamEvent>   // optional
}
```

- `toolCall` is the only required method. It MUST force the model to call
  `tool.name`, parse the result, **zod-validate** it against
  `tool.inputSchema`, and return `ProviderToolResult<T>`
  (`{ input, toolUseId, model, introText?, usage?, stopReason? }`).
- `textStream` is optional. Only `AnthropicProvider` implements it today
  (consumed by `runConverse`); the OpenAI-compatible base does **not** stream.
  Callers check for its presence and fall through when absent.

### The error contract (load-bearing)

Your `toolCall` MUST map failures onto exactly these classes, because routing
and degradation telemetry key off the type — not the message:

| Condition | Throw | Defined in | Trips degradation? |
| --- | --- | --- | --- |
| Model returned text / wrong tool / unparseable args / zod-invalid input | `ProviderSchemaError` | `src/lib/providers/types.ts:195` | **Yes** (only this) |
| Model refused | `ProviderRefusalError` | `src/lib/providers/types.ts:202` | No |
| Response truncated (`stop_reason === 'max_tokens'`) — throw BEFORE the zod parse | `OutputTruncatedError` | `src/lib/providers/types.ts` | No |
| HTTP 429 | `RateLimitedError` | `src/lib/llm/errors.ts` | No |
| Other non-2xx / network / no message | `UpstreamError(message, status)` | `src/lib/llm/errors.ts` | No |

Getting this wrong silently breaks the failover ladder: only
`ProviderSchemaError` increments `failureCounts` via
`reportProviderFailure` (`src/lib/providers/callWithFailover.ts:34`), so a
provider that mis-maps a malformed-output failure to `UpstreamError` will never
auto-failover. The `OpenAICompatibleProvider` base already does all of this
mapping correctly — another reason to subclass it.

### System-prompt handling

`ProviderCallOptions.systemPrompt` is `string | SystemBlock[]`. If you write a
bespoke provider:

- Per-block prompt caching (Anthropic ephemeral): a `cache_control` breakpoint
  caches the cumulative prefix, so mark the **last** `cache: true` block to cache
  the whole static prefix in one breakpoint. See `buildSystemBlocks`
  (`src/lib/providers/anthropic.ts`); Anthropic allows 4 breakpoints per request
  (the tool definition consumes one).
- No per-block caching: call `flattenSystemPrompt(options.systemPrompt)`
  (`src/lib/providers/systemBlocks.ts:18`) to collapse the blocks into one
  blank-line-joined string. This is what the OpenAI-compatible base does.

### History mode

`ProviderCallOptions.history` (multi-turn `ChatMessage[]`) is only supported by
`AnthropicProvider`. `OpenAICompatibleProvider.buildMessages` throws a plain
`Error` if `history` is set (`src/lib/providers/openaiCompatible.ts:195`). If
your provider must support refinement turns you have to implement
`ChatMessage` → OpenAI message conversion (tool_use / tool_result blocks)
yourself; otherwise it is single-shot (`system` + `userText`) only.

---

## Recipe A — OpenAI-compatible provider (the common case)

Worked example: adding **xAI** (`grok`). Five files, all type-checked end to end.

### 1. Widen the `ProviderName` union — `src/lib/providers/types.ts:5`

```ts
export type ProviderName = 'anthropic' | 'groq' | 'ollama' | 'xai'
```

This single edit makes TypeScript flag every other site that must be updated
(the `instantiate` switch, `REGISTRY`, `PROVIDER_API_KEY_ENV`) as a compile
error — lean on it as your checklist.

### 2. Write the provider subclass — `src/lib/providers/xai.ts`

Copy `src/lib/providers/groq.ts` verbatim and change the config. The base class
does the transport, parse, zod-validate, error-mapping, and usage mapping:

```ts
import { OpenAICompatibleProvider } from './openaiCompatible'
import type { ProviderCapabilities } from './types'

export const XAI_CAPABILITIES: ProviderCapabilities = {
  promptCaching: false,
  nativeToolUse: 'native',
  strictJsonSchema: true,
  estimatedCallMs: 1_000,
}

export class XaiProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      name: 'xai',
      baseUrl: 'https://api.x.ai/v1',   // MUST end in /v1 (no trailing slash); base appends /chat/completions
      apiKeyEnv: 'XAI_API_KEY',
      defaultModel: 'grok-3-mini',
      capabilities: XAI_CAPABILITIES,
    })
  }
}
```

The subclass exists mainly so callers can `instanceof XaiProvider` and so a
sane `defaultModel` is set if the registry omits a tier. For a local /
grammar-constrained backend, add an `extendRequestBody` hook the way
`src/lib/providers/ollama.ts:31` injects `body.format = tool.inputSchemaJson`.

### 3. Register models + key env — `src/lib/providers/registry.ts`

Add a tier→model block to `REGISTRY` (`registry.ts:28`) and an entry to
`PROVIDER_API_KEY_ENV` (`registry.ts:77`):

```ts
xai: {
  small:  { modelId: 'grok-3-mini', capabilities: { ...XAI_CAPS } },
  medium: { modelId: 'grok-3',      capabilities: { ...XAI_CAPS } },
  large:  { modelId: 'grok-3',      capabilities: { ...XAI_CAPS } },
},
```

```ts
export const PROVIDER_API_KEY_ENV: Record<ProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  groq: 'GROQ_API_KEY',
  ollama: '',          // keyless
  xai: 'XAI_API_KEY',
}
```

`REGISTRY` is `Record<ProviderName, ...>`, so step 1 forces this key to exist.
Every tier must have an entry — `selectProvider` hard-defaults to `anthropic`
if `getModelEntry(chosen, tier)` is `undefined` (`select.ts:96`), which would
silently route your provider's traffic to Anthropic.

`isProviderConfigured` (`registry.ts:83`) returns `true` for `ollama`
unconditionally (local, keyless) and otherwise requires the
`PROVIDER_API_KEY_ENV` var to be present and non-empty. A keyed provider with an
empty `apiKeyEnv` string would be treated as "never configured" → always falls
back. If your provider is keyless add it to the `ollama` branch of
`isProviderConfigured`.

### 4. Teach the selector to instantiate it — `src/lib/providers/select.ts`

Two edits:

```ts
// select.ts:7 — import
import { XaiProvider } from './xai'

// select.ts:15 — add to the runtime validator (gates PROVIDER_<TIER> env parsing)
const VALID_PROVIDERS: ReadonlyArray<ProviderName> = ['anthropic', 'groq', 'ollama', 'xai']

// select.ts:37 — add the lazy-instantiate case (memoized in the module `instances` map)
case 'xai': {
  const p = new XaiProvider()
  instances.xai = p
  return p
}
```

The `switch (name)` in `instantiate` is exhaustive over `ProviderName`, so TS
errors until you add the case. `VALID_PROVIDERS` is a **separate** runtime
guard (`isProviderName`, `select.ts:17`) used to validate the `PROVIDER_<TIER>`
env string — TypeScript will NOT flag a missing entry here, so it is the one
step the compiler can't enforce. Forgetting it means `PROVIDER_SMALL=xai` is
silently ignored and falls through to `anthropic`.

### 5. Debug-panel key status — `src/lib/orchestrator/keyStatus.ts:40`

`isValidProvider` is hand-maintained (not exhaustive-checked). Add your name so
the per-tier key indicator reports correctly:

```ts
function isValidProvider(name: string): name is ... {
  return name === 'anthropic' || name === 'groq' || name === 'ollama' || name === 'xai'
}
```

### Checklist (Recipe A)

| # | File | Edit | Compiler-enforced? |
| --- | --- | --- | --- |
| 1 | `src/lib/providers/types.ts:5` | Add name to `ProviderName` union | n/a (the source of truth) |
| 2 | `src/lib/providers/<name>.ts` | New subclass of `OpenAICompatibleProvider` | — |
| 3 | `src/lib/providers/registry.ts:28` | `REGISTRY[name]` block (all 3 tiers) | ✅ (Record key) |
| 3 | `src/lib/providers/registry.ts:77` | `PROVIDER_API_KEY_ENV[name]` | ✅ (Record key) |
| 3 | `src/lib/providers/registry.ts:83` | `isProviderConfigured` branch *(keyless only)* | ❌ |
| 4 | `src/lib/providers/select.ts:7` | Import the class | ✅ (via switch) |
| 4 | `src/lib/providers/select.ts:15` | `VALID_PROVIDERS` array | ❌ **easy to miss** |
| 4 | `src/lib/providers/select.ts:37` | `instantiate` switch case | ✅ (exhaustive) |
| 5 | `src/lib/orchestrator/keyStatus.ts:40` | `isValidProvider` branch | ❌ |

The two ❌ runtime guards (`VALID_PROVIDERS`, `isValidProvider`) are the only
sites the type checker won't catch — verify them by hand.

---

## Recipe B — bespoke SDK provider

When the upstream isn't OpenAI-compatible, implement `LLMProvider` directly.
`src/lib/providers/anthropic.ts` is the reference. In addition to all of
Recipe A's registration steps (1, 3, 4, 5), you must implement:

- `toolCall<T>` — call the SDK with the tool forced (`tool_choice`), find the
  tool-use block, `tool.inputSchema.safeParse(...)`, and on any
  wrong/missing/invalid result throw `ProviderSchemaError`. Map SDK rate-limit
  and API errors to `RateLimitedError` / `UpstreamError` (see
  `anthropic.ts:140`). Map usage onto
  `{ inputTokens, cachedInputTokens, outputTokens }`.
- Mint a `toolUseId`. Native SDKs usually supply one; if not, synthesize like
  `openaiCompatible.ts:163` (`crypto.randomUUID()`-derived).
- Client lifecycle: memoize the SDK client keyed on the env key, and honor
  `options.apiKeyOverride` by building a **throwaway** client so a long-lived
  stream isn't broken when the route restores `process.env` after a debug-panel
  key swap (`anthropic.ts:84`). Expose a `_reset()` test hook.
- `textStream` only if the provider must back the streaming converse path;
  otherwise omit it.

---

## How a handler consumes your provider (don't change this)

Once registered, no handler edits are needed — routing is env-driven. The
canonical consumer is the intra-measure edit handler:

```ts
// src/lib/orchestrator/handlers/editIntraMeasure.ts:1175
const selected = selectProvider(
  resolveModelClass({ callType: 'edit', complexity: input.classification.complexity }),
  input.chatId,
)
// ...
toolResult = await callWithFailover(
  { ...selected, chatId: input.chatId },
  { name, description, inputSchema, inputSchemaJson },
  { systemPrompt, userText, toolChoice: 'required', maxTokens, temperature: 0 },
)
```

`resolveModelClass` (SHE-19, `src/lib/providers/modelClass.ts`) defaults to
`small` (Haiku) and escalates to `medium` (Sonnet) when
`complexity === 'complex'`. Hardcoding a tier string like `'medium'` is the
legacy pattern — new handlers should route through `resolveModelClass` so the
tier follows the complexity signal rather than being fixed.

`selectProvider(tier, chatId)` (`src/lib/providers/select.ts:76`) resolves
`sticky ?? PROVIDER_<TIER> ?? 'anthropic'`, applies the degradation override and
the unconfigured-fallback, then stickies the choice for the rest of the chat.
`callWithFailover` (`src/lib/providers/callWithFailover.ts:21`) is
**single-attempt** despite the name — it records degradation telemetry on
`ProviderSchemaError` and re-throws; it does not re-select. See
[`../subsystems/providers-llm.md`](../subsystems/providers-llm.md) for the full
resolution order and the degradation ladder.

---

## Env wiring

| Var | Default | Effect |
| --- | --- | --- |
| `PROVIDER_SMALL` | `anthropic` | Provider for the `small` tier (classifier-grade calls) |
| `PROVIDER_MEDIUM` | `anthropic` | Provider for the `medium` tier (edits, simple gen) |
| `PROVIDER_LARGE` | `anthropic` | Provider for the `large` tier (complex gen) |
| `PROVIDER_FALLBACK` | `anthropic` | Provider used when the chosen one is unconfigured or has degraded |
| `<NAME>_API_KEY` | unset | Your provider's key (the `PROVIDER_API_KEY_ENV[name]` var). Keyless backends use `''` |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Example of a provider-specific base-URL override (read in `ollama.ts:27`) |

An unrecognized `PROVIDER_<TIER>` value (not in `VALID_PROVIDERS`) is silently
ignored and falls through to `anthropic` (`select.ts:21`) — this is the failure
mode when you skip checklist step 4's `VALID_PROVIDERS` edit. See
[`../local-models.md`](../local-models.md) for a full hybrid-routing `.env`
example (local classifier + cloud generation).

---

## Tests

Mirror the existing per-provider suites under `tests/unit/providers/`:

| Add a test like | To cover |
| --- | --- |
| `tests/unit/providers/openaiCompatible.test.ts` | (OpenAI-compatible) mocked `fetch`: Bearer auth, `tools`/`tool_choice` body shape, JSON-string `arguments` parse, usage mapping, `ProviderSchemaError` on bad JSON / zod-fail / wrong tool, 429→`RateLimitedError`, non-2xx→`UpstreamError`, missing-key→`UpstreamError`, `modelOverride`, `extendRequestBody` |
| `tests/unit/providers/ollama.test.ts` | a grammar/`extendRequestBody`-style extension if you add one |
| `tests/unit/providers/select.test.ts` | add a case: `PROVIDER_SMALL=<name>` + key set routes to your provider with the right `model`; key missing falls back to `PROVIDER_FALLBACK` |
| `tests/unit/providers/anthropic.test.ts` | (bespoke SDK) mocked SDK: native tool parse, error mapping, usage, `apiKeyOverride` one-shot client, `_reset()` |

Patterns to copy from `tests/unit/providers/openaiCompatible.test.ts`: stub the
key with `vi.stubEnv`, replace `globalThis.fetch` with a `vi.fn()`, and build
responses with the `chatCompletionsResponse` helper. For `select.test.ts`,
call `_resetSticky()` (`src/lib/providers/sticky.ts:36`) and `_resetDegradation()`
(`src/lib/providers/degradation.ts:47`) in `beforeEach`/`afterEach` — both
stores are module-level `Map`s that persist within a process and will leak
state across cases otherwise.

A no-op smoke check that nothing else regressed:

```bash
npx vitest run tests/unit/providers
```

---

## Gotchas specific to adding a provider

- **`VALID_PROVIDERS` and `isValidProvider` are not exhaustive-checked.** They
  are the only two sites the compiler won't flag. Miss them and your provider is
  silently unreachable via env / mis-reported in the debug panel.
- **Every tier needs a `REGISTRY` entry.** A missing tier silently routes to
  `anthropic` (`select.ts:96`), not an error.
- **`baseUrl` must end in `/v1` with no trailing slash.** The base class
  appends `/chat/completions` (`openaiCompatible.ts:105`).
- **Capability flags are declarative.** `promptCaching`, `nativeToolUse`,
  `strictJsonSchema`, `estimatedCallMs` are recorded but **not** consumed by
  `select`/`callWithFailover` today. Setting `nativeToolUse: 'native'` does not
  enable anything — it documents intent. Don't rely on a flag to change routing.
- **Map output failures to `ProviderSchemaError`, not `UpstreamError`.** Only
  the former trips the degradation ladder; mis-mapping defeats auto-failover.
- **State is in-memory and single-process.** Sticky + degradation maps don't
  persist or share across serverless instances; nothing for a new provider to do
  but be aware your provider's stickiness resets on restart.

## See also

- [`../subsystems/providers-llm.md`](../subsystems/providers-llm.md) — routing
  internals, error taxonomy, the degradation ladder, and the legacy
  `src/lib/llm/*` stack.
- [`../local-models.md`](../local-models.md) — Ollama setup + hybrid-routing
  `.env` recipes.
- `src/lib/providers/groq.ts`, `src/lib/providers/ollama.ts` — the two
  OpenAI-compatible subclass templates.
- `src/lib/providers/anthropic.ts` — the bespoke-SDK reference implementation.
- `src/lib/orchestrator/handlers/editIntraMeasure.ts:1174` — the canonical
  `selectProvider` + `callWithFailover` consumer.
