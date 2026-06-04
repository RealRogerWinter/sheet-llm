import { describe, it, expect } from 'vitest'
import { applyOperation, EditError } from '@/lib/music/editOperations'
import type { Score } from '@/lib/music/types'

const CHORD_SCORE: Score = {
  key: 'C',
  meter: '4/4',
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
  ],
}

const MONOPHONIC: Score = {
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
  ],
}

describe('editOperations — setFingering', () => {
  it('sets a piano fingering on a monophonic note via pitchIdx=0', () => {
    const next = applyOperation(MONOPHONIC, {
      kind: 'setFingering',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      fingering: { system: 'piano', value: '3' },
    })
    expect(next.measures[0].events[0].fingerings).toEqual([{ system: 'piano', value: '3' }])
  })

  it('fingers chord pitches in any order, padding earlier slots with null', () => {
    // User clicks the top of the chord first (pitchIdx=2). The persisted
    // array must keep the index alignment so renderer / future edits
    // see pitch[2]'s fingering at fingerings[2], not fingerings[0].
    const next = applyOperation(CHORD_SCORE, {
      kind: 'setFingering',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 2 },
      fingering: { system: 'piano', value: '5' },
    })
    expect(next.measures[0].events[0].fingerings).toEqual([
      null,
      null,
      { system: 'piano', value: '5' },
    ])
  })

  it('fills out a chord with successive setFingering ops', () => {
    let cur: Score = CHORD_SCORE
    cur = applyOperation(cur, {
      kind: 'setFingering',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      fingering: { system: 'piano', value: '1' },
    })
    cur = applyOperation(cur, {
      kind: 'setFingering',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 1 },
      fingering: { system: 'piano', value: '3' },
    })
    cur = applyOperation(cur, {
      kind: 'setFingering',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 2 },
      fingering: { system: 'piano', value: '5' },
    })
    expect(cur.measures[0].events[0].fingerings).toEqual([
      { system: 'piano', value: '1' },
      { system: 'piano', value: '3' },
      { system: 'piano', value: '5' },
    ])
  })

  it('overwrites an existing fingering at the same pitchIdx', () => {
    const seeded: Score = {
      ...CHORD_SCORE,
      measures: [
        {
          events: [
            {
              ...CHORD_SCORE.measures[0].events[0],
              fingerings: [
                { system: 'piano', value: '1' },
                { system: 'piano', value: '3' },
                { system: 'piano', value: '5' },
              ],
            },
          ],
        },
      ],
    }
    const next = applyOperation(seeded, {
      kind: 'setFingering',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 1 },
      fingering: { system: 'piano', value: '2' },
    })
    expect(next.measures[0].events[0].fingerings).toEqual([
      { system: 'piano', value: '1' },
      { system: 'piano', value: '2' },
      { system: 'piano', value: '5' },
    ])
  })

  it('accepts a string-system fingering on a violin-style line', () => {
    const next = applyOperation(MONOPHONIC, {
      kind: 'setFingering',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      fingering: { system: 'string', finger: 3, stringRoman: 'III' },
    })
    expect(next.measures[0].events[0].fingerings).toEqual([
      { system: 'string', finger: 3, stringRoman: 'III' },
    ])
  })

  it('accepts guitar-rh letters', () => {
    const next = applyOperation(MONOPHONIC, {
      kind: 'setFingering',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      fingering: { system: 'guitar-rh', value: 'p' },
    })
    expect(next.measures[0].events[0].fingerings).toEqual([{ system: 'guitar-rh', value: 'p' }])
  })

  it('rejects a fingering on a rest with EditError', () => {
    const restScore: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
      ],
    }
    expect(() =>
      applyOperation(restScore, {
        kind: 'setFingering',
        target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
        fingering: { system: 'piano', value: '1' },
      }),
    ).toThrow(EditError)
  })

  it('rejects out-of-range pitchIdx with a descriptive EditError', () => {
    expect(() =>
      applyOperation(CHORD_SCORE, {
        kind: 'setFingering',
        target: { measureIdx: 0, eventIdx: 0, pitchIdx: 5 },
        fingering: { system: 'piano', value: '1' },
      }),
    ).toThrow(/pitchIdx 5 out of range/)
  })
})

describe('editOperations — removeFingering', () => {
  it('clears the slot at the given pitchIdx and trims trailing nulls', () => {
    const seeded: Score = {
      ...CHORD_SCORE,
      measures: [
        {
          events: [
            {
              ...CHORD_SCORE.measures[0].events[0],
              fingerings: [
                { system: 'piano', value: '1' },
                { system: 'piano', value: '3' },
                { system: 'piano', value: '5' },
              ],
            },
          ],
        },
      ],
    }
    const next = applyOperation(seeded, {
      kind: 'removeFingering',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 2 },
    })
    expect(next.measures[0].events[0].fingerings).toEqual([
      { system: 'piano', value: '1' },
      { system: 'piano', value: '3' },
    ])
  })

  it('drops the fingerings field entirely when the last entry is removed', () => {
    const seeded: Score = {
      ...MONOPHONIC,
      measures: [
        {
          events: [
            {
              ...MONOPHONIC.measures[0].events[0],
              fingerings: [{ system: 'piano', value: '1' }],
            },
            ...MONOPHONIC.measures[0].events.slice(1),
          ],
        },
      ],
    }
    const next = applyOperation(seeded, {
      kind: 'removeFingering',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
    })
    expect(next.measures[0].events[0].fingerings).toBeUndefined()
    expect('fingerings' in next.measures[0].events[0]).toBe(false)
  })

  it('rejects out-of-range pitchIdx with a descriptive EditError', () => {
    expect(() =>
      applyOperation(CHORD_SCORE, {
        kind: 'removeFingering',
        target: { measureIdx: 0, eventIdx: 0, pitchIdx: 5 },
      }),
    ).toThrow(/pitchIdx 5 out of range/)
  })
})
