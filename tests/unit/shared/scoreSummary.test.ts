import { describe, it, expect } from 'vitest'
import { summarizeScore } from '@/lib/shared/scoreSummary'
import type { Score } from '@/lib/music/types'

describe('summarizeScore', () => {
  it('summarises a typical score', () => {
    const score: Score = {
      title: 'C major scale',
      key: 'C',
      meter: '4/4',
      tempo_bpm: 120,
      measures: [
        { events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
        ] },
      ],
    }
    expect(summarizeScore(score)).toEqual({
      title: 'C major scale',
      key: 'C',
      meter: '4/4',
      tempo_bpm: 120,
      measureCount: 1,
      staffCount: 1,
      voiceCountPerStaff: [1],
    })
  })

  it('reports staffCount=2 and per-staff voice counts for a grand-staff score', () => {
    const score: Score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
      secondStaff: {
        clef: 'bass',
        measures: [{ events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] }],
      },
    }
    const s = summarizeScore(score)
    expect(s.staffCount).toBe(2)
    expect(s.voiceCountPerStaff).toEqual([1, 1])
  })

  it('reports per-staff voice counts for an SATB score', () => {
    const wholeNote = (step: 'C' | 'D' | 'E' | 'G', octave: number) => ({
      events: [{ pitches: [{ step, octave }], duration: 'whole' as const }],
    })
    const score: Score = {
      key: 'C',
      meter: '4/4',
      measures: [wholeNote('G', 4)],
      extraVoices: [{ measures: [wholeNote('E', 4)] }],
      secondStaff: {
        clef: 'bass',
        measures: [wholeNote('C', 4)],
        extraVoices: [{ measures: [wholeNote('C', 3)] }],
      },
    }
    const s = summarizeScore(score)
    expect(s.staffCount).toBe(2)
    expect(s.voiceCountPerStaff).toEqual([2, 2])
  })

  it('omits optional title and tempo when missing', () => {
    const score: Score = {
      key: 'G',
      meter: '3/4',
      measures: [
        { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] },
      ],
    }
    const summary = summarizeScore(score)
    expect(summary.title).toBeUndefined()
    expect(summary.tempo_bpm).toBeUndefined()
    expect(summary.key).toBe('G')
    expect(summary.meter).toBe('3/4')
    expect(summary.measureCount).toBe(1)
    expect(summary.staffCount).toBe(1)
    expect(summary.voiceCountPerStaff).toEqual([1])
  })

  it('counts multiple measures', () => {
    const score: Score = {
      key: 'C',
      meter: '4/4',
      measures: Array.from({ length: 16 }, () => ({
        events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
      })),
    }
    expect(summarizeScore(score).measureCount).toBe(16)
  })

  it('preserves all KeySchema enum literals', () => {
    const keys: Array<Score['key']> = ['C', 'G', 'F#', 'Bb', 'C#m', 'A#m']
    for (const key of keys) {
      const score: Score = {
        key,
        meter: '4/4',
        measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
      }
      expect(summarizeScore(score).key).toBe(key)
    }
  })

  it('preserves all MeterSchema enum literals', () => {
    const meters: Array<Score['meter']> = ['2/4', '3/4', '4/4', '6/8', '9/8', '12/8', 'C', 'C|']
    for (const meter of meters) {
      // Use a single whole note for any 4-beat-equivalent; for compound
      // meters use a dotted-half. We don't actually need the score to be
      // semantically valid here — summarizeScore doesn't validate.
      const score: Score = {
        key: 'C',
        meter,
        measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
      }
      expect(summarizeScore(score).meter).toBe(meter)
    }
  })
})
