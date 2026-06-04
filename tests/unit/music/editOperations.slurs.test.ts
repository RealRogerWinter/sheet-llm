import { describe, it, expect } from 'vitest'
import { applyOperation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import { SLUR_KINDS, isSlur, createSpan } from '@/lib/music/spans'
import type { Score } from '@/lib/music/types'

const idA = 'evtestid01'
const idB = 'evtestid02'
const idC = 'evtestid03'
const idD = 'evtestid04'
const idE = 'evtestid05'
const idF = 'evtestid06'

function score(): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: [
      {
        events: [
          { id: idA, pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
          { id: idB, pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
          { id: idC, pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
          { id: idD, pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
        ],
      },
      {
        events: [
          { id: idE, pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
          { id: idF, pitches: [{ step: 'A', octave: 4 }], duration: 'half' },
        ],
      },
    ],
  }
}

function scoreWithTwoVoices(): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: [
      {
        events: [
          { id: idA, pitches: [{ step: 'C', octave: 5 }], duration: 'half' },
          { id: idB, pitches: [{ step: 'D', octave: 5 }], duration: 'half' },
        ],
      },
    ],
    extraVoices: [
      {
        measures: [
          {
            events: [
              { id: idC, pitches: [{ step: 'E', octave: 4 }], duration: 'half' },
              { id: idD, pitches: [{ step: 'F', octave: 4 }], duration: 'half' },
            ],
          },
        ],
      },
    ],
  }
}

describe('insertSlur', () => {
  it('adds a slur with minted id and survives validateScore', () => {
    const next = applyOperation(score(), {
      kind: 'insertSlur',
      slur: { kind: 'slur', startEventId: idA, endEventId: idD },
    })
    expect(next.spans).toHaveLength(1)
    expect(next.spans![0].kind).toBe('slur')
    expect(next.spans![0].startEventId).toBe(idA)
    expect(next.spans![0].endEventId).toBe(idD)
    expect(typeof next.spans![0].id).toBe('string')
    expect(() => validateScore(next)).not.toThrow()
  })

  it('adds a phrase-slur (broader curve)', () => {
    const next = applyOperation(score(), {
      kind: 'insertSlur',
      slur: { kind: 'phrase-slur', startEventId: idA, endEventId: idF },
    })
    expect(next.spans![0].kind).toBe('phrase-slur')
    expect(() => validateScore(next)).not.toThrow()
  })

  it('accepts optional placement', () => {
    const next = applyOperation(score(), {
      kind: 'insertSlur',
      slur: { kind: 'slur', startEventId: idA, endEventId: idD, placement: 'above' },
    })
    expect(next.spans![0].placement).toBe('above')
  })

  it('crosses a barline (start in m1, end in m2)', () => {
    const next = applyOperation(score(), {
      kind: 'insertSlur',
      slur: { kind: 'slur', startEventId: idA, endEventId: idF },
    })
    expect(next.spans).toHaveLength(1)
    expect(() => validateScore(next)).not.toThrow()
  })

  it('appends to existing spans rather than overwriting', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertSlur',
      slur: { kind: 'slur', startEventId: idA, endEventId: idB },
    })
    const withTwo = applyOperation(withOne, {
      kind: 'insertSlur',
      slur: { kind: 'phrase-slur', startEventId: idC, endEventId: idD },
    })
    expect(withTwo.spans).toHaveLength(2)
  })

  it('throws on missing startEventId', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertSlur',
        slur: { kind: 'slur', startEventId: 'doesnotexist', endEventId: idD },
      }),
    ).toThrow(/startEventId.*does not match/)
  })

  it('throws on missing endEventId', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertSlur',
        slur: { kind: 'slur', startEventId: idA, endEventId: 'doesnotexist' },
      }),
    ).toThrow(/endEventId.*does not match/)
  })

  it('throws on reversed start/end', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertSlur',
        slur: { kind: 'slur', startEventId: idF, endEventId: idA },
      }),
    ).toThrow(/is AFTER end/)
  })

  it('throws when endpoints are on different voices', () => {
    expect(() =>
      applyOperation(scoreWithTwoVoices(), {
        kind: 'insertSlur',
        slur: { kind: 'slur', startEventId: idA, endEventId: idC },
      }),
    ).toThrow(/different staves\/voices/)
  })

  it('throws on staffIdx mismatch with start event location', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertSlur',
        slur: { kind: 'slur', startEventId: idA, endEventId: idD, staffIdx: 1 },
      }),
    ).toThrow(/staffIdx\/voiceIdx.*does not match/)
  })

  it('throws on id collision with existing span', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertSlur',
      slur: { id: 'slurabcde1', kind: 'slur', startEventId: idA, endEventId: idB },
    })
    expect(() =>
      applyOperation(withOne, {
        kind: 'insertSlur',
        slur: { id: 'slurabcde1', kind: 'slur', startEventId: idC, endEventId: idD },
      }),
    ).toThrow(/collides/)
  })

  it('zero-duration slur (start === end) is permitted', () => {
    const next = applyOperation(score(), {
      kind: 'insertSlur',
      slur: { kind: 'slur', startEventId: idA, endEventId: idA },
    })
    expect(next.spans).toHaveLength(1)
    expect(() => validateScore(next)).not.toThrow()
  })
})

