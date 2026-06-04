import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Score, Measure } from '@/lib/music/types'
import type { Classification } from '@/lib/orchestrator/types'

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

const { runInsertMeasures } = await import(
  '@/lib/orchestrator/handlers/insertMeasures'
)

function fourBars(): Score {
  return {
    title: 'Test',
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
    ],
  }
}

function emitResponse(measures: Measure[]): unknown {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_insert_test',
        name: 'emit_inserted_bars',
        input: { measures },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 100 },
  }
}

const newBar: Measure[] = [
  { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] },
]

const classification: Classification = {
  kind: 'compose',
  scope: 'short',
  complexity: 'complex',
  confidence: 0.9,
}

describe('insertMeasures: insert + remap', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('inserts after measureIdx=1', async () => {
    anthropicCreateMock.mockResolvedValueOnce(emitResponse(newBar))
    const result = await runInsertMeasures({
      classification,
      editedScore: fourBars(),
      userText: 'insert a bar after measure 1',
      afterMeasureIdx: 1,
      count: 1,
    })
    expect(result.score.measures).toHaveLength(5)
    expect(result.score.measures[2].events[0].pitches[0].step).toBe('G')
    expect(result.dispatchTool).toBe('insert_measures')
  })

  it('remaps techniqueStates forward', async () => {
    const initial: Score = {
      ...fourBars(),
      techniqueStates: [
        { id: 'tech000001', measureIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
        { id: 'tech000002', measureIdx: 3, staffIdx: 0, voiceIdx: 0, kind: 'arco' },
      ],
    }
    anthropicCreateMock.mockResolvedValueOnce(emitResponse(newBar))
    const result = await runInsertMeasures({
      classification,
      editedScore: initial,
      userText: 'insert',
      afterMeasureIdx: 1,
      count: 1,
    })
    expect(result.score.techniqueStates![0].measureIdx).toBe(0)
    expect(result.score.techniqueStates![1].measureIdx).toBe(4)
  })

  it('remaps voltas, markers, annotations, jumpMarkers', async () => {
    const initial: Score = {
      ...fourBars(),
      voltas: [
        { id: 'voltaaaaaa', startMeasureIdx: 2, endMeasureIdx: 3, endings: [1] },
      ],
      markers: [{ measureIdx: 2, key: 'G' }],
      jumpMarkers: [
        { id: 'jumpmarker1', measureIdx: 3, side: 'end', kind: 'D.C.' },
      ],
      annotations: [
        {
          id: 'annnotation1',
          target: { measureIdx: 2, position: 'above' },
          text: 'cresc.',
          style: 'expression',
        },
      ],
    }
    anthropicCreateMock.mockResolvedValueOnce(emitResponse(newBar))
    const result = await runInsertMeasures({
      classification,
      editedScore: initial,
      userText: 'insert',
      afterMeasureIdx: 0,
      count: 1,
    })
    expect(result.score.voltas![0].startMeasureIdx).toBe(3)
    expect(result.score.voltas![0].endMeasureIdx).toBe(4)
    expect(result.score.markers![0].measureIdx).toBe(3)
    expect(result.score.jumpMarkers![0].measureIdx).toBe(4)
    expect(result.score.annotations![0].target.measureIdx).toBe(3)
  })

  it('warns when LLM emits more bars than requested (H4)', async () => {
    const fourNewBars: Measure[] = [
      { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'A', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'B', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
    ]
    anthropicCreateMock.mockResolvedValueOnce(emitResponse(fourNewBars))
    const result = await runInsertMeasures({
      classification,
      editedScore: fourBars(),
      userText: 'insert 1 bar',
      afterMeasureIdx: 1,
      count: 1,
    })
    expect(result.warnings?.some((w) => /emitted 4/.test(w) && /requested 1/.test(w))).toBe(true)
    expect(result.score.measures).toHaveLength(8) // 4 + 4 emitted
  })

  it('warns when LLM emits fewer bars than requested (H4)', async () => {
    anthropicCreateMock.mockResolvedValueOnce(emitResponse(newBar))
    const result = await runInsertMeasures({
      classification,
      editedScore: fourBars(),
      userText: 'insert 3 bars',
      afterMeasureIdx: 1,
      count: 3,
    })
    expect(result.warnings?.some((w) => /emitted 1/.test(w) && /requested 3/.test(w))).toBe(true)
    expect(result.score.measures).toHaveLength(5)
  })

  it('rejects afterMeasureIdx out of range', async () => {
    await expect(
      runInsertMeasures({
        classification,
        editedScore: fourBars(),
        userText: 'insert',
        afterMeasureIdx: 99,
        count: 1,
      }),
    ).rejects.toThrow(/out of range/)
  })
})
