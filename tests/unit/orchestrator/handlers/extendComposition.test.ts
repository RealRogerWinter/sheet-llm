import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Score, Measure } from '@/lib/music/types'
import type { Classification } from '@/lib/orchestrator/types'

// SDK mock identical to generateComplexAndCompose.test.ts pattern.
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

const { runExtendComposition } = await import(
  '@/lib/orchestrator/handlers/extendComposition'
)

function tripletDemoScore(): Score {
  return {
    title: 'Triplet demo',
    key: 'C',
    meter: '4/4',
    measures: [
      {
        events: [
          { id: 'evt0000001', pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
        ],
      },
      {
        events: [
          { id: 'evt0000002', pitches: [{ step: 'D', octave: 4 }], duration: 'whole' },
        ],
      },
      {
        events: [
          { id: 'evt0000003', pitches: [{ step: 'E', octave: 4 }], duration: 'whole' },
        ],
      },
      {
        events: [
          { id: 'evt0000004', pitches: [{ step: 'F', octave: 4 }], duration: 'whole' },
        ],
      },
    ],
  }
}

function classification(): Classification {
  return {
    kind: 'compose',
    scope: 'short',
    complexity: 'complex',
    confidence: 0.9,
  }
}

function emitAppendedBarsResponse(measures: Measure[]): unknown {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_extend_test',
        name: 'emit_appended_bars',
        input: { measures },
      },
    ],
    usage: { input_tokens: 200, output_tokens: 200 },
  }
}

const fourCmajWholes: Measure[] = [
  { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
  { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
  { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] },
  { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
]

describe('extendComposition: happy path', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('appends N measures and preserves key/meter/title/tempo + original bars', async () => {
    anthropicCreateMock.mockResolvedValueOnce(emitAppendedBarsResponse(fourCmajWholes))
    const result = await runExtendComposition({
      classification: classification(),
      editedScore: tripletDemoScore(),
      userText: 'add 4 more bars with a i iv v turnaround',
      targetBars: 4,
    })
    expect(result.score.measures).toHaveLength(8)
    expect(result.score.key).toBe('C')
    expect(result.score.meter).toBe('4/4')
    expect(result.score.title).toBe('Triplet demo')
    // First 4 measures byte-identical.
    const initial = tripletDemoScore()
    for (let i = 0; i < 4; i++) {
      expect(result.score.measures[i]).toEqual(initial.measures[i])
    }
    expect(result.appliedOps?.[0].kind).toBe('appendMeasures')
    expect(result.dispatchTool).toBe('extend_composition')
  })

  it('does not set cadenceAtBoundary when the existing score has no V-I ending', async () => {
    anthropicCreateMock.mockResolvedValueOnce(emitAppendedBarsResponse(fourCmajWholes))
    const result = await runExtendComposition({
      classification: classification(),
      editedScore: tripletDemoScore(),
      userText: 'extend',
      targetBars: 4,
    })
    expect(result.cadenceAtBoundary).toBeUndefined()
  })
})

describe('extendComposition: cadence detection at boundary', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('warns when extending past a V-I cadence at final barline', async () => {
    const score: Score = {
      title: 'Cadenced',
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] }, // V
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }, // I
      ],
    }
    anthropicCreateMock.mockResolvedValueOnce(emitAppendedBarsResponse([fourCmajWholes[0]]))
    const result = await runExtendComposition({
      classification: classification(),
      editedScore: score,
      userText: 'add a coda',
      targetBars: 1,
    })
    expect(result.cadenceAtBoundary).toBe(true)
    expect(result.warnings?.some((w) => w.toLowerCase().includes('cadence'))).toBe(true)
  })
})

describe('extendComposition: tie-at-boundary auto-downgrade', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('downgrades a tie to a slur when first new pitch does not match', async () => {
    // Tie on the last C, new bar starts on G — no match.
    const score: Score = {
      title: 'Tied',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              id: 'evt0000099',
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'whole',
              tied_to_next: true,
            },
          ],
        },
      ],
    }
    const newBars: Measure[] = [
      {
        events: [
          { id: 'evt0001001', pitches: [{ step: 'G', octave: 4 }], duration: 'whole' },
        ],
      },
    ]
    anthropicCreateMock.mockResolvedValueOnce(emitAppendedBarsResponse(newBars))
    const result = await runExtendComposition({
      classification: classification(),
      editedScore: score,
      userText: 'extend',
      targetBars: 1,
    })
    // Tie cleared on the last existing event.
    expect(result.score.measures[0].events[0].tied_to_next).toBeUndefined()
    // Slur span added.
    expect(result.score.spans?.some((s) => s.kind === 'slur')).toBe(true)
    // Warning emitted.
    expect(result.warnings?.some((w) => w.toLowerCase().includes('tie'))).toBe(true)
  })

  it('keeps the tie when first new pitch matches', async () => {
    const score: Score = {
      title: 'Tied',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              id: 'evt0000099',
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'whole',
              tied_to_next: true,
            },
          ],
        },
      ],
    }
    const newBars: Measure[] = [
      {
        events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
        ],
      },
    ]
    anthropicCreateMock.mockResolvedValueOnce(emitAppendedBarsResponse(newBars))
    const result = await runExtendComposition({
      classification: classification(),
      editedScore: score,
      userText: 'extend',
      targetBars: 1,
    })
    // Tie preserved.
    expect(result.score.measures[0].events[0].tied_to_next).toBe(true)
    // No slur span needed.
    expect(result.score.spans).toBeUndefined()
    // No tie warning.
    expect(result.warnings?.some((w) => w.toLowerCase().includes('tie'))).toBeFalsy()
  })
})

