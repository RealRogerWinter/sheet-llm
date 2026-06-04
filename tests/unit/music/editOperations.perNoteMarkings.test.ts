import { describe, it, expect } from 'vitest'
import { applyOperation, transformScore, EditError } from '@/lib/music/editOperations'
import type { Score } from '@/lib/music/types'

function buildScore(partial: Partial<Score> & Pick<Score, 'measures'>): Score {
  return { key: 'C', meter: '4/4', ...partial }
}

const TWO_BAR_QUARTERS: Score = buildScore({
  measures: [
    { events: [
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
    ] },
    { events: [
      { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
    ] },
  ],
})

const CHORD_BAR: Score = buildScore({
  measures: [
    {
      events: [
        {
          pitches: [
            { step: 'C', octave: 4 },
            { step: 'E', octave: 4 },
            { step: 'G', octave: 4 },
          ],
          duration: 'whole',
        },
      ],
    },
    {
      events: [
        {
          pitches: [
            { step: 'C', octave: 4 },
            { step: 'E', octave: 4 },
            { step: 'G', octave: 4 },
          ],
          duration: 'whole',
        },
      ],
    },
  ],
})

describe('editOperations — setArticulations', () => {
  it('sets the array form and strips the legacy singular field', () => {
    const seeded = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setArticulation',
      target: { measureIdx: 0, eventIdx: 0 },
      articulation: 'staccato',
    })
    expect(seeded.measures[0].events[0].articulation).toBe('staccato')

    const next = applyOperation(seeded, {
      kind: 'setArticulations',
      target: { measureIdx: 0, eventIdx: 0 },
      articulations: ['staccato', 'accent'],
    })
    expect(next.measures[0].events[0].articulations).toEqual(['staccato', 'accent'])
    expect(next.measures[0].events[0]).not.toHaveProperty('articulation')
  })

  it('auto-coerces staccato+tenuto to portato (the compound glyph)', () => {
    const next = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setArticulations',
      target: { measureIdx: 0, eventIdx: 0 },
      articulations: ['staccato', 'tenuto'],
    })
    expect(next.measures[0].events[0].articulations).toEqual(['portato'])
  })

  it('rejects marcato+accent as an engraving incoherence', () => {
    expect(() =>
      applyOperation(TWO_BAR_QUARTERS, {
        kind: 'setArticulations',
        target: { measureIdx: 0, eventIdx: 0 },
        articulations: ['marcato', 'accent'],
      }),
    ).toThrow(EditError)
  })

  it('normalizes order to innermost staccato → outermost marcato', () => {
    // Author in scrambled order; normalize sorts to canonical stacking.
    const next = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setArticulations',
      target: { measureIdx: 0, eventIdx: 0 },
      articulations: ['marcato', 'staccato'],
    })
    expect(next.measures[0].events[0].articulations).toEqual(['staccato', 'marcato'])
  })

  it('empty array clears both representations', () => {
    const seeded = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setArticulations',
      target: { measureIdx: 0, eventIdx: 0 },
      articulations: ['staccato', 'accent'],
    })
    const cleared = applyOperation(seeded, {
      kind: 'setArticulations',
      target: { measureIdx: 0, eventIdx: 0 },
      articulations: [],
    })
    expect(cleared.measures[0].events[0]).not.toHaveProperty('articulations')
    expect(cleared.measures[0].events[0]).not.toHaveProperty('articulation')
  })
})

describe('editOperations — setOrnament', () => {
  it('sets a Baroque ornament value', () => {
    const next = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setOrnament',
      target: { measureIdx: 0, eventIdx: 0 },
      ornament: 'upper-mordent',
    })
    expect(next.measures[0].events[0].ornament).toBe('upper-mordent')
  })

  it("'none' overwrites a prior ornament without removing the key", () => {
    const seeded = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setOrnament',
      target: { measureIdx: 0, eventIdx: 0 },
      ornament: 'trill',
    })
    const cleared = applyOperation(seeded, {
      kind: 'setOrnament',
      target: { measureIdx: 0, eventIdx: 0 },
      ornament: 'none',
    })
    expect(cleared.measures[0].events[0].ornament).toBe('none')
  })
})

