import { describe, it, expect } from 'vitest'
import abcjs from 'abcjs'
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

describe('scoreToAbcWithMap — tempo-span rendering (M14-PR-2)', () => {
  it('emits "accel." annotation at the start event of an accel span', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'tempoaccl1',
          kind: 'accel',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^accel."')
  })

  it('emits "rit." annotation for a ritardando span', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'temporit01',
          kind: 'rit',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^rit."')
  })

  it('emits the terminal "♩=144" annotation at the end event when endTempoBpm is set', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'tempoacbpm',
          kind: 'accel',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          endTempoBpm: 144,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^accel."')
    expect(abc).toContain('"^♩=144"')
  })

  it('emits the terminal text annotation when endTempoText is set', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'temporitex',
          kind: 'rit',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          endTempoText: 'a tempo',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^rit."')
    expect(abc).toContain('"^a tempo"')
  })

  it('combines endTempoText and endTempoBpm as "a tempo (♩=120)"', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'tempoboth1',
          kind: 'rit',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          endTempoText: 'a tempo',
          endTempoBpm: 120,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^a tempo (♩=120)"')
  })

  it('omits the end annotation when neither endTempoText nor endTempoBpm is set', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'temponoend',
          kind: 'accel',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // Only the start label, no end label
    expect(abc.match(/"\^/g)?.length).toBe(1)
    expect(abc).toContain('"^accel."')
  })

  it('span crosses a barline (start in m1, end in m2)', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'tempocross',
          kind: 'rit',
          startEventId: idA,
          endEventId: idF,
          staffIdx: 0,
          voiceIdx: 0,
          endTempoBpm: 60,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // start label sits on m1, end label on m2
    expect(abc).toContain('"^rit."C2')
    expect(abc).toContain('"^♩=60"A4')
  })

  it('two tempo spans whose endpoints share a note render in stable order (end-before-start at the boundary)', () => {
    // Span A ends at idC; span B starts at idC. Result: "^♩=120" then
    // "^accel." (end first per two-pass build).
    const sc1: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'tempofirst',
          kind: 'rit',
          startEventId: idA,
          endEventId: idC,
          staffIdx: 0,
          voiceIdx: 0,
          endTempoBpm: 120,
        },
        {
          id: 'tempocont1',
          kind: 'accel',
          startEventId: idC,
          endEventId: idE,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    // Reversed order — must produce the same ABC at the boundary.
    const sc2: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'tempocont2',
          kind: 'accel',
          startEventId: idC,
          endEventId: idE,
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'tempofrst2',
          kind: 'rit',
          startEventId: idA,
          endEventId: idC,
          staffIdx: 0,
          voiceIdx: 0,
          endTempoBpm: 120,
        },
      ],
    }
    const { abc: abc1 } = scoreToAbcWithMap(sc1)
    const { abc: abc2 } = scoreToAbcWithMap(sc2)
    // Both produce `"^♩=120""^accel."E2` at idC.
    expect(abc1).toContain('"^♩=120""^accel."E2')
    expect(abc2).toContain('"^♩=120""^accel."E2')
    // Boundary substring identical regardless of span array order.
    const boundary1 = abc1.match(/"\^♩=120""\^accel\."/)
    const boundary2 = abc2.match(/"\^♩=120""\^accel\."/)
    expect(boundary1).not.toBeNull()
    expect(boundary2).not.toBeNull()
  })

  it('round-trips through abcjs: emitted ABC parses without error', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'tempopars1',
          kind: 'accel',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          endTempoBpm: 144,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
    const tune = abcjs.parseOnly(abc)[0]
    // Verify the tune produced at least one element (sanity).
    expect(tune.lines.length).toBeGreaterThan(0)
  })

  it('span with unresolved endpoint id is silently skipped', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'tempomissg',
          kind: 'accel',
          startEventId: 'doesnotexist',
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // No accel label at all (silent skip).
    expect(abc).not.toContain('"^accel."')
  })

  it('coexists with annotations and hairpins on the same event without collision', () => {
    const sc: Score = {
      ...buildScore(),
      annotations: [
        {
          id: 'annotest01',
          target: { measureIdx: 0, eventIdx: 0, position: 'above' },
          text: 'cantabile',
          style: 'expression',
        },
      ],
      spans: [
        {
          id: 'tempocoex1',
          kind: 'accel',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'hairpncoex',
          kind: 'hairpin-cresc',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // All three render — order: score-level annotation, then tempo
    // span label, then technique annotation (empty), then hairpin
    // glyph.
    expect(abc).toContain('"^cantabile"')
    expect(abc).toContain('"^accel."')
    expect(abc).toContain('!<(!')
    // abcjs round-trip must not throw.
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
  })

  it('multiple tempo spans on the same voice accumulate labels at distinct events', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'tempoacc01',
          kind: 'accel',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'temporit02',
          kind: 'rit',
          startEventId: idC,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^accel."C2')
    expect(abc).toContain('"^rit."E2')
  })

  it('tempo span on secondStaff voice routes correctly (only on V:2, not V:1)', () => {
    const sc: Score = {
      ...buildScore(),
      secondStaff: {
        clef: 'bass',
        measures: [
          {
            events: [
              { id: 'evbass0001', pitches: [{ step: 'C', octave: 3 }], duration: 'half' },
              { id: 'evbass0002', pitches: [{ step: 'G', octave: 3 }], duration: 'half' },
            ],
          },
          {
            events: [
              { id: 'evbass0003', pitches: [{ step: 'C', octave: 3 }], duration: 'whole' },
            ],
          },
        ],
      },
      spans: [
        {
          id: 'tempobass1',
          kind: 'rit',
          startEventId: 'evbass0001',
          endEventId: 'evbass0003',
          staffIdx: 1,
          voiceIdx: 0,
          endTempoText: 'a tempo',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^rit."')
    expect(abc).toContain('"^a tempo"')
    // Tighter pin: the V:2 (secondStaff) section must contain the
    // labels; the V:1 primary section must NOT — otherwise the
    // routing leaked. The non-greedy `[^V]*?` keeps the match
    // within a single V: block.
    const v2Section = abc.match(/V:2[\s\S]*?(?=V:|$)/)?.[0] ?? ''
    expect(v2Section).toContain('"^rit."')
    expect(v2Section).toContain('"^a tempo"')
    const v1Section = abc.match(/V:1[\s\S]*?(?=V:|$)/)?.[0] ?? ''
    expect(v1Section).not.toContain('"^rit."')
    expect(v1Section).not.toContain('"^a tempo"')
  })

  it('tempo span coexists with M13 per-pitch ties on a chord (no parse interference)', () => {
    // M13-PR-1 wires per-pitch ties as `[C-EG]` inner-chord markers
    // and `[CEG]-` outer-chord markers. The tempo-span annotation
    // `"^accel."` sits in the decoration prefix BEFORE the chord
    // token, so the two should compose cleanly.
    const sc: Score = {
      ...buildScore(),
      measures: [
        {
          events: [
            {
              id: idA,
              pitches: [
                { step: 'C', octave: 4, tied_to_next: true },
                { step: 'E', octave: 4 },
                { step: 'G', octave: 4 },
              ],
              duration: 'half',
            },
            {
              id: idB,
              pitches: [
                { step: 'C', octave: 4 },
                { step: 'E', octave: 4 },
                { step: 'G', octave: 4 },
              ],
              duration: 'half',
            },
          ],
        },
      ],
      spans: [
        {
          id: 'tempotie01',
          kind: 'accel',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
          endTempoBpm: 144,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // The accel. label prepends the inner-tie chord token.
    expect(abc).toContain('"^accel."[C-EG]4')
    // The end label prepends the unmodified chord.
    expect(abc).toContain('"^♩=144"[CEG]4')
    // abcjs round-trip must not throw.
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
  })

  it('quote chars in endTempoText are escaped (defensive)', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'tempoesc01',
          kind: 'rit',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          endTempoText: 'a "tempo"',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // Literal quotes inside the abcjs annotation token are backslash-
    // escaped per escapeAnnotationText.
    expect(abc).toContain('a \\"tempo\\"')
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
  })
})

describe('scoreToAbcWithMap — tempo-span placement (M14-PR-2 follow-up)', () => {
  it("placement: 'above' emits ^ prefix on start label", () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'tempoplabv',
          kind: 'accel',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'above',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^accel."')
    expect(abc).not.toContain('"_accel."')
  })

  it("placement: 'below' emits _ prefix on start label", () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'tempoplblw',
          kind: 'accel',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'below',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"_accel."')
    expect(abc).not.toContain('"^accel."')
  })

  it("placement: 'default' falls back to ^ (tempo convention is above)", () => {
    // 'default' is a SCHEMA-level enum value meaning "let the engraver
    // decide" — for tempo spans the engraver decision is above.
    // Matches the M20-PR-2 octave-span pattern for the same trap (the
    // naive `?? defaultPos` fallback only catches undefined/null).
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'tempopldef',
          kind: 'rit',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'default',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^rit."')
    expect(abc).not.toContain('"_rit."')
  })

  it('placement undefined falls back to ^ (tempo convention is above)', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'tempoplund',
          kind: 'rit',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^rit."')
    expect(abc).not.toContain('"_rit."')
  })

  it("placement: 'below' applies to end terminal label as well as start", () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'tempoplbtb',
          kind: 'rit',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'below',
          endTempoBpm: 60,
          endTempoText: 'a tempo',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"_rit."')
    expect(abc).toContain('"_a tempo (♩=60)"')
    expect(abc).not.toContain('"^rit."')
    expect(abc).not.toContain('"^a tempo (♩=60)"')
  })

  it('abcjs round-trip — placement-below tempo span has no parser warnings', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'tempoplrtr',
          kind: 'accel',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'below',
          endTempoBpm: 144,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it('two tempo spans with opposite placements emit distinct prefixes', () => {
    // Confirms the per-span placement decision is honored
    // independently for each resolved entry (no cross-span leakage).
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'tempomx1ab',
          kind: 'accel',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'above',
        },
        {
          id: 'tempomx1bl',
          kind: 'rit',
          startEventId: idC,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'below',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^accel."')
    expect(abc).toContain('"_rit."')
  })

  it('shared-anchor event with opposite placements emits BOTH prefixes', () => {
    // One span ends at idC with 'above'; another starts at idC with
    // 'below'. The map entry for idC should contain both glyphs (the
    // ends-first / starts-second concatenation runs per-span, so
    // per-span positionChar is preserved independently).
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'temposhrab',
          kind: 'accel',
          startEventId: idA,
          endEventId: idC,
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'above',
          endTempoBpm: 120,
        },
        {
          id: 'temposhrbl',
          kind: 'rit',
          startEventId: idC,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'below',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // The end label of span1 sits above; the start label of span2
    // sits below — both attached to idC.
    expect(abc).toContain('"^♩=120"')
    expect(abc).toContain('"_rit."')
    // span1's own start label is above; sanity.
    expect(abc).toContain('"^accel."')
  })

  it("cross-staff tempo span on secondStaff honors placement: 'below'", () => {
    // The annotation map's per-staff/voice key routes the glyph to
    // the correct V: block in the multi-voice emission. placement
    // is orthogonal to staff routing — confirm with a 1-test pin.
    const sc: Score = {
      ...buildScore(),
      secondStaff: {
        clef: 'bass',
        measures: [
          {
            events: [
              { id: 'evtest2sa', pitches: [{ step: 'C', octave: 3 }], duration: 'whole' },
            ],
          },
          {
            events: [
              { id: 'evtest2sb', pitches: [{ step: 'G', octave: 2 }], duration: 'whole' },
            ],
          },
        ],
      },
      spans: [
        {
          id: 'tempocs2nd',
          kind: 'rit',
          startEventId: 'evtest2sa',
          endEventId: 'evtest2sb',
          staffIdx: 1,
          voiceIdx: 0,
          placement: 'below',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"_rit."')
    expect(abc).not.toContain('"^rit."')
  })
})
