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

const { runRegionReplace } = await import(
  '@/lib/orchestrator/handlers/regionReplace'
)

function sixBars(): Score {
  return {
    title: 'Test',
    key: 'C',
    meter: '4/4',
    measures: Array.from({ length: 6 }, (_, i) => ({
      events: [
        {
          id: `evt000000${i}`,
          pitches: [{ step: 'C', octave: 4 }],
          duration: 'whole',
        },
      ],
    })),
  }
}

function emitResponse(measures: Measure[]): unknown {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_region_test',
        name: 'emit_replacement_bars',
        input: { measures },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 200 },
  }
}

const replacement: Measure[] = [
  { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
]

const classification: Classification = {
  kind: 'compose',
  scope: 'short',
  complexity: 'complex',
  confidence: 0.9,
}

describe('regionReplace: replace + span severance warning', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('replaces a contiguous range', async () => {
    anthropicCreateMock.mockResolvedValueOnce(emitResponse(replacement))
    const result = await runRegionReplace({
      classification,
      editedScore: sixBars(),
      userText: 'rewrite measures 2-4',
      startMeasureIdx: 2,
      endMeasureIdx: 4,
      hint: 'mellow',
    })
    expect(result.score.measures).toHaveLength(4) // 6 - 3 + 1
    expect(result.dispatchTool).toBe('region_replace')
  })

  it('sends the model a DETAILED event schema (pitches + duration), not a bare object', async () => {
    // Regression: the emit_replacement_bars schema described events as a bare
    // {type:'object'}, so the model emitted skeletal events and every one failed
    // the strict MeasureSchema ("pitches: expected array, received undefined").
    anthropicCreateMock.mockResolvedValueOnce(emitResponse(replacement))
    await runRegionReplace({
      classification,
      editedScore: sixBars(),
      userText: 'add a bass line to bars 2-4',
      startMeasureIdx: 1,
      endMeasureIdx: 3,
      hint: 'left-hand bass line',
    })
    const tool = anthropicCreateMock.mock.calls[0][0].tools[0]
    const eventItems = tool.input_schema.properties.measures.items.properties.events.items
    expect(eventItems.required).toEqual(expect.arrayContaining(['pitches', 'duration']))
    expect(eventItems.properties.pitches.items.properties.step.enum).toContain('rest')
    // The grand-staff (second-staff/left-hand) path uses the same event shape.
    const voiceMeasure =
      tool.input_schema.properties.perVoiceContent.items.properties.voices.items.items
    expect(voiceMeasure.properties.events.items.required).toEqual(
      expect.arrayContaining(['pitches', 'duration']),
    )
  })

  it('warns when a span is severed by the replacement', async () => {
    const initial: Score = {
      ...sixBars(),
      spans: [
        {
          id: 'spannnnn01',
          kind: 'slur',
          startEventId: 'evt0000001',
          endEventId: 'evt0000003', // bar 3 is INSIDE replaced [2..4]
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    anthropicCreateMock.mockResolvedValueOnce(emitResponse(replacement))
    const result = await runRegionReplace({
      classification,
      editedScore: initial,
      userText: 'rewrite',
      startMeasureIdx: 2,
      endMeasureIdx: 4,
      hint: 'change',
    })
    expect(result.warnings).toBeDefined()
    expect(result.warnings!.some((w) => w.includes('spannnnn01'))).toBe(true)
    // Severed span is dropped.
    expect(result.score.spans).toBeUndefined()
  })

  it('remaps forward references after a range', async () => {
    const initial: Score = {
      ...sixBars(),
      markers: [
        { measureIdx: 0, key: 'G' }, // before range
        { measureIdx: 5, key: 'D' }, // after range
      ],
    }
    anthropicCreateMock.mockResolvedValueOnce(emitResponse(replacement))
    const result = await runRegionReplace({
      classification,
      editedScore: initial,
      userText: 'rewrite',
      startMeasureIdx: 2,
      endMeasureIdx: 4,
      hint: 'change',
    })
    expect(result.score.markers!.find((m) => m.key === 'G')!.measureIdx).toBe(0)
    // 5 - (3 - 1) = 3 — shifted back by 2 (replaced 3 bars with 1).
    expect(result.score.markers!.find((m) => m.key === 'D')!.measureIdx).toBe(3)
  })

  it('warns when LLM emits a different bar count than requested (H4)', async () => {
    // Range [2..4] is 3 bars; emit 1.
    anthropicCreateMock.mockResolvedValueOnce(emitResponse(replacement))
    const result = await runRegionReplace({
      classification,
      editedScore: sixBars(),
      userText: 'rewrite',
      startMeasureIdx: 2,
      endMeasureIdx: 4,
      hint: 'x',
    })
    expect(
      result.warnings?.some((w) => /emitted 1/.test(w) && /requested 3/.test(w)),
    ).toBe(true)
  })

  it('warns when a tie INTO the replaced region is broken (H2)', async () => {
    const initial: Score = {
      title: 'Tied',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              id: 'evtbefore01',
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'whole',
              tied_to_next: true,
            },
          ],
        },
        {
          events: [
            { id: 'evtinside01', pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
          ],
        },
        {
          events: [
            { id: 'evtafter001', pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
          ],
        },
      ],
    }
    // Replace measure 1 with G (no longer matches the tied C → tie breaks).
    const replaceWithG: Measure[] = [
      { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] },
    ]
    anthropicCreateMock.mockResolvedValueOnce(emitResponse(replaceWithG))
    const result = await runRegionReplace({
      classification,
      editedScore: initial,
      userText: 'rewrite',
      startMeasureIdx: 1,
      endMeasureIdx: 1,
      hint: 'x',
    })
    expect(
      result.warnings?.some((w) => w.toLowerCase().includes('tie') && /cleared/.test(w)),
    ).toBe(true)
    // The tie on the bar-before event is cleared.
    expect(result.score.measures[0].events[0].tied_to_next).toBeUndefined()
  })

  it('warns when a tie OUT of the replaced region is lost (H2)', async () => {
    const initial: Score = {
      title: 'Tied',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { id: 'evta00000001', pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
          ],
        },
        {
          events: [
            {
              id: 'evtlastinrng',
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'whole',
              tied_to_next: true,
            },
          ],
        },
        {
          events: [
            { id: 'evtafterrng1', pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
          ],
        },
      ],
    }
    anthropicCreateMock.mockResolvedValueOnce(emitResponse(replacement))
    const result = await runRegionReplace({
      classification,
      editedScore: initial,
      userText: 'rewrite',
      startMeasureIdx: 1,
      endMeasureIdx: 1,
      hint: 'x',
    })
    expect(
      result.warnings?.some((w) => w.toLowerCase().includes('tie') && /lost/.test(w)),
    ).toBe(true)
  })

  it('rejects an invalid range', async () => {
    await expect(
      runRegionReplace({
        classification,
        editedScore: sixBars(),
        userText: 'rewrite',
        startMeasureIdx: 5,
        endMeasureIdx: 2,
        hint: 'x',
      }),
    ).rejects.toThrow(/invalid/)
  })
})
