import { describe, it, expect } from 'vitest'
import { toOpenAIMessages } from '@/lib/providers/openaiConversation'
import type { NeutralMessage } from '@/lib/providers/conversation'

describe('toOpenAIMessages (neutral IR -> OpenAI chat messages)', () => {
  it('maps a user text turn to a user message', () => {
    const h: NeutralMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    expect(toOpenAIMessages(h)).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('maps assistant [text, tool_use] to one assistant message with tool_calls', () => {
    const h: NeutralMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'here' },
          { type: 'tool_use', id: 'tc_1', name: 'render_score', input: { key: 'C' } },
        ],
      },
    ]
    expect(toOpenAIMessages(h)).toEqual([
      {
        role: 'assistant',
        content: 'here',
        tool_calls: [
          { id: 'tc_1', type: 'function', function: { name: 'render_score', arguments: '{"key":"C"}' } },
        ],
      },
    ])
  })

  it('uses null content for an assistant turn that is tool_use only', () => {
    const h: NeutralMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tc_2', name: 'render_score', input: {} }],
      },
    ]
    const out = toOpenAIMessages(h)
    expect(out[0].content).toBeNull()
    expect(out[0].tool_calls).toHaveLength(1)
  })

  it('maps a user tool_result to a role:tool message keyed by tool_call_id', () => {
    const h: NeutralMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'tc_1', isError: true, content: 'bad' }],
      },
    ]
    expect(toOpenAIMessages(h)).toEqual([{ role: 'tool', tool_call_id: 'tc_1', content: 'bad' }])
  })

  it('expands a refinement turn [tool_result, text] into a tool message then a user message (order preserved)', () => {
    const h: NeutralMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'tc_1', content: 'edited' },
          { type: 'text', text: 'now minor' },
        ],
      },
    ]
    expect(toOpenAIMessages(h)).toEqual([
      { role: 'tool', tool_call_id: 'tc_1', content: 'edited' },
      { role: 'user', content: 'now minor' },
    ])
  })

  it('produces a valid ordered sequence for a full scoreRetry-shaped history', () => {
    const h: NeutralMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'make a scale' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'tc_9', name: 'render_score', input: { key: 'G' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'tc_9', isError: true, content: 'failed validation' }],
      },
    ]
    const out = toOpenAIMessages(h)
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    // The tool message answers the assistant's tool_call by id.
    expect((out[1].tool_calls as Array<{ id: string }>)[0].id).toBe('tc_9')
    expect(out[2].tool_call_id).toBe('tc_9')
  })

  it('handles empty history', () => {
    expect(toOpenAIMessages([])).toEqual([])
  })
})
