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

describe('scoreToAbcWithMap — octave-span rendering (M20-PR-2)', () => {
  it('emits "^8va" annotation at the start event of an 8va span (default above placement)', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'octa00001',
          kind: '8va',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^8va"')
  })

  it('emits "_8vb" annotation by default (below) for 8vb span', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'octb00001',
          kind: '8vb',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"_8vb"')
  })

  it('emits "^15ma" annotation for 15ma span', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: '15m000001',
          kind: '15ma',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^15ma"')
  })

  it('emits "_15mb" annotation for 15mb span (default below)', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: '15mb00001',
          kind: '15mb',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"_15mb"')
  })

  it('honors explicit placement (override default)', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'octa00002',
          kind: '8va',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'below',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"_8va"')
    expect(abc).not.toContain('"^8va"')
  })

  it('abcjs round-trip — 8va span produces no parser warnings', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'octa00003',
          kind: '8va',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes.length).toBeGreaterThan(0)
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it('skips spans with unresolvable endpoint ids (data-integrity issue)', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'octa00004',
          kind: '8va',
          startEventId: 'doesnotexist',
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).not.toContain('"^8va"')
  })

  it('placement="default" on 8vb falls back to kind-based default (below)', () => {
    // Code-review MUST FIX: SpanSchema.placement is enum
    // 'above'|'below'|'default'. The 'default' string means
    // "let the engraver decide" — it must fall through to the
    // kind-based default, NOT be treated as "above". Pre-fix,
    // the ?? operator only caught undefined/null, so 'default'
    // silently routed 8vb's annotation UP instead of down.
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'octb00005',
          kind: '8vb',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'default',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"_8vb"')
    expect(abc).not.toContain('"^8vb"')
  })

  it('placement="default" on 15mb also routes below (kind-based default)', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: '15mb00005',
          kind: '15mb',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'default',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"_15mb"')
    expect(abc).not.toContain('"^15mb"')
  })

  it('placement="default" on 8va routes above (kind-based default)', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'octa00006',
          kind: '8va',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'default',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^8va"')
    expect(abc).not.toContain('"_8va"')
  })
})

