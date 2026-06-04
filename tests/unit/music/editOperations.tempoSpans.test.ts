import { describe, it, expect } from 'vitest'
import { applyOperation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import { TEMPO_SPAN_KINDS, isTempoSpan, createSpan } from '@/lib/music/spans'
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

describe('TEMPO_SPAN_KINDS + isTempoSpan', () => {
  it('exposes the two tempo kinds', () => {
    expect([...TEMPO_SPAN_KINDS]).toEqual(['accel', 'rit'])
  })

  it('isTempoSpan returns true for accel and rit, false otherwise', () => {
    const accel = createSpan('accel', idA, idD)
    const rit = createSpan('rit', idA, idD)
    const slur = createSpan('slur', idA, idD)
    const hairpin = createSpan('hairpin-cresc', idA, idD)
    expect(isTempoSpan(accel)).toBe(true)
    expect(isTempoSpan(rit)).toBe(true)
    expect(isTempoSpan(slur)).toBe(false)
    expect(isTempoSpan(hairpin)).toBe(false)
  })
})

describe('insertTempoSpan', () => {
  it('adds a basic accel span with minted id; survives validateScore', () => {
    const next = applyOperation(score(), {
      kind: 'insertTempoSpan',
      tempoSpan: { kind: 'accel', startEventId: idA, endEventId: idD },
    })
    expect(next.spans).toHaveLength(1)
    expect(next.spans![0].kind).toBe('accel')
    expect(next.spans![0].startEventId).toBe(idA)
    expect(next.spans![0].endEventId).toBe(idD)
    expect(typeof next.spans![0].id).toBe('string')
    expect(() => validateScore(next)).not.toThrow()
  })

  it('adds a rit span with terminal tempo (endTempoBpm)', () => {
    const next = applyOperation(score(), {
      kind: 'insertTempoSpan',
      tempoSpan: {
        kind: 'rit',
        startEventId: idA,
        endEventId: idF,
        endTempoBpm: 60,
      },
    })
    expect(next.spans![0].kind).toBe('rit')
    expect(next.spans![0].endTempoBpm).toBe(60)
    expect(() => validateScore(next)).not.toThrow()
  })

  it('adds a span with endTempoText ("a tempo")', () => {
    const next = applyOperation(score(), {
      kind: 'insertTempoSpan',
      tempoSpan: {
        kind: 'rit',
        startEventId: idA,
        endEventId: idF,
        endTempoText: 'a tempo',
      },
    })
    expect(next.spans![0].endTempoText).toBe('a tempo')
  })

  it('carries both endTempoBpm and endTempoText together', () => {
    const next = applyOperation(score(), {
      kind: 'insertTempoSpan',
      tempoSpan: {
        kind: 'rit',
        startEventId: idA,
        endEventId: idF,
        endTempoBpm: 90,
        endTempoText: 'meno mosso',
      },
    })
    expect(next.spans![0].endTempoBpm).toBe(90)
    expect(next.spans![0].endTempoText).toBe('meno mosso')
  })

  it('honors explicit placement', () => {
    const next = applyOperation(score(), {
      kind: 'insertTempoSpan',
      tempoSpan: {
        kind: 'accel',
        startEventId: idA,
        endEventId: idD,
        placement: 'above',
      },
    })
    expect(next.spans![0].placement).toBe('above')
  })

  it('rejects missing startEventId', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertTempoSpan',
        tempoSpan: { kind: 'accel', startEventId: 'doesnotexist', endEventId: idD },
      }),
    ).toThrow(/startEventId .* does not match/)
  })

  it('rejects missing endEventId', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertTempoSpan',
        tempoSpan: { kind: 'rit', startEventId: idA, endEventId: 'doesnotexist' },
      }),
    ).toThrow(/endEventId .* does not match/)
  })

  it('rejects reversed start/end (must extend forward)', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertTempoSpan',
        tempoSpan: { kind: 'accel', startEventId: idD, endEventId: idA },
      }),
    ).toThrow(/extend FORWARD/)
  })

  it('rejects id collision', () => {
    const sc: Score = {
      ...score(),
      spans: [createSpan('hairpin-cresc', idA, idB)],
    }
    const existingId = sc.spans![0].id!
    expect(() =>
      applyOperation(sc, {
        kind: 'insertTempoSpan',
        tempoSpan: {
          kind: 'accel',
          id: existingId,
          startEventId: idA,
          endEventId: idD,
        },
      }),
    ).toThrow(/collides with an existing span/)
  })

  it('rejects mismatched staffIdx/voiceIdx vs start event location', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertTempoSpan',
        tempoSpan: {
          kind: 'accel',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 1, // wrong; event idA is staff 0
        },
      }),
    ).toThrow(/does not match the start event's location/)
  })
})

describe('removeTempoSpan', () => {
  it('removes a tempo span by id', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertTempoSpan',
      tempoSpan: { kind: 'accel', startEventId: idA, endEventId: idD },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, { kind: 'removeTempoSpan', id })
    expect(next.spans).toBeUndefined()
  })

  it('rejects removing a non-tempo span via removeTempoSpan', () => {
    const sc: Score = {
      ...score(),
      spans: [createSpan('slur', idA, idD)],
    }
    const id = sc.spans![0].id!
    expect(() => applyOperation(sc, { kind: 'removeTempoSpan', id })).toThrow(
      /not a tempo span/,
    )
  })

  it('rejects unknown id', () => {
    expect(() =>
      applyOperation(score(), { kind: 'removeTempoSpan', id: 'notreallyid' }),
    ).toThrow(/not found/)
  })

  it('preserves OTHER spans when removing one tempo span', () => {
    let sc = applyOperation(score(), {
      kind: 'insertTempoSpan',
      tempoSpan: { kind: 'accel', startEventId: idA, endEventId: idD },
    })
    const slurId = 'preservedid'
    sc = { ...sc, spans: [...(sc.spans ?? []), { ...createSpan('slur', idE, idF), id: slurId }] }
    const tempoId = sc.spans![0].id!
    const next = applyOperation(sc, { kind: 'removeTempoSpan', id: tempoId })
    expect(next.spans).toHaveLength(1)
    expect(next.spans![0].id).toBe(slurId)
  })
})

