import { describe, it, expect } from 'vitest'
import { scoreToAbc } from '@/lib/music/scoreToAbc'
import type { Score } from '@/lib/music/types'
import { ValidationError } from '@/lib/music/errors'
import { PitchSchema } from '@/lib/music/types'

function score(partial: Partial<Score> & Pick<Score, 'measures'>): Score {
  return {
    key: 'C',
    meter: '4/4',
    ...partial,
  }
}

function quarter(step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B', octave = 4) {
  return { pitches: [{ step, octave }], duration: 'quarter' as const }
}

describe('scoreToAbc — headers', () => {
  it('emits X, T, M, L, K headers in order', () => {
    const abc = scoreToAbc(score({ title: 'Test', measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }] }))
    const lines = abc.split('\n')
    expect(lines[0]).toBe('X:1')
    expect(lines[1]).toBe('T:Test')
    expect(lines[2]).toBe('M:4/4')
    expect(lines[3]).toBe('L:1/8')
    // L: is followed by %%annotationfont (M3-PR-3) then K:.
    expect(lines).toContain('K:C')
    expect(lines.indexOf('K:C')).toBeGreaterThan(lines.indexOf('L:1/8'))
  })

  it('includes Q tempo when tempo_bpm provided', () => {
    const abc = scoreToAbc(score({ tempo_bpm: 120, measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }] }))
    expect(abc).toContain('Q:1/4=120')
  })

  it('defaults title to "Untitled"', () => {
    const abc = scoreToAbc(score({ measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }] }))
    expect(abc).toContain('T:Untitled')
  })

  it('uses the key signature header', () => {
    const abc = scoreToAbc(score({ key: 'Bb', measures: [{ events: [quarter('B', 4), quarter('D', 5), quarter('F', 5), quarter('B', 4)] }] }))
    expect(abc).toContain('K:Bb')
  })

  it('omits clef= when clef is treble (default)', () => {
    const abc = scoreToAbc(score({ measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }] }))
    expect(abc).toMatch(/^K:C$/m)
    expect(abc).not.toContain('clef=')
  })

  it('emits clef=bass on K: line when clef is bass', () => {
    const abc = scoreToAbc(
      score({ clef: 'bass', measures: [{ events: [quarter('C', 3), quarter('D', 3), quarter('E', 3), quarter('F', 3)] }] }),
    )
    expect(abc).toMatch(/^K:C clef=bass$/m)
  })
})

describe('scoreToAbc — octave mapping', () => {
  // Quarter notes emit a "2" duration suffix under L:1/8. Assertions
  // include the duration digit since it falls immediately after the
  // note letter and we want a stable contiguous substring to check.
  it('octave 4 → uppercase no mark', () => {
    expect(scoreToAbc(score({ measures: [{ events: [quarter('C', 4), quarter('D', 4), quarter('E', 4), quarter('F', 4)] }] })))
      .toContain('C2D2E2F2')
  })
  it('octave 5 → lowercase no mark', () => {
    expect(scoreToAbc(score({ measures: [{ events: [quarter('C', 5), quarter('D', 5), quarter('E', 5), quarter('F', 5)] }] })))
      .toContain('c2d2e2f2')
  })
  it("octave 6 → lowercase + '", () => {
    const abc = scoreToAbc(score({ measures: [{ events: [quarter('C', 6), quarter('D', 6), quarter('E', 6), quarter('F', 6)] }] }))
    expect(abc).toContain("c'2d'2e'2f'2")
  })
  it('octave 3 → uppercase + ,', () => {
    const abc = scoreToAbc(score({ measures: [{ events: [quarter('C', 3), quarter('D', 3), quarter('E', 3), quarter('F', 3)] }] }))
    expect(abc).toContain('C,2D,2E,2F,2')
  })
  it('octave 2 → uppercase + ,,', () => {
    const abc = scoreToAbc(score({ measures: [{ events: [quarter('C', 2), quarter('D', 2), quarter('E', 2), quarter('F', 2)] }] }))
    expect(abc).toContain('C,,2D,,2E,,2F,,2')
  })
  it('octave 1 → uppercase + ,,, (bass clef / funk-bass register)', () => {
    const abc = scoreToAbc(score({ measures: [{ events: [quarter('C', 1), quarter('D', 1), quarter('E', 1), quarter('F', 1)] }] }))
    expect(abc).toContain('C,,,2D,,,2E,,,2F,,,2')
  })
  it('octave 0 → uppercase + ,,,, (piano low-A0 register)', () => {
    const abc = scoreToAbc(score({ measures: [{ events: [quarter('C', 0), quarter('D', 0), quarter('E', 0), quarter('F', 0)] }] }))
    expect(abc).toContain('C,,,,2D,,,,2E,,,,2F,,,,2')
  })
  it("octave 7 → lowercase + ''", () => {
    const abc = scoreToAbc(score({ measures: [{ events: [quarter('C', 7), quarter('D', 7), quarter('E', 7), quarter('F', 7)] }] }))
    expect(abc).toContain("c''2d''2e''2f''2")
  })
  it("octave 9 → lowercase + '''' (top of range)", () => {
    const abc = scoreToAbc(score({ measures: [{ events: [quarter('C', 9), quarter('D', 9), quarter('E', 9), quarter('F', 9)] }] }))
    expect(abc).toContain("c''''2d''''2e''''2f''''2")
  })
})

describe('PitchSchema — octave range', () => {
  it('accepts the full [0,9] range (bass clef through piccolo)', () => {
    for (const octave of [0, 1, 2, 4, 6, 8, 9]) {
      expect(PitchSchema.safeParse({ step: 'C', octave }).success, `octave ${octave}`).toBe(true)
    }
  })
  it('rejects octaves outside [0,9]', () => {
    // Regression: a grand-staff funk-bass generation emitted octave-1
    // bass notes that the old min(2) floor rejected ("expected number to
    // be >=2"), dead-ending the whole score before a note was rendered.
    expect(PitchSchema.safeParse({ step: 'C', octave: -1 }).success).toBe(false)
    expect(PitchSchema.safeParse({ step: 'C', octave: 10 }).success).toBe(false)
  })
})

describe('scoreToAbc — durations (L:1/8)', () => {
  function one(duration: Score['measures'][number]['events'][number]['duration']) {
    return scoreToAbc(score({
      meter: '4/4',
      measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration }] }],
    }))
  }
  it('whole = 8', () => expect(one('whole')).toContain('C8'))
  it('dotted-half = 6', () => expect(one('dotted-half')).toContain('C6'))
  it('half = 4', () => expect(one('half')).toContain('C4'))
  it('dotted-quarter = 3', () => expect(one('dotted-quarter')).toContain('C3'))
  it('quarter = 2', () => expect(one('quarter')).toContain('C2'))
  it('dotted-eighth = 3/2', () => expect(one('dotted-eighth')).toContain('C3/2'))
  it('eighth = (empty)', () => expect(one('eighth')).toMatch(/\nC\|/))
  it('sixteenth = /2', () => expect(one('sixteenth')).toContain('C/2'))
  it('32nd = /4', () => expect(one('32nd')).toContain('C/4'))
})

describe('scoreToAbc — chords', () => {
  it('emits multi-pitch event in [ ] brackets', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [{ pitches: [
        { step: 'C', octave: 4 },
        { step: 'E', octave: 4 },
        { step: 'G', octave: 4 },
      ], duration: 'whole' }] }],
    }))
    expect(abc).toContain('[CEG]8')
  })

  it('supports mixed-octave chord', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [{ pitches: [
        { step: 'C', octave: 4 },
        { step: 'E', octave: 5 },
        { step: 'G', octave: 5 },
      ], duration: 'whole' }] }],
    }))
    expect(abc).toContain('[Ceg]8')
  })

  it('throws when a rest is inside a chord stack', () => {
    expect(() => scoreToAbc(score({
      measures: [{ events: [{ pitches: [
        { step: 'C', octave: 4 },
        { step: 'rest', octave: 4 },
      ], duration: 'whole' }] }],
    }))).toThrow(ValidationError)
  })
})

describe('scoreToAbc — rests', () => {
  it('emits z for a rest', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [
        quarter('C'), quarter('D'), { pitches: [{ step: 'rest', octave: 4 }], duration: 'quarter' }, quarter('F'),
      ] }],
    }))
    expect(abc).toContain('z2')
  })
})

describe('scoreToAbc — tuplets', () => {
  it('emits (3 prefix on a triplet group', () => {
    const abc = scoreToAbc(score({
      meter: '4/4',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 5 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'D', octave: 5 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'E', octave: 5 }], duration: 'eighth', tuplet: 3 },
        quarter('F'), quarter('G'), quarter('A'),
      ] }],
    }))
    expect(abc).toContain('(3cde')
  })

  it('emits (5 prefix on a quintuplet', () => {
    const abc = scoreToAbc(score({
      meter: '4/4',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'sixteenth', tuplet: 5 },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'sixteenth', tuplet: 5 },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'sixteenth', tuplet: 5 },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'sixteenth', tuplet: 5 },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'sixteenth', tuplet: 5 },
        quarter('C'), quarter('D'), quarter('E'), { pitches: [{ step: 'F', octave: 4 }], duration: 'eighth' }, { pitches: [{ step: 'G', octave: 4 }], duration: 'eighth' }, { pitches: [{ step: 'A', octave: 4 }], duration: 'eighth' },
      ] }],
    }))
    expect(abc).toContain('(5C/2D/2E/2F/2G/2')
  })

  it('throws on incomplete tuplet (cross-barline scenario)', () => {
    expect(() => scoreToAbc(score({
      meter: '4/4',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 5 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'D', octave: 5 }], duration: 'eighth', tuplet: 3 },
        quarter('F'), quarter('G'), quarter('A'),
      ] }],
    }))).toThrow(ValidationError)
  })
})

