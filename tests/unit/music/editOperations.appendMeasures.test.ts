import { describe, expect, it } from 'vitest'
import { transformScore, type Operation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import type { Measure, Score } from '@/lib/music/types'

/**
 * Tests for the new structural multi-measure ops (M3.5-PR-3):
 * appendMeasures, insertMeasuresAfter, regionReplace.
 *
 * The orchestrator handlers (runExtendComposition, runInsertMeasures,
 * runRegionReplace) layer the LLM call + boundary handling on top of
 * these pure structural mutations. These tests cover the structural
 * layer only.
 */

const wholeRest: Measure = {
  events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }],
}

function fourFourScore(bars = 4): Score {
  return {
    title: 'Test',
    key: 'C',
    meter: '4/4',
    measures: Array.from({ length: bars }, () => ({
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
      ],
    })),
  }
}

function newBars(n: number): Measure[] {
  return Array.from({ length: n }, () => wholeRest)
}

describe('editOperations: appendMeasures', () => {
  it('appends N measures to a single-staff single-voice score', () => {
    const score = fourFourScore(4)
    const op: Operation = { kind: 'appendMeasures', measures: newBars(2) }
    const next = transformScore(score, op)
    expect(next.measures).toHaveLength(6)
    // First 4 measures byte-identical to original.
    expect(next.measures.slice(0, 4)).toEqual(score.measures)
    validateScore(next)
  })

  it('preserves top-level metadata (key, meter, title, tempo)', () => {
    const score: Score = { ...fourFourScore(2), tempo_bpm: 120, title: 'Triplet demo' }
    const op: Operation = { kind: 'appendMeasures', measures: newBars(1) }
    const next = transformScore(score, op)
    expect(next.key).toBe('C')
    expect(next.meter).toBe('4/4')
    expect(next.title).toBe('Triplet demo')
    expect(next.tempo_bpm).toBe(120)
  })

  it('fan-outs rests on secondStaff when perVoiceContent omitted', () => {
    const score: Score = {
      ...fourFourScore(2),
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
          { events: [{ pitches: [{ step: 'D', octave: 3 }], duration: 'whole' }] },
        ],
      },
    }
    const op: Operation = { kind: 'appendMeasures', measures: newBars(2) }
    const next = transformScore(score, op)
    expect(next.measures).toHaveLength(4)
    expect(next.secondStaff!.measures).toHaveLength(4)
    // Secondary's new bars are whole rests.
    expect(next.secondStaff!.measures[2].events[0].pitches[0].step).toBe('rest')
    expect(next.secondStaff!.measures[3].events[0].pitches[0].step).toBe('rest')
    validateScore(next)
  })

  it('honors perVoiceContent for secondStaff when provided', () => {
    const score: Score = {
      ...fourFourScore(2),
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
          { events: [{ pitches: [{ step: 'D', octave: 3 }], duration: 'whole' }] },
        ],
      },
    }
    const newPrimary: Measure[] = [
      {
        events: [
          { pitches: [{ step: 'E', octave: 4 }], duration: 'half' },
          { pitches: [{ step: 'F', octave: 4 }], duration: 'half' },
        ],
      },
    ]
    const newSecondary: Measure[] = [
      { events: [{ pitches: [{ step: 'E', octave: 3 }], duration: 'whole' }] },
    ]
    const op: Operation = {
      kind: 'appendMeasures',
      measures: newPrimary,
      perVoiceContent: [
        { voices: [newPrimary] },
        { voices: [newSecondary] },
      ],
    }
    const next = transformScore(score, op)
    expect(next.secondStaff!.measures).toHaveLength(3)
    expect(next.secondStaff!.measures[2].events[0].pitches[0].step).toBe('E')
    expect(next.secondStaff!.measures[2].events[0].pitches[0].octave).toBe(3)
    validateScore(next)
  })

  it('clears isFinalPartial on the previously-last measure', () => {
    const score = fourFourScore(2)
    score.measures[1] = { ...score.measures[1], isFinalPartial: true }
    const op: Operation = { kind: 'appendMeasures', measures: newBars(1) }
    const next = transformScore(score, op)
    expect(next.measures[1].isFinalPartial).toBeUndefined()
  })

  it('keeps techniqueStates measureIdx unchanged on append', () => {
    const score: Score = {
      ...fourFourScore(4),
      techniqueStates: [
        {
          id: 'tech1xxxxx',
          measureIdx: 2,
          staffIdx: 0,
          voiceIdx: 0,
          kind: 'pizz',
        },
      ],
    }
    const op: Operation = { kind: 'appendMeasures', measures: newBars(2) }
    const next = transformScore(score, op)
    expect(next.techniqueStates).toHaveLength(1)
    expect(next.techniqueStates![0].measureIdx).toBe(2)
  })
})

