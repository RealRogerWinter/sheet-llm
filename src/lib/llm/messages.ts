import type {
  AssistantContentBlock,
  ChatMessage,
  LLMClient,
  LLMCompleteRequest,
  LLMResponse,
} from './wrapper'
import { RENDER_SCORE_TOOL_NAME } from './renderScoreTool'
import { validateScore } from '@/lib/music/validateScore'
import { ValidationError } from '@/lib/music/errors'

export interface RetryOptions {
  /** Max retry attempts in addition to the initial call. Default 2. */
  maxRetries?: number
}

export interface CompleteResult {
  /** The successful LLM response (Score + introText + toolUseId). */
  response: LLMResponse
  /** The single assistant turn to persist (text + tool_use). */
  assistantTurn: ChatMessage
}

function buildAssistantTurn(response: LLMResponse): ChatMessage {
  const content: AssistantContentBlock[] = []
  if (response.introText) {
    content.push({ type: 'text', text: response.introText })
  }
  content.push({
    type: 'tool_use',
    id: response.toolUseId,
    name: RENDER_SCORE_TOOL_NAME,
    input: response.score as unknown as Record<string, unknown>,
  })
  return { role: 'assistant', content }
}

function buildRetryUserTurn(toolUseId: string, error: ValidationError): ChatMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        is_error: true,
        content: `Score failed validation: ${error.describe()}. Call render_score again with the fix; keep everything else unchanged.`,
      },
    ],
  }
}

/**
 * Call the LLM with semantic-retry. On ValidationError, appends a
 * tool_result(is_error: true) referencing the failed tool_use id and
 * retries — Claude can then see what it produced and correct it.
 *
 * Only the FINAL successful exchange is returned for persistence.
 * Failed retry intermediates are dropped on purpose: they bloat
 * tokens forever and would invalidate the prompt cache.
 */
export async function completeWithRetry(
  client: LLMClient,
  request: LLMCompleteRequest,
  options: RetryOptions = {},
): Promise<CompleteResult> {
  const maxRetries = options.maxRetries ?? 2
  let lastError: ValidationError | undefined
  let working = request.messages

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await client.complete({
      messages: working,
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    })
    const assistantTurn = buildAssistantTurn(response)
    try {
      validateScore(response.score)
      return { response, assistantTurn }
    } catch (e) {
      if (e instanceof ValidationError) {
        lastError = e
        working = [...working, assistantTurn, buildRetryUserTurn(response.toolUseId, e)]
        continue
      }
      throw e
    }
  }

  throw lastError ?? new ValidationError('Retry loop exhausted with no error captured', 'unknown')
}