describe('scoreToAbc — accidentals', () => {
  function makeMeasure(accidental: 'sharp' | 'flat' | 'natural' | 'dblsharp' | 'dblflat') {
    return scoreToAbc(score({
      measures: [{ events: [
        { pitches: [{ step: 'F', octave: 4, accidental }], duration: 'whole' },
      ] }],
    }))
  }
  it('sharp → ^', () => expect(makeMeasure('sharp')).toContain('^F8'))
  it('flat → _', () => expect(makeMeasure('flat')).toContain('_F8'))
  it('natural → =', () => expect(makeMeasure('natural')).toContain('=F8'))
  it('dblsharp → ^^', () => expect(makeMeasure('dblsharp')).toContain('^^F8'))
  it('dblflat → __', () => expect(makeMeasure('dblflat')).toContain('__F8'))
})

describe('scoreToAbc — articulations / dynamics / ties', () => {
  it('staccato → leading dot', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', articulation: 'staccato' },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    expect(abc).toContain('.C2')
  })

  it('dynamic mf → !mf!', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', dynamic: 'mf' },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    expect(abc).toContain('!mf!C2')
  })

  it('tied_to_next appends -', () => {
    const abc = scoreToAbc(score({
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole', tied_to_next: true }] },
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
      ],
    }))
    expect(abc).toContain('C8-')
  })

  it('articulations[] (plural) takes precedence over the singular field', () => {
    // A stack of staccato + accent renders both glyphs in canonical
    // stacking order (staccato innermost, accent outermost). The
    // articulationsToAbc emit reads through getArticulations which
    // honors the array form over the singular when both are present.
    const abc = scoreToAbc(score({
      measures: [{ events: [
        {
          pitches: [{ step: 'C', octave: 4 }],
          duration: 'quarter',
          articulations: ['staccato', 'accent'],
        },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    expect(abc).toContain('.!accent!C2')
  })

  it('portato articulation emits the compound staccato+tenuto glyph pair', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', articulation: 'portato' },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    expect(abc).toContain('.!tenuto!C2')
  })

  it('dynamic_structured.base is surfaced when the singular dynamic is unset', () => {
    // dynamic_structured = {base: 'p', prefix: 'sub.', suffix: 'espressivo'}
    // is rendered as !p! (the base is what abcjs natively understands).
    // The compound text rendering — "sub. p espressivo" — is M2-PR-3+
    // work; for now we surface the base loudness so it appears in the
    // output rather than being silently dropped.
    const abc = scoreToAbc(score({
      measures: [{ events: [
        {
          pitches: [{ step: 'C', octave: 4 }],
          duration: 'quarter',
          dynamic_structured: { base: 'p', prefix: 'sub.', suffix: 'espressivo' },
        },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    expect(abc).toContain('!p!C2')
  })
})

describe('scoreToAbc — per-note markings (M2-PR-4)', () => {
  it('fermata renders as !fermata!', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', fermata: 'standard' },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    expect(abc).toContain('!fermata!C2')
  })

  it('all 5 fermata forms map to the same abcjs !fermata! glyph (M2-PR-4 defers form distinction)', () => {
    for (const form of ['very-short', 'short', 'standard', 'long', 'very-long'] as const) {
      const abc = scoreToAbc(score({
        measures: [{ events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', fermata: form },
          quarter('D'), quarter('E'), quarter('F'),
        ] }],
      }))
      expect(abc).toContain('!fermata!C2')
    }
  })

  it('barlineFermata renders before the closing barline (G.P. fermata)', () => {
    const abc = scoreToAbc(score({
      measures: [
        { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')], barlineFermata: 'long' },
        { events: [quarter('G'), quarter('A'), quarter('B'), quarter('C', 5)] },
      ],
    }))
    expect(abc).toContain('F2!fermata!|')
  })

  it('breath mark renders as !breath! prepended to the FOLLOWING note (abcjs decoration semantics)', () => {
    // In ABC, decorations are PREFIXES on the note that follows. To
    // paint a breath glyph in the gap between C and D, the !breath!
    // token attaches to D's prefix chain — placing it after C's
    // duration would parse it as a decoration on D anyway.
    const abc = scoreToAbc(score({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', breathMark: true },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    expect(abc).toContain('C2!breath!D2')
  })

  it('caesura renders as !mediumphrase! prepended to the FOLLOWING note', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', caesura: true },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    expect(abc).toContain('C2!mediumphrase!D2')
  })

  it('breath mark on the LAST event of a measure carries into the NEXT measure', () => {
    const abc = scoreToAbc(score({
      measures: [
        { events: [
          quarter('C'), quarter('D'), quarter('E'),
          { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter', breathMark: true },
        ] },
        { events: [quarter('G'), quarter('A'), quarter('B'), quarter('C', 5)] },
      ],
    }))
    expect(abc).toContain('F2|!breath!G2')
  })

  it('tremolo renders as a !//! prefix decoration (NOT bare slashes — abcjs would parse those as duration division)', () => {
    for (const slashes of [1, 2, 3, 4] as const) {
      const abc = scoreToAbc(score({
        measures: [{ events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', tremolo: { slashes } },
          quarter('D'), quarter('E'), quarter('F'),
        ] }],
      }))
      expect(abc).toContain(`!${'/'.repeat(slashes)}!C2`)
    }
  })

  it('tremolo with 5 slashes clamps to 4 (abcjs cap)', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', tremolo: { slashes: 5 } },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    expect(abc).toContain('!////!C2')
  })

  it('tremolo no longer corrupts the duration (regression test for bare-slash-suffix bug)', async () => {
    // Parse with abcjs and verify the note's duration is the quarter
    // it was authored as, not a 64th (which is what `C2//` would parse
    // to via the duration-fraction-division path).
    const abc = scoreToAbc(score({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', tremolo: { slashes: 2 } },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    const mod = await import('abcjs')
    const abcjs = (mod as unknown as { default?: typeof mod }).default ?? mod
    const tunes = abcjs.parseOnly(abc) as Array<{
      lines: Array<{ staff: Array<{ voices: Array<Array<{ duration?: number; decoration?: string[] }>> }> }>
    }>
    const voice0 = tunes[0].lines[0].staff[0].voices[0]
    const cNote = voice0.find((el) => el.duration !== undefined && el.decoration?.includes('//'))
    expect(cNote).toBeDefined()
    // 1/4 = 0.25 (abcjs uses normalized durations where 1 = whole note).
    expect(cNote!.duration).toBeCloseTo(0.25, 3)
  })

  it('bowing up renders as !upbow! and down as !downbow!', () => {
    const up = scoreToAbc(score({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', bowing: 'up' },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    expect(up).toContain('!upbow!C2')

    const down = scoreToAbc(score({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', bowing: 'down' },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    expect(down).toContain('!downbow!C2')
  })

  it('Baroque ornaments render to their abcjs equivalents', () => {
    const cases: Array<[NonNullable<Parameters<typeof scoreToAbc>[0]['measures'][0]['events'][0]['ornament']>, string]> = [
      ['pralltriller', '!pralltriller!'],
      ['upper-mordent', '!uppermordent!'],
      ['lower-mordent', '!lowermordent!'],
      ['inverted-turn', '!invertedturn!'],
      ['slide', '!slide!'],
      ['arpeggio-up', '!arpeggio!'],
      ['arpeggio-down', '!arpeggio!'],
    ]
    for (const [orn, glyph] of cases) {
      const abc = scoreToAbc(score({
        measures: [{ events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', ornament: orn },
          quarter('D'), quarter('E'), quarter('F'),
        ] }],
      }))
      expect(abc).toContain(`${glyph}C2`)
    }
  })

  it('schneller maps to !pralltriller! (same glyph family, naming varies)', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', ornament: 'schneller' },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    expect(abc).toContain('!pralltriller!C2')
  })

  it('delayed-turn maps to !turn! (delay positioning deferred to a later PR)', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', ornament: 'delayed-turn' },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    expect(abc).toContain('!turn!C2')
  })

  it('non-arpeggio renders as no glyph (abcjs has no "do-not-roll" bracket — tracked for follow-up)', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', ornament: 'non-arpeggio' },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    // The note itself still renders; just no arpeggio bracket.
    expect(abc).toContain('C2')
    expect(abc).not.toContain('!arpeggio!')
  })

  it('combined markings on one event compose in stable prefix order', () => {
    // Prefix order: inherited (none here) → tremolo → dynamic → fermata
    // → ornament → bowing → articulations. Tremolo is a prefix
    // decoration (not a suffix) so it doesn't corrupt the duration.
    // breath/caesura land on the NEXT note's prefix per ABC semantics.
    const abc = scoreToAbc(score({
      measures: [{ events: [
        {
          pitches: [{ step: 'C', octave: 4 }],
          duration: 'quarter',
          dynamic: 'mf',
          fermata: 'standard',
          ornament: 'trill',
          bowing: 'down',
          articulation: 'staccato',
          tremolo: { slashes: 2 },
          breathMark: true,
        },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    // C event: every prefix decoration in canonical order, no breath here.
    expect(abc).toContain('!//!!mf!!fermata!T!downbow!.C2')
    // breath carried forward onto D's prefix chain.
    expect(abc).toContain('C2!breath!D2')
  })

  it('barlineFermata is suppressed when the closing event already carries event.fermata (no duplicate glyph)', () => {
    // The two fermatas would otherwise stack — one over the note, one
    // over the bar — which is visually ambiguous. The data still
    // round-trips through the score JSON; the renderer just paints once.
    const abc = scoreToAbc(score({
      measures: [
        {
          events: [
            quarter('C'), quarter('D'), quarter('E'),
            { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter', fermata: 'standard' },
          ],
          barlineFermata: 'long',
        },
        { events: [quarter('G'), quarter('A'), quarter('B'), quarter('C', 5)] },
      ],
    }))
    // Closing F has its !fermata!, but the bar does NOT — only ONE
    // !fermata! occurrence between F and the | (the one on F).
    const segment = abc.split('|')[0]
    // Count `!fermata!` occurrences in the segment ending at F.
    const matches = segment.match(/!fermata!/g) ?? []
    expect(matches.length).toBe(1)
    // Bar directly follows F's duration, no extra !fermata!.
    expect(abc).toContain('!fermata!F2|')
  })

  it('barlineFermata still renders when the closing event has no fermata', () => {
    const abc = scoreToAbc(score({
      measures: [
        { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')], barlineFermata: 'long' },
        { events: [quarter('G'), quarter('A'), quarter('B'), quarter('C', 5)] },
      ],
    }))
    expect(abc).toContain('F2!fermata!|')
  })

  it('output with the new decorations still parses cleanly with abcjs.parseOnly', async () => {
    const abc = scoreToAbc(score({
      title: 'Markings round-trip',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', bowing: 'up' },
            { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter', fermata: 'standard' },
            { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter', ornament: 'pralltriller' },
            { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter', tremolo: { slashes: 2 } },
          ],
          barlineFermata: 'long',
        },
        {
          events: [
            { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter', breathMark: true },
            { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter', caesura: true },
            { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter', ornament: 'upper-mordent' },
            { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter', bowing: 'down' },
          ],
        },
      ],
    }))
    const mod = await import('abcjs')
    const abcjs = (mod as unknown as { default?: typeof mod }).default ?? mod
    const tunes = abcjs.parseOnly(abc) as Array<{ warnings?: string[] | null }>
    expect(tunes).toBeDefined()
    expect(tunes[0]).toBeDefined()
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})

describe('scoreToAbc — structured grace notes (M7-PR-4)', () => {
  it('single before-grace renders as {pitch} immediately before the principal', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [
        {
          pitches: [{ step: 'C', octave: 5 }],
          duration: 'quarter',
          graceNotes: [{ pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' }],
        },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    // Grace {d} sits immediately before the principal note c.
    expect(abc).toContain('{d}c')
  })

  it('slashed=true renders as {/...} (acciaccatura)', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [
        {
          pitches: [{ step: 'C', octave: 5 }],
          duration: 'quarter',
          graceNotes: [{ pitches: [{ step: 'D', octave: 5 }], duration: 'eighth', slashed: true }],
        },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    expect(abc).toContain('{/d}c')
  })

  it('beamed grace run renders as {pq r} with each moment concatenated', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [
        {
          pitches: [{ step: 'D', octave: 5 }],
          duration: 'quarter',
          graceNotes: [
            { pitches: [{ step: 'A', octave: 4 }], duration: 'sixteenth' },
            { pitches: [{ step: 'B', octave: 4 }], duration: 'sixteenth' },
            { pitches: [{ step: 'C', octave: 5 }], duration: 'sixteenth' },
          ],
        },
        quarter('E'), quarter('F'), quarter('G'),
      ] }],
    }))
    // All three grace notes (with /2 sixteenth divisor) sit in one block before the principal d.
    expect(abc).toContain('{A/B/c/}d')
  })

  it('grace chord renders as {[ace]} (multiple noteheads at one moment)', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [
        {
          pitches: [{ step: 'D', octave: 5 }],
          duration: 'quarter',
          graceNotes: [{
            pitches: [
              { step: 'A', octave: 4 },
              { step: 'C', octave: 5 },
              { step: 'E', octave: 5 },
            ],
            duration: 'eighth',
          }],
        },
        quarter('E'), quarter('F'), quarter('G'),
      ] }],
    }))
    expect(abc).toContain('{[Ace]}d')
  })

  it('32nd grace renders with the /4 duration divisor', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [
        {
          pitches: [{ step: 'C', octave: 5 }],
          duration: 'quarter',
          graceNotes: [{ pitches: [{ step: 'D', octave: 5 }], duration: '32nd' }],
        },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    expect(abc).toContain('{d/4}c')
  })

  it('mixed slashed within a run honors only the LEADING grace (ABC limitation)', () => {
    // abcjs's grace-block parser (letter_to_grace in
    // abc_parse_music.js) accepts the slash marker IMMEDIATELY after
    // `{` and applies `.acciaccatura:true` to the leading grace only.
    // Later `/` characters inside the block are consumed as duration
    // divisors for the prior note, not as leading-slash markers for
    // the next. Verified against abcjs source; mixed slashed within
    // one beamed run is silently lossy.
    const leadingSlashed = scoreToAbc(score({
      measures: [{ events: [
        {
          pitches: [{ step: 'D', octave: 5 }],
          duration: 'quarter',
          graceNotes: [
            { pitches: [{ step: 'A', octave: 4 }], duration: 'sixteenth', slashed: true },
            { pitches: [{ step: 'B', octave: 4 }], duration: 'sixteenth' },
          ],
        },
        quarter('E'), quarter('F'), quarter('G'),
      ] }],
    }))
    expect(leadingSlashed).toContain('{/A/B/}d')

    // Conversely: leading grace unslashed → no `/` after `{`, even if
    // a trailing grace says slashed:true. Documents the silent loss.
    const trailingSlashed = scoreToAbc(score({
      measures: [{ events: [
        {
          pitches: [{ step: 'D', octave: 5 }],
          duration: 'quarter',
          graceNotes: [
            { pitches: [{ step: 'A', octave: 4 }], duration: 'sixteenth' },
            { pitches: [{ step: 'B', octave: 4 }], duration: 'sixteenth', slashed: true },
          ],
        },
        quarter('E'), quarter('F'), quarter('G'),
      ] }],
    }))
    expect(trailingSlashed).toContain('{A/B/}d')
    expect(trailingSlashed).not.toContain('{/')
  })

  it('structured graceNotes SUPPRESSES the legacy ornament:"grace" default', () => {
    // Without the suppression, both renderers would fire and the
    // event would emit `{c}{d}d` — two stacked grace groups.
    const abc = scoreToAbc(score({
      measures: [{ events: [
        {
          pitches: [{ step: 'D', octave: 5 }],
          duration: 'quarter',
          ornament: 'grace',
          graceNotes: [{ pitches: [{ step: 'E', octave: 5 }], duration: 'eighth' }],
        },
        quarter('E'), quarter('F'), quarter('G'),
      ] }],
    }))
    // The structured form wins — only ONE grace group, with the
    // structured grace pitch (e), not the legacy default (c).
    expect(abc).toContain('{e}d')
    expect(abc).not.toContain('{c}')
  })

  it('legacy ornament:"grace" still renders {c} when graceNotes is empty/absent', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [
        {
          pitches: [{ step: 'D', octave: 5 }],
          duration: 'quarter',
          ornament: 'grace',
        },
        quarter('E'), quarter('F'), quarter('G'),
      ] }],
    }))
    expect(abc).toContain('{c}d')
  })

  it('empty graceNotes array emits nothing AND does not suppress the legacy default', () => {
    // Symmetry with setGraceNotes(empty) clearing back to legacy
    // fallback — caller's contract documented in the schema docstring.
    const abc = scoreToAbc(score({
      measures: [{ events: [
        {
          pitches: [{ step: 'D', octave: 5 }],
          duration: 'quarter',
          ornament: 'grace',
          graceNotes: [],
        },
        quarter('E'), quarter('F'), quarter('G'),
      ] }],
    }))
    expect(abc).toContain('{c}d')
  })

  it('abcjs round-trip — structured grace notes parse without warnings AND surface in the AST', async () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [
        {
          pitches: [{ step: 'C', octave: 5 }],
          duration: 'quarter',
          graceNotes: [
            { pitches: [{ step: 'A', octave: 4 }], duration: 'sixteenth', slashed: true },
            { pitches: [{ step: 'B', octave: 4 }], duration: 'sixteenth' },
          ],
        },
        quarter('D'), quarter('E'), quarter('F'),
      ] }],
    }))
    const mod = await import('abcjs')
    const abcjs = (mod as unknown as { default?: typeof mod }).default ?? mod
    type AbcGrace = { name?: string; acciaccatura?: boolean }
    type AbcNote = { gracenotes?: AbcGrace[]; el_type?: string }
    type AbcStaff = { voices: AbcNote[][] }
    type AbcLine = { staff?: AbcStaff[] }
    const tunes = abcjs.parseOnly(abc) as Array<{
      warnings?: string[] | null
      lines?: AbcLine[]
    }>
    expect(tunes[0]).toBeDefined()
    expect(tunes[0].warnings ?? []).toEqual([])
    // Walk to the principal note's AST entry and verify gracenotes
    // attached + the leading one carries acciaccatura. Anchors the
    // M7-PR-4 contract against silent-drop regressions (a future
    // refactor that emits `c{c}` style — where the grace lands AFTER
    // the note — would still parse warning-free but lose the
    // before-grace semantic).
    const voice = tunes[0].lines?.[0]?.staff?.[0]?.voices?.[0]
    const noteEntry = voice?.find((e) => e.gracenotes !== undefined)
    expect(noteEntry).toBeDefined()
    expect(noteEntry!.gracenotes!.length).toBe(2)
    expect(noteEntry!.gracenotes![0].acciaccatura).toBe(true)
  })
})

describe('scoreToAbc — barlines and layout', () => {
  it('joins measures with |', () => {
    const abc = scoreToAbc(score({
      measures: [
        { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] },
        { events: [quarter('G'), quarter('A'), quarter('B', 4), quarter('C', 5)] },
      ],
    }))
    const body = abc.split('K:C\n')[1]
    expect(body).toContain('|')
    expect(body.split('|').filter(Boolean).length).toBe(2)
  })

  it('inserts a newline every 4 measures', () => {
    const m = { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }
    const abc = scoreToAbc(score({ measures: [m, m, m, m, m] }))
    const body = abc.split('K:C\n')[1]
    expect(body).toContain('|\n')
  })
})

describe('scoreToAbc — performance technique state (M3-PR-3)', () => {
  it('emits a "^pizz." annotation prefix on the first event of the targeted measure', () => {
    const sc = score({
      clef: 'bass',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
      ],
      techniqueStates: [
        { id: 'tech-1abcdef', measureIdx: 1, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
      ],
    })
    const abc = scoreToAbc(sc)
    expect(abc).toContain('"^pizz."')
    // The annotation must appear in the measure-1 region, AFTER the
    // first measure's pitch. Body looks like: C,,8|"^pizz."C,,8|
    const body = abc.split(/K:[A-G][#b]?\b[^\n]*\n/)[1]
    const measures = body.split('|').filter(Boolean)
    expect(measures.length).toBeGreaterThanOrEqual(2)
    expect(measures[0]).not.toContain('"^pizz."')
    expect(measures[1]).toContain('"^pizz."')
  })

  it('omitted eventIdx targets the first event in the measure', () => {
    const sc = score({
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
        { id: 'tech-2abcdef', measureIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'arco' },
      ],
    })
    const abc = scoreToAbc(sc)
    const body = abc.split(/K:[A-G][#b]?\b[^\n]*\n/)[1]
    // The annotation must come BEFORE the first note C
    const idx = body.indexOf('"^arco"')
    const cIdx = body.indexOf('C,')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(idx).toBeLessThan(cIdx)
  })

  it('eventIdx in the middle of the measure annotates the right event', () => {
    const sc = score({
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
        { id: 'tech-3abcdef', measureIdx: 0, eventIdx: 2, staffIdx: 0, voiceIdx: 0, kind: 'sul-ponticello' },
      ],
    })
    const abc = scoreToAbc(sc)
    expect(abc).toContain('"^sul pont."')
    // The annotation must come BEFORE the third note (E,) and AFTER the
    // second note (D,). Body's measure 0 is C,2D,2"^sul pont."E,2F,2.
    const body = abc.split(/K:[A-G][#b]?\b[^\n]*\n/)[1]
    const sulPontIdx = body.indexOf('"^sul pont."')
    const eIdx = body.indexOf('E,', sulPontIdx)
    expect(eIdx).toBeGreaterThan(sulPontIdx)
  })

  it('emits the conventional notation labels for every TechniqueKind', () => {
    const kinds: Array<['pizz' | 'arco' | 'col-legno-battuto' | 'col-legno-tratto' | 'sul-ponticello' | 'sul-tasto' | 'flautando' | 'ord' | 'snap-pizz' | 'LH-pizz' | 'tremolo' | 'mute-on' | 'mute-off', string]> = [
      ['pizz', '"^pizz."'],
      ['arco', '"^arco"'],
      ['col-legno-battuto', '"^col legno batt."'],
      ['col-legno-tratto', '"^col legno tr."'],
      ['sul-ponticello', '"^sul pont."'],
      ['sul-tasto', '"^sul tasto"'],
      ['flautando', '"^flaut."'],
      ['ord', '"^ord."'],
      ['snap-pizz', '"^snap pizz."'],
      ['LH-pizz', '"^L.H. pizz."'],
      ['tremolo', '"^trem."'],
      ['mute-on', '"^con sord."'],
      ['mute-off', '"^senza sord."'],
    ]
    for (const [kind, label] of kinds) {
      const sc = score({
        clef: 'bass',
        measures: [{ events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] }],
        techniqueStates: [
          { id: 'tech-x' + kind.slice(0, 4), measureIdx: 0, staffIdx: 0, voiceIdx: 0, kind },
        ],
      })
      const abc = scoreToAbc(sc)
      expect(abc, `${kind} should render as ${label}`).toContain(label)
    }
  })

  it('multiple techniques at the same event concatenate in input order', () => {
    // Edge case: a kind transition placed on the same event as a cancel
    // ("mute-off" + "pizz" right before a phrase). The renderer keeps
    // them in score-state order; the reader is responsible for ordering.
    const sc = score({
      clef: 'bass',
      measures: [{ events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] }],
      techniqueStates: [
        { id: 'tech-conc1', measureIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'mute-off' },
        { id: 'tech-conc2', measureIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
      ],
    })
    const abc = scoreToAbc(sc)
    expect(abc).toContain('"^senza sord.""^pizz."')
  })

  it('a score without techniqueStates has zero annotations', () => {
    const sc = score({
      measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
    })
    const abc = scoreToAbc(sc)
    expect(abc).not.toContain('"^')
  })

  it('grand-staff scores route techniqueStates to the correct staff/voice', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
        ],
      },
      techniqueStates: [
        { id: 'tech-bass-1', measureIdx: 0, staffIdx: 1, voiceIdx: 0, kind: 'pizz' },
      ],
    }
    const abc = scoreToAbc(sc)
    // The pizz must attach in the V:2 (second staff) block, not V:1.
    const v2Index = abc.indexOf('V:2')
    const pizzIndex = abc.indexOf('"^pizz."')
    expect(v2Index).toBeGreaterThan(0)
    expect(pizzIndex).toBeGreaterThan(v2Index)
  })

  it('SATB-style extraVoices route techniqueStates to the right voice block', () => {
    // Staff 0 voice 0 = Soprano, staff 0 voice 1 = Alto. A pizz on the
    // Alto must land in V:2 (Alto's abcjs voice id), not V:1 (Soprano).
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [quarter('G', 4), quarter('G', 4), quarter('G', 4), quarter('G', 4)] }],
      extraVoices: [
        { measures: [{ events: [quarter('E', 4), quarter('E', 4), quarter('E', 4), quarter('E', 4)] }] },
      ],
      techniqueStates: [
        { id: 'tech-alto-1', measureIdx: 0, staffIdx: 0, voiceIdx: 1, kind: 'pizz' },
      ],
    }
    const abc = scoreToAbc(sc)
    // Voice ids run sequentially across staves; the Alto is the second
    // voice on staff 0, so abcId = 2.
    const v1Index = abc.indexOf('V:1')
    const v2Index = abc.indexOf('V:2')
    const pizzIndex = abc.indexOf('"^pizz."')
    expect(v2Index).toBeGreaterThan(v1Index)
    expect(pizzIndex).toBeGreaterThan(v2Index)
  })

  it('emits %%annotationfont so technique markers render italic', () => {
    const sc = score({
      measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
    })
    const abc = scoreToAbc(sc)
    // Unconditional: the directive ships even without techniqueStates
    // so future expressive-text annotations inherit the same styling.
    expect(abc).toContain('%%annotationfont Helvetica 12 italic')
  })

  it('the output with technique annotations parses cleanly through abcjs', async () => {
    const sc = score({
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
        {
          events: [
            { pitches: [{ step: 'G', octave: 3 }], duration: 'quarter' },
            { pitches: [{ step: 'A', octave: 3 }], duration: 'quarter' },
            { pitches: [{ step: 'B', octave: 3 }], duration: 'quarter' },
            { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
          ],
        },
      ],
      techniqueStates: [
        { id: 'tech-rt-1', measureIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
        { id: 'tech-rt-2', measureIdx: 1, staffIdx: 0, voiceIdx: 0, kind: 'arco' },
      ],
    })
    const abc = scoreToAbc(sc)
    const mod = await import('abcjs')
    const abcjs = (mod as unknown as { default?: typeof mod }).default ?? mod
    const parsed = abcjs.parseOnly(abc)
    expect(parsed.length).toBeGreaterThan(0)
    expect(parsed[0].warnings ?? []).toEqual([])
  })
})

describe('scoreToAbc — fingerings (M5-PR-2)', () => {
  it('emits a !N! decoration for a piano fingering on a monophonic note', () => {
    const sc = score({
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', fingerings: [{ system: 'piano', value: '3' }] },
            quarter('D'),
            quarter('E'),
            quarter('F'),
          ],
        },
      ],
    })
    const abc = scoreToAbc(sc)
    expect(abc).toContain('!3!')
    // The decoration must come BEFORE the C notehead.
    const body = abc.split(/K:[A-G][#b]?\b[^\n]*\n/)[1]
    const decIdx = body.indexOf('!3!')
    const cIdx = body.indexOf('C', decIdx)
    expect(decIdx).toBeGreaterThanOrEqual(0)
    expect(cIdx).toBeGreaterThan(decIdx)
  })

  it('stacks all decorations for a chord with full fingerings', () => {
    const sc = score({
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
              fingerings: [
                { system: 'piano', value: '1' },
                { system: 'piano', value: '3' },
                { system: 'piano', value: '5' },
              ],
            },
          ],
        },
      ],
    })
    const abc = scoreToAbc(sc)
    // The three digit decorations concatenate in order before the chord
    // brackets. abcjs paints them vertically stacked above the chord.
    expect(abc).toContain('!1!!3!!5!')
    const body = abc.split(/K:[A-G][#b]?\b[^\n]*\n/)[1]
    const decIdx = body.indexOf('!1!!3!!5!')
    const chordIdx = body.indexOf('[')
    expect(decIdx).toBeGreaterThanOrEqual(0)
    expect(chordIdx).toBeGreaterThan(decIdx)
  })

  it('skips null entries silently (interior gaps in a chord)', () => {
    // Only the top pitch (index 2) is fingered. The first two entries
    // are null; the renderer emits nothing for them. So the output is
    // the same as a single trailing fingering — `!5!` before the chord.
    const sc = score({
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
              fingerings: [null, null, { system: 'piano', value: '5' }],
            },
          ],
        },
      ],
    })
    const abc = scoreToAbc(sc)
    expect(abc).toContain('!5!')
    expect(abc).not.toContain('!1!')
    expect(abc).not.toContain('!3!')
  })

  it('renders a string fingering with Roman numeral indicator', () => {
    const sc = score({
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'whole',
              fingerings: [{ system: 'string', finger: 3, stringRoman: 'III' }],
            },
          ],
        },
      ],
    })
    const abc = scoreToAbc(sc)
    expect(abc).toContain('!3!')
    expect(abc).toContain('"^III"')
  })

  it('renders a string fingering without Roman when stringRoman is omitted', () => {
    const sc = score({
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'whole',
              fingerings: [{ system: 'string', finger: 2 }],
            },
          ],
        },
      ],
    })
    const abc = scoreToAbc(sc)
    expect(abc).toContain('!2!')
    // No spurious Roman annotation when stringRoman is omitted.
    expect(abc).not.toMatch(/"\^I+"/)
  })

  it('renders guitar-rh Spanish letters as above-staff italic annotations', () => {
    const letters: Array<'p' | 'i' | 'm' | 'a' | 'c'> = ['p', 'i', 'm', 'a', 'c']
    for (const letter of letters) {
      const sc = score({
        measures: [
          {
            events: [
              {
                pitches: [{ step: 'C', octave: 4 }],
                duration: 'whole',
                fingerings: [{ system: 'guitar-rh', value: letter }],
              },
            ],
          },
        ],
      })
      const abc = scoreToAbc(sc)
      expect(abc, `guitar-rh ${letter} should render as "^${letter}"`).toContain(`"^${letter}"`)
    }
  })

  it('renders guitar-lh with stringNum + fret annotations alongside the digit', () => {
    const sc = score({
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'whole',
              fingerings: [{ system: 'guitar-lh', value: 3, stringNum: 6, fret: 'V' }],
            },
          ],
        },
      ],
    })
    const abc = scoreToAbc(sc)
    expect(abc).toContain('!3!')
    expect(abc).toContain('"^(6)"')
    expect(abc).toContain('"^V"')
  })

  it('renders an organ fingering with heel glyph and thumb direction', () => {
    const sc = score({
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'whole',
              fingerings: [
                { system: 'organ', value: '1', foot: 'heel', thumbDirection: '(' },
              ],
            },
          ],
        },
      ],
    })
    const abc = scoreToAbc(sc)
    expect(abc).toContain('!1!')
    expect(abc).toContain('"^∪"')
    expect(abc).toContain('"^("')
  })

  it('renders organ toe glyph distinctly from heel', () => {
    const sc = score({
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'whole',
              fingerings: [{ system: 'organ', value: '2', foot: 'toe' }],
            },
          ],
        },
      ],
    })
    const abc = scoreToAbc(sc)
    expect(abc).toContain('"^∧"')
    expect(abc).not.toContain('"^∪"')
  })

  it('emits piano substitution string as an annotation alongside the digit', () => {
    const sc = score({
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'whole',
              fingerings: [{ system: 'piano', value: '3', substitution: '3-2' }],
            },
          ],
        },
      ],
    })
    const abc = scoreToAbc(sc)
    expect(abc).toContain('!3!')
    expect(abc).toContain('"^3-2"')
  })

  it('a score without fingerings emits zero fingering decorations', () => {
    const sc = score({
      measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
    })
    const abc = scoreToAbc(sc)
    // Only the body matters; the headers don't carry decorations.
    const body = abc.split(/K:[A-G][#b]?\b[^\n]*\n/)[1]
    expect(body).not.toMatch(/![0-5]!/)
  })

  it('preserves the source map: clicking a chord pitch still resolves to its pitchIdx', async () => {
    const { scoreToAbcWithMap, resolveClickPosition } = await import('@/lib/music/scoreToAbcWithMap')
    const sc = score({
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
              fingerings: [
                { system: 'piano', value: '1' },
                { system: 'piano', value: '3' },
                { system: 'piano', value: '5' },
              ],
            },
          ],
        },
      ],
    })
    const { abc, map } = scoreToAbcWithMap(sc)
    // Find the chord brackets in the body; the inner pitches live there.
    const ePos = abc.indexOf('E')
    expect(ePos).toBeGreaterThan(0)
    const sel = resolveClickPosition(map, ePos)
    expect(sel).toBeDefined()
    expect(sel!.measureIdx).toBe(0)
    expect(sel!.eventIdx).toBe(0)
    expect(sel!.pitchIdx).toBe(1)
  })

  it('grand-staff scores route fingerings to the correct staff', () => {
    // Right hand on staff 0 (treble) — fingering 1. Left hand on staff
    // 1 (bass) — fingering 5. Both decorations must appear in their
    // respective voice blocks, not crossed.
    const sc = score({
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C', octave: 5 }],
              duration: 'whole',
              fingerings: [{ system: 'piano', value: '1' }],
            },
          ],
        },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          {
            events: [
              {
                pitches: [{ step: 'C', octave: 3 }],
                duration: 'whole',
                fingerings: [{ system: 'piano', value: '5' }],
              },
            ],
          },
        ],
      },
    })
    const abc = scoreToAbc(sc)
    // Multi-voice output uses V:1 / V:2 blocks; each fingering belongs
    // in its own block. The treble block has !1!c (octave 5 = lowercase
    // c); the bass block has !5!C,, (octave 3 = `C,`).
    const v1Match = abc.match(/V:1[^\n]*\n([^V]*?)(?:V:|\Z)/)
    const v2Match = abc.match(/V:2[^\n]*\n([^V]*?)$/)
    expect(v1Match).not.toBeNull()
    expect(v2Match).not.toBeNull()
    const v1 = v1Match![1]
    const v2 = v2Match![1]
    expect(v1).toContain('!1!')
    expect(v1).not.toContain('!5!')
    expect(v2).toContain('!5!')
    expect(v2).not.toContain('!1!')
  })

  it('SATB-style extraVoices route fingerings to the right voice block', () => {
    // Soprano (voice 0) carries a string fingering "1.I"; Alto (voice 1)
    // carries "3.II". The two annotations must appear in their own
    // voice blocks.
    const sc = score({
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C', octave: 5 }],
              duration: 'whole',
              fingerings: [{ system: 'string', finger: 1, stringRoman: 'I' }],
            },
          ],
        },
      ],
      extraVoices: [
        {
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'E', octave: 4 }],
                  duration: 'whole',
                  fingerings: [{ system: 'string', finger: 3, stringRoman: 'II' }],
                },
              ],
            },
          ],
        },
      ],
    })
    const abc = scoreToAbc(sc)
    const v1Match = abc.match(/V:1[^\n]*\n([^V]*?)(?:V:|\Z)/)
    const v2Match = abc.match(/V:2[^\n]*\n([^V]*?)$/)
    expect(v1Match).not.toBeNull()
    expect(v2Match).not.toBeNull()
    const v1 = v1Match![1]
    const v2 = v2Match![1]
    expect(v1).toContain('!1!')
    expect(v1).toContain('"^I"')
    expect(v2).toContain('!3!')
    expect(v2).toContain('"^II"')
  })

  it('the output with fingerings parses cleanly through abcjs', async () => {
    const sc = score({
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
              fingerings: [
                { system: 'piano', value: '1' },
                { system: 'piano', value: '3' },
                { system: 'piano', value: '5' },
              ],
            },
          ],
        },
      ],
    })
    const abc = scoreToAbc(sc)
    const mod = await import('abcjs')
    const abcjs = (mod as unknown as { default?: typeof mod }).default ?? mod
    const parsed = abcjs.parseOnly(abc)
    expect(parsed.length).toBeGreaterThan(0)
    expect(parsed[0].warnings ?? []).toEqual([])
  })
})

