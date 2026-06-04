import { describe, it, expect } from 'vitest'
import abcjs from 'abcjs'
import { scoreToAbcWithMap } from '@/lib/music/scoreToAbcWithMap'
import type { EngravingDefaults, Score } from '@/lib/music/types'

function buildScore(): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: [
      {
        events: [
          { id: 'evtestid01', pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
        ],
      },
    ],
  }
}

// EngravingDefaultsSchema.dynamicsPosition uses `.default('auto-by-staff')`,
// which makes the inferred OUTPUT type require the field (Zod default fields
// are always present after parse). Constructing an EngravingDefaults inline
// then requires dynamicsPosition every time. The helper fills the default so
// each test case can supply only the field it exercises.
function eg(partial: Partial<EngravingDefaults> = {}): EngravingDefaults {
  return { dynamicsPosition: 'auto-by-staff', ...partial }
}

describe('scoreToAbcWithMap — engravingDefaults header directives (M21-PR-1)', () => {
  it('emits no extra directives when engravingDefaults is undefined', () => {
    const { abc } = scoreToAbcWithMap(buildScore())
    expect(abc).not.toContain('%%tempofont')
    expect(abc).not.toContain('%%vocalfont')
    expect(abc).not.toContain('%%gchordfont')
    expect(abc).not.toContain('%%barsperstaff')
    expect(abc).not.toContain('%%indent')
    expect(abc).not.toContain('%%keywarn')
    expect(abc).not.toContain('%%continueall')
    expect(abc).not.toContain('%%flatbeams')
    expect(abc).not.toContain('%%dynamic ')
    // The unconditional %%annotationfont from M3-PR-3 stays.
    expect(abc).toContain('%%annotationfont Helvetica 12 italic')
  })

  it('emits no extra directives when engravingDefaults is empty (all undefined)', () => {
    const sc: Score = { ...buildScore(), engravingDefaults: eg() }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).not.toContain('%%tempofont')
    expect(abc).not.toContain('%%vocalfont')
    expect(abc).not.toContain('%%gchordfont')
    expect(abc).not.toContain('%%barsperstaff')
    expect(abc).not.toContain('%%indent')
    expect(abc).not.toContain('%%keywarn')
    expect(abc).not.toContain('%%continueall')
    expect(abc).not.toContain('%%flatbeams')
    // The eg() helper provides the .default('auto-by-staff'), which
    // the renderer deliberately skips (see emit-site comment in
    // scoreToAbcWithMap.ts). So even though dynamicsPosition has a
    // value, no %%dynamic directive should appear.
    expect(abc).not.toContain('%%dynamic ')
  })
})

describe('scoreToAbcWithMap — tempoTextFont → %%tempofont (M21-PR-1)', () => {
  it('italic-bold maps to bold italic Times', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ tempoTextFont: 'italic-bold' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%tempofont "Times New Roman" 15 bold italic')
  })

  it('bold-roman maps to bold Times (no "normal" — abcjs rejects it)', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ tempoTextFont: 'bold-roman' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%tempofont "Times New Roman" 15 bold')
  })

  it('italic-roman maps to italic Times', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ tempoTextFont: 'italic-roman' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%tempofont "Times New Roman" 15 italic')
  })

  it('plain-roman maps to bare face+size (no weight/style)', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ tempoTextFont: 'plain-roman' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%tempofont "Times New Roman" 15')
  })

  it('abcjs round-trip — %%tempofont produces no parser warnings', () => {
    const sc: Score = {
      ...buildScore(),
      tempo_bpm: 120,
      engravingDefaults: eg({ tempoTextFont: 'italic-bold' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})

describe('scoreToAbcWithMap — lyricFontScale → %%vocalfont (M21-PR-1)', () => {
  it('100% (base) emits %%vocalfont with 13pt base size', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ lyricFontScale: 100 }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%vocalfont "Times New Roman" 13 bold')
  })

  it('150% scales to ~20pt', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ lyricFontScale: 150 }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%vocalfont "Times New Roman" 20 bold')
  })

  it('50% scales to 7pt (lower bound rounded)', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ lyricFontScale: 50 }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%vocalfont "Times New Roman" 7 bold')
  })

  it('200% scales to 26pt (upper bound)', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ lyricFontScale: 200 }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%vocalfont "Times New Roman" 26 bold')
  })

  it('abcjs round-trip — %%vocalfont produces no parser warnings', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ lyricFontScale: 150 }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})

