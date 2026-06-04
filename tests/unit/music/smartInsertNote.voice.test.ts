import { describe, it, expect } from 'vitest'
import { smartInsertNote } from '@/lib/music/smartInsertNote'
import { transformScore } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import { getVoiceMeasureAt } from '@/lib/music/scoreAccessors'
import type { Score } from '@/lib/music/types'

function twoVoiceScore(): Score {
  // Single staff, two voices, two measures.
  const seed: Score = {
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
    ],
  }
  return transformScore(seed, { kind: 'addVoice', staffIdx: 0 })
}

describe('smartInsertNote with voiceIdx', () => {
  it('appends into voice 1 without touching voice 0 (absorbs the whole-rest in place)', () => {
    const before = twoVoiceScore()
    const v0BeforeM0 = getVoiceMeasureAt(before, 0, 0, 0)!
    const v0BeforeM1 = getVoiceMeasureAt(before, 0, 0, 1)!
    // Voice 1's last measure is a whole rest. The new rest-absorbing
    // behavior keeps everything in m.1 — no spillover, no new bar.
    const result = smartInsertNote(
      before,
      undefined,
      { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
      0,
      1,
    )
    // Voice 0's measures completely unchanged.
    expect(getVoiceMeasureAt(result.score, 0, 0, 0)!).toEqual(v0BeforeM0)
    expect(getVoiceMeasureAt(result.score, 0, 0, 1)!).toEqual(v0BeforeM1)
    // Voice 1's m.1 now starts with the quarter G + a dotted-half rest.
    expect(result.newSelection.measureIdx).toBe(1)
    expect(result.newSelection.eventIdx).toBe(0)
    const v1M1 = getVoiceMeasureAt(result.score, 0, 1, 1)!
    expect(v1M1.events[0]).toEqual({ pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' })
    expect(v1M1.events[1].pitches[0].step).toBe('rest')
    expect(v1M1.events[1].duration).toBe('dotted-half')
    // No new measure created.
    expect(getVoiceMeasureAt(result.score, 0, 1, 2)).toBeUndefined()
    expect(result.newSelection.voiceIdx).toBe(1)
    expect(() => validateScore(result.score)).not.toThrow()
  })

  it('targets the right (staff, voice) when target is provided (absorbs rest in place)', () => {
    const before = twoVoiceScore()
    // Voice 1's m0 is a whole rest. Insert with explicit target m.0 e.0
    // absorbs the rest in place — no new measure created.
    const result = smartInsertNote(
      before,
      { measureIdx: 0, eventIdx: 0 },
      { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      0,
      1,
    )
    expect(result.newSelection.measureIdx).toBe(0)
    expect(result.newSelection.eventIdx).toBe(0)
    const v1M0 = getVoiceMeasureAt(result.score, 0, 1, 0)!
    expect(v1M0.events[0]).toEqual({ pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' })
    expect(v1M0.events[1].duration).toBe('dotted-half')
    // Primary voice m0 untouched.
    const v0M0 = getVoiceMeasureAt(result.score, 0, 0, 0)!
    expect(v0M0.events[0].pitches[0].step).toBe('C')
    expect(() => validateScore(result.score)).not.toThrow()
  })

  it('spillover into a new measure fans across every voice when there are no rests to absorb', () => {
    // Build a two-voice score where voice 1's m.1 is a real whole NOTE
    // (no rest to absorb), forcing spillover.
    const before: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
      ],
      extraVoices: [
        {
          measures: [
            { events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
            { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
          ],
        },
      ],
    }
    const result = smartInsertNote(
      before,
      { measureIdx: 1, eventIdx: 0 },
      { pitches: [{ step: 'B', octave: 4 }], duration: 'whole' },
      0,
      1,
    )
    // Spillover should have created a 3rd measure on EVERY voice.
    expect(getVoiceMeasureAt(result.score, 0, 0, 2)).toBeDefined()
    expect(getVoiceMeasureAt(result.score, 0, 1, 2)).toBeDefined()
    // The new measure on voice 1 contains the B.
    const v1NewM = getVoiceMeasureAt(result.score, 0, 1, 2)!
    expect(v1NewM.events[0].pitches[0].step).toBe('B')
    // The new measure on voice 0 is a rest (untouched).
    const v0NewM = getVoiceMeasureAt(result.score, 0, 0, 2)!
    expect(v0NewM.events.every((e) => e.pitches[0].step === 'rest')).toBe(true)
    expect(() => validateScore(result.score)).not.toThrow()
  })

  it('defaults voiceIdx to 0 for legacy callers (back-compat)', () => {
    // Valid 4/4 single-measure score (sums to 8 eighths).
    const before: Score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ] }],
    }
    // Adding a quarter to a full 4/4 measure spills into a new measure.
    const result = smartInsertNote(
      before,
      undefined,
      { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
      0,
      // voiceIdx omitted → defaults to 0
    )
    expect(result.newSelection.voiceIdx).toBe(0)
    expect(() => validateScore(result.score)).not.toThrow()
  })
})
