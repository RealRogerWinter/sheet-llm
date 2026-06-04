import { describe, it, expect } from 'vitest'
import { scoreToAbcWithMap, resolveClickPosition } from '@/lib/music/scoreToAbcWithMap'
import type { Score } from '@/lib/music/types'

function buildScore(partial: Partial<Score> & Pick<Score, 'measures'>): Score {
  return { key: 'C', meter: '4/4', ...partial }
}

describe('scoreToAbcWithMap', () => {
  it('emits the same ABC as scoreToAbc would', () => {
    const score = buildScore({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ] }],
    })
    const { abc, map } = scoreToAbcWithMap(score)
    expect(abc).toContain('K:C')
    expect(abc).toContain('C2D2E2F2')
    expect(map.events).toHaveLength(4)
  })

  it('every event range slices to its emitted text', () => {
    const score = buildScore({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'half' },
      ] }],
    })
    const { abc, map } = scoreToAbcWithMap(score)
    const e0 = map.events[0]
    const e1 = map.events[1]
    expect(abc.slice(e0.startChar, e0.endChar)).toBe('C2')
    expect(abc.slice(e1.startChar, e1.endChar)).toBe('D4')
  })

  it('chord ranges cover the bracketed event including [ and ]', () => {
    const score = buildScore({
      measures: [{ events: [{
        pitches: [
          { step: 'C', octave: 4 },
          { step: 'E', octave: 4 },
          { step: 'G', octave: 4 },
        ],
        duration: 'whole',
      }] }],
    })
    const { abc, map } = scoreToAbcWithMap(score)
    const event = map.events[0]
    expect(abc.slice(event.startChar, event.endChar)).toBe('[CEG]8')
    // Pitch ranges sit INSIDE the brackets, no brackets included.
    expect(event.pitchRanges).toHaveLength(3)
    expect(abc.slice(event.pitchRanges[0].startChar, event.pitchRanges[0].endChar)).toBe('C')
    expect(abc.slice(event.pitchRanges[1].startChar, event.pitchRanges[1].endChar)).toBe('E')
    expect(abc.slice(event.pitchRanges[2].startChar, event.pitchRanges[2].endChar)).toBe('G')
  })

  it('tuplet range excludes the (n prefix', () => {
    const score = buildScore({
      meter: '4/4',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 5 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'D', octave: 5 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'E', octave: 5 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      ] }],
    })
    const { abc, map } = scoreToAbcWithMap(score)
    // First three events are tuplet members; their ranges should NOT
    // include the "(3" prefix.
    const e0 = map.events[0]
    expect(abc.slice(e0.startChar, e0.endChar)).toBe('c')
    // The "(3" is at positions startChar - 2 .. startChar
    expect(abc.slice(e0.startChar - 2, e0.startChar)).toBe('(3')
  })

  it('byEvent map keyed by `${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}` returns the same EventRange', () => {
    const score = buildScore({
      measures: [
        { events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
        ] },
        { events: [
          { pitches: [{ step: 'G', octave: 4 }], duration: 'whole' },
        ] },
      ],
    })
    const { map } = scoreToAbcWithMap(score)
    expect(map.byEvent.get('0:0:0:2')).toBe(map.events[2])
    expect(map.byEvent.get('0:0:1:0')).toBe(map.events[4])
  })

  it('event ranges are monotonically non-overlapping and in order', () => {
    const score = buildScore({
      measures: [
        { events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
        ] },
        { events: [
          { pitches: [{ step: 'G', octave: 4 }], duration: 'whole' },
        ] },
      ],
    })
    const { map } = scoreToAbcWithMap(score)
    for (let i = 1; i < map.events.length; i++) {
      expect(map.events[i].startChar).toBeGreaterThanOrEqual(map.events[i - 1].endChar)
    }
  })
})