describe('scoreToAbcWithMap — chordSymbolStyle → %%gchordfont (M21-PR-1)', () => {
  it('jazz maps to Arial Black 14pt bold', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ chordSymbolStyle: 'jazz' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%gchordfont "Arial Black" 14 bold')
  })

  it('plain maps to Helvetica 12pt bare (no weight suffix)', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ chordSymbolStyle: 'plain' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%gchordfont "Helvetica" 12')
  })

  it('roman-numeral maps to Times New Roman 12pt bare', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ chordSymbolStyle: 'roman-numeral' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%gchordfont "Times New Roman" 12')
  })

  it('abcjs round-trip — %%gchordfont produces no parser warnings', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ chordSymbolStyle: 'jazz' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})

describe('scoreToAbcWithMap — maxMeasuresPerSystem → %%barsperstaff (M21-PR-2)', () => {
  it('emits %%barsperstaff with the integer value (lower bound 1)', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ maxMeasuresPerSystem: 1 }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%barsperstaff 1')
  })

  it('emits %%barsperstaff 4 for the common publisher default', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ maxMeasuresPerSystem: 4 }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%barsperstaff 4')
  })

  it('emits %%barsperstaff 32 at the upper bound', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ maxMeasuresPerSystem: 32 }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%barsperstaff 32')
  })

  it('omits %%barsperstaff when maxMeasuresPerSystem is undefined', () => {
    const sc: Score = { ...buildScore(), engravingDefaults: eg() }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).not.toContain('%%barsperstaff')
  })

  it('abcjs round-trip — %%barsperstaff produces no parser warnings', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ maxMeasuresPerSystem: 4 }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})

describe('scoreToAbcWithMap — firstSystemIndent → %%indent (M21-PR-2)', () => {
  it('omits %%indent when firstSystemIndent is 0 (no-op, abcjs default)', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ firstSystemIndent: 0 }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).not.toContain('%%indent')
  })

  it('emits %%indent in cm (1 staff-space ≈ 0.5cm)', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ firstSystemIndent: 1 }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%indent 0.50cm')
  })

  it('emits %%indent 5cm for 10 staff-spaces (mid-range)', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ firstSystemIndent: 10 }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%indent 5.00cm')
  })

  it('emits %%indent 10cm at the upper bound (20 staff-spaces)', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ firstSystemIndent: 20 }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%indent 10.00cm')
  })

  it('omits %%indent when firstSystemIndent is undefined', () => {
    const sc: Score = { ...buildScore(), engravingDefaults: eg() }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).not.toContain('%%indent')
  })

  it('abcjs round-trip — %%indent produces no parser warnings', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ firstSystemIndent: 4 }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})

describe('scoreToAbcWithMap — cancelNaturalsOnKeyChange → %%keywarn (M21-PR-2)', () => {
  it('emits %%keywarn 0 when cancelNaturalsOnKeyChange is false', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ cancelNaturalsOnKeyChange: false }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%keywarn 0')
  })

  it('omits %%keywarn when cancelNaturalsOnKeyChange is true (abcjs default is on)', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ cancelNaturalsOnKeyChange: true }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).not.toContain('%%keywarn')
  })

  it('omits %%keywarn when cancelNaturalsOnKeyChange is undefined', () => {
    const sc: Score = { ...buildScore(), engravingDefaults: eg() }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).not.toContain('%%keywarn')
  })

  it('abcjs round-trip — %%keywarn 0 produces no parser warnings', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ cancelNaturalsOnKeyChange: false }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})