describe('editOperations — setTrillUpperPitch', () => {
  it('sets the upper-pitch indicator', () => {
    const next = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setTrillUpperPitch',
      target: { measureIdx: 0, eventIdx: 0 },
      trillUpperPitch: 'sharp',
    })
    expect(next.measures[0].events[0].trillUpperPitch).toBe('sharp')
  })

  it('omitting trillUpperPitch removes the field', () => {
    const seeded = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setTrillUpperPitch',
      target: { measureIdx: 0, eventIdx: 0 },
      trillUpperPitch: 'flat',
    })
    const cleared = applyOperation(seeded, {
      kind: 'setTrillUpperPitch',
      target: { measureIdx: 0, eventIdx: 0 },
    })
    expect(cleared.measures[0].events[0]).not.toHaveProperty('trillUpperPitch')
  })
})

describe('editOperations — setGraceNotes (M7-PR-2)', () => {
  it('sets a single before-grace appoggiatura on the principal', () => {
    const next = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setGraceNotes',
      target: { measureIdx: 0, eventIdx: 0 },
      graceNotes: [{ pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' }],
    })
    expect(next.measures[0].events[0].graceNotes).toEqual([
      { pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' },
    ])
  })

  it('sets a slashed acciaccatura (slashed=true preserved)', () => {
    const next = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setGraceNotes',
      target: { measureIdx: 0, eventIdx: 0 },
      graceNotes: [
        { pitches: [{ step: 'D', octave: 5 }], duration: 'sixteenth', slashed: true },
      ],
    })
    expect(next.measures[0].events[0].graceNotes?.[0].slashed).toBe(true)
  })

  it('sets a grace chord (one moment, multiple pitches)', () => {
    const next = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setGraceNotes',
      target: { measureIdx: 0, eventIdx: 0 },
      graceNotes: [
        {
          pitches: [
            { step: 'C', octave: 5 },
            { step: 'E', octave: 5 },
            { step: 'G', octave: 5 },
          ],
          duration: 'eighth',
        },
      ],
    })
    expect(next.measures[0].events[0].graceNotes?.[0].pitches).toHaveLength(3)
  })

  it('sets a beamed grace run (multiple moments)', () => {
    const next = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setGraceNotes',
      target: { measureIdx: 0, eventIdx: 0 },
      graceNotes: [
        { pitches: [{ step: 'A', octave: 4 }], duration: 'sixteenth' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'sixteenth' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'sixteenth' },
      ],
    })
    expect(next.measures[0].events[0].graceNotes).toHaveLength(3)
  })

  it('empty array STRIPS the field so legacy ornament=grace can render as fallback', () => {
    // Mirrors the setArticulations idiom — passing [] is the standard
    // way to clear. Stripping the field (not setting graceNotes: [])
    // ensures the renderer's "absent OR empty falls back to legacy
    // ornament:'grace'" contract behaves identically for both shapes.
    const seeded = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setGraceNotes',
      target: { measureIdx: 0, eventIdx: 0 },
      graceNotes: [{ pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' }],
    })
    expect(seeded.measures[0].events[0]).toHaveProperty('graceNotes')
    const cleared = applyOperation(seeded, {
      kind: 'setGraceNotes',
      target: { measureIdx: 0, eventIdx: 0 },
      graceNotes: [],
    })
    expect(cleared.measures[0].events[0]).not.toHaveProperty('graceNotes')
  })

  it('overwrites existing graceNotes verbatim (not merged)', () => {
    const seeded = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setGraceNotes',
      target: { measureIdx: 0, eventIdx: 0 },
      graceNotes: [
        { pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' },
        { pitches: [{ step: 'E', octave: 5 }], duration: 'eighth' },
      ],
    })
    const replaced = applyOperation(seeded, {
      kind: 'setGraceNotes',
      target: { measureIdx: 0, eventIdx: 0 },
      graceNotes: [{ pitches: [{ step: 'F', octave: 5 }], duration: 'sixteenth' }],
    })
    expect(replaced.measures[0].events[0].graceNotes).toHaveLength(1)
    expect(replaced.measures[0].events[0].graceNotes?.[0].pitches[0].step).toBe('F')
  })

  it('preserves co-existing legacy ornament=grace during rollout', () => {
    // Both can be set simultaneously; M7-PR-4 renderer prefers
    // structured graceNotes when present.
    const withLegacy = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setOrnament',
      target: { measureIdx: 0, eventIdx: 0 },
      ornament: 'grace',
    })
    const both = applyOperation(withLegacy, {
      kind: 'setGraceNotes',
      target: { measureIdx: 0, eventIdx: 0 },
      graceNotes: [{ pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' }],
    })
    expect(both.measures[0].events[0].ornament).toBe('grace')
    expect(both.measures[0].events[0].graceNotes).toHaveLength(1)
  })

  it('rest-only grace is rejected by applyOperation as EditError (schema no-rest refine surfaces inline)', () => {
    // applyOperation validates the produced score via validateScore
    // and re-throws schema failures as EditError, so the no-rest
    // refine on GraceNoteSchema fires synchronously here — no need
    // for the caller to run a separate validation pass.
    //
    // Note: step:'rest' typechecks fine as a Pitch (StepSchema includes
    // 'rest' as a member). The no-rest invariant on grace pitches lives
    // ONLY in GraceNoteSchema's runtime refine — there's no TS-level
    // GracePitch type that excludes rest, so no @ts-expect-error
    // needed here.
    expect(() =>
      applyOperation(TWO_BAR_QUARTERS, {
        kind: 'setGraceNotes',
        target: { measureIdx: 0, eventIdx: 0 },
        graceNotes: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'eighth' }],
      }),
    ).toThrow(EditError)
    expect(() =>
      applyOperation(TWO_BAR_QUARTERS, {
        kind: 'setGraceNotes',
        target: { measureIdx: 0, eventIdx: 0 },
        graceNotes: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'eighth' }],
      }),
    ).toThrow(/cannot be rests/)
  })

  it('on a chord principal, graceNotes attach to the event (not a single pitch)', () => {
    // Grace attaches to the principal EVENT — when the principal is
    // a chord, the grace sits in front of the whole chord, not in
    // front of a particular notehead.
    const next = applyOperation(CHORD_BAR, {
      kind: 'setGraceNotes',
      target: { measureIdx: 0, eventIdx: 0 },
      graceNotes: [{ pitches: [{ step: 'A', octave: 4 }], duration: 'eighth' }],
    })
    expect(next.measures[0].events[0].pitches).toHaveLength(3)
    expect(next.measures[0].events[0].graceNotes).toHaveLength(1)
  })
})

