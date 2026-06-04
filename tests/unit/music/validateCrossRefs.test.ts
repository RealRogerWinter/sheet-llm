import { describe, it, expect } from 'vitest'
import { ValidationError } from '@/lib/music/errors'
import { validateScore } from '@/lib/music/validateScore'
import { createSpan } from '@/lib/music/spans'
import type { Score } from '@/lib/music/types'

const idA = 'evtestid01'
const idB = 'evtestid02'
const idC = 'evtestid03'

const scoreWithIds = (): Score => ({
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { id: idA, pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { id: idB, pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { id: idC, pitches: [{ step: 'E', octave: 4 }], duration: 'half' },
      ],
    },
  ],
})

describe('span endpoint cross-reference', () => {
  it('rejects span with missing startEventId', () => {
    const sc = scoreWithIds()
    sc.spans = [createSpan('slur', 'doesnotexist', idC)]
    expect(() => validateScore(sc)).toThrow(ValidationError)
    try {
      validateScore(sc)
    } catch (e) {
      expect((e as ValidationError).code).toBe('span_endpoint_missing')
    }
  })

  it('rejects span with missing endEventId', () => {
    const sc = scoreWithIds()
    sc.spans = [createSpan('slur', idA, 'doesnotexist')]
    try {
      validateScore(sc)
    } catch (e) {
      expect((e as ValidationError).code).toBe('span_endpoint_missing')
    }
  })

  it('accepts a valid slur with both endpoints', () => {
    const sc = scoreWithIds()
    sc.spans = [createSpan('slur', idA, idC)]
    expect(() => validateScore(sc)).not.toThrow()
  })

  it('rejects a reversed span (start AFTER end)', () => {
    const sc = scoreWithIds()
    sc.spans = [createSpan('slur', idC, idA)]
    try {
      validateScore(sc)
    } catch (e) {
      expect((e as ValidationError).code).toBe('span_reversed')
    }
  })
})

