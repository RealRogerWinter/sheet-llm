import { describe, it, expect } from 'vitest'
import { applyOperation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
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
  // Primary voice (idx 0) and an extra voice (idx 1) on the same staff,
  // so cross-voice rejection cases can resolve real targets in each voice.
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

function scoreWithSecondStaff(): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: [
      {
        events: [
          { id: idA, pitches: [{ step: 'C', octave: 5 }], duration: 'whole' },
        ],
      },
    ],
    secondStaff: {
      clef: 'bass',
      measures: [
        {
          events: [
            { id: idB, pitches: [{ step: 'C', octave: 3 }], duration: 'whole' },
          ],
        },
      ],
    },
  }
}

describe('insertHairpin', () => {
  it('adds a crescendo with minted id and survives validateScore', () => {
    const next = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: idD },
    })
    expect(next.spans).toHaveLength(1)
    expect(next.spans![0].kind).toBe('hairpin-cresc')
    expect(next.spans![0].startEventId).toBe(idA)
    expect(next.spans![0].endEventId).toBe(idD)
    expect(next.spans![0].staffIdx).toBe(0)
    expect(next.spans![0].voiceIdx).toBe(0)
    expect(typeof next.spans![0].id).toBe('string')
    expect(next.spans![0].id!.length).toBeGreaterThanOrEqual(8)
    expect(() => validateScore(next)).not.toThrow()
  })

  it('adds a diminuendo with terminal dynamics', () => {
    const next = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: {
        kind: 'hairpin-dim',
        startEventId: idA,
        endEventId: idD,
        startDynamic: 'f',
        endDynamic: 'p',
      },
    })
    expect(next.spans![0].kind).toBe('hairpin-dim')
    expect(next.spans![0].startDynamic).toBe('f')
    expect(next.spans![0].endDynamic).toBe('p')
  })

  it('accepts optional placement', () => {
    const next = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: {
        kind: 'hairpin-cresc',
        startEventId: idA,
        endEventId: idD,
        placement: 'below',
      },
    })
    expect(next.spans![0].placement).toBe('below')
  })

  it('spans cross a barline (start in m1, end in m2)', () => {
    const next = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: idF },
    })
    expect(next.spans).toHaveLength(1)
    expect(() => validateScore(next)).not.toThrow()
  })

  it('appends to existing spans rather than overwriting', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: idB },
    })
    const withTwo = applyOperation(withOne, {
      kind: 'insertHairpin',
      hairpin: { kind: 'hairpin-dim', startEventId: idC, endEventId: idD },
    })
    expect(withTwo.spans).toHaveLength(2)
  })

  it('throws on missing startEventId', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertHairpin',
        hairpin: { kind: 'hairpin-cresc', startEventId: 'doesnotexist', endEventId: idD },
      }),
    ).toThrow(/startEventId.*does not match/)
  })

  it('throws on missing endEventId', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertHairpin',
        hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: 'doesnotexist' },
      }),
    ).toThrow(/endEventId.*does not match/)
  })

  it('throws on reversed start/end (in same measure)', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertHairpin',
        hairpin: { kind: 'hairpin-cresc', startEventId: idD, endEventId: idA },
      }),
    ).toThrow(/is AFTER end/)
  })

  it('throws on reversed start/end (across measures)', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertHairpin',
        hairpin: { kind: 'hairpin-cresc', startEventId: idF, endEventId: idA },
      }),
    ).toThrow(/is AFTER end/)
  })

  it('throws when endpoints are on different staves', () => {
    expect(() =>
      applyOperation(scoreWithSecondStaff(), {
        kind: 'insertHairpin',
        hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: idB },
      }),
    ).toThrow(/different staves\/voices/)
  })

  it('throws on staffIdx mismatch (LLM passes wrong staff)', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertHairpin',
        hairpin: {
          kind: 'hairpin-cresc',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 1, // start is actually on staff 0
        },
      }),
    ).toThrow(/staffIdx\/voiceIdx.*does not match/)
  })

  it('throws on id collision with existing span', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: { id: 'hairpin001', kind: 'hairpin-cresc', startEventId: idA, endEventId: idB },
    })
    expect(() =>
      applyOperation(withOne, {
        kind: 'insertHairpin',
        hairpin: { id: 'hairpin001', kind: 'hairpin-dim', startEventId: idC, endEventId: idD },
      }),
    ).toThrow(/collides/)
  })

  it('zero-duration hairpin (start === end) is permitted by the validator (one-event swell)', () => {
    // The schema only requires start <= end. A note-on-itself "hairpin"
    // is unusual but a valid limit case (e.g. fz wedge collapsed onto
    // a single note); validateCrossRefs allows it.
    const next = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: idA },
    })
    expect(next.spans).toHaveLength(1)
    expect(() => validateScore(next)).not.toThrow()
  })
})

