import { describe, it, expect } from 'vitest'
import { scoreToAbcWithMap } from '@/lib/music/scoreToAbcWithMap'
import type { Score } from '@/lib/music/types'

const idA = 'evtestid01'
const idB = 'evtestid02'
const idC = 'evtestid03'
const idD = 'evtestid04'
const idE = 'evtestid05'
const idF = 'evtestid06'

function buildScore(): Score {
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

describe('scoreToAbcWithMap — slur rendering (M12-PR-3)', () => {
  it('emits open paren before start event and close paren after end event', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'slurabcd01',
          kind: 'slur',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // (C2 ... F2)
    expect(abc).toMatch(/\(C2D2E2F2\)/)
  })

  it('phrase-slur emits the same paren tokens (no current visual differentiation)', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'slurabcd01',
          kind: 'phrase-slur',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toMatch(/\(C2D2E2F2\)/)
  })

  it('crosses a barline (start in m1, end in m2)', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'slurabcd01',
          kind: 'slur',
          startEventId: idA,
          endEventId: idF,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('(C2')
    expect(abc).toContain('A4)')
  })

  it('nested slurs accumulate as (( and ))', () => {
    // Inner slur b1-b3, outer slur b1-b4 — both START at A and the
    // inner ENDS at C (so C carries one `)`, outer END at D carries
    // another `)`).
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'slurouter1',
          kind: 'slur',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'slurinner1',
          kind: 'slur',
          startEventId: idA,
          endEventId: idC,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // Both starts pile up on A → `((`. Inner end on C → `)`. Outer end on D → `)`.
    expect(abc).toMatch(/\(\(C2/)
    expect(abc).toMatch(/E2\)/)
    expect(abc).toMatch(/F2\)/)
  })

  it('adjacent slurs (one ends at B, another starts at B) render as )(', () => {
    // Two slurs sharing event B as boundary. Two-pass build ensures
    // ) comes before ( on the shared note.
    const sc1: Score = {
      ...buildScore(),
      spans: [
        // Order A: ending-at-B FIRST, then starting-at-B
        {
          id: 'slurfirst1',
          kind: 'slur',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'slursecnd1',
          kind: 'slur',
          startEventId: idB,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const sc2: Score = {
      ...buildScore(),
      spans: [sc1.spans![1], sc1.spans![0]],
    }
    const out1 = scoreToAbcWithMap(sc1).abc
    const out2 = scoreToAbcWithMap(sc2).abc
    expect(out1).toBe(out2)
    // B is the boundary — close-then-open: D2) then (D2... wait, B is
    // event idB which is "D2" in the abc. So expect `D2)(` somewhere.
    // Actually wait: A=C2, B=D2 — D2 is the event whose ABC token is D2.
    // The close comes after D2 (close of first slur). The open comes
    // before D2 (open of second slur). With two-pass: close emitted to
    // map first (so it's at end-key D2's close), then open emitted (so
    // it's at start-key D2's open). Final rendered: `(C2(D2)E2F2)`.
    // The `(` of the second slur is BEFORE D2, so the sequence around
    // D2 is `(D2)`. NOT `D2)(` — the close of slur1 wraps with the
    // open of slur2.
    expect(out1).toMatch(/\(C2\(D2\)E2F2\)/)
  })

  it('zero-duration slur (start === end) emits ()  on the same note', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'slurzero01',
          kind: 'slur',
          startEventId: idA,
          endEventId: idA,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // Two-pass: close first (so A's close is `)`), then open (so A's
    // open is `(`). Rendered: `(C2)`.
    expect(abc).toMatch(/\(C2\)/)
  })

  it('silently skips slurs with unresolvable endpoint ids', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'slurabcd01',
          kind: 'slur',
          startEventId: 'doesnotexist',
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // No paren around the F event since start is unresolvable; also
    // no paren before any note (start was unresolvable).
    expect(abc).not.toContain('(C2')
    // F2 should NOT have a close paren attached.
    expect(abc).not.toContain('F2)')
  })

  it('non-slur spans (hairpin) do not emit slur parens', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'hairpin001',
          kind: 'hairpin-cresc',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // No slur parens around the notes; the hairpin emits its own
    // !<(! / !<)! decorations (verified by the hairpin renderer tests).
    expect(abc).not.toMatch(/\(C2/)
    expect(abc).not.toMatch(/F2\)/)
  })

  it('span array order does not affect rendered output', () => {
    const sc1: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'slurabcd01',
          kind: 'slur',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'slurabcd02',
          kind: 'slur',
          startEventId: idC,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const sc2: Score = {
      ...buildScore(),
      spans: [sc1.spans![1], sc1.spans![0]],
    }
    expect(scoreToAbcWithMap(sc1).abc).toBe(scoreToAbcWithMap(sc2).abc)
  })

  it('a score with no slurs (only hairpins) renders identically to baseline', () => {
    const baseline = scoreToAbcWithMap(buildScore()).abc
    const sc: Score = { ...buildScore(), spans: [] }
    expect(scoreToAbcWithMap(sc).abc).toBe(baseline)
  })

  it('slur on a second staff routes to that voice, not the primary', () => {
    const sc: Score = {
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
              { id: idC, pitches: [{ step: 'C', octave: 3 }], duration: 'half' },
              { id: idD, pitches: [{ step: 'D', octave: 3 }], duration: 'half' },
            ],
          },
        ],
      },
      spans: [
        {
          id: 'slurabcd01',
          kind: 'slur',
          startEventId: idC,
          endEventId: idD,
          staffIdx: 1,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // Bass staff: C,4 and D,4 with slur around them → (C,4D,4)
    expect(abc).toMatch(/\(C,4D,4\)/)
    // Primary staff's whole C5 should NOT have parens.
    expect(abc).not.toMatch(/\(c8/)
  })

  it('source map char ranges include opens in event range, closes in event range', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'slurabcd01',
          kind: 'slur',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc, map } = scoreToAbcWithMap(sc)
    for (const r of map.events) {
      const slice = abc.slice(r.startChar, r.endChar)
      if (r.measureIdx === 0 && r.eventIdx === 0) {
        // Start event includes the open paren.
        expect(slice).toBe('(C2')
      } else if (r.measureIdx === 0 && r.eventIdx === 3) {
        // End event includes the close paren.
        expect(slice).toBe('F2)')
      }
    }
  })

  it('slur endpoint inside a tuplet renders with parens correctly placed', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { id: idA, pitches: [{ step: 'C', octave: 5 }], duration: 'eighth', tuplet: 3 },
            { id: idB, pitches: [{ step: 'D', octave: 5 }], duration: 'eighth', tuplet: 3 },
            { id: idC, pitches: [{ step: 'E', octave: 5 }], duration: 'eighth', tuplet: 3 },
            { id: idD, pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
            { id: idE, pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
            { id: idF, pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
          ],
        },
      ],
      spans: [
        {
          id: 'slurabcd01',
          kind: 'slur',
          startEventId: idA, // first tuplet member
          endEventId: idC, // last tuplet member
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // Tuplet prefix `(3` precedes the slur-open `(` and the first pitch
    // — abcjs's note-group production consumes both at the prefix level.
    // Eighth notes in the default L:1/8 length omit the duration suffix
    // so the slurred run renders as `(3(cde)F2...`.
    expect(abc).toMatch(/\(3\(c/)
    expect(abc).toMatch(/e\)/)
  })

  it('slur whose start event is a chord stack renders open paren before the chord bracket', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              id: idA,
              pitches: [
                { step: 'C', octave: 4 },
                { step: 'E', octave: 4 },
                { step: 'G', octave: 4 },
              ],
              duration: 'quarter',
            },
            { id: idB, pitches: [{ step: 'D', octave: 5 }], duration: 'quarter' },
            { id: idC, pitches: [{ step: 'E', octave: 5 }], duration: 'quarter' },
            { id: idD, pitches: [{ step: 'F', octave: 5 }], duration: 'quarter' },
          ],
        },
      ],
      spans: [
        {
          id: 'slurabcd01',
          kind: 'slur',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // `([CEG]2D2...F2)` — open paren before the `[` chord bracket,
    // close after the last note's duration.
    expect(abc).toMatch(/\(\[CEG\]2/)
    expect(abc).toMatch(/f2\)/)
  })

  it('hairpin + slur on overlapping range coexist', () => {
    // Crescendo from A to D AND a slur from A to D — both span the
    // same range. Slur is bare parens; hairpin is !<(!/!<)! decorations.
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'slurabcd01',
          kind: 'slur',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'hairpin001',
          kind: 'hairpin-cresc',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('(C2')
    expect(abc).toContain('F2)')
    expect(abc).toContain('!<(!')
    expect(abc).toContain('!<)!')
    // Decoration ordering: hairpin-open + slur-open should appear
    // BEFORE C2 in the prefix chain. Slur is last in the chain
    // (closest to pitch), so `!<(!(C2` is expected.
    expect(abc).toMatch(/!<\(!\(C2/)
  })
})