describe('editOperations — setDynamic and setDynamicStructured', () => {
  it('setDynamic accepts the expanded enum (sfz, niente)', () => {
    const a = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setDynamic',
      target: { measureIdx: 0, eventIdx: 0 },
      dynamic: 'sfz',
    })
    expect(a.measures[0].events[0].dynamic).toBe('sfz')

    const b = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setDynamic',
      target: { measureIdx: 0, eventIdx: 0 },
      dynamic: 'n',
    })
    expect(b.measures[0].events[0].dynamic).toBe('n')
  })

  it('setDynamic strips a prior dynamic_structured so it does not shadow at render time', () => {
    // getDynamicMarking (dynamics.ts:12) returns dynamic_structured
    // first — leaving it set after setDynamic would silently keep the
    // old compound rendering instead of the new simple loudness.
    const seeded = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setDynamicStructured',
      target: { measureIdx: 0, eventIdx: 0 },
      dynamic_structured: { base: 'p', prefix: 'sub.', suffix: 'espressivo' },
    })
    const next = applyOperation(seeded, {
      kind: 'setDynamic',
      target: { measureIdx: 0, eventIdx: 0 },
      dynamic: 'f',
    })
    expect(next.measures[0].events[0].dynamic).toBe('f')
    expect(next.measures[0].events[0]).not.toHaveProperty('dynamic_structured')
  })

  it('setDynamicStructured strips a prior singular dynamic for symmetry', () => {
    const seeded = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setDynamic',
      target: { measureIdx: 0, eventIdx: 0 },
      dynamic: 'mf',
    })
    const next = applyOperation(seeded, {
      kind: 'setDynamicStructured',
      target: { measureIdx: 0, eventIdx: 0 },
      dynamic_structured: { base: 'p', prefix: 'sub.' },
    })
    expect(next.measures[0].events[0].dynamic_structured).toEqual({
      base: 'p',
      prefix: 'sub.',
    })
    expect(next.measures[0].events[0]).not.toHaveProperty('dynamic')
  })

  it('setDynamicStructured sets the compound form', () => {
    const next = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setDynamicStructured',
      target: { measureIdx: 0, eventIdx: 0 },
      dynamic_structured: { base: 'p', prefix: 'sub.', suffix: 'espressivo' },
    })
    expect(next.measures[0].events[0].dynamic_structured).toEqual({
      base: 'p',
      prefix: 'sub.',
      suffix: 'espressivo',
    })
  })

  it('omitting dynamic_structured clears the field', () => {
    const seeded = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setDynamicStructured',
      target: { measureIdx: 0, eventIdx: 0 },
      dynamic_structured: { base: 'f' },
    })
    const cleared = applyOperation(seeded, {
      kind: 'setDynamicStructured',
      target: { measureIdx: 0, eventIdx: 0 },
    })
    expect(cleared.measures[0].events[0]).not.toHaveProperty('dynamic_structured')
  })
})

