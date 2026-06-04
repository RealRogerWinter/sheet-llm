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

// Grand staff (2 staves) — addStaff fails on it ("already has two staves").
const GRAND_SCORE: Score = {
  title: 'Grand',
  key: 'C',
  meter: '4/4',
  measures: [{ events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] }],
  secondStaff: {
    clef: 'bass',
    measures: [{ events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] }],
  },
}

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

const { runEditIntraMeasure, _resetIntraMeasureClient } = await import(
  '@/lib/orchestrator/handlers/editIntraMeasure'
)

function intraMeasureResponse(ops: unknown): unknown {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_intra_1',
        name: 'edit_score',
        input: { ops },
      },
    ],
    usage: { input_tokens: 80, output_tokens: 25 },
  }
}

describe('orchestrator/handlers/editIntraMeasure', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    _resetIntraMeasureClient()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('calls Sonnet with a score-grounded edit_score tool', async () => {
    anthropicCreateMock.mockResolvedValue(
      intraMeasureResponse([{ kind: 'setAccidental', target: { measureIdx: 0, eventIdx: 0 }, accidental: 'sharp' }]),
    )
    await runEditIntraMeasure({
      classification: {
        kind: 'edit_intra_measure',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.9,
        target_description: 'make the first note a half note',
      },
      editedScore: BASE_SCORE,
    })
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.model).toMatch(/sonnet/i)
    expect(call.tool_choice).toMatchObject({ type: 'tool', name: 'edit_score' })
    // Schema is per-request — should expose maxMeasureIdx based on BASE_SCORE
    expect(call.tools[0].name).toBe('edit_score')
  })

  it('skips an op that cannot apply and applies the rest (tolerant edit)', async () => {
    // addStaff fails on an already-2-staff score; the sibling setAccidental is
    // valid — one bad op must not abort the whole edit.
    anthropicCreateMock.mockResolvedValue(
      intraMeasureResponse([
        { kind: 'addStaff', clef: 'bass' },
        { kind: 'setAccidental', target: { staffIdx: 0, measureIdx: 0, eventIdx: 0, pitchIdx: 0 }, accidental: 'sharp' },
      ]),
    )
    const result = await runEditIntraMeasure({
      classification: {
        kind: 'edit_intra_measure', scope: 'snippet', complexity: 'simple', confidence: 0.9,
        target_description: 'add a bass staff and sharpen the top note',
      },
      editedScore: GRAND_SCORE,
    })
    // Valid op applied...
    expect(result.score.measures[0].events[0].pitches[0].accidental).toBe('sharp')
    // ...failed addStaff skipped + surfaced as a warning with the real reason.
    expect(result.warnings?.some((w) => /addStaff/.test(w) && /two staves/i.test(w))).toBe(true)
  })

  it('throws a real-reason error when EVERY op fails (no partial apply)', async () => {
    anthropicCreateMock.mockResolvedValue(
      intraMeasureResponse([{ kind: 'addStaff', clef: 'bass' }]),
    )
    await expect(
      runEditIntraMeasure({
        classification: {
          kind: 'edit_intra_measure', scope: 'snippet', complexity: 'simple', confidence: 0.9,
          target_description: 'add a third staff',
        },
        editedScore: GRAND_SCORE,
      }),
    ).rejects.toThrow(/no ops could be applied/i)
  })

  it('per-call edit_score schema bounds voiceIdx in target to 0..3', async () => {
    anthropicCreateMock.mockResolvedValue(
      intraMeasureResponse([{ kind: 'setAccidental', target: { measureIdx: 0, eventIdx: 0 }, accidental: 'sharp' }]),
    )
    await runEditIntraMeasure({
      classification: {
        kind: 'edit_intra_measure',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.9,
        target_description: 'sharpen the first note',
      },
      editedScore: BASE_SCORE,
    })
    const call = anthropicCreateMock.mock.calls[0][0]
    const targetSchema = call.tools[0].input_schema.properties.ops.items.properties.target
    expect(targetSchema.properties.voiceIdx).toEqual({
      type: 'integer',
      minimum: 0,
      maximum: 3,
    })
    expect(targetSchema.properties.staffIdx).toMatchObject({ minimum: 0, maximum: 0 })
  })

  it('per-call edit_score schema bounds staffIdx to 0..1 when score has secondStaff', async () => {
    anthropicCreateMock.mockResolvedValue(
      intraMeasureResponse([{ kind: 'setAccidental', target: { measureIdx: 0, eventIdx: 0 }, accidental: 'sharp' }]),
    )
    const grandStaff: Score = {
      ...BASE_SCORE,
      secondStaff: {
        clef: 'bass',
        measures: [{ events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] }],
      },
    }
    await runEditIntraMeasure({
      classification: {
        kind: 'edit_intra_measure',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.9,
        target_description: 'edit the bass-staff note',
      },
      editedScore: grandStaff,
    })
    const call = anthropicCreateMock.mock.calls[0][0]
    const targetSchema = call.tools[0].input_schema.properties.ops.items.properties.target
    expect(targetSchema.properties.staffIdx).toMatchObject({ minimum: 0, maximum: 1 })
  })

  it('feeds a descriptive EditError back to the LLM when voiceIdx targets a nonexistent voice', async () => {
    // First call: LLM emits a bad voiceIdx; transformScore throws.
    // Second call: same response — verifies the error propagates out
    // through EditIntraMeasureError (no per-attempt retry inside this
    // handler; that's scoreRetry's domain for the *generation* path).
    anthropicCreateMock.mockResolvedValue(
      intraMeasureResponse([
        { kind: 'changePitch', target: { staffIdx: 0, voiceIdx: 5, measureIdx: 0, eventIdx: 0 }, deltaStep: 1 },
      ]),
    )
    const { EditIntraMeasureError } = await import('@/lib/orchestrator/handlers/editIntraMeasure')
    await expect(
      runEditIntraMeasure({
        classification: {
          kind: 'edit_intra_measure',
          scope: 'snippet',
          complexity: 'simple',
          confidence: 0.9,
          target_description: 'raise alto',
        },
        editedScore: BASE_SCORE,
      }),
    ).rejects.toThrow(EditIntraMeasureError)
  })

  it('applies the emitted ops sequentially via applyOperation', async () => {
    anthropicCreateMock.mockResolvedValue(
      intraMeasureResponse([
        { kind: 'changeDuration', target: { measureIdx: 0, eventIdx: 0 }, duration: 'half' },
        { kind: 'changeDuration', target: { measureIdx: 0, eventIdx: 1 }, duration: 'quarter' },
      ]),
    )
    const result = await runEditIntraMeasure({
      classification: {
        kind: 'edit_intra_measure',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.95,
        target_description: 'lengthen first note',
      },
      editedScore: {
        ...BASE_SCORE,
        measures: [{ events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        ] }],
      },
    })
    expect(result.score.measures[0].events[0].duration).toBe('half')
    expect(result.model).toMatch(/sonnet/i)
  })

  it('throws when editedScore is missing', async () => {
    const { EditIntraMeasureError } = await import('@/lib/orchestrator/handlers/editIntraMeasure')
    await expect(
      runEditIntraMeasure({
        classification: {
          kind: 'edit_intra_measure',
          scope: 'snippet',
          complexity: 'simple',
          confidence: 0.9,
          target_description: 'x',
        },
        editedScore: undefined,
      }),
    ).rejects.toThrow(EditIntraMeasureError)
  })

  it('falls through (throws EditIntraMeasureError) when the LLM emits no ops', async () => {
    anthropicCreateMock.mockResolvedValue(intraMeasureResponse([]))
    const { EditIntraMeasureError } = await import('@/lib/orchestrator/handlers/editIntraMeasure')
    await expect(
      runEditIntraMeasure({
        classification: {
          kind: 'edit_intra_measure',
          scope: 'snippet',
          complexity: 'simple',
          confidence: 0.9,
          target_description: 'x',
        },
        editedScore: BASE_SCORE,
      }),
    ).rejects.toThrow(EditIntraMeasureError)
  })

  it('throws EditIntraMeasureError when emitted ops fail validation against the live score', async () => {
    anthropicCreateMock.mockResolvedValue(
      intraMeasureResponse([{ kind: 'deleteEvent', target: { measureIdx: 99, eventIdx: 0 } }]),
    )
    const { EditIntraMeasureError } = await import('@/lib/orchestrator/handlers/editIntraMeasure')
    await expect(
      runEditIntraMeasure({
        classification: {
          kind: 'edit_intra_measure',
          scope: 'snippet',
          complexity: 'simple',
          confidence: 0.9,
          target_description: 'delete from non-existent measure',
        },
        editedScore: BASE_SCORE,
      }),
    ).rejects.toThrow(EditIntraMeasureError)
  })

  it('emits target_description and score JSON in the user message', async () => {
    anthropicCreateMock.mockResolvedValue(
      intraMeasureResponse([{ kind: 'setAccidental', target: { measureIdx: 0, eventIdx: 0 }, accidental: 'sharp' }]),
    )
    await runEditIntraMeasure({
      classification: {
        kind: 'edit_intra_measure',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.9,
        target_description: 'lengthen the first note',
      },
      editedScore: BASE_SCORE,
    })
    const call = anthropicCreateMock.mock.calls[0][0]
    const userText = (call.messages[0].content as Array<{ type: string; text?: string }>)
      .map((b) => b.text ?? '')
      .join(' ')
    expect(userText).toContain('lengthen the first note')
    // M26 PR-3: the score is now sent as COMPACT JSON (no pretty-print spaces).
    expect(userText).toContain('"key":"C"')
  })

  it('pins the Sonnet model id with date suffix', async () => {
    anthropicCreateMock.mockResolvedValue(
      intraMeasureResponse([{ kind: 'setAccidental', target: { measureIdx: 0, eventIdx: 0 }, accidental: 'sharp' }]),
    )
    await runEditIntraMeasure({
      classification: {
        kind: 'edit_intra_measure',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.9,
        target_description: 'x',
      },
      editedScore: BASE_SCORE,
    })
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.model).toBe('claude-sonnet-4-6')
  })

  it('per-call edit_score schema exposes the new per-note marking op fields', async () => {
    anthropicCreateMock.mockResolvedValue(
      intraMeasureResponse([{ kind: 'setAccidental', target: { measureIdx: 0, eventIdx: 0 }, accidental: 'sharp' }]),
    )
    await runEditIntraMeasure({
      classification: {
        kind: 'edit_intra_measure',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.9,
        target_description: 'x',
      },
      editedScore: BASE_SCORE,
    })
    const call = anthropicCreateMock.mock.calls[0][0]
    const opProps = call.tools[0].input_schema.properties.ops.items.properties
    // Spot-check fields the new ops need to address.
    expect(opProps.articulations).toBeDefined()
    expect(opProps.ornament).toBeDefined()
    expect((opProps.ornament as { enum: string[] }).enum).toContain('pralltriller')
    expect(opProps.dynamic_structured).toBeDefined()
    expect(opProps.fermata).toBeDefined()
    expect(opProps.barlineFermata).toBeDefined()
    expect(opProps.breathMark).toBeDefined()
    expect(opProps.caesura).toBeDefined()
    expect(opProps.tremolo).toBeDefined()
    expect(opProps.bowing).toBeDefined()
    expect(opProps.jazzInflection).toBeDefined()
    expect(opProps.trillUpperPitch).toBeDefined()
    expect(opProps.tied_to_next).toBeDefined()
    expect(opProps.lv).toBeDefined()
    expect(opProps.enharmonicTie).toBeDefined()
  })

  it('per-call edit_score system prompt documents the new per-note marking ops', async () => {
    anthropicCreateMock.mockResolvedValue(
      intraMeasureResponse([{ kind: 'setAccidental', target: { measureIdx: 0, eventIdx: 0 }, accidental: 'sharp' }]),
    )
    await runEditIntraMeasure({
      classification: {
        kind: 'edit_intra_measure',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.9,
        target_description: 'x',
      },
      editedScore: BASE_SCORE,
    })
    const call = anthropicCreateMock.mock.calls[0][0]
    const sys = call.system as Array<{ text?: string }> | string
    const systemText = typeof sys === 'string' ? sys : sys.map((b) => b.text ?? '').join('')
    for (const opName of [
      'setArticulations',
      'setOrnament',
      'setDynamic',
      'setDynamicStructured',
      'setFermata',
      'setBarlineFermata',
      'setBreathMark',
      'setCaesura',
      'setTremolo',
      'setBowing',
      'setJazzInflection',
      'setPitchTie',
      'setLv',
      'setEnharmonicTie',
      'setTrillUpperPitch',
      'insertTechniqueChange',
      'removeTechniqueChange',
    ]) {
      expect(systemText).toContain(opName)
    }
  })

  it('applies a setArticulations op against the live score', async () => {
    anthropicCreateMock.mockResolvedValue(
      intraMeasureResponse([
        {
          kind: 'setArticulations',
          target: { measureIdx: 0, eventIdx: 0 },
          articulations: ['staccato', 'accent'],
        },
      ]),
    )
    const result = await runEditIntraMeasure({
      classification: {
        kind: 'edit_intra_measure',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.9,
        target_description: 'add staccato + accent to the downbeat',
      },
      editedScore: BASE_SCORE,
    })
    expect(result.score.measures[0].events[0].articulations).toEqual([
      'staccato',
      'accent',
    ])
  })

  it('applies a setBarlineFermata op against the live score', async () => {
    anthropicCreateMock.mockResolvedValue(
      intraMeasureResponse([
        { kind: 'setBarlineFermata', measureIdx: 0, barlineFermata: 'long' },
      ]),
    )
    const result = await runEditIntraMeasure({
      classification: {
        kind: 'edit_intra_measure',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.9,
        target_description: 'put a G.P. on the closing barline',
      },
      editedScore: BASE_SCORE,
    })
    expect(result.score.measures[0].barlineFermata).toBe('long')
  })

  it('applies an insertTechniqueChange op against the live score and backfills id', async () => {
    anthropicCreateMock.mockResolvedValue(
      intraMeasureResponse([
        {
          kind: 'insertTechniqueChange',
          techniqueChange: {
            measureIdx: 0,
            staffIdx: 0,
            voiceIdx: 0,
            kind: 'pizz',
          },
        },
      ]),
    )
    const result = await runEditIntraMeasure({
      classification: {
        kind: 'edit_intra_measure',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.9,
        target_description: 'switch to pizz at the downbeat',
      },
      editedScore: BASE_SCORE,
    })
    expect(result.score.techniqueStates).toHaveLength(1)
    expect(result.score.techniqueStates![0].kind).toBe('pizz')
    expect(typeof result.score.techniqueStates![0].id).toBe('string')
    expect(result.score.techniqueStates![0].id!.length).toBeGreaterThanOrEqual(8)
  })

  it('applies a removeTechniqueChange op against an existing technique-state entry', async () => {
    const seeded: Score = {
      ...BASE_SCORE,
      techniqueStates: [
        { id: 'seeded-id-1', measureIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
      ],
    }
    anthropicCreateMock.mockResolvedValue(
      intraMeasureResponse([{ kind: 'removeTechniqueChange', id: 'seeded-id-1' }]),
    )
    const result = await runEditIntraMeasure({
      classification: {
        kind: 'edit_intra_measure',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.9,
        target_description: 'remove the pizz marker',
      },
      editedScore: seeded,
    })
    expect(result.score.techniqueStates).toBeUndefined()
  })

  it('per-call edit_score schema exposes techniqueChange + id top-level', async () => {
    anthropicCreateMock.mockResolvedValue(
      intraMeasureResponse([
        { kind: 'setAccidental', target: { measureIdx: 0, eventIdx: 0 }, accidental: 'sharp' },
      ]),
    )
    await runEditIntraMeasure({
      classification: {
        kind: 'edit_intra_measure',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.9,
        target_description: 'x',
      },
      editedScore: BASE_SCORE,
    })
    const call = anthropicCreateMock.mock.calls[0][0]
    const opProps = call.tools[0].input_schema.properties.ops.items.properties
    expect(opProps.techniqueChange).toBeDefined()
    expect(opProps.techniqueChange.properties.kind.enum).toContain('pizz')
    expect(opProps.techniqueChange.properties.kind.enum).toContain('arco')
    expect(opProps.id).toEqual({ type: 'string' })
  })
})
