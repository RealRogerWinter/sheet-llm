import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'

const anthropicCreateMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: anthropicCreateMock }
    constructor() {}
    static APIError = class extends Error {}
    static RateLimitError = class extends Error {}
  }
  return { default: MockAnthropic }
})

const { run: toolDispatchRun, ToolDispatchError } = await import(
  '@/lib/orchestrator/toolDispatch'
)

function fourBars(): Score {
  return {
    title: 'Triplet demo',
    key: 'C',
    meter: '4/4',
    measures: Array.from({ length: 4 }, () => ({
      events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
    })),
  }
}

function dispatchResponse(tool: string, args: Record<string, unknown>): unknown {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_dispatch_test',
        name: 'dispatch_to_handler',
        // Flat arg schema: the model fills fields at the top level next to `tool`.
        input: { tool, ...args },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 30 },
  }
}

describe('toolDispatch: tool-pick correctness', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('extend_composition for "add 4 more bars"', async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      dispatchResponse('extend_composition', { targetBars: 4, hint: 'i-iv-V turnaround' }),
    )
    const decision = await toolDispatchRun({
      userText: 'add 4 more bars with a i iv v turnaround',
      editedScore: fourBars(),
    })
    expect(decision.tool).toBe('extend_composition')
    expect(decision.args).toEqual({ targetBars: 4, hint: 'i-iv-V turnaround' })
    expect(decision.confidence).toBe(0.85)
  })

  it('accepts a long (>280 char) content hint instead of hard-rejecting it', async () => {
    // The old 280-char cap rejected a thorough hint at the provider layer and
    // dropped the turn to the free-tier error ("too restrictive"). A detailed
    // hint must flow through to the handler.
    const longHint =
      'add a walking bass line in the left-hand bass-clef staff following the chord changes, '.repeat(6).slice(0, 400)
    anthropicCreateMock.mockResolvedValueOnce(
      dispatchResponse('region_replace', { startMeasureIdx: 4, endMeasureIdx: 7, hint: longHint }),
    )
    const decision = await toolDispatchRun({
      userText: 'add bass to bars 5-8',
      editedScore: fourBars(),
    })
    expect(decision.tool).toBe('region_replace')
    expect((decision.args as { hint: string }).hint.length).toBeGreaterThan(280)
  })

  it('insert_measures for "insert 2 bars after measure 3"', async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      dispatchResponse('insert_measures', { afterMeasureIdx: 3, count: 2 }),
    )
    const decision = await toolDispatchRun({
      userText: 'insert 2 bars after measure 3',
      editedScore: fourBars(),
    })
    expect(decision.tool).toBe('insert_measures')
    expect(decision.args).toEqual({ afterMeasureIdx: 3, count: 2 })
  })

  it('region_replace for "rewrite measures 5-8"', async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      dispatchResponse('region_replace', {
        startMeasureIdx: 5,
        endMeasureIdx: 8,
        hint: 'in D minor',
      }),
    )
    const decision = await toolDispatchRun({
      userText: 'rewrite measures 5-8 in D minor',
      editedScore: fourBars(),
    })
    expect(decision.tool).toBe('region_replace')
    expect(decision.args).toEqual({
      startMeasureIdx: 5,
      endMeasureIdx: 8,
      hint: 'in D minor',
    })
  })

  it('edit_intra_measure for "raise the third note"', async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      dispatchResponse('edit_intra_measure', {
        targetDescription: 'raise the third note (event 2 of measure 0) by one octave',
      }),
    )
    const decision = await toolDispatchRun({
      userText: 'raise the third note an octave',
      editedScore: fourBars(),
    })
    expect(decision.tool).toBe('edit_intra_measure')
  })

  it('regenerate_all for "scrap this and write me X"', async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      dispatchResponse('regenerate_all', {
        confirmExplicitRewrite: true,
        justification: 'User said "scrap this".',
      }),
    )
    const decision = await toolDispatchRun({
      userText: 'scrap this and write me a Bach chorale in F',
      editedScore: fourBars(),
    })
    expect(decision.tool).toBe('regenerate_all')
    expect((decision.args as { confirmExplicitRewrite: boolean }).confirmExplicitRewrite).toBe(true)
  })

  it('answer_question for "explain the bass line" (music-theory question)', async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      dispatchResponse('answer_question', {
        question: 'explain what the bass line is doing harmonically',
      }),
    )
    const decision = await toolDispatchRun({
      userText: 'explain the bass line to me in terms of music theory. what is happening?',
      editedScore: fourBars(),
    })
    expect(decision.tool).toBe('answer_question')
    expect(decision.args).toEqual({
      question: 'explain what the bass line is doing harmonically',
    })
    expect(decision.confidence).toBe(0.85)
  })
})