describe('editOperations — setFermata and setBarlineFermata', () => {
  it('setFermata picks one of the 5 forms', () => {
    const next = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setFermata',
      target: { measureIdx: 0, eventIdx: 3 },
      fermata: 'long',
    })
    expect(next.measures[0].events[3].fermata).toBe('long')
  })

  it('setBarlineFermata targets the measure, not an event', () => {
    const next = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setBarlineFermata',
      measureIdx: 0,
      barlineFermata: 'very-long',
    })
    expect(next.measures[0].barlineFermata).toBe('very-long')
  })

  it('omitting barlineFermata clears the measure-level field', () => {
    const seeded = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setBarlineFermata',
      measureIdx: 0,
      barlineFermata: 'standard',
    })
    const cleared = applyOperation(seeded, {
      kind: 'setBarlineFermata',
      measureIdx: 0,
    })
    expect(cleared.measures[0]).not.toHaveProperty('barlineFermata')
  })

  it('setBarlineFermata throws when measureIdx is out of range (not silent no-op)', () => {
    expect(() =>
      applyOperation(TWO_BAR_QUARTERS, {
        kind: 'setBarlineFermata',
        measureIdx: 99,
        barlineFermata: 'standard',
      }),
    ).toThrow(EditError)
  })
})

describe('editOperations — per-pitch ops with out-of-range pitchIdx', () => {
  it('setPitchTie on a non-existent pitchIdx throws EditError (not silent no-op)', () => {
    expect(() =>
      applyOperation(CHORD_BAR, {
        kind: 'setPitchTie',
        target: { measureIdx: 0, eventIdx: 0, pitchIdx: 99 },
        tied_to_next: true,
      }),
    ).toThrow(EditError)
  })

  it('setLv on a non-existent pitchIdx throws EditError', () => {
    expect(() =>
      applyOperation(CHORD_BAR, {
        kind: 'setLv',
        target: { measureIdx: 0, eventIdx: 0, pitchIdx: 5 },
        lv: true,
      }),
    ).toThrow(EditError)
  })

  it('setEnharmonicTie on a non-existent pitchIdx throws EditError', () => {
    expect(() =>
      applyOperation(CHORD_BAR, {
        kind: 'setEnharmonicTie',
        target: { measureIdx: 0, eventIdx: 0, pitchIdx: 10 },
        enharmonicTie: true,
      }),
    ).toThrow(EditError)
  })
})