describe('removeHairpin', () => {
  it('removes a hairpin by id and clears spans key when last is gone', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: idD },
    })
    const id = withOne.spans![0].id!
    const next = applyOperation(withOne, { kind: 'removeHairpin', id })
    expect(next.spans).toBeUndefined()
  })

  it('preserves other spans when one is removed', () => {
    const withTwo = applyOperation(
      applyOperation(score(), {
        kind: 'insertHairpin',
        hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: idB },
      }),
      {
        kind: 'insertHairpin',
        hairpin: { kind: 'hairpin-dim', startEventId: idC, endEventId: idD },
      },
    )
    const firstId = withTwo.spans![0].id!
    const next = applyOperation(withTwo, { kind: 'removeHairpin', id: firstId })
    expect(next.spans).toHaveLength(1)
    expect(next.spans![0].kind).toBe('hairpin-dim')
  })

  it('throws when id is not found', () => {
    expect(() =>
      applyOperation(score(), { kind: 'removeHairpin', id: 'notpresent01' }),
    ).toThrow(/not found/)
  })

  it('throws when id points at a non-hairpin span (slur)', () => {
    // Insert a slur directly through the score (not via an edit op,
    // since the slur edit op doesn't ship until M12).
    const sc = score()
    sc.spans = [
      {
        id: 'slurabc123',
        kind: 'slur',
        startEventId: idA,
        endEventId: idD,
        staffIdx: 0,
        voiceIdx: 0,
      },
    ]
    expect(() =>
      applyOperation(sc, { kind: 'removeHairpin', id: 'slurabc123' }),
    ).toThrow(/is a slur span, not a hairpin/)
  })
})