describe('editOperations: insertMeasuresAfter — index remap', () => {
  it('inserts N measures and shifts forward references', () => {
    const score = fourFourScore(4)
    const op: Operation = {
      kind: 'insertMeasuresAfter',
      afterMeasureIdx: 1,
      measures: newBars(2),
    }
    const next = transformScore(score, op)
    expect(next.measures).toHaveLength(6)
    // First 2 measures byte-identical.
    expect(next.measures[0]).toEqual(score.measures[0])
    expect(next.measures[1]).toEqual(score.measures[1])
    // Old measures 2,3 now at 4,5.
    expect(next.measures[4]).toEqual(score.measures[2])
    expect(next.measures[5]).toEqual(score.measures[3])
    validateScore(next)
  })

  it('remaps techniqueStates.measureIdx forward', () => {
    const score: Score = {
      ...fourFourScore(4),
      techniqueStates: [
        { id: 'aaaaaaaaaa', measureIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
        { id: 'bbbbbbbbbb', measureIdx: 3, staffIdx: 0, voiceIdx: 0, kind: 'arco' },
      ],
    }
    const op: Operation = {
      kind: 'insertMeasuresAfter',
      afterMeasureIdx: 1,
      measures: newBars(2),
    }
    const next = transformScore(score, op)
    expect(next.techniqueStates![0].measureIdx).toBe(0) // before insert point
    expect(next.techniqueStates![1].measureIdx).toBe(5) // 3 + 2
  })

  it('remaps voltas start+end forward', () => {
    const score: Score = {
      ...fourFourScore(4),
      voltas: [
        {
          id: 'voltaaaaaa',
          startMeasureIdx: 2,
          endMeasureIdx: 3,
          endings: [1],
        },
      ],
    }
    const op: Operation = {
      kind: 'insertMeasuresAfter',
      afterMeasureIdx: 0,
      measures: newBars(1),
    }
    const next = transformScore(score, op)
    expect(next.voltas![0].startMeasureIdx).toBe(3)
    expect(next.voltas![0].endMeasureIdx).toBe(4)
  })

  it('remaps markers forward', () => {
    const score: Score = {
      ...fourFourScore(4),
      markers: [{ measureIdx: 2, key: 'G' }],
    }
    const op: Operation = {
      kind: 'insertMeasuresAfter',
      afterMeasureIdx: 1,
      measures: newBars(2),
    }
    const next = transformScore(score, op)
    expect(next.markers![0].measureIdx).toBe(4)
  })

  it('remaps jumpMarkers forward', () => {
    const score: Score = {
      ...fourFourScore(4),
      jumpMarkers: [
        { id: 'jumpmarker1', measureIdx: 3, side: 'end', kind: 'D.C.' },
      ],
    }
    const op: Operation = {
      kind: 'insertMeasuresAfter',
      afterMeasureIdx: 0,
      measures: newBars(2),
    }
    const next = transformScore(score, op)
    expect(next.jumpMarkers![0].measureIdx).toBe(5)
  })

  it('remaps annotations target.measureIdx + spanEnd.measureIdx', () => {
    const score: Score = {
      ...fourFourScore(4),
      annotations: [
        {
          id: 'annnotation1',
          target: { measureIdx: 1, position: 'above' },
          text: 'rit.',
          style: 'expression',
          spanEnd: { measureIdx: 3 },
        },
      ],
    }
    const op: Operation = {
      kind: 'insertMeasuresAfter',
      afterMeasureIdx: 0,
      measures: newBars(1),
    }
    const next = transformScore(score, op)
    expect(next.annotations![0].target.measureIdx).toBe(2)
    expect(next.annotations![0].spanEnd!.measureIdx).toBe(4)
  })

  it('rejects afterMeasureIdx out of range', () => {
    const score = fourFourScore(2)
    const op: Operation = {
      kind: 'insertMeasuresAfter',
      afterMeasureIdx: 5,
      measures: newBars(1),
    }
    expect(() => transformScore(score, op)).toThrow(/out of range/)
  })
})

describe('editOperations: regionReplace — index remap + severance', () => {
  it('replaces a contiguous run of measures', () => {
    const score = fourFourScore(6)
    const replacement: Measure[] = [
      { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
    ]
    const op: Operation = {
      kind: 'regionReplace',
      startMeasureIdx: 2,
      endMeasureIdx: 4,
      measures: replacement,
    }
    const next = transformScore(score, op)
    expect(next.measures).toHaveLength(4) // 6 - 3 replaced + 1 new
    expect(next.measures[0]).toEqual(score.measures[0])
    expect(next.measures[1]).toEqual(score.measures[1])
    expect(next.measures[2]).toEqual(replacement[0])
    expect(next.measures[3]).toEqual(score.measures[5])
    validateScore(next)
  })

  it('rejects an invalid range (start > end)', () => {
    const score = fourFourScore(4)
    const op: Operation = {
      kind: 'regionReplace',
      startMeasureIdx: 3,
      endMeasureIdx: 1,
      measures: newBars(1),
    }
    expect(() => transformScore(score, op)).toThrow(/invalid/)
  })

  it('rejects emptying the score', () => {
    const score = fourFourScore(2)
    const op: Operation = {
      kind: 'regionReplace',
      startMeasureIdx: 0,
      endMeasureIdx: 1,
      measures: [],
    }
    expect(() => transformScore(score, op)).toThrow(/empty the score/)
  })

  it('drops a span fully inside the replaced range', () => {
    const score: Score = {
      ...fourFourScore(4),
      measures: [
        { events: [{ id: 'evt0000000', pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        { events: [{ id: 'evt0000001', pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
        { events: [{ id: 'evt0000002', pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
        { events: [{ id: 'evt0000003', pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
      ],
      spans: [
        {
          id: 'span000000',
          kind: 'slur',
          startEventId: 'evt0000001',
          endEventId: 'evt0000002',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const op: Operation = {
      kind: 'regionReplace',
      startMeasureIdx: 1,
      endMeasureIdx: 2,
      measures: newBars(1),
    }
    const next = transformScore(score, op)
    expect(next.spans).toBeUndefined()
  })

  it('drops a severed span (one endpoint inside, other outside)', () => {
    const score: Score = {
      ...fourFourScore(4),
      measures: [
        { events: [{ id: 'evt0000000', pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        { events: [{ id: 'evt0000001', pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
        { events: [{ id: 'evt0000002', pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
        { events: [{ id: 'evt0000003', pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
      ],
      spans: [
        {
          id: 'spaaaaaa01',
          kind: 'slur',
          startEventId: 'evt0000000',
          endEventId: 'evt0000002', // severed by replacing range [1..2]
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const op: Operation = {
      kind: 'regionReplace',
      startMeasureIdx: 1,
      endMeasureIdx: 2,
      measures: newBars(1),
    }
    const next = transformScore(score, op)
    expect(next.spans).toBeUndefined()
  })

  it('remaps markers AFTER the range; drops markers INSIDE if range count=0 (deletion)', () => {
    // Use count > 0 since 0-count deletes are rejected when emptying;
    // here the marker is INSIDE the range and the range collapses to
    // a single new measure → marker pins to that measure.
    const score: Score = {
      ...fourFourScore(6),
      markers: [
        { measureIdx: 1, key: 'G' }, // before range
        { measureIdx: 3, key: 'D' }, // inside range [2..4]
        { measureIdx: 5, key: 'A' }, // after range
      ],
    }
    const op: Operation = {
      kind: 'regionReplace',
      startMeasureIdx: 2,
      endMeasureIdx: 4,
      measures: newBars(1),
    }
    const next = transformScore(score, op)
    // before: stays
    // inside: pinned to start+newCount-1 = 2+1-1 = 2 (the new measure)
    // after: shifted by (1-3) = -2 → 5 → 3
    expect(next.markers!.map((m) => m.measureIdx).sort((a, b) => a - b)).toEqual([1, 2, 3])
  })
})
