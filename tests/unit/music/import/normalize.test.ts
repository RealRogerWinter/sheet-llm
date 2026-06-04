import { describe, it, expect } from 'vitest'
import { MAX_MEASURES, normalize } from '@/lib/music/import/normalize'
import type { Score } from '@/lib/music/types'

function makeScore(measureCount: number, opts: Partial<Score> = {}): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: Array.from({ length: measureCount }, () => ({
      events: [
        { pitches: [{ step: 'C' as const, octave: 4 }], duration: 'whole' as const },
      ],
    })),
    ...opts,
  }
}

describe('normalize', () => {
  it('passes through a clean score unchanged', () => {
    const s = makeScore(4)
    const { score, warnings } = normalize(s, {})
    expect(score).toEqual(s)
    expect(warnings).toEqual([])
  })

  it('pads a partial first measure (anacrusis) with leading rests and warns', () => {
    const s: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        // Partial measure: only one quarter note (=2 eighths), meter expects 8.
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' }] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
      ],
    }
    const { score, warnings } = normalize(s, {})
    const first = score.measures[0]
    // 6 eighths of rest + 2 eighths of quarter = 8 eighths = 4/4.
    const restCount = first.events.filter((e) => e.pitches[0].step === 'rest').length
    expect(restCount).toBeGreaterThan(0)
    expect(warnings.some((w) => w.code === 'anacrusis_padded')).toBe(true)
  })

  it('fans anacrusis padding identically across every voice on every staff', () => {
    // Primary voice 0 starts with a quarter-note anacrusis (2 eighths).
    // All other voices start with whole-note rests (already 8 eighths).
    // After padding the same 6 eighths of leading rests are prepended
    // to every voice — secondStaff voices are now over-filled, which
    // is structurally OK at this layer (the per-voice cap is enforced
    // later by validateScore on user-facing import flows). For this
    // test we just verify the leading rests appear on every voice.
    const s: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        // Primary voice 0: partial first measure.
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' }] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
      ],
      extraVoices: [
        // Primary voice 1: starts with a partial bar mirroring v0.
        {
          measures: [
            { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' }] },
            { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
          ],
        },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'quarter' }] },
          { events: [{ pitches: [{ step: 'D', octave: 3 }], duration: 'whole' }] },
        ],
      },
    }
    const { score, warnings } = normalize(s, {})
    expect(warnings.some((w) => w.code === 'anacrusis_padded')).toBe(true)
    // Every voice's first measure now starts with rest events.
    expect(score.measures[0].events[0].pitches[0].step).toBe('rest')
    expect(score.extraVoices?.[0].measures[0].events[0].pitches[0].step).toBe('rest')
    expect(score.secondStaff?.measures[0].events[0].pitches[0].step).toBe('rest')
    // And the underlying note is still present in the right position.
    const v0Pitched = score.measures[0].events.find((e) => e.pitches[0].step !== 'rest')
    expect(v0Pitched?.pitches[0].step).toBe('C')
  })

  it('blocks when over MAX_MEASURES and truncateIfLong is false', () => {
    const over = MAX_MEASURES + 1
    const { warnings } = normalize(makeScore(over), {})
    const block = warnings.find((w) => w.code === 'too_long' && w.severity === 'block')
    expect(block).toBeDefined()
    expect(block?.meta?.originalMeasureCount).toBe(over)
  })

  it('truncates to MAX_MEASURES and emits info when truncateIfLong is true', () => {
    const over = MAX_MEASURES + 16
    const { score, warnings } = normalize(makeScore(over), { truncateIfLong: true })
    expect(score.measures).toHaveLength(MAX_MEASURES)
    const info = warnings.find((w) => w.code === 'too_long' && w.severity === 'info')
    expect(info).toBeDefined()
  })
})