describe('toolDispatch: arg validation', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('rejects extend_composition with targetBars > 64', async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      dispatchResponse('extend_composition', { targetBars: 100 }),
    )
    // The provider-level schema validates upfront (maxItems:64).
    await expect(
      toolDispatchRun({
        userText: 'extend by 100 bars',
        editedScore: fourBars(),
      }),
    ).rejects.toBeInstanceOf(ToolDispatchError)
  })

  it('region_replace with a range but no hint defaults the hint to the user text', async () => {
    // The range is unguessable, but the content hint can fall back to the
    // user's own words so region_replace still runs (instead of failing).
    anthropicCreateMock.mockResolvedValueOnce(
      dispatchResponse('region_replace', { startMeasureIdx: 0, endMeasureIdx: 2 }),
    )
    const decision = await toolDispatchRun({
      userText: 'rewrite bars 0-2',
      editedScore: fourBars(),
    })
    expect(decision.tool).toBe('region_replace')
    expect((decision.args as { hint: string }).hint).toBe('rewrite bars 0-2')
  })

  it('reroutes region_replace with NO range to edit_intra_measure (range unguessable)', async () => {
    anthropicCreateMock.mockResolvedValueOnce(dispatchResponse('region_replace', {}))
    const decision = await toolDispatchRun({
      userText: 'make the middle section moodier',
      editedScore: fourBars(),
    })
    expect(decision.tool).toBe('edit_intra_measure')
  })

  it('rejects answer_question with an empty question (provider-layer schema)', async () => {
    // An empty-string branch is rejected by the provider's input schema
    // (min(1)) before run()'s repair sees it — repair only fills a MISSING
    // branch (see the branch-arg repair suite below), not an empty value.
    anthropicCreateMock.mockResolvedValueOnce(
      dispatchResponse('answer_question', { question: '' }),
    )
    await expect(
      toolDispatchRun({
        userText: 'explain this',
        editedScore: fourBars(),
      }),
    ).rejects.toBeInstanceOf(ToolDispatchError)
  })
})

describe('toolDispatch: branch-arg repair (empty-branch tolerance)', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  function emptyBranch(tool: string): unknown {
    // Model picked the tool but left the matching branch object EMPTY — the
    // observed prod bug ("extend_composition args invalid: expected object,
    // received undefined") that fell through to the unbounded legacy path.
    return {
      content: [
        { type: 'tool_use', id: `toolu_${tool}`, name: 'dispatch_to_handler', input: { tool } },
      ],
      usage: { input_tokens: 100, output_tokens: 10 },
    }
  }

  it('repairs an empty extend_composition branch to a default 4 bars', async () => {
    anthropicCreateMock.mockResolvedValueOnce(emptyBranch('extend_composition'))
    const decision = await toolDispatchRun({ userText: 'keep going', editedScore: fourBars() })
    expect(decision.tool).toBe('extend_composition')
    expect(decision.args).toEqual({ targetBars: 4 })
  })

  it('repairs an empty edit_intra_measure branch from the user text', async () => {
    anthropicCreateMock.mockResolvedValueOnce(emptyBranch('edit_intra_measure'))
    const decision = await toolDispatchRun({
      userText: 'make the last note staccato',
      editedScore: fourBars(),
    })
    expect(decision.tool).toBe('edit_intra_measure')
    expect((decision.args as { targetDescription: string }).targetDescription).toBe(
      'make the last note staccato',
    )
  })

  it('reroutes an unrepairable empty insert_measures branch to edit_intra_measure', async () => {
    // The observed prod failure: insert_measures with no afterMeasureIdx/count.
    // No safe positional default → route the user's words to the general edit
    // handler (which can insertMeasureAfter) instead of failing → legacy regen.
    anthropicCreateMock.mockResolvedValueOnce(emptyBranch('insert_measures'))
    const decision = await toolDispatchRun({
      userText: 'insert 2 bars after bar 4',
      editedScore: fourBars(),
    })
    expect(decision.tool).toBe('edit_intra_measure')
    expect((decision.args as { targetDescription: string }).targetDescription).toBe(
      'insert 2 bars after bar 4',
    )
    expect(decision.confidence).toBe(0.6)
  })

  it('reroutes an unrepairable empty region_replace branch to edit_intra_measure', async () => {
    anthropicCreateMock.mockResolvedValueOnce(emptyBranch('region_replace'))
    const decision = await toolDispatchRun({
      userText: 'rewrite the middle',
      editedScore: fourBars(),
    })
    expect(decision.tool).toBe('edit_intra_measure')
    expect((decision.args as { targetDescription: string }).targetDescription).toBe(
      'rewrite the middle',
    )
  })
})

describe('toolDispatch: targetRegion injection (D5)', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('injects the selected region (0-based indices) into the dispatch prompt', async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      dispatchResponse('region_replace', { startMeasureIdx: 2, endMeasureIdx: 5, hint: 'jazzier' }),
    )
    await toolDispatchRun({
      userText: 'make this jazzier',
      editedScore: fourBars(),
      targetRegion: { startMeasureIdx: 2, endMeasureIdx: 5 },
    })
    const serialized = JSON.stringify(anthropicCreateMock.mock.calls[0][0])
    expect(serialized).toContain('SELECTED REGION')
    expect(serialized).toContain('startMeasureIdx=2')
    expect(serialized).toContain('endMeasureIdx=5')
    expect(serialized).toContain('measures 3') // 1-based human label (3–6)
  })

  it('uses singular phrasing for a one-bar region', async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      dispatchResponse('edit_intra_measure', { targetDescription: 'staccato' }),
    )
    await toolDispatchRun({
      userText: 'make this staccato',
      editedScore: fourBars(),
      targetRegion: { startMeasureIdx: 3, endMeasureIdx: 3 },
    })
    const serialized = JSON.stringify(anthropicCreateMock.mock.calls[0][0])
    expect(serialized).toContain('measure 4') // 1-based, singular
    expect(serialized).toContain('index 3')
  })

  it('omits the region line entirely when no targetRegion is supplied', async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      dispatchResponse('extend_composition', { targetBars: 4 }),
    )
    await toolDispatchRun({ userText: 'add 4 bars', editedScore: fourBars() })
    const serialized = JSON.stringify(anthropicCreateMock.mock.calls[0][0])
    expect(serialized).not.toContain('SELECTED REGION')
  })
})
