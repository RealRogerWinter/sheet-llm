import Anthropic from '@anthropic-ai/sdk'
import type { LLMClient, LLMCompleteRequest, LLMResponse } from './wrapper'
import type { Score } from '@/lib/music/types'
import { renderScoreTool, RENDER_SCORE_TOOL_NAME } from './renderScoreTool'
import { SYSTEM_PROMPT } from './systemPrompt'
import { RateLimitedError, UpstreamError, ProviderNotConfiguredError } from './errors'

const MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 8_000 // M25-PR-6: render_score emit floor (see tokenBudget.test.ts); was 2000 — the legacy fall-through path truncated big pieces

let _anthropic: Anthropic | undefined
let _cachedKey: string | undefined

function getAnthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new ProviderNotConfiguredError('Anthropic', 'ANTHROPIC_API_KEY')
  }
  if (!_anthropic || _cachedKey !== apiKey) {
    _anthropic = new Anthropic({ apiKey, maxRetries: 3 })
    _cachedKey = apiKey
  }
  return _anthropic
}

export const realClient: LLMClient = {
  async complete(req: LLMCompleteRequest): Promise<LLMResponse> {
    const anthropic = getAnthropic()

    let response
    try {
      response = await anthropic.messages.create({
        model: MODEL,
        // Per-request cap (free-tier legacy bound) falls back to the default.
        max_tokens: req.maxTokens ?? MAX_TOKENS,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [
          {
            ...renderScoreTool,
            cache_control: { type: 'ephemeral' },
          },
        ] as unknown as Anthropic.Tool[],
        tool_choice: { type: 'tool', name: RENDER_SCORE_TOOL_NAME },
        // ChatMessage already matches Anthropic's MessageParam shape.
        messages: req.messages as unknown as Anthropic.MessageParam[],
      })
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) {
        throw new RateLimitedError(e.message)
      }
      if (e instanceof Anthropic.APIError) {
        throw new UpstreamError(e.message, e.status ?? 502)
      }
      const message = e instanceof Error ? e.message : 'Unknown Anthropic SDK error'
      throw new UpstreamError(message, 502)
    }

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )
    if (!toolUse) {
      // Legitimate refusal: text-only response with no tool call.
      const text = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === 'text',
      )
      throw new UpstreamError(
        text?.text ?? 'Claude did not call render_score and returned no text',
        500,
      )
    }
    if (toolUse.name !== RENDER_SCORE_TOOL_NAME) {
      throw new UpstreamError(`Unexpected tool name: ${toolUse.name}`, 500)
    }

    const score = toolUse.input as Score

    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === 'text',
    )
    const introText = textBlock?.text

    return { score, introText, toolUseId: toolUse.id }
  },
}
