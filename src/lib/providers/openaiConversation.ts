/**
 * OpenAI-compatible adapter for the neutral conversation IR (SHE-17).
 *
 * Converts neutral history into OpenAI Chat Completions `messages`. Unlike
 * Anthropic (where tool_use / tool_result are content blocks INSIDE a
 * user/assistant turn), OpenAI models tool calls as fields on an assistant
 * message (`tool_calls`) and tool results as their own `role: 'tool'`
 * messages — so one neutral turn can expand to several OpenAI messages.
 *
 * Mapping:
 *   neutral assistant [text*, tool_use*]  -> 1 assistant msg
 *       { role:'assistant', content: <joined text | null>,
 *         tool_calls: [{ id, type:'function',
 *                        function:{ name, arguments: JSON.stringify(input) } }] }
 *   neutral user text                     -> { role:'user', content }
 *   neutral user tool_result              -> { role:'tool', tool_call_id, content }
 *
 * Ordering within a turn is preserved, so a refinement turn
 * [tool_result, text] becomes a `tool` message followed by a `user`
 * message — and because the neutral history is already ordered
 * user → assistant(tool_use) → user(tool_result), the `tool` message lands
 * after the assistant `tool_calls` it answers, as OpenAI requires.
 *
 * `is_error` has no OpenAI equivalent on a `tool` message; the failure text
 * already lives in `content` (the app embeds the validator complaint there),
 * so the model still sees it.
 *
 * Caller invariants (held by the sole producer, scoreRetry): the history is
 * built from validated/app-controlled data (not a persisted transcript), is
 * non-empty, and pairs each `tool_use` id with a following `tool_result`.
 * This adapter does not re-validate those; it is a structural mapping.
 */
import type { NeutralMessage } from './conversation'

export function toOpenAIMessages(
  history: ReadonlyArray<NeutralMessage>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []

  for (const msg of history) {
    if (msg.role === 'user') {
      for (const block of msg.content) {
        if (block.type === 'text') {
          out.push({ role: 'user', content: block.text })
        } else {
          out.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content })
        }
      }
      continue
    }

    // assistant: fold text blocks into `content`, tool_use blocks into
    // `tool_calls`, emitting a single assistant message.
    const texts: string[] = []
    const toolCalls: Array<Record<string, unknown>> = []
    for (const block of msg.content) {
      if (block.type === 'text') {
        texts.push(block.text)
      } else {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        })
      }
    }
    // OpenAI permits null content when tool_calls are present, but rejects a
    // message with neither content nor tool_calls — emit '' for that
    // (unreachable today) case so the adapter never produces an invalid msg.
    const content: string | null =
      texts.length > 0 ? texts.join('') : toolCalls.length > 0 ? null : ''
    const assistant: Record<string, unknown> = { role: 'assistant', content }
    if (toolCalls.length > 0) assistant.tool_calls = toolCalls
    out.push(assistant)
  }

  return out
}
