import { describe, it, expect } from 'vitest'
import { applyOperation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import type { Score } from '@/lib/music/types'

function twoBars(): Score {
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
          { pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
          { pitches: [{ step: 'A', octave: 4 }], duration: 'half' },
        ],
      },
    ],
  }
}

describe('setStartBarline / setEndBarline', () => {
  const BARLINE_KINDS = [
    'thin',
    'double',
    'final',
    'repeat-start',
    'repeat-end',
    'repeat-both',
    'invisible',
    'dashed',
  ] as const

  for (const kind of BARLINE_KINDS) {
    it(`sets startBarline to "${kind}"`, () => {
      const next = applyOperation(twoBars(), {
        kind: 'setStartBarline',
        measureIdx: 0,
        barline: kind,
      })
      expect(next.measures[0].startBarline).toBe(kind)
      expect(() => validateScore(next)).not.toThrow()
    })

    it(`sets endBarline to "${kind}"`, () => {
      const next = applyOperation(twoBars(), {
        kind: 'setEndBarline',
        measureIdx: 1,
        barline: kind,
      })
      expect(next.measures[1].endBarline).toBe(kind)
      expect(() => validateScore(next)).not.toThrow()
    })
  }

  it('clears startBarline when barline is omitted', () => {
    let sc = applyOperation(twoBars(), {
      kind: 'setStartBarline',
      measureIdx: 0,
      barline: 'repeat-start',
    })
    expect(sc.measures[0].startBarline).toBe('repeat-start')
    sc = applyOperation(sc, { kind: 'setStartBarline', measureIdx: 0 })
    expect(sc.measures[0].startBarline).toBeUndefined()
  })

  it('clears endBarline when barline is omitted', () => {
    let sc = applyOperation(twoBars(), {
      kind: 'setEndBarline',
      measureIdx: 1,
      barline: 'final',
    })
    expect(sc.measures[1].endBarline).toBe('final')
    sc = applyOperation(sc, { kind: 'setEndBarline', measureIdx: 1 })
    expect(sc.measures[1].endBarline).toBeUndefined()
  })

  it('rejects out-of-range measureIdx (setStartBarline)', () => {
    expect(() =>
      applyOperation(twoBars(), {
        kind: 'setStartBarline',
        measureIdx: 5,
        barline: 'thin',
      }),
    ).toThrow(/out of range/)
  })

  it('rejects out-of-range measureIdx (setEndBarline)', () => {
    expect(() =>
      applyOperation(twoBars(), {
        kind: 'setEndBarline',
        measureIdx: -1,
        barline: 'thin',
      }),
    ).toThrow(/out of range/)
  })

  it('staffIdx routes to secondStaff', () => {
    const sc: Score = {
      ...twoBars(),
      secondStaff: {
        clef: 'bass',
        measures: [
          {
            events: [
              { pitches: [{ step: 'C', octave: 3 }], duration: 'whole' },
            ],
          },
          {
            events: [
              { pitches: [{ step: 'G', octave: 3 }], duration: 'whole' },
            ],
          },
        ],
      },
    }
    const next = applyOperation(sc, {
      kind: 'setStartBarline',
      staffIdx: 1,
      measureIdx: 0,
      barline: 'repeat-start',
    })
    expect(next.secondStaff!.measures[0].startBarline).toBe('repeat-start')
    // primary staff untouched
    expect(next.measures[0].startBarline).toBeUndefined()
  })

  it('a repeat-start + repeat-end pair survives validateScore', () => {
    let sc = applyOperation(twoBars(), {
      kind: 'setStartBarline',
      measureIdx: 0,
      barline: 'repeat-start',
    })
    sc = applyOperation(sc, {
      kind: 'setEndBarline',
      measureIdx: 1,
      barline: 'repeat-end',
    })
    expect(sc.measures[0].startBarline).toBe('repeat-start')
    expect(sc.measures[1].endBarline).toBe('repeat-end')
    expect(() => validateScore(sc)).not.toThrow()
  })
})

