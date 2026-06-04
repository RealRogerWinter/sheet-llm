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

describe('scoreToAbcWithMap — hairpin rendering (M11-PR-4)', () => {
  it('emits crescendo decorations !<(! and !<)! at the endpoints', () => {
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
    expect(abc).toContain('!<(!')
    expect(abc).toContain('!<)!')
    expect(abc).not.toContain('!>(!')
    expect(abc).not.toContain('!>)!')
  })

  it('emits diminuendo decorations !>(! and !>)! at the endpoints', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'hairpin001',
          kind: 'hairpin-dim',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!>(!')
    expect(abc).toContain('!>)!')
    expect(abc).not.toContain('!<(!')
    expect(abc).not.toContain('!<)!')
  })

  it('positions the start decoration immediately before the start event', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'hairpin001',
          kind: 'hairpin-cresc',
          startEventId: idB, // 2nd event = D2
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // D is the start; abc text should have !<(!D2 inline (or with
    // intervening decorations from other prefixes — none here).
    expect(abc).toMatch(/!<\(!D2/)
  })

  it('positions the end decoration immediately before the end event', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'hairpin001',
          kind: 'hairpin-cresc',
          startEventId: idA,
          endEventId: idC, // 3rd event = E2
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toMatch(/!<\)!E2/)
  })

  it('crosses a barline (start in m1, end in m2)', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'hairpin001',
          kind: 'hairpin-cresc',
          startEventId: idA, // measure 1 event 0
          endEventId: idF, // measure 2 event 1
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toMatch(/!<\(!C2/)
    expect(abc).toMatch(/!<\)!A4/)
  })

  it('emits terminal dynamic glyphs alongside the hairpin endpoints', () => {
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
          startDynamic: 'p',
          endDynamic: 'f',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!p!')
    expect(abc).toContain('!f!')
    // Terminal dyn precedes the hairpin-open token at the start event
    expect(abc).toMatch(/!p!!<\(!/)
    // Hairpin-close precedes the terminal end dyn at the end event
    expect(abc).toMatch(/!<\)!!f!/)
  })

  it('accumulates multiple hairpin endpoints on the same event', () => {
    // Hairpin 1: ends at event B. Hairpin 2: starts at event B.
    // Both decorations should appear on the same note.
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'hairpin001',
          kind: 'hairpin-cresc',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'hairpin002',
          kind: 'hairpin-dim',
          startEventId: idB,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // The B event should carry both a `!<)!` (end of cresc) and a
    // `!>(!` (start of dim).
    expect(abc).toContain('!<)!')
    expect(abc).toContain('!>(!')
    expect(abc).toMatch(/!<\)!!>\(!D2/)
  })

  it('silently skips hairpins with unresolvable endpoint ids', () => {
    // Renderer is the wrong place to throw; validateCrossRefs catches
    // this earlier. Render should still produce valid ABC without the
    // broken hairpin.
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'hairpin001',
          kind: 'hairpin-cresc',
          startEventId: 'doesnotexist',
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).not.toContain('!<(!')
    expect(abc).not.toContain('!<)!')
  })

  it('non-hairpin spans (slur, glissando) do not emit hairpin decorations', () => {
    // M11-PR-4 only wires hairpins. A slur span should not produce a
    // hairpin glyph (slurs ship in M12).
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'slur00001',
          kind: 'slur',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).not.toContain('!<(!')
    expect(abc).not.toContain('!<)!')
    expect(abc).not.toContain('!>(!')
    expect(abc).not.toContain('!>)!')
  })

  it('a score with no spans renders unchanged from baseline', () => {
    const sc = buildScore()
    const withoutSpans = scoreToAbcWithMap(sc).abc
    const withEmptySpans = scoreToAbcWithMap({ ...sc, spans: [] }).abc
    expect(withEmptySpans).toBe(withoutSpans)
  })

  it('hairpin on a second staff renders on that staff, not the primary', () => {
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
          id: 'hairpin001',
          kind: 'hairpin-cresc',
          startEventId: idC,
          endEventId: idD,
          staffIdx: 1,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // The cresc tokens should appear in the bass-staff voice line, not
    // attached to the treble C5. The bass voice begins on its V: line;
    // both tokens should appear after the V: declaration for staff 1.
    expect(abc).toContain('!<(!')
    expect(abc).toContain('!<)!')
    // Check that the primary staff's C8 isn't preceded by !<(! (which
    // would indicate misrouting to the wrong voice).
    expect(abc).not.toMatch(/!<\(!C8/)
  })

  it('terminal startDynamic is suppressed when the start event already carries the same dynamic', () => {
    // Avoid double-glyph: event.dynamic 'p' + hairpin.startDynamic 'p'
    // would otherwise produce two stacked !p! tokens.
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { id: idA, pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', dynamic: 'p' },
            { id: idB, pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
            { id: idC, pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
            { id: idD, pitches: [{ step: 'F', octave: 4 }], duration: 'quarter', dynamic: 'f' },
          ],
        },
      ],
      spans: [
        {
          id: 'hairpin001',
          kind: 'hairpin-cresc',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          startDynamic: 'p',
          endDynamic: 'f',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // Only ONE !p! glyph (from the event's own dynamic), then the
    // hairpin open token. Same for !f! at the end.
    const pCount = (abc.match(/!p!/g) ?? []).length
    const fCount = (abc.match(/!f!/g) ?? []).length
    expect(pCount).toBe(1)
    expect(fCount).toBe(1)
  })

  it('terminal dynamic is emitted when the start event has a DIFFERENT dynamic', () => {
    // Event has !mf!, hairpin asks for !p! at start — both render
    // (the user has expressed two distinct intents).
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { id: idA, pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', dynamic: 'mf' },
            { id: idD, pitches: [{ step: 'F', octave: 4 }], duration: 'half' },
          ],
        },
      ],
      spans: [
        {
          id: 'hairpin001',
          kind: 'hairpin-cresc',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          startDynamic: 'p',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!mf!')
    expect(abc).toContain('!p!')
  })

  it('hairpin endpoint inside a tuplet renders with the open/close decoration', () => {
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
          id: 'hairpin001',
          kind: 'hairpin-cresc',
          startEventId: idA, // first tuplet member
          endEventId: idC, // last tuplet member
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!<(!')
    expect(abc).toContain('!<)!')
    // The decoration sits between the (3 prefix and the note — abcjs
    // accepts decorations anywhere before the pitch token.
    expect(abc).toMatch(/!<\(!c/)
    expect(abc).toMatch(/!<\)!e/)
  })

  it('zero-duration hairpin (start === end) emits both glyphs on the same note', () => {
    // Validator permits start === end as a limit case; renderer should
    // produce both open and close on that single note.
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'hairpin001',
          kind: 'hairpin-cresc',
          startEventId: idA,
          endEventId: idA,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // Two-pass build means !<)! (close) precedes !<(! (open).
    expect(abc).toMatch(/!<\)!!<\(!C2/)
  })

  it('span array order does not affect rendered glyph order for adjacent hairpins', () => {
    // Two hairpins sharing event B as boundary: one ends at B, another
    // begins at B. Render must produce !<)!!<(! on B regardless of the
    // order spans appear in score.spans.
    const sc1: Score = {
      ...buildScore(),
      spans: [
        // Order A: cresc-ending-at-B FIRST, then cresc-starting-at-B
        {
          id: 'hairpin001',
          kind: 'hairpin-cresc',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'hairpin002',
          kind: 'hairpin-cresc',
          startEventId: idB,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const sc2: Score = {
      ...buildScore(),
      // Order B: same spans, reversed order
      spans: [sc1.spans![1], sc1.spans![0]],
    }
    const out1 = scoreToAbcWithMap(sc1).abc
    const out2 = scoreToAbcWithMap(sc2).abc
    expect(out1).toBe(out2)
    // The order at boundary B must be close-then-open.
    expect(out1).toMatch(/!<\)!!<\(!D2/)
  })

  it('source map char ranges stay accurate when hairpin decorations are present', () => {
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
    const { abc, map } = scoreToAbcWithMap(sc)
    // Every event's range still slices to its emitted text — the
    // decoration is INCLUDED in the start event's range (matches the
    // existing annotation / technique pattern).
    for (const r of map.events) {
      const slice = abc.slice(r.startChar, r.endChar)
      // The first event of measure 0 should now start with the
      // hairpin-cresc open token; subsequent events stay normal.
      if (r.measureIdx === 0 && r.eventIdx === 0) {
        expect(slice).toBe('!<(!C2')
      } else if (r.measureIdx === 0 && r.eventIdx === 3) {
        expect(slice).toBe('!<)!F2')
      }
    }
  })
})