describe('extendComposition: per-pitch tie boundary (H1)', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('per-pitch tie preserved on chord match (C-E-G → C-E-G, only C tied)', async () => {
    const score: Score = {
      title: 'Chord tie',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              id: 'evt0000099',
              pitches: [
                { step: 'C', octave: 4, tied_to_next: true },
                { step: 'E', octave: 4 },
                { step: 'G', octave: 4 },
              ],
              duration: 'whole',
            },
          ],
        },
      ],
    }
    const newBars: Measure[] = [
      {
        events: [
          {
            id: 'evt0001001',
            pitches: [
              { step: 'C', octave: 4 },
              { step: 'E', octave: 4 },
              { step: 'G', octave: 4 },
            ],
            duration: 'whole',
          },
        ],
      },
    ]
    anthropicCreateMock.mockResolvedValueOnce(emitAppendedBarsResponse(newBars))
    const result = await runExtendComposition({
      classification: classification(),
      editedScore: score,
      userText: 'extend',
      targetBars: 1,
    })
    // Per-pitch tie preserved on pitch 0 (C); no slur span added.
    expect(result.score.measures[0].events[0].pitches[0].tied_to_next).toBe(true)
    expect(result.score.spans).toBeUndefined()
    expect(
      (result.warnings ?? []).some((w) => w.toLowerCase().includes('tie')),
    ).toBeFalsy()
  })

  it('per-pitch tie downgraded to event-level slur on chord mismatch', async () => {
    // Tie on pitch 0 (C) — the new event has E-G-B (no C). Tie cannot
    // hold → flag is cleared and a slur span is added.
    const score: Score = {
      title: 'Chord tie',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              id: 'evt0000099',
              pitches: [
                { step: 'C', octave: 4, tied_to_next: true },
                { step: 'E', octave: 4 },
                { step: 'G', octave: 4 },
              ],
              duration: 'whole',
            },
          ],
        },
      ],
    }
    const newBars: Measure[] = [
      {
        events: [
          {
            id: 'evt0001001',
            pitches: [
              { step: 'E', octave: 4 },
              { step: 'G', octave: 4 },
              { step: 'B', octave: 4 },
            ],
            duration: 'whole',
          },
        ],
      },
    ]
    anthropicCreateMock.mockResolvedValueOnce(emitAppendedBarsResponse(newBars))
    const result = await runExtendComposition({
      classification: classification(),
      editedScore: score,
      userText: 'extend',
      targetBars: 1,
    })
    // Per-pitch tie flag cleared.
    expect(result.score.measures[0].events[0].pitches[0].tied_to_next).toBeUndefined()
    // Slur span added.
    expect(result.score.spans?.some((s) => s.kind === 'slur')).toBe(true)
    // Warning emitted mentioning per-pitch tie.
    expect(
      (result.warnings ?? []).some((w) => w.toLowerCase().includes('tie')),
    ).toBe(true)
  })
})

describe('extendComposition: emit-count mismatch warning (H4)', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('warns when LLM emits more bars than requested', async () => {
    // Request 2, emit 4.
    anthropicCreateMock.mockResolvedValueOnce(emitAppendedBarsResponse(fourCmajWholes))
    const result = await runExtendComposition({
      classification: classification(),
      editedScore: tripletDemoScore(),
      userText: 'extend by 2',
      targetBars: 2,
    })
    expect(result.warnings?.some((w) => /emitted 4/.test(w) && /requested 2/.test(w))).toBe(true)
    expect(result.score.measures).toHaveLength(8)
  })

  it('warns when LLM emits fewer bars than requested', async () => {
    // Request 4, emit 1.
    anthropicCreateMock.mockResolvedValueOnce(
      emitAppendedBarsResponse([fourCmajWholes[0]]),
    )
    const result = await runExtendComposition({
      classification: classification(),
      editedScore: tripletDemoScore(),
      userText: 'extend by 4',
      targetBars: 4,
    })
    expect(result.warnings?.some((w) => /emitted 1/.test(w) && /requested 4/.test(w))).toBe(true)
    expect(result.score.measures).toHaveLength(5)
  })
})

