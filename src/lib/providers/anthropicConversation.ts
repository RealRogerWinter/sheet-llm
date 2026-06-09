/**
 * Anthropic adapter for the neutral conversation IR (SHE-17).
 *
 * `toAnthropicMessages` is the inverse of `fromAnthropicMessages`, and the
 * pair is the load-bearing invariant guarded by `conversation.test.ts`:
 *
 *     toAnthropicMessages(fromAnthropicMessages(x))  ===  x   (byte-identical)
 *
 * Byte-identity matters for confidence, not for prod cache cost — the
 * `messages` array carries no `cache_control`, so it is never cached
 * (breakpoints live only on the system+tool prefix; see
 * `anthropic.ts` buildSystemBlocks). The round-trip is therefore a
 * CORRECTNESS guard (tool_use/tool_result linkage, is_error presence)
 * that happens to also be byte-exact because the adapter reconstructs
 * blocks with the same field order the app already produces.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage } from '@/lib/llm/wrapper'
import type {
  NeutralAssistantBlock,
  NeutralMessage,
  NeutralUserBlock,
} from './conversation'

// ---------------------------------------------------------------------------
// neutral -> Anthropic
// ---------------------------------------------------------------------------

function userBlockToAnthropic(
  block: NeutralUserBlock,
): Anthropic.Messages.TextBlockParam | Anthropic.Messages.ToolResultBlockParam {
  if (block.type === 'text') {
    return { type: 'text', text: block.text }
  }
  // tool_result. Key order matches the app's construction sites exactly:
  //   no error  -> { type, tool_use_id, content }
  //   with error -> { type, tool_use_id, is_error, content }
  // Invariant: across this app `is_error` is only ever `true` or absent —
  // no site emits `is_error: false`. A future false-producer would
  // reconstruct in the error-branch order and so MUST be added to the
  // golden corpus (conversation.test.ts) to stay byte-faithful.
  if (block.isError !== undefined) {
    return {
      type: 'tool_result',
      tool_use_id: block.toolUseId,
      is_error: block.isError,
      content: block.content,
    }
  }
  return {
    type: 'tool_result',
    tool_use_id: block.toolUseId,
    content: block.content,
  }
}

function assistantBlockToAnthropic(
  block: NeutralAssistantBlock,
): Anthropic.Messages.TextBlockParam | Anthropic.Messages.ToolUseBlockParam {
  if (block.type === 'text') {
    return { type: 'text', text: block.text }
  }
  // tool_use. Key order: { type, id, name, input }.
  return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
}

/**
 * Convert neutral history to the Anthropic-native `ChatMessage[]` shape
 * (which is passed verbatim to `anthropic.messages.create`).
 */
export function toAnthropicMessages(
  history: ReadonlyArray<NeutralMessage>,
): ChatMessage[] {
  return history.map((msg): ChatMessage =>
    msg.role === 'user'
      ? { role: 'user', content: msg.content.map(userBlockToAnthropic) }
      : { role: 'assistant', content: msg.content.map(assistantBlockToAnthropic) },
  )
}

// ---------------------------------------------------------------------------
// Anthropic -> neutral
// ---------------------------------------------------------------------------

function userBlockFromAnthropic(
  block: Anthropic.Messages.TextBlockParam | Anthropic.Messages.ToolResultBlockParam,
): NeutralUserBlock {
  if (block.type === 'text') {
    return { type: 'text', text: block.text }
  }
  if (block.type === 'tool_result') {
    if (typeof block.content !== 'string') {
      // The app only ever produces string tool_result content. An array of
      // sub-blocks (or an absent content field) would lose data through this
      // adapter, so fail loudly instead — extend the IR
      // (NeutralToolResultBlock.content) if this ever fires. See
      // conversation.ts module note.
      const shape = block.content === undefined ? 'absent' : 'array'
      throw new Error(
        `fromAnthropicMessages: non-string tool_result content (${shape}) is not supported by the neutral IR`,
      )
    }
    const out: NeutralUserBlock = {
      type: 'tool_result',
      toolUseId: block.tool_use_id,
      content: block.content,
    }
    if (block.is_error !== undefined) out.isError = block.is_error
    return out
  }
  throw new Error(
    `fromAnthropicMessages: unsupported user content block type "${(block as { type: string }).type}"`,
  )
}

function assistantBlockFromAnthropic(
  block: Anthropic.Messages.TextBlockParam | Anthropic.Messages.ToolUseBlockParam,
): NeutralAssistantBlock {
  if (block.type === 'text') {
    return { type: 'text', text: block.text }
  }
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input as Record<string, unknown>,
    }
  }
  throw new Error(
    `fromAnthropicMessages: unsupported assistant content block type "${(block as { type: string }).type}"`,
  )
}

/**
 * Convert Anthropic-native history (`ChatMessage[]`, e.g. hydrated from
 * `content_json`) into the neutral IR. Throws on any block shape the IR
 * does not model, so unmodelled shapes surface immediately rather than
 * being silently dropped.
 */
export function fromAnthropicMessages(
  history: ReadonlyArray<ChatMessage>,
): NeutralMessage[] {
  return history.map((msg): NeutralMessage => {
    // Guard corrupt/foreign rows with a clear error instead of a raw
    // TypeError from `.map` on a non-array, or a silent mis-classification
    // of an unknown role. (Stored history is hydrated from content_json.)
    if (msg.role !== 'user' && msg.role !== 'assistant') {
      throw new Error(
        `fromAnthropicMessages: unsupported message role "${(msg as { role: string }).role}"`,
      )
    }
    if (!Array.isArray(msg.content)) {
      throw new Error('fromAnthropicMessages: message content is not an array')
    }
    return msg.role === 'user'
      ? { role: 'user', content: msg.content.map(userBlockFromAnthropic) }
      : { role: 'assistant', content: msg.content.map(assistantBlockFromAnthropic) }
  })
}
