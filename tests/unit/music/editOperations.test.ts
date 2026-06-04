import { describe, it, expect } from 'vitest'
import { applyOperation, transformScore, EditError } from '@/lib/music/editOperations'
import type { Score } from '@/lib/music/types'

// Re-export to silence unused warnings when the imports above are
// referenced inside nested test fixtures only.
void transformScore
void EditError

function buildScore(partial: Partial<Score> & Pick<Score, 'measures'>): Score {
  return { key: 'C', meter: '4/4', ...partial }
}

const ONE_BAR: Score = buildScore({
  measures: [{ events: [
    { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
    { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
    { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
    { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
  ] }],
})

describe('applyOperation — purity', () => {
  it('does not mutate the input score', () => {
    const before = JSON.stringify(ONE_BAR)
    applyOperation(ONE_BAR, {
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })
    expect(JSON.stringify(ONE_BAR)).toBe(before)
  })
})

describe('applyOperation — changePitch', () => {
  it('moves up a step within the octave', () => {
    const next = applyOperation(ONE_BAR, {
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })
    expect(next.measures[0].events[0].pitches[0].step).toBe('D')
    expect(next.measures[0].events[0].pitches[0].octave).toBe(4)
  })

  it('wraps from B to C and increments octave', () => {
    const score: Score = buildScore({
      measures: [{ events: [{ pitches: [{ step: 'B', octave: 4 }], duration: 'whole' }] }],
    })
    const next = applyOperation(score, {
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })
    expect(next.measures[0].events[0].pitches[0].step).toBe('C')
    expect(next.measures[0].events[0].pitches[0].octave).toBe(5)
  })

  it('wraps from C down to B and decrements octave', () => {
    const next = applyOperation(ONE_BAR, {
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: -1,
    })
    expect(next.measures[0].events[0].pitches[0].step).toBe('B')
    expect(next.measures[0].events[0].pitches[0].octave).toBe(3)
  })

  it('changes octave directly', () => {
    const next = applyOperation(ONE_BAR, {
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaOctave: 1,
    })
    expect(next.measures[0].events[0].pitches[0].octave).toBe(5)
  })

  it('throws EditError when transposition exits octave range', () => {
    const score: Score = buildScore({
      measures: [{ events: [{ pitches: [{ step: 'C', octave: 9 }], duration: 'whole' }] }],
    })
    expect(() => applyOperation(score, {
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaOctave: 1, // 9 -> 10 is past the [0,9] ceiling
    })).toThrow(EditError)
  })

  it('rejects transposing a rest', () => {
    const score: Score = buildScore({
      measures: [{ events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] }],
    })
    expect(() => applyOperation(score, {
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })).toThrow(EditError)
  })
})

describe('applyOperation — changeDuration', () => {
  it('transforms duration in a way the pure layer accepts', () => {
    // transformScore does not validate; only changes the field.
    const score: Score = buildScore({
      measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
    })
    const next = transformScore(score, {
      kind: 'changeDuration',
      target: { measureIdx: 0, eventIdx: 0 },
      duration: 'half',
    })
    expect(next.measures[0].events[0].duration).toBe('half')
  })

  it('throws EditError via the validated layer when the new duration breaks the measure sum', () => {
    expect(() => applyOperation(ONE_BAR, {
      kind: 'changeDuration',
      target: { measureIdx: 0, eventIdx: 0 },
      duration: 'whole',
    })).toThrow(EditError)
  })
})

describe('applyOperation — setAccidental', () => {
  it('sets the accidental on a pitch', () => {
    const next = applyOperation(ONE_BAR, {
      kind: 'setAccidental',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      accidental: 'sharp',
    })
    expect(next.measures[0].events[0].pitches[0].accidental).toBe('sharp')
  })
})

describe('applyOperation — deleteEvent', () => {
  it('transforms the array via the pure layer', () => {
    // transformScore does not validate sum constraints.
    const next = transformScore(ONE_BAR, {
      kind: 'deleteEvent',
      target: { measureIdx: 0, eventIdx: 1 },
    })
    expect(next.measures[0].events).toHaveLength(3)
  })

  it('throws EditError via the validated layer when delete breaks the measure sum', () => {
    expect(() => applyOperation(ONE_BAR, {
      kind: 'deleteEvent',
      target: { measureIdx: 0, eventIdx: 0 },
    })).toThrow(EditError)
  })

  it('converts the only event in a measure to a rest instead of emptying the bar (transform layer)', () => {
    const score: Score = buildScore({
      measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
    })
    const next = transformScore(score, {
      kind: 'deleteEvent',
      target: { measureIdx: 0, eventIdx: 0 },
    })
    const events = next.measures[0].events
    // Bar stays non-empty: the single note becomes a same-duration rest.
    expect(events).toHaveLength(1)
    expect(events[0].pitches).toEqual([{ step: 'rest', octave: 4 }])
    expect(events[0].duration).toBe('whole')
  })

  it('the validated layer accepts the only-event delete (rest keeps the bar summing)', () => {
    const score: Score = buildScore({
      measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
    })
    // Previously threw EditError('only event'); now it succeeds because the
    // replacement rest has the same duration, so the measure still sums.
    const next = applyOperation(score, {
      kind: 'deleteEvent',
      target: { measureIdx: 0, eventIdx: 0 },
    })
    expect(next.measures[0].events[0].pitches[0].step).toBe('rest')
  })
})

describe('applyOperation — addPitchToChord / removePitchFromChord', () => {
  const CHORD: Score = buildScore({
    measures: [{ events: [{
      pitches: [
        { step: 'C', octave: 4 },
        { step: 'E', octave: 4 },
      ],
      duration: 'whole',
    }] }],
  })

  it('adds a pitch to a chord', () => {
    const next = applyOperation(CHORD, {
      kind: 'addPitchToChord',
      target: { measureIdx: 0, eventIdx: 0 },
      pitch: { step: 'G', octave: 4 },
    })
    expect(next.measures[0].events[0].pitches).toHaveLength(3)
  })

  it('inserts the new pitch in ascending MIDI order', () => {
    // CHORD has [C4, E4]. Inserting D4 should land between them.
    const next = applyOperation(CHORD, {
      kind: 'addPitchToChord',
      target: { measureIdx: 0, eventIdx: 0 },
      pitch: { step: 'D', octave: 4 },
    })
    expect(next.measures[0].events[0].pitches.map((p) => p.step)).toEqual(['C', 'D', 'E'])
  })

  it('sorts above-octave additions to the top', () => {
    const next = applyOperation(CHORD, {
      kind: 'addPitchToChord',
      target: { measureIdx: 0, eventIdx: 0 },
      pitch: { step: 'G', octave: 5 },
    })
    expect(
      next.measures[0].events[0].pitches.map((p) => `${p.step}${p.octave}`),
    ).toEqual(['C4', 'E4', 'G5'])
  })

  it('rejects adding when chord is at 6 pitches', () => {
    const full: Score = buildScore({
      measures: [{ events: [{
        pitches: [
          { step: 'C', octave: 4 }, { step: 'D', octave: 4 }, { step: 'E', octave: 4 },
          { step: 'F', octave: 4 }, { step: 'G', octave: 4 }, { step: 'A', octave: 4 },
        ],
        duration: 'whole',
      }] }],
    })
    expect(() => applyOperation(full, {
      kind: 'addPitchToChord',
      target: { measureIdx: 0, eventIdx: 0 },
      pitch: { step: 'B', octave: 4 },
    })).toThrow(/6 pitches/)
  })

  it('removes a pitch from a chord', () => {
    const next = applyOperation(CHORD, {
      kind: 'removePitchFromChord',
      target: { measureIdx: 0, eventIdx: 0 },
      pitchIdx: 1,
    })
    expect(next.measures[0].events[0].pitches).toHaveLength(1)
  })

  it('refuses to remove the only pitch', () => {
    expect(() => applyOperation(ONE_BAR, {
      kind: 'removePitchFromChord',
      target: { measureIdx: 0, eventIdx: 0 },
      pitchIdx: 0,
    })).toThrow(/only pitch/)
  })
})

describe('applyOperation — setEventPitches', () => {
  const ONE_BAR_FOR_SET: Score = buildScore({
    measures: [{ events: [
      { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
    ] }],
  })

  it('replaces the event pitches and sorts ascending', () => {
    const next = applyOperation(ONE_BAR_FOR_SET, {
      kind: 'setEventPitches',
      target: { measureIdx: 0, eventIdx: 0 },
      pitches: [
        { step: 'G', octave: 4 },
        { step: 'C', octave: 4 },
        { step: 'E', octave: 4 },
      ],
    })
    expect(next.measures[0].events[0].pitches.map((p) => p.step)).toEqual(['C', 'E', 'G'])
  })

  it('rejects an empty pitch list', () => {
    expect(() => applyOperation(ONE_BAR_FOR_SET, {
      kind: 'setEventPitches',
      target: { measureIdx: 0, eventIdx: 0 },
      pitches: [],
    })).toThrow(/1\.\.6 pitches/)
  })

  it('rejects more than 6 pitches', () => {
    expect(() => applyOperation(ONE_BAR_FOR_SET, {
      kind: 'setEventPitches',
      target: { measureIdx: 0, eventIdx: 0 },
      pitches: Array.from({ length: 7 }, (_, i) => ({ step: 'C', octave: 4 + (i % 3) } as const)),
    })).toThrow(/1\.\.6 pitches/)
  })

  it('rejects a rest mixed with notes', () => {
    expect(() => applyOperation(ONE_BAR_FOR_SET, {
      kind: 'setEventPitches',
      target: { measureIdx: 0, eventIdx: 0 },
      pitches: [{ step: 'C', octave: 4 }, { step: 'rest', octave: 4 }],
    })).toThrow(/rest/)
  })
})

describe('applyOperation — global ops', () => {
  it('changeKey replaces the key signature', () => {
    const next = applyOperation(ONE_BAR, { kind: 'changeKey', key: 'G' })
    expect(next.key).toBe('G')
  })

  it('changeMeter to one that breaks the measure sum throws EditError', () => {
    expect(() => applyOperation(ONE_BAR, { kind: 'changeMeter', meter: '3/4' })).toThrow(EditError)
  })

  it('changeTempo updates tempo_bpm', () => {
    const next = applyOperation(ONE_BAR, { kind: 'changeTempo', tempo_bpm: 144 })
    expect(next.tempo_bpm).toBe(144)
  })

  it('changeTempo out of range throws EditError', () => {
    expect(() => applyOperation(ONE_BAR, { kind: 'changeTempo', tempo_bpm: 9999 })).toThrow(EditError)
  })

  it('changeTitle clamps to 80 chars', () => {
    const next = applyOperation(ONE_BAR, { kind: 'changeTitle', title: 'x'.repeat(200) })
    expect(next.title?.length).toBe(80)
  })

  it('changeClef to bass sets the clef field', () => {
    const next = applyOperation(ONE_BAR, { kind: 'changeClef', clef: 'bass' })
    expect(next.clef).toBe('bass')
  })

  it('changeClef to treble clears the clef field (default state)', () => {
    const withBass = applyOperation(ONE_BAR, { kind: 'changeClef', clef: 'bass' })
    expect(withBass.clef).toBe('bass')
    const back = applyOperation(withBass, { kind: 'changeClef', clef: 'treble' })
    expect(back.clef).toBeUndefined()
  })

  it('addStaff appends a bar-aligned bass staff with whole rests', () => {
    const next = applyOperation(ONE_BAR, { kind: 'addStaff', clef: 'bass' })
    expect(next.secondStaff).toBeDefined()
    expect(next.secondStaff?.clef).toBe('bass')
    expect(next.secondStaff?.measures).toHaveLength(ONE_BAR.measures.length)
    expect(next.secondStaff?.measures[0].events[0]).toMatchObject({
      pitches: [{ step: 'rest', octave: 4 }],
      duration: 'whole',
    })
  })

  it('addStaff throws when score already has two staves', () => {
    const two = applyOperation(ONE_BAR, { kind: 'addStaff', clef: 'bass' })
    expect(() => applyOperation(two, { kind: 'addStaff', clef: 'bass' })).toThrow(EditError)
  })

  it('removeStaff drops the secondStaff', () => {
    const two = applyOperation(ONE_BAR, { kind: 'addStaff', clef: 'bass' })
    const back = applyOperation(two, { kind: 'removeStaff', staffIdx: 1 })
    expect(back.secondStaff).toBeUndefined()
  })

  it('removeStaff refuses to remove the primary staff', () => {
    expect(() => applyOperation(ONE_BAR, { kind: 'removeStaff', staffIdx: 0 })).toThrow(EditError)
  })

  it('changeClef targets the second staff when staffIdx=1', () => {
    const two = applyOperation(ONE_BAR, { kind: 'addStaff', clef: 'bass' })
    const flipped = applyOperation(two, { kind: 'changeClef', clef: 'treble', staffIdx: 1 })
    expect(flipped.secondStaff?.clef).toBe('treble')
  })

  it('insertMeasureAfter fans out across both staves (bar alignment preserved)', () => {
    const two = applyOperation(ONE_BAR, { kind: 'addStaff', clef: 'bass' })
    const inserted = applyOperation(two, { kind: 'insertMeasureAfter', measureIdx: 0 })
    expect(inserted.measures).toHaveLength(2)
    expect(inserted.secondStaff?.measures).toHaveLength(2)
  })

  it('deleteMeasure fans out across both staves', () => {
    const two = applyOperation(ONE_BAR, { kind: 'addStaff', clef: 'bass' })
    const expanded = applyOperation(two, { kind: 'insertMeasureAfter', measureIdx: 0 })
    const back = applyOperation(expanded, { kind: 'deleteMeasure', measureIdx: 1 })
    expect(back.measures).toHaveLength(1)
    expect(back.secondStaff?.measures).toHaveLength(1)
  })
})

describe('applyOperation — staff-aware Target', () => {
  it('changePitch on staffIdx=1 mutates the second staff only', () => {
    const two = applyOperation(
      {
        ...ONE_BAR,
        secondStaff: {
          clef: 'bass',
          measures: [{ events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] }],
        },
      },
      {
        kind: 'changePitch',
        target: { staffIdx: 1, measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
        deltaStep: 1,
      },
    )
    expect(two.secondStaff?.measures[0].events[0].pitches[0].step).toBe('D')
    // Primary untouched.
    expect(two.measures[0].events[0].pitches[0].step).toBe('C')
  })
})

describe('applyOperation — voice-aware Target (voiceIdx)', () => {
  const SATB_ONE_BAR: Score = {
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] }, // Soprano
    ],
    extraVoices: [
      {
        measures: [
          { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] }, // Alto
        ],
      },
    ],
    secondStaff: {
      clef: 'bass',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }, // Tenor
      ],
      extraVoices: [
        {
          measures: [
            { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] }, // Bass
          ],
        },
      ],
    },
  }

  it('changePitch on voiceIdx=1 (Alto) mutates the alto voice only', () => {
    const next = applyOperation(SATB_ONE_BAR, {
      kind: 'changePitch',
      target: { staffIdx: 0, voiceIdx: 1, measureIdx: 0, eventIdx: 0 },
      deltaStep: 1,
    })
    expect(next.extraVoices?.[0].measures[0].events[0].pitches[0].step).toBe('F')
    // Soprano (primary) untouched.
    expect(next.measures[0].events[0].pitches[0].step).toBe('G')
  })

  it('deleteEvent on (staffIdx=1, voiceIdx=1) targets the Bass voice', () => {
    // Start with a Bass voice that has two half notes so deleting one
    // would over-empty the measure; use transformScore (not
    // applyOperation) to bypass the final-state validator so we can
    // assert that the targeting itself routes correctly.
    const fixture: Score = {
      ...SATB_ONE_BAR,
      secondStaff: {
        ...SATB_ONE_BAR.secondStaff!,
        extraVoices: [
          {
            measures: [
              {
                events: [
                  { pitches: [{ step: 'C', octave: 3 }], duration: 'half' },
                  { pitches: [{ step: 'G', octave: 2 }], duration: 'half' },
                ],
              },
            ],
          },
        ],
      },
    }
    // Per-step: drop one bass-voice event without final-state validation.
    const next = transformScore(fixture, {
      kind: 'deleteEvent',
      target: { staffIdx: 1, voiceIdx: 1, measureIdx: 0, eventIdx: 1 },
    })
    expect(next.secondStaff?.extraVoices?.[0].measures[0].events).toHaveLength(1)
    expect(next.secondStaff?.extraVoices?.[0].measures[0].events[0].pitches[0].step).toBe('C')
    // Other voices untouched.
    expect(next.measures[0].events[0].pitches[0].step).toBe('G') // Soprano
    expect(next.secondStaff?.measures[0].events[0].pitches[0].step).toBe('C') // Tenor
  })

  it('throws a descriptive EditError when voiceIdx addresses a nonexistent voice', () => {
    expect(() =>
      applyOperation(SATB_ONE_BAR, {
        kind: 'changePitch',
        target: { staffIdx: 0, voiceIdx: 2, measureIdx: 0, eventIdx: 0 },
        deltaStep: 1,
      }),
    ).toThrow(/staff 0 has 2 voices/)
  })

  it('throws a descriptive EditError when staffIdx addresses a nonexistent staff', () => {
    expect(() =>
      applyOperation(ONE_BAR, {
        kind: 'changePitch',
        target: { staffIdx: 1, voiceIdx: 0, measureIdx: 0, eventIdx: 0 },
        deltaStep: 1,
      }),
    ).toThrow(/staffIdx=1 does not exist/)
  })

  it('reorderEvent within a non-primary voice swaps within that voice only', () => {
    // Two half-note events in the Alto voice; swap them.
    const fixture: Score = {
      ...SATB_ONE_BAR,
      extraVoices: [
        {
          measures: [
            {
              events: [
                { pitches: [{ step: 'E', octave: 4 }], duration: 'half' },
                { pitches: [{ step: 'F', octave: 4 }], duration: 'half' },
              ],
            },
          ],
        },
      ],
    }
    const reordered = applyOperation(fixture, {
      kind: 'reorderEvent',
      target: { staffIdx: 0, voiceIdx: 1, measureIdx: 0, eventIdx: 0 },
      direction: 'right',
    })
    const altoEvents = reordered.extraVoices?.[0].measures[0].events
    expect(altoEvents?.[0].pitches[0].step).toBe('F')
    expect(altoEvents?.[1].pitches[0].step).toBe('E')
    // Soprano untouched.
    expect(reordered.measures[0].events[0].pitches[0].step).toBe('G')
  })
})

