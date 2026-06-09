import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@/lib/llm/wrapper'
import {
  fromAnthropicMessages,
  fromAnthropicMessagesLenient,
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
 *  - seed turns ................. chat/fork, chat/revert, import routes mint a
 *                                 bare [text] user turn + a [text, tool_use]
 *                                 assistant turn — same shapes as the first two
 *                                 entries; the fork-seed entry below pins them.
 *
 * If a new history shape (or a field-order change at any of those sites)
 * appears in the app, add/adjust an entry here — PR2 routes the live
 * Anthropic call through this adapter, so this corpus is the inventory.
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
  // Fork/revert/import seed turn (chat/fork/route.ts, chat/revert/route.ts,
  // import/route.ts): a synthetic-id assistant turn carrying the seeded score.
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Forked from a prior session.' },
      {
        type: 'tool_use',
        id: 'toolu_fork_seed01',
        name: 'render_score',
        input: { title: 'Forked Score', key: 'D', measures: [{ index: 0 }] },
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

  it('throws a clear error (not a raw TypeError) on non-array content', () => {
    const corrupt = [{ role: 'user', content: 'oops' }] as unknown as ChatMessage[]
    expect(() => fromAnthropicMessages(corrupt)).toThrow(/content is not an array/)
  })

  it('throws on an unknown message role rather than mis-classifying it', () => {
    const corrupt = [
      { role: 'system', content: [{ type: 'text', text: 'x' }] },
    ] as unknown as ChatMessage[]
    expect(() => fromAnthropicMessages(corrupt)).toThrow(/unsupported message role/)
  })

  it('reports absent tool_result content distinctly from an array', () => {
    const absent = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x' }] },
    ] as unknown as ChatMessage[]
    expect(() => fromAnthropicMessages(absent)).toThrow(/tool_result content \(absent\)/)
  })
})

describe('fromAnthropicMessagesLenient (stored-history adapter, S1-safe)', () => {
  it('is identical to the strict converter for well-formed history', () => {
    expect(fromAnthropicMessagesLenient(GOLDEN_CORPUS)).toEqual(
      fromAnthropicMessages(GOLDEN_CORPUS),
    )
  })

  it('coerces non-string tool_result content to a string (kept because its tool_use survives)', () => {
    const weird = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'render_score', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: [{ type: 'text', text: 'n' }] }],
      },
    ] as unknown as ChatMessage[]
    const out = fromAnthropicMessagesLenient(weird)
    const turn = out[1] as Extract<NeutralMessage, { role: 'user' }>
    const tr = turn.content[0]
    expect(tr.type).toBe('tool_result')
    if (tr.type === 'tool_result') {
      expect(typeof tr.content).toBe('string')
      expect(tr.content).toContain('text')
    }
  })

  it('NEVER throws on null/non-object messages or content elements (corrupt content_json)', () => {
    const corrupt = [
      null,
      'not-an-object',
      { role: 'user', content: [null, undefined, 42, { type: 'text', text: 'kept' }] },
      { role: 'assistant', content: null },
    ] as unknown as ChatMessage[]
    let out: unknown
    expect(() => {
      out = fromAnthropicMessagesLenient(corrupt)
    }).not.toThrow()
    expect(out).toEqual([{ role: 'user', content: [{ type: 'text', text: 'kept' }] }])
  })

  it('orphan-prunes a tool_result whose tool_use was dropped (no API-invalid request)', () => {
    const orphan = [
      // tool_use missing its id -> dropped -> assistant turn has no surviving blocks
      { role: 'assistant', content: [{ type: 'tool_use', name: 'render_score', input: {} }] },
      // its tool_result is now orphaned -> must be pruned, not emitted
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_gone', content: 'r' }] },
    ] as unknown as ChatMessage[]
    expect(fromAnthropicMessagesLenient(orphan)).toEqual([])
  })

  it('keeps a tool_result only after a surviving preceding tool_use of the same id', () => {
    const seq = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tc1', name: 'render_score', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'ok' }] },
    ] as unknown as ChatMessage[]
    const out = fromAnthropicMessagesLenient(seq)
    expect(out).toHaveLength(3)
    const last = out[2] as Extract<NeutralMessage, { role: 'user' }>
    expect(last.content[0]).toEqual({ type: 'tool_result', toolUseId: 'tc1', content: 'ok' })
  })

  it('skips unknown-role and non-array-content messages without throwing', () => {
    const corrupt = [
      { role: 'system', content: [{ type: 'text', text: 'x' }] },
      { role: 'user', content: 'oops' },
      { role: 'user', content: [{ type: 'text', text: 'kept' }] },
    ] as unknown as ChatMessage[]
    const out = fromAnthropicMessagesLenient(corrupt)
    expect(out).toEqual([{ role: 'user', content: [{ type: 'text', text: 'kept' }] }])
  })

  it('drops unmodelled blocks but keeps the surviving valid ones in the same message', () => {
    const mixed = [
      {
        role: 'assistant',
        content: [
          { type: 'image', source: {} },
          { type: 'text', text: 'survives' },
          { type: 'tool_use', id: 'tc', name: 'render_score', input: { k: 1 } },
        ],
      },
    ] as unknown as ChatMessage[]
    expect(fromAnthropicMessagesLenient(mixed)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'survives' },
          { type: 'tool_use', id: 'tc', name: 'render_score', input: { k: 1 } },
        ],
      },
    ])
  })
})