describe('scoreToAbcWithMap — grand staff', () => {
  it('emits %%score and V:1/V:2 blocks when secondStaff is present', () => {
    const score: Score = buildScore({
      measures: [
        { events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
        ] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
        ],
      },
    })
    const { abc } = scoreToAbcWithMap(score)
    // Grand staff = two separate staves, one voice each. abcjs's
    // %%score groups voices on the SAME staff inside parens, so
    // "(1) (2)" is the two-staff layout (vs "(1 2)" which would
    // collapse both onto a single staff).
    expect(abc).toContain('%%score (1) (2)')
    expect(abc).toContain('V:1 clef=treble')
    expect(abc).toContain('V:2 clef=bass')
  })

  it('tags each event with its staffIdx in the source map', () => {
    const score: Score = buildScore({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
      ] }],
      secondStaff: {
        clef: 'bass',
        measures: [{ events: [
          { pitches: [{ step: 'C', octave: 3 }], duration: 'whole' },
        ] }],
      },
    })
    const { map } = scoreToAbcWithMap(score)
    expect(map.events.filter((e) => e.staffIdx === 0)).toHaveLength(1)
    expect(map.events.filter((e) => e.staffIdx === 1)).toHaveLength(1)
    expect(map.byEvent.get('0:0:0:0')).toBeDefined()
    expect(map.byEvent.get('1:0:0:0')).toBeDefined()
  })

  it('source-map char ranges stay sorted across both voices (binary search safe)', () => {
    const score: Score = buildScore({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ] }],
      secondStaff: {
        clef: 'bass',
        measures: [{ events: [
          { pitches: [{ step: 'C', octave: 3 }], duration: 'whole' },
        ] }],
      },
    })
    const { map } = scoreToAbcWithMap(score)
    for (let i = 1; i < map.events.length; i++) {
      expect(map.events[i].startChar).toBeGreaterThanOrEqual(map.events[i - 1].endChar)
    }
  })
})

describe('scoreToAbcWithMap — SATB / extra voices', () => {
  it('groups SATB voices as %%score (1 2) (3 4) — two voices per staff', () => {
    const events4 = [
      { pitches: [{ step: 'C' as const, octave: 4 }], duration: 'quarter' as const },
      { pitches: [{ step: 'D' as const, octave: 4 }], duration: 'quarter' as const },
      { pitches: [{ step: 'E' as const, octave: 4 }], duration: 'quarter' as const },
      { pitches: [{ step: 'F' as const, octave: 4 }], duration: 'quarter' as const },
    ]
    const score: Score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: events4 }],            // soprano
      extraVoices: [{ measures: [{ events: events4 }] }], // alto
      secondStaff: {
        clef: 'bass',
        measures: [{ events: events4.map((e) => ({ ...e, pitches: [{ step: e.pitches[0].step, octave: 3 as const }] })) }], // tenor
        extraVoices: [{ measures: [{ events: events4.map((e) => ({ ...e, pitches: [{ step: e.pitches[0].step, octave: 2 as const }] })) }] }], // bass
      },
    }
    const { abc, map } = scoreToAbcWithMap(score)
    expect(abc).toContain('%%score (1 2) (3 4)')
    expect(abc).toContain('V:1 clef=treble')
    expect(abc).toContain('V:2 clef=treble')
    expect(abc).toContain('V:3 clef=bass')
    expect(abc).toContain('V:4 clef=bass')
    // Source map tags each voice independently.
    expect(map.byEvent.get('0:0:0:0')).toBeDefined()  // soprano m0 e0
    expect(map.byEvent.get('0:1:0:0')).toBeDefined()  // alto m0 e0
    expect(map.byEvent.get('1:0:0:0')).toBeDefined()  // tenor m0 e0
    expect(map.byEvent.get('1:1:0:0')).toBeDefined()  // bass m0 e0
  })

  it('single-staff two-voice score groups as %%score (1 2)', () => {
    const events4 = [
      { pitches: [{ step: 'C' as const, octave: 4 }], duration: 'quarter' as const },
      { pitches: [{ step: 'D' as const, octave: 4 }], duration: 'quarter' as const },
      { pitches: [{ step: 'E' as const, octave: 4 }], duration: 'quarter' as const },
      { pitches: [{ step: 'F' as const, octave: 4 }], duration: 'quarter' as const },
    ]
    const score: Score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: events4 }],
      extraVoices: [{ measures: [{ events: events4 }] }],
    }
    const { abc } = scoreToAbcWithMap(score)
    expect(abc).toContain('%%score (1 2)')
  })
})