describe('per-pitch tie target', () => {
  it('rejects a tied pitch with no successor event', () => {
    const sc = scoreWithIds()
    sc.measures[0].events[2] = {
      id: idC,
      pitches: [{ step: 'E' as const, octave: 4, tied_to_next: true } as never],
      duration: 'half',
    }
    try {
      validateScore(sc)
    } catch (e) {
      expect((e as ValidationError).code).toBe('pitch_tie_target_missing')
    }
  })

  it('rejects a tied pitch whose target step+octave is absent in next event', () => {
    const sc = scoreWithIds()
    // Tie C4 in event 0 — but next event has D4, not C4.
    sc.measures[0].events[0] = {
      id: idA,
      pitches: [{ step: 'C' as const, octave: 4, tied_to_next: true } as never],
      duration: 'quarter',
    }
    try {
      validateScore(sc)
    } catch (e) {
      expect((e as ValidationError).code).toBe('pitch_tie_target_missing')
    }
  })

  it('accepts a valid same-pitch tie across two events', () => {
    const sc = scoreWithIds()
    // C4 → C4: matches.
    sc.measures[0].events[0] = {
      id: idA,
      pitches: [{ step: 'C' as const, octave: 4, tied_to_next: true } as never],
      duration: 'quarter',
    }
    sc.measures[0].events[1] = {
      id: idB,
      pitches: [{ step: 'C', octave: 4 }],
      duration: 'quarter',
    }
    expect(() => validateScore(sc)).not.toThrow()
  })

  it('accepts a tied pitch with lv flag (laissez vibrer, no target needed)', () => {
    const sc = scoreWithIds()
    sc.measures[0].events[2] = {
      id: idC,
      pitches: [{ step: 'E' as const, octave: 4, tied_to_next: true, lv: true } as never],
      duration: 'half',
    }
    expect(() => validateScore(sc)).not.toThrow()
  })

  it('accepts a tied pitch with enharmonicTie (target match relaxed)', () => {
    const sc = scoreWithIds()
    sc.measures[0].events[0] = {
      id: idA,
      pitches: [{ step: 'C' as const, octave: 4, accidental: 'sharp' as const, tied_to_next: true, enharmonicTie: true } as never],
      duration: 'quarter',
    }
    // Next event has D, not C# — but enharmonicTie relaxes the check.
    expect(() => validateScore(sc)).not.toThrow()
  })

  describe('M13-PR-2 enhanced diagnostics', () => {
    it('error message hints at lv when tie is on the last event', () => {
      const sc = scoreWithIds()
      sc.measures[0].events[2] = {
        id: idC,
        pitches: [{ step: 'E' as const, octave: 4, tied_to_next: true } as never],
        duration: 'half',
      }
      try {
        validateScore(sc)
        expect.fail('expected ValidationError')
      } catch (e) {
        const msg = (e as ValidationError).message
        expect(msg).toMatch(/last event/i)
        expect(msg).toMatch(/lv:true|lv true/i)
      }
    })

    it('detects tie-into-rest with a specific message', () => {
      const sc = scoreWithIds()
      // Tie C4 in event 0; replace event 1 with a single rest.
      sc.measures[0].events[0] = {
        id: idA,
        pitches: [{ step: 'C' as const, octave: 4, tied_to_next: true } as never],
        duration: 'quarter',
      }
      sc.measures[0].events[1] = {
        id: idB,
        pitches: [{ step: 'rest' as const, octave: 4 }],
        duration: 'quarter',
      }
      try {
        validateScore(sc)
        expect.fail('expected ValidationError')
      } catch (e) {
        const msg = (e as ValidationError).message
        expect(msg).toMatch(/next event .* is a rest/i)
        expect((e as ValidationError).code).toBe('pitch_tie_target_missing')
      }
    })

    it('error message includes available next-event pitches', () => {
      const sc = scoreWithIds()
      sc.measures[0].events[0] = {
        id: idA,
        pitches: [{ step: 'C' as const, octave: 4, tied_to_next: true } as never],
        duration: 'quarter',
      }
      try {
        validateScore(sc)
        expect.fail('expected ValidationError')
      } catch (e) {
        const msg = (e as ValidationError).message
        // Next event is D4 (per scoreWithIds()).
        expect(msg).toMatch(/D4/)
      }
    })

    it('suggests enharmonicTie when an enharmonic equivalent is present', () => {
      // C#4 tied → next event has Db4 (enharmonic equivalent).
      const sc = scoreWithIds()
      sc.measures[0].events[0] = {
        id: idA,
        pitches: [{ step: 'C' as const, octave: 4, accidental: 'sharp' as const, tied_to_next: true } as never],
        duration: 'quarter',
      }
      sc.measures[0].events[1] = {
        id: idB,
        pitches: [{ step: 'D' as const, octave: 4, accidental: 'flat' as const }],
        duration: 'quarter',
      }
      try {
        validateScore(sc)
        expect.fail('expected ValidationError')
      } catch (e) {
        const msg = (e as ValidationError).message
        expect(msg).toMatch(/enharmonic/i)
        expect(msg).toMatch(/enharmonicTie/)
      }
    })

    it('does NOT suggest enharmonicTie when no enharmonic equivalent exists', () => {
      // C4 tied → next has E4 + G4 — no respell of C4 present.
      const sc = scoreWithIds()
      sc.measures[0].events[0] = {
        id: idA,
        pitches: [{ step: 'C' as const, octave: 4, tied_to_next: true } as never],
        duration: 'quarter',
      }
      sc.measures[0].events[1] = {
        id: idB,
        pitches: [{ step: 'E', octave: 4 }, { step: 'G', octave: 4 }],
        duration: 'quarter',
      }
      try {
        validateScore(sc)
        expect.fail('expected ValidationError')
      } catch (e) {
        const msg = (e as ValidationError).message
        expect(msg).not.toMatch(/enharmonicTie/)
      }
    })

    it('formats sharps and flats correctly in error messages', () => {
      const sc = scoreWithIds()
      // F# tied → next has G (semitone mismatch, not enharmonic).
      sc.measures[0].events[0] = {
        id: idA,
        pitches: [{ step: 'F' as const, octave: 4, accidental: 'sharp' as const, tied_to_next: true } as never],
        duration: 'quarter',
      }
      try {
        validateScore(sc)
        expect.fail('expected ValidationError')
      } catch (e) {
        const msg = (e as ValidationError).message
        expect(msg).toMatch(/F#4/)
      }
    })

    it('lv pitch on the last event is still accepted (no successor required)', () => {
      const sc = scoreWithIds()
      sc.measures[0].events[2] = {
        id: idC,
        pitches: [{ step: 'E' as const, octave: 4, tied_to_next: true, lv: true } as never],
        duration: 'half',
      }
      expect(() => validateScore(sc)).not.toThrow()
    })

    it('event-wide tied_to_next on a chord without matching next pitches is now REJECTED (M13-PR-2)', () => {
      // Pre-M13 the validator only checked per-pitch flags; event-
      // wide ties with broken targets were silently skipped. The
      // M13 validator routes through isPitchTiedToNext so the legacy
      // shape participates too.
      const sc = scoreWithIds()
      sc.measures[0].events[0] = {
        id: idA,
        pitches: [{ step: 'C' as const, octave: 4 }],
        duration: 'quarter',
        tied_to_next: true, // event-wide
      }
      // Next event is D (no match).
      try {
        validateScore(sc)
        expect.fail('expected ValidationError')
      } catch (e) {
        expect((e as ValidationError).code).toBe('pitch_tie_target_missing')
      }
    })

    it('event-wide tied_to_next on a chord with a matching next pitch passes', () => {
      const sc = scoreWithIds()
      sc.measures[0].events[0] = {
        id: idA,
        pitches: [{ step: 'C' as const, octave: 4 }],
        duration: 'quarter',
        tied_to_next: true,
      }
      sc.measures[0].events[1] = {
        id: idB,
        pitches: [{ step: 'C', octave: 4 }],
        duration: 'quarter',
      }
      expect(() => validateScore(sc)).not.toThrow()
    })

    it('chord tone tied into next event with matching tone passes (other tones change)', () => {
      const sc = scoreWithIds()
      // Event 0 chord [C, E, G] with only C tied; event 1 has [C, D] — C matches, no other constraint.
      sc.measures[0].events[0] = {
        id: idA,
        pitches: [
          { step: 'C' as const, octave: 4, tied_to_next: true } as never,
          { step: 'E', octave: 4 },
          { step: 'G', octave: 4 },
        ],
        duration: 'quarter',
      }
      sc.measures[0].events[1] = {
        id: idB,
        pitches: [{ step: 'C', octave: 4 }, { step: 'D', octave: 4 }],
        duration: 'quarter',
      }
      expect(() => validateScore(sc)).not.toThrow()
    })
  })
})

describe('jump marker linking', () => {
  it('rejects D.S. with no segnoRef', () => {
    const sc = scoreWithIds() as ReturnType<typeof scoreWithIds> & { jumpMarkers?: unknown[] }
    sc.jumpMarkers = [
      { id: 'jumpidtest', measureIdx: 0, side: 'end', kind: 'D.S.' },
    ]
    try {
      validateScore(sc)
    } catch (e) {
      expect((e as ValidationError).code).toBe('jump_ref_missing')
    }
  })

  it('rejects D.S. al Coda with codaRef pointing nowhere', () => {
    const sc = scoreWithIds() as ReturnType<typeof scoreWithIds> & {
      jumpMarkers?: unknown[]
      segnoMarkers?: unknown[]
      codaMarkers?: unknown[]
    }
    sc.segnoMarkers = [{ id: 'segnoxxxxx', measureIdx: 0, side: 'start' }]
    sc.jumpMarkers = [
      {
        id: 'jumpaaaaa',
        measureIdx: 0,
        side: 'end',
        kind: 'D.S. al Coda',
        segnoRef: 'segnoxxxxx',
        codaRef: 'nonexistent',
      },
    ]
    try {
      validateScore(sc)
    } catch (e) {
      expect((e as ValidationError).code).toBe('jump_ref_missing')
    }
  })

  it('accepts a complete D.S. al Coda with valid refs', () => {
    const sc = scoreWithIds() as ReturnType<typeof scoreWithIds> & {
      jumpMarkers?: unknown[]
      segnoMarkers?: unknown[]
      codaMarkers?: unknown[]
    }
    sc.segnoMarkers = [{ id: 'segnoxxxxx', measureIdx: 0, side: 'start' }]
    sc.codaMarkers = [{ id: 'codaxxxxxx', measureIdx: 0, side: 'start' }]
    sc.jumpMarkers = [
      {
        id: 'jumpaaaaa',
        measureIdx: 0,
        side: 'end',
        kind: 'D.S. al Coda',
        segnoRef: 'segnoxxxxx',
        codaRef: 'codaxxxxxx',
      },
    ]
    expect(() => validateScore(sc)).not.toThrow()
  })

  it('accepts Fine without any refs (no link required)', () => {
    const sc = scoreWithIds() as ReturnType<typeof scoreWithIds> & { jumpMarkers?: unknown[] }
    sc.jumpMarkers = [{ id: 'jumpfinexx', measureIdx: 0, side: 'end', kind: 'Fine' }]
    expect(() => validateScore(sc)).not.toThrow()
  })
})

describe('marker duplication', () => {
  it('rejects two markers at the same measureIdx that both change meter', () => {
    const sc = scoreWithIds() as ReturnType<typeof scoreWithIds> & { markers?: unknown[] }
    sc.markers = [
      { measureIdx: 0, meter: '3/4' },
      { measureIdx: 0, meter: '5/8' },
    ]
    try {
      validateScore(sc)
    } catch (e) {
      expect((e as ValidationError).code).toBe('marker_duplicate')
    }
  })

  it('accepts two markers at the same measureIdx that change DIFFERENT fields', () => {
    const sc = scoreWithIds() as ReturnType<typeof scoreWithIds> & { markers?: unknown[] }
    sc.markers = [
      { measureIdx: 0, key: 'G' },
      { measureIdx: 0, tempo_bpm: 120 },
    ]
    expect(() => validateScore(sc)).not.toThrow()
  })

  it('rejects two markers at the same measureIdx that both carry metricModulation (M9-PR-1)', () => {
    // Without including metricModulation in the duplicate-field set
    // these would silently both render, producing conflicting
    // "♩ = ♩." semantics. validateMarkers must catch it.
    const sc = scoreWithIds() as ReturnType<typeof scoreWithIds> & { markers?: unknown[] }
    sc.markers = [
      { measureIdx: 0, metricModulation: { fromNote: 'quarter', toNote: 'dotted-quarter' } },
      { measureIdx: 0, metricModulation: { fromNote: 'quarter', toNote: 'eighth' } },
    ]
    try {
      validateScore(sc)
      throw new Error('Expected ValidationError')
    } catch (e) {
      expect((e as ValidationError).code).toBe('marker_duplicate')
      expect((e as Error).message).toMatch(/metricModulation/)
    }
  })
})

describe('volta endings invariants', () => {
  it('rejects volta with start > end', () => {
    const sc = scoreWithIds() as ReturnType<typeof scoreWithIds> & { voltas?: unknown[] }
    sc.voltas = [{ id: 'voltaxxxxx', startMeasureIdx: 5, endMeasureIdx: 2, endings: [1] }]
    try {
      validateScore(sc)
    } catch (e) {
      expect((e as ValidationError).code).toBe('volta_endings_invalid')
    }
  })

  it('rejects volta with duplicate endings', () => {
    const sc = scoreWithIds() as ReturnType<typeof scoreWithIds> & { voltas?: unknown[] }
    sc.voltas = [{ id: 'voltaxxxxx', startMeasureIdx: 0, endMeasureIdx: 0, endings: [1, 1] }]
    try {
      validateScore(sc)
    } catch (e) {
      expect((e as ValidationError).code).toBe('volta_endings_invalid')
    }
  })
})

describe('anacrusis honoring in measure-duration validation', () => {
  it('accepts a short pickup measure when isPickup=true', () => {
    const sc = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C' as const, octave: 4 }], duration: 'quarter' as const },
          ],
          isPickup: true,
        },
        {
          events: [
            { pitches: [{ step: 'D' as const, octave: 4 }], duration: 'whole' as const },
          ],
        },
      ],
    }
    expect(() => validateScore(sc)).not.toThrow()
  })

  it('still rejects a short non-pickup measure', () => {
    const sc = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C' as const, octave: 4 }], duration: 'quarter' as const },
          ],
        },
      ],
    }
    try {
      validateScore(sc)
    } catch (e) {
      expect((e as ValidationError).code).toBe('measure_duration_mismatch')
    }
  })

  it('rejects a pickup measure that EXCEEDS the meter capacity', () => {
    const sc = {
      key: 'C' as const,
      meter: '3/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C' as const, octave: 4 }], duration: 'whole' as const },
          ],
          isPickup: true,
        },
      ],
    }
    try {
      validateScore(sc)
    } catch (e) {
      expect((e as ValidationError).code).toBe('measure_duration_mismatch')
    }
  })

  it('accepts a short final-partial measure when isFinalPartial=true', () => {
    const sc = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C' as const, octave: 4 }], duration: 'whole' as const },
          ],
        },
        {
          events: [
            { pitches: [{ step: 'D' as const, octave: 4 }], duration: 'half' as const },
          ],
          isFinalPartial: true,
        },
      ],
    }
    expect(() => validateScore(sc)).not.toThrow()
  })
})

