import { describe, it, expect } from 'vitest'
import abcjs from 'abcjs'
import { scoreToAbcWithMap } from '@/lib/music/scoreToAbcWithMap'
import type { Score } from '@/lib/music/types'

function fourNoteScore(): Score {
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
    ],
  }
}

describe('scoreToAbcWithMap — lyric rendering (M15-PR-2)', () => {
  it('emits a single w: line with bare syllables', () => {
    const sc = fourNoteScore()
    sc.measures[0].events[0].lyrics = [{ verse: 1, syllable: 'A' }]
    sc.measures[0].events[1].lyrics = [{ verse: 1, syllable: 'ma' }]
    sc.measures[0].events[2].lyrics = [{ verse: 1, syllable: 'zing' }]
    sc.measures[0].events[3].lyrics = [{ verse: 1, syllable: 'grace' }]
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('w:A ma zing grace')
  })

  it('emits hyphen suffix for syllables marked hyphen:true', () => {
    const sc = fourNoteScore()
    sc.measures[0].events[0].lyrics = [{ verse: 1, syllable: 'Glo', hyphen: true }]
    sc.measures[0].events[1].lyrics = [{ verse: 1, syllable: 'ri', hyphen: true }]
    sc.measures[0].events[2].lyrics = [{ verse: 1, syllable: 'a' }]
    sc.measures[0].events[3].lyrics = [{ verse: 1, syllable: 'in' }]
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('w:Glo- ri- a in')
  })

  it('emits underscore extender for melismatic syllables', () => {
    const sc = fourNoteScore()
    sc.measures[0].events[0].lyrics = [{ verse: 1, syllable: 'A', extender: true }]
    sc.measures[0].events[1].lyrics = [{ verse: 1, syllable: 'men' }]
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('w:A_ men * *')
  })

  it('emits * for events without a syllable in the active verse', () => {
    const sc = fourNoteScore()
    sc.measures[0].events[0].lyrics = [{ verse: 1, syllable: 'A' }]
    // events 1, 2, 3 have no verse 1 syllable → all become *
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('w:A * * *')
  })

  it('emits one w: line per verse when multiple verses are present', () => {
    const sc = fourNoteScore()
    sc.measures[0].events[0].lyrics = [
      { verse: 1, syllable: 'first' },
      { verse: 2, syllable: 'second' },
    ]
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('w:first * * *')
    expect(abc).toContain('w:second * * *')
    // Verses sorted ascending
    const v1Idx = abc.indexOf('w:first')
    const v2Idx = abc.indexOf('w:second')
    expect(v1Idx).toBeLessThan(v2Idx)
  })

  it('emits | between measures so abcjs aligns syllables with bars', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4 }], duration: 'whole', lyrics: [{ verse: 1, syllable: 'Ho' }] },
          ],
        },
        {
          events: [
            { pitches: [{ step: 'D', octave: 4 }], duration: 'whole', lyrics: [{ verse: 1, syllable: 'ly' }] },
          ],
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('w:Ho | ly')
  })

  it('omits w: lines entirely when no lyrics are present', () => {
    const { abc } = scoreToAbcWithMap(fourNoteScore())
    expect(abc).not.toContain('w:')
  })

  it('skips a verse that has only * tokens (active set is per-voice)', () => {
    // Verse 1 on staff 0; verse 2 only on extraVoices voice 1. The
    // score-wide maxVerse is 2, but voice 0's active verses are
    // only {1}, so voice 0 emits ONE w: line, not two.
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 5 }], duration: 'whole', lyrics: [{ verse: 1, syllable: 'sop' }] },
          ],
        },
      ],
      extraVoices: [
        {
          measures: [
            {
              events: [
                { pitches: [{ step: 'E', octave: 4 }], duration: 'whole', lyrics: [{ verse: 2, syllable: 'alt' }] },
              ],
            },
          ],
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // Soprano line carries verse 1, alto carries verse 2 — neither
    // emits the other's verse.
    expect(abc).toMatch(/V:1[^V]*w:sop/)
    expect(abc).toMatch(/V:2[^V]*w:alt/)
    expect(abc).not.toMatch(/V:1[^V]*w:alt/)
    expect(abc).not.toMatch(/V:2[^V]*w:sop/)
  })

  it('escapes literal hyphens / underscores / asterisks / pipes / tildes in syllables', () => {
    const sc = fourNoteScore()
    sc.measures[0].events[0].lyrics = [{ verse: 1, syllable: 'a-b' }]
    sc.measures[0].events[1].lyrics = [{ verse: 1, syllable: 'c_d' }]
    sc.measures[0].events[2].lyrics = [{ verse: 1, syllable: 'e*f' }]
    sc.measures[0].events[3].lyrics = [{ verse: 1, syllable: 'g|h' }]
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('a\\-b')
    expect(abc).toContain('c\\_d')
    expect(abc).toContain('e\\*f')
    expect(abc).toContain('g\\|h')
  })

  it('strips backslashes from syllables (HIGH bug fix — abcjs translateString)', () => {
    // abcjs's tokenizer.translateString consumes `\X` for accent
    // / music-glyph lookups (`\b` → ♭, `\#` → ♯, `\AE` → Æ). User
    // backslash input would silently corrupt to a music symbol or
    // a doubled backslash in the rendered output. No safe escape
    // sequence exists; strip backslashes outright. Pin the
    // strip behavior so a future "escape with \\" attempt fails
    // visibly.
    const sc = fourNoteScore()
    sc.measures[0].events[0].lyrics = [{ verse: 1, syllable: 'a\\b' }]
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('w:ab * * *')
    expect(abc).not.toContain('\\b')
    expect(abc).not.toContain('\\\\')
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
  })

  it('escapes spaces inside syllables as ~ (non-breaking space)', () => {
    const sc = fourNoteScore()
    sc.measures[0].events[0].lyrics = [{ verse: 1, syllable: 'a long' }]
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('w:a~long * * *')
  })

  it('SATB divisi: soprano voice 0 and alto voice 1 carry independent lyrics', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C', octave: 5 }],
              duration: 'whole',
              lyrics: [{ verse: 1, syllable: 'Ky' }],
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
                  lyrics: [{ verse: 1, syllable: 'Glo' }],
                },
              ],
            },
          ],
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // Each voice gets its own w: line under its own V: declaration.
    expect(abc).toMatch(/V:1[^V]*w:Ky/)
    expect(abc).toMatch(/V:2[^V]*w:Glo/)
  })

  it('rest events emit * regardless of any syllable on them (HIGH bug fix)', () => {
    // Critical regression pin: abcjs's w: parser
    // (abc_parse.js:303) advances word_list only on non-rest
    // notes. Emitting a real syllable token at a rest shifts every
    // subsequent syllable LEFT by one — the alto's "Glo" lands on
    // the soprano's note, then "ri" shifts onto the next note, etc.
    // The fix: ALWAYS emit `*` at a rest event, even if its
    // .lyrics array carries a syllable. The data round-trips
    // through save/load (the score JSON still has the syllable);
    // the renderer just can't visualize lyrics under a rest in
    // abcjs. Anglican psalter convention is a known deferred case.
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'rest', octave: 4 }],
              duration: 'whole',
              lyrics: [{ verse: 1, syllable: 'A' }],
            },
          ],
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('w:*')
    expect(abc).not.toMatch(/w:A\b/)
  })

  it('rest followed by notes does NOT shift the verse left (HIGH bug regression pin)', () => {
    // The most dangerous form of the rest-shift bug: a rest
    // BEFORE pitched notes. Without the fix, emit would be
    // `A B C D` for events [rest+'A', note, note, note]; the
    // parser would attach A→note1, B→note2, C→note3, drop D.
    // With the fix, emit is `* B C D` and the parser correctly
    // attaches B→note1, C→note2, D→note3.
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'rest', octave: 4 }],
              duration: 'quarter',
              lyrics: [{ verse: 1, syllable: 'A' }],
            },
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'quarter',
              lyrics: [{ verse: 1, syllable: 'men' }],
            },
            { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
            { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
          ],
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('w:* men * *')
    // Parse and verify "men" lands on the C (note 0 of the
    // non-rest sequence), not shifted onto the D.
    const tune = abcjs.parseOnly(abc)[0]
    const lyricsPerNote: Array<string[]> = []
    for (const line of tune.lines) {
      for (const staff of line.staff ?? []) {
        for (const voice of staff.voices ?? []) {
          for (const el of voice) {
            if (el.el_type === 'note' && el.rest === undefined) {
              lyricsPerNote.push(
                (el.lyric ?? []).map((l: { syllable: string }) => l.syllable),
              )
            }
          }
        }
      }
    }
    // 3 pitched notes; first has "men", next two have skip
    // tokens (`*`) which abcjs records as empty-syllable lyric
    // entries (so the renderer leaves space under those notes).
    // The CRITICAL invariant is that "men" is on note 0, not
    // shifted onto note 1 or 2.
    expect(lyricsPerNote).toHaveLength(3)
    expect(lyricsPerNote[0]).toEqual(['men'])
    // The remaining 2 notes carry the `*` skip token; we don't
    // assert exact content (abcjs may record this as [''] or [])
    // — just confirm "men" isn't there.
    expect(lyricsPerNote[1]).not.toContain('men')
    expect(lyricsPerNote[2]).not.toContain('men')
  })

  it('round-trips through abcjs: hyphenated line parses to lyric objects on the right notes', () => {
    const sc = fourNoteScore()
    sc.measures[0].events[0].lyrics = [{ verse: 1, syllable: 'Glo', hyphen: true }]
    sc.measures[0].events[1].lyrics = [{ verse: 1, syllable: 'ri', hyphen: true }]
    sc.measures[0].events[2].lyrics = [{ verse: 1, syllable: 'a' }]
    sc.measures[0].events[3].lyrics = [{ verse: 1, syllable: 'in' }]
    const { abc } = scoreToAbcWithMap(sc)
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
    const tune = abcjs.parseOnly(abc)[0]
    const syllables: string[] = []
    for (const line of tune.lines) {
      for (const staff of line.staff ?? []) {
        for (const voice of staff.voices ?? []) {
          for (const el of voice) {
            if (el.el_type === 'note' && el.lyric) {
              for (const l of el.lyric as Array<{ syllable: string }>) {
                syllables.push(l.syllable)
              }
            }
          }
        }
      }
    }
    expect(syllables).toEqual(['Glo', 'ri', 'a', 'in'])
  })

  it('round-trips through abcjs: melisma extender on note 1 carries through note 2 (rest)', () => {
    const sc = fourNoteScore()
    sc.measures[0].events[0].lyrics = [{ verse: 1, syllable: 'A', extender: true }]
    sc.measures[0].events[1].lyrics = [{ verse: 1, syllable: 'men' }]
    const { abc } = scoreToAbcWithMap(sc)
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
    // Check the w: line carries A_ and men with two *
    expect(abc).toContain('w:A_ men * *')
  })

  it('coexists with hairpins and slurs on the same voice', () => {
    const idA = 'evlyrabcde'
    const idD = 'evlyrabcdf'
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { id: idA, pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', lyrics: [{ verse: 1, syllable: 'A' }] },
            { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter', lyrics: [{ verse: 1, syllable: 'ma' }] },
            { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter', lyrics: [{ verse: 1, syllable: 'zing' }] },
            { id: idD, pitches: [{ step: 'F', octave: 4 }], duration: 'quarter', lyrics: [{ verse: 1, syllable: 'grace' }] },
          ],
        },
      ],
      spans: [
        { id: 'hpcoex0001', kind: 'hairpin-cresc', startEventId: idA, endEventId: idD, staffIdx: 0, voiceIdx: 0 },
        { id: 'slcoex0001', kind: 'slur', startEventId: idA, endEventId: idD, staffIdx: 0, voiceIdx: 0 },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('w:A ma zing grace')
    expect(abc).toContain('!<(!')
    expect(abc).toContain('(C2')
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
  })
})
