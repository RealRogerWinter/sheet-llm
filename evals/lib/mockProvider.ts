import type { Mock } from 'vitest'
import type { Score } from '@/lib/music/types'

/**
 * Helper for mock-tier eval cases that need to drive the
 * AnthropicProvider via the SDK mock. Tests `vi.mock('@anthropic-ai/sdk', ...)`
 * with `anthropicCreateMock` exported below — usage mirrors the
 * existing pattern in `tests/unit/orchestrator/generateComplexAndCompose.test.ts`
 * so we don't fork the mocking surface.
 *
 * The eval file owns the `vi.mock` call (which must be hoisted to the
 * top of the file). This module just gives canonical payload builders.
 */

/** The shape vitest needs to wire into `vi.mock('@anthropic-ai/sdk')`. */
export interface AnthropicSdkMockShape {
  default: new () => {
    messages: { create: Mock }
  }
}

/**
 * Build a canned Anthropic `messages.create` response that emits a
 * single `tool_use` block carrying the given Score as input.
 *
 * Mirrors the production response wire format: `content[]` carries
 * `tool_use`, `usage` carries token counts. The orchestrator's
 * `AnthropicProvider.toolCall` reads `id`, `name`, `input` off the
 * first `tool_use` block and `usage.cached_input_tokens` for cache hit
 * accounting.
 */
export function toolUseResponse(
  score: Score,
  opts: {
    toolName?: string
    toolUseId?: string
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
    /** Intro/explanation text emitted alongside the tool call. */
    introText?: string
  } = {},
): unknown {
  const content: unknown[] = []
  if (opts.introText) {
    content.push({ type: 'text', text: opts.introText })
  }
  content.push({
    type: 'tool_use',
    id: opts.toolUseId ?? 'toolu_eval_mock',
    name: opts.toolName ?? 'render_score',
    input: score,
  })
  return {
    content,
    usage: {
      input_tokens: opts.inputTokens ?? 500,
      output_tokens: opts.outputTokens ?? 800,
      cached_input_tokens: opts.cachedInputTokens,
    },
  }
}

/**
 * Build a canned classifier `messages.create` response carrying a
 * Classification payload via the classify tool. Lets eval cases stub
 * the classifier's decision deterministically so the case exercises
 * the dispatch decision rather than the LLM's labeling.
 */
export function classifyResponse(
  classification: Record<string, unknown>,
  opts: { toolUseId?: string; inputTokens?: number; outputTokens?: number } = {},
): unknown {
  return {
    content: [
      {
        type: 'tool_use',
        id: opts.toolUseId ?? 'toolu_eval_classify',
        name: 'classify',
        input: classification,
      },
    ],
    usage: {
      input_tokens: opts.inputTokens ?? 200,
      output_tokens: opts.outputTokens ?? 60,
    },
  }
}