describe('scoreToAbcWithMap — pageLayoutMode → %%continueall (M21-PR-3)', () => {
  it("emits %%continueall when pageLayoutMode is 'scroll'", () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ pageLayoutMode: 'scroll' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%continueall')
  })

  it("omits %%continueall when pageLayoutMode is 'page' (abcjs default)", () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ pageLayoutMode: 'page' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).not.toContain('%%continueall')
  })

  it('omits %%continueall when pageLayoutMode is undefined', () => {
    const sc: Score = { ...buildScore(), engravingDefaults: eg() }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).not.toContain('%%continueall')
  })

  it('abcjs round-trip — %%continueall produces no parser warnings', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ pageLayoutMode: 'scroll' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})

describe('scoreToAbcWithMap — beamSlopeRule → %%flatbeams (M21-PR-3)', () => {
  it("emits %%flatbeams when beamSlopeRule is 'european-flat'", () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ beamSlopeRule: 'european-flat' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%flatbeams')
  })

  it("omits %%flatbeams when beamSlopeRule is 'american-steep' (abcjs default)", () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ beamSlopeRule: 'american-steep' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).not.toContain('%%flatbeams')
  })

  it('omits %%flatbeams when beamSlopeRule is undefined', () => {
    const sc: Score = { ...buildScore(), engravingDefaults: eg() }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).not.toContain('%%flatbeams')
  })

  it('abcjs round-trip — %%flatbeams produces no parser warnings', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ beamSlopeRule: 'european-flat' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})