describe('editOperations — setBreathMark and setCaesura', () => {
  it('breath mark true adds the field; false clears it', () => {
    const set = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setBreathMark',
      target: { measureIdx: 0, eventIdx: 1 },
      breathMark: true,
    })
    expect(set.measures[0].events[1].breathMark).toBe(true)

    const cleared = applyOperation(set, {
      kind: 'setBreathMark',
      target: { measureIdx: 0, eventIdx: 1 },
      breathMark: false,
    })
    expect(cleared.measures[0].events[1]).not.toHaveProperty('breathMark')
  })

  it('caesura toggles the same way', () => {
    const set = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setCaesura',
      target: { measureIdx: 0, eventIdx: 2 },
      caesura: true,
    })
    expect(set.measures[0].events[2].caesura).toBe(true)

    const cleared = applyOperation(set, {
      kind: 'setCaesura',
      target: { measureIdx: 0, eventIdx: 2 },
      caesura: false,
    })
    expect(cleared.measures[0].events[2]).not.toHaveProperty('caesura')
  })
})

describe('editOperations — setTremolo', () => {
  it('sets the tremolo object', () => {
    const next = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setTremolo',
      target: { measureIdx: 0, eventIdx: 0 },
      tremolo: { slashes: 3, measured: true },
    })
    expect(next.measures[0].events[0].tremolo).toEqual({ slashes: 3, measured: true })
  })

  it('omitting tremolo clears the field', () => {
    const seeded = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setTremolo',
      target: { measureIdx: 0, eventIdx: 0 },
      tremolo: { slashes: 2 },
    })
    const cleared = applyOperation(seeded, {
      kind: 'setTremolo',
      target: { measureIdx: 0, eventIdx: 0 },
    })
    expect(cleared.measures[0].events[0]).not.toHaveProperty('tremolo')
  })
})

describe('editOperations — setBowing', () => {
  it('sets up / down', () => {
    const up = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setBowing',
      target: { measureIdx: 0, eventIdx: 0 },
      bowing: 'up',
    })
    expect(up.measures[0].events[0].bowing).toBe('up')

    const down = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setBowing',
      target: { measureIdx: 0, eventIdx: 0 },
      bowing: 'down',
    })
    expect(down.measures[0].events[0].bowing).toBe('down')
  })

  it('omitting bowing clears the field', () => {
    const seeded = applyOperation(TWO_BAR_QUARTERS, {
      kind: 'setBowing',
      target: { measureIdx: 0, eventIdx: 0 },
      bowing: 'up',
    })
    const cleared = applyOperation(seeded, {
      kind: 'setBowing',
      target: { measureIdx: 0, eventIdx: 0 },
    })
    expect(cleared.measures[0].events[0]).not.toHaveProperty('bowing')
  })

  it('rejects bowing on a rest', () => {
    const restScore: Score = buildScore({
      measures: [
        { events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
      ],
    })
    expect(() =>
      applyOperation(restScore, {
        kind: 'setBowing',
        target: { measureIdx: 0, eventIdx: 0 },
        bowing: 'up',
      }),
    ).toThrow(EditError)
  })
})

describe('editOperations — setJazzInflection', () => {
  it('sets each of the 5 inflections', () => {
    for (const inflection of ['fall', 'doit', 'scoop', 'plop', 'ghost'] as const) {
      const next = applyOperation(TWO_BAR_QUARTERS, {
        kind: 'setJazzInflection',
        target: { measureIdx: 0, eventIdx: 0 },
        jazzInflection: inflection,
      })
      expect(next.measures[0].events[0].jazzInflection).toBe(inflection)
    }
  })
})

