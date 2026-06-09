import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'

const BASE_SCORE: Score = {
  title: 'Base',
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
    ] },
  ],
}

describe('orchestrator/handlers/editScoreLevel', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('applies a changeKey op to editedScore and returns the new score', async () => {
    const { runEditScoreLevel } = await import('@/lib/orchestrator/handlers/editScoreLevel')
    const result = await runEditScoreLevel({
      classification: {
        kind: 'edit_score_level',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.95,
        score_level_ops: [{ kind: 'changeKey', key: 'G' }],
      },
      editedScore: BASE_SCORE,
    })
    expect(result.score.key).toBe('G')
    expect(result.score.measures).toEqual(BASE_SCORE.measures)
    expect(result.model).toBeNull()
    expect(result.classification.kind).toBe('edit_score_level')
  })

  it('applies multiple ops sequentially', async () => {
    const { runEditScoreLevel } = await import('@/lib/orchestrator/handlers/editScoreLevel')
    const result = await runEditScoreLevel({
      classification: {
        kind: 'edit_score_level',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.95,
        score_level_ops: [
          { kind: 'changeKey', key: 'F' },
          { kind: 'changeTempo', tempo_bpm: 60 },
          { kind: 'changeTitle', title: 'Slow F' },
        ],
      },
      editedScore: BASE_SCORE,
    })
    expect(result.score.key).toBe('F')
    expect(result.score.tempo_bpm).toBe(60)
    expect(result.score.title).toBe('Slow F')
  })

  it('throws when editedScore is missing', async () => {
    const { runEditScoreLevel, EditHandlerError } = await import(
      '@/lib/orchestrator/handlers/editScoreLevel'
    )
    await expect(
      runEditScoreLevel({
        classification: {
          kind: 'edit_score_level',
          scope: 'snippet',
          complexity: 'simple',
          confidence: 0.95,
          score_level_ops: [{ kind: 'changeKey', key: 'G' }],
        },
        editedScore: undefined,
      }),
    ).rejects.toThrow(EditHandlerError)
  })

  it('is transactional: if any op throws, the original score is returned in the error', async () => {
    const { runEditScoreLevel, EditHandlerError } = await import(
      '@/lib/orchestrator/handlers/editScoreLevel'
    )
    try {
      await runEditScoreLevel({
        classification: {
          kind: 'edit_score_level',
          scope: 'snippet',
          complexity: 'simple',
          confidence: 0.95,
          score_level_ops: [
            { kind: 'changeKey', key: 'G' },
            // Cast to bypass the classifier's zod gate — this exercises
            // the *handler*'s defensive validation against an op kind
            // it's not equipped to apply.
            { kind: 'invalid_op' } as never,
          ],
        },
        editedScore: BASE_SCORE,
      })
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(EditHandlerError)
    }
  })

  it('does not mutate the input score', async () => {
    const { runEditScoreLevel } = await import('@/lib/orchestrator/handlers/editScoreLevel')
    const snapshot = JSON.parse(JSON.stringify(BASE_SCORE))
    await runEditScoreLevel({
      classification: {
        kind: 'edit_score_level',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.95,
        score_level_ops: [{ kind: 'changeKey', key: 'D' }],
      },
      editedScore: BASE_SCORE,
    })
    expect(BASE_SCORE).toEqual(snapshot)
  })
})

describe('orchestrator/handlers/refuse', () => {
  it('returns an OrchestratorRefusal with the classification reason', async () => {
    const { runRefuse } = await import('@/lib/orchestrator/handlers/refuse')
    const result = runRefuse({
      classification: {
        kind: 'refuse',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.99,
        reason: 'copyrighted material',
      },
      refusalCode: 'copyright',
    })
    expect(result.refused).toBe(true)
    expect(result.reason).toContain('copyrighted')
    expect(result.refusalCode).toBe('copyright')
  })

  it('defaults refusalCode to out_of_scope and uses a generic message when reason missing', async () => {
    const { runRefuse } = await import('@/lib/orchestrator/handlers/refuse')
    const result = runRefuse({
      classification: {
        kind: 'refuse',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.95,
      },
    })
    expect(result.refused).toBe(true)
    expect(result.refusalCode).toBe('out_of_scope')
    expect(result.reason).toBeTruthy()
  })
})

describe('orchestrator/handlers/generateSimple', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('routes fresh generation through the registry and returns its Score (default Sonnet)', async () => {
    const toolCallMock = vi.fn().mockResolvedValue({
      input: BASE_SCORE,
      toolUseId: 'toolu_real_1',
      model: 'claude-sonnet-4-6',
      introText: 'Generated.',
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    vi.doMock('@/lib/providers/select', () => ({
      selectProvider: () => ({
        provider: { name: 'anthropic', toolCall: toolCallMock },
        providerName: 'anthropic',
        model: 'claude-sonnet-4-6',
        tier: 'medium',
      }),
    }))
    const { runGenerateSimple } = await import('@/lib/orchestrator/handlers/generateSimple')
    const result = await runGenerateSimple({
      classification: {
        kind: 'generate_simple',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.95,
      },
      history: [{ role: 'user', content: [{ type: 'text', text: 'make a C major scale' }] }],
      chatId: 'chat-1',
    })
    expect(result.score).toEqual(BASE_SCORE)
    expect(result.introText).toBe('Generated.')
    expect(result.toolUseId).toBe('toolu_real_1')
    expect(result.model).toMatch(/sonnet/i)
    expect(toolCallMock).toHaveBeenCalledTimes(1)
    // The stored transcript is forwarded as neutral history, and the legacy
    // render_score tool description is preserved (byte-equivalence).
    const [tool, callOpts] = toolCallMock.mock.calls[0]
    expect(tool.description).toBeTruthy()
    expect(callOpts.history).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'make a C major scale' }] },
    ])
    expect(callOpts.userText).toBeUndefined()
  })
})