describe('updateTempoSpan', () => {
  it('patches a single field (endTempoBpm)', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertTempoSpan',
      tempoSpan: { kind: 'accel', startEventId: idA, endEventId: idD, endTempoBpm: 120 },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateTempoSpan',
      id,
      patch: { endTempoBpm: 144 },
    })
    expect(next.spans![0].endTempoBpm).toBe(144)
    expect(next.spans![0].kind).toBe('accel') // unchanged
  })

  it('null clears endTempoBpm', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertTempoSpan',
      tempoSpan: { kind: 'accel', startEventId: idA, endEventId: idD, endTempoBpm: 120 },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateTempoSpan',
      id,
      patch: { endTempoBpm: null },
    })
    expect(next.spans![0].endTempoBpm).toBeUndefined()
  })

  it('null clears endTempoText', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertTempoSpan',
      tempoSpan: {
        kind: 'rit',
        startEventId: idA,
        endEventId: idD,
        endTempoText: 'meno mosso',
      },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateTempoSpan',
      id,
      patch: { endTempoText: null },
    })
    expect(next.spans![0].endTempoText).toBeUndefined()
  })

  it('undefined preserves prior value (carry semantics)', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertTempoSpan',
      tempoSpan: { kind: 'rit', startEventId: idA, endEventId: idD, endTempoBpm: 60, endTempoText: 'a tempo' },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateTempoSpan',
      id,
      patch: { kind: 'accel' }, // only kind changes; bpm + text carry
    })
    expect(next.spans![0].kind).toBe('accel')
    expect(next.spans![0].endTempoBpm).toBe(60)
    expect(next.spans![0].endTempoText).toBe('a tempo')
  })

  it('endpoint re-anchor re-validates same-voice + forward order', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertTempoSpan',
      tempoSpan: { kind: 'accel', startEventId: idA, endEventId: idD },
    })
    const id = inserted.spans![0].id!
    expect(() =>
      applyOperation(inserted, {
        kind: 'updateTempoSpan',
        id,
        patch: { startEventId: idD, endEventId: idA }, // reversed
      }),
    ).toThrow(/start .* is AFTER end/)
  })

  it('rejects re-anchor to missing event', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertTempoSpan',
      tempoSpan: { kind: 'accel', startEventId: idA, endEventId: idD },
    })
    const id = inserted.spans![0].id!
    expect(() =>
      applyOperation(inserted, {
        kind: 'updateTempoSpan',
        id,
        patch: { endEventId: 'doesnotexist' },
      }),
    ).toThrow(/does not match any event/)
  })

  it('empty patch is a no-op (all fields carry)', () => {
    // Mirrors editOperations.slurs.test.ts and .hairpins.test.ts
    // empty-patch pins so a future refactor that drops a
    // carry-or-patch branch fails fast. Every optional field
    // (placement, endTempoBpm, endTempoText) is populated before
    // the patch so any silent-strip would surface here.
    const inserted = applyOperation(score(), {
      kind: 'insertTempoSpan',
      tempoSpan: {
        kind: 'rit',
        startEventId: idA,
        endEventId: idD,
        placement: 'above',
        endTempoBpm: 60,
        endTempoText: 'a tempo',
      },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateTempoSpan',
      id,
      patch: {},
    })
    expect(next.spans![0].kind).toBe('rit')
    expect(next.spans![0].placement).toBe('above')
    expect(next.spans![0].endTempoBpm).toBe(60)
    expect(next.spans![0].endTempoText).toBe('a tempo')
  })

  it('rejects update of non-tempo span via updateTempoSpan', () => {
    const sc: Score = {
      ...score(),
      spans: [createSpan('slur', idA, idD)],
    }
    const id = sc.spans![0].id!
    expect(() =>
      applyOperation(sc, {
        kind: 'updateTempoSpan',
        id,
        patch: { kind: 'rit' },
      }),
    ).toThrow(/not a tempo span/)
  })
})

describe('schema validation', () => {
  it('SpanSchema accepts endTempoBpm 30..240', () => {
    for (const bpm of [30, 60, 120, 144, 240]) {
      const sc: Score = {
        ...score(),
        spans: [{ ...createSpan('rit', idA, idD), endTempoBpm: bpm }],
      }
      expect(() => validateScore(sc)).not.toThrow()
    }
  })

  it('SpanSchema rejects endTempoBpm out of range', () => {
    const sc: Score = {
      ...score(),
      spans: [{ ...createSpan('rit', idA, idD), endTempoBpm: 250 }],
    }
    expect(() => validateScore(sc)).toThrow()
  })

  it('SpanSchema accepts endTempoText up to 40 chars', () => {
    const sc: Score = {
      ...score(),
      spans: [{ ...createSpan('rit', idA, idD), endTempoText: 'a tempo' }],
    }
    expect(() => validateScore(sc)).not.toThrow()
  })

  it('SpanSchema rejects endTempoText > 40 chars', () => {
    const sc: Score = {
      ...score(),
      spans: [{ ...createSpan('rit', idA, idD), endTempoText: 'x'.repeat(41) }],
    }
    expect(() => validateScore(sc)).toThrow()
  })
})