describe('scoreToAbc — abcjs round-trip', () => {
  it('output parses cleanly with abcjs.parseOnly', async () => {
    const abc = scoreToAbc(score({
      title: 'C major scale',
      measures: [
        { events: [
          quarter('C'), quarter('D'), quarter('E'), quarter('F'),
          quarter('G'), quarter('A'), quarter('B', 4), quarter('C', 5),
        ] },
      ],
      meter: '4/4',
    }))
    // C major scale has 8 quarters = 2 whole measures. Schema requires
    // duration sum match — 8 quarters = 16 eighths = 2 measures of 4/4.
    // Re-render across two measures.
    const twoMeasureScore = score({
      title: 'C major',
      measures: [
        { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] },
        { events: [quarter('G'), quarter('A'), quarter('B', 4), quarter('C', 5)] },
      ],
    })
    const abcOut = scoreToAbc(twoMeasureScore)
    const mod = await import('abcjs')
    const abcjs = (mod as unknown as { default?: typeof mod }).default ?? mod
    const tunes = abcjs.parseOnly(abcOut)
    expect(tunes.length).toBeGreaterThan(0)
    expect(tunes[0].warnings ?? []).toEqual([])
    // Avoid unused vars
    void abc
  })
})

describe('scoreToAbc — annotations + score metadata (M8-PR-3)', () => {
  it('measure-level annotation (no eventIdx) attaches to the first event', () => {
    const abc = scoreToAbc(
      score({
        annotations: [
          {
            id: 'rehearseAA',
            target: { measureIdx: 0, position: 'above' },
            text: 'A',
            style: 'rehearsal-mark',
          },
        ],
        measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
      }),
    )
    // Annotation prefix sits before the first note in the bar.
    expect(abc).toContain('"^A"C2')
  })

  it('event-level annotation attaches to the specified event', () => {
    const abc = scoreToAbc(
      score({
        annotations: [
          {
            id: 'express001',
            target: { measureIdx: 0, eventIdx: 2, position: 'above' },
            text: 'dolce',
            style: 'expression',
          },
        ],
        measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
      }),
    )
    // First two notes unannotated, third gets the dolce label.
    expect(abc).toContain('"^dolce"E2')
  })

  it('below-position annotation uses underscore prefix', () => {
    const abc = scoreToAbc(
      score({
        annotations: [
          {
            id: 'below00001',
            target: { measureIdx: 0, position: 'below' },
            text: 'below',
            style: 'plain',
          },
        ],
        measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
      }),
    )
    expect(abc).toContain('"_below"C2')
  })

  it('multiple annotations on the same event concatenate in input order', () => {
    const abc = scoreToAbc(
      score({
        annotations: [
          {
            id: 'rehearseAA',
            target: { measureIdx: 0, position: 'above' },
            text: 'A',
            style: 'rehearsal-mark',
          },
          {
            id: 'tempo00001',
            target: { measureIdx: 0, position: 'above' },
            text: 'Allegro',
            style: 'tempo-text',
          },
        ],
        measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
      }),
    )
    expect(abc).toContain('"^A""^Allegro"C2')
  })

  it('embedded double-quote in annotation text is escaped (does not corrupt the token)', () => {
    const abc = scoreToAbc(
      score({
        annotations: [
          {
            id: 'quote00001',
            target: { measureIdx: 0, position: 'above' },
            text: 'say "hi"',
            style: 'plain',
          },
        ],
        measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
      }),
    )
    // The literal " is replaced with \" so the closing quote of the
    // annotation token stays unambiguous.
    expect(abc).toContain('"^say \\"hi\\""C2')
  })

  it('raw backslashes are STRIPPED (abcjs has no \\\\→\\ decode; doubling would swallow the closing quote)', () => {
    // Documented in escapeAnnotationText: backslashes are removed,
    // not escaped. Locks the M8-PR-3 review fix — doubling produced
    // unparseable ABC because abcjs's substInChord only decodes
    // \\" → " and \\n → newline, leaving \\\\ as a 2-char run that
    // keeps the parser's escape state on and consumes the closing ".
    const abc = scoreToAbc(
      score({
        annotations: [
          {
            id: 'backsl0001',
            target: { measureIdx: 0, position: 'above' },
            text: 'C:\\Users\\foo',
            style: 'plain',
          },
        ],
        measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
      }),
    )
    // Backslashes gone; rest of the text intact.
    expect(abc).toContain('"^C:Usersfoo"C2')
    expect(abc).not.toContain('\\\\')
  })

  it('trailing backslash is stripped (regression: would otherwise eat the closing quote)', () => {
    const abc = scoreToAbc(
      score({
        annotations: [
          {
            id: 'trailbs001',
            target: { measureIdx: 0, position: 'above' },
            text: 'note\\',
            style: 'plain',
          },
        ],
        measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
      }),
    )
    expect(abc).toContain('"^note"C2')
  })

  it('newlines in annotation text are collapsed to spaces (single-line abcjs constraint)', () => {
    const abc = scoreToAbc(
      score({
        annotations: [
          {
            id: 'newln00001',
            target: { measureIdx: 0, position: 'above' },
            text: 'line one\nline two',
            style: 'plain',
          },
        ],
        measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
      }),
    )
    expect(abc).toContain('"^line one line two"C2')
    // No raw newline inside the annotation token — a stray \n would
    // break the abcjs parse since annotations are single-line.
    expect(abc).not.toContain('"^line one\n')
  })

  it('annotation co-exists with technique state on the same event without collision', () => {
    const abc = scoreToAbc(
      score({
        clef: 'bass',
        annotations: [
          {
            id: 'rehearseAA',
            target: { measureIdx: 0, position: 'above' },
            text: 'A',
            style: 'rehearsal-mark',
          },
        ],
        techniqueStates: [
          { id: 'pizz000001', measureIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
        ],
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
        ],
      }),
    )
    // Annotation precedes technique annotation, both before the note.
    expect(abc).toContain('"^A""^pizz."C,8')
  })

  it('composer surfaces as the ABC C: header', () => {
    const abc = scoreToAbc(
      score({
        composer: 'J. S. Bach',
        measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
      }),
    )
    expect(abc).toContain('C:J. S. Bach')
  })

  it('copyright surfaces as %%footer directive (page bottom)', () => {
    const abc = scoreToAbc(
      score({
        copyright: '© Public Domain',
        measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
      }),
    )
    expect(abc).toContain('%%footer © Public Domain')
  })

  it('header text with newlines is sanitized (single-line ABC headers)', () => {
    const abc = scoreToAbc(
      score({
        composer: 'Line one\nLine two',
        measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
      }),
    )
    // Newline collapsed to space; no rogue header line emitted.
    expect(abc).toContain('C:Line one Line two')
    const headerLines = abc.split('\n').filter((l) => l.startsWith('C:'))
    expect(headerLines).toHaveLength(1)
  })

  it('absent composer / copyright do not emit empty headers', () => {
    const abc = scoreToAbc(score({
      measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
    }))
    expect(abc).not.toContain('C:')
    expect(abc).not.toContain('%%footer')
  })

  it('annotations only attach to the primary voice — extraVoices on the same staff do not duplicate the label', () => {
    // staff 0 voice 1 (SATB Alto-on-Soprano-staff style) is voiceIdx
    // > 0 so the guard (staffIdx === 0 && voiceIdx === 0) routes it
    // to EMPTY_ANNOTATION_MAP. Locks the per-voice scope decision.
    const abc = scoreToAbc(
      score({
        annotations: [
          {
            id: 'rehearseAA',
            target: { measureIdx: 0, position: 'above' },
            text: 'A',
            style: 'rehearsal-mark',
          },
        ],
        measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
        extraVoices: [
          {
            measures: [{ events: [quarter('E'), quarter('F'), quarter('G'), quarter('A')] }],
          },
        ],
      }),
    )
    const matches = abc.match(/"\^A"/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('annotations only attach to the primary line — secondStaff voice does not duplicate the label', () => {
    const abc = scoreToAbc(
      score({
        annotations: [
          {
            id: 'rehearseAA',
            target: { measureIdx: 0, position: 'above' },
            text: 'A',
            style: 'rehearsal-mark',
          },
        ],
        measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
        secondStaff: {
          clef: 'bass',
          measures: [
            { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
          ],
        },
      }),
    )
    // Exactly one "^A" token across the whole tune — abcjs aligns it
    // visually across the system from the primary line.
    const matches = abc.match(/"\^A"/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('abcjs round-trip — annotations + score metadata parse without warnings', async () => {
    const abc = scoreToAbc(
      score({
        composer: 'J. S. Bach',
        copyright: 'Public Domain',
        annotations: [
          {
            id: 'rehearseAA',
            target: { measureIdx: 0, position: 'above' },
            text: 'A',
            style: 'rehearsal-mark',
          },
          {
            id: 'tempo00001',
            target: { measureIdx: 0, position: 'above' },
            text: 'Allegro',
            style: 'tempo-text',
          },
          {
            id: 'express001',
            target: { measureIdx: 0, eventIdx: 0, position: 'above' },
            text: 'dolce',
            style: 'expression',
          },
        ],
        measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
      }),
    )
    const mod = await import('abcjs')
    const abcjs = (mod as unknown as { default?: typeof mod }).default ?? mod
    const tunes = abcjs.parseOnly(abc) as Array<{ warnings?: string[] | null }>
    expect(tunes[0]).toBeDefined()
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})

describe('scoreToAbc — markers + metric modulation (M9-PR-3)', () => {
  it('tempo change (bpm + text) emits a single Q: directive on the targeted measure', () => {
    const abc = scoreToAbc(
      score({
        markers: [
          {
            id: 'marker0001',
            measureIdx: 1,
            tempo_bpm: 120,
            tempo_text: 'Allegro',
          },
        ],
        measures: [
          { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] },
          { events: [quarter('G'), quarter('A'), quarter('B'), quarter('C', 5)] },
        ],
      }),
    )
    // Inline Q: directive lands at the START of measure 1 (right
    // after the previous measure's `|` barline).
    expect(abc).toContain('|[Q:"Allegro" 1/4=120]G2')
  })

  it('tempo_bpm alone emits Q: without quoted text', () => {
    const abc = scoreToAbc(
      score({
        markers: [{ id: 'marker0001', measureIdx: 1, tempo_bpm: 140 }],
        measures: [
          { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] },
          { events: [quarter('G'), quarter('A'), quarter('B'), quarter('C', 5)] },
        ],
      }),
    )
    expect(abc).toContain('[Q:1/4=140]G2')
  })

  it('tempo_text alone (no bpm) emits an annotation prefix instead of Q:', () => {
    // No bpm means abcjs can't bind a Q: tempo number; fall back to
    // a plain "^text" annotation so the verbal label still renders.
    const abc = scoreToAbc(
      score({
        markers: [{ id: 'marker0001', measureIdx: 1, tempo_text: 'rit.' }],
        measures: [
          { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] },
          { events: [quarter('G'), quarter('A'), quarter('B'), quarter('C', 5)] },
        ],
      }),
    )
    expect(abc).toContain('"^rit."G2')
    expect(abc).not.toContain('[Q:')
  })

  it('mid-piece meter change emits inline [M:...] directive', () => {
    const abc = scoreToAbc(
      score({
        markers: [{ id: 'marker0001', measureIdx: 1, meter: '3/4' }],
        measures: [
          { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] },
          { events: [quarter('G'), quarter('A'), quarter('B')] },
        ],
      }),
    )
    expect(abc).toContain('[M:3/4]G2')
  })

  it('mid-piece key change emits inline [K:...] directive', () => {
    const abc = scoreToAbc(
      score({
        markers: [{ id: 'marker0001', measureIdx: 1, key: 'G' }],
        measures: [
          { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] },
          { events: [quarter('G'), quarter('A'), quarter('B'), quarter('C', 5)] },
        ],
      }),
    )
    expect(abc).toContain('[K:G]G2')
  })

  it('metric modulation emits as annotation prefix (♩ = ♩.) — abcjs cannot parse ratio Q:', () => {
    // abcjs's Q: parser cannot handle `1/4=3/8` (reads `=3` as bpm
    // and chokes on /8 with "Unexpected string at end of Q: field"
    // — dropping the tempo element entirely). The metric-modulation
    // visual label rides on the annotation channel instead. Tempo
    // bpm Q: still emits separately for playback.
    const abc = scoreToAbc(
      score({
        markers: [
          {
            id: 'marker0001',
            measureIdx: 1,
            tempo_bpm: 80,
            metricModulation: { fromNote: 'quarter', toNote: 'dotted-quarter' },
          },
        ],
        measures: [
          { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] },
          { events: [quarter('G'), quarter('A'), quarter('B'), quarter('C', 5)] },
        ],
      }),
    )
    // Tempo Q: emits first (playback), then the annotation prefix
    // (visual label using Unicode music glyphs).
    expect(abc).toContain('[Q:1/4=80]"^♩ = ♩."G2')
  })

  it('metric modulation alone (no tempo_bpm) emits only the annotation', () => {
    const abc = scoreToAbc(
      score({
        markers: [
          {
            id: 'marker0001',
            measureIdx: 1,
            metricModulation: { fromNote: 'quarter', toNote: 'eighth' },
          },
        ],
        measures: [
          { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] },
          { events: [quarter('G'), quarter('A'), quarter('B'), quarter('C', 5)] },
        ],
      }),
    )
    expect(abc).toContain('"^♩ = ♪"G2')
    expect(abc).not.toContain('[Q:')
  })

  it('abcjs round-trip — metric modulation parses without warnings (regression for ratio Q: bug)', async () => {
    // The original implementation emitted `[Q:1/4=3/8]` which abcjs
    // silently warned about and discarded. The annotation-based
    // emission must parse cleanly.
    const abc = scoreToAbc(
      score({
        markers: [
          {
            id: 'marker0001',
            measureIdx: 1,
            tempo_bpm: 80,
            metricModulation: { fromNote: 'quarter', toNote: 'dotted-quarter' },
          },
        ],
        measures: [
          { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] },
          { events: [quarter('G'), quarter('A'), quarter('B'), quarter('C', 5)] },
        ],
      }),
    )
    const mod = await import('abcjs')
    const abcjs = (mod as unknown as { default?: typeof mod }).default ?? mod
    const tunes = abcjs.parseOnly(abc) as Array<{ warnings?: string[] | null }>
    expect(tunes[0]).toBeDefined()
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it('combined marker (meter + key + tempo) emits directives in M→K→Q order', () => {
    const abc = scoreToAbc(
      score({
        markers: [
          {
            id: 'marker0001',
            measureIdx: 1,
            meter: '6/8',
            key: 'D',
            tempo_bpm: 100,
            tempo_text: 'Allegretto',
          },
        ],
        measures: [
          { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] },
          {
            events: [
              { pitches: [{ step: 'G', octave: 4 }], duration: 'eighth' },
              { pitches: [{ step: 'A', octave: 4 }], duration: 'eighth' },
              { pitches: [{ step: 'B', octave: 4 }], duration: 'eighth' },
              { pitches: [{ step: 'C', octave: 5 }], duration: 'eighth' },
              { pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' },
              { pitches: [{ step: 'E', octave: 5 }], duration: 'eighth' },
            ],
          },
        ],
      }),
    )
    expect(abc).toContain('[M:6/8][K:D][Q:"Allegretto" 1/4=100]')
  })

  it('embedded double-quote in tempo_text is escaped (does not corrupt the Q: token)', () => {
    const abc = scoreToAbc(
      score({
        markers: [
          {
            id: 'marker0001',
            measureIdx: 1,
            tempo_bpm: 100,
            tempo_text: 'a "tempo"',
          },
        ],
        measures: [
          { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] },
          { events: [quarter('G'), quarter('A'), quarter('B'), quarter('C', 5)] },
        ],
      }),
    )
    expect(abc).toContain('[Q:"a \\"tempo\\"" 1/4=100]')
  })

  it('newlines in tempo_text are collapsed to spaces (single-line Q: constraint)', () => {
    const abc = scoreToAbc(
      score({
        markers: [
          {
            id: 'marker0001',
            measureIdx: 1,
            tempo_bpm: 100,
            tempo_text: 'line one\nline two',
          },
        ],
        measures: [
          { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] },
          { events: [quarter('G'), quarter('A'), quarter('B'), quarter('C', 5)] },
        ],
      }),
    )
    expect(abc).toContain('[Q:"line one line two" 1/4=100]')
  })

  it('multiple markers at the same measure concatenate (e.g. tempo + meter from two markers)', () => {
    // Two separate markers at the same measureIdx — meter on one,
    // tempo on the other — both directives emit.
    const abc = scoreToAbc(
      score({
        markers: [
          { id: 'marker0001', measureIdx: 1, meter: '5/8' },
          { id: 'marker0002', measureIdx: 1, tempo_bpm: 90 },
        ],
        measures: [
          { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] },
          {
            events: [
              { pitches: [{ step: 'G', octave: 4 }], duration: 'eighth' },
              { pitches: [{ step: 'A', octave: 4 }], duration: 'eighth' },
              { pitches: [{ step: 'B', octave: 4 }], duration: 'eighth' },
              { pitches: [{ step: 'C', octave: 5 }], duration: 'eighth' },
              { pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' },
            ],
          },
        ],
      }),
    )
    expect(abc).toContain('[M:5/8]')
    expect(abc).toContain('[Q:1/4=90]')
  })

  it('marker on measureIdx 0 emits BEFORE the first event (after K: header line)', () => {
    // A marker at the opening of the score behaves the same — the
    // inline directive sits at the start of measure 0's body. abcjs
    // accepts an inline [Q:...] before the first note.
    const abc = scoreToAbc(
      score({
        markers: [
          { id: 'marker0001', measureIdx: 0, tempo_bpm: 100, tempo_text: 'Allegro' },
        ],
        measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
      }),
    )
    expect(abc).toContain('[Q:"Allegro" 1/4=100]C2')
  })

  it('abcjs round-trip — markers parse without warnings', async () => {
    const abc = scoreToAbc(
      score({
        markers: [
          {
            id: 'marker0001',
            measureIdx: 1,
            tempo_bpm: 120,
            tempo_text: 'Allegro',
            meter: '3/4',
          },
        ],
        measures: [
          { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] },
          {
            events: [
              { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
              { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
              { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
            ],
          },
        ],
      }),
    )
    const mod = await import('abcjs')
    const abcjs = (mod as unknown as { default?: typeof mod }).default ?? mod
    const tunes = abcjs.parseOnly(abc) as Array<{ warnings?: string[] | null }>
    expect(tunes[0]).toBeDefined()
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it('markers only emit on the primary line — extraVoices do not duplicate the directive', () => {
    const abc = scoreToAbc(
      score({
        markers: [{ id: 'marker0001', measureIdx: 0, tempo_bpm: 100 }],
        measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
        extraVoices: [
          {
            measures: [{ events: [quarter('E'), quarter('F'), quarter('G'), quarter('A')] }],
          },
        ],
      }),
    )
    // Exactly one [Q:1/4=100] across the whole tune.
    const matches = abc.match(/\[Q:1\/4=100\]/g) ?? []
    expect(matches.length).toBe(1)
  })
})

describe('scoreToAbc — chord symbols (M10-PR-4)', () => {
  it('emits a bare quoted-text chord symbol before the note', async () => {
    const { parseChordSymbol } = await import('@/lib/music/chordSymbols')
    const abc = scoreToAbc(
      score({
        measures: [{
          events: [
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'quarter',
              chordSymbol: parseChordSymbol('Cmaj7')!,
            },
            quarter('D'), quarter('E'), quarter('F'),
          ],
        }],
      }),
    )
    // Bare quoted text (no ^/_ prefix) = abcjs chord-symbol syntax.
    // Lands BEFORE the pitch letter.
    expect(abc).toContain('"Cmaj7"C2')
  })

  it('uses the canonical formatChordSymbol output, not the display field', async () => {
    const { parseChordSymbol } = await import('@/lib/music/chordSymbols')
    // The parser stores the raw input in display ("cmaj 7" → display
    // = "cmaj 7") but the formatter emits canonical "Cmaj7".
    const parsed = parseChordSymbol('Cmaj7')!
    const mutated = { ...parsed, display: 'WRONG_DISPLAY_VALUE' }
    const abc = scoreToAbc(
      score({
        measures: [{
          events: [
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'quarter',
              chordSymbol: mutated,
            },
            quarter('D'), quarter('E'), quarter('F'),
          ],
        }],
      }),
    )
    expect(abc).toContain('"Cmaj7"')
    expect(abc).not.toContain('WRONG_DISPLAY_VALUE')
  })

  it('slash-chord bass renders in the canonical "/E" form', async () => {
    const { parseChordSymbol } = await import('@/lib/music/chordSymbols')
    const abc = scoreToAbc(
      score({
        measures: [{
          events: [
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'quarter',
              chordSymbol: parseChordSymbol('C/E')!,
            },
            quarter('D'), quarter('E'), quarter('F'),
          ],
        }],
      }),
    )
    expect(abc).toContain('"C/E"C2')
  })

  it('polychord bass renders in the canonical "|G" form', async () => {
    const { parseChordSymbol } = await import('@/lib/music/chordSymbols')
    const abc = scoreToAbc(
      score({
        measures: [{
          events: [
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'quarter',
              chordSymbol: parseChordSymbol('C|G')!,
            },
            quarter('D'), quarter('E'), quarter('F'),
          ],
        }],
      }),
    )
    expect(abc).toContain('"C|G"C2')
  })

  it('modal symbol renders with the modal suffix', async () => {
    const { parseChordSymbol } = await import('@/lib/music/chordSymbols')
    const abc = scoreToAbc(
      score({
        measures: [{
          events: [
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'quarter',
              chordSymbol: parseChordSymbol('C Mixolydian')!,
            },
            quarter('D'), quarter('E'), quarter('F'),
          ],
        }],
      }),
    )
    expect(abc).toContain('"C Mixolydian"C2')
  })

  it('absent chordSymbol does not emit a quoted-text prefix', () => {
    const abc = scoreToAbc(
      score({
        measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
      }),
    )
    // No quoted-text tokens in the body. Note: the headers can carry
    // C: (composer) or T: (title) — those are line-level, not inline.
    const body = abc.split('K:C\n')[1] ?? ''
    expect(body).not.toContain('"')
  })

  it('chord symbol coexists with other event-level fields (dynamic + chord symbol on same note)', async () => {
    const { parseChordSymbol } = await import('@/lib/music/chordSymbols')
    const abc = scoreToAbc(
      score({
        measures: [{
          events: [
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'quarter',
              chordSymbol: parseChordSymbol('Cmaj7')!,
              dynamic: 'p',
            },
            quarter('D'), quarter('E'), quarter('F'),
          ],
        }],
      }),
    )
    // Chord symbol emits FIRST, then the dynamic decoration. Locks
    // the precedence chosen in the decorations chain.
    expect(abc).toContain('"Cmaj7"!p!C2')
  })

  it('embedded double-quote in a (synthetic) chord display is escaped', async () => {
    // formatChordSymbol normally produces a clean canonical form, but
    // a malformed structured chord (or one where display somehow
    // leaks into format) shouldn't break the abcjs parse. Defensive
    // test for the escape rule.
    const malformed = {
      root: 'C',
      quality: 'major' as const,
      seventh: 'none' as const,
      // Force an alteration with a quote char (which Zod would
      // normally reject; we bypass for the escape test).
      alterations: ['b"9'],
    }
    const abc = scoreToAbc(
      score({
        measures: [{
          events: [
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'quarter',
              chordSymbol: malformed,
            },
            quarter('D'), quarter('E'), quarter('F'),
          ],
        }],
      }),
    )
    expect(abc).toMatch(/"C.*\\".*9"/)
  })

  it('chord symbol + technique annotation on the SAME event emit both quoted tokens', async () => {
    // Locks ordering: chord symbol FIRST, then technique annotation
    // (italic above-staff text). abcjs's parse loop iterates both
    // quoted tokens into separate chord[] entries with distinct
    // `position` ('default' vs 'above').
    const { parseChordSymbol } = await import('@/lib/music/chordSymbols')
    const abc = scoreToAbc(
      score({
        clef: 'bass',
        techniqueStates: [
          { id: 'pizz000001', measureIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
        ],
        measures: [{
          events: [
            {
              pitches: [{ step: 'C', octave: 3 }],
              duration: 'whole',
              chordSymbol: parseChordSymbol('Cmaj7')!,
            },
          ],
        }],
      }),
    )
    expect(abc).toContain('"Cmaj7""^pizz."C,8')
  })

  it('abcjs round-trip — chord symbols parse without warnings AND surface in the AST', async () => {
    // Anchors the M10-PR-4 contract against silent-drop regressions.
    // A typo that produced `"^Cmaj7"` (above-staff annotation) instead
    // of `"Cmaj7"` (chord symbol routed through the chord-symbol
    // layout pass) would still parse warning-free — but the AST
    // chord-symbol entry would have position:'above' instead of
    // 'default', so we walk the AST and assert that explicitly.
    // Same gap the M7-PR-4 review caught (ratio Q: silently dropped).
    const { parseChordSymbol } = await import('@/lib/music/chordSymbols')
    const abc = scoreToAbc(
      score({
        measures: [{
          events: [
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'quarter',
              chordSymbol: parseChordSymbol('Cmaj7')!,
            },
            {
              pitches: [{ step: 'D', octave: 4 }],
              duration: 'quarter',
              chordSymbol: parseChordSymbol('Dm7')!,
            },
            {
              pitches: [{ step: 'E', octave: 4 }],
              duration: 'quarter',
              chordSymbol: parseChordSymbol('G7')!,
            },
            {
              pitches: [{ step: 'F', octave: 4 }],
              duration: 'quarter',
              chordSymbol: parseChordSymbol('Cmaj7')!,
            },
          ],
        }],
      }),
    )
    const mod = await import('abcjs')
    const abcjs = (mod as unknown as { default?: typeof mod }).default ?? mod
    type AbcChord = { name?: string; position?: string }
    type AbcNote = { chord?: AbcChord[]; el_type?: string }
    type AbcStaff = { voices: AbcNote[][] }
    type AbcLine = { staff?: AbcStaff[] }
    const tunes = abcjs.parseOnly(abc) as Array<{
      warnings?: string[] | null
      lines?: AbcLine[]
    }>
    expect(tunes[0]).toBeDefined()
    expect(tunes[0].warnings ?? []).toEqual([])
    // Walk the voice for note entries carrying chord[], assert each
    // entry's position is 'default' (chord-symbol layout pass), not
    // 'above' (which would mean it landed in the annotation channel).
    const voice = tunes[0].lines?.[0]?.staff?.[0]?.voices?.[0]
    const noteEntries = (voice ?? []).filter((e) => e.chord !== undefined && e.chord.length > 0)
    expect(noteEntries.length).toBe(4)
    for (const note of noteEntries) {
      const cs = note.chord!.find((c) => c.position === 'default')
      expect(cs).toBeDefined()
    }
    const names = noteEntries.map((e) => e.chord!.find((c) => c.position === 'default')!.name)
    expect(names).toEqual(['Cmaj7', 'Dm7', 'G7', 'Cmaj7'])
  })
})