describe('resolveClickPosition', () => {
  it('returns the correct event when the click lands inside its range', () => {
    const score: Score = {
      key: 'C', meter: '4/4',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ] }],
    }
    const { map } = scoreToAbcWithMap(score)
    const hit = resolveClickPosition(map, map.events[2].startChar)
    expect(hit).toEqual({ staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 2, pitchIdx: 0 })
  })

  it('finds the right pitch inside a chord', () => {
    const score: Score = {
      key: 'C', meter: '4/4',
      measures: [{ events: [{
        pitches: [
          { step: 'C', octave: 4 },
          { step: 'E', octave: 4 },
          { step: 'G', octave: 4 },
        ],
        duration: 'whole',
      }] }],
    }
    const { map } = scoreToAbcWithMap(score)
    const event = map.events[0]
    // Click on the 'E' pitch
    const hit = resolveClickPosition(map, event.pitchRanges[1].startChar)
    expect(hit).toEqual({ staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, pitchIdx: 1 })
  })

  it('returns undefined when click lands outside any event range', () => {
    const score: Score = {
      key: 'C', meter: '4/4',
      measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
    }
    const { map } = scoreToAbcWithMap(score)
    const hit = resolveClickPosition(map, 0) // header chars
    expect(hit).toBeUndefined()
  })

  describe('technique annotations (M3-PR-3) and source map', () => {
    it('event range encompasses the "^pizz." annotation prefix', () => {
      const score = buildScore({
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
        ],
        techniqueStates: [
          { id: 'techmap-1', measureIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
        ],
      })
      const { abc, map } = scoreToAbcWithMap(score)
      const e0 = map.events[0]
      // The sliced range starts at the annotation, NOT at the pitch.
      // Octave 3 in ABC renders as `C,` (single comma).
      expect(abc.slice(e0.startChar, e0.endChar)).toContain('"^pizz."')
      expect(abc.slice(e0.startChar, e0.endChar)).toContain('C,')
    })

    it('clicking on the pitch (after the annotation) still resolves to the right event', () => {
      const score = buildScore({
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
          { events: [{ pitches: [{ step: 'D', octave: 3 }], duration: 'whole' }] },
        ],
        techniqueStates: [
          { id: 'techmap-2', measureIdx: 1, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
        ],
      })
      const { abc, map } = scoreToAbcWithMap(score)
      // Find the position of D, (second measure's pitch)
      const dIdx = abc.indexOf('D,')
      const hit = resolveClickPosition(map, dIdx)
      expect(hit).toEqual({
        staffIdx: 0,
        voiceIdx: 0,
        measureIdx: 1,
        eventIdx: 0,
        pitchIdx: 0,
      })
    })

    it('multiple-event measure with an interior technique still resolves clicks correctly', () => {
      const score = buildScore({
        clef: 'bass',
        measures: [
          {
            events: [
              { pitches: [{ step: 'C', octave: 3 }], duration: 'quarter' },
              { pitches: [{ step: 'D', octave: 3 }], duration: 'quarter' },
              { pitches: [{ step: 'E', octave: 3 }], duration: 'quarter' },
              { pitches: [{ step: 'F', octave: 3 }], duration: 'quarter' },
            ],
          },
        ],
        techniqueStates: [
          { id: 'techmap-3', measureIdx: 0, eventIdx: 2, staffIdx: 0, voiceIdx: 0, kind: 'arco' },
        ],
      })
      const { abc, map } = scoreToAbcWithMap(score)
      const e2 = map.events[2]
      expect(abc.slice(e2.startChar, e2.endChar)).toContain('"^arco"E,2')
      // Click on the F, (event 3) still resolves correctly — annotation
      // characters got accounted for in the offset accumulator.
      const fIdx = abc.indexOf('F,')
      const hit = resolveClickPosition(map, fIdx)
      expect(hit?.eventIdx).toBe(3)
    })
  })
})