describe('setPickup', () => {
  it('marks measure as pickup', () => {
    // Shorten the first measure so validateMeasureDuration accepts
    // the pickup short-bar.
    const sc: Score = {
      ...twoBars(),
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
          ],
        },
        twoBars().measures[1],
      ],
    }
    const next = applyOperation(sc, {
      kind: 'setPickup',
      measureIdx: 0,
      isPickup: true,
    })
    expect(next.measures[0].isPickup).toBe(true)
    expect(() => validateScore(next)).not.toThrow()
  })

  it('false strips the field (clean JSON)', () => {
    let sc = applyOperation(twoBars(), {
      kind: 'setPickup',
      measureIdx: 1,
      isPickup: true,
    })
    expect(sc.measures[1].isPickup).toBe(true)
    sc = applyOperation(sc, {
      kind: 'setPickup',
      measureIdx: 1,
      isPickup: false,
    })
    expect(sc.measures[1].isPickup).toBeUndefined()
  })

  it('rejects out-of-range measureIdx', () => {
    expect(() =>
      applyOperation(twoBars(), {
        kind: 'setPickup',
        measureIdx: 99,
        isPickup: true,
      }),
    ).toThrow(/out of range/)
  })
})

describe('setFinalPartial', () => {
  it('marks measure as final-partial', () => {
    // Shorten the second measure so validateMeasureDuration accepts
    // the final-partial short-bar.
    const sc: Score = {
      ...twoBars(),
      measures: [
        twoBars().measures[0],
        {
          events: [
            { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
          ],
        },
      ],
    }
    const next = applyOperation(sc, {
      kind: 'setFinalPartial',
      measureIdx: 1,
      isFinalPartial: true,
    })
    expect(next.measures[1].isFinalPartial).toBe(true)
    expect(() => validateScore(next)).not.toThrow()
  })

  it('false strips the field', () => {
    let sc = applyOperation(twoBars(), {
      kind: 'setFinalPartial',
      measureIdx: 0,
      isFinalPartial: true,
    })
    expect(sc.measures[0].isFinalPartial).toBe(true)
    sc = applyOperation(sc, {
      kind: 'setFinalPartial',
      measureIdx: 0,
      isFinalPartial: false,
    })
    expect(sc.measures[0].isFinalPartial).toBeUndefined()
  })
})

describe('staffIdx:1 on a single-staff score is REJECTED (no silent no-op)', () => {
  // Pre-fix: getStaffMeasures falls back to score.measures when no
  // secondStaff exists, so a staffIdx:1 op would silently target
  // the primary staff (giving the LLM a successful apply with no
  // diff and no retry signal). assertStaffExists now throws.
  it('setStartBarline staffIdx:1 throws when score has no secondStaff', () => {
    expect(() =>
      applyOperation(twoBars(), {
        kind: 'setStartBarline',
        staffIdx: 1,
        measureIdx: 0,
        barline: 'thin',
      }),
    ).toThrow(/staffIdx=1 does not exist/)
  })

  it('setEndBarline staffIdx:1 throws when score has no secondStaff', () => {
    expect(() =>
      applyOperation(twoBars(), {
        kind: 'setEndBarline',
        staffIdx: 1,
        measureIdx: 0,
        barline: 'thin',
      }),
    ).toThrow(/staffIdx=1 does not exist/)
  })

  it('setPickup staffIdx:1 throws when score has no secondStaff', () => {
    expect(() =>
      applyOperation(twoBars(), {
        kind: 'setPickup',
        staffIdx: 1,
        measureIdx: 0,
        isPickup: true,
      }),
    ).toThrow(/staffIdx=1 does not exist/)
  })

  it('setFinalPartial staffIdx:1 throws when score has no secondStaff', () => {
    expect(() =>
      applyOperation(twoBars(), {
        kind: 'setFinalPartial',
        staffIdx: 1,
        measureIdx: 0,
        isFinalPartial: true,
      }),
    ).toThrow(/staffIdx=1 does not exist/)
  })

  it('setBarlineFermata staffIdx:1 throws when score has no secondStaff (consistency fix)', () => {
    expect(() =>
      applyOperation(twoBars(), {
        kind: 'setBarlineFermata',
        staffIdx: 1,
        measureIdx: 0,
        barlineFermata: 'standard',
      }),
    ).toThrow(/staffIdx=1 does not exist/)
  })
})

describe('barline ops coexist with other measure-level fields', () => {
  it('barlineFermata + startBarline + endBarline all on the same measure', () => {
    let sc = applyOperation(twoBars(), {
      kind: 'setStartBarline',
      measureIdx: 0,
      barline: 'double',
    })
    sc = applyOperation(sc, {
      kind: 'setEndBarline',
      measureIdx: 0,
      barline: 'repeat-end',
    })
    sc = applyOperation(sc, {
      kind: 'setBarlineFermata',
      measureIdx: 0,
      barlineFermata: 'long',
    })
    const m0 = sc.measures[0]
    expect(m0.startBarline).toBe('double')
    expect(m0.endBarline).toBe('repeat-end')
    expect(m0.barlineFermata).toBe('long')
    expect(() => validateScore(sc)).not.toThrow()
  })
})
