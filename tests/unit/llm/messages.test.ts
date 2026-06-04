import { describe, it, expect, vi } from 'vitest'
import { completeWithRetry } from '@/lib/llm/messages'
import type { LLMClient } from '@/lib/llm/wrapper'
import type { Score } from '@/lib/music/types'

const VALID: Score = {
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
  ],
}

// One quarter note in a 4/4 bar → measure sums to 1 beat, not 4 → invalid.
const INVALID: Score = {
  key: 'C',
  meter: '4/4',
  measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' }] }],
}

describe('completeWithRetry — maxTokens + retry threading (M26 free-tier legacy bound)', () => {
  it('threads request.maxTokens into client.complete', async () => {
    const complete = vi.fn().mockResolvedValue({ score: VALID, toolUseId: 'toolu_1' })
    const client: LLMClient = { complete }
    await completeWithRetry(client, { messages: [], maxTokens: 2600 })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0][0].maxTokens).toBe(2600)
  })

  it('omits maxTokens when not set (pro / default path)', async () => {
    const complete = vi.fn().mockResolvedValue({ score: VALID, toolUseId: 'toolu_1' })
    await completeWithRetry({ complete }, { messages: [] })
    expect(complete.mock.calls[0][0].maxTokens).toBeUndefined()
  })

  it('honors maxRetries: 1 → at most 2 attempts on a persistently invalid score', async () => {
    const complete = vi.fn().mockResolvedValue({ score: INVALID, toolUseId: 'toolu_x' })
    await expect(
      completeWithRetry({ complete }, { messages: [], maxTokens: 2600 }, { maxRetries: 1 }),
    ).rejects.toBeTruthy()
    // initial + 1 retry = 2 (not the default 3) — the free-tier time bound.
    expect(complete).toHaveBeenCalledTimes(2)
  })
})