describe('scoreToAbcWithMap — glissando rendering (M20-PR-2)', () => {
  it('emits "!glissando(!" / "!glissando)!" decorations at the endpoints', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'gliss00001',
          kind: 'glissando',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!glissando(!')
    expect(abc).toContain('!glissando)!')
  })

  it('emits "gliss." text annotation when glissText is true', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'gliss00002',
          kind: 'glissando',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
          glissText: true,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^gliss."')
    expect(abc).toContain('!glissando(!')
  })

  it('OMITS "gliss." text when glissText is false', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'gliss00003',
          kind: 'glissando',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
          glissText: false,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).not.toContain('"^gliss."')
    expect(abc).toContain('!glissando(!')
  })

  it('abcjs round-trip — glissando produces no parser warnings', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'gliss00004',
          kind: 'glissando',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes.length).toBeGreaterThan(0)
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it('two-pass build: closes-then-opens for stable order at shared boundaries', () => {
    // Two glissandos sharing one event as both end and start endpoint.
    // Without the closes-first ordering, abcjs would see "!gliss(!"
    // before "!gliss)!" at the boundary note and the parser would
    // complain. Pass-1-then-pass-2 ordering ensures `)` precedes `(`.
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'gliss00005',
          kind: 'glissando',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'gliss00006',
          kind: 'glissando',
          startEventId: idB,
          endEventId: idC,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!glissando(!')
    expect(abc).toContain('!glissando)!')
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})

describe('scoreToAbcWithMap — trill-line rendering (M20-PR-2)', () => {
  it('emits "!trill(!" / "!trill)!" decorations at the endpoints', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'trill00001',
          kind: 'trill-line',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!trill(!')
    expect(abc).toContain('!trill)!')
  })

  it('abcjs round-trip — trill line produces no parser warnings', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'trill00002',
          kind: 'trill-line',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes.length).toBeGreaterThan(0)
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it('cross-measure trill line spans correctly', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'trill00003',
          kind: 'trill-line',
          startEventId: idB,
          endEventId: idF,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!trill(!')
    expect(abc).toContain('!trill)!')
  })

  it('two-pass build: closes before opens at shared boundary (regression pin)', () => {
    // Same precaution as the glissando shared-boundary test —
    // mirrors the M14 tempo-span / M11 hairpin precedents. Two
    // trill lines whose start/end coincide on one event must
    // render with `!trill)!` BEFORE `!trill(!` on that note.
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'trill00004',
          kind: 'trill-line',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'trill00005',
          kind: 'trill-line',
          startEventId: idB,
          endEventId: idC,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!trill(!')
    expect(abc).toContain('!trill)!')
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})

describe('scoreToAbcWithMap — tremolo-between rendering (M20-PR-2)', () => {
  it('emits "^trem." annotation at the start event', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'trem000001',
          kind: 'tremolo-between',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^trem."')
  })

  it('abcjs round-trip — tremolo-between produces no parser warnings', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'trem000002',
          kind: 'tremolo-between',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes.length).toBeGreaterThan(0)
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it("tremolo-between placement: 'below' emits _ prefix (latent bug fix)", () => {
    // buildTremoloBetweenAnnotationMap previously always emitted
    // "^trem." regardless of span.placement. Same shape of bug as
    // M14-PR-2 tempo span (fixed in PR #193).
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'trem0plbl1',
          kind: 'tremolo-between',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'below',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"_trem."')
    expect(abc).not.toContain('"^trem."')
  })

  it("tremolo-between placement: 'default' falls back to ^ (convention is above)", () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'trem0pldef',
          kind: 'tremolo-between',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'default',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^trem."')
    expect(abc).not.toContain('"_trem."')
  })

  it("tremolo-between placement: 'above' emits ^ prefix", () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'trem0plabv',
          kind: 'tremolo-between',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'above',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^trem."')
    expect(abc).not.toContain('"_trem."')
  })

  it('abcjs round-trip — tremolo-between placement-below has no parser warnings', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'trem0plrtr',
          kind: 'tremolo-between',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'below',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})

describe('scoreToAbcWithMap — M20 secondStaff routing (M11/M12/M14 precedent)', () => {
  it('8va on secondStaff voice routes correctly (V:2 only, not V:1)', () => {
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
        ],
      },
      spans: [
        {
          id: 'octabass01',
          kind: '8va',
          startEventId: 'evbass0001',
          endEventId: 'evbass0002',
          staffIdx: 1,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^8va"')
    const v2Section = abc.match(/V:2[\s\S]*?(?=V:|$)/)?.[0] ?? ''
    expect(v2Section).toContain('"^8va"')
    const v1Section = abc.match(/V:1[\s\S]*?(?=V:|$)/)?.[0] ?? ''
    expect(v1Section).not.toContain('"^8va"')
  })

  it('glissando on secondStaff voice routes correctly (V:2 only)', () => {
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
        ],
      },
      spans: [
        {
          id: 'glissbass1',
          kind: 'glissando',
          startEventId: 'evbass0001',
          endEventId: 'evbass0002',
          staffIdx: 1,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!glissando(!')
    const v2Section = abc.match(/V:2[\s\S]*?(?=V:|$)/)?.[0] ?? ''
    expect(v2Section).toContain('!glissando(!')
    const v1Section = abc.match(/V:1[\s\S]*?(?=V:|$)/)?.[0] ?? ''
    expect(v1Section).not.toContain('!glissando(!')
  })

  it('trill-line on secondStaff voice routes correctly (V:2 only)', () => {
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
        ],
      },
      spans: [
        {
          id: 'trillbass1',
          kind: 'trill-line',
          startEventId: 'evbass0001',
          endEventId: 'evbass0002',
          staffIdx: 1,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!trill(!')
    const v2Section = abc.match(/V:2[\s\S]*?(?=V:|$)/)?.[0] ?? ''
    expect(v2Section).toContain('!trill(!')
    const v1Section = abc.match(/V:1[\s\S]*?(?=V:|$)/)?.[0] ?? ''
    expect(v1Section).not.toContain('!trill(!')
  })

  it('tremolo-between on secondStaff voice routes correctly (V:2 only)', () => {
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
        ],
      },
      spans: [
        {
          id: 'trembass01',
          kind: 'tremolo-between',
          startEventId: 'evbass0001',
          endEventId: 'evbass0002',
          staffIdx: 1,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^trem."')
    const v2Section = abc.match(/V:2[\s\S]*?(?=V:|$)/)?.[0] ?? ''
    expect(v2Section).toContain('"^trem."')
    const v1Section = abc.match(/V:1[\s\S]*?(?=V:|$)/)?.[0] ?? ''
    expect(v1Section).not.toContain('"^trem."')
  })

  it("tremolo-between on secondStaff with placement: 'below' routes _trem. to V:2", () => {
    // Pin that placement is orthogonal to staff routing for tremolo
    // — same shape of pin as the tempo-span cross-staff test added
    // in PR #193 follow-up.
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
        ],
      },
      spans: [
        {
          id: 'tremcsplbl',
          kind: 'tremolo-between',
          startEventId: 'evbass0001',
          endEventId: 'evbass0002',
          staffIdx: 1,
          voiceIdx: 0,
          placement: 'below',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"_trem."')
    const v2Section = abc.match(/V:2[\s\S]*?(?=V:|$)/)?.[0] ?? ''
    expect(v2Section).toContain('"_trem."')
    const v1Section = abc.match(/V:1[\s\S]*?(?=V:|$)/)?.[0] ?? ''
    expect(v1Section).not.toContain('"_trem."')
  })
})

describe('scoreToAbcWithMap — M20 spans coexistence (regression coverage)', () => {
  it('octave + glissando + trill + tremolo + hairpin all coexist on one score', () => {
    const sc: Score = {
      ...buildScore(),
      spans: [
        {
          id: 'octa00010',
          kind: '8va',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'gliss00010',
          kind: 'glissando',
          startEventId: idC,
          endEventId: idD,
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'trill00010',
          kind: 'trill-line',
          startEventId: idE,
          endEventId: idF,
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'trem000010',
          kind: 'tremolo-between',
          startEventId: idA,
          endEventId: idA,
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'hair000001',
          kind: 'hairpin-cresc',
          startEventId: idA,
          endEventId: idB,
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^8va"')
    expect(abc).toContain('!glissando(!')
    expect(abc).toContain('!trill(!')
    expect(abc).toContain('"^trem."')
    expect(abc).toContain('!<(!')
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})