describe('removeSlur', () => {
  it('removes a slur by id and clears spans when last is gone', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertSlur',
      slur: { kind: 'slur', startEventId: idA, endEventId: idD },
    })
    const id = withOne.spans![0].id!
    const next = applyOperation(withOne, { kind: 'removeSlur', id })
    expect(next.spans).toBeUndefined()
  })

  it('preserves other spans when one is removed', () => {
    const withTwo = applyOperation(
      applyOperation(score(), {
        kind: 'insertSlur',
        slur: { kind: 'slur', startEventId: idA, endEventId: idB },
      }),
      {
        kind: 'insertSlur',
        slur: { kind: 'phrase-slur', startEventId: idC, endEventId: idD },
      },
    )
    const firstId = withTwo.spans![0].id!
    const next = applyOperation(withTwo, { kind: 'removeSlur', id: firstId })
    expect(next.spans).toHaveLength(1)
    expect(next.spans![0].kind).toBe('phrase-slur')
  })

  it('throws when id is not found', () => {
    expect(() =>
      applyOperation(score(), { kind: 'removeSlur', id: 'notpresent01' }),
    ).toThrow(/not found/)
  })

  it('throws when id points at a non-slur span (hairpin)', () => {
    const sc = score()
    sc.spans = [
      {
        id: 'hairpin001',
        kind: 'hairpin-cresc',
        startEventId: idA,
        endEventId: idD,
        staffIdx: 0,
        voiceIdx: 0,
      },
    ]
    expect(() =>
      applyOperation(sc, { kind: 'removeSlur', id: 'hairpin001' }),
    ).toThrow(/is a hairpin-cresc span, not a slur/)
  })
})

