import { describe, it, expect } from 'vitest'
import { fillMeasureWithRests, DURATION_32NDS } from '@/lib/music/measureBalance'
import { meterCapacityIn32nds, METER_PRESETS } from '@/lib/music/meter'
import { validateScore } from '@/lib/music/validateScore'
import type { Meter, Score } from '@/lib/music/types'

function sumMeasureUnits(measure: { events: { duration: keyof typeof DURATION_32NDS }[] }): number {
  return measure.events.reduce((acc, e) => acc + DURATION_32NDS[e.duration], 0)
}

describe('fillMeasureWithRests', () => {
  it('produces a measure whose duration sum equals the meter capacity for every preset', () => {
    for (const meter of METER_PRESETS) {
      const m = fillMeasureWithRests(meter as Meter)
      expect(sumMeasureUnits(m), `meter ${meter}`).toBe(meterCapacityIn32nds(meter))
      expect(m.events.length).toBeGreaterThanOrEqual(1)
      for (const ev of m.events) {
        expect(ev.pitches[0].step).toBe('rest')
      }
    }
  })

  it('handles odd meters with greedy largest-first decomposition', () => {
    // 5/4 = 10 eighths = 20 32nds → whole(32?) no, whole=32 > 20; dotted-half=24 > 20; half=16, leaves 4 → eighth=4 → [half, eighth]
    // Actually 5/4 in 32nds = 5 * 8 = 40. whole=32 fits; remaining 8 = quarter. → [whole, quarter]
    const m54 = fillMeasureWithRests('5/4')
    expect(sumMeasureUnits(m54)).toBe(40)
    // 7/8 = 7 * 4 = 28 32nds. dotted-half=24 fits; remaining 4 = eighth. → [dotted-half, eighth]
    const m78 = fillMeasureWithRests('7/8')
    expect(sumMeasureUnits(m78)).toBe(28)
    // 3/4 = 24 32nds → dotted-half(24) → [dotted-half]
    const m34 = fillMeasureWithRests('3/4')
    expect(m34.events).toHaveLength(1)
    expect(m34.events[0].duration).toBe('dotted-half')
    // 6/8 = 24 32nds → dotted-half(24) → [dotted-half]
    const m68 = fillMeasureWithRests('6/8')
    expect(m68.events).toHaveLength(1)
    expect(m68.events[0].duration).toBe('dotted-half')
    // 4/4 = 32 32nds → whole
    const m44 = fillMeasureWithRests('4/4')
    expect(m44.events).toHaveLength(1)
    expect(m44.events[0].duration).toBe('whole')
  })

  it('passes validateScore when used as a measure body', () => {
    for (const meter of METER_PRESETS) {
      const score: Score = {
        key: 'C',
        meter: meter as Meter,
        measures: [fillMeasureWithRests(meter as Meter)],
      }
      expect(() => validateScore(score), `meter ${meter}`).not.toThrow()
    }
  })
})