describe('scoreToAbcWithMap — dynamicsPosition → %%dynamic (M21-PR-4)', () => {
  it("emits %%dynamic above when dynamicsPosition is 'above'", () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ dynamicsPosition: 'above' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%dynamic above')
  })

  it("emits %%dynamic below when dynamicsPosition is 'below'", () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ dynamicsPosition: 'below' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%dynamic below')
  })

  it("omits %%dynamic when dynamicsPosition is 'auto-by-staff'", () => {
    // 'auto-by-staff' is the schema's SATB-aware semantic (vocal
    // staves get dynamics below, instrumental above). abcjs's 'auto'
    // is a simpler stem-aware choice that doesn't honor SATB, so the
    // renderer deliberately skips emission rather than emit a
    // misleading approximation.
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ dynamicsPosition: 'auto-by-staff' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).not.toContain('%%dynamic ')
  })

  it('abcjs round-trip — %%dynamic above produces no parser warnings', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ dynamicsPosition: 'above' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it('abcjs round-trip — %%dynamic below produces no parser warnings', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ dynamicsPosition: 'below' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it("abcjs round-trip — %%dynamic auto would parse cleanly (documents the deferral is a semantic choice, not a parser limitation)", () => {
    // The renderer never emits %%dynamic auto (see emit-site comment).
    // This pin asserts abcjs WOULD accept it if we did — proving the
    // deferral is a deliberate semantic choice about SATB-routing, not
    // a workaround for an abcjs parser gap.
    const abc = `X:1\nT:Test\nM:4/4\nL:1/8\nK:C\n%%dynamic auto\nC8|]\n`
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it("emits %%dynamic hidden when dynamicsPosition is 'hidden'", () => {
    // 'hidden' suppresses dynamic glyphs entirely — useful for editor
    // overlays or instrumental part extraction where dynamics live on
    // a separate layer. abcjs supports it via positionChoices
    // (abc_parse_directive.js:751) and special-cases the rendering at
    // abc_parse_music.js:771.
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ dynamicsPosition: 'hidden' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%dynamic hidden')
  })

  it('abcjs round-trip — %%dynamic hidden produces no parser warnings', () => {
    const sc: Score = {
      ...buildScore(),
      engravingDefaults: eg({ dynamicsPosition: 'hidden' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})

describe('scoreToAbcWithMap — engravingDefaults coexistence (regression)', () => {
  it('all 3 font directives emit together cleanly', () => {
    const sc: Score = {
      ...buildScore(),
      tempo_bpm: 120,
      engravingDefaults: eg({
        tempoTextFont: 'italic-bold',
        lyricFontScale: 120,
        chordSymbolStyle: 'jazz',
      }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%tempofont "Times New Roman" 15 bold italic')
    expect(abc).toContain('%%vocalfont "Times New Roman" 16 bold')
    expect(abc).toContain('%%gchordfont "Arial Black" 14 bold')
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it('engravingDefaults coexists with composer + copyright headers', () => {
    const sc: Score = {
      ...buildScore(),
      composer: 'J. S. Bach',
      copyright: 'Public Domain',
      engravingDefaults: eg({ tempoTextFont: 'bold-roman' }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('C:J. S. Bach')
    expect(abc).toContain('%%footer Public Domain')
    expect(abc).toContain('%%tempofont "Times New Roman" 15 bold')
  })

  it('all 6 supported directives emit together cleanly (M21-PR-1 + M21-PR-2)', () => {
    const sc: Score = {
      ...buildScore(),
      tempo_bpm: 120,
      engravingDefaults: eg({
        tempoTextFont: 'italic-bold',
        lyricFontScale: 120,
        chordSymbolStyle: 'jazz',
        maxMeasuresPerSystem: 4,
        firstSystemIndent: 4,
        cancelNaturalsOnKeyChange: false,
      }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%tempofont "Times New Roman" 15 bold italic')
    expect(abc).toContain('%%vocalfont "Times New Roman" 16 bold')
    expect(abc).toContain('%%gchordfont "Arial Black" 14 bold')
    expect(abc).toContain('%%barsperstaff 4')
    expect(abc).toContain('%%indent 2.00cm')
    expect(abc).toContain('%%keywarn 0')
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it('all 8 supported directives emit together cleanly (M21-PR-1 + M21-PR-2 + M21-PR-3)', () => {
    const sc: Score = {
      ...buildScore(),
      tempo_bpm: 120,
      engravingDefaults: eg({
        tempoTextFont: 'italic-bold',
        lyricFontScale: 120,
        chordSymbolStyle: 'jazz',
        maxMeasuresPerSystem: 4,
        firstSystemIndent: 4,
        cancelNaturalsOnKeyChange: false,
        pageLayoutMode: 'scroll',
        beamSlopeRule: 'european-flat',
      }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%tempofont "Times New Roman" 15 bold italic')
    expect(abc).toContain('%%vocalfont "Times New Roman" 16 bold')
    expect(abc).toContain('%%gchordfont "Arial Black" 14 bold')
    expect(abc).toContain('%%barsperstaff 4')
    expect(abc).toContain('%%indent 2.00cm')
    expect(abc).toContain('%%keywarn 0')
    expect(abc).toContain('%%continueall')
    expect(abc).toContain('%%flatbeams')
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it('all 9 supported directives emit together cleanly (M21-PR-1 + M21-PR-2 + M21-PR-3 + M21-PR-4)', () => {
    const sc: Score = {
      ...buildScore(),
      tempo_bpm: 120,
      engravingDefaults: eg({
        tempoTextFont: 'italic-bold',
        lyricFontScale: 120,
        chordSymbolStyle: 'jazz',
        maxMeasuresPerSystem: 4,
        firstSystemIndent: 4,
        cancelNaturalsOnKeyChange: false,
        pageLayoutMode: 'scroll',
        beamSlopeRule: 'european-flat',
        dynamicsPosition: 'below',
      }),
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('%%tempofont "Times New Roman" 15 bold italic')
    expect(abc).toContain('%%vocalfont "Times New Roman" 16 bold')
    expect(abc).toContain('%%gchordfont "Arial Black" 14 bold')
    expect(abc).toContain('%%barsperstaff 4')
    expect(abc).toContain('%%indent 2.00cm')
    expect(abc).toContain('%%keywarn 0')
    expect(abc).toContain('%%continueall')
    expect(abc).toContain('%%flatbeams')
    expect(abc).toContain('%%dynamic below')
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})
