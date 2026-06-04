import { describe, it, expect } from 'vitest'
import abcjs from 'abcjs'
import { scoreToAbcWithMap } from '@/lib/music/scoreToAbcWithMap'
import type { Score } from '@/lib/music/types'

function twoBars(): Score {
  return {
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
      {
        events: [
          { pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
          { pitches: [{ step: 'A', octave: 4 }], duration: 'half' },
        ],
      },
    ],
  }
}

describe('scoreToAbcWithMap — barline rendering (M16-PR-2)', () => {
  it('default thin barline (no endBarline set) emits | between measures', () => {
    const { abc } = scoreToAbcWithMap(twoBars())
    // Two `|` chars: one between m1 and m2, one closing m2.
    expect(abc.match(/\|/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('endBarline:"double" emits || at the right edge', () => {
    const sc = twoBars()
    sc.measures[0].endBarline = 'double'
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('||')
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
  })

  it('endBarline:"final" emits |] at the right edge', () => {
    const sc = twoBars()
    sc.measures[1].endBarline = 'final'
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('|]')
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
  })

  it('endBarline:"repeat-end" emits :| at the right edge', () => {
    const sc = twoBars()
    sc.measures[1].endBarline = 'repeat-end'
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain(':|')
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
  })

  it('endBarline:"repeat-both" emits :: (the canonical bar_dbl_repeat token; NOT :|:)', () => {
    // CRITICAL: abcjs's tokenizer (abc_tokenizer.js:178) parses
    // `::` as a single bar_dbl_repeat token. The seemingly-natural
    // `:|:` form would WRONGLY parse as bar_right_repeat + orphan
    // `:` (the `:|` branch at line 198 returns after 2 chars on
    // any non-]/| following char). Pin the correct token AND
    // assert abcjs emits no warnings.
    const sc = twoBars()
    sc.measures[0].endBarline = 'repeat-both'
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('::')
    expect(abc).not.toContain(':|:')
    const tunes = abcjs.parseOnly(abc)
    expect(tunes.length).toBeGreaterThan(0)
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it('endBarline:"invisible" emits [|]', () => {
    const sc = twoBars()
    sc.measures[0].endBarline = 'invisible'
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('[|]')
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
  })

  it('endBarline:"dashed" falls back to | (abcjs has no dashed token)', () => {
    const sc = twoBars()
    sc.measures[0].endBarline = 'dashed'
    const { abc } = scoreToAbcWithMap(sc)
    // No special token; standard thin barline. Data round-trips
    // through save/load even if visual rendering falls back.
    expect(abc).toContain('|')
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
  })

  it('startBarline on the FIRST measure (m=0) emits at the very start of the body', () => {
    const sc = twoBars()
    sc.measures[0].startBarline = 'repeat-start'
    const { abc } = scoreToAbcWithMap(sc)
    // The `|:` must precede the first pitch token (C2 from m0e0).
    expect(abc).toMatch(/\|:\s*C2/)
  })

  it('startBarline on a later measure (m=1) emits BETWEEN m=0 endBarline and m=1 body', () => {
    const sc = twoBars()
    sc.measures[1].startBarline = 'repeat-start'
    const { abc } = scoreToAbcWithMap(sc)
    // m=0 ends with default `|`, then m=1 prepends `|:`, then G note.
    expect(abc).toMatch(/\|\|:G4/)
  })

  it('repeat-start + repeat-end paired across measures produces a parseable repeat block', () => {
    const sc = twoBars()
    sc.measures[0].startBarline = 'repeat-start'
    sc.measures[1].endBarline = 'repeat-end'
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('|:')
    expect(abc).toContain(':|')
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
  })

  it('adjacent boundary: m=0 end="final" + m=1 start="repeat-start" emits |] then |:', () => {
    const sc = twoBars()
    sc.measures[0].endBarline = 'final'
    sc.measures[1].startBarline = 'repeat-start'
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('|]|:')
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
  })

  it('barlineFermata coexists with custom endBarline (decoration sits BEFORE the barline glyph)', () => {
    const sc = twoBars()
    sc.measures[0].endBarline = 'final'
    sc.measures[0].barlineFermata = 'standard'
    const { abc } = scoreToAbcWithMap(sc)
    // `!fermata!` precedes the final-barline glyph.
    expect(abc).toMatch(/!fermata!\|\]/)
  })

  it('round-trips through abcjs: emitted ABC parses without warnings on all 8 barline kinds', () => {
    const KINDS = ['thin', 'double', 'final', 'repeat-start', 'repeat-end', 'repeat-both', 'invisible', 'dashed'] as const
    for (const kind of KINDS) {
      const sc = twoBars()
      sc.measures[0].endBarline = kind
      const { abc } = scoreToAbcWithMap(sc)
      const tunes = abcjs.parseOnly(abc)
      expect(tunes.length).toBeGreaterThan(0)
      // Pin no-warnings so future canonical-token regressions
      // surface (the original `:|:` for repeat-both passed the
      // tunes.length check while silently producing warnings +
      // an orphan `:` token).
      expect(tunes[0].warnings ?? []).toEqual([])
    }
  })

  it('m=0 startBarline:"invisible" emits [|] at the leading position', () => {
    const sc = twoBars()
    sc.measures[0].startBarline = 'invisible'
    const { abc } = scoreToAbcWithMap(sc)
    // The invisible glyph sits between the K: header and the
    // first pitch. abcjs parses [|] as bar_invisible (no glyph
    // drawn) without warning.
    expect(abc).toContain('[|]')
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it('isPickup measure with short duration renders without throwing', () => {
    // Pickup measures have fewer beats than the meter. validateScore
    // accepts when isPickup:true is set. The renderer just emits
    // whatever events are present; abcjs auto-handles the partial
    // bar visually.
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          isPickup: true,
          events: [
            { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
          ],
        },
        {
          events: [
            { pitches: [{ step: 'C', octave: 5 }], duration: 'whole' },
          ],
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('G2')
    expect(abc).toContain('c8')
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
  })

  it('isFinalPartial measure with short duration renders without throwing', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
          ],
        },
        {
          isFinalPartial: true,
          events: [
            { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
          ],
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('C8')
    expect(abc).toContain('G2')
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
  })

  it('multi-voice score: barlines emit on every voice line (each voice independently)', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          endBarline: 'repeat-end',
          events: [
            { pitches: [{ step: 'C', octave: 5 }], duration: 'whole' },
          ],
        },
      ],
      extraVoices: [
        {
          measures: [
            {
              endBarline: 'repeat-end',
              events: [
                { pitches: [{ step: 'E', octave: 4 }], duration: 'whole' },
              ],
            },
          ],
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // Both V:1 (soprano) and V:2 (alto) lines should carry the
    // :| glyph. Count :| occurrences — should be at least 2.
    const matches = abc.match(/:\|/g)
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
  })
})
