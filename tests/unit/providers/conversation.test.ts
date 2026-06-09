import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@/lib/llm/wrapper'
import {
  fromAnthropicMessages,
  toAnthropicMessages,
} from '@/lib/providers/anthropicConversation'
import type { NeutralMessage } from '@/lib/providers/conversation'

/**
 * Golden corpus: every Anthropic-native history block shape this app
 * actually constructs, captured byte-exact (including field ORDER) from
 * the real construction sites:
 *
 *  - first user turn ............ route.ts buildUserTurnForFirstCall
 *  - assistant intro + tool_use . llm/messages.ts buildAssistantTurn
 *  - assistant tool_use only .... same, no intro
 *  - refinement tool_result ..... route.ts buildUserTurnForRefinement (no is_error)
 *  - retry tool_result .......... llm/messages.ts buildRetryUserTurn / scoreRetry (is_error: true)
 *
 * If a new history shape appears in the app, add it here.
 */
const GOLDEN_CORPUS: ChatMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'Write a C major scale, one octave.' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Here is your score.' },
      {
        type: 'tool_use',
        id: 'toolu_01abc',
        name: 'render_score',
        input: { title: 'C Major Scale', key: 'C', measures: [{ index: 0 }] },
      },
    ],
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_02def',
        name: 'render_score',
        input: { title: 'Untitled', key: 'G', measures: [] },
      },
    ],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_01abc',
        content:
          'The user manually edited the score after your last response. The current state is:\n\n{}\n\nApply the next instruction to THIS current state, not your previous output.',
      },
      { type: 'text', text: 'now make it harmonic minor' },
    ],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_02def',
        is_error: true,
        content:
          'Score failed validation: measure 0 duration mismatch. Call render_score again with the fix; keep everything else unchanged.',
      },
    ],
  },
]

describe('neutral conversation IR <-> Anthropic adapter', () => {
  it('round-trips the full corpus BYTE-IDENTICALLY (toAnthropic(fromAnthropic(x)) === x)', () => {
    const roundTripped = toAnthropicMessages(fromAnthropicMessages(GOLDEN_CORPUS))
    // Byte-exact: same fields, same field order, same values.
    expect(JSON.stringify(roundTripped)).toBe(JSON.stringify(GOLDEN_CORPUS))
    // Also structurally equal as a belt-and-suspenders check.
    expect(roundTripped).toEqual(GOLDEN_CORPUS)
  })

  it('round-trips each corpus entry independently (isolates which shape, if any, drifts)', () => {
    for (const msg of GOLDEN_CORPUS) {
      const rt = toAnthropicMessages(fromAnthropicMessages([msg]))
      expect(JSON.stringify(rt)).toBe(JSON.stringify([msg]))
    }
  })

  it('produces a neutral (camelCase, Anthropic-free) shape on the way in', () => {
    const neutral = fromAnthropicMessages(GOLDEN_CORPUS)
    // tool_result -> toolUseId / isError (NOT tool_use_id / is_error)
    const retryTurn = neutral[4] as Extract<NeutralMessage, { role: 'user' }>
    const tr = retryTurn.content[0]
    expect(tr.type).toBe('tool_result')
    if (tr.type === 'tool_result') {
      expect(tr.toolUseId).toBe('toolu_02def')
      expect(tr.isError).toBe(true)
      // The Anthropic wire keys must NOT leak into the neutral block.
      expect('tool_use_id' in tr).toBe(false)
      expect('is_error' in tr).toBe(false)
    }
  })

  it('omits isError entirely when the source tool_result has no is_error', () => {
    const neutral = fromAnthropicMessages([GOLDEN_CORPUS[3]])
    const turn = neutral[0] as Extract<NeutralMessage, { role: 'user' }>
    const tr = turn.content[0]
    expect(tr.type).toBe('tool_result')
    if (tr.type === 'tool_result') {
      expect('isError' in tr).toBe(false)
    }
  })

  it('preserves tool_use input object identity/order through the round-trip', () => {
    const neutral = fromAnthropicMessages([GOLDEN_CORPUS[1]])
    const turn = neutral[0] as Extract<NeutralMessage, { role: 'assistant' }>
    const tu = turn.content[1]
    expect(tu.type).toBe('tool_use')
    if (tu.type === 'tool_use') {
      expect(tu.input).toEqual({
        title: 'C Major Scale',
        key: 'C',
        measures: [{ index: 0 }],
      })
    }
  })

  it('handles empty history', () => {
    expect(toAnthropicMessages(fromAnthropicMessages([]))).toEqual([])
  })

  it('throws (tripwire) on non-string tool_result content rather than dropping data', () => {
    const weird: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_x',
            // Array-of-blocks content — valid Anthropic, but not modelled by the IR.
            content: [{ type: 'text', text: 'nested' }],
          },
        ],
      },
    ]
    expect(() => fromAnthropicMessages(weird)).toThrow(/non-string tool_result content/)
  })

  it('throws on an unmodelled content block type', () => {
    const weird = [
      { role: 'user', content: [{ type: 'image', source: {} }] },
    ] as unknown as ChatMessage[]
    expect(() => fromAnthropicMessages(weird)).toThrow(/unsupported user content block type/)
  })
})
