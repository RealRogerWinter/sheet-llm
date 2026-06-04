import { describe, it, expect } from 'vitest'
import {
  createMarker,
  createMarkerId,
  ensureMarkerIds,
} from '@/lib/music/markers'
import type { Marker, Score } from '@/lib/music/types'
import {
  MarkerSchema,
  MetricModulationNoteSchema,
  MetricModulationSchema,
} from '@/lib/music/types'
import { validateScore } from '@/lib/music/validateScore'

function buildScore(markers?: Marker[]): Score {
  return {
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
      {
        events: [
          { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
        ],
      },
    ],
    ...(markers ? { markers } : {}),
  }
}

describe('MetricModulationNoteSchema', () => {
  it('accepts the 7 standard pivot note values', () => {
    for (const n of [
      'half',
      'dotted-half',
      'quarter',
      'dotted-quarter',
      'eighth',
      'dotted-eighth',
      'sixteenth',
    ]) {
      expect(() => MetricModulationNoteSchema.parse(n)).not.toThrow()
    }
  })

  it("rejects 'whole' (too long for a sensible modulation pivot)", () => {
    expect(() => MetricModulationNoteSchema.parse('whole')).toThrow()
  })

  it('rejects 32nd (deferred — extension point)', () => {
    expect(() => MetricModulationNoteSchema.parse('32nd')).toThrow()
  })
})

describe('MetricModulationSchema', () => {
  it('validates a quarter = dotted-quarter modulation', () => {
    expect(() =>
      MetricModulationSchema.parse({ fromNote: 'quarter', toNote: 'dotted-quarter' }),
    ).not.toThrow()
  })

  it('requires both fromNote and toNote', () => {
    expect(() => MetricModulationSchema.parse({ fromNote: 'quarter' })).toThrow()
  })
})

describe('createMarkerId', () => {
  it('returns a 10-character string within schema bounds (8..16)', () => {
    const id = createMarkerId()
    expect(id.length).toBe(10)
  })

  it('returns unique ids on successive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createMarkerId()))
    expect(ids.size).toBe(100)
  })
})

describe('createMarker', () => {
  it('mints an id and assembles a tempo marker', () => {
    const m = createMarker({
      measureIdx: 4,
      tempo_bpm: 120,
      tempo_text: 'Allegro',
    })
    expect(typeof m.id).toBe('string')
    expect(m.measureIdx).toBe(4)
    expect(m.tempo_bpm).toBe(120)
    expect(m.tempo_text).toBe('Allegro')
    expect(m).not.toHaveProperty('key')
    expect(m).not.toHaveProperty('metricModulation')
  })

  it('builds a metric-modulation marker', () => {
    const m = createMarker({
      measureIdx: 8,
      tempo_bpm: 80,
      metricModulation: { fromNote: 'quarter', toNote: 'dotted-quarter' },
    })
    expect(m.metricModulation).toEqual({
      fromNote: 'quarter',
      toNote: 'dotted-quarter',
    })
  })

  it('passes validateScore when attached to a Score', () => {
    const m = createMarker({ measureIdx: 1, tempo_bpm: 120 })
    expect(() => validateScore(buildScore([m]))).not.toThrow()
  })
})

describe('MarkerSchema refine', () => {
  it('rejects an empty marker (no fields set)', () => {
    expect(() => MarkerSchema.parse({ measureIdx: 0 })).toThrow(/at least one of/i)
  })

  it('accepts a marker with ONLY metricModulation (no tempo_bpm)', () => {
    expect(() =>
      MarkerSchema.parse({
        measureIdx: 0,
        metricModulation: { fromNote: 'quarter', toNote: 'eighth' },
      }),
    ).not.toThrow()
  })

  it('id is optional during rollout (no .min(8) when absent)', () => {
    expect(() =>
      MarkerSchema.parse({ measureIdx: 0, tempo_bpm: 100 }),
    ).not.toThrow()
  })
})

describe('ensureMarkerIds', () => {
  it('returns the same Score reference when there are no markers', () => {
    const score = buildScore()
    expect(ensureMarkerIds(score)).toBe(score)
  })

  it('returns the same Score reference when every marker already has an id', () => {
    const score = buildScore([
      createMarker({ measureIdx: 0, tempo_bpm: 100 }),
    ])
    expect(ensureMarkerIds(score)).toBe(score)
  })

  it('backfills missing ids in place', () => {
    const existing = createMarker({ measureIdx: 0, tempo_bpm: 100 })
    const incoming = { measureIdx: 1, tempo_bpm: 80 } as Marker
    const score = buildScore([existing, incoming])
    const fixed = ensureMarkerIds(score)
    expect(fixed).toBe(score)
    expect(fixed.markers![0].id).toBe(existing.id)
    expect(typeof fixed.markers![1].id).toBe('string')
    expect(fixed.markers![1].id!.length).toBeGreaterThanOrEqual(8)
  })

  it('backfills produce ids that survive validateScore', () => {
    const incoming = { measureIdx: 0, tempo_bpm: 100 } as Marker
    const score = buildScore([incoming])
    const fixed = ensureMarkerIds(score)
    expect(() => validateScore(fixed)).not.toThrow()
  })

  it('returns input on non-object input (defensive narrowing)', () => {
    expect(ensureMarkerIds('not a score' as unknown)).toBe('not a score')
    expect(ensureMarkerIds(null)).toBe(null)
    expect(ensureMarkerIds(undefined)).toBe(undefined)
  })
})