describe('updateHairpin', () => {
  it('updates terminal dynamics in place', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: idD },
    })
    const id = withOne.spans![0].id!
    const next = applyOperation(withOne, {
      kind: 'updateHairpin',
      id,
      patch: { startDynamic: 'p', endDynamic: 'f' },
    })
    expect(next.spans![0].startDynamic).toBe('p')
    expect(next.spans![0].endDynamic).toBe('f')
    expect(next.spans![0].id).toBe(id)
  })

  it('clears a dynamic when patch field is null', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: {
        kind: 'hairpin-cresc',
        startEventId: idA,
        endEventId: idD,
        startDynamic: 'p',
        endDynamic: 'f',
      },
    })
    const id = withOne.spans![0].id!
    const next = applyOperation(withOne, {
      kind: 'updateHairpin',
      id,
      patch: { startDynamic: null },
    })
    expect(next.spans![0].startDynamic).toBeUndefined()
    expect(next.spans![0].endDynamic).toBe('f')
  })

  it('re-anchors start/end events and updates voice/staff to match', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: idB },
    })
    const id = withOne.spans![0].id!
    const next = applyOperation(withOne, {
      kind: 'updateHairpin',
      id,
      patch: { startEventId: idC, endEventId: idF },
    })
    expect(next.spans![0].startEventId).toBe(idC)
    expect(next.spans![0].endEventId).toBe(idF)
    expect(() => validateScore(next)).not.toThrow()
  })

  it('flips kind from cresc to dim', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: idD },
    })
    const id = withOne.spans![0].id!
    const next = applyOperation(withOne, {
      kind: 'updateHairpin',
      id,
      patch: { kind: 'hairpin-dim' },
    })
    expect(next.spans![0].kind).toBe('hairpin-dim')
  })

  it('throws when id not found', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'updateHairpin',
        id: 'notpresent01',
        patch: { startDynamic: 'p' },
      }),
    ).toThrow(/not found/)
  })

  it('throws when id points at a non-hairpin span', () => {
    const sc = score()
    sc.spans = [
      {
        id: 'slurabc123',
        kind: 'slur',
        startEventId: idA,
        endEventId: idD,
        staffIdx: 0,
        voiceIdx: 0,
      },
    ]
    expect(() =>
      applyOperation(sc, {
        kind: 'updateHairpin',
        id: 'slurabc123',
        patch: { startDynamic: 'p' },
      }),
    ).toThrow(/is a slur span, not a hairpin/)
  })

  it('throws when re-anchoring to a missing event', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: idD },
    })
    const id = withOne.spans![0].id!
    expect(() =>
      applyOperation(withOne, {
        kind: 'updateHairpin',
        id,
        patch: { startEventId: 'doesnotexist' },
      }),
    ).toThrow(/does not match any event/)
  })

  it('throws when re-anchoring produces reversed start/end', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: idB },
    })
    const id = withOne.spans![0].id!
    expect(() =>
      applyOperation(withOne, {
        kind: 'updateHairpin',
        id,
        patch: { startEventId: idF, endEventId: idA },
      }),
    ).toThrow(/is AFTER end/)
  })

  it('throws when re-anchoring crosses voice boundaries', () => {
    // Set up: hairpin on voice 0 endpoints, then try to re-anchor the
    // start endpoint to a voice 1 event — same staff, different voice.
    const sc0 = scoreWithTwoVoices()
    const withOne = applyOperation(sc0, {
      kind: 'insertHairpin',
      hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: idB },
    })
    const id = withOne.spans![0].id!
    expect(() =>
      applyOperation(withOne, {
        kind: 'updateHairpin',
        id,
        patch: { startEventId: idC },
      }),
    ).toThrow(/different staves\/voices/)
  })

  it('flipping kind preserves startDynamic / endDynamic', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: {
        kind: 'hairpin-cresc',
        startEventId: idA,
        endEventId: idD,
        startDynamic: 'p',
        endDynamic: 'f',
      },
    })
    const id = withOne.spans![0].id!
    const next = applyOperation(withOne, {
      kind: 'updateHairpin',
      id,
      patch: { kind: 'hairpin-dim' },
    })
    expect(next.spans![0].kind).toBe('hairpin-dim')
    expect(next.spans![0].startDynamic).toBe('p')
    expect(next.spans![0].endDynamic).toBe('f')
  })

  it('empty patch is a no-op (re-validates but does not change fields)', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertHairpin',
      hairpin: {
        kind: 'hairpin-cresc',
        startEventId: idA,
        endEventId: idD,
        startDynamic: 'p',
        endDynamic: 'f',
        placement: 'below',
      },
    })
    const before = withOne.spans![0]
    const next = applyOperation(withOne, {
      kind: 'updateHairpin',
      id: before.id!,
      patch: {},
    })
    expect(next.spans![0]).toEqual(before)
  })
})

describe('hairpin ops coexist with non-hairpin spans', () => {
  it('insertHairpin preserves a pre-existing slur', () => {
    const sc = score()
    sc.spans = [
      {
        id: 'slurabc123',
        kind: 'slur',
        startEventId: idA,
        endEventId: idD,
        staffIdx: 0,
        voiceIdx: 0,
      },
    ]
    const next = applyOperation(sc, {
      kind: 'insertHairpin',
      hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: idB },
    })
    expect(next.spans).toHaveLength(2)
    expect(next.spans![0].kind).toBe('slur')
    expect(next.spans![1].kind).toBe('hairpin-cresc')
  })

  it('removeHairpin preserves an unrelated slur in spans', () => {
    const sc = score()
    sc.spans = [
      {
        id: 'slurabc123',
        kind: 'slur',
        startEventId: idA,
        endEventId: idD,
        staffIdx: 0,
        voiceIdx: 0,
      },
    ]
    const withHairpin = applyOperation(sc, {
      kind: 'insertHairpin',
      hairpin: { kind: 'hairpin-cresc', startEventId: idA, endEventId: idB },
    })
    const hairpinId = withHairpin.spans!.find((s) => s.kind === 'hairpin-cresc')!.id!
    const next = applyOperation(withHairpin, { kind: 'removeHairpin', id: hairpinId })
    expect(next.spans).toHaveLength(1)
    expect(next.spans![0].kind).toBe('slur')
    expect(next.spans![0].id).toBe('slurabc123')
  })
})