describe('extendComposition: multi-staff fanout', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('fills secondStaff with rests when perVoiceContent is omitted', async () => {
    const score: Score = {
      title: 'Grand',
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
        ],
      },
    }
    anthropicCreateMock.mockResolvedValueOnce(emitAppendedBarsResponse(fourCmajWholes))
    const result = await runExtendComposition({
      classification: classification(),
      editedScore: score,
      userText: 'extend',
      targetBars: 4,
    })
    expect(result.score.secondStaff!.measures).toHaveLength(5)
    // Bars 1..4 on secondStaff are rests.
    for (let i = 1; i <= 4; i++) {
      expect(result.score.secondStaff!.measures[i].events[0].pitches[0].step).toBe('rest')
    }
  })
})

describe('extendComposition: anacrusis isFinalPartial cleared', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('clears isFinalPartial on the previously-last measure', async () => {
    // Use isFinalPartial on a bar that just happens to also fully fill
    // the meter — the flag isn't required for short bars, but it's a
    // valid signal that "this is the END of the piece". After append
    // the flag must be cleared regardless of how the partial sums.
    const score: Score = {
      title: 'Hymn',
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        {
          events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
          isFinalPartial: true,
        },
      ],
    }
    const newBar: Measure[] = [
      { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
    ]
    anthropicCreateMock.mockResolvedValueOnce(emitAppendedBarsResponse(newBar))
    const result = await runExtendComposition({
      classification: classification(),
      editedScore: score,
      userText: 'extend',
      targetBars: 1,
    })
    expect(result.score.measures[1].isFinalPartial).toBeUndefined()
  })
})

describe('extendComposition: validation-retry (M3.5-PR-5b)', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  // Two whole-notes in a single 4/4 bar = 16 eighths; validateScore
  // throws measure_duration_mismatch.
  const invalidBars: Measure[] = [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
        { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
      ],
    },
  ]

  it('does not retry when the first attempt validates', async () => {
    anthropicCreateMock.mockResolvedValueOnce(emitAppendedBarsResponse(fourCmajWholes))
    const result = await runExtendComposition({
      classification: classification(),
      editedScore: tripletDemoScore(),
      userText: 'add 4 bars',
      targetBars: 4,
    })
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1)
    expect(result.score.measures).toHaveLength(8)
  })

  it('retries with feedback when first attempt fails validation, succeeds on second', async () => {
    anthropicCreateMock.mockResolvedValueOnce(emitAppendedBarsResponse(invalidBars))
    anthropicCreateMock.mockResolvedValueOnce(
      emitAppendedBarsResponse([fourCmajWholes[0]]),
    )
    const result = await runExtendComposition({
      classification: classification(),
      editedScore: tripletDemoScore(),
      userText: 'add 1 bar',
      targetBars: 1,
    })
    expect(anthropicCreateMock).toHaveBeenCalledTimes(2)
    // Second-attempt user text contains the validation feedback.
    const secondCallArgs = anthropicCreateMock.mock.calls[1][0]
    const userMsg = secondCallArgs.messages.find(
      (m: { role: string }) => m.role === 'user',
    )
    const userText = Array.isArray(userMsg.content)
      ? userMsg.content.map((c: { text?: string }) => c.text ?? '').join('')
      : userMsg.content
    expect(userText).toMatch(/YOUR PREVIOUS ATTEMPT FAILED VALIDATION/)
    expect(userText).toMatch(/duration sum/)
    expect(result.score.measures).toHaveLength(5)
  })

  it('throws ExtendCompositionError after both attempts fail validation', async () => {
    anthropicCreateMock.mockResolvedValueOnce(emitAppendedBarsResponse(invalidBars))
    anthropicCreateMock.mockResolvedValueOnce(emitAppendedBarsResponse(invalidBars))
    await expect(
      runExtendComposition({
        classification: classification(),
        editedScore: tripletDemoScore(),
        userText: 'add 1 bar',
        targetBars: 1,
      }),
    ).rejects.toThrow(/invalid score|duration sum/)
    expect(anthropicCreateMock).toHaveBeenCalledTimes(2)
  })
})

describe('extendComposition: input validation', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('rejects targetBars=0', async () => {
    await expect(
      runExtendComposition({
        classification: classification(),
        editedScore: tripletDemoScore(),
        userText: 'extend',
        targetBars: 0,
      }),
    ).rejects.toThrow(/targetBars/)
  })

  it('rejects targetBars > 64', async () => {
    await expect(
      runExtendComposition({
        classification: classification(),
        editedScore: tripletDemoScore(),
        userText: 'extend',
        targetBars: 65,
      }),
    ).rejects.toThrow(/targetBars/)
  })
})