describe('editOperations — per-pitch ops on chord stacks', () => {
  it('setPitchTie ties only the targeted pitch in a chord', () => {
    const next = applyOperation(CHORD_BAR, {
      kind: 'setPitchTie',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 2 },
      tied_to_next: true,
    })
    const pitches = next.measures[0].events[0].pitches
    expect(pitches[0].tied_to_next).toBeUndefined()
    expect(pitches[1].tied_to_next).toBeUndefined()
    expect(pitches[2].tied_to_next).toBe(true)
  })

  it('setPitchTie false persists the explicit override (does NOT strip the field)', () => {
    // Persisted `false` is the documented override path for chord-tone
    // ties when the legacy event-wide `tied_to_next:true` is in effect.
    // See pitchTies.ts:24-26 — undefined falls back to event-wide;
    // explicit `false` overrides it. Stripping would silently re-tie.
    const seeded = applyOperation(CHORD_BAR, {
      kind: 'setPitchTie',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 1 },
      tied_to_next: true,
    })
    const next = applyOperation(seeded, {
      kind: 'setPitchTie',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 1 },
      tied_to_next: false,
    })
    expect(next.measures[0].events[0].pitches[1].tied_to_next).toBe(false)
  })

  it('setPitchTie false on a chord with event-wide tied_to_next:true releases just that pitch', async () => {
    const { isPitchTiedToNext } = await import('@/lib/music/pitchTies')
    const eventWideTied: Score = buildScore({
      measures: [
        {
          events: [
            {
              pitches: [
                { step: 'C', octave: 4 },
                { step: 'E', octave: 4 },
                { step: 'G', octave: 4 },
              ],
              duration: 'whole',
              tied_to_next: true,
            },
          ],
        },
        {
          events: [
            {
              pitches: [
                { step: 'C', octave: 4 },
                { step: 'E', octave: 4 },
                { step: 'G', octave: 4 },
              ],
              duration: 'whole',
            },
          ],
        },
      ],
    })
    const next = applyOperation(eventWideTied, {
      kind: 'setPitchTie',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 1 },
      tied_to_next: false,
    })
    const event = next.measures[0].events[0]
    // E (pitchIdx 1) is released; C and G still ride the event-wide tie.
    expect(isPitchTiedToNext(event.pitches[0], event)).toBe(true)
    expect(isPitchTiedToNext(event.pitches[1], event)).toBe(false)
    expect(isPitchTiedToNext(event.pitches[2], event)).toBe(true)
  })

  it('setLv sets and clears the per-pitch lv flag', () => {
    const set = applyOperation(CHORD_BAR, {
      kind: 'setLv',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      lv: true,
    })
    expect(set.measures[0].events[0].pitches[0].lv).toBe(true)

    const cleared = applyOperation(set, {
      kind: 'setLv',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      lv: false,
    })
    expect(cleared.measures[0].events[0].pitches[0]).not.toHaveProperty('lv')
  })

  it('setEnharmonicTie sets the escape-hatch flag', () => {
    const next = applyOperation(CHORD_BAR, {
      kind: 'setEnharmonicTie',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      enharmonicTie: true,
    })
    expect(next.measures[0].events[0].pitches[0].enharmonicTie).toBe(true)
  })

  it('rejects lv on a rest', () => {
    const restScore: Score = buildScore({
      measures: [
        { events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
      ],
    })
    expect(() =>
      applyOperation(restScore, {
        kind: 'setLv',
        target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
        lv: true,
      }),
    ).toThrow(EditError)
  })

  it('rejects per-pitch tie on a rest', () => {
    const restScore: Score = buildScore({
      measures: [
        { events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
      ],
    })
    expect(() =>
      applyOperation(restScore, {
        kind: 'setPitchTie',
        target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
        tied_to_next: true,
      }),
    ).toThrow(EditError)
  })
})

describe('editOperations — purity for per-note marking ops', () => {
  it('setArticulations does not mutate the input score', () => {
    const before = JSON.stringify(TWO_BAR_QUARTERS)
    transformScore(TWO_BAR_QUARTERS, {
      kind: 'setArticulations',
      target: { measureIdx: 0, eventIdx: 0 },
      articulations: ['staccato', 'accent'],
    })
    expect(JSON.stringify(TWO_BAR_QUARTERS)).toBe(before)
  })

  it('setBarlineFermata does not mutate the input score', () => {
    const before = JSON.stringify(TWO_BAR_QUARTERS)
    transformScore(TWO_BAR_QUARTERS, {
      kind: 'setBarlineFermata',
      measureIdx: 0,
      barlineFermata: 'standard',
    })
    expect(JSON.stringify(TWO_BAR_QUARTERS)).toBe(before)
  })

  it('setPitchTie does not mutate the input score', () => {
    const before = JSON.stringify(CHORD_BAR)
    transformScore(CHORD_BAR, {
      kind: 'setPitchTie',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 2 },
      tied_to_next: true,
    })
    expect(JSON.stringify(CHORD_BAR)).toBe(before)
  })
})