describe('updateSlur', () => {
  it('updates placement in place', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertSlur',
      slur: { kind: 'slur', startEventId: idA, endEventId: idD },
    })
    const id = withOne.spans![0].id!
    const next = applyOperation(withOne, {
      kind: 'updateSlur',
      id,
      patch: { placement: 'below' },
    })
    expect(next.spans![0].placement).toBe('below')
    expect(next.spans![0].id).toBe(id)
  })

  it('clears placement when patch field is null', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertSlur',
      slur: { kind: 'slur', startEventId: idA, endEventId: idD, placement: 'above' },
    })
    const id = withOne.spans![0].id!
    const next = applyOperation(withOne, {
      kind: 'updateSlur',
      id,
      patch: { placement: null },
    })
    expect(next.spans![0].placement).toBeUndefined()
  })

  it('re-anchors start/end events', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertSlur',
      slur: { kind: 'slur', startEventId: idA, endEventId: idB },
    })
    const id = withOne.spans![0].id!
    const next = applyOperation(withOne, {
      kind: 'updateSlur',
      id,
      patch: { startEventId: idC, endEventId: idF },
    })
    expect(next.spans![0].startEventId).toBe(idC)
    expect(next.spans![0].endEventId).toBe(idF)
    expect(() => validateScore(next)).not.toThrow()
  })

  it('flips kind from slur to phrase-slur', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertSlur',
      slur: { kind: 'slur', startEventId: idA, endEventId: idD },
    })
    const id = withOne.spans![0].id!
    const next = applyOperation(withOne, {
      kind: 'updateSlur',
      id,
      patch: { kind: 'phrase-slur' },
    })
    expect(next.spans![0].kind).toBe('phrase-slur')
  })

  it('throws when id not found', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'updateSlur',
        id: 'notpresent01',
        patch: { placement: 'above' },
      }),
    ).toThrow(/not found/)
  })

  it('throws when id points at a non-slur span (hairpin)', () => {
    const sc = score()
    sc.spans = [
      {
        id: 'hairpin001',
        kind: 'hairpin-dim',
        startEventId: idA,
        endEventId: idD,
        staffIdx: 0,
        voiceIdx: 0,
      },
    ]
    expect(() =>
      applyOperation(sc, {
        kind: 'updateSlur',
        id: 'hairpin001',
        patch: { placement: 'above' },
      }),
    ).toThrow(/is a hairpin-dim span, not a slur/)
  })

  it('throws when re-anchoring crosses voice boundaries', () => {
    const sc0 = scoreWithTwoVoices()
    const withOne = applyOperation(sc0, {
      kind: 'insertSlur',
      slur: { kind: 'slur', startEventId: idA, endEventId: idB },
    })
    const id = withOne.spans![0].id!
    expect(() =>
      applyOperation(withOne, {
        kind: 'updateSlur',
        id,
        patch: { startEventId: idC },
      }),
    ).toThrow(/different staves\/voices/)
  })

  it('throws when re-anchoring to a missing event', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertSlur',
      slur: { kind: 'slur', startEventId: idA, endEventId: idD },
    })
    const id = withOne.spans![0].id!
    expect(() =>
      applyOperation(withOne, {
        kind: 'updateSlur',
        id,
        patch: { startEventId: 'doesnotexist' },
      }),
    ).toThrow(/does not match any event/)
  })

  it('throws when re-anchoring produces reversed start/end', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertSlur',
      slur: { kind: 'slur', startEventId: idA, endEventId: idB },
    })
    const id = withOne.spans![0].id!
    expect(() =>
      applyOperation(withOne, {
        kind: 'updateSlur',
        id,
        patch: { startEventId: idF, endEventId: idA },
      }),
    ).toThrow(/is AFTER end/)
  })

  it('empty patch is a no-op (preserves all fields)', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertSlur',
      slur: { kind: 'phrase-slur', startEventId: idA, endEventId: idD, placement: 'below' },
    })
    const before = withOne.spans![0]
    const next = applyOperation(withOne, {
      kind: 'updateSlur',
      id: before.id!,
      patch: {},
    })
    expect(next.spans![0]).toEqual(before)
  })
})

describe('slur and hairpin coexistence', () => {
  it('insertSlur preserves a pre-existing hairpin', () => {
    const withHairpin = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: idD },
    })
    const next = applyOperation(withHairpin, {
      kind: 'insertSlur',
      slur: { kind: 'slur', startEventId: idA, endEventId: idB },
    })
    expect(next.spans).toHaveLength(2)
    expect(next.spans!.map((s) => s.kind).sort()).toEqual(['hairpin-cresc', 'slur'])
  })

  it('removeSlur preserves an unrelated hairpin', () => {
    const withHairpin = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: idD },
    })
    const withBoth = applyOperation(withHairpin, {
      kind: 'insertSlur',
      slur: { kind: 'slur', startEventId: idA, endEventId: idB },
    })
    const slurId = withBoth.spans!.find((s) => s.kind === 'slur')!.id!
    const next = applyOperation(withBoth, { kind: 'removeSlur', id: slurId })
    expect(next.spans).toHaveLength(1)
    expect(next.spans![0].kind).toBe('hairpin-cresc')
  })
})

describe('spans.ts — SLUR_KINDS / isSlur', () => {
  it('SLUR_KINDS lists exactly slur and phrase-slur', () => {
    expect(SLUR_KINDS).toEqual(['slur', 'phrase-slur'])
  })

  it('isSlur returns true for slur and phrase-slur', () => {
    expect(isSlur(createSpan('slur', idA, idB))).toBe(true)
    expect(isSlur(createSpan('phrase-slur', idA, idB))).toBe(true)
  })

  it('isSlur returns false for hairpin and other span kinds', () => {
    expect(isSlur(createSpan('hairpin-cresc', idA, idB))).toBe(false)
    expect(isSlur(createSpan('hairpin-dim', idA, idB))).toBe(false)
    expect(isSlur(createSpan('glissando', idA, idB))).toBe(false)
    expect(isSlur(createSpan('8va', idA, idB))).toBe(false)
    expect(isSlur(createSpan('pedal', idA, idB))).toBe(false)
  })
})