describe('applyOperation — measure ops', () => {
  it('insertMeasureAfter adds a whole-rest measure', () => {
    const next = applyOperation(ONE_BAR, { kind: 'insertMeasureAfter', measureIdx: 0 })
    expect(next.measures).toHaveLength(2)
    expect(next.measures[1].events[0].pitches[0].step).toBe('rest')
    expect(next.measures[1].events[0].duration).toBe('whole')
  })

  it('deleteMeasure removes a measure', () => {
    const two: Score = buildScore({
      measures: [
        ONE_BAR.measures[0],
        ONE_BAR.measures[0],
      ],
    })
    const next = applyOperation(two, { kind: 'deleteMeasure', measureIdx: 0 })
    expect(next.measures).toHaveLength(1)
  })

  it('refuses to delete the only measure', () => {
    expect(() => applyOperation(ONE_BAR, { kind: 'deleteMeasure', measureIdx: 0 })).toThrow(/only measure/)
  })

  it('duplicateMeasure clones the measure', () => {
    const next = applyOperation(ONE_BAR, { kind: 'duplicateMeasure', measureIdx: 0 })
    expect(next.measures).toHaveLength(2)
    expect(next.measures[1]).toEqual(next.measures[0])
    // Independent objects (mutating one should not affect the other).
    expect(next.measures[1]).not.toBe(next.measures[0])
  })
})