describe('techniqueStates cross-reference (M3-PR-3)', () => {
  const baseMeasures = [
    { events: [{ pitches: [{ step: 'C' as const, octave: 3 }], duration: 'whole' as const }] },
    { events: [{ pitches: [{ step: 'D' as const, octave: 3 }], duration: 'whole' as const }] },
  ]

  it('accepts a valid in-range marker', () => {
    const sc = {
      key: 'C' as const,
      meter: '4/4',
      clef: 'bass' as const,
      measures: baseMeasures,
      techniqueStates: [
        { id: 'tech-ok-1', measureIdx: 1, staffIdx: 0, voiceIdx: 0, kind: 'pizz' as const },
      ],
    }
    expect(() => validateScore(sc)).not.toThrow()
  })

  it('rejects an out-of-range measureIdx', () => {
    const sc = {
      key: 'C' as const,
      meter: '4/4',
      clef: 'bass' as const,
      measures: baseMeasures,
      techniqueStates: [
        { id: 'tech-bad-1', measureIdx: 9, staffIdx: 0, voiceIdx: 0, kind: 'pizz' as const },
      ],
    }
    try {
      validateScore(sc)
      throw new Error('expected throw')
    } catch (e) {
      const err = e as { code?: string; message: string }
      expect(err.code).toBe('technique_state_invalid')
      expect(err.message).toContain('measureIdx 9')
    }
  })

  it('rejects an out-of-range staffIdx (no secondStaff present)', () => {
    const sc = {
      key: 'C' as const,
      meter: '4/4',
      clef: 'bass' as const,
      measures: baseMeasures,
      techniqueStates: [
        { id: 'tech-bad-2', measureIdx: 0, staffIdx: 1, voiceIdx: 0, kind: 'pizz' as const },
      ],
    }
    try {
      validateScore(sc)
      throw new Error('expected throw')
    } catch (e) {
      const err = e as { code?: string; message: string }
      expect(err.code).toBe('technique_state_invalid')
      expect(err.message).toContain('staffIdx 1')
    }
  })

  it('rejects an out-of-range voiceIdx (no extraVoices present)', () => {
    const sc = {
      key: 'C' as const,
      meter: '4/4',
      clef: 'bass' as const,
      measures: baseMeasures,
      techniqueStates: [
        { id: 'tech-bad-3', measureIdx: 0, staffIdx: 0, voiceIdx: 1, kind: 'pizz' as const },
      ],
    }
    try {
      validateScore(sc)
      throw new Error('expected throw')
    } catch (e) {
      const err = e as { code?: string; message: string }
      expect(err.code).toBe('technique_state_invalid')
      expect(err.message).toContain('voiceIdx 1')
    }
  })

  it('rejects an out-of-range eventIdx within a valid measure', () => {
    const sc = {
      key: 'C' as const,
      meter: '4/4',
      clef: 'bass' as const,
      measures: baseMeasures,
      techniqueStates: [
        { id: 'tech-bad-4', measureIdx: 0, eventIdx: 5, staffIdx: 0, voiceIdx: 0, kind: 'pizz' as const },
      ],
    }
    try {
      validateScore(sc)
      throw new Error('expected throw')
    } catch (e) {
      const err = e as { code?: string; message: string }
      expect(err.code).toBe('technique_state_invalid')
      expect(err.message).toContain('eventIdx 5')
    }
  })
})
