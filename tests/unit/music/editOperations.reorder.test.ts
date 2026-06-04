import { describe, it, expect } from 'vitest'
import { applyOperation, transformScore, EditError } from '@/lib/music/editOperations'
import type { Score } from '@/lib/music/types'

function buildScore(partial: Partial<Score> & Pick<Score, 'measures'>): Score {
  return { key: 'C', meter: '4/4', ...partial }
}

const THREE_NOTES: Score = buildScore({
  measures: [{ events: [
    { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
    { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
    { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
    { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
  ] }],
})

const TWO_MEASURES: Score = buildScore({
  measures: [
    { events: [
      { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
      { pitches: [{ step: 'D', octave: 4 }], duration: 'half' },
    ]},
    { events: [
      { pitches: [{ step: 'E', octave: 4 }], duration: 'half' },
      { pitches: [{ step: 'F', octave: 4 }], duration: 'half' },
    ]},
  ],
})

describe('reorderEvent — within measure', () => {
  it('swaps right with the next event', () => {
    const next = applyOperation(THREE_NOTES, {
      kind: 'reorderEvent',
      target: { measureIdx: 0, eventIdx: 0 },
      direction: 'right',
    })
    const steps = next.measures[0].events.map((e) => e.pitches[0].step)
    expect(steps).toEqual(['D', 'C', 'E', 'F'])
  })

  it('swaps left with the previous event', () => {
    const next = applyOperation(THREE_NOTES, {
      kind: 'reorderEvent',
      target: { measureIdx: 0, eventIdx: 2 },
      direction: 'left',
    })
    const steps = next.measures[0].events.map((e) => e.pitches[0].step)
    expect(steps).toEqual(['C', 'E', 'D', 'F'])
  })

  it('does not mutate the input score', () => {
    const before = JSON.stringify(THREE_NOTES)
    applyOperation(THREE_NOTES, {
      kind: 'reorderEvent',
      target: { measureIdx: 0, eventIdx: 1 },
      direction: 'right',
    })
    expect(JSON.stringify(THREE_NOTES)).toBe(before)
  })
})

describe('reorderEvent — across barline (pure transform, no duration validation)', () => {
  it('moves the last event of m.0 to the start of m.1 on right', () => {
    const next = transformScore(TWO_MEASURES, {
      kind: 'reorderEvent',
      target: { measureIdx: 0, eventIdx: 1 },
      direction: 'right',
    })
    const m0 = next.measures[0].events.map((e) => e.pitches[0].step)
    const m1 = next.measures[1].events.map((e) => e.pitches[0].step)
    expect(m0).toEqual(['C'])
    expect(m1).toEqual(['D', 'E', 'F'])
  })

  it('moves the first event of m.1 to the end of m.0 on left', () => {
    const next = transformScore(TWO_MEASURES, {
      kind: 'reorderEvent',
      target: { measureIdx: 1, eventIdx: 0 },
      direction: 'left',
    })
    const m0 = next.measures[0].events.map((e) => e.pitches[0].step)
    const m1 = next.measures[1].events.map((e) => e.pitches[0].step)
    expect(m0).toEqual(['C', 'D', 'E'])
    expect(m1).toEqual(['F'])
  })

  it('throws if moving across barline would empty a measure', () => {
    const oneNoteEach: Score = buildScore({
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
      ],
    })
    expect(() =>
      transformScore(oneNoteEach, {
        kind: 'reorderEvent',
        target: { measureIdx: 0, eventIdx: 0 },
        direction: 'right',
      }),
    ).toThrow(EditError)
  })
})

describe('reorderEvent — score boundaries', () => {
  it('right at end of last measure is a no-op (same score reference)', () => {
    const next = transformScore(THREE_NOTES, {
      kind: 'reorderEvent',
      target: { measureIdx: 0, eventIdx: THREE_NOTES.measures[0].events.length - 1 },
      direction: 'right',
    })
    expect(next).toBe(THREE_NOTES)
  })

  it('left at start of first measure is a no-op (same score reference)', () => {
    const next = transformScore(THREE_NOTES, {
      kind: 'reorderEvent',
      target: { measureIdx: 0, eventIdx: 0 },
      direction: 'left',
    })
    expect(next).toBe(THREE_NOTES)
  })
})

describe('reorderEvent — tuplet preservation', () => {
  it('swapping two same-tuplet siblings keeps the tuplet group intact', () => {
    // Duration math: 3-eighth tuplet plays in the time of 2 eighths,
    // + half (4 eighths) + quarter (2 eighths) = 2 + 4 + 2 = 8 = 4/4. ✓
    const tuplet: Score = buildScore({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'half' },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
      ]}],
    })
    const next = applyOperation(tuplet, {
      kind: 'reorderEvent',
      target: { measureIdx: 0, eventIdx: 0 },
      direction: 'right',
    })
    expect(next.measures[0].events[0].tuplet).toBe(3)
    expect(next.measures[0].events[1].tuplet).toBe(3)
    expect(next.measures[0].events[2].tuplet).toBe(3)
    expect(next.measures[0].events[3].tuplet).toBeUndefined()
    expect(next.measures[0].events[4].tuplet).toBeUndefined()
    const steps = next.measures[0].events.map((e) => e.pitches[0].step)
    expect(steps).toEqual(['D', 'C', 'E', 'F', 'G'])
  })
})
