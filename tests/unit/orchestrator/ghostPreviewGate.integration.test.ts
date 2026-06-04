import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'

const BASE_SCORE: Score = {
  title: 'Triplet demo',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { id: 'a0', pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { id: 'a1', pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { id: 'a2', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { id: 'a3', pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { id: 'b0', pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { id: 'b1', pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { id: 'b2', pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
        { id: 'b3', pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      ],
    },
  ],
}

/** Modified one event — small inline-class diff. */
const SMALL_EDIT_SCORE: Score = {
  ...BASE_SCORE,
  measures: [
    {
      events: [
        { id: 'a0', pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { id: 'a1', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' }, // D -> E
        { id: 'a2', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { id: 'a3', pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
    BASE_SCORE.measures[1],
  ],
}

/** Same key/meter/title, with 2 extra bars (extend_composition shape). */
const EXTEND_SCORE: Score = {
  ...BASE_SCORE,
  measures: [
    ...BASE_SCORE.measures,
    {
      events: [
        { id: 'c0', pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
      ],
    },
    {
      events: [
        { id: 'd0', pitches: [{ step: 'G', octave: 4 }], duration: 'whole' },
      ],
    },
  ],
}

/** Wholesale replacement output — replacement gate fires; proposal hook
 *  must defer (mutually exclusive). */
const REPLACEMENT_SCORE: Score = {
  title: '5/4 ostinato',
  key: 'Am',
  meter: '5/4',
  measures: Array.from({ length: 4 }, (_, i) => ({
    events: [
      { id: `r${i}0`, pitches: [{ step: 'A', octave: 3 }], duration: 'quarter' },
      { id: `r${i}1`, pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      { id: `r${i}2`, pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
      { id: `r${i}3`, pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      { id: `r${i}4`, pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
    ],
  })),
}

const classifyMock = vi.fn()
vi.mock('@/lib/orchestrator/classifier', () => ({
  classify: classifyMock,
  ClassifierSchemaError: class extends Error {
    constructor(m: string) {
      super(m)
      this.name = 'ClassifierSchemaError'
    }
  },
}))

const runComposeMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/compose', () => ({
  runCompose: runComposeMock,
  _resetComposeClient: () => undefined,
}))

const runExtendCompositionMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/extendComposition', () => ({
  runExtendComposition: runExtendCompositionMock,
  ExtendCompositionError: class extends Error {},
}))

const toolDispatchMock = vi.fn()
vi.mock('@/lib/orchestrator/toolDispatch', () => ({
  run: toolDispatchMock,
  ToolDispatchError: class extends Error {},
}))

const { run } = await import('@/lib/orchestrator')

describe('orchestrator ghost-preview hook (M24-PR-2)', () => {
  beforeEach(() => {
    classifyMock.mockReset()
    runComposeMock.mockReset()
    runExtendCompositionMock.mockReset()
    toolDispatchMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    // Default to legacy classifier path; opt INTO new dispatcher per
    // test as needed.
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '0')
    vi.stubEnv('SL_GHOST_PREVIEW', '1')
  })

  it('attaches proposal + requiresConfirmation on a small edit (legacy path)', async () => {
    classifyMock.mockResolvedValue({
      kind: 'compose',
      scope: 'short',
      complexity: 'complex',
      confidence: 0.9,
    })
    runComposeMock.mockResolvedValue({
      score: SMALL_EDIT_SCORE,
      classification: {
        kind: 'compose',
        scope: 'short',
        complexity: 'complex',
        confidence: 0.9,
      },
      model: 'claude-sonnet-4-6',
      latencyMs: 100,
      toolUseId: 'toolu_llm_1',
    })

    const result = await run({
      requestId: 'r-small',
      userText: 'raise the second note',
      editedScore: BASE_SCORE,
      history: [],
    })

    expect(result).toBeTruthy()
    if (!result || 'refused' in result || 'fellThrough' in result || 'outcomeKind' in result) {
      throw new Error('expected OrchestratorResult')
    }
    expect(result.requiresConfirmation).toBe(true)
    expect(result.proposal).toBeDefined()
    // ids are backfilled by ensureEventIds, so assert the COUNT (one
    // raised note flagged) rather than the toy fixture id.
    expect(result.proposal?.affectedEventIds).toHaveLength(1)
    // Mutual exclusivity: replacement gate did not fire on this small edit.
    expect(result.replacement).toBeUndefined()
  })

  it('backfills ids on an ID-LESS result so affectedEventIds is non-empty (real LLM shape)', async () => {
    // Real orchestrator/LLM output does NOT carry event ids (`id` is
    // optional and only backfilled on the migrate-on-load path). Before
    // the ensureEventIds() backfill, computeAffectedEventIds returned []
    // here and the overlay/diff had nothing to highlight — the actual
    // "no amber ever shows" bug. The existing tests masked it by using
    // scores that already carried ids.
    const smallEditNoIds: Score = {
      title: 'Triplet demo',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
            { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' }, // D -> E, NO id
            { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
            { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
          ],
        },
        {
          events: [
            { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
            { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
            { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
            { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
          ],
        },
      ],
    }
    classifyMock.mockResolvedValue({
      kind: 'compose',
      scope: 'short',
      complexity: 'complex',
      confidence: 0.9,
    })
    runComposeMock.mockResolvedValue({
      score: smallEditNoIds,
      classification: {
        kind: 'compose',
        scope: 'short',
        complexity: 'complex',
        confidence: 0.9,
      },
      model: 'claude-sonnet-4-6',
      latencyMs: 100,
    })

    const result = await run({
      requestId: 'r-noids',
      userText: 'raise the second note',
      editedScore: BASE_SCORE,
      history: [],
    })

    if (!result || 'refused' in result || 'fellThrough' in result || 'outcomeKind' in result) {
      throw new Error('expected OrchestratorResult')
    }
    expect(result.requiresConfirmation).toBe(true)
    // The changed event is at measure 0, index 1 → exactly one affected id.
    expect(result.proposal?.affectedEventIds).toHaveLength(1)
    expect(result.proposal?.affectedEventIds[0]).toMatch(/^.{8,16}$/)
    // The candidate score now carries ids on EVERY event, so the client
    // overlay can resolve them via findEventLocationById.
    expect(result.score.measures.every((m) => m.events.every((e) => e.id))).toBe(true)
    // And the affected id is actually one that exists in the candidate.
    const allIds = new Set(result.score.measures.flatMap((m) => m.events.map((e) => e.id)))
    expect(allIds.has(result.proposal!.affectedEventIds[0])).toBe(true)
  })

  it('attaches proposal on an extend with new measures (dispatched path)', async () => {
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '1')
    toolDispatchMock.mockResolvedValue({
      tool: 'extend_composition',
      args: { targetBars: 2 },
      confidence: 0.9,
      model: 'claude-haiku-4-5',
    })
    runExtendCompositionMock.mockResolvedValue({
      score: EXTEND_SCORE,
      classification: {
        kind: 'compose',
        scope: 'short',
        complexity: 'complex',
        confidence: 0.9,
      },
      model: 'claude-sonnet-4-6',
      latencyMs: 100,
      dispatchTool: 'extend_composition',
    })

    const result = await run({
      requestId: 'r-extend',
      userText: 'add 2 more bars',
      editedScore: BASE_SCORE,
      history: [],
    })

    if (!result || 'refused' in result || 'fellThrough' in result || 'outcomeKind' in result) {
      throw new Error('expected OrchestratorResult')
    }
    expect(result.requiresConfirmation).toBe(true)
    expect(result.proposal).toBeDefined()
    // 2 inserted measures × 1 event each → 2 affected ids.
    expect(result.proposal?.affectedEventIds).toHaveLength(2)
    expect(result.replacement).toBeUndefined()
  })

  it('does NOT attach a proposal when SL_GHOST_PREVIEW=0 (explicit opt-out; default flipped ON in M24-PR-6)', async () => {
    vi.stubEnv('SL_GHOST_PREVIEW', '0')
    classifyMock.mockResolvedValue({
      kind: 'compose',
      scope: 'short',
      complexity: 'complex',
      confidence: 0.9,
    })
    runComposeMock.mockResolvedValue({
      score: SMALL_EDIT_SCORE,
      classification: {
        kind: 'compose',
        scope: 'short',
        complexity: 'complex',
        confidence: 0.9,
      },
      model: 'claude-sonnet-4-6',
      latencyMs: 100,
    })

    const result = await run({
      requestId: 'r-off',
      userText: 'raise the second note',
      editedScore: BASE_SCORE,
      history: [],
    })

    if (!result || 'refused' in result || 'fellThrough' in result || 'outcomeKind' in result) {
      throw new Error('expected OrchestratorResult')
    }
    expect(result.requiresConfirmation).toBeUndefined()
    expect(result.proposal).toBeUndefined()
  })

  it('defers to replacement gate on wholesale rewrite (mutual exclusion)', async () => {
    classifyMock.mockResolvedValue({
      kind: 'compose',
      scope: 'short',
      complexity: 'complex',
      confidence: 0.9,
    })
    runComposeMock.mockResolvedValue({
      score: REPLACEMENT_SCORE,
      classification: {
        kind: 'compose',
        scope: 'short',
        complexity: 'complex',
        confidence: 0.9,
      },
      model: 'claude-sonnet-4-6',
      latencyMs: 100,
    })

    const result = await run({
      requestId: 'r-replace',
      userText: 'make it more jazzy',
      editedScore: BASE_SCORE,
      history: [],
    })

    if (!result || 'refused' in result || 'fellThrough' in result || 'outcomeKind' in result) {
      throw new Error('expected OrchestratorResult')
    }
    expect(result.requiresConfirmation).toBe(true)
    expect(result.replacement).toBeDefined()
    // Ghost-preview hook deferred — proposal field NOT set.
    expect(result.proposal).toBeUndefined()
  })

  it('attaches proposal when only chord symbols change (canonEvent v2 captures chordSymbol)', async () => {
    // Defense-in-depth: if a future "optimize chordSymbol out of the
    // hash" change regresses canonEvent, this test catches it. Adding
    // a chord symbol to an existing event must surface as a diff.
    const WITH_CHORD: Score = {
      ...BASE_SCORE,
      measures: [
        {
          events: [
            {
              id: 'a0',
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'quarter',
              chordSymbol: { root: 'C', quality: 'major', seventh: 'none' },
            },
            { id: 'a1', pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
            { id: 'a2', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
            { id: 'a3', pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
          ],
        },
        BASE_SCORE.measures[1],
      ],
    }
    classifyMock.mockResolvedValue({
      kind: 'compose',
      scope: 'short',
      complexity: 'complex',
      confidence: 0.9,
    })
    runComposeMock.mockResolvedValue({
      score: WITH_CHORD,
      classification: {
        kind: 'compose',
        scope: 'short',
        complexity: 'complex',
        confidence: 0.9,
      },
      model: 'claude-sonnet-4-6',
      latencyMs: 100,
    })

    const result = await run({
      requestId: 'r-chord',
      userText: 'add a C major chord symbol on beat 1',
      editedScore: BASE_SCORE,
      history: [],
    })

    if (!result || 'refused' in result || 'fellThrough' in result || 'outcomeKind' in result) {
      throw new Error('expected OrchestratorResult')
    }
    expect(result.requiresConfirmation).toBe(true)
    expect(result.proposal).toBeDefined()
    // One event (the one that gained a chord symbol) is flagged.
    expect(result.proposal?.affectedEventIds).toHaveLength(1)
  })

  it('does NOT attach a proposal when the result is identical to the input (no-op turn)', async () => {
    classifyMock.mockResolvedValue({
      kind: 'compose',
      scope: 'short',
      complexity: 'complex',
      confidence: 0.9,
    })
    runComposeMock.mockResolvedValue({
      score: BASE_SCORE,
      classification: {
        kind: 'compose',
        scope: 'short',
        complexity: 'complex',
        confidence: 0.9,
      },
      model: 'claude-sonnet-4-6',
      latencyMs: 100,
    })

    const result = await run({
      requestId: 'r-noop',
      userText: 'no change please',
      editedScore: BASE_SCORE,
      history: [],
    })

    if (!result || 'refused' in result || 'fellThrough' in result || 'outcomeKind' in result) {
      throw new Error('expected OrchestratorResult')
    }
    expect(result.requiresConfirmation).toBeUndefined()
    expect(result.proposal).toBeUndefined()
  })
})
